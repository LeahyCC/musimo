"""Shared bits for the bake-off runners: windows, FFmpeg decoding, limits, output.

Windows match tempo-energy-v1: three 10 s sections at 10, 50 and 90 percent of
`duration - 10`, plus one 60 s window centred on the middle of the song. Decoding copies the
worker's rules (FFmpeg seeks, M4A seeks streams together, 30 s deadline, one thread, a
section more than 100 ms short is rejected).
"""

import json
import os
import resource
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

SECTION_SECONDS = 10.0
LONG_SECONDS = 60.0
SECTION_FRACTIONS = (0.1, 0.5, 0.9)
SHORT_TOLERANCE = 0.1
DECODE_DEADLINE = 30.0
INDIVIDUAL_SEEK_OFF = frozenset({".m4a", ".m4b", ".mp4", ".mov"})
CGROUP = Path("/sys/fs/cgroup")


class DecodeError(Exception):
    pass


def windows(duration: float) -> dict[str, tuple[float, float]]:
    """Name -> (start, seconds). Empty when the file is under 10 s."""
    if not duration or duration < SECTION_SECONDS:
        return {}
    span = duration - SECTION_SECONDS
    out = {f"s{int(f * 100)}": (round(span * f, 3), SECTION_SECONDS) for f in SECTION_FRACTIONS}
    length = min(LONG_SECONDS, duration)
    out["long60"] = (round(max(0.0, duration / 2 - length / 2), 3), length)
    return out


def decode(path: str, start: float, seconds: float, rate: int) -> np.ndarray:
    command = ["ffmpeg", "-v", "error", "-nostdin", "-threads", "1"]
    if Path(path).suffix.casefold() in INDIVIDUAL_SEEK_OFF:
        command += ["-seek_streams_individually", "0"]
    command += ["-ss", f"{start:.3f}", "-i", path, "-t", f"{seconds:.3f}"]
    command += ["-vn", "-ac", "1", "-ar", str(rate), "-f", "f32le", "-"]
    try:
        done = subprocess.run(
            command, stdin=subprocess.DEVNULL, capture_output=True, timeout=DECODE_DEADLINE
        )
    except subprocess.TimeoutExpired as exc:
        raise DecodeError(f"decoder exceeded {DECODE_DEADLINE:.0f} s at {start:.1f} s") from exc
    if done.returncode != 0:
        raise DecodeError(f"ffmpeg exited {done.returncode} at {start:.1f} s")
    whole = len(done.stdout) - len(done.stdout) % 4
    samples = np.frombuffer(done.stdout[:whole], dtype="<f4")
    if len(samples) < int((seconds - SHORT_TOLERANCE) * rate):
        raise DecodeError(f"window at {start:.1f} s is {len(samples) / rate:.2f} s, too short")
    return np.ascontiguousarray(samples[: int(seconds * rate)], dtype=np.float32)


def read_int(name: str) -> int | None:
    try:
        text = (CGROUP / name).read_text().split()[0]
    except (OSError, IndexError):
        return None
    return int(text) if text.isdigit() else None


def limits() -> dict:
    """The kernel's view of the caps. Refuse to run uncapped."""
    try:
        cpu = (CGROUP / "cpu.max").read_text().strip()
    except OSError:
        cpu = None
    found = {
        "memory.max": read_int("memory.max"),
        "memory.swap.max": read_int("memory.swap.max"),
        "cpu.max": cpu,
        "root_read_only": not os.access("/", os.W_OK),
        "music_read_only": not os.access("/music", os.W_OK),
        "models_read_only": not os.access("/models", os.W_OK),
        "uid": os.getuid(),
    }
    ok = (
        found["memory.max"] is not None
        and found["memory.max"] <= 2 * 1024**3
        and found["memory.swap.max"] == 0
        and cpu == "100000 100000"
        and found["root_read_only"]
        and found["music_read_only"]
        and found["models_read_only"]
        and found["uid"] == 1000
    )
    if not ok:
        sys.exit(f"refusing to run, limits not as required: {found}")
    return found


def memory() -> dict:
    usage = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024
    children = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss * 1024
    return {
        "cgroup_peak": read_int("memory.peak"),
        "cgroup_current": read_int("memory.current"),
        "python_maxrss": usage,
        "ffmpeg_maxrss": children,
    }


def write_json(path: Path, data: dict) -> None:
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    temp.replace(path)


def load_sample(key: str) -> tuple[list[str], dict]:
    sample = json.loads(Path("/sample.json").read_text(encoding="utf-8"))
    return sample[key], sample["songs"]


class Clock:
    def __init__(self) -> None:
        self.start = time.perf_counter()

    def seconds(self) -> float:
        return round(time.perf_counter() - self.start, 4)
