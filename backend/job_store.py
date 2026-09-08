from __future__ import annotations

import builtins
import time
import uuid
from collections.abc import Callable
from pathlib import Path

from backend.job_models import RUNNING, TERMINAL, Format, Job, Metadata
from backend.store import Store


class JobConflict(ValueError):
    pass


class Jobs:
    def __init__(self, store: Store, notify: Callable[[], None]) -> None:
        self.store, self.notify = store, notify

    def get(self, job_id: str) -> Job:
        with self.store.lock:
            row = self.store.db.execute("SELECT payload FROM jobs WHERE id=?", (job_id,)).fetchone()
        if row is None:
            raise KeyError(job_id)
        return Job.model_validate_json(row[0])

    def list(self, active: bool = False) -> builtins.list[Job]:
        with self.store.lock:
            rows = self.store.db.execute(
                "SELECT payload FROM jobs"
                + (" WHERE active=1" if active else "")
                + " ORDER BY created_at DESC"
            ).fetchall()
        return [Job.model_validate_json(row[0]) for row in rows]

    def visible(self) -> builtins.list[Job]:
        with self.store.lock:
            rows = self.store.db.execute(
                "SELECT payload FROM jobs WHERE active=1 OR "
                "json_extract(payload,'$.batch_id') IN (SELECT json_extract(payload,'$.batch_id') "
                "FROM jobs WHERE active=1 AND json_extract(payload,'$.batch_id')!='') OR id IN "
                "(SELECT id FROM jobs WHERE active=0 AND json_extract(payload,'$.hidden')=0 "
                "AND json_extract(payload,'$.stage')='failed' ORDER BY created_at DESC LIMIT 50) "
                "OR id IN (SELECT id FROM jobs WHERE active=0 "
                "AND json_extract(payload,'$.hidden')=0 "
                "AND json_extract(payload,'$.stage')!='failed' ORDER BY created_at DESC LIMIT 50) "
                "ORDER BY created_at DESC"
            ).fetchall()
        return [Job.model_validate_json(row[0]) for row in rows]

    def history(self, q: str, since: float, until: float, offset: int) -> dict[str, object]:
        where = (
            "active=0 AND created_at BETWEEN ? AND ? AND instr(lower("
            "json_extract(payload,'$.meta.title') || ' ' || "
            "json_extract(payload,'$.meta.artist') || ' ' || "
            "json_extract(payload,'$.meta.album') || ' ' || "
            "json_extract(payload,'$.final_path')), lower(?))>0"
        )
        with self.store.lock:
            args = (since, until, q)
            total = self.store.db.execute(
                "SELECT count(*) FROM jobs WHERE " + where, args
            ).fetchone()[0]
            rows = self.store.db.execute(
                "SELECT payload FROM jobs WHERE "
                + where
                + " ORDER BY created_at DESC LIMIT 100 OFFSET ?",
                (*args, offset),
            ).fetchall()
        return {"jobs": [Job.model_validate_json(row[0]).public() for row in rows], "total": total}

    def enqueue(
        self, track_id: int, format: Format, target: str, *, replace_match: bool = False
    ) -> Job:
        return self.enqueue_many([track_id], format, target, replace_match=replace_match)[0]

    def enqueue_many(
        self,
        tracks: builtins.list[int],
        format: Format,
        target: str,
        batch_id: str = "",
        batch_label: str = "",
        *,
        album_id: int = 0,
        replace_match: bool = False,
    ) -> builtins.list[Job]:
        jobs: builtins.list[Job] = []
        with self.store.lock:
            self.store.db.execute("BEGIN IMMEDIATE")
            try:
                for track_id in tracks:
                    row = self.store.db.execute(
                        "SELECT payload FROM jobs WHERE catalog='deezer' AND track_id=? "
                        "AND format=? AND bitrate=0 AND target=? AND active=1",
                        (track_id, format, target),
                    ).fetchone()
                    if row:
                        jobs.append(Job.model_validate_json(row[0]))
                        continue
                    if not replace_match:
                        saved = self.store.db.execute(
                            "SELECT payload FROM jobs WHERE catalog='deezer' AND track_id=? "
                            "AND format=? AND bitrate=0 AND target=? AND active=0 "
                            "AND json_extract(payload,'$.stage')='done' ORDER BY created_at DESC",
                            (track_id, format, target),
                        ).fetchall()
                        complete = next(
                            (
                                job
                                for row in saved
                                if (job := Job.model_validate_json(row[0])).final_path
                                and Path(job.final_path).is_file()
                            ),
                            None,
                        )
                        if complete:
                            jobs.append(complete)
                            continue
                    now = time.time()
                    job = Job(
                        id=uuid.uuid4().hex,
                        batch_id=batch_id,
                        batch_label=batch_label,
                        album_id=album_id,
                        track_id=track_id,
                        format=format,
                        target=target,
                        meta=Metadata(id=track_id),
                        created_at=now,
                        updated_at=now,
                    )
                    self.store.db.execute(
                        "INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?)",
                        (
                            job.id,
                            job.catalog,
                            track_id,
                            format,
                            0,
                            target,
                            1,
                            now,
                            job.model_dump_json(),
                        ),
                    )
                    self.store._event("job.updated", job.public())
                    jobs.append(job)
                self.store.db.commit()
            except Exception:
                self.store.db.rollback()
                raise
        self.notify()
        return jobs

    def update(self, job_id: str, **changes: object) -> Job:
        with self.store.lock:
            self.store.db.execute("BEGIN IMMEDIATE")
            try:
                old = self.get(job_id)
                job = Job.model_validate(old.model_dump() | changes | {"updated_at": time.time()})
                active = job.stage not in TERMINAL
                duplicate = self.store.db.execute(
                    "SELECT id FROM jobs WHERE catalog=? AND track_id=? AND format=? "
                    "AND bitrate=? AND target=? AND active=1 AND id!=?",
                    (job.catalog, job.track_id, job.format, job.bitrate, job.target, job.id),
                ).fetchone()
                if active and duplicate:
                    raise JobConflict(f"This track already has an active job: {duplicate[0]}")
                self.store.db.execute(
                    "UPDATE jobs SET active=?,payload=? WHERE id=?",
                    (int(active), job.model_dump_json(), job.id),
                )
                self.store._event("job.updated", job.public())
                self.store.db.commit()
            except Exception:
                self.store.db.rollback()
                raise
        self.notify()
        return job

    def recover(self) -> None:
        for job in self.list(active=True):
            if job.stage in RUNNING:
                stage = (
                    "cancelled"
                    if job.desired == "cancel"
                    else "paused"
                    if job.desired == "pause"
                    else "queued"
                )
                self.update(job.id, stage=stage, speed=0, eta=None)
