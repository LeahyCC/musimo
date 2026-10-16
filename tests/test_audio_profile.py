"""Schema 9: song characteristic rows, the worker queue, freshness, bands and scoring."""

import asyncio
import base64
import contextlib
import io
import sqlite3
import struct
import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import numpy as np
from pydantic import ValidationError
from test_player import tag, write_wav

from backend.core.audio_recipes import RECIPES, SCALAR_RECIPE, Recipe, recipe_for, registered
from backend.core.store import SCHEMA_VERSION, Store
from backend.library.audio_profile import (
    LEASE_SECONDS,
    MAX_ATTEMPTS,
    AudioProfiles,
    LeaseError,
    WorkerResult,
    energy_band,
    percentile_bands,
    tempo_band,
    unit,
)
from backend.library.index import Library
from backend.library.player import Player, StoredSong
from scripts.enqueue_audio_trial import enqueue
from scripts.enqueue_audio_trial import main as enqueue_main

SCALAR = RECIPES[SCALAR_RECIPE]
T0 = datetime(2026, 10, 15, 12, tzinfo=UTC)


def floats(*values: float) -> str:
    return base64.b64encode(struct.pack(f"<{len(values)}f", *values)).decode()


def result(job: dict[str, Any], **changes: object) -> WorkerResult:
    body: dict[str, object] = {
        "song_id": job["song_id"],
        "recipe": job["recipe"],
        "lease_token": job["lease_token"],
        "size": job["size"],
        "mtime_ns": job["mtime_ns"],
        "status": "done",
        "tempo_bpm": 120.0,
        "energy": 0.1,
    }
    return WorkerResult.model_validate(body | changes)


class SchemaTests(unittest.TestCase):
    def setUp(self) -> None:
        self.folder = tempfile.TemporaryDirectory()
        self.root = Path(self.folder.name)

    def tearDown(self) -> None:
        self.folder.cleanup()

    def test_version_8_database_upgrades_and_keeps_its_rows(self) -> None:
        path = self.root / "v8.sqlite3"
        store = Store(path)
        store.db.execute("INSERT INTO library_roots VALUES ('/music', 1)")
        store.db.execute(
            "INSERT INTO library_files(path,root,mtime_ns,size,generation,title,artist,album,"
            "title_key,artist_key,album_key,duration,isrc,mbid,song_id,play_count,last_played) "
            "VALUES ('kept.wav','/music',1,2,'g','Kept','Artist','Album','','','',42,'','',"
            "'tr-aaaaaaaaaaaaaaaa',7,'2026-01-01T00:00:00Z')"
        )
        store.db.commit()
        playlist = store.create_playlist("Kept", ["tr-aaaaaaaaaaaaaaaa"])
        # Back to version 8: no characteristic tables at all.
        store.db.executescript("""
            DROP TABLE audio_profile;
            DROP TABLE audio_job;
            PRAGMA user_version=8;
        """)
        store.close()
        for _ in range(2):
            store = Store(path)
            try:
                self.assertEqual(
                    store.db.execute("PRAGMA user_version").fetchone()[0], SCHEMA_VERSION
                )
                self.assertEqual(SCHEMA_VERSION, 9)
                tables = {
                    row[0]
                    for row in store.db.execute(
                        "SELECT name FROM sqlite_master WHERE type IN ('table','index')"
                    )
                }
                self.assertTrue({"audio_profile", "audio_job", "audio_profile_recipe"} <= tables)
                profile = {row[1] for row in store.db.execute("PRAGMA table_info(audio_profile)")}
                self.assertEqual(
                    profile,
                    {
                        "song_id",
                        "recipe",
                        "status",
                        "size",
                        "mtime_ns",
                        "tempo_bpm",
                        "energy",
                        "dim",
                        "vector",
                        "detail",
                        "updated_at",
                    },
                )
                job = {row[1] for row in store.db.execute("PRAGMA table_info(audio_job)")}
                self.assertEqual(
                    job,
                    {"song_id", "recipe", "status", "lease_token", "leased_until", "attempts"},
                )
                row = store.db.execute(
                    "SELECT play_count, last_played FROM library_files"
                ).fetchone()
                self.assertEqual(tuple(row), (7, "2026-01-01T00:00:00Z"))
                playlist_id = playlist["id"]
                assert isinstance(playlist_id, int)
                saved = store.playlist(playlist_id)
                assert saved is not None
                self.assertEqual(saved["song_ids"], ["tr-aaaaaaaaaaaaaaaa"])
                with self.assertRaises(sqlite3.IntegrityError):
                    store.db.execute(
                        "INSERT INTO audio_profile VALUES ('tr-aaaaaaaaaaaaaaaa','r','odd',"
                        "1,1,NULL,NULL,0,NULL,'','now')"
                    )
            finally:
                store.close()


class ProfileTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.folder = tempfile.TemporaryDirectory()
        self.root = Path(self.folder.name)
        self.music = self.root / "music"
        self.music.mkdir()
        self.store = Store(self.root / "musimo.sqlite3")
        self.library = Library(self.store, [self.music], asyncio.Event())
        for name, title, genres in (
            ("a.wav", "Alpha", ["Rock"]),
            ("b.wav", "Beta", ["Rock"]),
            ("c.wav", "Chatter", ["Podcast"]),
        ):
            path = self.music / name
            write_wav(path)
            tag(path, title=title, artist="Fixture", album="Rows", genres=genres)
        self.library.scan()
        self.player = Player(self.store, [self.music])
        self.ids = {str(track["title"]): str(track["id"]) for track in self.player.view().tracks}
        self.profiles = AudioProfiles(self.store)

    async def asyncTearDown(self) -> None:
        self.store.close()
        self.folder.cleanup()

    def song(self, title: str) -> StoredSong:
        self.store.bump_library_revision()
        return self.player.view().stored[self.ids[title]]

    def lease(self, now: datetime = T0, recipe: str = SCALAR_RECIPE) -> dict[str, Any]:
        job = self.profiles.lease(recipe, now)
        assert job is not None
        return job

    def queue_rows(self) -> list[tuple[str, str, int]]:
        return [
            (str(row[0]), str(row[1]), int(row[2]))
            for row in self.store.db.execute(
                "SELECT song_id, status, attempts FROM audio_job ORDER BY rowid"
            )
        ]

    def test_enqueue_lease_and_a_done_result_round_trip(self) -> None:
        self.assertEqual(enqueue(self.store, SCALAR_RECIPE, 2), 2)
        self.assertEqual(self.profiles.queued(SCALAR_RECIPE), 2)
        self.assertEqual(self.profiles.lacking(SCALAR_RECIPE), 1)
        # Already queued songs are left alone; the limit counts new rows.
        self.assertEqual(enqueue(self.store, SCALAR_RECIPE, 5), 1)
        self.assertEqual(self.profiles.lacking(SCALAR_RECIPE), 0)
        job = self.lease()
        self.assertEqual(
            set(job),
            {
                "song_id",
                "recipe",
                "lease_token",
                "leased_until",
                "path",
                "size",
                "mtime_ns",
                "duration",
                "genre",
                "genres",
            },
        )
        self.assertEqual(job["leased_until"], "2026-10-15T12:03:00.000000Z")
        self.assertEqual(LEASE_SECONDS, 180)
        self.assertTrue(Path(str(job["path"])).is_file())
        self.assertEqual(
            job["genres"], ["Rock"] if job["song_id"] != self.ids["Chatter"] else ["Podcast"]
        )
        self.profiles.complete(result(job), T0 + timedelta(seconds=5))
        song = next(s for s in self.player.view().stored.values() if s.song_id == job["song_id"])
        fresh = self.profiles.profiles(SCALAR).fresh(song)
        assert fresh is not None
        self.assertEqual(
            (fresh.tempo_bpm, fresh.energy, fresh.dim, fresh.vector_length), (120.0, 0.1, 0, 0)
        )
        self.assertEqual(
            self.profiles.profiles(SCALAR).coverage(self.player.view().stored.values()), (1, 3)
        )
        self.assertEqual(self.profiles.queued(SCALAR_RECIPE), 2)
        # A second result for the same lease has nothing to attach to.
        with self.assertRaises(LeaseError) as refused:
            self.profiles.complete(result(job), T0 + timedelta(seconds=6))
        self.assertEqual(refused.exception.status, 409)
        # The other two songs follow, then the queue is empty.
        second = self.lease()
        third = self.lease()
        self.assertEqual(len({job["song_id"], second["song_id"], third["song_id"]}), 3)
        self.assertIsNone(self.profiles.lease(SCALAR_RECIPE, T0))

    def test_results_are_checked_against_the_lease_and_the_file(self) -> None:
        enqueue(self.store, SCALAR_RECIPE, 1)
        job = self.lease()
        cases: list[tuple[dict[str, object], int]] = [
            ({"lease_token": "0" * 32}, 409),
            ({"recipe": "nobody-v9"}, 422),
            ({"tempo_bpm": None}, 422),
            ({"dim": 4, "vector": floats(1, 0, 0, 0)}, 422),
            ({"size": int(job["size"]) + 1}, 409),
        ]
        for changes, status in cases:
            with self.subTest(changes=changes), self.assertRaises(LeaseError) as refused:
                self.profiles.complete(result(job, **changes), T0 + timedelta(seconds=1))
            self.assertEqual(refused.exception.status, status)
        # The size mismatch put the job back on the queue with its token cleared.
        self.assertEqual(self.queue_rows(), [(str(job["song_id"]), "queued", 1)])
        with self.assertRaises(LeaseError):
            self.profiles.complete(result(job), T0 + timedelta(seconds=2))
        # A lease that lapsed is not current, even with the right token.
        job = self.lease(T0 + timedelta(seconds=10))
        late = T0 + timedelta(seconds=10 + LEASE_SECONDS + 1)
        with self.assertRaises(LeaseError) as refused:
            self.profiles.complete(result(job), late)
        self.assertEqual(refused.exception.status, 409)
        self.assertEqual(
            self.store.db.execute("SELECT count(*) FROM audio_profile").fetchone()[0], 0
        )
        # Measurements on a failed or skipped result, and a vector without a dim, are rejected
        # before anything is looked up.
        shapes: list[dict[str, object]] = [
            {"status": "failed", "energy": 0.2},
            {"status": "skipped", "tempo_bpm": 90.0},
            {"vector": floats(1.0)},
            {"dim": 1},
            {"tempo_bpm": -1.0},
            {"energy": float("nan")},
        ]
        for changes in shapes:
            with self.subTest(changes=changes), self.assertRaises(ValidationError):
                result(job, **changes)
        with self.assertRaises(LeaseError):
            result(job, dim=1, vector="not base64!").vector_bytes()

    def test_a_changed_file_makes_the_row_stale_and_the_job_waits_again(self) -> None:
        enqueue(self.store, SCALAR_RECIPE, 3)
        job = self.lease()
        self.profiles.complete(result(job), T0)
        title = next(t for t, sid in self.ids.items() if sid == job["song_id"])
        before = self.song(title)
        self.assertIsNotNone(self.profiles.profiles(SCALAR).fresh(before))
        path = Path(str(job["path"]))
        write_wav(path, frames=1600)
        tag(path, title=title, artist="Fixture", album="Rows", genres=["Rock"])
        self.library.scan()
        after = self.song(title)
        self.assertNotEqual(after.size, before.size)
        self.assertIsNone(self.profiles.profiles(SCALAR).fresh(after))
        self.assertEqual(self.profiles.profiles(SCALAR).coverage([after]), (0, 1))
        # The song lacks a fresh row again, so the script queues it again.
        self.assertEqual(self.profiles.lacking(SCALAR_RECIPE), 1)

    def test_failed_results_requeue_until_the_third(self) -> None:
        enqueue(self.store, SCALAR_RECIPE, 1)
        for attempt in range(1, MAX_ATTEMPTS + 1):
            job = self.lease(T0 + timedelta(minutes=attempt))
            self.profiles.complete(
                result(job, status="failed", tempo_bpm=None, energy=None, detail="no tempo"),
                T0 + timedelta(minutes=attempt, seconds=1),
            )
            row = self.store.db.execute(
                "SELECT status, detail, tempo_bpm, energy, vector FROM audio_profile"
            ).fetchone()
            self.assertEqual(tuple(row), ("failed", "no tempo", None, None, None))
            if attempt < MAX_ATTEMPTS:
                self.assertEqual(self.queue_rows(), [(str(job["song_id"]), "queued", attempt)])
        self.assertEqual(self.queue_rows(), [])
        song = self.player.view().stored[str(job["song_id"])]
        self.assertIsNone(self.profiles.profiles(SCALAR).fresh(song))

    def test_a_lease_that_lapses_three_times_marks_the_song_failed(self) -> None:
        enqueue(self.store, SCALAR_RECIPE, 1)
        first = self.lease(T0)
        again = self.lease(T0 + timedelta(seconds=LEASE_SECONDS + 1))
        self.assertEqual(again["song_id"], first["song_id"])
        self.assertNotEqual(again["lease_token"], first["lease_token"])
        self.lease(T0 + timedelta(seconds=2 * (LEASE_SECONDS + 1)))
        self.assertEqual(self.queue_rows(), [(str(first["song_id"]), "leased", 3)])
        self.assertIsNone(
            self.profiles.lease(SCALAR_RECIPE, T0 + timedelta(seconds=3 * (LEASE_SECONDS + 1)))
        )
        self.assertEqual(self.queue_rows(), [])
        row = self.store.db.execute("SELECT status, detail FROM audio_profile").fetchone()
        self.assertEqual(row[0], "failed")
        self.assertIn("did not report back", row[1])

    def test_skipped_and_failed_rows_satisfy_no_gate(self) -> None:
        enqueue(self.store, SCALAR_RECIPE, 3)
        job = self.lease()
        self.profiles.complete(
            result(job, status="skipped", tempo_bpm=None, energy=None, detail="spoken-word genre"),
            T0,
        )
        rows = self.profiles.profiles(SCALAR)
        song = self.player.view().stored[str(job["song_id"])]
        self.assertIsNone(rows.fresh(song))
        self.assertEqual(rows.rows[song.song_id].status, "skipped")
        self.assertNotIn(job["song_id"], [row[0] for row in self.queue_rows()])

    def test_recipes_are_never_scored_against_each_other_and_bad_vectors_are_invisible(
        self,
    ) -> None:
        embed = Recipe("embed-test", "embedding", dim=3, text_aligned=True)
        songs = {sid: self.player.view().stored[sid] for sid in self.ids.values()}
        alpha, beta, chatter = (songs[self.ids[t]] for t in ("Alpha", "Beta", "Chatter"))
        with registered(embed, lambda phrase: [1.0, 0.0, 0.0]):
            good = struct.pack("<3f", 0.0, 1.0, 0.0)
            short = struct.pack("<2f", 1.0, 0.0)
            with self.store.lock:
                self.store.db.execute("BEGIN IMMEDIATE")
                for song, recipe, dim, vector in (
                    (alpha, "embed-test", 3, good),
                    (beta, "embed-test", 3, short),
                    (chatter, "embed-test", 2, good[:8]),
                    (alpha, SCALAR_RECIPE, 0, None),
                ):
                    self.store.db.execute(
                        "INSERT INTO audio_profile VALUES (?,?,'done',?,?,NULL,NULL,?,?,'','t')",
                        (song.song_id, recipe, song.size, song.mtime_ns, dim, vector),
                    )
                self.store.db.commit()
            vectors = self.profiles.profiles(embed)
            self.assertEqual(vectors.ids, [alpha.song_id])
            self.assertIsNotNone(vectors.fresh(alpha))
            self.assertIsNone(vectors.fresh(beta))
            self.assertIsNone(vectors.fresh(chatter))
            self.assertIsNone(vectors.vector(beta.song_id))
            seed = unit(np.array([0.0, 2.0, 0.0]))
            assert seed is not None
            self.assertEqual(vectors.cosine(seed), {alpha.song_id: 1.0})
            # The scalar recipe's rows are its own, and the embedding rows do not appear there.
            scalar = self.profiles.profiles(SCALAR)
            self.assertEqual(set(scalar.rows), {alpha.song_id})
            self.assertIsNone(scalar.matrix)
            self.assertIsNone(scalar.fresh(beta))
        self.assertIsNone(recipe_for("embed-test"))

    def test_removing_a_file_drops_its_rows_on_the_next_scan(self) -> None:
        enqueue(self.store, SCALAR_RECIPE, 3)
        job = self.lease()
        self.profiles.complete(result(job), T0)
        Path(str(job["path"])).unlink()
        self.library.scan()
        for table in ("audio_profile", "audio_job"):
            with self.subTest(table=table):
                ids = {str(row[0]) for row in self.store.db.execute(f"SELECT song_id FROM {table}")}
                self.assertNotIn(job["song_id"], ids)
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM audio_job").fetchone()[0], 2)

    def test_the_enqueue_script_limits_and_asks_before_everything(self) -> None:
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(enqueue_main(["--data", str(self.root), "--limit", "1"]), 0)
            self.assertEqual(enqueue_main(["--data", str(self.root), "--all"]), 1)
            self.assertEqual(self.profiles.queued(SCALAR_RECIPE), 1)
            self.assertEqual(enqueue_main(["--data", str(self.root), "--all", "--yes"]), 0)
        lines = out.getvalue().splitlines()
        self.assertEqual(lines[0], f"Queued 1 songs for {SCALAR_RECIPE}. 1 waiting.")
        self.assertIn("2 songs lack a fresh", lines[1])
        self.assertIn("Add --yes", lines[1])
        self.assertEqual(lines[2], f"Queued 2 songs for {SCALAR_RECIPE}. 3 waiting.")
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            enqueue_main(["--data", str(self.root), "--recipe", "nobody-v9"])
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            enqueue_main(["--data", str(self.root), "--limit", "0"])


class BandTests(unittest.TestCase):
    def test_percentiles_come_from_the_sorted_list_without_interpolation(self) -> None:
        self.assertIsNone(percentile_bands([]))
        self.assertEqual(percentile_bands([0.5]), (0.5, 0.5))
        bands = percentile_bands(range(10, 0, -1))
        assert bands is not None
        self.assertEqual(bands, (3, 6))
        self.assertEqual(
            [energy_band(v, bands) for v in (1, 2, 3, 5, 6, 10)],
            ["low", "low", "medium", "medium", "high", "high"],
        )

    def test_equal_values_leave_the_low_band_empty(self) -> None:
        bands = percentile_bands([0.2, 0.2, 0.2, 0.2])
        assert bands is not None
        self.assertEqual(bands, (0.2, 0.2))
        self.assertEqual(energy_band(0.2, bands), "high")
        self.assertEqual(energy_band(0.19, bands), "low")

    def test_tempo_bands(self) -> None:
        self.assertEqual(
            [tempo_band(v) for v in (89.9, 90, 139.9, 140)], ["slow", "medium", "medium", "fast"]
        )

    def test_unit_has_no_direction_for_a_zero_vector(self) -> None:
        self.assertIsNone(unit(np.zeros(3)))
        vector = unit(np.array([3.0, 4.0]))
        assert vector is not None
        self.assertAlmostEqual(float(np.linalg.norm(vector)), 1.0, places=6)
        self.assertEqual(vector.dtype, np.float32)
