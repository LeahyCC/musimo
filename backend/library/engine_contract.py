"""The versioned request and result of Musimo's music engine, and what it can do today.

An intent is the canonical, already-merged form of a request `MusicBot.resolve` supports: no
follow-up merging, no model wording. Anything the intent cannot say is an unknown field and is
refused, never dropped. The registry lists only what resolve does now; the unavailable entries
exist so a client can tell "not built yet" from "mistyped". A proposal is a stored result a
client can refine and then commit; the commit body and its receipt are defined here too.
"""

from dataclasses import dataclass
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from backend.core.audio_recipes import Recipe
from backend.library.duration import ABOUT_WINDOW, CANDIDATE_CAP, WORK_LIMIT, TotalLength
from backend.library.music_bot import SongId
from backend.library.selection import SEED_LIMIT, SHOWN_LIMIT

# The shape of the intent and the result. Bump on any change a client could notice.
# Version 2 added proposals, commit receipts, selection_too_large and the drawn seed in the
# echoed intent. Version 3 added filters.total_length and the result's duration report. An
# intent without total_length is unchanged, so it may still say 1 or 2.
CONTRACT_VERSION = 3
SUPPORTED_VERSIONS = (1, 2, 3)
# The first version with total_length.
TOTAL_LENGTH_VERSION = 3
# A commit body has not changed since proposals arrived in version 2.
COMMIT_VERSIONS = (2, 3)
# The rules that order and choose songs: the gates in resolve, the artist cap and the draw in
# selection.py. Bump when any of them changes, so a replay across versions is not mistaken
# for a replay of the same engine. tests/test_engine.py pins the constants that feed it.
# Version 2 added the total-length search in duration.py.
ENGINE_VERSION = 2

# Stripped first, so a blank name cannot match every untagged song.
Text = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
# The most songs a selection, a proposal or a queue holds. More is refused, never cut.
SELECTION_LIMIT = 500

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
    # The whole selection's length as a comparator. Not with target_seconds. Version 3.
    total_length: TotalLength | None = None
    limit: int = Field(default=SELECTION_LIMIT, ge=1, le=SELECTION_LIMIT)
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
    proposal_ids: list[SongId] = Field(default_factory=list, max_length=SELECTION_LIMIT)
    queue_ids: list[SongId] = Field(default_factory=list, max_length=SELECTION_LIMIT)
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


# Made by the client, so a retry after a lost reply can say "the same one as before".
OperationId = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9._:-]{8,80}$")]


class Refine(BaseModel):
    """A new intent against the latest revision. A proposal scope refines that revision's
    songs, which the server supplies; any other scope searches again under the same id."""

    model_config = ConfigDict(extra="forbid", strict=True)

    revision: int = Field(ge=1)
    # Parsed by parse_intent, so it is refused with the intent's own error codes.
    intent: dict[str, object]


class PlaylistTarget(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    kind: Literal["playlist"]
    # The rule the playlist routes use.
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]


class QueueTarget(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    kind: Literal["queue"]


class Commit(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    contract_version: int
    revision: int = Field(ge=1)
    operation_id: OperationId
    target: Annotated[PlaylistTarget | QueueTarget, Field(discriminator="kind")]
    # Each says yes to something a client should not do by accident: commit a revision that is
    # no longer the latest, or commit a revision again to a target it already went to.
    older_revision: bool = False
    repeat: bool = False


class Receipt(BaseModel):
    """What a commit did. A queue receipt means the ids are ready for the browser's player,
    which owns the live queue; the server never knows whether audio started."""

    operation_id: OperationId
    proposal_id: str
    revision: int
    target: Literal["playlist", "queue"]
    ids: list[SongId]
    status: Literal["saved", "ready_for_player"]
    playlist_id: str | None = None
    playlist_name: str | None = None
    created: str


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
        Capability(
            "proposal_commit",
            "action",
            True,
            "Saves a stored proposal revision as a new playlist, or hands its exact ids back for "
            "the browser's player. Nothing plays from the server.",
        ),
        *(Capability(name, "filter", True, "Saved library tags.") for name in _TAGS),
        Capability(
            "total_length",
            "filter",
            True,
            "Under, at most, at least, over or about (within "
            f"{ABOUT_WINDOW // 60} minutes) a total of stored whole-song lengths. A bounded "
            f"search of {CANDIDATE_CAP} songs and {WORK_LIMIT:,} steps; not claimed to be the "
            "best total. Contract version 3.",
        ),
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
        Capability("seed", "context", True, "Repeats a library selection. Library scope only."),
        Capability("current_id", "context", True, "The playing song, for comparisons."),
        Capability("reference_id", "context", True, "The song to compare with."),
        Capability("proposal_ids", "context", True, "The selection a proposal scope refines."),
        Capability("queue_ids", "context", True, "The queue a queue scope refines."),
        Capability(
            "shown_ids", "context", True, "Shown songs go last. Never excluded. Library scope only."
        ),
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
