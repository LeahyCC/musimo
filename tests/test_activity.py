import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from backend.main import create_app
from backend.store import Store


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


if __name__ == "__main__":
    unittest.main()
