"""Account listening: signed-in Play, fallbacks, and a removed cookie."""

import sqlite3
import tempfile
import threading
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.integrations import deezer_cookie
from backend.integrations.deezer_audio import Saved, allows_full
from backend.jobs.account_listen import (
    BUSY,
    COMMAND_REQUIRED,
    FREE_ACCOUNT,
    UNAVAILABLE,
    drop_cache,
)
from backend.jobs.account_lock import AccountBusy, hold
from backend.jobs.file_command import FileCommandError
from backend.main import create_app

COOKIE = "ab" * 96


def _sign_in(self: object) -> None:
    account = self
    assert hasattr(account, "full_file")
    account.full_file = True


def _free(self: object) -> None:
    account = self
    assert hasattr(account, "full_file")
    account.full_file = False


def _fetch(track_id: int, folder: Path, _progress: object) -> Saved:
    path = folder / "account.bin"
    path.write_bytes(b"saved-account-file")
    return Saved(path, False)


def _prepare(folder: Path, _probe: object, command: str | None = None) -> Path:
    if not command:
        raise FileCommandError("The Deezer file could not be read")
    target = folder / "source.mp3"
    target.write_bytes(b"playable-audio")
    (folder / "account.bin").unlink(missing_ok=True)
    return target


class AccountListenTests(unittest.TestCase):
    def setUp(self) -> None:
        self._dir = tempfile.TemporaryDirectory()
        self.data = Path(self._dir.name)
        drop_cache(self.data)

    def tearDown(self) -> None:
        drop_cache(self.data)
        self._dir.cleanup()

    def test_a_full_file_follows_the_account_flags(self) -> None:
        self.assertTrue(allows_full({"web_sound_quality": {"low": True}}))
        self.assertFalse(allows_full({"web_streaming": False, "mobile_streaming": False}))
        self.assertFalse(
            allows_full({"web_sound_quality": {"low": False, "standard": False, "high": False}})
        )

    def test_signed_in_play_serves_a_musimo_file_and_does_not_count_a_library_play(self) -> None:
        deezer_cookie.write(self.data, COOKIE)
        with (
            TestClient(create_app(self.data)) as client,
            patch("backend.jobs.account_listen.Account.login", _sign_in),
            patch("backend.jobs.account_listen.fetch", _fetch),
            patch("backend.jobs.account_listen.prepare", _prepare),
        ):
            saved = client.patch("/api/settings", json={"file_command": "decode"})
            self.assertEqual(saved.status_code, 200)
            health = client.get("/api/diagnostics").json()["deezer_listen"]
            self.assertTrue(health["ready"])
            self.assertTrue(health["command"])
            played = client.post(
                "/api/player/account/dz-7",
                json={
                    "title": "Song",
                    "artist": "Artist",
                    "album": "Album",
                    "duration": 180,
                    "art": "https://cdn.example/a.jpg",
                },
            )
            self.assertEqual(played.status_code, 200, played.text)
            body = played.json()
            self.assertEqual(body["play"], "account")
            self.assertTrue(body["url"].startswith("/api/player/account/dz-7/file"))
            audio = client.get(body["url"])
            self.assertEqual(audio.status_code, 200)
            self.assertEqual(audio.content, b"playable-audio")
            self.assertNotIn(COOKIE, audio.text)
            counted = client.post("/api/player/scrobble", json={"id": "dz-7", "submission": True})
            self.assertEqual(counted.status_code, 204)

    def test_a_missing_sign_in_stays_on_preview(self) -> None:
        with TestClient(create_app(self.data)) as client:
            health = client.get("/api/diagnostics").json()["deezer_listen"]
            self.assertFalse(health["ready"])
            played = client.post("/api/player/account/dz-7", json={"title": "Song"})
            self.assertEqual(played.json()["play"], "off")

    def test_a_free_account_stays_on_preview_and_says_so(self) -> None:
        deezer_cookie.write(self.data, COOKIE)
        with (
            TestClient(create_app(self.data)) as client,
            patch("backend.jobs.account_listen.Account.login", _free),
        ):
            health = client.get("/api/diagnostics").json()["deezer_listen"]
            self.assertFalse(health["ready"])
            self.assertEqual(health["detail"], FREE_ACCOUNT)
            played = client.post("/api/player/account/dz-7", json={"title": "Song"})
            self.assertEqual(played.json()["play"], "off")
            self.assertEqual(played.json()["detail"], FREE_ACCOUNT)

    def test_a_library_file_plays_from_disk(self) -> None:
        deezer_cookie.write(self.data, COOKIE)
        with (
            TestClient(create_app(self.data)) as client,
            patch("backend.jobs.account_listen.Account.login", _sign_in),
            patch("backend.jobs.account_listen.library_song", return_value="tr-library"),
            patch("backend.jobs.account_listen.fetch") as fetched,
        ):
            client.patch("/api/settings", json={"file_command": "decode"})
            played = client.post("/api/player/account/dz-7", json={"title": "Song"})
            self.assertEqual(
                played.json(),
                {"play": "library", "detail": "", "url": "", "id": "tr-library"},
            )
            fetched.assert_not_called()

    def test_an_empty_command_asks_for_one_unless_the_file_already_plays(self) -> None:
        deezer_cookie.write(self.data, COOKIE)
        with (
            TestClient(create_app(self.data)) as client,
            patch("backend.jobs.account_listen.Account.login", _sign_in),
            patch("backend.jobs.account_listen.fetch", _fetch),
            patch("backend.jobs.account_listen.prepare", _prepare),
        ):
            refused = client.post("/api/player/account/dz-7", json={"title": "Song"})
            self.assertEqual(refused.json()["play"], "preview")
            self.assertEqual(refused.json()["detail"], COMMAND_REQUIRED)
            folder = self.data / "account-listen" / "9"
            folder.mkdir(parents=True)
            (folder / "source.mp3").write_bytes(b"already")
            health = client.get("/api/diagnostics").json()["deezer_listen"]
            self.assertIn(9, health["cached"])
            self.assertNotIn(7, health["cached"])

    def test_a_removed_cookie_stops_the_stream(self) -> None:
        deezer_cookie.write(self.data, COOKIE)
        with (
            TestClient(create_app(self.data)) as client,
            patch("backend.jobs.account_listen.Account.login", _sign_in),
            patch("backend.jobs.account_listen.fetch", _fetch),
            patch("backend.jobs.account_listen.prepare", _prepare),
        ):
            client.patch("/api/settings", json={"file_command": "decode"})
            played = client.post("/api/player/account/dz-7", json={"title": "Song"})
            url = played.json()["url"]
            self.assertEqual(client.get(url).status_code, 200)
            before = client.get("/api/diagnostics").json()["deezer_listen"]["mark"]
            self.assertTrue(before)
            self.assertNotIn(COOKIE, before)
            removed = client.patch("/api/settings", json={"deezer_arl": ""})
            self.assertEqual(removed.status_code, 200)
            self.assertEqual(client.get(url).status_code, 404)
            self.assertFalse((self.data / "account-listen").exists())
            health = client.get("/api/diagnostics").json()["deezer_listen"]
            self.assertFalse(health["ready"])
            self.assertEqual(health["mark"], "")
        with closing(sqlite3.connect(self.data / "musimo.sqlite3")) as db:
            payloads = [
                str(row[0])
                for row in db.execute(
                    "SELECT payload FROM job_events WHERE kind='settings.updated'"
                )
            ]
        self.assertTrue(payloads)
        self.assertNotIn(COOKIE, "".join(payloads))

    def test_replacing_the_cookie_drops_the_listening_file(self) -> None:
        deezer_cookie.write(self.data, COOKIE)
        with (
            TestClient(create_app(self.data)) as client,
            patch("backend.jobs.account_listen.Account.login", _sign_in),
            patch("backend.jobs.account_listen.fetch", _fetch),
            patch("backend.jobs.account_listen.prepare", _prepare),
        ):
            client.patch("/api/settings", json={"file_command": "decode"})
            played = client.post("/api/player/account/dz-7", json={"title": "Song"})
            url = played.json()["url"]
            before = client.get("/api/diagnostics").json()["deezer_listen"]["mark"]
            replaced = client.patch("/api/settings", json={"deezer_arl": "cd" * 96})
            self.assertEqual(replaced.status_code, 200)
            after = client.get("/api/diagnostics").json()["deezer_listen"]
            self.assertNotEqual(before, after["mark"])
            self.assertNotIn("cd" * 96, after["mark"])
            self.assertEqual(client.get(url).status_code, 404)
            self.assertFalse((self.data / "account-listen").exists())

    def test_the_file_command_does_not_hold_the_cookie(self) -> None:
        deezer_cookie.write(self.data, COOKIE)
        free = {"value": False}

        def _command(folder: Path, _probe: object, command: str | None = None) -> Path:
            def probe() -> None:
                try:
                    with hold(self.data, wait=False):
                        free["value"] = True
                except AccountBusy:
                    free["value"] = False

            thread = threading.Thread(target=probe)
            thread.start()
            thread.join(5)
            self.assertFalse(thread.is_alive())
            target = folder / "source.mp3"
            target.write_bytes(b"playable-audio")
            (folder / "account.bin").unlink(missing_ok=True)
            return target

        with (
            TestClient(create_app(self.data)) as client,
            patch("backend.jobs.account_listen.Account.login", _sign_in),
            patch("backend.jobs.account_listen.fetch", _fetch),
            patch("backend.jobs.account_listen.prepare", _command),
        ):
            client.patch("/api/settings", json={"file_command": "decode"})
            played = client.post("/api/player/account/dz-7", json={"title": "Song"})
            self.assertEqual(played.json()["play"], "account", played.text)
        self.assertTrue(free["value"])

    def test_a_busy_account_is_left_running(self) -> None:
        deezer_cookie.write(self.data, COOKIE)
        with (
            TestClient(create_app(self.data)) as client,
            patch("backend.jobs.account_listen.Account.login", _sign_in),
            patch("backend.jobs.account_listen.fetch") as fetched,
            hold(self.data),
        ):
            client.patch("/api/settings", json={"file_command": "decode"})
            played = client.post("/api/player/account/dz-7", json={"title": "Song"})
            self.assertEqual(played.json()["play"], "busy")
            self.assertEqual(played.json()["detail"], BUSY)
            fetched.assert_not_called()

    def test_an_unavailable_song_is_not_a_preview(self) -> None:
        deezer_cookie.write(self.data, COOKIE)

        def missing(*_args: object, **_kwargs: object) -> Saved:
            from backend.integrations.deezer_audio import DeezerUnavailable

            raise DeezerUnavailable(UNAVAILABLE)

        with (
            TestClient(create_app(self.data)) as client,
            patch("backend.jobs.account_listen.Account.login", _sign_in),
            patch("backend.jobs.account_listen.fetch", missing),
        ):
            client.patch("/api/settings", json={"file_command": "decode"})
            played = client.post("/api/player/account/dz-4", json={"title": "Song"})
            self.assertEqual(played.json()["play"], "unavailable")
            self.assertEqual(played.json()["detail"], UNAVAILABLE)
            again = client.get("/api/diagnostics").json()["deezer_listen"]
            self.assertIn(4, again["unavailable"])
