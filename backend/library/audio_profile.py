"""Song characteristics: the rows the audio worker writes, and the scores the bot ranks by.

The worker measures. This module leases it work, checks and stores what it sends back, says
which rows are fresh, works out the energy bands, and scores cosine. No librosa here. See
docs/audio-profile-spec.md for the contract.
"""

import base64
import binascii
import json
import secrets
import sqlite3
import threading
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Literal, Protocol

import numpy as np
from numpy.typing import NDArray
from pydantic import BaseModel, ConfigDict, Field, model_validator

from backend.core.audio_recipes import Recipe, recipe_for, text_encoder
from backend.core.store import Store

LEASE_SECONDS = 180
# A song whose lease lapses or whose analysis fails this many times is written as failed.
MAX_ATTEMPTS = 3
ProfileStatus = Literal["done", "failed", "skipped"]
Vector = NDArray[np.float32]

# Tempo bands in beats per minute. Medium runs from the slow edge up to, not including, fast.
SLOW_BELOW = 90.0
FAST_FROM = 140.0
# A single named BPM is a hard window this wide on each side.
BPM_WINDOW = 10.0


class LeaseError(Exception):
    def __init__(self, detail: str, status: int = 409):
        self.detail = detail
        self.status = status


class WorkerResult(BaseModel):
    """What the worker sends back for one lease. The service rechecks it against the lease."""

    model_config = ConfigDict(extra="forbid", strict=True)

    song_id: str = Field(pattern=r"^tr-[0-9a-f]{16}$")
    recipe: str = Field(min_length=1, max_length=80)
    lease_token: str = Field(min_length=1, max_length=200)
    # The file as the worker saw it. A mismatch with the index rejects the result.
    size: int = Field(ge=0)
    mtime_ns: int
    status: ProfileStatus
    tempo_bpm: float | None = None
    energy: float | None = None
    dim: int = Field(default=0, ge=0, le=4096)
    # Little-endian float32 values, base64. Null for a scalar recipe and for any row not done.
    vector: str | None = Field(default=None, max_length=32768)
    detail: str = Field(default="", max_length=400)

    @model_validator(mode="after")
    def shape(self) -> "WorkerResult":
        measured = self.tempo_bpm is not None or self.energy is not None or self.dim or self.vector
        if self.status != "done" and measured:
            raise ValueError("A failed or skipped result carries no measurements")
        if self.tempo_bpm is not None and not 0 < self.tempo_bpm < 1000:
            raise ValueError("tempo_bpm is outside the range a song can have")
        if self.energy is not None and not self.energy >= 0:
            raise ValueError("energy is a linear amplitude, never negative")
        if (self.vector is None) != (self.dim == 0):
            raise ValueError("dim and vector go together")
        return self

    def vector_bytes(self) -> bytes | None:
        if self.vector is None:
            return None
        try:
            return base64.b64decode(self.vector, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise LeaseError("vector is not base64", 422) from exc


class FileIdentity(Protocol):
    """A library song as the freshness check sees it. `StoredSong` is one."""

    @property
    def song_id(self) -> str: ...

    @property
    def size(self) -> int: ...

    @property
    def mtime_ns(self) -> int: ...


@dataclass(frozen=True)
class Profile:
    song_id: str
    status: str
    size: int
    mtime_ns: int
    tempo_bpm: float | None
    energy: float | None
    dim: int
    # Bytes stored, so a reader can tell a vector of the wrong length without decoding it.
    vector_length: int
    detail: str


@dataclass(frozen=True, eq=False)
class ProfileSet:
    """Every row of one recipe, with the usable vectors stacked for scoring."""

    recipe: Recipe
    rows: dict[str, Profile]
    # Song ids in matrix order. Only done rows whose vector has the recipe's length are here.
    ids: list[str]
    index: dict[str, int]
    matrix: Vector | None

    def fresh(self, song: FileIdentity) -> Profile | None:
        """The done row for this file, if it was measured from the file as it is now."""
        row = self.rows.get(song.song_id)
        if (
            row is None
            or row.status != "done"
            or row.size != song.size
            or row.mtime_ns != song.mtime_ns
        ):
            return None
        if self.recipe.kind == "embedding" and song.song_id not in self.index:
            return None
        # A scalar row carries no vector. One with bytes anyway is malformed, like a wrong length.
        if self.recipe.kind == "scalar" and (row.dim or row.vector_length):
            return None
        return row

    def vector(self, song_id: str) -> Vector | None:
        position = self.index.get(song_id)
        if position is None or self.matrix is None:
            return None
        row: Vector = self.matrix[position]
        return row

    def cosine(self, seed: Vector) -> dict[str, float]:
        """Cosine of every usable vector against a unit seed, keyed by song id."""
        if self.matrix is None:
            return {}
        scores = self.matrix @ seed
        return dict(zip(self.ids, scores.tolist(), strict=True))

    def coverage(self, songs: Iterable[FileIdentity]) -> tuple[int, int]:
        """How many of these songs have a fresh row, out of how many there are."""
        total = 0
        done = 0
        for song in songs:
            total += 1
            if self.fresh(song) is not None:
                done += 1
        return done, total


def unit(values: NDArray[np.floating[Any]]) -> Vector | None:
    """The same direction at length one, or None for a zero vector, which has no direction."""
    vector = np.asarray(values, dtype=np.float32)
    norm = float(np.linalg.norm(vector))
    if not np.isfinite(norm) or norm == 0.0:
        return None
    scaled: Vector = (vector / norm).astype(np.float32)
    return scaled


def encode_phrase(recipe: Recipe, phrase: str) -> Vector | None:
    """The unit vector a text-aligned recipe gives a phrase, or None when it cannot."""
    encoder = text_encoder(recipe.id)
    if encoder is None or not recipe.text_aligned:
        return None
    values = np.asarray(encoder(phrase), dtype=np.float32)
    if values.shape != (recipe.dim,):
        return None
    return unit(values)


def percentile_bands(energies: Iterable[float]) -> tuple[float, float] | None:
    """The 33rd and 66th percentile values, from the sorted list, without interpolation."""
    values = sorted(energies)
    if not values:
        return None
    last = len(values) - 1
    return values[int(0.33 * last)], values[int(0.66 * last)]


def energy_band(energy: float, bands: tuple[float, float]) -> Literal["low", "medium", "high"]:
    """Low is below the 33rd percentile, medium up to but not including the 66th, high above."""
    low, high = bands
    if energy < low:
        return "low"
    if energy < high:
        return "medium"
    return "high"


def tempo_band(bpm: float) -> Literal["slow", "medium", "fast"]:
    if bpm < SLOW_BELOW:
        return "slow"
    if bpm < FAST_FROM:
        return "medium"
    return "fast"


def _stamp(moment: datetime) -> str:
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _strings(raw: object) -> list[str]:
    try:
        values = json.loads(str(raw))
    except ValueError:
        return []
    return [value for value in values if isinstance(value, str)] if isinstance(values, list) else []


class AudioProfiles:
    """Reads and writes `audio_profile`, and runs the `audio_job` queue the worker leases from.

    The rows of a recipe are loaded once and kept until a result is stored or the library
    changes, so a bot request does not read every vector again.
    """

    def __init__(self, store: Store) -> None:
        self.store = store
        # Bumped on every write, so a cached ProfileSet knows it is behind.
        self.generation = 0
        self._cache: dict[str, tuple[int, int, ProfileSet]] = {}
        self._lock = threading.Lock()

    def profiles(self, recipe: Recipe) -> ProfileSet:
        revision = self.store.library_revision()
        with self._lock:
            cached = self._cache.get(recipe.id)
            if cached is not None and cached[0] == self.generation and cached[1] == revision:
                return cached[2]
            generation = self.generation
        built = self._load(recipe)
        with self._lock:
            self._cache[recipe.id] = (generation, revision, built)
        return built

    def _load(self, recipe: Recipe) -> ProfileSet:
        with self.store.lock:
            rows = self.store.db.execute(
                """
                SELECT song_id, status, size, mtime_ns, tempo_bpm, energy, dim, detail,
                    length(vector) AS vector_length,
                    CASE WHEN ? THEN vector ELSE NULL END AS vector
                FROM audio_profile WHERE recipe = ?
                """,
                (int(recipe.kind == "embedding"), recipe.id),
            ).fetchall()
        profiles: dict[str, Profile] = {}
        ids: list[str] = []
        vectors: list[Vector] = []
        for row in rows:
            length = row["vector_length"]
            profile = Profile(
                song_id=str(row["song_id"]),
                status=str(row["status"]),
                size=int(row["size"]),
                mtime_ns=int(row["mtime_ns"]),
                tempo_bpm=None if row["tempo_bpm"] is None else float(row["tempo_bpm"]),
                energy=None if row["energy"] is None else float(row["energy"]),
                dim=int(row["dim"]),
                vector_length=0 if length is None else int(length),
                detail=str(row["detail"]),
            )
            profiles[profile.song_id] = profile
            if (
                recipe.kind == "embedding"
                and profile.status == "done"
                and profile.dim == recipe.dim
                and profile.vector_length == recipe.dim * 4
            ):
                vector = unit(np.frombuffer(bytes(row["vector"]), dtype="<f4"))
                if vector is not None:
                    ids.append(profile.song_id)
                    vectors.append(vector)
        matrix = np.stack(vectors).astype(np.float32) if vectors else None
        return ProfileSet(recipe, profiles, ids, {sid: i for i, sid in enumerate(ids)}, matrix)

    def lease(self, recipe_id: str, now: datetime | None = None) -> dict[str, object] | None:
        """Hand one queued song to the worker for LEASE_SECONDS, or None when there is none.

        A lapsed lease is handed out again. After MAX_ATTEMPTS lapses the song is written as
        failed and leaves the queue, so a file that keeps killing the worker cannot hold it.
        """
        if recipe_for(recipe_id) is None:
            raise LeaseError("Unknown recipe", 422)
        moment = now or datetime.now(UTC)
        stamp = _stamp(moment)
        wrote = False
        with self.store.lock:
            db = self.store.db
            db.execute("BEGIN IMMEDIATE")
            try:
                while True:
                    row = db.execute(
                        """
                        SELECT j.song_id, j.status, j.attempts, f.path, f.size, f.mtime_ns,
                            f.duration, f.genre, f.genres
                        FROM audio_job j
                        JOIN library_files f ON f.song_id = j.song_id
                        JOIN library_roots r ON r.path = f.root AND r.enabled = 1
                        WHERE j.recipe = ? AND (j.status = 'queued' OR j.leased_until < ?)
                        ORDER BY j.attempts, j.rowid
                        LIMIT 1
                        """,
                        (recipe_id, stamp),
                    ).fetchone()
                    if row is None:
                        db.commit()
                        return None
                    song_id = str(row["song_id"])
                    if row["status"] == "leased" and int(row["attempts"]) >= MAX_ATTEMPTS:
                        self._write(
                            db,
                            song_id,
                            recipe_id,
                            "failed",
                            int(row["size"]),
                            int(row["mtime_ns"]),
                            detail=f"the worker did not report back {MAX_ATTEMPTS} times",
                            stamp=stamp,
                        )
                        db.execute(
                            "DELETE FROM audio_job WHERE song_id=? AND recipe=?",
                            (song_id, recipe_id),
                        )
                        wrote = True
                        continue
                    token = secrets.token_hex(16)
                    until = _stamp(moment + timedelta(seconds=LEASE_SECONDS))
                    db.execute(
                        "UPDATE audio_job SET status='leased', lease_token=?, leased_until=?, "
                        "attempts=attempts+1 WHERE song_id=? AND recipe=?",
                        (token, until, song_id, recipe_id),
                    )
                    db.commit()
                    return {
                        "song_id": song_id,
                        "recipe": recipe_id,
                        "lease_token": token,
                        "leased_until": until,
                        "path": str(row["path"]),
                        "size": int(row["size"]),
                        "mtime_ns": int(row["mtime_ns"]),
                        "duration": float(row["duration"]),
                        "genre": str(row["genre"]),
                        "genres": _strings(row["genres"]),
                    }
            except Exception:
                db.rollback()
                raise
            finally:
                if wrote:
                    self.generation += 1

    def complete(self, result: WorkerResult, now: datetime | None = None) -> None:
        """Store a result, or raise LeaseError and leave the row as it was.

        The lease must be current and its token must match. The file must still be the one the
        index knows. A vector must be the recipe's length. A failed result goes back on the
        queue until MAX_ATTEMPTS; done and skipped results end the job.
        """
        recipe = recipe_for(result.recipe)
        if recipe is None:
            raise LeaseError("Unknown recipe", 422)
        vector = result.vector_bytes()
        if result.status == "done":
            if recipe.kind == "scalar":
                if result.tempo_bpm is None or result.energy is None:
                    raise LeaseError(f"A done {recipe.id} row needs tempo_bpm and energy", 422)
                if vector is not None or result.dim:
                    raise LeaseError(f"{recipe.id} rows have no vector", 422)
            elif vector is None or result.dim != recipe.dim or len(vector) != recipe.dim * 4:
                raise LeaseError(f"A {recipe.id} vector is {recipe.dim} float32 values", 422)
        stamp = _stamp(now or datetime.now(UTC))
        with self.store.lock:
            db = self.store.db
            db.execute("BEGIN IMMEDIATE")
            try:
                job = db.execute(
                    "SELECT status, lease_token, leased_until, attempts FROM audio_job "
                    "WHERE song_id=? AND recipe=?",
                    (result.song_id, result.recipe),
                ).fetchone()
                if (
                    job is None
                    or job["status"] != "leased"
                    or not secrets.compare_digest(
                        str(job["lease_token"]).encode(), result.lease_token.encode()
                    )
                    or str(job["leased_until"]) < stamp
                ):
                    raise LeaseError("That lease is not current. Nothing was stored.", 409)
                file = db.execute(
                    "SELECT f.size, f.mtime_ns FROM library_files f "
                    "JOIN library_roots r ON r.path = f.root AND r.enabled = 1 "
                    "WHERE f.song_id=?",
                    (result.song_id,),
                ).fetchone()
                if file is None:
                    db.execute(
                        "DELETE FROM audio_job WHERE song_id=? AND recipe=?",
                        (result.song_id, result.recipe),
                    )
                    db.commit()
                    raise LeaseError("That song left the library. Nothing was stored.", 409)
                if (int(file["size"]), int(file["mtime_ns"])) != (result.size, result.mtime_ns):
                    self._requeue(db, result.song_id, result.recipe)
                    db.commit()
                    raise LeaseError("The file changed during the lease. Nothing was stored.", 409)
                self._write(
                    db,
                    result.song_id,
                    result.recipe,
                    result.status,
                    result.size,
                    result.mtime_ns,
                    tempo_bpm=result.tempo_bpm,
                    energy=result.energy,
                    dim=result.dim,
                    vector=vector,
                    detail=result.detail,
                    stamp=stamp,
                )
                if result.status == "failed" and int(job["attempts"]) < MAX_ATTEMPTS:
                    self._requeue(db, result.song_id, result.recipe)
                else:
                    db.execute(
                        "DELETE FROM audio_job WHERE song_id=? AND recipe=?",
                        (result.song_id, result.recipe),
                    )
                db.commit()
            except Exception:
                db.rollback()
                raise
            finally:
                self.generation += 1

    def enqueue(self, recipe_id: str, limit: int | None) -> int:
        """Queue songs without a fresh done row for this recipe, newest files first.

        `limit` None queues every one. Songs already queued are left as they are. Returns how
        many rows were added.
        """
        if recipe_for(recipe_id) is None:
            raise LeaseError("Unknown recipe", 422)
        with self.store.lock:
            db = self.store.db
            db.execute("BEGIN IMMEDIATE")
            try:
                cursor = db.execute(
                    f"""
                    INSERT INTO audio_job (song_id, recipe, status)
                    SELECT f.song_id, ?, 'queued' FROM library_files f
                    {_LACKING_SQL}
                    ORDER BY f.added_at DESC, f.path
                    LIMIT ?
                    """,
                    (recipe_id, recipe_id, recipe_id, -1 if limit is None else max(0, limit)),
                )
                db.commit()
                return int(cursor.rowcount)
            except Exception:
                db.rollback()
                raise

    def lacking(self, recipe_id: str) -> int:
        """How many library songs have no fresh done row and are not queued yet."""
        with self.store.lock:
            row = self.store.db.execute(
                f"SELECT count(*) FROM library_files f {_LACKING_SQL}", (recipe_id, recipe_id)
            ).fetchone()
        return int(row[0])

    def queued(self, recipe_id: str) -> int:
        with self.store.lock:
            row = self.store.db.execute(
                "SELECT count(*) FROM audio_job WHERE recipe=?", (recipe_id,)
            ).fetchone()
        return int(row[0])

    @staticmethod
    def _requeue(db: sqlite3.Connection, song_id: str, recipe_id: str) -> None:
        db.execute(
            "UPDATE audio_job SET status='queued', lease_token='', leased_until='' "
            "WHERE song_id=? AND recipe=?",
            (song_id, recipe_id),
        )

    @staticmethod
    def _write(
        db: sqlite3.Connection,
        song_id: str,
        recipe_id: str,
        status: str,
        size: int,
        mtime_ns: int,
        *,
        tempo_bpm: float | None = None,
        energy: float | None = None,
        dim: int = 0,
        vector: bytes | None = None,
        detail: str,
        stamp: str,
    ) -> None:
        db.execute(
            """
            INSERT INTO audio_profile (
                song_id, recipe, status, size, mtime_ns, tempo_bpm, energy, dim, vector,
                detail, updated_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(song_id, recipe) DO UPDATE SET
                status=excluded.status, size=excluded.size, mtime_ns=excluded.mtime_ns,
                tempo_bpm=excluded.tempo_bpm, energy=excluded.energy, dim=excluded.dim,
                vector=excluded.vector, detail=excluded.detail, updated_at=excluded.updated_at
            """,
            (
                song_id,
                recipe_id,
                status,
                size,
                mtime_ns,
                tempo_bpm,
                energy,
                dim,
                vector,
                detail,
                stamp,
            ),
        )


# Songs in an enabled root that have no done row measured from the file as it is now, and are
# not already waiting. Takes the recipe id twice.
_LACKING_SQL = """
    JOIN library_roots r ON r.path = f.root AND r.enabled = 1
    WHERE f.song_id != ''
      AND NOT EXISTS (
        SELECT 1 FROM audio_profile p
        WHERE p.song_id = f.song_id AND p.recipe = ? AND p.status = 'done'
          AND p.size = f.size AND p.mtime_ns = f.mtime_ns
      )
      AND NOT EXISTS (SELECT 1 FROM audio_job j WHERE j.song_id = f.song_id AND j.recipe = ?)
"""
