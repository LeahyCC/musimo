"""Save one catalog track from the Deezer account named by MUSIMO_DEEZER_ARL.

The cookie stays in the environment. Jobs, logs and diagnostics never receive it.
Naming, tags and format conversion still run on the file afterwards.
"""

import os
import re
from collections.abc import Callable, Iterable
from pathlib import Path

import httpx
from Cryptodome.Cipher import Blowfish
from Cryptodome.Hash import MD5

USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64; rv:135.0) Gecko/20100101 Firefox/135.0"
BLOCK = 2048
# Deezer's account cookie is 192 hex characters. Anything else is not one.
ARL = re.compile(r"[a-fA-F0-9]{192}")
Progress = Callable[[int, int], None]


class DeezerAudioError(Exception):
    """The account file could not be saved. The worker then tries another source."""


class DeezerCookieRejected(DeezerAudioError):
    """Deezer refused the cookie. Asking again with the same one cannot work."""


class DeezerNoTrack(DeezerAudioError):
    """The account cannot play this track, so Deezer has no file to give for it."""


def configured() -> bool:
    return bool(os.environ.get("MUSIMO_DEEZER_ARL", "").strip())


def account_cookie() -> str:
    value = os.environ.get("MUSIMO_DEEZER_ARL", "").strip()
    if ARL.fullmatch(value) is None:
        raise DeezerCookieRejected("MUSIMO_DEEZER_ARL is not a Deezer account cookie")
    return value


# Best first. A CDN refusal of one quality is not "no audio": the next one may still play.
QUALITY_LADDER = ("FLAC", "MP3_320", "MP3_128")


def choose_format(quality: object) -> str:
    """Best format this account is allowed to request."""
    if not isinstance(quality, dict):
        return "MP3_128"
    if quality.get("lossless") is True:
        return "FLAC"
    if quality.get("high") is True:
        return "MP3_320"
    return "MP3_128"


def formats_to_try(preferred: str) -> tuple[str, ...]:
    """The preferred quality, then each lower one. Stops at the bottom of the ladder."""
    if preferred not in QUALITY_LADDER:
        return (preferred,)
    return QUALITY_LADDER[QUALITY_LADDER.index(preferred) :]


def extension(fmt: str) -> str:
    return "flac" if fmt == "FLAC" else "mp3"


def blowfish_key(song_id: str) -> bytes:
    """The per-song key. The hex digest is xored, then UTF-8 encoded, matching Deezer's files."""
    secret = b"g4el58wc0zvf9na1"
    hashed = MD5.new(song_id.encode()).hexdigest().encode("ascii")
    chars = "".join(chr(hashed[i] ^ hashed[i + 16] ^ secret[i]) for i in range(16))
    return chars.encode()


def decrypt_block(block: bytes, key: bytes) -> bytes:
    cipher = Blowfish.new(key, Blowfish.MODE_CBC, iv=bytes(range(8)))
    return bytes(cipher.decrypt(block))


def decrypt_stripe(chunks: Iterable[bytes], key: bytes) -> bytes:
    """Deezer encrypts every third 2048-byte block and leaves the rest as plain audio."""
    pending = bytearray()
    out = bytearray()
    index = 0
    for chunk in chunks:
        pending.extend(chunk)
        while len(pending) >= BLOCK:
            block = bytes(pending[:BLOCK])
            del pending[:BLOCK]
            if index % 3 == 0:
                block = decrypt_block(block, key)
            out.extend(block)
            index += 1
    out.extend(pending)
    return bytes(out)


class Account:
    def __init__(self, cookie: str) -> None:
        # Scoped to deezer.com. A plain dict sets no domain, and httpx then sends the account
        # cookie to every host, including the media CDN and wherever a redirect points.
        jar = httpx.Cookies()
        jar.set("arl", cookie, domain=".deezer.com")
        jar.set("comeback", "1", domain=".deezer.com")
        self.http = httpx.Client(
            headers={"User-Agent": USER_AGENT, "Accept": "*/*"},
            cookies=jar,
            timeout=httpx.Timeout(30.0),
            follow_redirects=True,
        )
        self.license = ""
        self.api_token = ""
        self.format = "MP3_128"

    def close(self) -> None:
        self.http.close()

    def _payload(self, response: httpx.Response) -> dict[str, object]:
        try:
            response.raise_for_status()
            raw: object = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise DeezerAudioError("Deezer did not answer") from exc
        if not isinstance(raw, dict):
            raise DeezerAudioError("Deezer did not answer")
        # gw-light reports a failure here with an empty results object, and still answers 200.
        # Read as no track, it would file a song as missing while Deezer was only refusing.
        if raw.get("error"):
            raise DeezerAudioError("Deezer did not answer")
        return raw

    def login(self) -> None:
        payload = self._payload(
            self.http.get(
                "https://www.deezer.com/ajax/gw-light.php",
                params={
                    "method": "deezer.getUserData",
                    "input": "3",
                    "api_version": "1.0",
                    "api_token": "",
                },
            )
        )
        results = payload.get("results")
        if not isinstance(results, dict):
            raise DeezerCookieRejected("Deezer did not accept the account cookie")
        user = results.get("USER")
        token = results.get("checkForm")
        if not isinstance(user, dict) or not isinstance(token, str) or not token:
            raise DeezerCookieRejected("Deezer did not accept the account cookie")
        if user.get("USER_ID") in {0, "0"}:
            raise DeezerCookieRejected("Deezer did not accept the account cookie")
        options = user.get("OPTIONS")
        if not isinstance(options, dict) or not isinstance(options.get("license_token"), str):
            raise DeezerCookieRejected("Deezer did not accept the account cookie")
        self.license = str(options["license_token"])
        self.api_token = token
        self.format = choose_format(options.get("web_sound_quality"))

    def track(self, track_id: str) -> dict[str, object]:
        payload = self._payload(
            self.http.post(
                "https://www.deezer.com/ajax/gw-light.php",
                params={
                    "method": "song.getData",
                    "input": "3",
                    "api_version": "1.0",
                    "api_token": self.api_token,
                },
                json={"sng_id": track_id},
            )
        )
        song = payload.get("results")
        if not isinstance(song, dict) or not song.get("TRACK_TOKEN") or not song.get("SNG_ID"):
            raise DeezerNoTrack("Deezer does not have this track for the account")
        return song

    def media_url(self, token: str, fmt: str | None = None) -> str:
        payload = self._payload(
            self.http.post(
                "https://media.deezer.com/v1/get_url",
                json={
                    "license_token": self.license,
                    "media": [
                        {
                            "type": "FULL",
                            "formats": [{"cipher": "BF_CBC_STRIPE", "format": fmt or self.format}],
                        }
                    ],
                    "track_tokens": [token],
                },
            )
        )
        rows = payload.get("data")
        if not isinstance(rows, list) or not rows or not isinstance(rows[0], dict):
            raise DeezerAudioError("Deezer did not return the audio")
        row = rows[0]
        if row.get("errors"):
            raise DeezerAudioError("Deezer did not return the audio")
        media = row.get("media")
        if not isinstance(media, list) or not media or not isinstance(media[0], dict):
            raise DeezerAudioError("Deezer did not return the audio")
        sources = media[0].get("sources")
        if not isinstance(sources, list) or not sources or not isinstance(sources[0], dict):
            raise DeezerAudioError("Deezer did not return the audio")
        url = sources[0].get("url")
        if not isinstance(url, str) or not url.startswith("https://"):
            raise DeezerAudioError("Deezer did not return the audio")
        return url

    def save(self, track_id: str, folder: Path, on_progress: Progress | None) -> Path:
        """Save the account file. A refused quality tries the next one down, then another take."""
        song = self.track(track_id)
        song_id = str(song["SNG_ID"])
        tokens = [(song_id, str(song["TRACK_TOKEN"]))]
        fallback = song.get("FALLBACK")
        if isinstance(fallback, dict) and fallback.get("TRACK_TOKEN"):
            tokens.append((str(fallback.get("SNG_ID") or song_id), str(fallback["TRACK_TOKEN"])))
        last = DeezerAudioError("Deezer did not return the audio")
        for fmt in formats_to_try(self.format):
            for token_id, token in tokens:
                try:
                    url = self.media_url(token, fmt)
                except DeezerAudioError as exc:
                    last = exc
                    continue
                target = folder / f"source.{extension(fmt)}"
                partial = target.with_suffix(target.suffix + ".part")
                key = blowfish_key(token_id)
                try:
                    with self.http.stream("GET", url) as response:
                        try:
                            response.raise_for_status()
                        except httpx.HTTPError as exc:
                            raise DeezerAudioError("Deezer did not return the audio") from exc
                        total = int(response.headers.get("content-length") or 0)
                        written = decrypt_to(
                            response.iter_bytes(), partial, key, total, on_progress
                        )
                except DeezerAudioError as exc:
                    partial.unlink(missing_ok=True)
                    last = exc
                    continue
                except httpx.HTTPError:
                    partial.unlink(missing_ok=True)
                    last = DeezerAudioError("Deezer did not return the audio")
                    continue
                except BaseException:
                    partial.unlink(missing_ok=True)
                    raise
                if written < BLOCK:
                    partial.unlink(missing_ok=True)
                    last = DeezerAudioError("Deezer did not return the audio")
                    continue
                partial.replace(target)
                return target
        raise last


def decrypt_to(
    chunks: Iterable[bytes],
    path: Path,
    key: bytes,
    total: int,
    on_progress: Progress | None,
) -> int:
    pending = bytearray()
    written = 0
    index = 0
    with path.open("wb") as handle:
        for chunk in chunks:
            pending.extend(chunk)
            while len(pending) >= BLOCK:
                block = bytes(pending[:BLOCK])
                del pending[:BLOCK]
                if index % 3 == 0:
                    block = decrypt_block(block, key)
                handle.write(block)
                written += BLOCK
                index += 1
                if on_progress:
                    on_progress(written, total)
        if pending:
            handle.write(pending)
            written += len(pending)
            if on_progress:
                on_progress(written, total or written)
    return written


def fetch(track_id: int, folder: Path, on_progress: Progress | None = None) -> Path:
    account = Account(account_cookie())
    try:
        account.login()
        return account.save(str(track_id), folder, on_progress)
    finally:
        account.close()
