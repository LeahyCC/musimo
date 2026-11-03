"""Adapter between a small local model's JSON output and the engine's canonical intent.

`Interpretation` is the schema the model is asked to return. It is intentionally small and
flat: a few actions, a scope, filters named exactly as the engine contract names them,
named songs as `{title, artist}` rather than ids, and a small edit vocabulary.

`parse_model_output` turns raw model text into an `Interpretation` or a usable `Reply`.
`to_intent` validates an interpretation against the server's capability registry and catalogue,
turning named songs into `context.proposal_ids`. Anything the engine cannot honour is refused
as a `Reply` rather than loosened.
"""

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Annotated, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    ValidationError,
    model_validator,
)

from backend.core.text import normalize
from backend.library.duration import TotalLength
from backend.library.engine_contract import (
    CONTRACT_VERSION,
    Capability,
    Context,
    Filters,
    Intent,
    Scope,
)

Text = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]


class NamedSong(BaseModel):
    """A song the model named by its metadata, never by an opaque id."""

    model_config = ConfigDict(extra="forbid", strict=True)

    title: Text
    artist: Text | None = Field(default=None)


class TotalLengthModel(BaseModel):
    """The whole-list duration comparator, using the same names as `TotalLength`."""

    model_config = ConfigDict(extra="forbid", strict=True)

    mode: Literal["under", "at_most", "at_least", "over", "about"]
    seconds: int = Field(ge=1, le=86400)


class FilterSet(BaseModel):
    """The hard filters of a search, using the engine contract's field names.

    `exclude_ids` is omitted because the model expresses removals through the edit block.
    """

    model_config = ConfigDict(extra="forbid", strict=True)

    artists: list[Text] = Field(default_factory=list, max_length=10)
    exclude_artists: list[Text] = Field(default_factory=list, max_length=10)
    genres: list[Text] = Field(default_factory=list, max_length=10)
    year_from: int | None = Field(default=None, ge=1000, le=3000)
    year_to: int | None = Field(default=None, ge=1000, le=3000)
    favourites: bool = False
    history: Literal["any", "played", "unplayed", "familiar"] = "any"
    exclude_played_days: int = Field(default=0, ge=0, le=3650)
    min_seconds: int = Field(default=0, ge=0, le=86400)
    max_seconds: int | None = Field(default=None, ge=1, le=86400)
    target_seconds: int = Field(default=0, ge=0, le=86400)
    total_length: TotalLengthModel | None = None
    limit: int = Field(default=500, ge=1, le=500)
    similar_to_current: bool = False
    tempo: Literal["", "slow", "medium", "fast"] = ""
    tempo_min: int | None = Field(default=None, ge=1, le=999)
    tempo_max: int | None = Field(default=None, ge=1, le=999)
    energy: Literal["", "low", "medium", "high"] = ""
    energy_compared: Literal["", "calmer", "more_intense"] = ""
    tempo_compared: Literal["", "slower", "faster"] = ""
    sound: str = Field(default="", max_length=120)

    @model_validator(mode="after")
    def ranges(self) -> "FilterSet":
        if self.year_from and self.year_to and self.year_from > self.year_to:
            raise ValueError("Year range is reversed")
        if self.max_seconds is not None and self.min_seconds > self.max_seconds:
            raise ValueError("Duration range is reversed")
        if (
            self.tempo_min is not None
            and self.tempo_max is not None
            and self.tempo_min > self.tempo_max
        ):
            raise ValueError("Tempo range is reversed")
        if self.total_length is not None and self.target_seconds:
            raise ValueError("Send total_length or target_seconds, not both")
        return self


class AnotherEdit(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    kind: Literal["another"]
    pinned: list[NamedSong] = Field(default_factory=list, max_length=500)


class AddEdit(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    kind: Literal["add"]
    count: int = Field(default=1, ge=1, le=500)


class RemoveEdit(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    kind: Literal["remove"]
    songs: list[NamedSong] = Field(min_length=1, max_length=500)


Edit = Annotated[AnotherEdit | AddEdit | RemoveEdit, Field(discriminator="kind")]


class Interpretation(BaseModel):
    """The JSON a local model returns for one user request."""

    model_config = ConfigDict(extra="forbid", strict=True)

    action: Literal["search", "edit", "pause", "resume", "skip", "clarify", "unsupported"]
    scope: Scope = "library"
    filters: FilterSet = Field(default_factory=FilterSet)
    named_songs: list[NamedSong] = Field(default_factory=list, max_length=10)
    edit: Edit | None = None
    question: str = Field(default="", max_length=400)
    reason: str = Field(default="", max_length=400)

    @model_validator(mode="after")
    def consistent(self) -> "Interpretation":
        if self.action == "edit" and self.edit is None:
            raise ValueError("edit needs an edit block")
        if self.action != "edit" and self.edit is not None:
            raise ValueError("edit block only belongs to action edit")
        return self


@dataclass(frozen=True)
class Reply:
    """A reply the chat can return instead of an intent."""

    action: Literal["clarify", "unsupported"]
    explanation: str


# Filters that are checked explicitly against the capability registry.
_REGISTRY_FILTER_FIELDS = {
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
    "total_length",
    "tempo",
    "tempo_min",
    "tempo_max",
    "energy",
    "energy_compared",
    "tempo_compared",
    "sound",
}

_SCALAR_FIELDS = ("tempo", "tempo_min", "tempo_max", "energy", "energy_compared", "tempo_compared")


def _available(registry: list[Capability]) -> set[str]:
    return {item.id for item in registry if item.available}


def _normalize(value: str) -> str:
    """Use the same text normalisation as the engine."""
    return normalize(value)


def resolve_named_songs(
    songs: list[NamedSong], catalogue: Sequence[object]
) -> tuple[list[str], str | None]:
    """Find ids for named songs, or return a clarification question.

    A title with no artist matches only when exactly one catalogue song has that title.
    This is the same lookup to_intent uses, exposed for edits that name songs.
    """
    return _lookup(songs, catalogue)


def _lookup(songs: list[NamedSong], catalogue: Sequence[object]) -> tuple[list[str], str | None]:
    """Find ids for named songs, or return a clarification question.

    A title with no artist matches only when exactly one catalogue song has that title.
    """
    by_title: dict[str, list[object]] = {}
    for item in catalogue:
        title = getattr(item, "title", "")
        key = _normalize(title)
        by_title.setdefault(key, []).append(item)

    ids: list[str] = []
    for song in songs:
        key = _normalize(song.title)
        candidates = by_title.get(key, [])
        if song.artist:
            wanted = _normalize(song.artist)
            matches = [
                item for item in candidates if _normalize(getattr(item, "artist", "")) == wanted
            ]
        else:
            matches = candidates
        if not matches:
            question = f'I couldn\'t find "{song.title}"' + (
                f" by {song.artist}." if song.artist else "."
            )
            return [], question
        if len(matches) > 1:
            artists = ", ".join(sorted({getattr(item, "artist", "") for item in matches}))
            return [], f'Which version of "{song.title}"? I see {artists}.'
        ids.append(str(getattr(matches[0], "song_id", "")))
    return ids, None


def to_intent(
    interpretation: Interpretation,
    catalogue: Sequence[object],
    registry: list[Capability],
) -> Intent | Reply:
    """Validate an interpretation and turn it into an engine `Intent`.

    Named songs are looked up in `catalogue`, whose items expose `title`, `artist` and
    `song_id`. A missing or ambiguous song becomes a `clarify` reply. A filter the server
    does not support becomes an `unsupported` reply.
    """
    available = _available(registry)

    if interpretation.action in {"pause", "resume", "skip"}:
        if not {"pause", "resume", "skip"} <= available:
            return Reply("unsupported", "Transport commands are not available.")
        return Intent(
            contract_version=CONTRACT_VERSION,
            action=interpretation.action,
            scope="library",
            explanation="",
        )

    if interpretation.action == "unsupported":
        return Reply("unsupported", interpretation.reason or "I can't do that yet.")

    if interpretation.action == "clarify":
        return Reply("clarify", interpretation.question or "What do you mean?")

    if interpretation.action == "edit":
        # The adapter receives no previous proposal, so it cannot build the engine edit here.
        return Reply(
            "unsupported", "Edits need a previous proposal that the adapter does not have."
        )

    if "search" not in available:
        return Reply("unsupported", "Searching the library is not available.")

    if interpretation.scope not in available:
        return Reply("unsupported", f"Scope {interpretation.scope} is not available.")

    filters = interpretation.filters
    used = {name for name in _REGISTRY_FILTER_FIELDS if _filter_set(filters, name)}
    unsupported = sorted(used - available)
    if unsupported:
        return Reply(
            "unsupported",
            "That request needs filters the server does not support: " + ", ".join(unsupported),
        )

    if filters.total_length is not None and "target_seconds" in used:
        return Reply(
            "unsupported",
            "Send total_length or target_seconds, not both.",
        )

    if filters.sound and ("sound" not in available or not filters.sound.strip()):
        # Handled by the registry check above; keep a clear refusal for negated descriptions.
        return Reply("unsupported", "That description cannot be used to search.")

    song_ids, question = _lookup(interpretation.named_songs, catalogue)
    if question is not None:
        return Reply("clarify", question)

    # The contract has no title filter. A named song is either the song to compare with
    # ("songs like Night Bus") or a request for those songs, which becomes a preview of just
    # them in scope proposal. The engine rejects proposal_ids outside that scope.
    scope = interpretation.scope
    context = Context()
    if song_ids and filters.similar_to_current:
        if len(song_ids) != 1:
            return Reply("clarify", "Which one song should I compare with?")
        context = Context(reference_id=song_ids[0])
    elif song_ids:
        if scope != "library":
            return Reply("unsupported", "I can't pick named songs out of this list yet.")
        if "proposal" not in available:
            return Reply("unsupported", "Previewing named songs is not available.")
        scope = "proposal"
        context = Context(proposal_ids=song_ids)

    total_length = (
        TotalLength.model_validate(
            {
                "mode": filters.total_length.mode,
                "seconds": filters.total_length.seconds,
            }
        )
        if filters.total_length is not None
        else None
    )

    intent_filters = Filters(
        artists=filters.artists,
        exclude_artists=filters.exclude_artists,
        genres=filters.genres,
        year_from=filters.year_from,
        year_to=filters.year_to,
        favourites=filters.favourites,
        history=filters.history,
        exclude_played_days=filters.exclude_played_days,
        min_seconds=filters.min_seconds,
        max_seconds=filters.max_seconds,
        target_seconds=filters.target_seconds,
        total_length=total_length,
        limit=filters.limit,
        similar_to_current=filters.similar_to_current,
        tempo=filters.tempo,
        tempo_min=filters.tempo_min,
        tempo_max=filters.tempo_max,
        energy=filters.energy,
        energy_compared=filters.energy_compared,
        tempo_compared=filters.tempo_compared,
        sound=filters.sound,
    )

    return Intent(
        contract_version=CONTRACT_VERSION,
        action="search",
        scope=scope,
        filters=intent_filters,
        context=context,
        explanation="",
    )


def _filter_set(filters: FilterSet, name: str) -> bool:
    """Whether a filter is set to a non-default value."""
    value: object = getattr(filters, name)
    if name == "limit":
        return value != 500
    if name == "history":
        return value != "any"
    if name in ("min_seconds", "exclude_played_days"):
        return value != 0
    if name in ("artists", "exclude_artists", "genres"):
        return bool(value)
    if name in ("year_from", "year_to", "max_seconds", "tempo_min", "tempo_max"):
        return value is not None
    if name == "total_length":
        return value is not None
    if name in ("favourites", "similar_to_current"):
        return bool(value)
    if name in ("tempo", "energy", "energy_compared", "tempo_compared", "sound"):
        return bool(value)
    return bool(value)


def _extract_json(text: str) -> str | None:
    """Return the first brace-balanced JSON object in `text`, or None."""
    start = text.find("{")
    if start == -1:
        return None
    depth = 0
    for index, char in enumerate(text[start:], start=start):
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return text[start : index + 1]
    return None


def parse_model_output(
    text: str, repair: Callable[[str], str] | None = None
) -> Interpretation | Reply:
    """Parse raw model text into an `Interpretation`.

    If the text is not valid JSON or does not match the schema, `repair` is called once with
    the original text. If that still fails, a `Reply` is returned so the chat can answer the
    user instead of running an action.
    """
    # The whole text first: the brace scan ignores strings, so a "}" inside a question would
    # cut a valid answer short.
    for source in dict.fromkeys(item for item in (text.strip(), _extract_json(text)) if item):
        try:
            return Interpretation.model_validate_json(source)
        except ValidationError:
            pass

    if repair is not None:
        try:
            repaired = repair(text)
        except Exception:
            # The repair is a second model call. A timeout or outage there must still end in a
            # reply, never an error the chat can't show.
            repaired = ""
        if isinstance(repaired, str):
            result = parse_model_output(repaired, repair=None)
            if isinstance(result, Interpretation):
                return result

    return Reply("unsupported", "The model's answer could not be read. Please try again.")
