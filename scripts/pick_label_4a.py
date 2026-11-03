"""Build a blind 120-clip label set for the 4A audio evidence package.

Reads the catalogue read-only, picks hard cases with a fixed seed and SHA-256 ordering,
and writes a manifest under runtime/label-4a/. It does not scan files or run any model.
"""

import argparse
import hashlib
import json
import os
import sys
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import NotRequired, TypedDict, cast

from backend.core.store import Store
from backend.library.genres import _fold, tag_profile


class Song(TypedDict):
    song_id: str
    artist_key: str
    duration: float
    genres: list[str]
    title: str
    rms: NotRequired[float]


CLIP_SECONDS = 30
LONG_SECONDS = 600

LIQUID_TAG = _fold("Liquid Drum and Bass")
DNB_TAGS = {_fold(t) for t in ("Drum and Bass", "Neurofunk", "Jungle", "dnb")}
SPEECH_TAGS = {
    _fold(t) for t in ("Podcast", "Comedy", "Spoken", "Non-Music - Radioplay", "Spoken Word")
}
CALM_TAGS = {_fold(t) for t in ("Ambient", "Classical", "Chill", "Piano", "Acoustic")}
INTENSE_TAGS = {_fold(t) for t in ("Metal", "Hardcore", "Hard Rock", "Punk")}
VOCAL_HEAVY_GROUPS = {"pop", "hip-hop", "soul-rnb", "reggae"}

DEFAULT_SEED = "label-4a-v1"
DEFAULT_OUTPUT = "runtime/label-4a/manifest.json"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Pick the 4A blind label set")
    parser.add_argument(
        "--data-dir",
        default=os.environ.get("MUSIMO_DATA_DIR", "/data"),
        help="Musimo data directory (default: MUSIMO_DATA_DIR or /data)",
    )
    parser.add_argument(
        "--output",
        default=os.environ.get("MUSIMO_LABEL_4A_MANIFEST", DEFAULT_OUTPUT),
        help="Where to write the manifest (default: runtime/label-4a/manifest.json)",
    )
    parser.add_argument("--seed", default=DEFAULT_SEED, help="Deterministic ordering seed")
    parser.add_argument("--force", action="store_true", help="Overwrite an existing manifest")
    return parser.parse_args()


def load_songs(store: Store) -> list[Song]:
    """All indexed songs from enabled roots, with raw tags."""
    with store.lock:
        rows = store.db.execute(
            """
            SELECT
                f.song_id,
                f.artist_key,
                f.duration,
                f.genres,
                f.title
            FROM library_files f
            JOIN library_roots r ON r.path = f.root AND r.enabled = 1
            WHERE f.song_id != ''
            """
        ).fetchall()
    songs: list[Song] = []
    for row in rows:
        raw_genres = json.loads(str(row["genres"]))
        genres = [str(g) for g in raw_genres] if isinstance(raw_genres, list) else []
        songs.append(
            {
                "song_id": str(row["song_id"]),
                "artist_key": str(row["artist_key"]),
                "duration": float(row["duration"]),
                "genres": genres,
                "title": str(row["title"]),
            }
        )
    return songs


def tag_set(song: Song) -> set[str]:
    """Folded tag words for the song."""
    return {_fold(tag) for tag in song["genres"] if tag.strip()}


def broad_groups(song: Song) -> frozenset[str]:
    """Broad genre groups the song's tags map to."""
    return tag_profile(tuple(song["genres"]))[1]


def has_rms_rows(store: Store) -> bool:
    """True if any RMS-style audio profile rows exist today."""
    with store.lock:
        row = store.db.execute(
            """
            SELECT 1 FROM audio_profile
            WHERE recipe LIKE 'rms-%' AND status = 'done' LIMIT 1
            """
        ).fetchone()
    return row is not None


def fetch_rms_songs(store: Store, used: set[str], target: int, seed: str) -> list[Song]:
    """Songs with the most extreme RMS/loudness values, avoiding used artists."""
    with store.lock:
        rows = store.db.execute(
            """
            SELECT f.song_id, f.artist_key, f.duration, f.genres, f.title, ap.energy
            FROM audio_profile ap
            JOIN library_files f ON f.song_id = ap.song_id
            JOIN library_roots r ON r.path = f.root AND r.enabled = 1
            WHERE ap.recipe LIKE 'rms-%' AND ap.status = 'done' AND ap.energy IS NOT NULL
              AND f.song_id != '' AND f.duration >= ?
            """,
            (CLIP_SECONDS,),
        ).fetchall()
    candidates: list[Song] = []
    for row in rows:
        raw_genres = json.loads(str(row["genres"]))
        genres = [str(g) for g in raw_genres] if isinstance(raw_genres, list) else []
        candidates.append(
            {
                "song_id": str(row["song_id"]),
                "artist_key": str(row["artist_key"]),
                "duration": float(row["duration"]),
                "genres": genres,
                "title": str(row["title"]),
                "rms": float(row["energy"]),
            }
        )
    # Take loud-but-calm and quiet-but-intense as the two tails of the RMS distribution.
    ordered = sorted(candidates, key=lambda s: _order_key(seed, s["song_id"]))
    low_rms: list[Song] = []
    high_rms: list[Song] = []
    for song in ordered:
        if song["artist_key"] in used:
            continue
        if song.get("rms", 0) == 0:
            continue
        if len(low_rms) < target // 2 and song.get("rms", 0) < 0.05:
            low_rms.append(song)
            used.add(song["artist_key"])
        elif len(high_rms) < target // 2 and song.get("rms", 0) > 0.2:
            high_rms.append(song)
            used.add(song["artist_key"])
        if len(low_rms) + len(high_rms) >= target:
            break
    return low_rms + high_rms


def _order_key(seed: str, song_id: str) -> str:
    return hashlib.sha256(f"{seed}|{song_id}".encode()).hexdigest()


def pick(
    songs: list[Song],
    predicate: Callable[[Song], bool],
    target: int,
    used_artists: set[str],
    seed: str,
) -> list[Song]:
    """Pick up to `target` songs matching the predicate, one per artist, in hash order."""
    eligible = [s for s in songs if predicate(s) and s["duration"] >= CLIP_SECONDS]
    eligible.sort(key=lambda s: _order_key(seed, s["song_id"]))
    chosen: list[Song] = []
    for song in eligible:
        if song["artist_key"] in used_artists:
            continue
        chosen.append(song)
        used_artists.add(song["artist_key"])
        if len(chosen) >= target:
            break
    return chosen


def split_group(songs: list[Song], seed: str) -> list[tuple[Song, str]]:
    """Assign a group alternately to dev and held using a separate deterministic key."""
    ordered = sorted(songs, key=lambda s: _order_key(f"{seed}|split", s["song_id"]))
    return [(song, "dev" if index % 2 == 0 else "held") for index, song in enumerate(ordered)]


def section_start(song: Song, group: str) -> int:
    """The manifest section start: long-intro groups start at zero, others at the middle."""
    if group == "long_intro":
        return 0
    duration = song["duration"]
    if duration <= CLIP_SECONDS:
        return 0
    middle = max(0, int(duration / 2) - CLIP_SECONDS // 2)
    return min(middle, int(duration) - CLIP_SECONDS)


def build_manifest(songs: list[Song], store: Store, seed: str) -> dict[str, object]:
    used_artists: set[str] = set()
    shortfalls: dict[str, int] = {}
    group_clips: list[tuple[str, list[tuple[Song, str]]]] = []

    def note(name: str, target: int, chosen: list[Song]) -> list[tuple[Song, str]]:
        if len(chosen) < target:
            shortfalls[name] = target - len(chosen)
        return split_group(chosen, seed)

    # 1. Liquid drum and bass
    liquid = pick(
        songs,
        lambda s: LIQUID_TAG in tag_set(s) and not (DNB_TAGS - {LIQUID_TAG}) & tag_set(s),
        20,
        used_artists,
        seed,
    )
    group_clips.append(("liquid", note("liquid", 20, liquid)))

    # 2. Other drum and bass
    other_dnb = pick(
        songs,
        lambda s: bool(DNB_TAGS & tag_set(s)) and LIQUID_TAG not in tag_set(s),
        20,
        used_artists,
        seed,
    )
    group_clips.append(("other_dnb", note("other_dnb", 20, other_dnb)))

    # 3. Vocals unclear
    def vocals_unclear(song: Song) -> bool:
        title = _fold(song["title"])
        tags = tag_set(song)
        groups = broad_groups(song)
        return (
            "instrumental" in title
            or "instrumental" in tags
            or "ambient" in tags
            or "classical" in tags
            or len(groups) >= 2
            or bool(groups & VOCAL_HEAVY_GROUPS)
        )

    vocals = pick(songs, vocals_unclear, 20, used_artists, seed)
    group_clips.append(("vocals_unclear", note("vocals_unclear", 20, vocals)))

    # 4. Loud but calm / quiet but intense
    if has_rms_rows(store):
        loud_quiet = fetch_rms_songs(store, used_artists, 20, seed)
        group_clips.append(("loud_quiet", note("loud_quiet", 20, loud_quiet)))
    else:
        calm = pick(songs, lambda s: bool(tag_set(s) & CALM_TAGS), 10, used_artists, seed)
        intense = pick(songs, lambda s: bool(tag_set(s) & INTENSE_TAGS), 10, used_artists, seed)
        group_clips.append(("loud_quiet", note("loud_quiet", 20, calm + intense)))

    # 5. Long intro / tempo change
    long_songs = pick(songs, lambda s: s["duration"] >= LONG_SECONDS, 15, used_artists, seed)
    group_clips.append(("long_intro", note("long_intro", 15, long_songs)))

    # 6. Speech
    speech = pick(songs, lambda s: bool(tag_set(s) & SPEECH_TAGS), 10, used_artists, seed)
    group_clips.append(("speech", note("speech", 10, speech)))

    # 7. Random from the library, prioritising untagged songs
    def untagged_or_random(s: Song) -> bool:
        return s["artist_key"] not in used_artists

    untagged = [s for s in songs if not s["genres"] and s["duration"] >= CLIP_SECONDS]
    untagged.sort(key=lambda s: _order_key(seed, s["song_id"]))
    random_chosen: list[Song] = []
    for song in untagged:
        if song["artist_key"] in used_artists:
            continue
        random_chosen.append(song)
        used_artists.add(song["artist_key"])
        if len(random_chosen) >= 7:
            break
    remaining_target = 15 - len(random_chosen)
    if remaining_target > 0:
        random_chosen.extend(
            pick(
                [s for s in songs if s not in random_chosen],
                untagged_or_random,
                remaining_target,
                used_artists,
                seed,
            )
        )
    group_clips.append(("random", note("random", 15, random_chosen)))

    clips = []
    counter = 1
    for group, items in group_clips:
        for song, split in items:
            clips.append(
                {
                    "clip_id": f"C{counter:03d}",
                    "song_id": song["song_id"],
                    "section_start": section_start(song, group),
                    "group": group,
                    "split": split,
                }
            )
            counter += 1

    return {
        "seed": seed,
        "snapshot_time": datetime.now(UTC).isoformat(),
        "total": len(clips),
        "clips": clips,
        "shortfalls": shortfalls,
    }


def main() -> None:
    args = parse_args()
    output = Path(args.output)
    if output.exists() and not args.force:
        print(f"Manifest already exists: {output}", file=sys.stderr)
        print("Use --force to overwrite.", file=sys.stderr)
        sys.exit(1)
    output.parent.mkdir(parents=True, exist_ok=True)

    data = Path(args.data_dir)
    if not data.is_dir():
        print(f"Data directory not found: {data}", file=sys.stderr)
        sys.exit(1)

    store = Store(data / "musimo.sqlite3")
    try:
        songs = load_songs(store)
        manifest = build_manifest(songs, store, args.seed)
    finally:
        store.close()

    with output.open("w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2)

    total = cast(int, manifest["total"])
    print(f"Wrote {total} clips to {output}")
    print(f"Snapshot time: {cast(str, manifest['snapshot_time'])}")
    shortfalls = cast(dict[str, int], manifest["shortfalls"])
    if shortfalls:
        print("Shortfalls (target - actual):")
        for group, shortfall in shortfalls.items():
            print(f"  {group}: {shortfall}")
    else:
        print("All groups filled.")


if __name__ == "__main__":
    main()
