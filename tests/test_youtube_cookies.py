import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.main import create_app
from backend.worker import base_options
from backend.youtube_cookies import clean, remove, saved, write

YOUTUBE = ".youtube.com\tTRUE\t/\tTRUE\t0\tLOGIN_INFO\tabc"
GOOGLE = ".google.com\tTRUE\t/\tFALSE\t0\tSID\tdef"
OTHER = ".evil.test\tTRUE\t/\tFALSE\t0\tSESSION\tnope"


class YoutubeCookieTests(unittest.TestCase):
    def test_only_youtube_and_google_rows_are_kept(self) -> None:
        body = clean("\n".join(["# comment", YOUTUBE, GOOGLE, OTHER]))
        self.assertIn(YOUTUBE, body)
        self.assertIn(GOOGLE, body)
        self.assertNotIn("evil.test", body)
        self.assertTrue(body.startswith("# Netscape HTTP Cookie File\n"))
        with self.assertRaises(ValueError):
            clean(OTHER)
        with self.assertRaises(ValueError):
            clean("")

    def test_the_file_is_what_yt_dlp_reads_and_settings_never_return_it(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            data = Path(folder)
            write(data, YOUTUBE + "\n" + OTHER)
            text = (data / "youtube-cookies.txt").read_text(encoding="utf-8")
            self.assertNotIn("evil.test", text)
            self.assertTrue(saved(data))
            with TestClient(create_app(data)) as client:
                listed = client.get("/api/settings").json()["youtube_cookies"]
                self.assertTrue(listed["value"])
                self.assertNotIn("LOGIN_INFO", json.dumps(listed))
                self.assertEqual(client.delete("/api/youtube-cookies").json()["saved"], False)
            self.assertFalse(saved(data))
            remove(data)

    def test_a_saved_file_is_passed_to_yt_dlp(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "youtube-cookies.txt"
            path.write_text("# Netscape HTTP Cookie File\n" + YOUTUBE + "\n", encoding="utf-8")
            with patch.dict(os.environ, {"MUSIMO_YOUTUBE_COOKIES": str(path)}):
                self.assertEqual(base_options()["cookiefile"], str(path))
            with patch.dict(os.environ, {"MUSIMO_YOUTUBE_COOKIES": ""}):
                self.assertNotIn("cookiefile", base_options())
