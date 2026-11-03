"""Routes for the blind 4A label page.

The page never learns song titles, artists, tags or group/split. Clip ids are the only
public identifier; the server maps them to real files internally.
"""

import asyncio
import logging
from collections.abc import AsyncIterator, Callable
from pathlib import Path
from typing import Annotated

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from backend.core.store import Store
from backend.library.label_4a import (
    CLIP_SECONDS,
    Dnb,
    DnbSubtype,
    Intensity,
    Label4AAnswer,
    Label4AClip,
    Section,
    Speech,
    Vocals,
    clip_start,
    load_answers,
    load_manifest,
    save_answer,
    shuffled_order,
)
from backend.library.player import Player

logger = logging.getLogger(__name__)


class AnswerIn(BaseModel):
    sections_played: list[Section] = Field(default_factory=list)
    vocals: Vocals | None = None
    intensity: Intensity | None = None
    speech: Speech | None = None
    dnb: Dnb | None = None
    dnb_subtype: DnbSubtype | None = None


class ClipsOut(BaseModel):
    seed: str
    total: int
    order: list[str]
    answers: dict[str, AnswerIn]


def _load_clips() -> dict[str, Label4AClip]:
    try:
        manifest = load_manifest()
    except FileNotFoundError as exc:
        raise HTTPException(503, "No label set has been generated yet") from exc
    return {clip.clip_id: clip for clip in manifest.clips}


async def _stream_ffmpeg(path: Path, start: int) -> AsyncIterator[bytes]:
    proc = await asyncio.create_subprocess_exec(
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        str(start),
        "-t",
        str(CLIP_SECONDS),
        "-i",
        str(path),
        "-map_metadata",
        "-1",
        "-f",
        "mp3",
        "-q:a",
        "4",
        "-",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    assert proc.stdout is not None
    try:
        while True:
            chunk = await proc.stdout.read(65536)
            if not chunk:
                break
            yield chunk
    finally:
        if proc.returncode is None:
            proc.kill()
        await proc.wait()
        if proc.returncode not in (0, None):
            stderr = await proc.stderr.read() if proc.stderr else b""
            if stderr:
                logger.error("ffmpeg clip failed: %s", stderr.decode("utf-8", "replace").strip())


def install_label_4a_routes(
    app: FastAPI,
    get_store: Callable[[], Store],
    get_player: Callable[[], Player],
) -> None:
    @app.get("/api/label-4a/clips")
    async def list_clips() -> ClipsOut:
        manifest = load_manifest()
        clips = {clip.clip_id: clip for clip in manifest.clips}
        answers = {
            clip_id: AnswerIn(**answer.model_dump(exclude={"clip_id", "updated_at"}))
            for clip_id, answer in load_answers(get_store()).items()
            if clip_id in clips
        }
        return ClipsOut(
            seed=manifest.seed,
            total=len(clips),
            order=shuffled_order(manifest.clips, manifest.seed),
            answers=answers,
        )

    @app.post("/api/label-4a/answers/{clip_id}", status_code=204)
    async def post_answer(clip_id: str, body: AnswerIn) -> None:
        clips = _load_clips()
        if clip_id not in clips:
            raise HTTPException(404, "Clip not found")
        answer = Label4AAnswer(clip_id=clip_id, **body.model_dump())
        save_answer(get_store(), answer)

    @app.get("/api/label-4a/clips/{clip_id}")
    async def stream_clip(
        clip_id: str,
        section: Annotated[Section, Query()] = "middle",
    ) -> StreamingResponse:
        clips = _load_clips()
        clip = clips.get(clip_id)
        if clip is None:
            raise HTTPException(404, "Clip not found")

        store = get_store()
        with store.lock:
            row = store.db.execute(
                "SELECT duration FROM library_files WHERE song_id=?", (clip.song_id,)
            ).fetchone()
        if row is None:
            raise HTTPException(404, "Track not found")
        duration = float(row["duration"])

        path = get_player().local_file(clip.song_id)
        if path is None:
            raise HTTPException(404, "Track file not available")

        start = clip_start(section, clip.section_start, duration)
        return StreamingResponse(
            _stream_ffmpeg(path, start),
            media_type="audio/mpeg",
            headers={"Accept-Ranges": "none"},
        )
