import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.main import create_app
from backend.store import LockedSetting, Store


class FoundationTests(unittest.TestCase):
    def test_settings_are_atomic_persisted_and_bootstrap_locked(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "db.sqlite3"
            with patch.dict("os.environ", {"MUSIMO_CONCURRENCY": "3"}):
                store = Store(path)
            with self.assertRaises(LockedSetting):
                store.update({"library_label": "Must roll back", "concurrency": 1})
            self.assertEqual(store.bounds()[1], 0)
            store.update({"library_label": "Records"})
            cursor = store.snapshot()["cursor"]
            store.close()
            with patch.dict("os.environ", {"MUSIMO_CONCURRENCY": "1"}):
                store = Store(path)
            self.assertEqual(store.snapshot()["cursor"], cursor)
            self.assertEqual(
                store.settings()["library_label"],
                {"value": "Records", "origin": "database", "locked": False},
            )
            self.assertEqual(
                store.settings()["concurrency"],
                {"value": 3, "origin": "MUSIMO_CONCURRENCY", "locked": True},
            )
            self.assertEqual(len(store.events(0)), 1)
            store.close()

    def test_api_rejects_invalid_and_cross_origin_changes(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            with TestClient(create_app(Path(folder))) as client:
                self.assertEqual(client.get("/api/health").status_code, 200)
                for change in (
                    {"concurrency": 0},
                    {"concurrency": True},
                    {"concurrency": None},
                    {"unknown": 1},
                ):
                    self.assertEqual(client.patch("/api/settings", json=change).status_code, 422)
                self.assertEqual(
                    client.patch(
                        "/api/settings",
                        json={"concurrency": 1},
                        headers={"origin": "https://other.test"},
                    ).status_code,
                    403,
                )
                self.assertEqual(
                    client.patch(
                        "/api/settings",
                        content='{"concurrency":1}',
                        headers={"content-type": "text/plain"},
                    ).status_code,
                    415,
                )
                self.assertEqual(client.get("/api/does-not-exist").status_code, 404)
                self.assertEqual(
                    client.get("/api/events", headers={"last-event-id": "bad"}).status_code, 400
                )
                self.assertEqual(
                    client.patch("/api/settings", json={"concurrency": 1}).status_code, 200
                )
                snapshot = client.get("/api/snapshot").json()
                self.assertEqual(snapshot["settings"]["concurrency"]["value"], 1)
                self.assertGreaterEqual(snapshot["cursor"], 1)

    def test_root_public_files_are_served(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            data = Path(folder)
            static = data / "static"
            static.mkdir()
            (static / "favicon.ico").write_bytes(b"ico")
            (static / "index.html").write_text("<html></html>", encoding="utf-8")
            with TestClient(create_app(data, static)) as client:
                icon = client.get("/favicon.ico")
                self.assertEqual(icon.status_code, 200)
                self.assertEqual(icon.content, b"ico")
                self.assertEqual(client.get("/search").status_code, 200)
                self.assertEqual(client.get("/nope").status_code, 404)


if __name__ == "__main__":
    unittest.main()
