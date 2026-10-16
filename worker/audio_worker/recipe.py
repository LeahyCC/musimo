"""`tempo-energy-v1`: tempo in BPM and energy as linear RMS, from three 10-second sections.

The sections start at 10, 50 and 90 percent of `duration - 10` seconds. FFmpeg seeks to each
and decodes 10 seconds of mono float32 at 22,050 Hz; librosa never opens the file. A section
more than 100 ms short is rejected. Tempo is the median of the section estimates that
succeeded, where a section with no onsets gives no estimate rather than the estimator's prior.
Energy is the mean over the accepted sections of the mean frame RMS. A done row needs both;
anything else is failed with the reason in `detail`. No BPM is invented for a file under 10
seconds. A podcast or spoken-word genre is skipped without decoding.

Changing any of this is a new recipe id.
"""

import math
import statistics
import subprocess
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path

import numpy as np

RECIPE = "tempo-energy-v1"
SAMPLE_RATE = 22050
SECTION_SECONDS = 10.0
# Codec end padding can leave a section a little short; more than this is a bad seek.
SHORT_TOLERANCE = 0.1
DECODE_DEADLINE = 30.0
SECTION_FRACTIONS = (0.1, 0.5, 0.9)
SKIPPED_GENRES = frozenset({"podcast", "podcasts", "spoken word"})
# The MOV demuxer family. Fragmented files with attached pictures seek wrongly per stream.
INDIVIDUAL_SEEK_OFF = frozenset({".m4a", ".m4b", ".mp4", ".mov"})

Samples = np.ndarray
Decoder = Callable[[Path, float], Samples]
# Tempo in BPM, or None when the section gives no estimate, and the section's RMS.
Measurer = Callable[[Samples], tuple[float | None, float]]


class DecodeError(Exception):
    pass


@dataclass(frozen=True)
class Job:
    song_id: str
    recipe: str
    lease_token: str
    path: str
    size: int
    mtime_ns: int
    duration: float
    genre: str
    genres: tuple[str, ...]


@dataclass(frozen=True)
class Result:
    song_id: str
    recipe: str
    lease_token: str
    size: int
    mtime_ns: int
    status: str
    tempo_bpm: float | None = None
    energy: float | None = None
    detail: str = ""

    def payload(self) -> dict[str, object]:
        return {
            "song_id": self.song_id,
            "recipe": self.recipe,
            "lease_token": self.lease_token,
            "size": self.size,
            "mtime_ns": self.mtime_ns,
            "status": self.status,
            "tempo_bpm": self.tempo_bpm,
            "energy": self.energy,
            "dim": 0,
            "vector": None,
            "detail": self.detail[:400],
        }


def job_from(payload: object) -> Job:
    """The job the lease returned, with every field checked before it is used."""
    if not isinstance(payload, dict):
        raise ValueError("lease is not an object")
    genres = payload.get("genres", [])
    if not isinstance(genres, list) or not all(isinstance(genre, str) for genre in genres):
        raise ValueError("genres is not a list of strings")
    try:
        return Job(
            song_id=_text(payload, "song_id"),
            recipe=_text(payload, "recipe"),
            lease_token=_text(payload, "lease_token"),
            path=_text(payload, "path"),
            size=int(payload["size"]),
            mtime_ns=int(payload["mtime_ns"]),
            duration=float(payload["duration"]),
            genre=str(payload.get("genre", "")),
            genres=tuple(genres),
        )
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError(f"lease is missing or mistypes a field: {exc}") from exc


def _text(payload: dict[object, object], key: str) -> str:
    value = payload[key]
    if not isinstance(value, str) or not value:
        raise ValueError(f"{key} is not text")
    return value


def skip_reason(genre: str, genres: Sequence[str]) -> str | None:
    """Speech has no musical tempo. The genre tag decides, before any decoding."""
    words = {genre.casefold().strip(), *(item.casefold().strip() for item in genres)}
    if words & SKIPPED_GENRES:
        return "spoken-word genre"
    return None


def section_starts(duration: float) -> list[float] | None:
    """Three starts across the span, or None when the file cannot hold a section."""
    if not math.isfinite(duration) or duration < SECTION_SECONDS:
        return None
    span = duration - SECTION_SECONDS
    return [round(span * fraction, 3) for fraction in SECTION_FRACTIONS]


def decode_command(path: Path, start: float, seconds: float = SECTION_SECONDS) -> list[str]:
    command = ["ffmpeg", "-v", "error", "-nostdin", "-threads", "1"]
    if path.suffix.casefold() in INDIVIDUAL_SEEK_OFF:
        command += ["-seek_streams_individually", "0"]
    command += ["-ss", f"{start:.3f}", "-i", str(path), "-t", f"{seconds:.3f}"]
    command += ["-vn", "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "f32le", "-"]
    return command


def decode_section(path: Path, start: float, deadline: float = DECODE_DEADLINE) -> Samples:
    """`SECTION_SECONDS` of mono float32 from `start`, or DecodeError."""
    try:
        done = subprocess.run(
            decode_command(path, start),
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=deadline,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise DecodeError(f"decoder exceeded {deadline:.0f} s at {start:.1f} s") from exc
    except OSError as exc:
        raise DecodeError(f"ffmpeg could not be started: {exc}") from exc
    if done.returncode != 0:
        raise DecodeError(f"ffmpeg exited {done.returncode} at {start:.1f} s")
    whole = len(done.stdout) - len(done.stdout) % 4
    samples = np.frombuffer(done.stdout[:whole], dtype="<f4")
    needed = int((SECTION_SECONDS - SHORT_TOLERANCE) * SAMPLE_RATE)
    if len(samples) < needed:
        raise DecodeError(
            f"section at {start:.1f} s is {len(samples) / SAMPLE_RATE:.2f} s, more than "
            f"{SHORT_TOLERANCE * 1000:.0f} ms short"
        )
    return samples[: int(SECTION_SECONDS * SAMPLE_RATE)].astype(np.float32)


def measure_section(samples: Samples) -> tuple[float | None, float]:
    """Tempo and RMS of one section. Imports librosa here, so only the worker image needs it."""
    import librosa
    from librosa.feature.rhythm import tempo

    rms = float(np.mean(librosa.feature.rms(y=samples)))
    onsets = librosa.onset.onset_strength(y=samples, sr=SAMPLE_RATE)
    if not np.any(onsets > 0):
        return None, rms
    estimate = float(np.asarray(tempo(onset_envelope=onsets, sr=SAMPLE_RATE)).reshape(-1)[0])
    if not math.isfinite(estimate) or estimate <= 0:
        return None, rms
    return estimate, rms


def inside(path: Path, roots: Sequence[Path]) -> bool:
    """Whether the path the app named is under a music mount, without following links."""
    try:
        if path.is_symlink():
            return False
        resolved = path.resolve(strict=True)
    except OSError:
        return False
    return any(resolved.is_relative_to(root.resolve()) for root in roots)


def analyse(
    job: Job,
    roots: Sequence[Path],
    decode: Decoder = decode_section,
    measure: Measurer = measure_section,
) -> Result:
    """The result for one leased song. Never raises for a bad file; that is a failed result."""
    if job.recipe != RECIPE:
        return _failed(job, f"this worker measures {RECIPE}, not {job.recipe}")
    reason = skip_reason(job.genre, job.genres)
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
    path = Path(job.path)
    try:
        stat = path.stat()
    except OSError as exc:
        return _failed(job, f"cannot read the file: {exc.strerror or exc}")
    if not inside(path, roots):
        return _failed(job, "the path is not under the music mount")
    size, mtime_ns = stat.st_size, stat.st_mtime_ns
    starts = section_starts(job.duration)
    if starts is None:
        return _failed(job, "shorter than 10 seconds", size, mtime_ns)
    energies: list[float] = []
    tempos: list[float] = []
    problems: list[str] = []
    decoded: dict[float, Samples] = {}
    for start in starts:
        try:
            if start not in decoded:
                decoded[start] = decode(path, start)
        except DecodeError as exc:
            problems.append(str(exc))
            continue
        bpm, rms = measure(decoded[start])
        energies.append(rms)
        if bpm is not None:
            tempos.append(bpm)
    if not energies:
        return _failed(job, f"no section decoded: {problems[0]}", size, mtime_ns)
    if not tempos:
        return _failed(job, "no section gave a tempo estimate", size, mtime_ns)
    detail = f"{len(energies)} of {len(starts)} sections, {len(tempos)} tempo estimates"
    if problems:
        detail += f"; {problems[0]}"
    return Result(
        job.song_id,
        job.recipe,
        job.lease_token,
        size,
        mtime_ns,
        "done",
        tempo_bpm=float(statistics.median(tempos)),
        energy=float(statistics.fmean(energies)),
        detail=detail,
    )


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
