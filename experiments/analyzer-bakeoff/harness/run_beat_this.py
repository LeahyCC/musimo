"""Beat This! tempo for the tempo sample. One song at a time, one CPU, no network.

Usage (inside the container): python -I /harness/run_beat_this.py <checkpoint> <out dir>
BPM per window is 60 / median inter-beat interval. The song's section BPM is the median of
the three 10 s section estimates, the same aggregation tempo-energy-v1 uses. The 60 s window
is reported on its own. A window with fewer than 4 beats gives no estimate.
"""

import statistics
import sys
import traceback
from pathlib import Path

sys.path.insert(0, "/harness")

import numpy as np  # noqa: E402
import torch  # noqa: E402
from common import Clock, DecodeError, decode, limits, load_sample, memory, windows, write_json  # noqa: E402

RATE = 22050
MIN_BEATS = 4


def bpm(beats: np.ndarray) -> float | None:
    if len(beats) < MIN_BEATS:
        return None
    gaps = np.diff(beats)
    gaps = gaps[gaps > 0]
    if not len(gaps):
        return None
    return round(60.0 / float(np.median(gaps)), 2)


def main() -> None:
    checkpoint, out_dir = sys.argv[1], Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)
    caps = limits()
    torch.set_num_threads(1)
    torch.set_num_interop_threads(1)
    clock = Clock()
    from beat_this.inference import Audio2Beats

    tracker = Audio2Beats(checkpoint_path=f"/models/beat_this/{checkpoint}.ckpt", device="cpu")
    load_seconds = clock.seconds()
    after_load = memory()
    write_json(
        out_dir / "_run.json",
        {
            "checkpoint": checkpoint,
            "torch": torch.__version__,
            "limits": caps,
            "load_seconds": load_seconds,
            "memory_after_load": after_load,
        },
    )
    ids, songs = load_sample(sys.argv[3] if len(sys.argv) > 3 else "tempo_ids")
    for song_id in ids:
        target = out_dir / f"{song_id}.json"
        if target.exists():
            continue
        song = songs.get(song_id)
        if song is None:
            write_json(target, {"song_id": song_id, "status": "failed", "error": "not in sample"})
            continue
        record = {"song_id": song_id, "path": song["path"], "duration": song["duration"]}
        song_clock = Clock()
        decode_seconds = 0.0
        infer_seconds = 0.0
        try:
            found = {}
            for name, (start, seconds) in windows(song["duration"] or 0).items():
                part = Clock()
                try:
                    audio = decode(song["path"], start, seconds, RATE)
                except DecodeError as exc:
                    found[name] = {"start": start, "error": str(exc)}
                    continue
                decode_seconds += part.seconds()
                part = Clock()
                beats, downbeats = tracker(audio, RATE)
                infer_seconds += part.seconds()
                found[name] = {
                    "start": start,
                    "seconds": seconds,
                    "beats": len(beats),
                    "downbeats": len(downbeats),
                    "bpm": bpm(np.asarray(beats)),
                    "beat_times": [round(float(b), 3) for b in beats],
                }
            sections = [w["bpm"] for k, w in found.items() if k != "long60" and w.get("bpm")]
            record["windows"] = found
            record["bpm_sections"] = (
                round(float(statistics.median(sections)), 2) if sections else None
            )
            record["bpm_long60"] = found.get("long60", {}).get("bpm")
            record["status"] = "done" if sections or record["bpm_long60"] else "failed"
        except Exception as exc:  # noqa: BLE001 - one bad song is a failed record, not a stop
            record["status"] = "failed"
            record["error"] = f"{type(exc).__name__}: {exc}"
            record["trace"] = traceback.format_exc()[-1500:]
        record["seconds_total"] = song_clock.seconds()
        record["seconds_decode"] = round(decode_seconds, 4)
        record["seconds_infer"] = round(infer_seconds, 4)
        record["memory"] = memory()
        write_json(target, record)
        print(
            f"{song_id} {record['status']} sections={record.get('bpm_sections')} "
            f"long60={record.get('bpm_long60')} in {record['seconds_total']:.1f} s",
            flush=True,
        )
    final = memory()
    run = {"load_seconds": load_seconds, "memory_after_load": after_load, "memory_end": final}
    write_json(out_dir / "_end.json", run)
    print(f"done, cgroup peak {final['cgroup_peak']}", flush=True)


if __name__ == "__main__":
    main()
