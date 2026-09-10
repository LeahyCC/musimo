from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

Format = Literal["original", "m4a", "opus", "mp3"]
Stage = Literal[
    "queued",
    "matching",
    "downloading",
    "converting",
    "tagging",
    "moving",
    "scanning",
    "pausing",
    "paused",
    "cancelling",
    "cancelled",
    "retry_wait",
    "failed",
    "done",
]
TERMINAL = {"done", "failed", "cancelled"}
RUNNING = {
    "matching",
    "downloading",
    "converting",
    "tagging",
    "moving",
    "scanning",
    "pausing",
    "cancelling",
}


class Metadata(BaseModel):
    id: int
    title: str = "Loading track"
    artist: str = ""
    album_artist: str = ""
    album: str = ""
    duration: float = 0
    date: str = ""
    genre: str = ""
    label: str = ""
    isrc: str = ""
    upc: str = ""
    explicit: bool = False
    track: int = 1
    tracks: int = 1
    disc: int = 1
    discs: int = 1
    art: str = ""
    contributors: list[str] = Field(default_factory=list)
    mb_recording: str = ""
    mb_track: str = ""
    mb_release: str = ""
    mb_release_group: str = ""
    mb_artist: str = ""
    lyrics: str = ""
    synced_lyrics: str = ""


class Candidate(BaseModel):
    id: str
    title: str
    artist: str = ""
    duration: float = 0
    score: float = 0
    topic: bool = False
    reason: str = ""


class Job(BaseModel):
    id: str
    batch_id: str = ""
    batch_label: str = ""
    album_id: int = 0
    catalog: str = "deezer"
    track_id: int
    format: Format = "original"
    bitrate: int = 0
    target: str
    stage: Stage = "queued"
    desired: Literal["run", "pause", "cancel"] = "run"
    meta: Metadata
    candidates: list[Candidate] = Field(default_factory=list)
    selected: str = ""
    check_match: bool = False
    attempts: int = 0
    retry_at: float = 0
    progress: float = 0
    downloaded: int = 0
    total: int = 0
    speed: float = 0
    eta: float | None = None
    error_code: str = ""
    error: str = ""
    retryable: bool = False
    error_hint: str = ""
    error_fix: str = ""
    tool_tail: str = ""
    tool_version: str = ""
    warnings: list[str] = Field(default_factory=list)
    final_path: str = ""
    artifact_hash: str = ""
    codec: str = ""
    actual_bitrate: int = 0
    created_at: float
    updated_at: float
    hidden: bool = False

    def public(self) -> dict[str, object]:
        return self.model_dump(exclude={"meta": {"lyrics", "synced_lyrics"}})


class Enqueue(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    track_id: int = Field(gt=0)
    format: Format | None = None
    target: str | None = None


class Pick(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    candidate_id: str = Field(pattern=r"^[A-Za-z0-9_-]{11}$")


class BatchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    album_id: int = Field(gt=0)
    missing_only: bool = True
    format: Format | None = None
    target: str | None = None
