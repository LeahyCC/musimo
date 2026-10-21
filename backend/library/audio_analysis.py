"""The Song analysis page: worker status, measuring runs and the listen groups.

The page always works on `tempo-beat-v1` (BEAT_RECIPE). Counts are of the library as it is
now, so a row measured from an older copy of a file does not count. What the worker says about
itself (device, card, decoders, caps) comes with each lease call and is kept in memory only, as
is the start of the run the page last began, for its progress bar. See the "Song analysis page"
section of docs/audio-profile-spec.md.
"""

import json
import math
import threading
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from backend.core.audio_recipes import BEAT_RECIPE
from backend.core.store import Store
from backend.library.audio_profile import (
    AudioProfiles,
    energy_band,
    percentile_bands,
)

# A worker that has not asked for work in this long is not running. An idle one asks every 15 s.
SEEN_SECONDS = 60.0
# Rows written closer together than this belong to the same run, for the measured rate.
RUN_GAP_SECONDS = 120.0
# Fewer rows than this in the last run is too few to call a rate.
MIN_RUN_ROWS = 10
# Seconds a song before this machine has measured its own: the graphics card from the 20 October
# trial on this library (four runs, 0.39 to 0.99 s with 1 to 8 decoders, about 0.6 typical), the
# CPU from the bake-off (one core, one decoder).
TRIAL_SECONDS = {"cuda": 0.6, "cpu": 5.6}
DEVICES = ("cuda", "cpu")
GROUP_SIZE = 10
AMBIGUOUS_SIZE = 20
# Under 100 BPM with high energy, or over 160 with low, is a likely half or double reading.
SLOW_BUT_LOUD = 100.0
FAST_BUT_QUIET = 160.0


class WorkerInfo(BaseModel):
    """What a `tempo-beat-v1` worker sends about itself with a lease. All optional, so the
    `tempo-energy-v1` worker, which sends none, still leases."""

    model_config = ConfigDict(extra="forbid", strict=True)

    version: str = Field(default="", max_length=40)
    device: Literal["cuda", "cpu", ""] = ""
    gpu: str = Field(default="", max_length=120)
    decoders: int = Field(default=1, ge=1, le=64)
    memory_limit: int | None = Field(default=None, ge=0)
    cpus: float | None = Field(default=None, ge=0, le=1024)
    note: str = Field(default="", max_length=200)


@dataclass(frozen=True)
class Batch:
    kind: Literal["sample", "all"]
    total: int
    started_at: str


def _stamp(moment: datetime) -> str:
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _parse(stamp: str) -> datetime | None:
    try:
        return datetime.strptime(stamp, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=UTC)
    except ValueError:
        return None


def run_rate(stamps: list[datetime], now: datetime) -> tuple[float | None, int, bool]:
    """Songs a second over the most recent run of writes, how many rows that run holds, and
    whether it is still going. `stamps` is newest first. A run ends at the first gap of
    RUN_GAP_SECONDS; fewer than MIN_RUN_ROWS rows gives no rate."""
    if not stamps:
        return None, 0, False
    run = [stamps[0]]
    for stamp in stamps[1:]:
        if (run[-1] - stamp).total_seconds() > RUN_GAP_SECONDS:
            break
        run.append(stamp)
    going = (now - stamps[0]).total_seconds() <= RUN_GAP_SECONDS
    span = (run[0] - run[-1]).total_seconds()
    if len(run) < MIN_RUN_ROWS or span <= 0:
        return None, len(run), going
    return (len(run) - 1) / span, len(run), going


def _reading(detail: str) -> dict[str, object]:
    """The JSON `tempo-beat-v1` keeps in `detail`, or {} for anything else."""
    try:
        value = json.loads(detail)
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


def _number(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    number = float(value)
    return number if math.isfinite(number) else None


class AudioAnalysis:
    def __init__(self, store: Store, profiles: AudioProfiles, token_configured: bool) -> None:
        self.store = store
        self.profiles = profiles
        self.token_configured = token_configured
        self.recipe = BEAT_RECIPE
        self._lock = threading.Lock()
        self._worker: tuple[WorkerInfo, datetime] | None = None
        self._batch: Batch | None = None

    def seen(self, recipe: str, info: WorkerInfo | None, now: datetime | None = None) -> None:
        """A worker for the page's recipe asked for work. Other recipes are not shown."""
        if recipe != self.recipe:
            return
        with self._lock:
            self._worker = (info or WorkerInfo(), now or datetime.now(UTC))

    def paused(self) -> bool:
        return self.store.current().audio_analysis_paused

    def counts(self) -> dict[str, int]:
        with self.store.lock:
            row = self.store.db.execute(
                """
                SELECT count(*) AS library,
                    coalesce(sum(p.status = 'done' AND p.tempo_bpm IS NOT NULL), 0) AS done,
                    coalesce(sum(p.status = 'done' AND p.tempo_bpm IS NULL), 0) AS unsure,
                    coalesce(sum(p.status = 'skipped'), 0) AS skipped,
                    coalesce(sum(p.status = 'failed'), 0) AS failed
                FROM library_files f
                JOIN library_roots r ON r.path = f.root AND r.enabled = 1
                LEFT JOIN audio_profile p ON p.song_id = f.song_id AND p.recipe = ?
                    AND p.size = f.size AND p.mtime_ns = f.mtime_ns
                WHERE f.song_id != ''
                """,
                (self.recipe,),
            ).fetchone()
            queue = dict(
                self.store.db.execute(
                    "SELECT status, count(*) FROM audio_job WHERE recipe = ? GROUP BY status",
                    (self.recipe,),
                ).fetchall()
            )
        counts = {key: int(row[key]) for key in ("library", "done", "unsure", "skipped", "failed")}
        counts["waiting"] = int(queue.get("queued", 0))
        counts["leased"] = int(queue.get("leased", 0))
        counts["lacking"] = self.profiles.lacking(self.recipe)
        return counts

    def status(self, now: datetime | None = None) -> dict[str, object]:
        moment = now or datetime.now(UTC)
        settings = self.store.current()
        counts = self.counts()
        with self.store.lock:
            rows = self.store.db.execute(
                "SELECT updated_at, detail FROM audio_profile WHERE recipe = ? "
                "ORDER BY updated_at DESC LIMIT 2000",
                (self.recipe,),
            ).fetchall()
        written = [
            (stamp, str(_reading(str(row[1])).get("device", "")))
            for row in rows
            if (stamp := _parse(str(row[0]))) is not None
        ]
        rate, run_rows, going = run_rate([stamp for stamp, _ in written], moment)
        # Each device's own last run, so a CPU run never sets the graphics card's estimate.
        measured = {
            name: run_rate([stamp for stamp, on in written if on == name], moment)[0]
            for name in DEVICES
        }
        with self._lock:
            worker = self._worker
            batch = self._batch
        worker_out: dict[str, object] | None = None
        # The device in use: the worker's, else the one that measured last, else the CPU.
        device = next((on for _, on in written if on in DEVICES), "cpu")
        if worker is not None:
            info, at = worker
            ago = max(0.0, (moment - at).total_seconds())
            device = info.device or device
            worker_out = info.model_dump() | {
                "seen_at": _stamp(at),
                "seconds_ago": round(ago, 1),
                "running": ago <= SEEN_SECONDS,
            }
        left = counts["waiting"] + counts["leased"]
        devices: dict[str, dict[str, object]] = {}
        for name in DEVICES:
            speed = measured[name]
            per_song = 1 / speed if speed else TRIAL_SECONDS[name]
            devices[name] = {
                "seconds_per_song": round(per_song, 3),
                "source": "measured" if speed else "trial",
                "whole_library_seconds": round(counts["lacking"] * per_song),
            }
        progress: dict[str, object] | None = None
        if batch is not None:
            with self.store.lock:
                written = self.store.db.execute(
                    "SELECT count(*) FROM audio_profile WHERE recipe = ? AND updated_at >= ?",
                    (self.recipe, batch.started_at),
                ).fetchone()[0]
            progress = {
                "kind": batch.kind,
                "total": batch.total,
                "measured": min(int(written), batch.total),
                "started_at": batch.started_at,
            }
        return {
            "recipe": self.recipe,
            "active": settings.audio_scalar_recipe == self.recipe,
            "active_recipe": settings.audio_scalar_recipe,
            "paused": settings.audio_analysis_paused,
            "energy": settings.audio_energy,
            "token_configured": self.token_configured,
            "worker": worker_out,
            "counts": counts,
            "rate": {
                "songs_per_minute": None if rate is None else round(rate * 60, 1),
                "run_songs": run_rows,
                "running": going,
            },
            "eta_seconds": round(left / rate) if rate is not None and left else None,
            "estimate": {
                "device": device,
                "lacking": counts["lacking"],
                **devices[device],
                "devices": devices,
            },
            "batch": progress,
        }

    def _start(self, kind: Literal["sample", "all"]) -> None:
        """Progress from now: every song waiting is part of this run, whoever queued it."""
        total = self.profiles.queued(self.recipe)
        with self._lock:
            self._batch = Batch(kind, total, _stamp(datetime.now(UTC)))

    def sample(self) -> dict[str, object]:
        added = self.profiles.enqueue_sample(self.recipe)
        self._start("sample")
        return {"queued": added, "waiting": self.profiles.queued(self.recipe)}

    def measure_all(self, confirm: bool) -> dict[str, object]:
        lacking = self.profiles.lacking(self.recipe)
        if not confirm:
            return {
                "queued": 0,
                "lacking": lacking,
                "needs_confirmation": True,
                "waiting": self.profiles.queued(self.recipe),
            }
        added = self.profiles.enqueue(self.recipe, None)
        self._start("all")
        return {
            "queued": added,
            "lacking": self.profiles.lacking(self.recipe),
            "needs_confirmation": False,
            "waiting": self.profiles.queued(self.recipe),
        }

    def listen(self) -> dict[str, object]:
        """The page's listen groups, from the fresh done rows."""
        with self.store.lock:
            rows = self.store.db.execute(
                """
                SELECT f.song_id, f.title, f.artist, f.album, f.duration, f.added_at,
                    p.tempo_bpm, p.energy, p.detail
                FROM library_files f
                JOIN library_roots r ON r.path = f.root AND r.enabled = 1
                JOIN audio_profile p ON p.song_id = f.song_id AND p.recipe = ?
                    AND p.size = f.size AND p.mtime_ns = f.mtime_ns AND p.status = 'done'
                WHERE f.song_id != '' AND p.energy IS NOT NULL
                """,
                (self.recipe,),
            ).fetchall()
        bands = percentile_bands(float(row["energy"]) for row in rows)
        songs: list[dict[str, object]] = []
        for row in rows:
            reading = _reading(str(row["detail"]))
            sections = reading.get("sections")
            starts = [
                start
                for item in (sections if isinstance(sections, list) else [])
                if isinstance(item, list) and item and (start := _number(item[0])) is not None
            ]
            energy = float(row["energy"])
            songs.append(
                {
                    "id": str(row["song_id"]),
                    "title": str(row["title"]),
                    "artist": str(row["artist"]),
                    "album": str(row["album"]),
                    "duration": _number(row["duration"]),
                    "added_at": str(row["added_at"]),
                    "bpm": None if row["tempo_bpm"] is None else float(row["tempo_bpm"]),
                    "reading": _number(reading.get("bpm")),
                    "check": _number(reading.get("long")),
                    "sure": row["tempo_bpm"] is not None,
                    "why": str(reading.get("why", ""))[:120],
                    "energy": energy,
                    "band": energy_band(energy, bands) if bands is not None else None,
                    "sections": starts,
                }
            )
        sure = [song for song in songs if song["bpm"] is not None]

        def bpm(song: dict[str, object]) -> float:
            value = song["bpm"]
            return float(value) if isinstance(value, float) else 0.0

        def loud(song: dict[str, object]) -> float:
            value = song["energy"]
            return float(value) if isinstance(value, float) else 0.0

        def newest(song: dict[str, object]) -> str:
            return str(song["added_at"])

        def odd(song: dict[str, object]) -> bool:
            if not song["sure"]:
                return True
            value = bpm(song)
            return (value < SLOW_BUT_LOUD and song["band"] == "high") or (
                value > FAST_BUT_QUIET and song["band"] == "low"
            )

        ambiguous = sorted((song for song in songs if odd(song)), key=newest, reverse=True)
        # Unsure songs first, then the likely half and double readings, newest first in each.
        ambiguous.sort(key=lambda song: bool(song["sure"]))
        return {
            "recipe": self.recipe,
            "bands": None if bands is None else {"low_below": bands[0], "high_from": bands[1]},
            "measured": len(songs),
            "groups": {
                "fastest": sorted(sure, key=bpm, reverse=True)[:GROUP_SIZE],
                "slowest": sorted(sure, key=bpm)[:GROUP_SIZE],
                "loudest": sorted(songs, key=loud, reverse=True)[:GROUP_SIZE],
                "quietest": sorted(songs, key=loud)[:GROUP_SIZE],
                "ambiguous": ambiguous[:AMBIGUOUS_SIZE],
            },
            "ambiguous_total": len(ambiguous),
        }
