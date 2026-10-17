"""The structured entry point: a canonical intent in, real song ids and their snapshot out.

This wraps `MusicBot.resolve`; it adds no selection rule of its own. It calls no model and
writes nothing: not the queue, a playlist, play history or a receipt. A request it cannot
honour is refused with a typed error, never loosened until it succeeds.
"""

import hashlib
import json
from collections.abc import Iterable
from datetime import datetime
from zoneinfo import ZoneInfo

from pydantic import ValidationError

from backend.core.audio_recipes import Recipe
from backend.library.audio_profile import ProfileSet
from backend.library.engine_contract import (
    CONTRACT_VERSION,
    ENGINE_VERSION,
    SUPPORTED_VERSIONS,
    EngineError,
    ErrorField,
    Intent,
    registry,
)
from backend.library.music_bot import BotError, BotRequest, MusicBot, SearchPlan, negation_only
from backend.library.player import LibraryView

# resolve never reads the prompt; BotRequest needs some text.
_PROMPT = "structured intent"
# A snapshot that moves under a request is read again this many times before giving up.
ATTEMPTS = 3
_SCALAR_FIELDS = ("tempo", "tempo_min", "tempo_max", "energy", "energy_compared", "tempo_compared")


def parse_intent(raw: object) -> Intent:
    """A decoded JSON body as an Intent, or the typed error that says why not."""
    if not isinstance(raw, dict):
        raise EngineError("malformed_request", "The body must be a JSON object.", 400)
    version = raw.get("contract_version")
    if version is None:
        raise EngineError(
            "malformed_request",
            "contract_version is required.",
            400,
            [ErrorField(field="contract_version", message="Field required")],
        )
    if type(version) is not int or version not in SUPPORTED_VERSIONS:
        raise EngineError(
            "unsupported_version",
            f"Contract version is not supported. Supported: {list(SUPPORTED_VERSIONS)}.",
            422,
            [ErrorField(field="contract_version", message="Unsupported")],
        )
    try:
        return Intent.model_validate(raw)
    except ValidationError as exc:
        found = exc.errors(include_input=False, include_url=False)
        unknown = [
            ErrorField(field=".".join(str(part) for part in item["loc"]), message="Unknown field")
            for item in found
            if item["type"] == "extra_forbidden"
        ]
        if unknown:
            raise EngineError(
                "unknown_field", "The intent has fields this engine does not know.", 422, unknown
            ) from exc
        raise EngineError(
            "invalid_intent",
            "The intent is not valid.",
            422,
            [
                ErrorField(field=".".join(str(part) for part in item["loc"]), message=item["msg"])
                for item in found[:10]
            ],
        ) from exc


def _digest(parts: Iterable[str]) -> str:
    hasher = hashlib.blake2b(digest_size=16)
    for part in parts:
        hasher.update(part.encode())
        hasher.update(b"\n")
    return hasher.hexdigest()


def _catalogue(view: LibraryView) -> tuple[str, str]:
    """Digests of what a song is (what the filters and the duplicate rule read, and the file
    it was measured from) and of its play history, both independent of the order read."""
    songs = sorted(view.stored.values(), key=lambda song: song.song_id)
    what = _digest(
        f"{s.song_id}|{s.size}|{s.mtime_ns}|{s.title}|{s.artist}|{s.genre}|"
        f"{'/'.join(s.genres)}|{s.year}|{s.duration!r}"
        for s in songs
    )
    played = _digest(
        f"{s.song_id}|{s.play_count}|{s.last_played}"
        for s in songs
        if s.play_count or s.last_played
    )
    return what, played


def _profiles(recipe: Recipe | None, rows: ProfileSet | None) -> dict[str, object]:
    """A recipe is deterministic and a changed recipe gets a new id, so the id and the state
    of each row (which file it was measured from) stand for the measured values."""
    if recipe is None or rows is None:
        return {"recipe": "", "digest": ""}
    return {
        "recipe": recipe.id,
        "digest": _digest(
            f"{p.song_id}|{p.status}|{p.size}|{p.mtime_ns}|{p.tempo_bpm!r}|{p.energy!r}|"
            f"{p.dim}|{p.vector_length}"
            for p in sorted(rows.rows.values(), key=lambda p: p.song_id)
        ),
    }


class Engine:
    def __init__(self, bot: MusicBot):
        self.bot = bot

    def capabilities(self) -> dict[str, object]:
        return {
            "contract_version": CONTRACT_VERSION,
            "engine_version": ENGINE_VERSION,
            "capabilities": [item.public() for item in registry(*self.bot.active_recipes())],
        }

    def run(self, intent: Intent) -> dict[str, object]:
        """Resolve one intent. Everything it reads is captured with the result, and a read
        that changed underneath it is repeated, so the snapshot is the one the ids came from."""
        plan = self._plan(intent)
        scalar, embedding = self.bot.active_recipes()
        self._check_capabilities(intent, scalar, embedding)
        self._check_songs(intent, self.bot.player.view())
        request = BotRequest(
            prompt=_PROMPT,
            proposal_ids=intent.context.proposal_ids,
            queue_ids=intent.context.queue_ids,
            current_id=intent.context.current_id,
            reference_id=intent.context.reference_id,
            generation_seed=intent.seed,
            shown_ids=intent.context.shown_ids,
        )
        for _ in range(ATTEMPTS):
            now = datetime.now(ZoneInfo(self.bot.store.current().music_timezone))
            before = self._snapshot(intent, now)
            try:
                reply = self.bot.resolve(plan, request, now)
            except BotError as exc:
                raise EngineError("engine_rejected", exc.detail, exc.status) from exc
            if before == self._snapshot(intent, now):
                return self._result(intent, reply, before)
        raise EngineError(
            "snapshot_changed", "The library changed while the request ran. Try again.", 409
        )

    def _check_capabilities(
        self, intent: Intent, scalar: Recipe | None, embedding: Recipe | None
    ) -> None:
        filters = intent.filters
        off: list[str] = []
        if scalar is None:
            off += [name for name in _SCALAR_FIELDS if getattr(filters, name)]
        if filters.sound and (embedding is None or not embedding.text_aligned):
            off.append("sound")
        if off:
            raise EngineError(
                "unsupported_capability",
                "Those filters need audio analysis that is not enabled.",
                422,
                [ErrorField(field=f"filters.{name}", message="Not available") for name in off],
            )
        if filters.sound and negation_only(filters.sound):
            raise EngineError(
                "unsupported_constraint",
                "A negated description such as no vocals cannot be enforced, so it is refused "
                "rather than dropped.",
                422,
                [ErrorField(field="filters.sound", message="Negation is not supported")],
            )
        if filters.sound and filters.similar_to_current:
            raise EngineError(
                "unsupported_constraint",
                "A description beside similar_to_current would be dropped. Send one of them.",
                422,
                [ErrorField(field="filters.sound", message="Conflicts with similar_to_current")],
            )
        if intent.action != "search":
            blank = (
                filters.model_dump() == type(filters)().model_dump()
                and intent.scope == "library"
                and intent.seed is None
                and not intent.context.proposal_ids
                and not intent.context.queue_ids
            )
            if not blank:
                raise EngineError(
                    "invalid_intent",
                    f"{intent.action} takes no filters, scope, seed or selection.",
                    422,
                )
        elif intent.explanation:
            raise EngineError(
                "invalid_intent",
                "explanation is only for clarify and unsupported.",
                422,
                [ErrorField(field="explanation", message="Not allowed for search")],
            )

    def _check_songs(self, intent: Intent, view: LibraryView) -> None:
        """Song ids are opaque and must exist. The shown list is memory and is exempt."""
        context = intent.context
        if intent.scope != "proposal" and context.proposal_ids:
            raise EngineError(
                "invalid_intent",
                "proposal_ids belong to scope proposal.",
                422,
                [ErrorField(field="context.proposal_ids", message="Wrong scope")],
            )
        if intent.scope != "queue" and context.queue_ids:
            raise EngineError(
                "invalid_intent",
                "queue_ids belong to scope queue.",
                422,
                [ErrorField(field="context.queue_ids", message="Wrong scope")],
            )
        unknown = [
            ErrorField(field=f"context.{name}", message="Not in the library")
            for name, ids in (
                ("current_id", [context.current_id] if context.current_id else []),
                ("reference_id", [context.reference_id] if context.reference_id else []),
                ("proposal_ids", context.proposal_ids),
                ("queue_ids", context.queue_ids),
            )
            if any(sid not in view.stored for sid in ids)
        ]
        if unknown:
            raise EngineError(
                "unknown_song", "Those song ids are not in the library.", 422, unknown
            )
        if intent.action != "search":
            return
        if intent.scope != "library" and not (context.proposal_ids or context.queue_ids):
            raise EngineError(
                "no_selection",
                "There is no selection to refine. Send the songs, or search the library.",
                422,
            )
        filters = intent.filters
        needs = filters.similar_to_current or filters.energy_compared or filters.tempo_compared
        if needs and not (context.reference_id or context.current_id):
            raise EngineError(
                "missing_reference",
                "Choose a current or reference song to compare with.",
                422,
                [ErrorField(field="context.reference_id", message="Required")],
            )

    def _plan(self, intent: Intent) -> SearchPlan:
        try:
            return SearchPlan.model_validate(
                {
                    "action": intent.action,
                    "scope": intent.scope,
                    "change_filters": [],
                    "allow_artists": [],
                    "add_count": 0,
                    "explanation": intent.explanation,
                    **intent.filters.model_dump(),
                }
            )
        except ValidationError as exc:
            raise EngineError(
                "invalid_intent",
                "The filters conflict.",
                422,
                [
                    ErrorField(
                        field=".".join(["filters", *(str(p) for p in item["loc"])]),
                        message=item["msg"],
                    )
                    for item in exc.errors(include_input=False, include_url=False)[:10]
                ],
            ) from exc

    def _snapshot(self, intent: Intent, now: datetime) -> dict[str, object]:
        """Every input besides the intent that decides the ids. A seed alone is not enough:
        the same seed over another catalogue, history, likes, reference, day or shown list is
        another selection. The files on disk are read as they are when songs are filled, and
        are not part of this."""
        bot = self.bot
        view = bot.player.view()
        scalar, embedding = bot.active_recipes()
        what, played = _catalogue(view)
        liked = sorted(bot._liked())
        shown = intent.context.shown_ids
        body: dict[str, object] = {
            "engine_version": ENGINE_VERSION,
            "contract_version": CONTRACT_VERSION,
            "catalogue": {"revision": view.revision, "songs": len(view.stored), "digest": what},
            "history": {"digest": played},
            "likes": {"count": len(liked), "digest": _digest(liked)},
            "audio": {
                "scalar": _profiles(
                    scalar, bot.profiles.profiles(scalar) if scalar is not None else None
                ),
                "embedding": _profiles(
                    embedding, bot.profiles.profiles(embedding) if embedding is not None else None
                ),
            },
            "reference_id": intent.context.reference_id,
            "current_id": intent.context.current_id,
            "local_day": now.date().isoformat(),
            "timezone": bot.store.current().music_timezone,
            "shown": {
                "count": len(shown),
                "unknown": sum(1 for sid in shown if sid not in view.stored),
                "digest": _digest(shown),
            },
        }
        return body

    def _result(
        self, intent: Intent, reply: dict[str, object], snapshot: dict[str, object]
    ) -> dict[str, object]:
        plan = SearchPlan.model_validate(reply["plan"])
        if plan.action != intent.action:
            # resolve turned the search into a refusal. Said as an error, not as a result.
            raise EngineError("unsupported_capability", plan.explanation or "Refused.", 422)
        tracks = reply["tracks"]
        assert isinstance(tracks, list)
        # The seed is drawn inside resolve when the intent has none, so it joins the snapshot
        # after the two reads. It is what makes the draw repeatable.
        full = snapshot | {"seed": reply["generation_seed"]}
        return {
            "contract_version": CONTRACT_VERSION,
            "engine_version": ENGINE_VERSION,
            "status": "ok",
            "action": plan.action,
            "scope": plan.scope,
            "ids": [str(track["id"]) for track in tracks],
            "tracks": tracks,
            "total_seconds": reply["total_seconds"],
            "shortfall_seconds": reply["shortfall_seconds"],
            "summary": reply["summary"],
            "seed": reply["generation_seed"],
            "snapshot": full | {"id": _digest([json.dumps(full, sort_keys=True)])},
            "intent": intent.model_dump(),
            "plan": reply["plan"],
            # Nothing was played, queued, saved or recorded.
            "state_changed": False,
        }
