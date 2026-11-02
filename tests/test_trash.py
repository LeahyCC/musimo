"""Delete moves songs into the root's trash folder, and a trashed Deezer track is not downloaded."""

import asyncio
import tempfile
import unittest
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from test_holdings import index_file, mark_done

from backend.api.trash_api import install_trash_routes
from backend.core.store import Store
from backend.integrations.catalog import Result
from backend.jobs.holdings import batch_skip
from backend.jobs.job_store import Jobs
from backend.library import trash
from backend.library.index import Library

SONG = "tr-aaaaaaaaaaaaaaaa"
OTHER = "tr-bbbbbbbbbbbbbbbb"


class TrashTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.folder = tempfile.TemporaryDirectory()
        self.root = Path(self.folder.name).resolve() / "music"
        self.root.mkdir()
        self.store = Store(Path(self.folder.name) / "db.sqlite3")
        self.library = Library(self.store, [self.root], asyncio.Event())

    async def asyncTearDown(self) -> None:
        self.store.close()
        self.folder.cleanup()

    def track(self, track_id: int) -> Result:
        return Result(id=track_id, kind="track", title="Elsewhere", artist="Nobody", duration=10)

    async def test_a_deleted_song_goes_to_the_trash_with_its_lyrics(self) -> None:
        song = index_file(self.store, self.root, "Artist/Album/01 Song.flac", SONG)
        (song.parent / "01 Song.lrc").write_text("[00:01] la")
        keep = index_file(self.store, self.root, "Artist/Album/02 Other.flac", OTHER)
        result = self.library.delete_songs([SONG])
        self.assertEqual(result, {"deleted": [SONG], "failed": []})
        binned = self.root / ".musimo-trash" / "Artist" / "Album"
        self.assertTrue((binned / "01 Song.flac").is_file())
        self.assertTrue((binned / "01 Song.lrc").is_file())
        self.assertFalse(song.exists())
        self.assertTrue(keep.exists())
        left = [row[0] for row in self.store.db.execute("SELECT song_id FROM library_files")]
        self.assertEqual(left, [OTHER])
        self.assertEqual(trash.usage([self.root])["files"], 2)

    async def test_the_last_song_takes_its_cover_and_empty_folders_with_it(self) -> None:
        song = index_file(self.store, self.root, "Artist/Album/01 Song.flac", SONG)
        (song.parent / "cover.jpg").write_bytes(b"jpg")
        self.library.delete_songs([SONG])
        self.assertFalse((self.root / "Artist").exists())
        self.assertTrue((self.root / ".musimo-trash" / "Artist" / "Album" / "cover.jpg").is_file())

    async def test_a_second_delete_of_the_same_name_keeps_both(self) -> None:
        index_file(self.store, self.root, "Song.flac", SONG, body=b"one")
        self.library.delete_songs([SONG])
        index_file(self.store, self.root, "Song.flac", OTHER, body=b"two")
        self.library.delete_songs([OTHER])
        binned = self.root / ".musimo-trash"
        self.assertEqual((binned / "Song.flac").read_bytes(), b"one")
        self.assertEqual((binned / "Song (2).flac").read_bytes(), b"two")

    async def test_a_read_only_folder_is_left_alone(self) -> None:
        song = index_file(self.store, self.root, "Song.flac", SONG)
        with patch("backend.library.index.os.access", return_value=False):
            result = self.library.delete_songs([SONG, OTHER])
        self.assertEqual(result["deleted"], [])
        self.assertEqual(
            sorted(row["reason"] for row in result["failed"]),  # type: ignore[attr-defined]
            ["not_found", "read_only"],
        )
        self.assertTrue(song.exists())

    async def test_a_trashed_download_is_refused_until_the_trash_is_emptied(self) -> None:
        song = index_file(self.store, self.root, "Song.flac", SONG)
        mark_done(Jobs(self.store, lambda: None), 7, song, self.root, 10)
        self.library.delete_songs([SONG])
        self.assertEqual(trash.trashed_tracks(self.store, [7, 8]), {7})
        result = self.track(7)
        self.library.annotate([result])
        self.assertEqual(result.ownership, "trashed")
        self.assertEqual(batch_skip(result.matched_by, False), "owned")

        usage = trash.empty(self.store, [self.root])
        self.assertEqual(usage["size"], 0)
        self.assertEqual(trash.trashed_tracks(self.store, [7]), set())
        again = self.track(7)
        self.library.annotate([again])
        self.assertEqual(again.ownership, "missing")

    async def test_emptying_the_folder_by_hand_also_lifts_the_block(self) -> None:
        song = index_file(self.store, self.root, "Song.flac", SONG)
        mark_done(Jobs(self.store, lambda: None), 7, song, self.root, 10)
        self.library.delete_songs([SONG])
        (self.root / ".musimo-trash" / "Song.flac").unlink()
        self.assertEqual(trash.trashed_tracks(self.store, [7]), set())
        self.assertEqual(
            self.store.db.execute("SELECT count(*) FROM library_trash").fetchone()[0], 0
        )


class FakePlayer:
    async def album_song_ids(self, album_id: str) -> list[str]:
        return [SONG]

    async def artist_song_ids(self, artist_id: str) -> list[str]:
        return [SONG]


class TrashRouteTests(unittest.TestCase):
    def test_routes_delete_show_and_empty(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve() / "music"
            root.mkdir()
            store = Store(Path(folder) / "db.sqlite3")
            holder: dict[str, Library] = {}

            @asynccontextmanager
            async def lifespan(_: FastAPI) -> AsyncIterator[None]:
                # Library needs the running loop, so it is made once the app starts.
                holder["library"] = Library(store, [root], asyncio.Event())
                yield

            app = FastAPI(lifespan=lifespan)

            install_trash_routes(
                app,
                lambda: FakePlayer(),  # type: ignore[arg-type,return-value]
                lambda: holder["library"],
                lambda: store,
                lambda: [root],
            )
            try:
                with TestClient(app) as client:
                    index_file(store, root, "Song.flac", SONG, body=b"12345")
                    deleted = client.delete("/api/library/albums/al-1")
                    self.assertEqual(deleted.status_code, 200)
                    self.assertEqual(deleted.json()["deleted"], [SONG])
                    again = client.delete(f"/api/library/tracks/{SONG}")
                    self.assertEqual(again.status_code, 409)
                    self.assertEqual(again.json()["detail"], "That file is already gone.")
                    self.assertEqual(client.get("/api/library/trash").json()["size"], 5)
                    emptied = client.delete("/api/library/trash").json()
                    self.assertEqual((emptied["size"], emptied["files"]), (0, 0))
            finally:
                store.close()
