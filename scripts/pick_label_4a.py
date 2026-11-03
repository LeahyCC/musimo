"""Build a blind 120-clip label set for the 4A audio evidence package.

Reads the catalogue read-only, picks hard cases with a fixed seed and SHA-256 ordering,
and writes a manifest to <data dir>/label-4a/. It opens the database read-only, does not scan
files and does not run any model.
"""

import argparse
import hashlib
import json
import os
import sqlite3
import sys
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import NotRequired, TypedDict, cast

from backend.core.text import normalize
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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Pick the 4A blind label set")
    parser.add_argument(
        "--data-dir",
        default=os.environ.get("MUSIMO_DATA_DIR", "/data"),
        help="Musimo data directory (default: MUSIMO_DATA_DIR or /data)",
    )
    parser.add_argument(
        "--output",
        default=os.environ.get("MUSIMO_LABEL_4A_MANIFEST", ""),
        help="Where to write the manifest (default: <data dir>/label-4a/manifest.json)",
    )
    parser.add_argument("--seed", default=DEFAULT_SEED, help="Deterministic ordering seed")
    parser.add_argument("--force", action="store_true", help="Overwrite an existing manifest")
    parser.add_argument(
        "--artists",
        default="",
        help='JSON file {"liquid": [...], "other_dnb": [...]} of artist names. The library '
        "has no liquid tag and few dnb tags, so Colin names the artists.",
    )
    return parser.parse_args()


def load_songs(db: sqlite3.Connection) -> list[Song]:
    """All indexed songs from enabled roots, with raw tags."""
    rows = db.execute(
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


def has_rms_rows(db: sqlite3.Connection) -> bool:
    """True if any RMS-style audio profile rows exist today."""
    row = db.execute(
        """
            SELECT 1 FROM audio_profile
            WHERE recipe LIKE 'rms-%' AND status = 'done' LIMIT 1
            """
    ).fetchone()
    return row is not None


def fetch_rms_songs(db: sqlite3.Connection, used: set[str], target: int, seed: str) -> list[Song]:
    """Songs with the most extreme RMS/loudness values, avoiding used artists."""
    rows = db.execute(
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
    per_artist: int = 1,
) -> list[Song]:
    """Pick up to `target` songs matching the predicate, in hash order.

    At most `per_artist` songs per artist, and never an artist another group already used.
    Groups with few artists (dnb, speech) allow more than one so they can fill.
    """
    eligible = [s for s in songs if predicate(s) and s["duration"] >= CLIP_SECONDS]
    eligible.sort(key=lambda s: _order_key(seed, s["song_id"]))
    chosen: list[Song] = []
    counts: dict[str, int] = {}
    for song in eligible:
        artist = song["artist_key"]
        if artist in used_artists or counts.get(artist, 0) >= per_artist:
            continue
        chosen.append(song)
        counts[artist] = counts.get(artist, 0) + 1
        if len(chosen) >= target:
            break
    used_artists.update(counts)
    return chosen


def split_group(songs: list[Song], seed: str) -> list[tuple[Song, str]]:
    """Split a group into dev and held by artist, so no artist is in both splits.

    Artists go in hash order to whichever split has fewer songs so far.
    """
    by_artist: dict[str, list[Song]] = {}
    for song in songs:
        by_artist.setdefault(song["artist_key"], []).append(song)
    artists = sorted(by_artist, key=lambda a: _order_key(f"{seed}|split", a))
    sizes = {"dev": 0, "held": 0}
    result: list[tuple[Song, str]] = []
    for artist in artists:
        split = "dev" if sizes["dev"] <= sizes["held"] else "held"
        for song in by_artist[artist]:
            result.append((song, split))
        sizes[split] += len(by_artist[artist])
    return result


def section_start(song: Song, group: str) -> int:
    """The manifest section start: long-intro groups start at zero, others at the middle."""
    if group == "long_intro":
        return 0
    duration = song["duration"]
    if duration <= CLIP_SECONDS:
        return 0
    middle = max(0, int(duration / 2) - CLIP_SECONDS // 2)
    return min(middle, int(duration) - CLIP_SECONDS)


def build_manifest(
    songs: list[Song],
    db: sqlite3.Connection,
    seed: str,
    liquid_artists: frozenset[str] = frozenset(),
    dnb_artists: frozenset[str] = frozenset(),
) -> dict[str, object]:
    used_artists: set[str] = set()
    shortfalls: dict[str, int] = {}
    group_clips: list[tuple[str, list[tuple[Song, str]]]] = []

    def note(name: str, target: int, chosen: list[Song]) -> list[tuple[Song, str]]:
        if len(chosen) < target:
            shortfalls[name] = target - len(chosen)
        return split_group(chosen, seed)

    # 1 and 2. Drum and bass. Colin's artist lists come first, since the tags barely cover it.
    def is_liquid(song: Song) -> bool:
        return song["artist_key"] in liquid_artists or LIQUID_TAG in tag_set(song)

    def is_other_dnb(song: Song) -> bool:
        dnb = song["artist_key"] in dnb_artists or bool(DNB_TAGS & tag_set(song))
        return dnb and not is_liquid(song)

    liquid = pick(songs, is_liquid, 20, used_artists, seed, per_artist=3)
    group_clips.append(("liquid", note("liquid", 20, liquid)))
    other_dnb = pick(songs, is_other_dnb, 20, used_artists, seed, per_artist=3)
    group_clips.append(("other_dnb", note("other_dnb", 20, other_dnb)))

    # 3. Vocals unclear: half that lean instrumental, half from vocal-heavy genres, so the
    # set has both answers instead of mostly pop and hip-hop from the largest groups.
    def leans_instrumental(song: Song) -> bool:
        tags = tag_set(song)
        return "instrumental" in _fold(song["title"]) or bool(
            {"instrumental", "ambient", "classical"} & tags
        )

    def vocal_heavy(song: Song) -> bool:
        return bool(broad_groups(song) & VOCAL_HEAVY_GROUPS) and not leans_instrumental(song)

    vocals = pick(songs, leans_instrumental, 10, used_artists, seed)
    vocals += pick(songs, vocal_heavy, 10, used_artists, seed)
    group_clips.append(("vocals_unclear", note("vocals_unclear", 20, vocals)))

    # 4. Loud but calm / quiet but intense
    if has_rms_rows(db):
        loud_quiet = fetch_rms_songs(db, used_artists, 20, seed)
        group_clips.append(("loud_quiet", note("loud_quiet", 20, loud_quiet)))
    else:
        calm = pick(songs, lambda s: bool(tag_set(s) & CALM_TAGS), 10, used_artists, seed)
        intense = pick(songs, lambda s: bool(tag_set(s) & INTENSE_TAGS), 10, used_artists, seed)
        group_clips.append(("loud_quiet", note("loud_quiet", 20, calm + intense)))

    # 5. Long intro / tempo change
    long_songs = pick(songs, lambda s: s["duration"] >= LONG_SECONDS, 15, used_artists, seed)
    group_clips.append(("long_intro", note("long_intro", 15, long_songs)))

    # 6. Speech
    speech = pick(
        songs, lambda s: bool(tag_set(s) & SPEECH_TAGS), 10, used_artists, seed, per_artist=3
    )
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


def load_artists(path: str) -> tuple[frozenset[str], frozenset[str]]:
    """Liquid and other dnb artist keys from Colin's list. The file stays out of the repo."""
    if not path:
        return frozenset(), frozenset()
    with open(path, encoding="utf-8") as handle:
        data = json.load(handle)
    liquid = frozenset(normalize(str(name)) for name in data.get("liquid", []))
    other = frozenset(normalize(str(name)) for name in data.get("other_dnb", []))
    return liquid, other


def main() -> None:
    args = parse_args()
    data = Path(args.data_dir)
    if not data.is_dir():
        print(f"Data directory not found: {data}", file=sys.stderr)
        sys.exit(1)
    output = Path(args.output) if args.output else data / "label-4a" / "manifest.json"
    if output.exists() and not args.force:
        print(f"Manifest already exists: {output}", file=sys.stderr)
        print("Use --force to overwrite.", file=sys.stderr)
        sys.exit(1)
    output.parent.mkdir(parents=True, exist_ok=True)

    # Read-only: opening a Store would run its schema setup against the live database.
    db = sqlite3.connect(f"{(data / 'musimo.sqlite3').resolve().as_uri()}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    try:
        songs = load_songs(db)
        manifest = build_manifest(songs, db, args.seed, *load_artists(args.artists))
    finally:
        db.close()

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
