import asyncio
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.downloads import stop_tree
from backend.main import create_app
from backend.worker import base_options, cookie_options
from backend.youtube_cookies import clean, drop_copies, remove, saved, write

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

    def test_httponly_rows_are_kept_and_broken_rows_dropped(self) -> None:
        # Exporters mark HttpOnly cookies with this prefix, and YouTube's sign-in cookies are
        # HttpOnly. Dropping them as comments saved a file that could not sign in.
        signed_in = "#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t0\t__Secure-3PSID\tghi"
        extra_field = ".youtube.com\tTRUE\t/\tTRUE\t0\tPREF\tf1\textra"
        body = clean("\n".join([signed_in, extra_field]))
        self.assertIn(signed_in, body)
        self.assertNotIn("extra", body)
        with self.assertRaises(ValueError):
            clean(".notyoutube.com\tTRUE\t/\tTRUE\t0\tSID\tx")

    def test_yt_dlp_gets_a_copy_and_its_write_back_leaves_the_saved_file(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "youtube-cookies.txt"
            path.write_text("# Netscape HTTP Cookie File\n" + YOUTUBE + "\n", encoding="utf-8")
            with patch.dict(os.environ, {"MUSIMO_YOUTUBE_COOKIES": str(path)}):
                # Building the shared options makes no copy. Only a yt-dlp client asks for one.
                self.assertNotIn("cookiefile", base_options())
                copy = Path(str(cookie_options()["cookiefile"]))
                # Later clients in the same process share the copy and its write-back.
                self.assertEqual(Path(str(cookie_options()["cookiefile"])), copy)
                # Beside the saved file on the data volume, never in a job's staging folder,
                # which sits in the music library.
                self.assertNotEqual(copy, path)
                self.assertEqual(copy.parent, path.parent)
                self.assertEqual(copy.read_bytes(), path.read_bytes())
                # yt-dlp saves its jar to the cookie file on close. A running job must not
                # undo a file that was replaced or removed in Settings meanwhile.
                copy.write_text("# Netscape HTTP Cookie File\n" + OTHER + "\n", encoding="utf-8")
                self.assertNotIn("evil.test", path.read_text(encoding="utf-8"))
                # A stopped worker's copy is removed on the next start, and the saved file stays.
                drop_copies(path.parent)
                self.assertFalse(copy.exists())
                self.assertTrue(path.exists())
            with patch.dict(os.environ, {"MUSIMO_YOUTUBE_COOKIES": ""}):
                self.assertEqual(cookie_options(), {})

    def test_remove_and_replace_clear_the_copies_stopped_workers_left(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            data = Path(folder)
            write(data, YOUTUBE)
            left = data / "youtube-cookies.4242.txt"
            left.write_text("# Netscape HTTP Cookie File\n" + YOUTUBE + "\n", encoding="utf-8")
            write(data, YOUTUBE)
            self.assertFalse(left.exists())
            left.write_text("# Netscape HTTP Cookie File\n" + YOUTUBE + "\n", encoding="utf-8")
            remove(data)
            self.assertFalse(left.exists())
            self.assertFalse(saved(data))

    def test_the_server_removes_the_copy_of_a_worker_it_stopped(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "youtube-cookies.txt"
            path.write_text("# Netscape HTTP Cookie File\n" + YOUTUBE + "\n", encoding="utf-8")
            with patch.dict(os.environ, {"MUSIMO_YOUTUBE_COOKIES": str(path)}):

                async def stop_a_worker() -> Path:
                    # A worker that makes its copy and then hangs, as a paused job's would.
                    process = await asyncio.create_subprocess_exec(
                        sys.executable,
                        "-c",
                        "import time\n"
                        "from backend.youtube_cookies import private_copy\n"
                        "print(private_copy(), flush=True)\n"
                        "time.sleep(60)\n",
                        stdout=asyncio.subprocess.PIPE,
                        start_new_session=sys.platform != "win32",
                    )
                    assert process.stdout is not None
                    copy = Path((await process.stdout.readline()).decode().strip())
                    self.assertTrue(copy.is_file())
                    await stop_tree(process)
                    return copy

                copy = asyncio.run(stop_a_worker())
                self.assertFalse(copy.exists())
                self.assertTrue(path.exists())
