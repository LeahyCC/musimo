"""`tempo-beat-v1`: Beat This! tempo, with a sure check, and energy as linear RMS.

The bake-off's method exactly (docs/analyzer-bakeoff.md). Four windows are decoded with the
`tempo-energy-v1` decoder rules: three 10-second sections at 10, 50 and 90 percent of
`duration - 10` and one 60-second window centred on the middle. Beat This! gives beat times
per window. A window's BPM is 60 over the mean of its "steady" gaps, the gaps within 12 percent
of the median gap. The song's BPM is the median of the section BPMs. It is kept only when it is
sure: at least two sections gave a BPM, their median is within 2 BPM of the 60-second window,
and it is 200 BPM or less. An unsure song is still a done row, with its energy and no tempo.
Energy is the loudest window's mean frame RMS, so a quiet intro or breakdown under one
section does not pull a loud song down.

Podcast genres and files under 60 seconds are skipped before anything is decoded. Changing any
rule here is a new recipe id. Nothing in this module imports torch; the model is passed in as a
`Tracker`, so the rules are tested without it (see `model.py` for the real one).
"""

import json
import math
import statistics
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from audio_worker.recipe import (
    SECTION_FRACTIONS,
    SECTION_SECONDS,
    DecodeError,
    Job,
    Result,
    Samples,
    checked_file,
    decode_section,
    skip_reason,
)

RECIPE = "tempo-beat-v1"
LONG_SECONDS = 60.0
# Under this the check window is the whole file and holds the sections, so "sure" would be the
# audio agreeing with itself. 782 of the library's 786 short radio clips are under it.
MIN_SECONDS = 60.0
STEADY_TOLERANCE = 0.12
MIN_BEATS = 4
MIN_STEADY_GAPS = 3
AGREE_BPM = 2.0
MAX_SURE_BPM = 200.0
MIN_SURE_SECTIONS = 2
FRAME = 2048
HOP = 512
LONG = "long60"

# Beat times in seconds for one window of mono float32 at SAMPLE_RATE.
Tracker = Callable[[Samples], Sequence[float]]
# (path, start, seconds) -> samples, or DecodeError.
WindowDecoder = Callable[[Path, float, float], Samples]


@dataclass(frozen=True)
class Window:
    name: str
    start: float
    seconds: float


def windows(duration: float) -> list[Window]:
    """The three sections, then the 60-second check window. Assumes at least MIN_SECONDS."""
    span = duration - SECTION_SECONDS
    found = [
        Window(f"s{round(fraction * 100)}", round(span * fraction, 3), SECTION_SECONDS)
        for fraction in SECTION_FRACTIONS
    ]
    length = min(LONG_SECONDS, duration)
    found.append(Window(LONG, round(max(0.0, duration / 2 - length / 2), 3), length))
    return found


def beat_skip_reason(job: Job) -> str | None:
    """Why this song is not measured at all, decided from the lease alone."""
    reason = skip_reason(job.genre, job.genres)
    if reason is not None:
        return reason
    if math.isfinite(job.duration) and 0 < job.duration < MIN_SECONDS:
        return "shorter than the 60 s check window"
    return None


def steady_bpm(beats: Sequence[float]) -> float | None:
    """60 over the mean of the gaps within 12 percent of the median gap, or None."""
    if len(beats) < MIN_BEATS:
        return None
    gaps = np.diff(np.asarray(beats, dtype=np.float64))
    gaps = gaps[gaps > 0]
    if not len(gaps):
        return None
    median = float(np.median(gaps))
    steady = gaps[np.abs(gaps - median) <= STEADY_TOLERANCE * median]
    if len(steady) < MIN_STEADY_GAPS:
        return None
    return round(60.0 / float(steady.mean()), 2)


def window_rms(samples: Samples) -> float:
    """Mean over frames of 2,048 samples, hop 512, of each frame's RMS. A window shorter than
    one frame is one frame."""
    values = np.asarray(samples, dtype=np.float64)
    if len(values) == 0:
        raise ValueError("an empty window has no RMS")
    if len(values) <= FRAME:
        return float(np.sqrt(np.mean(values**2)))
    # Frame sums of squares from a running total, so a 60 s window costs one pass.
    total = np.concatenate(([0.0], np.cumsum(values**2)))
    starts = np.arange(0, len(values) - FRAME + 1, HOP)
    sums = total[starts + FRAME] - total[starts]
    return float(np.mean(np.sqrt(np.maximum(sums, 0.0) / FRAME)))


@dataclass(frozen=True)
class Reading:
    bpm: float | None
    sure: bool
    why: str


def reading(sections: Sequence[float | None], long: float | None) -> Reading:
    """The song's BPM from its section BPMs, and whether it is sure enough to keep."""
    found = [bpm for bpm in sections if bpm is not None]
    bpm = round(float(statistics.median(found)), 2) if found else None
    if len(found) < MIN_SURE_SECTIONS:
        return Reading(bpm, False, f"{len(found)} section{'' if len(found) == 1 else 's'}")
    assert bpm is not None
    if long is None:
        return Reading(bpm, False, "no 60 s reading")
    if abs(bpm - long) > AGREE_BPM:
        return Reading(bpm, False, "sections and 60 s disagree")
    if bpm > MAX_SURE_BPM:
        return Reading(bpm, False, "over 200 BPM")
    return Reading(bpm, True, "")


@dataclass
class Decoded:
    """A song whose windows are decoded and waiting for the model."""

    job: Job
    size: int
    mtime_ns: int
    windows: list[Window]
    audio: dict[str, Samples] = field(default_factory=dict)
    problems: list[str] = field(default_factory=list)


def _decode(path: Path, start: float, seconds: float) -> Samples:
    return decode_section(path, start, seconds=seconds)


def prepare(job: Job, roots: Sequence[Path], decode: WindowDecoder = _decode) -> Result | Decoded:
    """Everything before the model: the recipe, the skips, the file and the four windows.
    A Result is final (skipped or failed); a Decoded goes to `finish`. Never raises for a
    bad file."""
    if job.recipe != RECIPE:
        return _failed(job, f"this worker measures {RECIPE}, not {job.recipe}")
    reason = beat_skip_reason(job)
    if reason is not None:
        return Result(
            job.song_id,
            job.recipe,
            job.lease_token,
            job.size,
            job.mtime_ns,
            "skipped",
            detail=reason,
        )
    checked = checked_file(job, roots)
    if isinstance(checked, Result):
        return checked
    path, size, mtime_ns = checked
    if not math.isfinite(job.duration) or job.duration <= 0:
        return _failed(job, "the file has no known length", size, mtime_ns)
    decoded = Decoded(job, size, mtime_ns, windows(job.duration))
    for window in decoded.windows:
        try:
            decoded.audio[window.name] = decode(path, window.start, window.seconds)
        except DecodeError as exc:
            decoded.problems.append(str(exc))
    return decoded


def finish(decoded: Decoded, track: Tracker) -> Result:
    """Run the model on the decoded windows and build the row."""
    job = decoded.job
    if not decoded.audio:
        problem = decoded.problems[0] if decoded.problems else "nothing decoded"
        return _failed(job, f"no window decoded: {problem}", decoded.size, decoded.mtime_ns)
    bpms: dict[str, float | None] = {}
    energies: list[float] = []
    for window in decoded.windows:
        samples = decoded.audio.get(window.name)
        if samples is None:
            continue
        try:
            beats = track(samples)
        except Exception as exc:  # noqa: BLE001 - a model failure is a failed row, retried
            # Not an unsure row: the reading did not happen, so the song is tried again.
            return _failed(
                job,
                f"beat tracker failed at {window.start:.1f} s: {type(exc).__name__}: {exc}",
                decoded.size,
                decoded.mtime_ns,
            )
        bpms[window.name] = steady_bpm(beats)
        rms = window_rms(samples)
        if math.isfinite(rms) and rms >= 0:
            energies.append(rms)
    if not energies:
        return _failed(job, "no window gave a finite RMS", decoded.size, decoded.mtime_ns)
    sections = [w for w in decoded.windows if w.name != LONG]
    long = next(w for w in decoded.windows if w.name == LONG)
    read = reading([bpms.get(w.name) for w in sections], bpms.get(LONG))
    detail = json.dumps(
        {
            "bpm": read.bpm,
            "sure": read.sure,
            "long": bpms.get(LONG),
            "sections": [[w.start, bpms.get(w.name)] for w in sections],
            "long_start": long.start,
            "why": read.why or (decoded.problems[0][:120] if decoded.problems else ""),
        },
        separators=(",", ":"),
    )
    return Result(
        job.song_id,
        job.recipe,
        job.lease_token,
        decoded.size,
        decoded.mtime_ns,
        "done",
        tempo_bpm=read.bpm if read.sure else None,
        energy=float(max(energies)),
        detail=detail,
    )


def analyse(
    job: Job, roots: Sequence[Path], track: Tracker, decode: WindowDecoder = _decode
) -> Result:
    """One song from lease to result, in one thread. The pipeline splits it in two."""
    prepared = prepare(job, roots, decode)
    return prepared if isinstance(prepared, Result) else finish(prepared, track)


def _failed(job: Job, detail: str, size: int | None = None, mtime_ns: int | None = None) -> Result:
    return Result(
        job.song_id,
        job.recipe,
        job.lease_token,
        job.size if size is None else size,
        job.mtime_ns if mtime_ns is None else mtime_ns,
        "failed",
        detail=detail,
    )
