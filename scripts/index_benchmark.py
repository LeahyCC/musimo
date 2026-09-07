"""Measure real tag scans over generated audio in a temporary, isolated library."""

import argparse
import asyncio
import json
import math
import platform
import statistics
import tempfile
import time
import wave
from pathlib import Path

from mutagen.id3 import TALB, TIT2, TPE1
from mutagen.wave import WAVE

from backend.catalog import Result
from backend.library import Library
from backend.store import Store


async def measure(files: int, parent: Path | None) -> dict[str, object]:
    with tempfile.TemporaryDirectory(prefix="musimo-index-", dir=parent) as temporary:
        root = Path(temporary).resolve()
        music = root / "music"
        music.mkdir()
        sample = root / "sample.wav"
        with wave.open(str(sample), "wb") as stream:
            stream.setparams((1, 2, 8000, 0, "NONE", "not compressed"))
            stream.writeframes(bytes(1600))
        audio = WAVE(sample)
        audio.add_tags()
        assert audio.tags is not None
        audio.tags.add(TIT2(encoding=3, text="Fixture 000000"))
        audio.tags.add(TPE1(encoding=3, text="Generated Artist"))
        audio.tags.add(TALB(encoding=3, text="Generated Album"))
        audio.save()
        template = sample.read_bytes()
        assert template.count(b"Fixture 000000") == 1
        for number in range(files):
            folder = music / f"album-{number // 50:04d}"
            folder.mkdir(exist_ok=True)
            (folder / f"track-{number:06d}.wav").write_bytes(
                template.replace(b"Fixture 000000", f"Fixture {number:06d}".encode())
            )
        store = Store(root / "index.sqlite3")
        try:
            library = Library(store, [music], asyncio.Event())
            scans: list[dict[str, object]] = []
            for iteration in range(3):
                started = time.perf_counter()
                await asyncio.to_thread(library.scan)
                duration = time.perf_counter() - started
                status = library.status()
                assert status["status"] == "done" and status["errors"] == 0, status
                assert status["total_files"] == files and status["indexed"] == files, status
                scans.append(
                    {
                        "kind": "cold_tags" if iteration == 0 else "unchanged",
                        "seconds": round(duration, 3),
                        "files": files,
                        "errors": 0,
                    }
                )
                print(json.dumps(scans[-1]), flush=True)
            wanted = [
                Result(
                    id=index + 1,
                    kind="track",
                    title=f"Fixture {index:06d}",
                    artist="Generated Artist",
                    duration=1,
                )
                for index in range(min(50, files))
            ]
            times = []
            for _ in range(50):
                started = time.perf_counter()
                library.annotate(wanted)
                times.append((time.perf_counter() - started) * 1000)
                assert all(row.ownership == "owned" for row in wanted)
                assert all(len(row.matched_paths) == 1 for row in wanted)
            return {
                "platform": platform.platform(),
                "python": platform.python_version(),
                "corpus": "Generated 0.1-second WAVs with distinct title tags; 50 files per folder",
                "storage": "Temporary directory under "
                + str(parent or Path(tempfile.gettempdir())),
                "scans": scans,
                "ownership_50_tracks": {
                    "samples": len(times),
                    "median_ms": round(statistics.median(times), 2),
                    "p95_ms": round(sorted(times)[math.ceil(len(times) * 0.95) - 1], 2),
                },
                "limitations": (
                    "Synthetic small WAVs; excludes watcher startup, real mixed formats "
                    "and host bind-mount performance"
                ),
            }
        finally:
            store.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--files", type=int, default=50000)
    parser.add_argument("--directory", type=Path, help="Parent of the temporary fixture directory")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not 50 <= args.files <= 100000:
        parser.error("Choose 50 to 100000 generated files")
    report = asyncio.run(measure(args.files, args.directory))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report), flush=True)


if __name__ == "__main__":
    main()
