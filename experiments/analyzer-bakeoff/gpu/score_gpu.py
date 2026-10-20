"""Score the fresh-100 GPU runs with the bake-off's own rules (TOL 2 BPM, steady gap 12%).

Usage: python -I score_gpu.py <runtime dir holding sample.json and out/>
Writes results.json in that directory.
"""

import json
import statistics
import sys
from collections import Counter
from pathlib import Path

import numpy as np

here = Path(sys.argv[1])
sample = json.loads((here / "sample.json").read_text(encoding="utf-8"))
TOL, STEADY = 2.0, 0.12


def classify(v, ref):
    if not v or not ref:
        return None
    if abs(v - ref) <= TOL:
        return "same"
    if abs(v - 2 * ref) <= TOL:
        return "double"
    if abs(v - ref / 2) <= TOL:
        return "half"
    return "other"


def fine(beats):
    if len(beats) < 4:
        return None
    gaps = np.diff(np.asarray(beats))
    gaps = gaps[gaps > 0]
    if not len(gaps):
        return None
    med = float(np.median(gaps))
    steady = gaps[np.abs(gaps - med) <= STEADY * med]
    return round(60.0 / float(steady.mean()), 2) if len(steady) >= 3 else None


def agreement(pairs):
    c = Counter(x for x in (classify(a, b) for a, b in pairs) if x)
    return {"n": sum(c.values()), **{k: c.get(k, 0) for k in ("same", "half", "double", "other")}}


out = {}
for run in sorted((here / "out").iterdir()):
    end = json.loads((run / "_end.json").read_text(encoding="utf-8"))
    rows = {}
    for p in run.glob("tr-*.json"):
        r = json.loads(p.read_text(encoding="utf-8"))
        w = r["windows"]
        secs = [
            v
            for k, v in ((k, fine(x.get("beat_times", []))) for k, x in w.items() if k != "long60")
            if v
        ]
        rows[r["song_id"]] = {
            "sections": round(statistics.median(secs), 2) if secs else None,
            "n_sections": len(secs),
            "long60": fine(w.get("long60", {}).get("beat_times", [])),
            "deezer": sample["deezer"][r["song_id"]],
            "t": r["seconds_total"],
            "dec": r["seconds_decode"],
            "inf": r["seconds_infer"],
        }
    for v in rows.values():
        v["sure"] = v["n_sections"] >= 2 and classify(v["sections"], v["long60"]) == "same"
    t = sorted(v["t"] for v in rows.values())
    sure = [v for v in rows.values() if v["sure"]]
    unsure = [v for v in rows.values() if not v["sure"]]
    misses = [
        (
            sid,
            sample["songs"][sid]["artist"],
            sample["songs"][sid]["title"],
            sample["songs"][sid]["genre"],
            v["long60"],
            v["deezer"],
            classify(v["long60"], v["deezer"]),
            v["sure"],
        )
        for sid, v in rows.items()
        if classify(v["long60"], v["deezer"]) in ("half", "double", "other")
    ]
    out[run.name] = {
        "songs": len(rows),
        "load_s": end["load_seconds"],
        "gpu_peak_mb": end.get("gpu_peak_mb"),
        "per_song_median_p95": [t[len(t) // 2], t[int(len(t) * 0.95)]],
        "decode_share": round(
            sum(v["dec"] for v in rows.values()) / sum(v["t"] for v in rows.values()), 3
        ),
        "infer_median": sorted(v["inf"] for v in rows.values())[len(rows) // 2],
        "vs_deezer_long60": agreement((v["long60"], v["deezer"]) for v in rows.values()),
        "vs_deezer_sections": agreement((v["sections"], v["deezer"]) for v in rows.values()),
        "sure": {"songs": len(sure), **agreement((v["long60"], v["deezer"]) for v in sure)},
        "unsure": {"songs": len(unsure), **agreement((v["long60"], v["deezer"]) for v in unsure)},
        "misses": misses,
    }
(here / "results.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
print("written", here / "results.json")
