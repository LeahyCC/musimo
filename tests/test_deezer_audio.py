import json
import os
import sqlite3
import stat
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

import httpx
from Cryptodome.Cipher import Blowfish
from fastapi.testclient import TestClient
from pydantic import ValidationError

from backend import deezer_cookie
from backend.deezer_audio import (
    BLOCK,
    Account,
    DeezerAudioError,
    DeezerNoTrack,
    account_cookie,
    blowfish_key,
    choose_format,
    decrypt_stripe,
    decrypt_to,
    formats_to_try,
)
from backend.main import create_app
from backend.models import Settings, SettingsPatch
from backend.store import Store


class DeezerAudioTests(unittest.TestCase):
    def test_cookie_setting_accepts_only_the_account_value(self) -> None:
        self.assertEqual(SettingsPatch(deezer_arl="a" * 192).deezer_arl, "a" * 192)
        self.assertEqual(SettingsPatch(deezer_arl="").deezer_arl, "")
        with self.assertRaises(ValidationError):
            SettingsPatch(deezer_arl="nope")
        # The cookie is not a setting any more. It lives in its own file.
        with self.assertRaises(ValidationError):
            Settings.model_validate({"deezer_arl": "a" * 192})

    def test_catalog_order_keeps_the_saved_sequence(self) -> None:
        saved = Settings(source_order=["youtube", "deezer", "youtube"])
        self.assertEqual(saved.source_order, ["youtube", "deezer"])
        self.assertEqual(Settings(tries_per_source=2).tries_per_source, 2)
        with self.assertRaises(ValidationError):
            Settings(source_order=["bandcamp"])
        with self.assertRaises(ValidationError):
            Settings(source_order=[])

    def test_only_known_sources_can_be_turned_off(self) -> None:
        self.assertEqual(Settings(disabled_sources=["youtube"]).disabled_sources, ["youtube"])
        with self.assertRaises(ValidationError):
            Settings(disabled_sources=["nope"])

    def test_format_follows_the_account(self) -> None:
        self.assertEqual(choose_format({"lossless": True, "high": True}), "FLAC")
        self.assertEqual(choose_format({"lossless": False, "high": True}), "MP3_320")
        self.assertEqual(choose_format({"lossless": False, "high": False}), "MP3_128")
        self.assertEqual(choose_format(None), "MP3_128")
        self.assertEqual(formats_to_try("FLAC"), ("FLAC", "MP3_320", "MP3_128"))
        self.assertEqual(formats_to_try("MP3_320"), ("MP3_320", "MP3_128"))
        self.assertEqual(formats_to_try("MP3_128"), ("MP3_128",))

    def test_a_refused_quality_tries_the_next_one(self) -> None:
        account = Account("ab" * 96)
        account.format = "FLAC"
        asked: list[str] = []

        def media(_token: str, fmt: str | None = None) -> str:
            asked.append(fmt or "")
            return "https://cdn.test/audio"

        class Response:
            def __init__(self, status: int, body: bytes) -> None:
                self.status_code = status
                self.headers = {"content-length": str(len(body))}
                self._body = body

            def raise_for_status(self) -> None:
                if self.status_code >= 400:
                    request = httpx.Request("GET", "https://cdn.test/audio")
                    response = httpx.Response(self.status_code, request=request)
                    raise httpx.HTTPStatusError("refused", request=request, response=response)

            def iter_bytes(self) -> object:
                yield self._body

            def __enter__(self) -> "Response":
                return self

            def __exit__(self, *_args: object) -> None:
                return None

        def stream(_method: str, _url: str) -> Response:
            status = 200 if asked[-1] == "MP3_128" else 403
            return Response(status, b"\x01" * BLOCK)

        try:
            with (
                patch.object(
                    account, "track", return_value={"SNG_ID": "1", "TRACK_TOKEN": "token"}
                ),
                patch.object(account, "media_url", side_effect=media),
                patch.object(account.http, "stream", side_effect=stream),
                tempfile.TemporaryDirectory() as directory,
            ):
                saved = account.save("1", Path(directory), None)
                self.assertEqual(saved.path.suffix, ".mp3")
                self.assertGreaterEqual(saved.path.stat().st_size, BLOCK)
                self.assertFalse(saved.alternate)
        finally:
            account.close()
        self.assertEqual(asked, ["FLAC", "MP3_320", "MP3_128"])

    def test_a_fallback_of_another_recording_is_marked(self) -> None:
        account = Account("ab" * 96)

        class Response:
            def __init__(self, status: int) -> None:
                self.status = status
                self.headers: dict[str, str] = {}

            def raise_for_status(self) -> None:
                if self.status != 200:
                    raise httpx.HTTPStatusError(
                        "refused",
                        request=httpx.Request("GET", "https://cdn.test"),
                        response=httpx.Response(self.status),
                    )

            def iter_bytes(self) -> list[bytes]:
                return [b"\x01" * BLOCK]

            def __enter__(self) -> "Response":
                return self

            def __exit__(self, *_args: object) -> None:
                return None

        # The track's own token is refused, so the file comes from the fallback.
        try:
            for fallback_id, alternate in (("2", True), ("1", False)):
                song = {
                    "SNG_ID": "1",
                    "TRACK_TOKEN": "own",
                    "FALLBACK": {"SNG_ID": fallback_id, "TRACK_TOKEN": "other"},
                }
                with (
                    self.subTest(fallback_id=fallback_id),
                    patch.object(account, "track", return_value=song),
                    patch.object(account, "media_url", side_effect=lambda token, _fmt: token),
                    patch.object(
                        account.http,
                        "stream",
                        side_effect=lambda _method, url: Response(200 if url == "other" else 403),
                    ),
                    tempfile.TemporaryDirectory() as directory,
                ):
                    saved = account.save("1", Path(directory), None)
                    self.assertEqual(saved.alternate, alternate)
        finally:
            account.close()

    def test_every_quality_of_the_track_comes_before_the_fallback(self) -> None:
        account = Account("ab" * 96)
        account.format = "FLAC"
        asked: list[tuple[str, str]] = []

        def media(token: str, fmt: str | None = None) -> str:
            asked.append((token, fmt or ""))
            if fmt == "FLAC":
                raise DeezerAudioError("refused")
            return "https://cdn.test/audio"

        class Response:
            headers: dict[str, str] = {}

            def raise_for_status(self) -> None:
                return None

            def iter_bytes(self) -> list[bytes]:
                return [b"\x01" * BLOCK]

            def __enter__(self) -> "Response":
                return self

            def __exit__(self, *_args: object) -> None:
                return None

        song = {
            "SNG_ID": "1",
            "TRACK_TOKEN": "own",
            "FALLBACK": {"SNG_ID": "2", "TRACK_TOKEN": "other"},
        }
        try:
            with (
                patch.object(account, "track", return_value=song),
                patch.object(account, "media_url", side_effect=media),
                patch.object(account.http, "stream", side_effect=lambda *_args: Response()),
                tempfile.TemporaryDirectory() as directory,
            ):
                saved = account.save("1", Path(directory), None)
                self.assertEqual(saved.path.suffix, ".mp3")
                self.assertFalse(saved.alternate)
        finally:
            account.close()
        self.assertEqual(asked, [("own", "FLAC"), ("own", "MP3_320")])

    def test_cookie_must_be_the_account_value(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "deezer-arl.txt"
            path.write_text("nope", encoding="utf-8")
            with (
                patch.dict("os.environ", {deezer_cookie.ENV: str(path)}),
                self.assertRaises(DeezerAudioError),
            ):
                account_cookie()

    def test_stripe_puts_the_plain_audio_back(self) -> None:
        key = blowfish_key("3135556")
        plain = bytes((index * 17) % 256 for index in range(BLOCK * 4 + 10))
        raw = bytearray(plain)
        block_index = 0
        for start in range(0, len(raw) - BLOCK + 1, BLOCK):
            if block_index % 3 == 0:
                cipher = Blowfish.new(key, Blowfish.MODE_CBC, iv=bytes(range(8)))
                raw[start : start + BLOCK] = cipher.encrypt(bytes(raw[start : start + BLOCK]))
            block_index += 1
        self.assertEqual(decrypt_stripe([bytes(raw[:1000]), bytes(raw[1000:])], key), plain)

    def test_decrypt_to_matches_the_stripe(self) -> None:
        key = blowfish_key("42")
        plain = b"\x01" * (BLOCK * 3)
        cipher = Blowfish.new(key, Blowfish.MODE_CBC, iv=bytes(range(8)))
        encrypted = bytearray(plain)
        encrypted[:BLOCK] = cipher.encrypt(bytes(encrypted[:BLOCK]))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "audio.part"
            written = decrypt_to([bytes(encrypted)], path, key, len(encrypted), None)
            self.assertEqual(written, len(plain))
            self.assertEqual(path.read_bytes(), plain)

    def test_the_account_cookie_only_goes_to_deezer(self) -> None:
        # A cookie set without a domain went to every host: the media CDN and any redirect.
        account = Account("ab" * 96)
        try:
            own = account.http.build_request("GET", "https://www.deezer.com/ajax/gw-light.php")
            self.assertIn("arl=", own.headers.get("cookie", ""))
            for elsewhere in ("https://e-cdns-proxy-1.dzcdn.net/media", "http://mirror.test/x"):
                with self.subTest(url=elsewhere):
                    request = account.http.build_request("GET", elsewhere)
                    self.assertNotIn("arl=", request.headers.get("cookie", ""))
        finally:
            account.close()

    def test_settings_replies_never_carry_the_account_cookie(self) -> None:
        cookie = "ab" * 96
        with tempfile.TemporaryDirectory() as folder:
            with TestClient(create_app(Path(folder))) as client:
                saved = client.patch("/api/settings", json={"deezer_arl": cookie})
                self.assertEqual(saved.status_code, 200)
                replies = (
                    saved.json(),
                    client.get("/api/settings").json(),
                    client.get("/api/snapshot").json()["settings"],
                )
                for reply in replies:
                    self.assertNotIn(cookie, json.dumps(reply))
                    self.assertTrue(reply["deezer_cookie"]["value"])
                    self.assertIn("youtube_cookies", reply)
                # The file holds it. The settings table never does.
                arl_file = Path(folder) / "deezer-arl.txt"
                self.assertEqual(arl_file.read_text(encoding="utf-8"), cookie)
                if os.name == "posix":
                    self.assertEqual(stat.S_IMODE(arl_file.stat().st_mode), 0o600)
                with closing(sqlite3.connect(Path(folder) / "musimo.sqlite3")) as db:
                    table = db.execute("SELECT group_concat(value) FROM settings").fetchone()[0]
                self.assertNotIn(cookie, table)
                # Saving another setting leaves the cookie alone.
                other = client.patch("/api/settings", json={"concurrency": 3})
                self.assertEqual(other.status_code, 200)
                self.assertTrue(other.json()["deezer_cookie"]["value"])
                self.assertTrue(arl_file.is_file())
                client.patch("/api/settings", json={"deezer_arl": ""})
                self.assertFalse(client.get("/api/settings").json()["deezer_cookie"]["value"])
                self.assertFalse(arl_file.exists())

    def test_a_cookie_in_the_settings_table_moves_to_its_file(self) -> None:
        cookie = "cd" * 96
        with tempfile.TemporaryDirectory() as folder, patch.dict("os.environ"):
            # What an older version left: the cookie in the table, and the retired switch.
            store = Store(Path(folder) / "musimo.sqlite3")
            store.db.execute(
                "UPDATE settings SET value=?,origin='database' WHERE key='deezer_arl'",
                (json.dumps(cookie),),
            )
            store.db.execute(
                "INSERT INTO settings VALUES ('soundcloud_fallback','true','database',0)"
            )
            store.close()
            with TestClient(create_app(Path(folder))) as client:
                reply = client.get("/api/settings").json()
                self.assertTrue(reply["deezer_cookie"]["value"])
                self.assertNotIn(cookie, json.dumps(reply))
                self.assertNotIn("soundcloud_fallback", reply)
                self.assertEqual(
                    (Path(folder) / "deezer-arl.txt").read_text(encoding="utf-8"), cookie
                )
            with closing(sqlite3.connect(Path(folder) / "musimo.sqlite3")) as db:
                row = db.execute("SELECT value FROM settings WHERE key='deezer_arl'").fetchone()
            self.assertEqual(json.loads(row[0]), "")

    def test_the_environment_cookie_seeds_the_first_start_only(self) -> None:
        cookie = "ef" * 96
        with (
            tempfile.TemporaryDirectory() as folder,
            patch.dict("os.environ", {"MUSIMO_DEEZER_ARL": cookie}),
        ):
            arl_file = Path(folder) / "deezer-arl.txt"
            with TestClient(create_app(Path(folder))) as client:
                self.assertTrue(client.get("/api/settings").json()["deezer_cookie"]["value"])
                self.assertEqual(arl_file.read_text(encoding="utf-8"), cookie)
                client.patch("/api/settings", json={"deezer_arl": ""})
                # Seeded, so the server's children cannot inherit it.
                self.assertNotIn("MUSIMO_DEEZER_ARL", os.environ)
            # Removed in Settings stays removed, though the variable is set again.
            os.environ["MUSIMO_DEEZER_ARL"] = cookie
            with TestClient(create_app(Path(folder))) as client:
                self.assertFalse(client.get("/api/settings").json()["deezer_cookie"]["value"])
            self.assertFalse(arl_file.exists())

    def test_a_gw_light_error_reply_is_not_read_as_a_missing_track(self) -> None:
        # Deezer answers 200 with an error and empty results. That is a refusal, not "no song".
        account = Account("ab" * 96)
        account.http.close()
        account.http = httpx.Client(
            transport=httpx.MockTransport(
                lambda _: httpx.Response(
                    200,
                    json={"error": {"VALID_TOKEN_REQUIRED": "Invalid CSRF token"}, "results": {}},
                )
            )
        )
        try:
            with self.assertRaises(DeezerAudioError) as raised:
                account.track("1")
            self.assertNotIsInstance(raised.exception, DeezerNoTrack)
        finally:
            account.close()

    def test_deezer_data_error_is_no_song_and_other_errors_are_refusals(self) -> None:
        def answering(body: dict[str, object]) -> Account:
            account = Account("ab" * 96)
            account.http.close()
            account.http = httpx.Client(
                transport=httpx.MockTransport(lambda _: httpx.Response(200, json=body))
            )
            return account

        errors: tuple[object, ...] = ({"DATA_ERROR": "No song"}, ["DATA_ERROR"], "DATA_ERROR")
        for error in errors:
            with self.subTest(error=error):
                missing = answering({"error": error, "results": {}})
                try:
                    with self.assertRaises(DeezerNoTrack):
                        missing.track("1")
                finally:
                    missing.close()
        # The account check is not a song lookup. The same word there must not read as no song.
        account = answering({"error": {"DATA_ERROR": "No song"}, "results": {}})
        try:
            with self.assertRaises(DeezerAudioError) as raised:
                account.login()
            self.assertNotIsInstance(raised.exception, DeezerNoTrack)
        finally:
            account.close()
