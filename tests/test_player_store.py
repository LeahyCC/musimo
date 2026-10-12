"""Schema version 6: local playback state, and the old playback settings rows leaving."""

import re
import sqlite3
import tempfile
import unittest
from pathlib import Path

from backend.core.store import REMOVED_SETTING_KEYS, Store, drop_song_references

SONG_ID = re.compile(r"^tr-[0-9a-f]{16}$")


class PlayerStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.folder = tempfile.TemporaryDirectory()
        self.root = Path(self.folder.name)

    def tearDown(self) -> None:
        self.folder.cleanup()

    def test_version_5_database_opens_without_navidrome_settings(self) -> None:
        path = self.root / "v5.sqlite3"
        db = sqlite3.connect(path)
        db.executescript("""
            CREATE TABLE settings (
                key TEXT PRIMARY KEY, value TEXT NOT NULL,
                origin TEXT NOT NULL, locked INTEGER NOT NULL DEFAULT 0
            );
            INSERT INTO settings VALUES
                ('navidrome_url', '"http://navidrome:4533"', 'database', 0),
                ('navidrome_mode', '"api"', 'database', 0),
                ('navidrome_library_id', '1', 'database', 0),
                ('library_label', '"Shelf"', 'database', 0);
            CREATE TABLE library_files (
                path TEXT PRIMARY KEY, root TEXT NOT NULL,
                mtime_ns INTEGER NOT NULL, size INTEGER NOT NULL, generation TEXT NOT NULL,
                title TEXT NOT NULL, artist TEXT NOT NULL, album TEXT NOT NULL,
                title_key TEXT NOT NULL, artist_key TEXT NOT NULL, album_key TEXT NOT NULL,
                duration REAL NOT NULL, isrc TEXT NOT NULL, mbid TEXT NOT NULL
            );
            INSERT INTO library_files VALUES (
                'blank.wav', '/music', 1700000000000000000, 10, 'g',
                '', '', '', '', '', '', 0, '', ''
            );
            CREATE TABLE waveforms (
                song_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, peaks BLOB NOT NULL
            );
            INSERT INTO waveforms VALUES ('nd-old', 'fp', x'00');
            CREATE TABLE linked_playlists (
                key TEXT PRIMARY KEY, playlist_id TEXT NOT NULL
            );
            INSERT INTO linked_playlists VALUES ('liked', 'nd-playlist-stale');
            PRAGMA user_version=5;
        """)
        # A path that is not valid UTF-8. The upgrade must not decode it.
        db.execute(
            "INSERT INTO library_files VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                b"caf\xff.mp3",
                "/music",
                1700000000000000000,
                4,
                "g",
                "",
                "",
                "",
                "",
                "",
                "",
                1.0,
                "",
                "",
            ),
        )
        db.commit()
        db.close()

        for _ in range(2):
            store = Store(path)
            try:
                self.assertEqual(store.db.execute("PRAGMA user_version").fetchone()[0], 6)
                keys = {row[0] for row in store.db.execute("SELECT key FROM settings")}
                self.assertTrue(set(REMOVED_SETTING_KEYS).isdisjoint(keys))
                self.assertEqual(store.current().library_label, "Shelf")
                self.assertEqual(store.linked_playlist("liked"), "nd-playlist-stale")
                self.assertEqual(
                    store.db.execute("SELECT count(*) FROM waveforms").fetchone()[0], 0
                )
                rows = store.db.execute("SELECT song_id, added_at FROM library_files").fetchall()
                self.assertEqual(len(rows), 2)
                self.assertTrue(all(SONG_ID.fullmatch(str(row[0])) for row in rows))
                self.assertEqual(len({str(row[0]) for row in rows}), 2)
                self.assertTrue(all(str(row[1]) for row in rows))
                self.assertEqual(store.library_revision(), 0)
            finally:
                store.close()

    def test_version_4_database_upgrades_to_6(self) -> None:
        path = self.root / "v4.sqlite3"
        db = sqlite3.connect(path)
        db.executescript("""
            CREATE TABLE settings (
                key TEXT PRIMARY KEY, value TEXT NOT NULL,
                origin TEXT NOT NULL, locked INTEGER NOT NULL DEFAULT 0
            );
            INSERT INTO settings VALUES
                ('navidrome_url', '"http://playback:4533"', 'database', 0),
                ('navidrome_mode', '"api"', 'database', 0),
                ('navidrome_library_id', '1', 'database', 0),
                ('library_label', '"Shelf"', 'database', 0);
            CREATE TABLE queue_control (
                id INTEGER PRIMARY KEY CHECK(id=1), paused INTEGER NOT NULL DEFAULT 0,
                source_paused INTEGER NOT NULL DEFAULT 0,
                blocking_failures INTEGER NOT NULL DEFAULT 0
            );
            INSERT INTO queue_control VALUES (1, 0, 0, 0);
            CREATE TABLE source_control (
                source TEXT PRIMARY KEY, paused INTEGER NOT NULL DEFAULT 0,
                blocking_failures INTEGER NOT NULL DEFAULT 0
            );
            INSERT INTO source_control VALUES ('youtube', 1, 2);
            CREATE TABLE library_files (
                path TEXT PRIMARY KEY, root TEXT NOT NULL,
                mtime_ns INTEGER NOT NULL, size INTEGER NOT NULL, generation TEXT NOT NULL,
                title TEXT NOT NULL, artist TEXT NOT NULL, album TEXT NOT NULL,
                title_key TEXT NOT NULL, artist_key TEXT NOT NULL, album_key TEXT NOT NULL,
                duration REAL NOT NULL, isrc TEXT NOT NULL, mbid TEXT NOT NULL
            );
            INSERT INTO library_files VALUES (
                'kept.wav', '/music', 1700000000000000000, 10, 'g',
                'Kept', 'Artist', 'Album', 'kept', 'artist', 'album', 1, '', ''
            );
            PRAGMA user_version=4;
        """)
        db.commit()
        db.close()

        for _ in range(2):
            store = Store(path)
            try:
                self.assertEqual(store.db.execute("PRAGMA user_version").fetchone()[0], 6)
                keys = {row[0] for row in store.db.execute("SELECT key FROM settings")}
                self.assertTrue(set(REMOVED_SETTING_KEYS).isdisjoint(keys))
                self.assertEqual(store.current().library_label, "Shelf")
                pace = store.db.execute(
                    "SELECT pace_started, pace_until FROM queue_control"
                ).fetchone()
                self.assertEqual(tuple(pace), (0, 0.0))
                self.assertEqual(store.controls()["paused_sources"], ["youtube"])
                song_id = store.db.execute("SELECT song_id FROM library_files").fetchone()[0]
                self.assertTrue(SONG_ID.fullmatch(str(song_id)))
                self.assertEqual(
                    store.db.execute(
                        "SELECT name FROM sqlite_master WHERE type='table' AND name='playlists'"
                    ).fetchone()[0],
                    "playlists",
                )
            finally:
                store.close()

    def test_newer_database_is_refused(self) -> None:
        path = self.root / "newer.sqlite3"
        db = sqlite3.connect(path)
        db.execute("PRAGMA user_version=7")
        db.close()
        with self.assertRaises(RuntimeError):
            Store(path)

    def test_playlists_favourites_plays_and_queue(self) -> None:
        store = Store(self.root / "db.sqlite3")
        try:
            store.db.execute("INSERT INTO library_roots VALUES ('/music', 1)")
            store.db.execute(
                "INSERT INTO library_files ("
                "path, root, mtime_ns, size, generation, title, artist, album, "
                "title_key, artist_key, album_key, duration, isrc, mbid, song_id, added_at"
                ") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    "/music/a.mp3",
                    "/music",
                    1,
                    10,
                    "g",
                    "Title",
                    "Artist",
                    "Album",
                    "title",
                    "artist",
                    "album",
                    3.5,
                    "",
                    "",
                    "tr-aaaaaaaaaaaaaaaa",
                    "2020-01-01T00:00:00.000000Z",
                ),
            )
            store.db.execute(
                "INSERT INTO library_files ("
                "path, root, mtime_ns, size, generation, title, artist, album, "
                "title_key, artist_key, album_key, duration, isrc, mbid, song_id, added_at"
                ") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    "/music/b.mp3",
                    "/music",
                    1,
                    10,
                    "g",
                    "Other",
                    "Artist",
                    "Album",
                    "other",
                    "artist",
                    "album",
                    4.0,
                    "",
                    "",
                    "tr-bbbbbbbbbbbbbbbb",
                    "2020-01-01T00:00:00.000000Z",
                ),
            )
            created = store.create_playlist(
                "Evening", ["tr-aaaaaaaaaaaaaaaa", "tr-bbbbbbbbbbbbbbbb"]
            )
            playlist_id = created["id"]
            assert isinstance(playlist_id, int)
            self.assertEqual(created["song_ids"], ["tr-aaaaaaaaaaaaaaaa", "tr-bbbbbbbbbbbbbbbb"])
            removed = store.remove_playlist_song(playlist_id, 0)
            assert removed is not None
            self.assertEqual(removed["song_ids"], ["tr-bbbbbbbbbbbbbbbb"])
            positions = [
                int(row[0])
                for row in store.db.execute(
                    "SELECT position FROM playlist_songs WHERE playlist_id=? ORDER BY position",
                    (playlist_id,),
                )
            ]
            self.assertEqual(positions, [0])
            self.assertIsNone(store.remove_playlist_song(playlist_id, 3))
            renamed = store.rename_playlist(playlist_id, "Morning")
            assert renamed is not None
            self.assertEqual(renamed["name"], "Morning")
            listed = store.list_playlists()
            self.assertEqual(listed[0]["song_count"], 1)
            self.assertEqual(listed[0]["duration"], 4.0)
            self.assertTrue(store.delete_playlist(playlist_id))
            self.assertEqual(
                store.db.execute("SELECT count(*) FROM playlist_songs").fetchone()[0], 0
            )

            starred = store.set_artist_favourite("ar-1", True)
            self.assertEqual(store.set_artist_favourite("ar-1", True), starred)
            self.assertEqual(store.artist_favourites(), {"ar-1": starred})
            self.assertIsNone(store.set_artist_favourite("ar-1", False))
            self.assertEqual(store.artist_favourites(), {})

            self.assertTrue(store.record_play("tr-aaaaaaaaaaaaaaaa"))
            store.db.execute(
                "UPDATE library_files SET last_played=? WHERE song_id=?",
                ("2099-01-01T00:00:00.000000Z", "tr-aaaaaaaaaaaaaaaa"),
            )
            self.assertTrue(store.record_play("tr-aaaaaaaaaaaaaaaa"))
            row = store.db.execute(
                "SELECT play_count, last_played FROM library_files WHERE song_id=?",
                ("tr-aaaaaaaaaaaaaaaa",),
            ).fetchone()
            self.assertEqual(int(row[0]), 2)
            self.assertEqual(str(row[1]), "2099-01-01T00:00:00.000000Z")
            self.assertFalse(store.record_play("tr-missing"))

            store.write_play_queue(["tr-aaaaaaaaaaaaaaaa", "tr-missing"], "tr-missing", 1200)
            cleaned = store.read_play_queue()
            self.assertEqual(cleaned["song_ids"], ["tr-aaaaaaaaaaaaaaaa"])
            self.assertEqual(cleaned["current"], "")
            self.assertEqual(cleaned["position"], 0)
            again = store.read_play_queue()
            self.assertEqual(again["song_ids"], ["tr-aaaaaaaaaaaaaaaa"])

            kept = store.create_playlist("Kept", ["tr-aaaaaaaaaaaaaaaa", "tr-bbbbbbbbbbbbbbbb"])
            store.write_play_queue(
                ["tr-aaaaaaaaaaaaaaaa", "tr-bbbbbbbbbbbbbbbb"], "tr-bbbbbbbbbbbbbbbb", 40
            )
            store.save_waveform("tr-aaaaaaaaaaaaaaaa", "fp", b"peaks")
            store.db.execute("BEGIN IMMEDIATE")
            drop_song_references(store.db, ["tr-aaaaaaaaaaaaaaaa"])
            store.db.commit()
            kept_id = kept["id"]
            assert isinstance(kept_id, int)
            leftover = store.playlist(kept_id)
            assert leftover is not None
            self.assertEqual(leftover["song_ids"], ["tr-bbbbbbbbbbbbbbbb"])
            self.assertEqual(store.read_play_queue()["song_ids"], ["tr-bbbbbbbbbbbbbbbb"])
            self.assertEqual(store.read_play_queue()["current"], "tr-bbbbbbbbbbbbbbbb")
            self.assertIsNone(store.waveform("tr-aaaaaaaaaaaaaaaa", "fp"))
            self.assertEqual(store.bump_library_revision(), 1)
        finally:
            store.close()
