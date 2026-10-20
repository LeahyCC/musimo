"""Export the bake-off sample from the trial DB copy, opened read-only.

Tempo sample: every tempo-energy-v1 row (the 100-song run, podcast included).
Genre sample: those 100 plus 200 more, drawn by a blake2b hash of SEED and song_id,
stratified so each of the top genre tags has at least MIN_PER_TAG songs in the 300.
Writes one JSON document to the path given as the only argument.
"""

import hashlib
import json
import sqlite3
import sys
from collections import Counter

SEED = "musimo-bakeoff-20261019"
EXTRA = 200
MIN_PER_TAG = 15
TOP_TAGS = 14
COLUMNS = (
    "song_id, path, size, mtime_ns, title, artist, album, duration, genre, genres, isrc, suffix"
)


def draw_key(song_id: str) -> str:
    return hashlib.blake2b(f"{SEED}:{song_id}".encode(), digest_size=16).hexdigest()


def main() -> None:
    db = sqlite3.connect("file:/data/musimo.sqlite3?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    rows = {r["song_id"]: dict(r) for r in db.execute(f"SELECT {COLUMNS} FROM library_files")}
    tempo = {
        r["song_id"]: dict(r)
        for r in db.execute(
            "SELECT song_id, status, tempo_bpm, energy, detail FROM audio_profile"
            " WHERE recipe = 'tempo-energy-v1'"
        )
    }
    counts = Counter((r["genre"] or "").strip() for r in rows.values())
    top = [g for g, _ in counts.most_common() if g][:TOP_TAGS]

    base = sorted(tempo)
    chosen = set(base)
    have = Counter((rows[s]["genre"] or "").strip() for s in base if s in rows)

    def eligible(r: dict) -> bool:
        genre = (r["genre"] or "").strip()
        dur = r["duration"] or 0
        return bool(genre) and genre.casefold() not in {"podcast", "podcasts"} and 30 <= dur <= 1200

    pool = sorted((r for r in rows.values() if eligible(r)), key=lambda r: draw_key(r["song_id"]))
    # First pass: top up each main tag to MIN_PER_TAG.
    for tag in top:
        for r in pool:
            if have[tag] >= MIN_PER_TAG or len(chosen) >= len(base) + EXTRA:
                break
            if r["song_id"] not in chosen and (r["genre"] or "").strip() == tag:
                chosen.add(r["song_id"])
                have[tag] += 1
    # Second pass: fill the rest in hash order, cycling the main tags so no tag dominates,
    # then any other tag.
    queues = {tag: [r for r in pool if (r["genre"] or "").strip() == tag] for tag in top}
    while len(chosen) < len(base) + EXTRA and any(queues.values()):
        for tag in top:
            while queues[tag] and queues[tag][0]["song_id"] in chosen:
                queues[tag].pop(0)
            if queues[tag] and len(chosen) < len(base) + EXTRA:
                r = queues[tag].pop(0)
                chosen.add(r["song_id"])
                have[tag] += 1
    out = {
        "seed": SEED,
        "top_tags": top,
        "library_tag_counts": dict(counts.most_common(40)),
        "tempo_ids": base,
        "genre_ids": sorted(chosen, key=lambda s: (s not in tempo, draw_key(s))),
        "songs": {s: {**rows[s], "tempo_energy_v1": tempo.get(s)} for s in chosen if s in rows},
        "missing_from_library": [s for s in chosen if s not in rows],
    }
    with open(sys.argv[1], "w", encoding="utf-8") as handle:
        json.dump(out, handle, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
