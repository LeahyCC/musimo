import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from backend.core.store import Store
from backend.main import create_app, cross_origin_write


class ActivityTests(unittest.TestCase):
    def test_clear_persists_preserves_replay_and_does_not_clear_later_events(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.sqlite3"
            store = Store(path)
            store.update({"library_label": "Before"})
            cursor = store.bounds()[1]
            store.update({"library_label": "After"})
            store.clear_activity(cursor)
            self.assertEqual(store.activity()["count"], 1)
            self.assertEqual(len(store.events(0)), 3)
            store.close()
            store = Store(path)
            self.assertEqual(store.activity()["count"], 1)
            store.clear_activity(store.bounds()[1])
            self.assertEqual(store.activity()["count"], 0)
            self.assertEqual(store.activity()["events"], [])
            self.assertGreater(store.bounds()[1], cursor)
            store.close()

    def test_api_clear_rejects_invalid_requests_and_cross_origin_writes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with TestClient(create_app(Path(directory))) as client:
                client.patch("/api/settings", json={"library_label": "Activity fixture"})
                data = client.get("/api/activity").json()
                response = client.request(
                    "DELETE",
                    "/api/activity",
                    json={"through": data["cursor"]},
                    headers={"origin": "https://other.test"},
                )
                self.assertEqual(response.status_code, 403)
                self.assertEqual(
                    client.request("DELETE", "/api/activity", json={"through": -1}).status_code, 422
                )
                self.assertEqual(
                    client.request("DELETE", "/api/activity", json={"through": True}).status_code,
                    422,
                )
                response = client.request(
                    "DELETE", "/api/activity", json={"through": data["cursor"]}
                )
                self.assertEqual(response.status_code, 200)
                self.assertTrue(
                    all(event["id"] > data["cursor"] for event in response.json()["events"])
                )


class SameOriginTests(unittest.TestCase):
    def test_the_browser_saying_same_origin_is_trusted_behind_a_proxy(self) -> None:
        # Tailscale Serve: the page is https://box.tailnet, the app sees http on its own port.
        headers = {
            "sec-fetch-site": "same-origin",
            "origin": "https://box.tailnet.ts.net",
            "host": "127.0.0.1:8765",
        }
        self.assertFalse(cross_origin_write(headers, "http"))

    def test_another_site_is_refused_whatever_the_origin_says(self) -> None:
        for site in ("cross-site", "same-site"):
            headers = {"sec-fetch-site": site, "origin": "http://box:8765", "host": "box:8765"}
            self.assertTrue(cross_origin_write(headers, "http"), site)

    def test_a_browser_without_fetch_metadata_falls_back_to_origin_and_host(self) -> None:
        self.assertFalse(
            cross_origin_write({"origin": "http://box:8765", "host": "box:8765"}, "http")
        )
        self.assertTrue(
            cross_origin_write({"origin": "https://other.test", "host": "box:8765"}, "http")
        )
        self.assertTrue(
            cross_origin_write({"origin": "https://box:8765", "host": "box:8765"}, "http")
        )

    def test_a_client_that_is_not_a_page_is_let_through(self) -> None:
        self.assertFalse(cross_origin_write({"host": "box:8765"}, "http"))

    def test_the_app_accepts_its_own_page_reached_through_a_proxy(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with TestClient(create_app(Path(directory))) as client:
                response = client.patch(
                    "/api/settings",
                    json={"library_label": "Proxy fixture"},
                    headers={"sec-fetch-site": "same-origin", "origin": "https://box.ts.net"},
                )
                self.assertEqual(response.status_code, 200)
                response = client.patch(
                    "/api/settings",
                    json={"library_label": "Foreign"},
                    headers={"sec-fetch-site": "cross-site", "origin": "https://other.test"},
                )
                self.assertEqual(response.status_code, 403)


if __name__ == "__main__":
    unittest.main()
