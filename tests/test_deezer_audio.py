import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from Cryptodome.Cipher import Blowfish
from pydantic import ValidationError

from backend.deezer_audio import (
    BLOCK,
    Account,
    DeezerAudioError,
    account_cookie,
    blowfish_key,
    choose_format,
    decrypt_stripe,
    decrypt_to,
    formats_to_try,
)
from backend.models import Settings


class DeezerAudioTests(unittest.TestCase):
    def test_cookie_setting_accepts_only_the_account_value(self) -> None:
        self.assertEqual(Settings(deezer_arl="a" * 192).deezer_arl, "a" * 192)
        self.assertEqual(Settings(deezer_arl="").deezer_arl, "")
        with self.assertRaises(ValidationError):
            Settings(deezer_arl="nope")

    def test_catalog_order_keeps_the_saved_sequence(self) -> None:
        saved = Settings(source_order=["youtube", "deezer", "youtube"])
        self.assertEqual(saved.source_order, ["youtube", "deezer"])
        self.assertEqual(Settings(tries_per_source=2).tries_per_source, 2)
        with self.assertRaises(ValidationError):
            Settings(source_order=["bandcamp"])

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
                self.assertEqual(saved.suffix, ".mp3")
                self.assertGreaterEqual(saved.stat().st_size, BLOCK)
        finally:
            account.close()
        self.assertEqual(asked, ["FLAC", "MP3_320", "MP3_128"])

    def test_cookie_must_be_the_account_value(self) -> None:
        with (
            patch.dict("os.environ", {"MUSIMO_DEEZER_ARL": "nope"}),
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
