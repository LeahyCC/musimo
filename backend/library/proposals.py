"""Engine-owned proposals: a stored, revisable selection that a client approves and commits.

A proposal is made and refined by `Engine.run`, so preview and refinement write only the
proposal tables. A commit never runs selection again. It rechecks what the approved songs
depend on and either refuses with `proposal_stale` or saves exactly those ids in that order,
once per operation id. The browser owns the live queue, so a queue commit only hands the ids
back with a receipt; nothing here plays, queues or records a play.
"""

import re
from collections.abc import Callable

from backend.library.engine import ATTEMPTS, Engine, _digest, _row, parse_body, parse_intent
from backend.library.engine_contract import (
    CONTRACT_VERSION,
    ENGINE_VERSION,
    Commit,
    EngineError,
    ErrorField,
    Intent,
    PlaylistTarget,
    Receipt,
    Refine,
)
from backend.library.music_bot import MusicBot
from backend.library.player import LibraryView

PROPOSAL_ID = re.compile(r"^pr-[0-9a-f]{16}$")
# A stale refusal names at most this many changes, and says how many there were.
STALE_FIELDS = 50
_SCALAR_FIELDS = ("tempo", "tempo_min", "tempo_max", "energy", "energy_compared", "tempo_compared")
# Check values that are not digests.
_MISSING = "missing"
_UNPLAYABLE = "unplayable"
_CHANGED = {
    "": "Tags, length or file changed",
    "history": "Play history changed",
    "liked": "Like changed",
    "scalar": "Measurement changed",
    "embedding": "Measurement changed",
}


class Cancelled(Exception):
    """The client went away before anything was written."""


def _not_found(proposal_id: str) -> EngineError:
    return EngineError(
        "proposal_not_found",
        "There is no such proposal. It may be older than the ones kept. Ask again.",
        404,
        [ErrorField(field="proposal_id", message=proposal_id)],
    )


class Proposals:
    def __init__(self, bot: MusicBot):
        self.bot = bot
        self.engine = Engine(bot)

    def create(self, raw: object, cancelled: Callable[[], bool]) -> dict[str, object]:
        intent = parse_intent(raw)
        return self._save(None, 0, intent, cancelled)

    def refine(
        self, proposal_id: str, raw: object, cancelled: Callable[[], bool]
    ) -> dict[str, object]:
        body = parse_body(Refine, raw, (), "invalid_request")
        intent = parse_intent(body.intent, "intent.")
        base = self._revision(proposal_id, body.revision)
        latest = base["latest"]
        assert isinstance(latest, int)
        if body.revision != latest:
            raise self._superseded(latest)
        if intent.scope == "proposal":
            if intent.context.proposal_ids:
                raise EngineError(
                    "invalid_intent",
                    "A refinement uses the stored revision's songs. Leave proposal_ids out.",
                    422,
                    [ErrorField(field="intent.context.proposal_ids", message="Not allowed")],
                )
            ids = base["ids"]
            assert isinstance(ids, list)
            context = intent.context.model_copy(update={"proposal_ids": ids})
            intent = intent.model_copy(update={"context": context})
        return self._save(proposal_id, body.revision, intent, cancelled)

    def read(self, proposal_id: str, revision: int | None) -> dict[str, object]:
        return self._public(self._revision(proposal_id, revision), self.bot.player.view())

    def commit(
        self, proposal_id: str, raw: object, cancelled: Callable[[], bool]
    ) -> dict[str, object]:
        """Save or hand back exactly the approved revision. The order of the refusals matters:
        a retried operation id answers first, so a retry is never refused for staleness after
        its first attempt went through."""
        body = parse_body(Commit, raw, (CONTRACT_VERSION,), "invalid_request")
        target = body.target.kind
        wanted = {"proposal_id": proposal_id, "revision": body.revision, "target": target}
        first = self.bot.store.proposal_receipt(body.operation_id)
        if first is not None:
            return self._replayed(first, wanted)
        stored = self._revision(proposal_id, body.revision)
        latest = stored["latest"]
        assert isinstance(latest, int)
        if body.revision != latest and not body.older_revision:
            raise self._superseded(latest)
        ids = stored["ids"]
        assert isinstance(ids, list)
        if not ids:
            raise EngineError("empty_proposal", "The proposal has no songs to commit.", 422)
        revision = self.bot.store.library_revision()
        intent = Intent.model_validate(stored["intent"])
        checks = stored["checks"]
        assert isinstance(checks, dict)
        changed = self._stale(checks, self._checks(intent, ids, self.bot.player.view()))
        if changed:
            raise EngineError(
                "proposal_stale",
                f"{len(changed)} thing{'s' if len(changed) != 1 else ''} the proposal depends on "
                "changed. Nothing was saved. Refresh the preview.",
                409,
                changed[:STALE_FIELDS],
            )
        name = body.target.name if isinstance(body.target, PlaylistTarget) else None
        status = "saved" if name is not None else "ready_for_player"
        receipt = {
            "operation_id": body.operation_id,
            **wanted,
            "ids": ids,
            "status": status,
        }
        store = self.bot.store
        # Held from the last checks to the write, so a second commit cannot slip between. The
        # library view is never built under it.
        with store.lock:
            if store.library_revision() != revision:
                raise EngineError(
                    "snapshot_changed", "The library changed during the commit. Try again.", 409
                )
            earlier = store.proposal_receipts(proposal_id, body.revision, target)
            if earlier and not body.repeat:
                raise EngineError(
                    "already_committed",
                    f"This revision already went to the {target}. Send repeat to do it again.",
                    409,
                    [ErrorField(field="operation_id", message=earlier[0])],
                )
            if cancelled():
                raise Cancelled
            saved, replayed = store.record_receipt(receipt, name)
        if replayed:
            return self._replayed(saved, wanted)
        return self._receipt(saved, False)

    def _save(
        self, proposal_id: str | None, base: int, intent: Intent, cancelled: Callable[[], bool]
    ) -> dict[str, object]:
        if intent.action != "search":
            raise EngineError(
                "invalid_intent",
                "A proposal is made from a search. Pause, resume and skip stay immediate.",
                422,
                [ErrorField(field="action", message="Must be search")],
            )
        for _ in range(ATTEMPTS):
            result = self.engine.run(intent)
            ids = result["ids"]
            snapshot = result["snapshot"]
            assert isinstance(ids, list) and isinstance(snapshot, dict)
            ran = Intent.model_validate(result["intent"])
            checks = self._checks(ran, ids, self.bot.player.view())
            # The checks are read after run, so they count only if nothing moved in between.
            if self.engine.unchanged(intent, snapshot):
                break
        else:
            raise EngineError(
                "snapshot_changed", "The library changed while the request ran. Try again.", 409
            )
        row: dict[str, object] = {
            "intent": result["intent"],
            "seed": result["seed"],
            "ids": ids,
            "snapshot": snapshot,
            "checks": checks,
            "totals": {
                "total_seconds": result["total_seconds"],
                "shortfall_seconds": result["shortfall_seconds"],
                "summary": result["summary"],
            },
        }
        if cancelled():
            raise Cancelled
        saved = self.bot.store.save_proposal(proposal_id, base, row)
        if saved is None:
            stored = self.bot.store.proposal_revision(proposal_id or "", None)
            if stored is None:
                raise _not_found(proposal_id or "")
            latest = stored["latest"]
            assert isinstance(latest, int)
            raise self._superseded(latest)
        found = self.bot.store.proposal_revision(*saved)
        assert found is not None
        return self._public(found, self.bot.player.view())

    def _revision(self, proposal_id: str, revision: int | None) -> dict[str, object]:
        found = (
            self.bot.store.proposal_revision(proposal_id, revision)
            if PROPOSAL_ID.match(proposal_id)
            else None
        )
        if found is None:
            raise _not_found(proposal_id)
        if found["revision"] is None:
            raise EngineError(
                "revision_not_found",
                f"The proposal has no revision {revision}. Older revisions are not all kept.",
                404,
                [ErrorField(field="revision", message=f"Latest is {found['latest']}")],
            )
        return found

    def _checks(self, intent: Intent, ids: list[str], view: LibraryView) -> dict[str, str]:
        """What the approved songs depend on, keyed by part: each song's file, tags and length,
        and only where the intent reads them its play history, its like, its measurements,
        the local day and the audio recipe. A reference a comparison used is checked the same
        way. A commit compares these and nothing else, so a song added elsewhere in the
        library does not make a proposal stale."""
        bot = self.bot
        filters = intent.filters
        scalar, embedding = bot.active_recipes()
        uses_scalar = any(getattr(filters, name) for name in _SCALAR_FIELDS)
        uses_embedding = bool(filters.sound) or (
            filters.similar_to_current and embedding is not None
        )
        history = filters.history != "any" or filters.exclude_played_days > 0
        liked = bot._liked() if filters.favourites else set()
        rows = {
            "scalar": bot.profiles.profiles(scalar) if uses_scalar and scalar else None,
            "embedding": bot.profiles.profiles(embedding) if uses_embedding and embedding else None,
        }
        checks: dict[str, str] = {}
        if filters.exclude_played_days:
            checks["local_day"] = self.engine.today()
        if uses_scalar:
            checks["audio.scalar"] = scalar.id if scalar else ""
        if uses_embedding:
            checks["audio.embedding"] = embedding.id if embedding else ""
        compares = filters.similar_to_current or filters.energy_compared or filters.tempo_compared
        reference = intent.context.reference_id or intent.context.current_id
        songs = [(f"songs.{sid}", sid) for sid in ids]
        if compares and reference:
            songs.append((f"reference.{reference}", reference))
        for key, sid in songs:
            song = view.stored.get(sid)
            if song is None:
                checks[key] = _MISSING
                continue
            if key.startswith("songs.") and bot.player.local_file(sid) is None:
                checks[key] = _UNPLAYABLE
                continue
            checks[key] = _digest(
                [
                    _row(
                        song.size,
                        song.mtime_ns,
                        song.title,
                        song.artist,
                        song.genre,
                        list(song.genres),
                        song.year,
                        repr(song.duration),
                    )
                ]
            )
            if history:
                checks[f"{key}.history"] = _row(song.play_count, song.last_played)
            if filters.favourites:
                checks[f"{key}.liked"] = str(sid in liked)
            for part, found in rows.items():
                if found is None:
                    continue
                row = found.rows.get(sid)
                checks[f"{key}.{part}"] = _row(
                    *(
                        (
                            row.status,
                            row.size,
                            row.mtime_ns,
                            repr(row.tempo_bpm),
                            repr(row.energy),
                            row.dim,
                            row.vector_length,
                        )
                        if row is not None
                        else ()
                    )
                )
        return checks

    def _stale(self, stored: dict[str, object], now: dict[str, str]) -> list[ErrorField]:
        """Each part whose value moved, in the stored order, said in words."""
        changed: list[ErrorField] = []
        for key, before in stored.items():
            after = now.get(key)
            if after == before:
                continue
            if after == _MISSING:
                message = "Not in the library"
            elif after == _UNPLAYABLE:
                message = "The file is unavailable"
            elif key == "local_day":
                message = "The day changed"
            elif key.startswith("audio."):
                message = "Audio setting changed"
            else:
                suffix = key.split(".")[2] if key.count(".") >= 2 else ""
                message = _CHANGED.get(suffix, "Changed")
            changed.append(ErrorField(field=key, message=message))
        return changed

    def _superseded(self, latest: int) -> EngineError:
        return EngineError(
            "revision_superseded",
            f"Revision {latest} is the latest. Use it, or send older_revision to commit an "
            "older one on purpose.",
            409,
            [ErrorField(field="revision", message=f"Latest is {latest}")],
        )

    def _replayed(self, first: dict[str, object], wanted: dict[str, object]) -> dict[str, object]:
        """The first receipt of a retried operation, or a refusal when the id was used for
        something else."""
        if {key: first[key] for key in wanted} != wanted:
            raise EngineError(
                "operation_conflict",
                "That operation id already committed something else. Use a new one.",
                409,
                [ErrorField(field="operation_id", message="Already used")],
            )
        return self._receipt(first, True)

    def _receipt(self, receipt: dict[str, object], replayed: bool) -> dict[str, object]:
        return {
            "contract_version": CONTRACT_VERSION,
            "status": "ok",
            "receipt": Receipt.model_validate(receipt).model_dump(),
            # True when this is a retry and nothing new was written.
            "replayed": replayed,
        }

    def _public(self, found: dict[str, object], view: LibraryView) -> dict[str, object]:
        """A revision with its full ordered list. Track cards come from the library as it is
        now, so an id since removed is listed in missing_ids instead."""
        ids = found["ids"]
        totals = found["totals"]
        assert isinstance(ids, list) and isinstance(totals, dict)
        return {
            "contract_version": CONTRACT_VERSION,
            "engine_version": ENGINE_VERSION,
            "status": "ok",
            "proposal": {
                "id": found["id"],
                "revision": found["revision"],
                "latest_revision": found["latest"],
                "created": found["created"],
                # The intent as it ran, with the seed it drew, so posting it to the intent
                # route repeats the selection against the same snapshot.
                "intent": found["intent"],
                "seed": found["seed"],
                "ids": ids,
                **totals,
                "snapshot": found["snapshot"],
            },
            "tracks": [view.by_song[sid] for sid in ids if sid in view.by_song],
            "missing_ids": [sid for sid in ids if sid not in view.by_song],
            # Only the proposal tables were written. Nothing was played, queued or saved.
            "state_changed": False,
        }
