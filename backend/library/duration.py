"""A total length for a selection, and the bounded search that picks whole songs to meet it.

Length is the sum of the songs' stored lengths, compared in whole milliseconds. Nothing is
estimated for crossfades or gaps. A song with an unknown, zero or non-finite length cannot
count towards a total, so it is never a candidate here; the caller counts it.

The search is deterministic and bounded. It sees at most CANDIDATE_CAP songs, in the order the
caller walks them (drawn for a library search, the person's own for a refinement), and stops
after WORK_LIMIT steps, never on the clock. Within those limits it keeps the first best total it
finds, so a tie goes to the songs earlier in the walk. It does not claim that total is the best
the library holds. A shortage is "proven" only when a bound over every eligible song, or a
search that ran to the end over all of them, rules a total out; otherwise it is "not_found".
"""

import math
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Literal, NamedTuple

from pydantic import BaseModel, ConfigDict, Field

Mode = Literal["under", "at_most", "at_least", "over", "about"]
# "About N" is the closest total within this many seconds either side of N.
ABOUT_WINDOW = 300
# The most songs one search considers, from the front of the walk. Above the 500-song
# selection limit, so a long target is not cut short by the cap alone.
CANDIDATE_CAP = 600
# The most steps one search takes. A step is one song tried at one position.
WORK_LIMIT = 50_000


class TotalLength(BaseModel):
    """The whole selection's length: under N (strictly less), at most N, at least N, over N
    (strictly more), or about N (closest within ABOUT_WINDOW)."""

    model_config = ConfigDict(extra="forbid", strict=True)

    mode: Mode
    seconds: int = Field(ge=1, le=86400)


@dataclass(frozen=True)
class Item:
    """One candidate. At most `group_cap` items of one group, and one item per unique key."""

    ms: int
    group: str | None = None
    unique: object = None


class Found(NamedTuple):
    picked: list[int]
    total_ms: int
    # A selection in range was found. With kept songs that can be picking nothing more.
    hit: bool
    # Every combination was ruled in or out, or the goal was hit exactly.
    complete: bool
    work: int


@dataclass(frozen=True)
class Outcome:
    picked: list[int]
    total_ms: int
    met: bool
    unmet: Literal["", "proven", "not_found"]
    # The other side of the target, for the person to accept: longer when the target has an
    # upper edge that could not be met from below.
    alternative: list[int] | None
    alternative_ms: int
    complete: bool
    work: int


def length_ms(seconds: float) -> int | None:
    """A stored length in milliseconds, or None when it cannot count towards a total."""
    if not math.isfinite(seconds) or seconds <= 0:
        return None
    ms = round(seconds * 1000)
    return ms if ms > 0 else None


def bounds(mode: Mode, seconds: int) -> tuple[int, int | None, int]:
    """The totals that meet a target, as floor (inclusive), ceiling (exclusive, None for no
    ceiling) and the goal the search moves towards, all in milliseconds."""
    target = seconds * 1000
    window = ABOUT_WINDOW * 1000
    if mode == "under":
        return 1, target, target
    if mode == "at_most":
        return 1, target + 1, target
    if mode == "at_least":
        return target, None, target
    if mode == "over":
        return target + 1, None, target + 1
    return max(1, target - window), target + window + 1, target


def most(items: list[Item], limit: int, group_cap: int) -> int:
    """The longest total any selection of these items could have. The rules nest (one per
    unique key, a capped number per group, `limit` in all), so keeping the longest at each
    level is exact for them."""
    by_key: dict[object, Item] = {}
    loose: list[Item] = []
    for item in items:
        if item.unique is None:
            loose.append(item)
        elif item.unique not in by_key or by_key[item.unique].ms < item.ms:
            by_key[item.unique] = item
    groups: dict[str, list[int]] = {}
    free: list[int] = []
    for item in [*by_key.values(), *loose]:
        (groups.setdefault(item.group, []) if item.group is not None else free).append(item.ms)
    for lengths in groups.values():
        free += sorted(lengths, reverse=True)[:group_cap]
    return sum(sorted(free, reverse=True)[:limit])


def search(
    items: list[Item],
    limit: int,
    group_cap: int,
    floor: int,
    ceiling: int | None,
    goal: int,
    work_limit: int,
    taken: Iterable[Item] = (),
) -> Found:
    """The selection whose total in [floor, ceiling) is closest to `goal`, by a depth-first walk
    that tries each item in order before skipping it. Its first path is a plain greedy fill in
    the caller's order; later paths swap the later items first, so the front of the walk is
    kept when it can be. Branches that cannot reach the floor, or cannot beat the best found,
    are cut using the remaining lengths, ignoring the group and key rules (so the cut is safe).

    `taken` are songs already in the selection (kept by an edit). The bounds are relative to
    them, so a floor at or below 0 means they meet it already and picking nothing counts; they
    hold their places in the group cap and the key rule.
    """
    count = len(items)
    rest = [0] * (count + 1)
    shortest = [math.inf] * (count + 1)
    for index in range(count - 1, -1, -1):
        rest[index] = rest[index + 1] + items[index].ms
        shortest[index] = min(shortest[index + 1], items[index].ms)
    best: list[int] = []
    best_total = 0
    best_gap = math.inf
    hit = False
    if floor <= 0 and (ceiling is None or ceiling > 0):
        best_gap, hit = abs(goal), True
    chosen: list[int] = []
    groups: dict[str, int] = {}
    keys: set[object] = set()
    for item in taken:
        if item.group is not None:
            groups[item.group] = groups.get(item.group, 0) + 1
        if item.unique is not None:
            keys.add(item.unique)
    total = 0
    work = 0
    index = 0

    def take(at: int) -> None:
        nonlocal total
        item = items[at]
        chosen.append(at)
        total += item.ms
        if item.group is not None:
            groups[item.group] = groups.get(item.group, 0) + 1
        if item.unique is not None:
            keys.add(item.unique)

    def drop() -> int:
        nonlocal total
        at = chosen.pop()
        item = items[at]
        total -= item.ms
        if item.group is not None:
            groups[item.group] -= 1
        if item.unique is not None:
            keys.discard(item.unique)
        return at

    while True:
        reach = total + rest[index]
        exhausted = (
            index >= count
            or reach < floor
            or (ceiling is not None and total + shortest[index] >= ceiling)
            or (reach < goal and goal - reach >= best_gap)
        )
        if exhausted:
            if not chosen:
                return Found(best, best_total, hit, True, work)
            index = drop() + 1
            continue
        work += 1
        if work > work_limit:
            return Found(best, best_total, hit, False, work - 1)
        item = items[index]
        fits = (
            len(chosen) < limit
            and (ceiling is None or total + item.ms < ceiling)
            and (item.group is None or groups.get(item.group, 0) < group_cap)
            and (item.unique is None or item.unique not in keys)
        )
        if not fits:
            index += 1
            continue
        take(index)
        if total >= floor and abs(total - goal) < best_gap:
            best, best_total, best_gap, hit = list(chosen), total, abs(total - goal), True
            if best_gap == 0:
                return Found(best, best_total, True, True, work)
        if total >= goal or len(chosen) >= limit:
            # Adding more only moves away from the goal: try the next item here instead.
            index = drop() + 1
        else:
            index += 1


def fit(
    mode: Mode,
    seconds: int,
    candidates: list[Item],
    everything: list[Item],
    capped: bool,
    limit: int,
    group_cap: int,
    work_limit: int = WORK_LIMIT,
    taken: list[Item] | None = None,
) -> Outcome:
    """Meet a target from `candidates`, or say why not and offer the other side.

    `everything` holds every eligible item, the candidates and any the cap left out (their
    files unchecked, so it may hold more than can play); the shortage proofs read it, which
    only makes them more cautious. `capped` says the cap left some out.

    `taken` are songs an edit keeps. They are always in the selection and are never dropped
    to meet the target: the total counts them, `limit` is the number of songs that may join
    them, and `picked` and the alternative name only the songs added. Kept songs already past
    a ceiling make the target unmet, proven, with no alternative.

    When the target cannot be met the result is the longest selection below its floor (for
    about, at least and over), never a looser search. When it has a ceiling, the shortest
    selection at or past it is the alternative. A long mix alone is offered that way, never cut.
    Each of the up to three searches has its own `work_limit`.
    """
    kept = taken or []
    base = sum(item.ms for item in kept)
    floor, ceiling, goal = bounds(mode, seconds)
    has_floor = floor > 1
    # Relative to the kept songs from here on.
    floor, goal = floor - base, goal - base
    ceiling = ceiling - base if ceiling is not None else None
    if ceiling is not None and ceiling <= 0:
        return Outcome([], base, False, "proven", None, 0, True, 0)
    shortest = min((item.ms for item in everything), default=None)
    proven = (
        # Nothing more to add, and the kept songs alone are short.
        (shortest is None and floor > 0)
        or (floor > 0 and most(everything, limit, group_cap) < floor)
        or (ceiling is not None and shortest is not None and shortest >= ceiling and floor > 0)
    )
    work = 0
    complete = True
    if not proven:
        found = search(candidates, limit, group_cap, floor, ceiling, goal, work_limit, kept)
        work, complete = found.work, found.complete
        if found.hit:
            return Outcome(found.picked, base + found.total_ms, True, "", None, 0, complete, work)
        proven = complete and not capped
    picked: list[int] = []
    total = 0
    if has_floor and candidates:
        shorter = search(candidates, limit, group_cap, 1 - base, floor, floor - 1, work_limit, kept)
        work += shorter.work
        picked, total = shorter.picked, shorter.total_ms
    alternative = None
    alternative_ms = 0
    if ceiling is not None and candidates:
        longer = search(candidates, limit, group_cap, ceiling, None, ceiling, work_limit, kept)
        work += longer.work
        if longer.picked:
            alternative, alternative_ms = longer.picked, base + longer.total_ms
    return Outcome(
        picked,
        base + total,
        False,
        "proven" if proven else "not_found",
        alternative,
        alternative_ms,
        complete,
        work,
    )
