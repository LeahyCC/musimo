"""Candidates for the GPU check: songs outside the bake-off's 300, read-only from the trial copy.

Shuffled with a fixed seed (blake2b of seed + song id). Podcasts are left out (the recipe skips
them) and so are files under 30 s (the voice clips need their own rule).
"""

import hashlib
import json
import sqlite3
import sys

SEED = "musimo-gpu-20261020"
done = set(json.load(open("/bakeoff-sample.json", encoding="utf-8"))["songs"])
c = sqlite3.connect("file:/data/musimo.sqlite3?mode=ro", uri=True)
c.row_factory = sqlite3.Row
rows = [
    dict(r)
    for r in c.execute(
        """SELECT song_id, path, duration, isrc, title, artist, genre FROM library_files
           WHERE duration >= 30 AND isrc IS NOT NULL AND isrc != ''
             AND lower(coalesce(genre, '')) NOT IN ('podcast', 'podcasts', 'spoken word')"""
    )
    if r["song_id"] not in done
]
rows.sort(key=lambda r: hashlib.blake2b((SEED + r["song_id"]).encode(), digest_size=8).digest())
json.dump({"seed": SEED, "candidates": rows[: int(sys.argv[1])]}, sys.stdout, ensure_ascii=False)
