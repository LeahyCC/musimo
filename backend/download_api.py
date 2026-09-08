import uuid
from collections.abc import Callable
from typing import Literal

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import JSONResponse

from backend.catalog import Result
from backend.downloads import DownloadError, Downloads
from backend.job_models import RUNNING, TERMINAL, BatchRequest, Enqueue, Job, Metadata, Pick
from backend.job_store import JobConflict
from backend.naming import Naming


def install_download_routes(app: FastAPI, get: Callable[[], Downloads]) -> None:
    @app.get("/api/naming-preview")
    async def naming_preview(template: str = Query(max_length=240)) -> dict[str, str]:
        try:
            path = Naming().path(
                template,
                Metadata(
                    id=1,
                    title="Example Track",
                    artist="Example Artist",
                    album_artist="Example Artist",
                    album="Example Album",
                    track=3,
                    date="2026-01-01",
                ),
                "opus",
            )
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        return {"path": path}

    @app.exception_handler(JobConflict)
    async def conflict(_: object, exc: JobConflict) -> JSONResponse:
        return JSONResponse({"detail": str(exc)}, status_code=409)

    @app.exception_handler(DownloadError)
    async def download_error(_: object, exc: DownloadError) -> JSONResponse:
        return JSONResponse({"detail": exc.detail, "code": exc.code}, status_code=409)

    @app.get("/api/jobs")
    async def jobs() -> dict[str, object]:
        return {
            "jobs": [job.public() for job in get().jobs.visible()],
            "controls": get().controls(),
        }

    @app.get("/api/history")
    async def history(
        q: str = Query(default="", max_length=200),
        since: float = Query(default=0, ge=0),
        until: float = Query(default=1e12, ge=0),
        offset: int = Query(default=0, ge=0),
    ) -> dict[str, object]:
        return get().jobs.history(q, since, until, offset)

    @app.post("/api/jobs", response_model=Job)
    async def enqueue(request: Enqueue) -> Job:
        service = get()
        settings = service.settings()
        try:
            target = service.target(request.target or settings.destination)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        service.check_destination(target)
        return service.jobs.enqueue(
            request.track_id, request.format or settings.output_format, str(target)
        )

    @app.post("/api/batches")
    async def batch(request: BatchRequest) -> dict[str, object]:
        service = get()
        settings = service.settings()
        try:
            target = service.target(request.target or settings.destination)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        service.check_destination(target)
        album = await service.catalog.album_detail(request.album_id)
        if album.get("complete") is not True:
            raise HTTPException(409, "Album track list is incomplete. Retry before downloading.")
        raw = album.get("tracks", [])
        tracks = [Result.model_validate(row) for row in raw] if isinstance(raw, list) else []
        service.library.annotate(tracks)
        wanted = [row.id for row in tracks if not request.missing_only or row.ownership != "owned"]
        batch_id = uuid.uuid4().hex
        jobs = service.jobs.enqueue_many(
            wanted,
            request.format or settings.output_format,
            str(target),
            batch_id,
            album_id=request.album_id,
        )
        completed = sum(job.stage == "done" for job in jobs)
        jobs = [job for job in jobs if job.stage != "done"]
        return {
            "id": batch_id,
            "jobs": [job.public() for job in jobs],
            "skipped": len(tracks) - len(wanted) + completed,
        }

    @app.post("/api/batches/{batch_id}/{action}")
    async def batch_command(
        batch_id: str, action: Literal["pause", "resume", "cancel", "retry"]
    ) -> dict[str, object]:
        service = get()
        jobs = [job for job in service.jobs.list() if job.batch_id == batch_id]
        if not jobs:
            raise HTTPException(404, "Batch not found")
        errors: list[str] = []
        for job in jobs:
            eligible = (
                job.stage in {"failed", "cancelled"}
                if action == "retry"
                else job.stage in {"paused", "pausing"}
                if action == "resume"
                else job.stage not in TERMINAL
            )
            if eligible:
                try:
                    service.command(job.id, action)
                except (ValueError, DownloadError) as exc:
                    errors.append(exc.detail if isinstance(exc, DownloadError) else str(exc))
        return {"controls": service.controls(), "errors": errors}

    @app.post("/api/jobs/{job_id}/pick", response_model=Job)
    async def pick(job_id: str, request: Pick) -> Job:
        service = get()
        try:
            job = service.jobs.get(job_id)
        except KeyError as exc:
            raise HTTPException(404, "Job not found") from exc
        if job.stage in RUNNING or job.id in service.running:
            raise HTTPException(409, "Pause the job before choosing another recording")
        if not any(candidate.id == request.candidate_id for candidate in job.candidates):
            raise HTTPException(422, "Choose a candidate from this job's match list")
        if any(
            row.id != job.id
            and row.track_id == job.track_id
            and row.format == job.format
            and row.target == job.target
            for row in service.jobs.list(active=True)
        ):
            raise HTTPException(409, "This track already has another active job")
        if job.stage == "done":
            replacement = service.jobs.enqueue(
                job.track_id, job.format, job.target, replace_match=True
            )
            return service.jobs.update(
                replacement.id,
                meta=job.meta.model_dump(),
                selected=request.candidate_id,
                candidates=[candidate.model_dump() for candidate in job.candidates],
                check_match=False,
            )
        service.cleanup(job)
        return service.jobs.update(
            job.id,
            selected=request.candidate_id,
            stage="queued",
            desired="run",
            attempts=0,
            retry_at=0,
            error="",
            error_code="",
            final_path="",
            artifact_hash="",
            check_match=False,
        )

    @app.post("/api/jobs/{job_id}/{action}", response_model=Job)
    async def command(job_id: str, action: Literal["pause", "resume", "cancel", "retry"]) -> Job:
        try:
            return get().command(job_id, action)
        except KeyError as exc:
            raise HTTPException(404, "Job not found") from exc
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.post("/api/queue/{action}")
    async def queue(
        action: Literal[
            "pause", "resume", "cancel-queued", "retry-failed", "clear-finished", "resume-source"
        ],
    ) -> dict[str, object]:
        service = get()
        if action == "pause":
            service.set_controls(paused=True)
        elif action == "resume":
            service.set_controls(paused=False)
        elif action == "resume-source":
            service.set_controls(source_paused=False)
        failures: list[str] = []
        for job in service.jobs.list():
            try:
                if action == "pause" and job.stage not in TERMINAL and job.stage != "paused":
                    service.command(job.id, "pause")
                elif action == "resume" and job.stage in {"paused", "pausing"}:
                    service.command(job.id, "resume")
                elif action == "cancel-queued" and job.stage in {"queued", "retry_wait", "paused"}:
                    service.command(job.id, "cancel")
                elif action == "retry-failed" and job.stage == "failed":
                    service.command(job.id, "retry")
                elif action == "clear-finished" and job.stage in TERMINAL:
                    service.jobs.update(job.id, hidden=True)
            except (ValueError, DownloadError) as exc:
                failures.append(str(exc) if not isinstance(exc, DownloadError) else exc.detail)
        return {"controls": service.controls(), "errors": failures}
