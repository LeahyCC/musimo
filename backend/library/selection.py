"""The order a library search walks: fit to the request first, then a seeded draw.

Play counts and skips are never a default taste score. Songs that fit a request equally are
drawn in a uniform random order. A request with a measure of fit (cosine to a reference song or
a phrase, or play count only when the person asked for familiar music) samples by that fit,
inside a window that never reaches far below the best matches, so variety never costs relevance.
Songs the chat showed lately go after the others that fit as well, and are never excluded.

The order depends only on the seed, the ids, their relevance and the shown songs. Each song's
draw is a hash of the seed and its id, so one seed repeats one selection. Without a rank key,
adding, removing or playing one song never reorders the others; with one, a change to the best
or the weakest fit in the window rescales the draw and can.
"""

import hashlib
import math
import secrets
import statistics
from collections.abc import Collection, Iterable, Mapping
from typing import NamedTuple

# Seeds stay below 2**53 so a browser can carry one as an exact number.
SEED_LIMIT = 2**53
# Inside the window, the best match is this many times as likely to be drawn first as the
# weakest one. Reasoned, not listened: tune it at the first embedding listen.
RELEVANCE_RATIO = 4.0
# The most recently shown songs one request can name.
SHOWN_LIMIT = 500


class Drawn(NamedTuple):
    """The walk, how many leading songs were sampled by fit, and whether it chose among more
    songs than the request needs (only then does asking again change the set)."""

    ids: list[str]
    window: int
    sampled: bool


def new_seed() -> int:
    return secrets.randbelow(SEED_LIMIT)


def sample_key(seed: int, song_id: str, person: bytes = b"musimo-select") -> int:
    """A 64-bit draw that depends only on the seed and the song. Never Python's hash().
    A different `person` gives an independent draw from the same seed."""
    digest = hashlib.blake2b(
        song_id.encode(),
        digest_size=8,
        key=seed.to_bytes(8, "little"),
        person=person,
    ).digest()
    return int.from_bytes(digest, "little")


def gumbel(key: int) -> float:
    """Standard Gumbel noise from a draw. 52 bits keep the uniform strictly inside (0, 1):
    with 53 or more, the largest draws round to 1.0 and the logarithm fails."""
    uniform = ((key >> 12) + 0.5) / 2**52
    return -math.log(-math.log(uniform))


def need_for(limit: int, add_count: int, target_seconds: int, durations: Iterable[float]) -> int:
    """About how many songs the fill will take. It sizes the window and nothing else; it never
    weighs a song, so a draw does not lean to short or long songs."""
    if add_count:
        return add_count
    lengths = [duration for duration in durations if duration > 0]
    if target_seconds and lengths:
        typical = statistics.median_low(lengths)
        return max(1, min(limit, math.ceil(target_seconds / typical) + 1))
    return max(1, limit)


def broad_order(
    ids: Iterable[str],
    seed: int,
    need: int,
    relevance: Mapping[str, float] | None,
    shown: Collection[str],
) -> Drawn:
    """The order a library search fills from.

    Without relevance every song fits equally: a uniform shuffle of the songs not shown lately,
    then of the shown ones. With relevance and more songs than needed, a window holds the top
    `need`, never reaches past twice that, and never further below the need-th song than the
    top songs spread; it is drawn by Gumbel-top-k (sampling without replacement, weighted by
    fit), unshown songs first. Everything below the window follows in fit order, for when the
    artist cap, duplicates, missing files or a length target use up the window.
    """
    keys = {sid: sample_key(seed, sid) for sid in dict.fromkeys(ids)}

    def fit(sid: str) -> float:
        return relevance[sid] if relevance is not None else 0.0

    base = sorted(keys, key=lambda sid: (-fit(sid), sid in shown, keys[sid], sid))
    count = len(base)
    needed = min(max(need, 1), count)
    sampled = count > needed
    if relevance is None or not sampled:
        return Drawn(base, count, sampled)
    best = fit(base[0])
    floor = max(round(2 * fit(base[needed - 1]) - best, 6), fit(base[min(count, 2 * needed) - 1]))
    width = needed
    while width < min(count, 2 * needed) and fit(base[width]) >= floor:
        width += 1
    window = base[:width]
    spread = best - fit(window[-1])
    scale = spread / math.log(RELEVANCE_RATIO) if spread > 0 else 0.0
    # The noise needs its own draw. The window's tie-break keeps the smallest keys, so noise
    # from the same keys would give exactly those songs the lowest scores and never draw them.
    noise = {sid: gumbel(sample_key(seed, sid, b"musimo-gumbel")) for sid in window}

    def score(sid: str) -> float:
        return (fit(sid) - best) / scale + noise[sid] if scale else noise[sid]

    drawn = sorted(window, key=lambda sid: (-score(sid), keys[sid], sid))
    walk = [sid for sid in drawn if sid not in shown] + [sid for sid in drawn if sid in shown]
    return Drawn(walk + base[width:], width, sampled)


def refine_order(ids: Iterable[str]) -> list[str]:
    """Refining a proposal or the queue keeps the person's order: nothing is drawn or sorted.
    A follow-up inherits earlier filters such as familiar, and those must not quietly re-sort
    songs the person already arranged."""
    return list(dict.fromkeys(ids))
