"""Walk the candidates in order and keep the first 100 that Deezer gives a BPM for. Host only.

Usage: python -I deezer_pick.py <runtime dir holding candidates.json>
Writes sample.json next to it.
"""

import json
import sys
import time
import urllib.request
from pathlib import Path

here = Path(sys.argv[1])
candidates = json.loads((here / "candidates.json").read_text(encoding="utf-8"))["candidates"]
picked, looked, errors = [], 0, 0
deezer = {}
for song in candidates:
    if len(picked) == 100:
        break
    looked += 1
    try:
        with urllib.request.urlopen(
            f"https://api.deezer.com/track/isrc:{song['isrc']}", timeout=20
        ) as r:
            body = json.load(r)
    except Exception as exc:  # noqa: BLE001 - a lookup failure only skips the song
        errors += 1
        deezer[song["song_id"]] = {"error": str(exc)}
        continue
    bpm = body.get("bpm") or 0
    deezer[song["song_id"]] = {"bpm": bpm, "title": body.get("title"), "error": body.get("error")}
    if bpm > 0:
        picked.append(song)
    time.sleep(0.25)
sample = {
    "rule": "first 100 candidates (seeded order) with Deezer bpm > 0",
    "looked_up": looked,
    "lookup_errors": errors,
    "tempo_ids": [s["song_id"] for s in picked],
    "songs": {s["song_id"]: s for s in picked},
    "deezer": {s["song_id"]: deezer[s["song_id"]]["bpm"] for s in picked},
}
(here / "sample.json").write_text(
    json.dumps(sample, ensure_ascii=False, indent=1), encoding="utf-8"
)
print(f"looked up {looked}, errors {errors}, picked {len(picked)}", file=sys.stderr)
