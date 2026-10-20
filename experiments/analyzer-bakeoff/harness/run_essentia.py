"""Essentia discogs-effnet + genre_discogs400 style activations for the genre sample.

Usage (inside the container): python -I /harness/run_essentia.py <out dir>
Audio is the same four windows as the tempo run (three 10 s sections and the middle 60 s),
16 kHz mono. Each window gives one 400-value activation per ~2 s patch. The song's score per
style is the mean over every patch of the 60 s window and of each section that does not
overlap it, so no stretch of audio is counted twice (the 50 % section always sits inside the
middle 60 s, and is not analysed). If the 60 s window fails to decode, every section counts.
All 400 per-window means are kept too, to see how stable a song's styles are.
"""

import json
import sys
import traceback
from pathlib import Path

sys.path.insert(0, "/harness")

import numpy as np  # noqa: E402
from common import Clock, DecodeError, decode, limits, load_sample, memory, windows, write_json  # noqa: E402

RATE = 16000
MODELS = Path("/models/essentia")
KEEP = 10


def top(scores: np.ndarray, classes: list[str], n: int = KEEP) -> list[list]:
    order = np.argsort(scores)[::-1][:n]
    return [[classes[i], round(float(scores[i]), 4)] for i in order]


def main() -> None:
    out_dir = Path(sys.argv[1])
    out_dir.mkdir(parents=True, exist_ok=True)
    caps = limits()
    clock = Clock()
    import essentia
    from essentia.standard import TensorflowPredict2D, TensorflowPredictEffnetDiscogs

    essentia.log.warningActive = False
    embedder = TensorflowPredictEffnetDiscogs(
        graphFilename=str(MODELS / "discogs-effnet-bs64-1.pb"), output="PartitionedCall:1"
    )
    head = TensorflowPredict2D(
        graphFilename=str(MODELS / "genre_discogs400-discogs-effnet-1.pb"),
        input="serving_default_model_Placeholder",
        output="PartitionedCall:0",
    )
    classes = json.loads((MODELS / "genre_discogs400-discogs-effnet-1.json").read_text())["classes"]
    # The first call builds the TensorFlow session; count it as part of loading.
    warm = np.zeros(RATE * 3, dtype=np.float32)
    head(embedder(warm))
    load_seconds = clock.seconds()
    after_load = memory()
    write_json(
        out_dir / "_run.json",
        {
            "essentia": essentia.__version__,
            "limits": caps,
            "load_seconds": load_seconds,
            "memory_after_load": after_load,
        },
    )
    ids, songs = load_sample("genre_ids")
    for song_id in ids:
        target = out_dir / f"{song_id}.json"
        if target.exists():
            continue
        song = songs[song_id]
        record = {"song_id": song_id, "path": song["path"], "duration": song["duration"]}
        song_clock = Clock()
        decode_seconds = 0.0
        infer_seconds = 0.0
        try:
            patches = []
            found = {}
            spans = windows(song["duration"] or 0)
            long_start, long_seconds = spans.get("long60", (0.0, 0.0))
            have_long = False
            # The 60 s window first. A section that overlaps it is skipped once it decoded.
            for name in sorted(spans, key=lambda n: n != "long60"):
                start, seconds = spans[name]
                overlaps = start < long_start + long_seconds and long_start < start + seconds
                if name != "long60" and overlaps and have_long:
                    found[name] = {"start": start, "skipped": "inside the 60 s window"}
                    continue
                part = Clock()
                try:
                    audio = decode(song["path"], start, seconds, RATE)
                except DecodeError as exc:
                    found[name] = {"start": start, "error": str(exc)}
                    continue
                decode_seconds += part.seconds()
                part = Clock()
                activations = np.asarray(head(embedder(audio)))
                infer_seconds += part.seconds()
                have_long = have_long or name == "long60"
                patches.append(activations)
                means = activations.mean(axis=0)
                found[name] = {
                    "start": start,
                    "seconds": seconds,
                    "patches": int(activations.shape[0]),
                    "top": top(means, classes, 5),
                    "scores": [round(float(v), 5) for v in means],
                }
            record["windows"] = found
            if patches:
                scores = np.concatenate(patches).mean(axis=0)
                record["top"] = top(scores, classes)
                record["scores"] = [round(float(s), 5) for s in scores]
                record["status"] = "done"
            else:
                record["status"] = "failed"
        except Exception as exc:  # noqa: BLE001 - one bad song is a failed record, not a stop
            record["status"] = "failed"
            record["error"] = f"{type(exc).__name__}: {exc}"
            record["trace"] = traceback.format_exc()[-1500:]
        record["seconds_total"] = song_clock.seconds()
        record["seconds_decode"] = round(decode_seconds, 4)
        record["seconds_infer"] = round(infer_seconds, 4)
        record["memory"] = memory()
        write_json(target, record)
        best = record.get("top", [["-", 0]])[0]
        print(
            f"{song_id} {record['status']} {best[0]} {best[1]} in {record['seconds_total']:.1f} s",
            flush=True,
        )
    final = memory()
    run = {"load_seconds": load_seconds, "memory_after_load": after_load, "memory_end": final}
    write_json(out_dir / "_end.json", run)
    print(f"done, cgroup peak {final['cgroup_peak']}", flush=True)


if __name__ == "__main__":
    main()
