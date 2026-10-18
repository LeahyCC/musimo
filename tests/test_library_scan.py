"""The scan reads player columns once, and an empty root does not wipe them."""

import asyncio
import math
import os
import tempfile
import threading
import time
import unittest
import wave
from collections.abc import Callable, Iterator
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from mutagen.id3 import ID3, TALB, TCMP, TCON, TDRC, TIT2, TPE1, TPE2, TPOS, TRCK, TXXX
from mutagen.wave import WAVE

from backend.core.store import Store
from backend.library.index import Library
from backend.library.tags import facts_for, track_length


def wav(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as stream:
        stream.setparams((1, 2, 8000, 0, "NONE", "not compressed"))
        stream.writeframes(b"\0\0" * 800)


class LibraryScanTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_polled_folder_does_not_hold_startup(self) -> None:
        previous_mode = os.environ.get("MUSIMO_WATCH_MODE")
        previous_interval = os.environ.get("MUSIMO_POLL_INTERVAL_SECONDS")
        os.environ["MUSIMO_WATCH_MODE"] = "poll"
        os.environ["MUSIMO_POLL_INTERVAL_SECONDS"] = "300"
        gate = threading.Event()
        from watchdog.utils.dirsnapshot import DirectorySnapshot

        class SlowSnapshot(DirectorySnapshot):
            def __init__(
                self,
                path: str,
                *,
                recursive: bool = True,
                stat: Callable[[str], os.stat_result] = os.stat,
                listdir: Callable[[str | None], Iterator[os.DirEntry[str]]] = os.scandir,
            ) -> None:
                gate.set()
                time.sleep(0.4)
                super().__init__(path, recursive=recursive, stat=stat, listdir=listdir)

        library = Library(self.store, [self.root], asyncio.Event())
        try:
            self.assertEqual(library.watch_mode, "poll")
            with patch("watchdog.observers.polling.DirectorySnapshot", SlowSnapshot):
                started = time.perf_counter()
                library.start()
                elapsed = time.perf_counter() - started
            self.assertLess(elapsed, 0.2)
            self.assertTrue(gate.wait(1))
        finally:
            await library.close()
            if previous_mode is None:
                os.environ.pop("MUSIMO_WATCH_MODE", None)
            else:
                os.environ["MUSIMO_WATCH_MODE"] = previous_mode
            if previous_interval is None:
                os.environ.pop("MUSIMO_POLL_INTERVAL_SECONDS", None)
            else:
                os.environ["MUSIMO_POLL_INTERVAL_SECONDS"] = previous_interval

    async def asyncSetUp(self) -> None:
        self.folder = tempfile.TemporaryDirectory()
        self.root = Path(self.folder.name)
        self.store = Store(self.root / "db.sqlite3")
        self.library = Library(self.store, [self.root], asyncio.Event())

    async def asyncTearDown(self) -> None:
        self.store.close()
        self.folder.cleanup()

    async def test_bad_numbers_are_absent_and_junk_folders_are_not_indexed(self) -> None:
        path = self.root / "Album" / "song.wav"
        wav(path)
        audio = WAVE(path)
        audio.add_tags()
        assert isinstance(audio.tags, ID3)
        for frame in (
            TIT2(encoding=3, text="Song"),
            TPE1(encoding=3, text="Artist"),
            TPE2(encoding=3, text="Album Artist"),
            TALB(encoding=3, text="Album"),
            TRCK(encoding=3, text="4294967295"),
            TPOS(encoding=3, text="2/3"),
            TDRC(encoding=3, text="2020-05-01"),
            TCON(encoding=3, text=["Jazz", "Live"]),
            TCMP(encoding=3, text="1"),
            TXXX(encoding=3, desc="REPLAYGAIN_TRACK_GAIN", text="nan"),
            TXXX(encoding=3, desc="REPLAYGAIN_TRACK_PEAK", text="0.0"),
            TXXX(encoding=3, desc="REPLAYGAIN_ALBUM_GAIN", text=""),
        ):
            audio.tags.add(frame)
        audio.save()
        hidden = self.root / "@eaDir" / "junk.wav"
        wav(hidden)
        self.library.scan()
        row = self.store.db.execute("SELECT * FROM library_files").fetchone()
        self.assertEqual(row["path"], str(path))
        self.assertEqual(row["track"], 0)
        self.assertEqual(row["disc"], 2)
        self.assertEqual(row["year"], 2020)
        self.assertEqual(row["genre"], "Jazz")
        self.assertEqual(row["album_artist"], "Album Artist")
        self.assertEqual(row["compilation"], 1)
        self.assertIsNone(row["replaygain_track_gain"])
        self.assertEqual(row["replaygain_track_peak"], 0.0)
        self.assertIsNone(row["replaygain_album_gain"])
        self.assertEqual(row["content_type"], "audio/wav")
        self.assertGreater(row["bit_depth"], 0)
        song_id = str(row["song_id"])
        added = str(row["added_at"])
        self.library.scan()
        again = self.store.db.execute("SELECT song_id, added_at FROM library_files").fetchone()
        self.assertEqual(str(again["song_id"]), song_id)
        self.assertEqual(str(again["added_at"]), added)
        counted = self.store.db.execute("SELECT count(*) FROM library_files").fetchone()[0]
        self.assertEqual(counted, 1)


class TrackLengthTests(unittest.TestCase):
    def test_a_broken_length_is_stored_as_unknown(self) -> None:
        for raw in (math.inf, -math.inf, math.nan, -3.0, 0, None, "12", True):
            with self.subTest(raw=raw):
                self.assertEqual(track_length(raw), 0.0)
                audio = SimpleNamespace(tags=None, info=SimpleNamespace(length=raw))
                self.assertEqual(facts_for(audio, ".mp3", 1000).duration, 0.0)
        self.assertEqual(track_length(212.5), 212.5)
        self.assertEqual(track_length(7), 7.0)
