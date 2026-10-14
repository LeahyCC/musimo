"""Import fixtures use the columns read from Navidrome 0.63.2, with invented listening state."""

import asyncio
import sqlite3
import tempfile
import unittest
import wave
from pathlib import Path

from mutagen.id3 import TALB, TIT2, TPE1
from mutagen.wave import WAVE

from backend.core.store import Store
from backend.library.import_navidrome import NavidromeImport
from backend.library.index import Library
from backend.library.player import Player


def write_track(path: Path, title: str) -> None:
    with wave.open(str(path), "wb") as stream:
        stream.setparams((1, 2, 8000, 0, "NONE", "not compressed"))
        stream.writeframes(bytes(1600))
    audio = WAVE(path)
    audio.add_tags()
    assert audio.tags is not None
    audio.tags.add(TIT2(encoding=3, text=title))
    audio.tags.add(TPE1(encoding=3, text="Artist"))
    audio.tags.add(TALB(encoding=3, text="Album"))
    audio.save()


class ImportTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        root = Path(self.folder.name).resolve()
        self.music = root / "music"
        self.music.mkdir()
        for title in ("First", "Second"):
            path = self.music / f"{title}.wav"
            write_track(path, title)
        self.store = Store(root / "target.sqlite3")
        self.addCleanup(self.store.close)
        self.library = Library(self.store, [self.music], asyncio.Event())
        self.library.scan()
        self.source = sqlite3.connect(":memory:")
        self.addCleanup(self.source.close)
        self.source.executescript(r"""
            CREATE TABLE user(id TEXT, user_name TEXT);
            INSERT INTO user VALUES ('u1','listener'), ('u2','other');
            CREATE TABLE library(id INTEGER, path TEXT);
            INSERT INTO library VALUES (1,'Z:\Music');
            CREATE TABLE media_file(id TEXT, path TEXT, artist TEXT, album TEXT, title TEXT,
                                    duration REAL, library_id INTEGER, missing INTEGER);
            INSERT INTO media_file VALUES ('a','First.wav','Artist','Album','First',0.1,1,0),
                                          ('b','Second.wav','Artist','Album','Second',0.1,1,0);
            CREATE TABLE artist(id TEXT, name TEXT);
            INSERT INTO artist VALUES ('ar1','Artist');
            CREATE TABLE annotation(user_id TEXT, item_id TEXT, item_type TEXT,
                                    play_count INTEGER, play_date TEXT, starred INTEGER,
                                    starred_at TEXT);
            INSERT INTO annotation VALUES
                ('u1','a','media_file',8,'2026-09-01 12:00:00+00:00',1,NULL),
                ('u1','ar1','artist',0,NULL,1,'2026-09-01 12:00:00+00:00'),
                ('u2','b','media_file',99,NULL,1,NULL);
            CREATE TABLE playlist(id TEXT, name TEXT, rules TEXT, owner_id TEXT);
            INSERT INTO playlist VALUES ('p1','Road',NULL,'u1'),('p2','Other',NULL,'u2');
            CREATE TABLE playlist_tracks(id INTEGER,playlist_id TEXT,media_file_id TEXT);
            INSERT INTO playlist_tracks VALUES (3,'p1','a'),(1,'p1','a'),(2,'p1','b');
            CREATE TABLE playqueue(user_id TEXT,items TEXT,current INTEGER,position INTEGER);
            INSERT INTO playqueue VALUES ('u1','a,b',1,42);
        """)
        self.importer = NavidromeImport(self.source, "listener", {"Z:\\Music": str(self.music)})

    def test_dry_run_preserves_both_databases(self) -> None:
        source, target = self.source.serialize(), self.store.db.serialize()
        plan = self.importer.plan(self.store.db)
        self.assertEqual(plan.matched_path, 2)
        self.assertEqual(len(plan.plays), 1)
        self.assertEqual(len(plan.likes), 1)
        self.assertEqual(len(plan.artists), 1)
        self.assertEqual(len(plan.playlists), 1)
        self.assertEqual(self.source.serialize(), source)
        self.assertEqual(self.store.db.serialize(), target)

    async def test_apply_preserves_order_duplicates_and_other_user_state_is_excluded(self) -> None:
        player = Player(self.store, [self.music])
        before = player.view()
        plan = self.importer.apply(self.store)
        after = player.view()
        self.assertIsNot(before, after)
        titles = {track["title"]: track for track in after.tracks}
        self.assertEqual(titles["First"]["playCount"], 8)
        self.assertEqual(titles["Second"]["playCount"], 0)
        playlists = self.store.list_playlists()
        self.assertEqual([row["name"] for row in playlists], ["Road", "Liked"])
        road = await player.playlist(f"pl-{playlists[0]['id']}")
        entries = road["entry"]
        assert isinstance(entries, list)
        self.assertEqual([row["title"] for row in entries], ["First", "Second", "First"])
        queue = self.store.read_play_queue()
        self.assertEqual(queue["current"], titles["Second"]["id"])
        self.assertEqual(queue["position"], 42)
        self.assertEqual(len(plan.likes), 1)
        again = self.importer.apply(self.store)
        self.assertEqual(
            (again.plays, again.likes, again.artists, again.playlists), ([], [], [], [])
        )
        self.assertIsNone(again.queue)

    def test_counts_dates_and_existing_queue_never_go_backwards(self) -> None:
        song = self.store.db.execute(
            "SELECT song_id FROM library_files WHERE title='First'"
        ).fetchone()[0]
        self.store.db.execute(
            "UPDATE library_files SET play_count=20,last_played='2099-01-01T00:00:00.000Z'"
        )
        self.store.write_play_queue([song], song, 123)
        plan = self.importer.apply(self.store)
        self.assertEqual(plan.plays, [])
        self.assertIsNone(plan.queue)
        self.assertEqual(self.store.read_play_queue()["position"], 123)

    def test_unique_tags_match_but_ambiguous_missing_and_unsafe_paths_do_not(self) -> None:
        self.source.execute("UPDATE media_file SET path='renamed.wav' WHERE id='a'")
        plan = self.importer.plan(self.store.db)
        self.assertEqual(plan.matched_tags, 1)
        duplicate = self.music / "duplicate.wav"
        write_track(duplicate, "First")
        self.library.scan()
        self.source.execute("UPDATE media_file SET path='../Second.wav' WHERE id='b'")
        self.source.execute(
            "INSERT INTO media_file VALUES ('c','missing.wav','Lost','Lost','Lost',1,1,0)"
        )
        plan = self.importer.plan(self.store.db)
        self.assertEqual(plan.plays, [])
        self.assertEqual(
            {row["kind"] for row in plan.skipped}, {"ambiguous", "unsafe_path", "missing"}
        )

    def test_failed_playlist_write_rolls_back_counts_likes_and_queue(self) -> None:
        self.store.db.execute("""
            CREATE TRIGGER reject_import BEFORE INSERT ON playlist_songs
            BEGIN SELECT RAISE(ABORT, 'test failure'); END
        """)
        before = self.store.db.serialize()
        with self.assertRaises(sqlite3.IntegrityError):
            self.importer.apply(self.store)
        self.assertEqual(self.store.db.serialize(), before)

    def test_disabled_destination_is_refused(self) -> None:
        self.store.db.execute("UPDATE library_roots SET enabled=0")
        with self.assertRaisesRegex(ValueError, "enabled"):
            self.importer.plan(self.store.db)

    def test_large_playlist_is_reported_without_truncating_it(self) -> None:
        self.source.executemany(
            "INSERT INTO playlist_tracks VALUES (?,'p1','a')", [(i,) for i in range(4, 503)]
        )
        plan = self.importer.plan(self.store.db)
        self.assertEqual(plan.playlists, [])
        self.assertIn("playlist_over_500", [row["kind"] for row in plan.skipped])
