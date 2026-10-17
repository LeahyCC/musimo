"""The versioned request and result of Musimo's music engine, and what it can do today.

An intent is the canonical, already-merged form of a request `MusicBot.resolve` supports: no
follow-up merging, no model wording. Anything the intent cannot say is an unknown field and is
refused, never dropped. The registry lists only what resolve does now; the unavailable entries
exist so a client can tell "not built yet" from "mistyped".
"""

from dataclasses import dataclass
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from backend.core.audio_recipes import Recipe
from backend.library.music_bot import SongId
from backend.library.selection import SEED_LIMIT, SHOWN_LIMIT

# The shape of the intent and the result. Bump on any change a client could notice.
CONTRACT_VERSION = 1
SUPPORTED_VERSIONS = (1,)
# The rules that order and choose songs: the gates in resolve, the artist cap and the draw in
# selection.py. Bump when any of them changes, so a replay across versions is not mistaken
# for a replay of the same engine. tests/test_engine.py pins the constants that feed it.
ENGINE_VERSION = 1

Text = Annotated[str, StringConstraints(min_length=1, max_length=120)]
Action = Literal["search", "pause", "resume", "skip", "clarify", "unsupported"]
Scope = Literal["library", "proposal", "queue"]


class Filters(BaseModel):
    """The hard filters of a search. An omitted field is the empty filter."""

    model_config = ConfigDict(extra="forbid", strict=True)

    artists: list[Text] = Field(default_factory=list, max_length=10)
    exclude_artists: list[Text] = Field(default_factory=list, max_length=10)
    genres: list[Text] = Field(default_factory=list, max_length=10)
    year_from: int | None = Field(default=None, ge=1000, le=3000)
    year_to: int | None = Field(default=None, ge=1000, le=3000)
    favourites: bool = False
    history: Literal["any", "played", "unplayed", "familiar"] = "any"
    exclude_played_days: int = Field(default=0, ge=0, le=3650)
    # Each song's own length.
    min_seconds: int = Field(default=0, ge=0, le=86400)
    max_seconds: int | None = Field(default=None, ge=1, le=86400)
    # The length to fill to: the walk stops once the total reaches it. Not a comparator.
    target_seconds: int = Field(default=0, ge=0, le=86400)
    limit: int = Field(default=500, ge=1, le=500)
    similar_to_current: bool = False
    tempo: Literal["", "slow", "medium", "fast"] = ""
    tempo_min: int | None = Field(default=None, ge=1, le=999)
    tempo_max: int | None = Field(default=None, ge=1, le=999)
    energy: Literal["", "low", "medium", "high"] = ""
    energy_compared: Literal["", "calmer", "more_intense"] = ""
    tempo_compared: Literal["", "slower", "faster"] = ""
    sound: str = Field(default="", max_length=120)


class Context(BaseModel):
    """The songs a request is about, and the memory it was made against."""

    model_config = ConfigDict(extra="forbid", strict=True)

    current_id: SongId | None = None
    reference_id: SongId | None = None
    # The selection a proposal-scope request refines, and the queue a queue-scope one does.
    proposal_ids: list[SongId] = Field(default_factory=list, max_length=500)
    queue_ids: list[SongId] = Field(default_factory=list, max_length=500)
    # Songs shown lately. Memory, not a reference: a song since removed is counted, not refused.
    shown_ids: list[SongId] = Field(default_factory=list, max_length=SHOWN_LIMIT)


class Intent(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    contract_version: int
    action: Action
    scope: Scope = "library"
    filters: Filters = Field(default_factory=Filters)
    # Repeats a library selection against the same snapshot. None draws a fresh seed.
    seed: int | None = Field(default=None, ge=0, lt=SEED_LIMIT)
    context: Context = Field(default_factory=Context)
    # Only for clarify and unsupported: the question or the refusal, in words.
    explanation: str = Field(default="", max_length=400)


@dataclass(frozen=True)
class Capability:
    id: str
    group: Literal["action", "scope", "filter", "context"]
    available: bool
    note: str

    def public(self) -> dict[str, object]:
        return {
            "id": self.id,
            "group": self.group,
            "available": self.available,
            "note": self.note,
        }


# What is built but not yet allowed in an intent. None of these is a field of `Intent`.
NOT_BUILT = (
    Capability(
        "duration_comparators",
        "filter",
        False,
        "Under, at most, at least and about a total length are not built. target_seconds only "
        "fills until the total reaches it.",
    ),
    Capability("proposal_commit", "action", False, "Nothing is saved, queued or played."),
    Capability(
        "audio_certainty",
        "filter",
        False,
        "No constraint is certified by audio evidence. A negated description such as no "
        "vocals is refused.",
    ),
    Capability("persona", "action", False, "No persona renders the result."),
    Capability("external_catalogue", "scope", False, "Only the local library is searched."),
)
_PLAYER_NOTE = "Reported to the client. The engine never changes playback."
_TAGS = (
    "artists",
    "exclude_artists",
    "genres",
    "year_from",
    "year_to",
    "favourites",
    "history",
    "exclude_played_days",
    "min_seconds",
    "max_seconds",
    "target_seconds",
    "limit",
)
_SCALAR_NOTE = "Needs a fresh measured row. Available while a scalar recipe is on."


def registry(scalar: Recipe | None, embedding: Recipe | None) -> list[Capability]:
    """Every capability, available or not, given the recipes the settings turn on."""
    text = embedding is not None and embedding.text_aligned
    return [
        Capability("search", "action", True, "Resolves real library songs."),
        Capability("pause", "action", True, _PLAYER_NOTE),
        Capability("resume", "action", True, _PLAYER_NOTE),
        Capability("skip", "action", True, _PLAYER_NOTE),
        Capability("clarify", "action", True, "Carries a question. No search runs."),
        Capability("unsupported", "action", True, "Carries a refusal. No search runs."),
        Capability("library", "scope", True, "All library songs."),
        Capability("proposal", "scope", True, "Refines the given proposal in its order."),
        Capability("queue", "scope", True, "Refines the given queue in its order."),
        *(Capability(name, "filter", True, "Saved library tags.") for name in _TAGS),
        Capability(
            "similar_to_current",
            "filter",
            True,
            "Measured sound similarity." if embedding is not None else "Artist and saved genres.",
        ),
        *(
            Capability(name, "filter", scalar is not None, _SCALAR_NOTE)
            for name in (
                "tempo",
                "tempo_min",
                "tempo_max",
                "energy",
                "energy_compared",
                "tempo_compared",
            )
        ),
        Capability(
            "sound",
            "filter",
            text,
            "Needs a text-aligned embedding recipe, and a phrase that is not only a negation.",
        ),
        Capability("seed", "context", True, "Repeats a library selection."),
        Capability("shown_ids", "context", True, "Shown songs go last. Never excluded."),
        *NOT_BUILT,
    ]


class ErrorField(BaseModel):
    field: str
    message: str


class EngineError(Exception):
    """A typed refusal. The code is the contract; the message is for a person."""

    def __init__(
        self,
        code: str,
        message: str,
        status: int = 422,
        fields: list[ErrorField] | None = None,
    ):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.fields = fields or []

    def public(self) -> dict[str, object]:
        return {
            "contract_version": CONTRACT_VERSION,
            "status": "error",
            "error": {
                "code": self.code,
                "message": self.message,
                "fields": [item.model_dump() for item in self.fields],
            },
        }
