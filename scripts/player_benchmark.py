"""Measure cold and warm player reads over generated files, without touching live state."""

import argparse
import asyncio
import json
import platform
import sys
import tempfile
import time
import wave
from pathlib import Path

from mutagen.id3 import TALB, TIT2, TPE1
from mutagen.wave import WAVE

from backend.core.store import Store
from backend.library.index import Library
from backend.library.player import Player


def peak_rss_mb() -> float | None:
    if sys.platform == "win32":
        return None
    import resource

    value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return round(value / (1024 * 1024 if sys.platform == "darwin" else 1024), 2)


async def measure(files: int) -> dict[str, object]:
    with tempfile.TemporaryDirectory(prefix="musimo-player-") as temporary:
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
        audio.tags.add(TPE1(encoding=3, text="Artist 000000"))
        audio.tags.add(TALB(encoding=3, text="Album 000000"))
        audio.save()
        template = sample.read_bytes()
        # Different album tags matter: different folders alone still form one album.
        for number in range(files):
            folder = music / f"album-{number // 50:06d}"
            folder.mkdir(exist_ok=True)
            body = template.replace(b"Fixture 000000", f"Fixture {number:06d}".encode())
            body = body.replace(b"Album 000000", f"Album {number // 50:06d}".encode())
            body = body.replace(b"Artist 000000", f"Artist {number // 500:06d}".encode())
            (folder / f"{number:06d}.wav").write_bytes(body)
        store = Store(root / "player.sqlite3")
        try:
            library = Library(store, [music], asyncio.Event())
            await asyncio.to_thread(library.scan)
            status = library.status()
            assert status["status"] == "done" and status["errors"] == 0, status
            assert status["indexed"] == files, status
            ids = [
                str(row[0])
                for row in store.db.execute(
                    "SELECT song_id FROM library_files ORDER BY path LIMIT 500"
                )
            ]
            store.write_play_queue(ids, ids[0], 12000)
            timings: dict[str, float] = {}
            for operation in ("view", "queue", "albums", "tracks"):
                player = Player(store, [music])
                for temperature in ("cold", "warm"):
                    started = time.perf_counter()
                    if operation == "view":
                        result = await asyncio.to_thread(player.view)
                        assert len(result.tracks) == files
                    elif operation == "queue":
                        queue = await player.play_queue()
                        entries = queue["entry"]
                        assert isinstance(entries, list) and len(entries) == len(ids)
                    elif operation == "albums":
                        albums = await player.browse_albums("", "newest", [], [], 0, 50)
                        assert albums["total"] == (files + 49) // 50
                    else:
                        tracks = await player.browse_tracks("", "title", [], [], 0, 100)
                        assert tracks["total"] == files
                    timings[f"{operation}_{temperature}_ms"] = round(
                        (time.perf_counter() - started) * 1000, 2
                    )
            return {
                "files": files,
                "albums": (files + 49) // 50,
                "platform": platform.platform(),
                "python": platform.python_version(),
                "timings": timings,
                "process_peak_rss_mb": peak_rss_mb(),
                "memory_scope": (
                    "Process lifetime including fixture generation and scan; unavailable on Windows"
                ),
            }
        finally:
            store.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--files", type=int, default=2000)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if not 1 <= args.files <= 1_000_000:
        parser.error("--files must be between 1 and 1000000")
    result = json.dumps(asyncio.run(measure(args.files)), indent=2) + "\n"
    print(result, end="")
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(result, encoding="utf-8")


if __name__ == "__main__":
    main()
