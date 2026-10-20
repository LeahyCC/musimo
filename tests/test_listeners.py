"""Names share one library. The first name keeps what is already here. A later name starts empty."""

import asyncio
import tempfile
import threading
import unittest
from pathlib import Path

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient
from test_holdings import index_file

from backend.api.download_api import install_download_routes
from backend.core.listener import CHOOSE, HEADER, ForeignListener, ListenerNameError, scope
from backend.core.store import Store, drop_song_references
from backend.integrations.catalog import Catalog, Result
from backend.jobs.account_listen import BUSY, CACHE_DIR
from backend.jobs.account_lock import AccountBusy, hold
from backend.jobs.downloads import Downloads
from backend.jobs.holdings import ensure_holding
from backend.library.engine_contract import CONTRACT_VERSION, EngineError
from backend.library.index import Library
from backend.library.player import Player
from backend.library.proposals import Proposals
from backend.main import create_app

SONG = "tr-aaaaaaaaaaaaaaaa"


def _song(store: Store, root: str = "/music") -> None:
    store.db.execute("INSERT INTO library_roots(path, enabled) VALUES (?, 1)", (root,))
    store.db.execute(
        "INSERT INTO library_files(path,root,mtime_ns,size,generation,title,artist,album,"
        "title_key,artist_key,album_key,duration,isrc,mbid,song_id,play_count,last_played) "
        "VALUES (?,?,1,2,'g','Kept','Artist','Album','kept','artist','album',42,'','',?,?,?)",
        (str(Path(root) / "kept.wav"), root, SONG, 4, "2026-01-01T00:00:00Z"),
    )
    store.db.commit()


class ListenerStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self._tmp.name) / "db.sqlite3")
        _song(self.store)

    def tearDown(self) -> None:
        self.store.close()
        self._tmp.cleanup()

    def test_the_first_name_keeps_today_and_the_second_starts_empty(self) -> None:
        self.store.write_play_queue([SONG], SONG, 1500)
        playlist = self.store.create_playlist("Road", [SONG])
        liked = self.store.create_playlist("Liked", [SONG])
        self.store.set_linked_playlist("liked", f"pl-{liked['id']}")
        self.store.set_artist_favourite("ar-aaaaaaaaaaaaaaaa", True)
        self.store.record_shown("shown-1", [SONG])
        first = self.store.create_listener("Colin")
        second = self.store.create_listener("Sam")
        self.assertTrue(str(first["id"]).startswith("ln-"))
        self.assertEqual(len(str(first["id"])), 19)

        with scope(str(first["id"])):
            queue = self.store.read_play_queue()
            self.assertEqual(queue["song_ids"], [SONG])
            self.assertEqual(queue["position"], 1500)
            names = {str(row["name"]) for row in self.store.list_playlists()}
            self.assertEqual(names, {"Road", "Liked"})
            self.assertEqual(self.store.linked_playlist("liked"), f"pl-{liked['id']}")
            self.assertIn("ar-aaaaaaaaaaaaaaaa", self.store.artist_favourites())
            self.assertEqual(self.store.plays_for(str(first["id"]))[SONG][0], 4)
            self.assertEqual(self.store.shown_memory()[1], [SONG])
            self.assertEqual(self.store.shown_profile(), first["id"])
            self.assertTrue(self.store.record_play(SONG))
            self.assertEqual(self.store.plays_for(str(first["id"]))[SONG][0], 5)

        with scope(str(second["id"])):
            self.assertEqual(self.store.read_play_queue()["song_ids"], [])
            rows = self.store.list_playlists()
            self.assertEqual([str(row["name"]) for row in rows], ["Liked"])
            self.assertEqual(int(rows[0]["song_count"]), 0)
            self.assertEqual(self.store.linked_playlist("liked"), f"pl-{rows[0]['id']}")
            self.assertEqual(self.store.artist_favourites(), {})
            self.assertEqual(self.store.plays_for(str(second["id"])), {})
            self.assertEqual(self.store.shown_memory(), (0, []))
            self.assertIsNone(self.store.playlist(int(str(playlist["id"]))))

        # The file columns stay, and they are no longer the count that is read.
        file_count = self.store.db.execute(
            "SELECT play_count FROM library_files WHERE song_id=?", (SONG,)
        ).fetchone()[0]
        self.assertEqual(file_count, 4)

    def test_a_blank_a_long_name_and_a_duplicate_stay_refused(self) -> None:
        with self.assertRaises(ListenerNameError) as blank:
            self.store.create_listener("   ")
        self.assertEqual(str(blank.exception), "Enter a name.")
        self.assertEqual(blank.exception.status, 422)
        with self.assertRaises(ListenerNameError) as long:
            self.store.create_listener("n" * 41)
        self.assertEqual(str(long.exception), "Use 40 characters or fewer.")
        self.store.create_listener("n" * 40)
        with self.assertRaises(ListenerNameError) as duplicate:
            self.store.create_listener("N" * 40)
        self.assertEqual(str(duplicate.exception), "That name is already in use.")
        self.assertEqual(duplicate.exception.status, 409)

    def test_two_creates_at_once_give_the_existing_data_to_one_name(self) -> None:
        self.store.write_play_queue([SONG], SONG, 10)
        barrier = threading.Barrier(2)
        found: list[dict[str, str]] = []

        def create(name: str) -> None:
            barrier.wait()
            found.append(self.store.create_listener(name))

        threads = [threading.Thread(target=create, args=(name,)) for name in ("Colin", "Sam")]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(len(found), 2)
        owners = []
        for row in found:
            with scope(row["id"]):
                if self.store.read_play_queue()["song_ids"] == [SONG]:
                    owners.append(row["id"])
        self.assertEqual(len(owners), 1)

    def test_a_stale_writer_on_one_name_does_not_reject_the_other(self) -> None:
        first = str(self.store.create_listener("Colin")["id"])
        second = str(self.store.create_listener("Sam")["id"])
        with scope(first):
            epoch = self.store.begin_queue_writer()
            self.assertTrue(self.store.write_play_queue([SONG], SONG, 1, epoch, 1))
        with scope(second):
            other = self.store.begin_queue_writer()
            self.assertTrue(self.store.write_play_queue([SONG], "", 0, other, 1))
        with scope(first):
            self.assertFalse(self.store.write_play_queue([], "", 0, epoch, 1))
            self.assertEqual(self.store.read_play_queue()["current"], SONG)
        with scope(second):
            self.assertEqual(self.store.read_play_queue()["current"], "")

    def test_deleting_a_file_clears_every_name_and_the_house_holding(self) -> None:
        first = str(self.store.create_listener("Colin")["id"])
        second = str(self.store.create_listener("Sam")["id"])
        with scope(first):
            self.store.create_playlist("Road", [SONG])
            self.store.write_play_queue([SONG], SONG, 1)
        with scope(second):
            liked = self.store.linked_playlist("liked")
            assert liked is not None
            number = int(liked.removeprefix("pl-"))
            self.store.add_playlist_song(number, SONG)
            self.store.write_play_queue([SONG], SONG, 2)
        with self.store.lock:
            self.store.db.execute("BEGIN IMMEDIATE")
            ensure_holding(self.store.db, "deezer", 9, SONG, "/music/kept.wav", "chosen")
            drop_song_references(self.store.db, [SONG])
            self.store.db.commit()
        with scope(first):
            road = next(row for row in self.store.list_playlists() if row["name"] == "Road")
            self.assertEqual(road["song_count"], 0)
            self.assertEqual(self.store.read_play_queue()["song_ids"], [])
        with scope(second):
            self.assertEqual(self.store.read_play_queue()["song_ids"], [])
            detail = self.store.playlist(number)
            assert detail is not None
            self.assertEqual(detail["song_ids"], [])
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM holdings").fetchone()[0], 0)
        left = self.store.db.execute(
            "SELECT count(*) FROM listener_plays WHERE song_id=?", (SONG,)
        ).fetchone()[0]
        self.assertEqual(left, 0)

    def test_a_holding_is_one_row_for_every_name(self) -> None:
        columns = [str(row[1]) for row in self.store.db.execute("PRAGMA table_info(holdings)")]
        self.assertNotIn("listener_id", columns)
        first = str(self.store.create_listener("Colin")["id"])
        second = str(self.store.create_listener("Sam")["id"])
        with scope(first):
            with self.store.lock:
                self.store.db.execute("BEGIN IMMEDIATE")
                row = ensure_holding(self.store.db, "deezer", 9, SONG, "/music/kept.wav", "chosen")
                self.store.db.commit()
        with scope(second):
            with self.store.lock:
                self.store.db.execute("BEGIN IMMEDIATE")
                again = ensure_holding(
                    self.store.db, "deezer", 9, SONG, "/music/kept.wav", "chosen"
                )
                self.store.db.commit()
        self.assertEqual(again["id"], row["id"])
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM holdings").fetchone()[0], 1)

    def test_import_refuses_until_a_name_is_given_and_one_name_is_implicit(self) -> None:
        self.assertEqual(self.store.import_target(None), "")
        only = str(self.store.create_listener("Colin")["id"])
        with self.store.lock:
            self.store.db.execute("BEGIN IMMEDIATE")
            try:
                self.assertEqual(self.store.import_target(None), only)
                self.assertEqual(self.store.import_target("colin"), only)
                self.store.db.commit()
            except Exception:
                self.store.db.rollback()
                raise
        self.store.create_listener("Sam")
        with self.store.lock:
            self.store.db.execute("BEGIN IMMEDIATE")
            try:
                with self.assertRaisesRegex(ValueError, "Name the listener to import into"):
                    self.store.import_target(None)
                with self.assertRaisesRegex(ValueError, "No listener by that name"):
                    self.store.import_target("Nobody")
                self.store.db.commit()
            except Exception:
                self.store.db.rollback()
                raise


class ProposalOwnerTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self._tmp.name) / "db.sqlite3")
        self.first = str(self.store.create_listener("Colin")["id"])
        self.second = str(self.store.create_listener("Sam")["id"])

    def tearDown(self) -> None:
        self.store.close()
        self._tmp.cleanup()

    def test_another_name_cannot_read_or_retry_a_proposal(self) -> None:
        with scope(self.first):
            saved = self.store.save_proposal(
                None,
                0,
                {
                    "intent": {},
                    "seed": 1,
                    "ids": [SONG],
                    "snapshot": {},
                    "checks": {},
                    "totals": {},
                },
            )
            assert isinstance(saved, tuple)
            proposal_id, revision = saved
            receipt = {
                "operation_id": "op-owner-01",
                "proposal_id": proposal_id,
                "revision": revision,
                "target": "queue",
                "playlist_name": None,
                "ids": [SONG],
                "status": "ready_for_player",
            }
            stored, replayed = self.store.record_receipt(receipt, None)
            self.assertFalse(replayed)
        with scope(self.second):
            self.assertIsNone(self.store.proposal_revision(proposal_id, None))
            with self.assertRaises(ForeignListener):
                self.store.proposal_receipt("op-owner-01")
            proposals = Proposals(_Bot(self.store))  # type: ignore[arg-type]
            with self.assertRaises(EngineError) as refused:
                proposals.commit(
                    proposal_id,
                    {
                        "contract_version": CONTRACT_VERSION,
                        "revision": revision,
                        "operation_id": "op-owner-01",
                        "target": {"kind": "queue"},
                    },
                    lambda: False,
                )
            self.assertEqual(refused.exception.code, "proposal_not_found")
        with scope(self.first):
            again = self.store.proposal_receipt("op-owner-01")
            self.assertEqual(again, stored)
            proposals = Proposals(_Bot(self.store))  # type: ignore[arg-type]
            replay = proposals.commit(
                proposal_id,
                {
                    "contract_version": CONTRACT_VERSION,
                    "revision": revision,
                    "operation_id": "op-owner-01",
                    "target": {"kind": "queue"},
                },
                lambda: False,
            )
            self.assertTrue(replay["replayed"])
            body = replay["receipt"]
            assert isinstance(body, dict)
            self.assertEqual(body["ids"], [SONG])


class _Bot:
    def __init__(self, store: Store) -> None:
        self.store = store


class AccountAndPlayTests(unittest.IsolatedAsyncioTestCase):
    async def test_an_account_listen_does_not_move_a_name_and_the_lock_is_one(self) -> None:
        self.assertEqual(CACHE_DIR, "account-listen")
        self.assertEqual(BUSY, "The Deezer account is busy.")
        with tempfile.TemporaryDirectory() as tmp:
            data = Path(tmp)
            store = Store(data / "db.sqlite3")
            try:
                _song(store, str(data))
                first = str(store.create_listener("Colin")["id"])
                store.create_listener("Sam")
                player = Player(store, [data])
                with scope(first):
                    await player.scrobble("dz-15", True)
                    await player.scrobble(SONG, True)
                self.assertEqual(
                    store.db.execute(
                        "SELECT count(*) FROM listener_plays WHERE song_id LIKE 'dz-%'"
                    ).fetchone()[0],
                    0,
                )
                self.assertEqual(store.plays_for(first)[SONG][0], 5)
                with hold(data, wait=True):
                    with self.assertRaises(AccountBusy) as busy:
                        with hold(data, wait=False):
                            pass
                self.assertEqual(str(busy.exception), "The Deezer account is busy.")
            finally:
                store.close()


class ListenerRouteTests(unittest.TestCase):
    def test_routes_require_a_known_name_once_one_exists(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            with TestClient(create_app(Path(tmp))) as client:
                early = client.get("/api/library/albums")
                self.assertEqual(early.status_code, 200)
                stale = client.get("/api/library/albums", headers={HEADER: "ln-aaaaaaaaaaaaaaaa"})
                self.assertEqual(stale.status_code, 401)
                self.assertEqual(stale.json()["detail"], CHOOSE)
                blank = client.post("/api/listeners", json={"name": "  "})
                self.assertEqual(blank.status_code, 422)
                self.assertEqual(blank.json()["detail"], "Enter a name.")
                made = client.post("/api/listeners", json={"name": "Colin"})
                self.assertEqual(made.status_code, 200)
                listener_id = made.json()["id"]
                missing = client.get("/api/player/queue")
                self.assertEqual(missing.status_code, 401)
                self.assertEqual(missing.json()["detail"], CHOOSE)
                queued = client.get("/api/player/queue", headers={HEADER: listener_id})
                self.assertEqual(queued.status_code, 200)
                again = client.post("/api/listeners", json={"name": "colin"})
                self.assertEqual(again.status_code, 409)
                self.assertEqual(again.json()["detail"], "That name is already in use.")
                listed = client.get("/api/listeners")
                self.assertEqual([row["name"] for row in listed.json()["items"]], ["Colin"])
                # House routes ignore the header.
                settings = client.get("/api/settings", headers={HEADER: listener_id})
                self.assertNotEqual(settings.status_code, 401)


class HoldingRouteTests(unittest.IsolatedAsyncioTestCase):
    async def test_post_holdings_is_the_same_row_for_either_name(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            store = Store(root / "db.sqlite3")
            try:
                library = Library(store, [root], asyncio.Event())
                house = index_file(store, root, "deluxe.flac", SONG, body=b"keep", album="Deluxe")
                item = Result(
                    id=12, kind="track", title="Song", artist="Artist", album="Album", duration=180
                )
                library.annotate([item])
                first = str(store.create_listener("Colin")["id"])
                second = str(store.create_listener("Sam")["id"])

                def upstream(request: httpx.Request) -> httpx.Response:
                    if request.url.path == "/track/12":
                        return httpx.Response(
                            200,
                            json={
                                "id": 12,
                                "title": "Song",
                                "duration": 180,
                                "isrc": "",
                                "artist": {"id": 1, "name": "Artist"},
                                "album": {"id": 2, "title": "Album"},
                            },
                        )
                    return httpx.Response(404)

                async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
                    service = Downloads(store, Catalog(store, client), library, asyncio.Event())
                    app = FastAPI()
                    install_download_routes(app, lambda: service)
                    async with httpx.AsyncClient(
                        transport=httpx.ASGITransport(app=app), base_url="http://test"
                    ) as api:
                        accepted = await api.post(
                            "/api/holdings",
                            headers={HEADER: first},
                            json={"track_id": 12, "song_id": SONG},
                        )
                        other = await api.post(
                            "/api/holdings",
                            headers={HEADER: second},
                            json={"track_id": 12, "song_id": SONG},
                        )
                self.assertEqual(accepted.status_code, 200)
                self.assertEqual(other.status_code, 200)
                self.assertEqual(other.json()["id"], accepted.json()["id"])
                self.assertEqual(house.read_bytes(), b"keep")
                self.assertEqual(store.db.execute("SELECT count(*) FROM holdings").fetchone()[0], 1)
            finally:
                store.close()
