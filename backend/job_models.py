import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from backend.sources import Kind

Format = Literal["original", "m4a", "opus", "mp3"]
# `deezer` jobs match a catalog track on YouTube. `podcast` and `link` jobs download the address
# in `source_url` directly, taken from the server's own lookup and never from the browser.
CatalogName = Literal["deezer", "podcast", "link"]
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


# The ID each source uses for one recording. A candidate from a source missing here is never
# accepted, so a new site has to add its own pattern before its matches can be picked.
CANDIDATE_IDS = {"youtube": re.compile(r"[A-Za-z0-9_-]{11}")}


def valid_candidate_id(source: str, candidate_id: str) -> bool:
    pattern = CANDIDATE_IDS.get(source)
    return pattern is not None and pattern.fullmatch(candidate_id) is not None


class Candidate(BaseModel):
    id: str
    title: str
    artist: str = ""
    duration: float = 0
    score: float = 0
    topic: bool = False
    reason: str = ""
    source: str = "youtube"
    url: str = ""


class Job(BaseModel):
    id: str
    batch_id: str = ""
    batch_label: str = ""
    album_id: int = 0
    catalog: CatalogName = "deezer"
    track_id: int
    # The site the audio comes from. Pausing, error mapping and candidate checks key off it.
    source: str = "youtube"
    # Podcast episodes and pasted links download this address directly instead of matching.
    source_url: str = ""
    # Mixes and radio shows run long, so they get the episode timeout.
    kind: Kind = "music"
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

    @model_validator(mode="before")
    @classmethod
    def default_source(cls, data: object) -> object:
        # Jobs stored before `source` existed were YouTube matches or podcast feed files.
        if isinstance(data, dict) and "source" not in data:
            return {**data, "source": "podcast" if data.get("catalog") == "podcast" else "youtube"}
        return data

    def public(self) -> dict[str, object]:
        return self.model_dump(exclude={"meta": {"lyrics", "synced_lyrics"}})


class Enqueue(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    track_id: int = Field(gt=0)
    format: Format | None = None
    target: str | None = None


class Pick(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    # Only a bounded token here; the candidate's own source checks the exact ID shape.
    candidate_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")


class BatchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    album_id: int = Field(gt=0)
    missing_only: bool = True
    format: Format | None = None
    target: str | None = None


class LinkResolveRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    url: str = Field(min_length=1, max_length=2000)


class LinkRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    token: str = Field(pattern=r"^[A-Za-z0-9_-]{16,64}$")
    entry_ids: list[str] = Field(min_length=1, max_length=500)
    format: Format | None = None
    target: str | None = None


class EpisodeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    podcast_id: int = Field(gt=0)
    episode_id: int = Field(gt=0)
    target: str | None = None
