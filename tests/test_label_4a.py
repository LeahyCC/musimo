"""Blind label set picker, page API and export for package 4A."""

import json
import subprocess
import sys
import tempfile
import unittest
import wave
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from mutagen.id3 import ID3, TCON, TIT2, TPE1
from mutagen.wave import WAVE

from backend.core.store import Store
from backend.library.index import Library
from backend.library.label_4a import (
    Label4AAnswer,
    clip_start,
    load_manifest,
    shuffled_order,
)
from backend.main import create_app
from scripts.export_label_4a import digest_file
from scripts.pick_label_4a import build_manifest, load_songs


def write_wav(path: Path, frames: int = 800) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(8000)
        handle.writeframes(b"\0\0" * frames)


def tag_wav(path: Path, title: str, artist: str, genres: list[str]) -> None:
    audio = WAVE(path)
    audio.add_tags()
    assert isinstance(audio.tags, ID3)
    audio.tags.add(TIT2(encoding=3, text=title))
    audio.tags.add(TPE1(encoding=3, text=artist))
    if genres:
        audio.tags.add(TCON(encoding=3, text=[str(genre) for genre in genres]))
    audio.save()


def song_id(index: int) -> str:
    return f"tr-{index:016x}"


def insert_song(
    store: Store,
    root: Path,
    index: int,
    artist_key: str,
    title: str,
    genres: list[str],
    duration: float,
) -> None:
    sid = song_id(index)
    genres_json = json.dumps(genres)
    with store.lock:
        store.db.execute(
            """
            INSERT OR REPLACE INTO library_files (
                path, root, mtime_ns, size, generation, title, artist, album,
                title_key, artist_key, album_key, duration, isrc, mbid,
                song_id, added_at, track, disc, year, genre, genres, album_artist,
                compilation, suffix, content_type, bitrate, sample_rate,
                bit_depth, channels, has_art, tags_version, record_labels,
                play_count, codec, flac_id3
            ) VALUES (
                ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                str(root / f"{sid}.wav"),
                str(root),
                0,
                0,
                "test",
                title,
                artist_key,
                "",
                title.lower(),
                artist_key,
                "",
                duration,
                "",
                "",
                sid,
                "2026-01-01T00:00:00.000Z",
                0,
                0,
                0,
                genres[0] if genres else "",
                genres_json,
                "",
                0,
                "wav",
                "audio/wav",
                0,
                8000,
                16,
                1,
                0,
                0,
                "[]",
                0,
                "pcm",
                0,
            ),
        )


class ClipLogicTests(unittest.TestCase):
    def test_clip_start_uses_zero_for_long_intro_group(self) -> None:
        self.assertEqual(clip_start("middle", 0, 120.0), 0)

    def test_clip_start_clamps_to_track_duration(self) -> None:
        self.assertEqual(clip_start("late", 80, 90.0), 60)

    def test_shuffled_order_is_deterministic_for_a_seed(self) -> None:
        clips = [
            Label4AAnswer.model_construct(clip_id="C001"),
            Label4AAnswer.model_construct(clip_id="C002"),
            Label4AAnswer.model_construct(clip_id="C003"),
        ]
        first = shuffled_order(clips, "seed-a")
        second = shuffled_order(clips, "seed-a")
        self.assertEqual(first, second)
        self.assertEqual(set(first), {"C001", "C002", "C003"})


class PickerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.folder = tempfile.TemporaryDirectory()
        self.root = Path(self.folder.name) / "music"
        self.root.mkdir()
        self.store = Store(Path(self.folder.name) / "db.sqlite3")
        with self.store.lock:
            self.store.db.execute(
                "INSERT OR REPLACE INTO library_roots (path, enabled) VALUES (?, 1)",
                (str(self.root),),
            )

    def tearDown(self) -> None:
        self.store.close()
        self.folder.cleanup()

    def _fill_library(self) -> None:
        # Liquid drum and bass
        for i in range(20):
            insert_song(
                self.store,
                self.root,
                i,
                f"artist_liquid_{i}",
                f"Liquid track {i}",
                ["Liquid Drum and Bass"],
                240.0,
            )
        # Other drum and bass
        for i in range(20, 40):
            insert_song(
                self.store,
                self.root,
                i,
                f"artist_dnb_{i}",
                f"DnB track {i}",
                ["Drum and Bass"],
                240.0,
            )
        # Vocals unclear
        for i in range(40, 60):
            insert_song(
                self.store,
                self.root,
                i,
                f"artist_vocals_{i}",
                "Instrumental",
                ["Classical"],
                240.0,
            )
        # Loud/quiet genre mix
        for i in range(60, 70):
            insert_song(
                self.store,
                self.root,
                i,
                f"artist_calm_{i}",
                f"Calm {i}",
                ["Ambient"],
                240.0,
            )
        for i in range(70, 80):
            insert_song(
                self.store,
                self.root,
                i,
                f"artist_intense_{i}",
                f"Intense {i}",
                ["Metal"],
                240.0,
            )
        # Long intro
        for i in range(80, 95):
            insert_song(
                self.store,
                self.root,
                i,
                f"artist_long_{i}",
                f"Long {i}",
                ["Rock"],
                700.0,
            )
        # Speech
        for i in range(95, 105):
            insert_song(
                self.store,
                self.root,
                i,
                f"artist_speech_{i}",
                f"Speech {i}",
                ["Podcast"],
                240.0,
            )
        # Random / untagged
        for i in range(105, 125):
            insert_song(
                self.store,
                self.root,
                i,
                f"artist_random_{i}",
                f"Random {i}",
                [],
                240.0,
            )

    def test_picker_is_deterministic_for_a_fixed_seed(self) -> None:
        self._fill_library()
        first = build_manifest(load_songs(self.store), self.store, "seed-one")
        second = build_manifest(load_songs(self.store), self.store, "seed-one")
        self.assertEqual(
            [clip["clip_id"] for clip in first["clips"]],
            [clip["clip_id"] for clip in second["clips"]],
        )
        self.assertEqual(
            [clip["song_id"] for clip in first["clips"]],
            [clip["song_id"] for clip in second["clips"]],
        )

    def test_no_artist_appears_in_both_splits(self) -> None:
        self._fill_library()
        manifest = build_manifest(load_songs(self.store), self.store, "seed-split")
        dev_artists: set[str] = set()
        held_artists: set[str] = set()
        with self.store.lock:
            for clip in manifest["clips"]:
                row = self.store.db.execute(
                    "SELECT artist_key FROM library_files WHERE song_id=?",
                    (clip["song_id"],),
                ).fetchone()
                self.assertIsNotNone(row)
                artist = str(row["artist_key"])
                if clip["split"] == "dev":
                    dev_artists.add(artist)
                else:
                    held_artists.add(artist)
        self.assertTrue(dev_artists.isdisjoint(held_artists))

    def test_split_counts_are_balanced_within_each_group(self) -> None:
        self._fill_library()
        manifest = build_manifest(load_songs(self.store), self.store, "seed-balance")
        groups = {
            "liquid",
            "other_dnb",
            "vocals_unclear",
            "loud_quiet",
            "long_intro",
            "speech",
            "random",
        }
        for group in groups:
            clips = [c for c in manifest["clips"] if c["group"] == group]
            if clips:
                dev = len([c for c in clips if c["split"] == "dev"])
                held = len([c for c in clips if c["split"] == "held"])
                self.assertLessEqual(abs(dev - held), 1, f"{group} split is unbalanced")


class Label4AApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.folder = tempfile.TemporaryDirectory()
        self.root = Path(self.folder.name) / "music"
        self.root.mkdir()
        self.data = Path(self.folder.name) / "data"
        self.data.mkdir()
        self.static = Path(self.folder.name) / "static"
        self.static.mkdir()
        (self.static / "index.html").write_text("<html>App</html>", encoding="utf-8")
        self.manifest = Path(self.folder.name) / "manifest.json"

        import asyncio

        # Index a small real library so clips can be streamed.
        for i in range(6):
            self._create_file(i, f"Title {i}", f"Artist {i}", ["Rock"])
        store = Store(self.data / "musimo.sqlite3")
        library = Library(store, [self.root], asyncio.Event())
        try:
            library.start()
            if library.task:
                await library.task
        finally:
            await library.close()
            store.close()

        # Reopen store to create the label-4a table and insert the manifest.
        store = Store(self.data / "musimo.sqlite3")
        try:
            self._insert_manifest(store)
        finally:
            store.close()

    def tearDown(self) -> None:
        self.folder.cleanup()

    def _create_file(self, index: int, title: str, artist: str, genres: list[str]) -> None:
        path = self.root / f"{song_id(index)}.wav"
        write_wav(path, frames=240_000)
        tag_wav(path, title, artist, genres)

    def _insert_manifest(self, store: Store) -> None:
        # The scan already populated library_files; build a manifest from it.
        manifest = build_manifest(load_songs(store), store, "api-seed")
        manifest["clips"] = manifest["clips"][:6]
        for index, clip in enumerate(manifest["clips"], start=1):
            clip["clip_id"] = f"C{index:03d}"
        manifest["total"] = len(manifest["clips"])
        self.manifest.write_text(json.dumps(manifest), encoding="utf-8")

    @contextmanager
    def _client(self):
        env = {
            "MUSIMO_LIBRARY_ROOTS": str(self.root),
            "MUSIMO_LABEL_4A_MANIFEST": str(self.manifest),
        }
        with patch.dict("os.environ", env, clear=False):
            with TestClient(create_app(self.data, self.static)) as client:
                yield client

    def test_clips_endpoint_hides_identity_group_and_split(self) -> None:
        with self._client() as client:
            response = client.get("/api/label-4a/clips")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertIn("order", body)
        self.assertIn("total", body)
        self.assertIn("answers", body)
        for key in ("title", "artist", "genre", "group", "split", "song_id"):
            self.assertNotIn(key, body)

    def test_clips_order_is_shuffled_not_grouped(self) -> None:
        with self._client() as client:
            body = client.get("/api/label-4a/clips").json()
        raw = load_manifest(self.manifest)
        order = body["order"]
        # All six clips should appear once.
        self.assertEqual(len(order), 6)
        self.assertEqual(set(order), {c.clip_id for c in raw.clips})
        # The shuffled order should not match the grouped manifest order.
        manifest_order = [c.clip_id for c in raw.clips]
        self.assertNotEqual(order, manifest_order)

    def test_answer_is_saved_and_returned(self) -> None:
        with self._client() as client:
            post = client.post(
                "/api/label-4a/answers/C001",
                json={
                    "sections_played": ["middle"],
                    "vocals": "yes",
                    "intensity": "intense",
                    "speech": "music",
                    "dnb": "yes",
                    "dnb_subtype": "liquid",
                },
            )
            self.assertEqual(post.status_code, 204)
            body = client.get("/api/label-4a/clips").json()
        answer = body["answers"]["C001"]
        self.assertEqual(answer["vocals"], "yes")
        self.assertEqual(answer["dnb_subtype"], "liquid")

    def test_clip_stream_rejects_unknown_clip_id(self) -> None:
        with self._client() as client:
            response = client.get("/api/label-4a/clips/C999")
        self.assertEqual(response.status_code, 404)

    def test_clip_stream_rejects_song_outside_library(self) -> None:
        store = Store(self.data / "musimo.sqlite3")
        try:
            # Add a clip that points to a song whose file is not inside the configured root.
            outside = Path(self.folder.name) / "outside" / "nope.wav"
            outside.parent.mkdir(exist_ok=True)
            outside.write_text("not audio", encoding="utf-8")
            sql = (
                "INSERT OR REPLACE INTO library_files (path, root, mtime_ns, size, "
                "generation, title, artist, album, title_key, artist_key, album_key, "
                "duration, isrc, mbid, song_id, added_at, track, disc, year, genre, "
                "genres, album_artist, compilation, suffix, content_type, bitrate, "
                "sample_rate, bit_depth, channels, has_art, tags_version, "
                "record_labels, play_count, codec, flac_id3) "
                "VALUES (?, ?, 0, 0, 'test', '', '', '', '', '', '', 60, '', '', "
                "'tr-aaaaaaaaaaaaaaaa', '2026-01-01T00:00:00.000Z', 0, 0, 0, '', "
                "'[]', '', 0, 'wav', 'audio/wav', 0, 8000, 16, 1, 0, 0, '[]', 0, 'pcm', 0)"
            )
            store.db.execute(sql, (str(outside), str(self.root)))
            manifest = json.loads(self.manifest.read_text(encoding="utf-8"))
            manifest["clips"].append(
                {
                    "clip_id": "C099",
                    "song_id": "tr-aaaaaaaaaaaaaaaa",
                    "section_start": 0,
                    "group": "random",
                    "split": "dev",
                }
            )
            manifest["total"] = len(manifest["clips"])
            self.manifest.write_text(json.dumps(manifest), encoding="utf-8")
        finally:
            store.close()

        with self._client() as client:
            response = client.get("/api/label-4a/clips/C099")
        self.assertEqual(response.status_code, 404)

    def test_saving_answer_does_not_change_player_state(self) -> None:
        with self._client() as client:
            queue_before = client.get("/api/player/queue").json()
            playlists_before = client.get("/api/library/playlists").json()
            client.post(
                "/api/label-4a/answers/C001",
                json={
                    "sections_played": ["middle"],
                    "vocals": "no",
                    "intensity": "calm",
                    "speech": "music",
                    "dnb": "no",
                },
            )
            queue_after = client.get("/api/player/queue").json()
            playlists_after = client.get("/api/library/playlists").json()
        self.assertEqual(queue_before, queue_after)
        self.assertEqual(playlists_before, playlists_after)

    def test_export_and_seal_on_synthetic_answers(self) -> None:
        synthetic = Path(self.folder.name) / "test-only-answers.json"
        synthetic.write_text(
            json.dumps(
                {
                    "C001": {
                        "sections_played": ["middle"],
                        "vocals": "yes",
                        "intensity": "intense",
                        "speech": "music",
                        "dnb": "yes",
                        "dnb_subtype": "liquid",
                    },
                    "C002": {
                        "sections_played": ["early"],
                        "vocals": "none",
                        "intensity": "calm",
                        "speech": "music",
                        "dnb": "no",
                    },
                }
            ),
            encoding="utf-8",
        )
        output = Path(self.folder.name) / "evals"
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "scripts.export_label_4a",
                "--manifest",
                str(self.manifest),
                "--answers",
                str(synthetic),
                "--output",
                str(output),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((output / "manifest.json").exists())
        self.assertTrue((output / "dev.json").exists())
        self.assertTrue((output / "heldout.json").exists())
        self.assertTrue((output / "seal.json").exists())
        seal = json.loads((output / "seal.json").read_text(encoding="utf-8"))
        self.assertEqual(seal["file"], "heldout.json")
        self.assertEqual(seal["sha256"], digest_file(output / "heldout.json"))
        self.assertGreater(seal["cases"], 0)
