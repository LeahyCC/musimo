"""Blind labelling for the 4A audio evidence set.

Nothing here runs an audio model. It reads the picker manifest from runtime/label-4a,
persists Colin's answers, and serves short anonymised clips so the page never sees a
song id, title, artist or tag.
"""

import json
import os
import random
import sqlite3
from collections.abc import Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

from backend.core.store import Store

MANIFEST_ENV = "MUSIMO_LABEL_4A_MANIFEST"
DEFAULT_MANIFEST = "runtime/label-4a/manifest.json"
CLIP_ID_PREFIX = "C"
CLIP_SECONDS = 30

Section = Literal["early", "middle", "late"]
Vocals = Literal["none", "a_bit", "yes", "unknown"]
Intensity = Literal["calm", "medium", "intense", "unknown"]
Speech = Literal["music", "speech", "both", "unknown"]
Dnb = Literal["no", "yes", "unknown"]
DnbSubtype = Literal["liquid", "other", "unknown"]


class Label4AClip(BaseModel):
    """One labelled section, as recorded by the picker."""

    clip_id: str = Field(pattern=r"^C\d{3,}$")
    song_id: str = Field(pattern=r"^tr-[0-9a-f]{16}$")
    section_start: int = Field(ge=0)
    group: str
    split: Literal["dev", "held"]


class Label4AManifest(BaseModel):
    """The picker manifest. It lives in runtime/label-4a and is not committed."""

    seed: str
    snapshot_time: str
    total: int
    clips: list[Label4AClip]


class Label4AAnswer(BaseModel):
    """One saved blind judgement, excluding any song identity."""

    clip_id: str = Field(pattern=r"^C\d{3,}$")
    sections_played: list[Section] = Field(default_factory=list)
    vocals: Vocals | None = None
    intensity: Intensity | None = None
    speech: Speech | None = None
    dnb: Dnb | None = None
    dnb_subtype: DnbSubtype | None = None
    updated_at: str = ""

    def filled(self) -> bool:
        """True once every required field has a value."""
        return (
            self.vocals is not None
            and self.intensity is not None
            and self.speech is not None
            and self.dnb is not None
            and (self.dnb != "yes" or self.dnb_subtype is not None)
        )


def default_manifest_path() -> Path:
    return Path(os.environ.get(MANIFEST_ENV, DEFAULT_MANIFEST))


def load_manifest(path: Path | None = None) -> Label4AManifest:
    """Read the picker manifest, verifying its clip ids are unique."""
    if path is None:
        path = default_manifest_path()
    with path.open(encoding="utf-8") as handle:
        data = json.load(handle)
    manifest = Label4AManifest.model_validate(data)
    seen: set[str] = set()
    for clip in manifest.clips:
        if clip.clip_id in seen:
            raise ValueError(f"Duplicate clip id {clip.clip_id}")
        seen.add(clip.clip_id)
    return manifest


def manifest_clips(path: Path | None = None) -> dict[str, Label4AClip]:
    return {clip.clip_id: clip for clip in load_manifest(path).clips}


class Label4AError(Exception):
    pass


class ManifestMissing(Label4AError):
    pass


def _ensure_tables(db: sqlite3.Connection) -> None:
    db.execute(
        """
        CREATE TABLE IF NOT EXISTS label_4a_answers (
            clip_id TEXT PRIMARY KEY,
            sections_played TEXT NOT NULL DEFAULT '[]',
            vocals TEXT,
            intensity TEXT,
            speech TEXT,
            dnb TEXT,
            dnb_subtype TEXT,
            updated_at TEXT NOT NULL
        )
        """
    )


def ensure_tables(store: Store) -> None:
    with store.lock:
        _ensure_tables(store.db)


def save_answer(store: Store, answer: Label4AAnswer) -> None:
    """Persist one answer, replacing any earlier one for the same clip."""
    ensure_tables(store)
    answer.updated_at = datetime.now(UTC).isoformat()
    with store.lock:
        store.db.execute(
            """
            INSERT OR REPLACE INTO label_4a_answers
                (clip_id, sections_played, vocals, intensity, speech, dnb, dnb_subtype, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                answer.clip_id,
                json.dumps(answer.sections_played),
                answer.vocals,
                answer.intensity,
                answer.speech,
                answer.dnb,
                answer.dnb_subtype,
                answer.updated_at,
            ),
        )


def load_answers(store: Store) -> dict[str, Label4AAnswer]:
    """All saved answers keyed by clip id."""
    ensure_tables(store)
    with store.lock:
        rows = store.db.execute(
            """
            SELECT clip_id, sections_played, vocals, intensity, speech, dnb, dnb_subtype, updated_at
            FROM label_4a_answers
            """
        ).fetchall()
    answers: dict[str, Label4AAnswer] = {}
    for row in rows:
        sections = json.loads(str(row["sections_played"]))
        answers[str(row["clip_id"])] = Label4AAnswer(
            clip_id=str(row["clip_id"]),
            sections_played=sections if isinstance(sections, list) else [],
            vocals=row["vocals"],
            intensity=row["intensity"],
            speech=row["speech"],
            dnb=row["dnb"],
            dnb_subtype=row["dnb_subtype"],
            updated_at=str(row["updated_at"]),
        )
    return answers


def load_answer(store: Store, clip_id: str) -> Label4AAnswer | None:
    ensure_tables(store)
    with store.lock:
        row = store.db.execute(
            "SELECT * FROM label_4a_answers WHERE clip_id=?", (clip_id,)
        ).fetchone()
    if row is None:
        return None
    sections = json.loads(str(row["sections_played"]))
    return Label4AAnswer(
        clip_id=str(row["clip_id"]),
        sections_played=sections if isinstance(sections, list) else [],
        vocals=row["vocals"],
        intensity=row["intensity"],
        speech=row["speech"],
        dnb=row["dnb"],
        dnb_subtype=row["dnb_subtype"],
        updated_at=str(row["updated_at"]),
    )


def clip_start(section: Section, base_start: int, duration: float) -> int:
    """Where a 30-second clip begins for the chosen section button.

    Early and Late move 15 seconds either side of the manifest start, clamped to the
    track. The long-intro group uses a base start of zero, so its buttons audition the
    opening at 0, 15 and 30 seconds.
    """
    if duration <= 0:
        return 0
    offset = {"early": -15, "middle": 0, "late": 15}[section]
    start = max(0, base_start + offset)
    if start >= duration:
        start = max(0, int(duration) - CLIP_SECONDS)
    return start


def shuffled_order(clips: Sequence[Label4AClip], seed: str) -> list[str]:
    """Deterministic interview order: fixed seed, not grouped."""
    order = [clip.clip_id for clip in clips]
    random.Random(seed).shuffle(order)
    return order
