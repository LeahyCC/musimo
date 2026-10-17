"""What a proposal revision holds, said from its actual songs, and a sample that stands for it.

The preview shows a compact overview and about six songs, with the full ordered list beside
them. The overview keeps three kinds of fact apart: `requested` (what the intent asked for),
`measured` (what the songs and their fresh measurements show) and `unknown` (what could not
be read). A missing value is unknown, never a zero or a negative, and nothing is inferred from
a genre name. No model is called and nothing is written.
"""

import hashlib
import math
from collections.abc import Iterable, Sequence
from dataclasses import dataclass

from backend.library.audio_profile import ProfileSet
from backend.library.engine_contract import Intent
from backend.library.player import StoredSong

# A proposal this long or shorter is its own sample.
FULL_LIST_LIMIT = 12
SAMPLE_SIZE = 6
# Tercile cuts of the proposal's own known durations: short, middle, long.
_BUCKETS = 3


@dataclass(frozen=True)
class Sample:
    ids: list[str]
    # True when the sample is the whole list, in the proposal's order.
    complete: bool


def _length(song: StoredSong | None) -> float | None:
    """A usable whole-track length, or None for a missing, zero or nonfinite one."""
    if song is None or not math.isfinite(song.duration) or song.duration <= 0:
        return None
    return song.duration


def _genres(song: StoredSong) -> tuple[str, ...]:
    return song.genres or ((song.genre,) if song.genre else ())


def _rank(salt: str, song_id: str) -> str:
    """A tie-break that depends only on the song and the proposal, so one revision always
    picks the same songs and no song is favoured for sitting early in the list."""
    return hashlib.blake2b(f"{salt}\n{song_id}".encode(), digest_size=8).hexdigest()


def _bucket_of(duration: float | None, cuts: Sequence[float]) -> int:
    if duration is None:
        return -1
    return sum(1 for cut in cuts if duration > cut)


def pick_sample(ids: Sequence[str], songs: dict[str, StoredSong], salt: str = "") -> Sample:
    """About six songs from the proposal, spread over its artists, genres and lengths.

    A proposal of `FULL_LIST_LIMIT` or fewer is returned whole. Otherwise songs are taken one
    at a time, each time preferring one whose artist is new to the sample, then one with the
    most genres the sample lacks, then a length band it lacks, and last a hash of the song id.
    The result is in the proposal's order. It depends on the ids and their tags only, so a
    new measurement cannot change it. Songs no longer in the library are never picked."""
    if len(ids) <= FULL_LIST_LIMIT:
        return Sample(list(ids), True)
    pool = [sid for sid in dict.fromkeys(ids) if sid in songs]
    known = sorted(d for d in (_length(songs[sid]) for sid in pool) if d is not None)
    cuts = [known[len(known) * n // _BUCKETS] for n in range(1, _BUCKETS)] if known else []
    artists: set[str] = set()
    genres: set[str] = set()
    bands: set[int] = set()
    chosen: set[str] = set()
    while len(chosen) < min(SAMPLE_SIZE, len(pool)):

        def score(sid: str) -> tuple[int, int, int, int]:
            song = songs[sid]
            band = _bucket_of(_length(song), cuts)
            return (
                int(song.artist.casefold() not in artists),
                sum(1 for genre in _genres(song) if genre.casefold() not in genres),
                int(band not in bands),
                # The smallest hash wins, so it is negated beside the maximised terms.
                -int(_rank(salt, sid), 16),
            )

        best = max((sid for sid in pool if sid not in chosen), key=score)
        song = songs[best]
        chosen.add(best)
        artists.add(song.artist.casefold())
        genres.update(genre.casefold() for genre in _genres(song))
        bands.add(_bucket_of(_length(song), cuts))
    return Sample([sid for sid in ids if sid in chosen], False)


def _requested(intent: Intent) -> dict[str, object]:
    """Only what the intent set, as it set it."""
    return {
        "scope": intent.scope,
        "filters": intent.filters.model_dump(exclude_defaults=True),
    }


def _range(values: Iterable[float]) -> dict[str, float] | None:
    found = list(values)
    return {"min": min(found), "max": max(found)} if found else None


def summarize(
    intent: Intent,
    ids: Sequence[str],
    songs: dict[str, StoredSong],
    scalar: ProfileSet | None,
) -> dict[str, object]:
    """The overview of one revision. `scalar` is the tempo and energy rows of the scalar
    recipe when one is on, else None; only a row measured from the file as it is now counts."""
    present: list[StoredSong] = [songs[sid] for sid in ids if sid in songs]
    durations = [d for d in (_length(songs.get(sid)) for sid in ids) if d is not None]
    counts: dict[str, int] = {}
    for song in present:
        for genre in dict.fromkeys(_genres(song)):
            counts[genre] = counts.get(genre, 0) + 1
    years = [song.year for song in present if song.year > 0]
    measured: dict[str, object] = {
        "track_count": len(ids),
        "total_seconds": sum(durations),
        "artist_count": len({song.artist.casefold() for song in present if song.artist}),
        "genres": [
            {"name": name, "count": count}
            for name, count in sorted(counts.items(), key=lambda item: (-item[1], item[0]))
        ],
        "year_range": {"min": min(years), "max": max(years)} if years else None,
        # Tempo and energy exist only with a scalar recipe, and only as the rows say.
        "audio": None,
    }
    unknown: dict[str, object] = {
        "duration_tracks": len(ids) - len(durations),
        "year_tracks": len(present) - len(years),
        "genre_tracks": sum(1 for song in present if not _genres(song)),
        "artist_tracks": sum(1 for song in present if not song.artist),
        # Songs the library no longer holds have no tags to read.
        "missing_tracks": len(ids) - len(present),
    }
    if scalar is not None:
        rows = [row for song in present if (row := scalar.fresh(song)) is not None]
        tempo = [row.tempo_bpm for row in rows if row.tempo_bpm is not None]
        energy = [row.energy for row in rows if row.energy is not None]
        measured["audio"] = {
            "recipe": scalar.recipe.id,
            "tempo": _range(tempo),
            "energy": _range(energy),
            "tempo_coverage": {"measured": len(tempo), "total": len(ids)},
            "energy_coverage": {"measured": len(energy), "total": len(ids)},
        }
        unknown["tempo_tracks"] = len(ids) - len(tempo)
        unknown["energy_tracks"] = len(ids) - len(energy)
    return {"requested": _requested(intent), "measured": measured, "unknown": unknown}
