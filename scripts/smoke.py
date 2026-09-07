"""Exercise the running container, including durable settings and SSE replay."""

import argparse
import json
import subprocess
import time
from pathlib import Path

import httpx


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:8765")
    parser.add_argument("--restart", action="store_true")
    parser.add_argument("--compose-file", default="compose.yaml")
    parser.add_argument("--project-name", default="musimo")
    args = parser.parse_args()
    with httpx.Client(base_url=args.url, timeout=5) as client:
        for route in ("/", "/search", "/settings", "/downloads", "/diagnostics", "/api/health"):
            response = client.get(route)
            response.raise_for_status()
        initial = client.get("/api/snapshot").json()
        previous = initial["settings"]["library_label"]["value"]
        label = f"Smoke-{time.time_ns()}"
        saved = client.patch("/api/settings", json={"library_label": label})
        saved.raise_for_status()
        cursor = client.get("/api/snapshot").json()["cursor"]
        try:
            if args.restart:
                # Hold a real browser-style stream open to catch shutdowns waiting forever on SSE.
                with client.stream("GET", f"/api/events?after={cursor}") as live:
                    live.raise_for_status()
                    assert next(live.iter_lines()) == "retry: 1000"
                    started = time.perf_counter()
                    subprocess.run(
                        [
                            "docker",
                            "compose",
                            "-f",
                            args.compose_file,
                            "-p",
                            args.project_name,
                            "restart",
                            "musimo",
                        ],
                        cwd=Path(__file__).resolve().parents[1],
                        check=True,
                        timeout=8,
                    )
                    print(f"Restart with open SSE: {time.perf_counter() - started:.2f} s")
                for _ in range(100):
                    try:
                        if client.get("/api/health").status_code == 200:
                            break
                    except httpx.HTTPError:
                        pass
                    time.sleep(0.1)
                else:
                    raise AssertionError("Container did not become ready")
            snapshot = client.get("/api/snapshot").json()
            assert snapshot["settings"]["library_label"]["value"] == label
            assert snapshot["cursor"] >= cursor
            # EventSource reconnects with Last-Event-ID while the URL keeps its old cursor.
            with client.stream(
                "GET", "/api/events?after=999999", headers={"Last-Event-ID": str(initial["cursor"])}
            ) as response:
                response.raise_for_status()
                for line in response.iter_lines():
                    if line.startswith("data: "):
                        event = json.loads(line[6:])
                        if event["kind"] != "settings.updated":
                            continue
                        assert event["id"] <= cursor
                        assert event["payload"]["library_label"]["value"] == label
                        break
                else:
                    raise AssertionError("Replay did not arrive")
            with client.stream("GET", "/api/events?after=999999") as response:
                assert (
                    next(line for line in response.iter_lines() if line.startswith("event:"))
                    == "event: reset"
                )
            assert client.patch("/api/settings", json={"concurrency": 99}).status_code == 422
            assert (
                client.patch(
                    "/api/settings",
                    json={"concurrency": 1},
                    headers={"Origin": "https://other.test"},
                ).status_code
                == 403
            )
            export = client.get("/api/diagnostics/export")
            export.raise_for_status()
            assert export.json()["database"]["mode"] == "wal"
            print(
                "PASS: routes, settings, snapshot, SSE replay/reset, "
                "validation, origin checks and export"
            )
            if args.restart:
                print("PASS: settings and event replay survive container restart")
        finally:
            client.patch("/api/settings", json={"library_label": previous}).raise_for_status()


if __name__ == "__main__":
    main()
