"""tempo-energy-v1 exactly as the worker runs it, offline, plus librosa on the middle 60 s.

Usage (inside musimo-audio-worker:0.4.0): python -I /harness/run_librosa.py <out dir> <sample key>
Calls audio_worker.recipe.analyse with a job built from the sample, so the three-section BPM
is the recipe's own. The 60 s window uses the recipe's measure_section on a longer buffer.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, "/app")
sys.path.insert(1, "/harness")

from audio_worker import recipe  # noqa: E402
from common import Clock, DecodeError, decode, limits, load_sample, memory, windows, write_json  # noqa: E402


def main() -> None:
    out_dir, key = Path(sys.argv[1]), sys.argv[2]
    out_dir.mkdir(parents=True, exist_ok=True)
    caps = limits()
    clock = Clock()
    import librosa

    recipe.measure_section(decode_silence())
    write_json(
        out_dir / "_run.json",
        {"librosa": librosa.__version__, "limits": caps, "load_seconds": clock.seconds()},
    )
    ids, songs = load_sample(key)
    for song_id in ids:
        target = out_dir / f"{song_id}.json"
        if target.exists():
            continue
        song = songs[song_id]
        job = recipe.Job(
            song_id=song_id,
            recipe=recipe.RECIPE,
            lease_token="offline",
            path=song["path"],
            size=song["size"],
            mtime_ns=song["mtime_ns"],
            duration=float(song["duration"] or 0),
            genre=song["genre"] or "",
            genres=tuple(json.loads(song["genres"] or "[]")),
        )
        timer = Clock()
        try:
            result = recipe.analyse(job, [Path("/music")])
            record = {
                "song_id": song_id,
                "status": result.status,
                "bpm_sections": result.tempo_bpm,
                "detail": result.detail,
                "seconds_sections": timer.seconds(),
            }
            long = windows(job.duration).get("long60")
            if long:
                timer = Clock()
                try:
                    samples = decode(song["path"], long[0], long[1], 22050)
                    record["bpm_long60"], _ = recipe.measure_section(samples)
                except DecodeError as exc:
                    record["long60_error"] = str(exc)
                record["seconds_long60"] = timer.seconds()
        except Exception as exc:  # noqa: BLE001 - one bad song is a failed record, not a stop
            record = {
                "song_id": song_id,
                "status": "failed",
                "bpm_sections": None,
                "error": f"{type(exc).__name__}: {exc}",
            }
        record["memory"] = memory()
        write_json(target, record)
        print(
            song_id, record["status"], record["bpm_sections"], record.get("bpm_long60"), flush=True
        )
    write_json(out_dir / "_end.json", {"memory_end": memory()})


def decode_silence():
    import numpy as np

    return np.zeros(22050 * 2, dtype=np.float32)


if __name__ == "__main__":
    main()
