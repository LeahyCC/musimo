import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.main import create_app
from backend.store import LockedSetting, Store


class FoundationTests(unittest.TestCase):
    def test_destination_selects_configured_roots_without_resolving_input(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            data = Path(folder)
            music = data / "music"
            music.mkdir()
            with (
                patch.dict("os.environ", {"MUSIMO_LIBRARY_ROOTS": str(music)}),
                TestClient(create_app(data)) as client,
                patch("backend.downloads.Path", side_effect=AssertionError("Untrusted path probe")),
            ):
                for path in (str(data), "../outside", "//untrusted.invalid/share"):
                    self.assertEqual(
                        client.patch("/api/settings", json={"destination": path}).status_code, 422
                    )
                self.assertEqual(
                    client.patch("/api/settings", json={"destination": str(music)}).status_code, 200
                )

    def test_static_routes_reject_paths_outside_the_build(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            data = Path(folder)
            static = data / "static"
            static.mkdir()
            (static / "index.html").write_text("<html>App</html>", encoding="utf-8")
            outside = data / "outside.txt"
            outside.write_text("private", encoding="utf-8")
            try:
                (static / "escape.txt").symlink_to(outside)
            except OSError:
                pass  # Windows can deny symlink creation without Developer Mode.
            with TestClient(create_app(data, static)) as client:
                self.assertEqual(client.get("/index.html").status_code, 200)
                for path in (
                    "/%2e%2e%2foutside.txt",
                    "/%2e%2e%5coutside.txt",
                    "/C:outside.txt",
                    "/index.html:secret",
                    "/escape.txt",
                    "/outside.txt",
                ):
                    with self.subTest(path=path):
                        self.assertEqual(client.get(path).status_code, 404)

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
                self.assertEqual(client.get("/library/artists/artist-1").status_code, 200)
                self.assertEqual(
                    client.get("/library/artists/artist-1/albums/album-1").status_code,
                    200,
                )
                self.assertEqual(client.get("/library/artists/bad!id").status_code, 404)
                self.assertEqual(client.get("/nope").status_code, 404)

    def test_read_only_destinations_are_rejected(self) -> None:
        import os as os_module

        with tempfile.TemporaryDirectory() as folder:
            data = Path(folder)
            readonly = data / "readonly"
            readonly.mkdir()
            writable = data / "writable"
            writable.mkdir()

            original_access = os_module.access

            def mock_access(path: str, mode: int) -> bool:
                if path == str(readonly) and mode == os_module.W_OK:
                    return False
                return original_access(path, mode)

            with (
                patch.dict("os.environ", {"MUSIMO_LIBRARY_ROOTS": f"{str(readonly)}{os.pathsep}{str(writable)}"}),
                TestClient(create_app(data)) as client,
                patch("backend.main.os.access", side_effect=mock_access),
            ):
                response = client.patch("/api/settings", json={"destination": str(readonly)})
                self.assertEqual(response.status_code, 422)
                self.assertIn("writable", response.json()["detail"].lower())
                response = client.patch("/api/settings", json={"destination": str(writable)})
                self.assertEqual(response.status_code, 200)


if __name__ == "__main__":
    unittest.main()
