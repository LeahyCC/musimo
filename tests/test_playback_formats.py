"""Real codecs, including two codecs sharing an M4A extension."""

import asyncio
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from mutagen.id3 import ID3, TIT2

from backend.core.store import Store
from backend.jobs.tagging import Tagger, probe
from backend.library.index import Library
from backend.library.player import Player


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg required")
class PlaybackFormatTests(unittest.IsolatedAsyncioTestCase):
    async def test_scan_warns_about_alac_wma_and_id3_flac_and_rescan_keeps_ids(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            music = root / "music"
            music.mkdir()
            for name, codec in (
                ("alac.m4a", "alac"),
                ("aac.m4a", "aac"),
                ("normal.flac", "flac"),
                ("id3.flac", "flac"),
                ("test.wma", "wmav2"),
            ):
                subprocess.run(
                    [
                        "ffmpeg",
                        "-v",
                        "error",
                        "-f",
                        "lavfi",
                        "-i",
                        "sine=frequency=440:duration=1",
                        "-c:a",
                        codec,
                        "-metadata",
                        f"title={name}",
                        "-metadata",
                        "artist=Fixture",
                        "-metadata",
                        "album=Formats",
                        str(music / name),
                    ],
                    check=True,
                    capture_output=True,
                )
            id3 = ID3()
            id3.add(TIT2(encoding=3, text="Old ID3 header"))
            id3.save(music / "id3.flac")
            store = Store(root / "test.sqlite3")
            try:
                library = Library(store, [music], asyncio.Event())
                library.scan()
                self.assertEqual(library.status()["errors"], 0)
                player = Player(store, [music])
                songs = {Path(row.path).name: row for row in player.view().stored.values()}
                self.assertIn("ALAC", songs["alac.m4a"].playback_warning)
                self.assertIn("WMA", songs["test.wma"].playback_warning)
                self.assertIn("ID3", songs["id3.flac"].playback_warning)
                self.assertEqual(songs["aac.m4a"].playback_warning, "")
                self.assertEqual(songs["normal.flac"].playback_warning, "")
                ids = {name: song.song_id for name, song in songs.items()}
                store.db.execute("UPDATE library_files SET tags_version=1,codec='' ")
                library.scan()
                rescanned = {Path(row.path).name: row for row in player.view().stored.values()}
                self.assertEqual({name: song.song_id for name, song in rescanned.items()}, ids)
                self.assertEqual(rescanned["alac.m4a"].codec, "alac")
                detail = await player.song(songs["alac.m4a"].song_id)
                self.assertIn("ALAC", str(detail["playbackWarning"]))
            finally:
                store.close()

    async def test_explicit_m4a_output_converts_alac_to_aac_and_preserves_original(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "lossless.m4a"
            subprocess.run(
                [
                    "ffmpeg",
                    "-v",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=440:duration=1",
                    "-c:a",
                    "alac",
                    str(source),
                ],
                check=True,
                capture_output=True,
            )
            before = source.read_bytes()
            result = Tagger().prepare(source, root, "m4a")
            self.assertEqual(probe(result)["codec"], "aac")
            self.assertEqual(source.read_bytes(), before)
