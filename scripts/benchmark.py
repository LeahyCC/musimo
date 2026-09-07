"""Print measured foundation latency and explicitly unavailable later-phase targets."""

import argparse
import json
import math
import statistics
import time
from pathlib import Path

import httpx


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:8765")
    parser.add_argument("--samples", type=int, default=50)
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--release", action="store_true", help="Fail until every release target has a measurement"
    )
    args = parser.parse_args()
    if args.samples < 5:
        parser.error("At least five samples are required")
    rows: list[dict[str, object]] = []
    with httpx.Client(base_url=args.url, timeout=5) as client:
        for name, route, target in (
            ("Health HTTP", "health", None),
            ("Snapshot HTTP", "snapshot", 300),
            ("Settings HTTP", "settings", None),
        ):
            times = []
            for _ in range(args.samples):
                start = time.perf_counter()
                client.get(f"/api/{route}").raise_for_status()
                times.append((time.perf_counter() - start) * 1000)
            p95 = sorted(times)[math.ceil(len(times) * 0.95) - 1]
            rows.append(
                {
                    "metric": name,
                    "p50_ms": round(statistics.median(times), 2),
                    "p95_ms": round(p95, 2),
                    "status": "BASELINE" if target is None else "PASS" if p95 <= target else "FAIL",
                }
            )
    for name in (
        "Cached/cold typeahead",
        "Multi-source first/complete",
        "Album prefetch/cold",
        "Ownership lookup",
        "Click to progress",
        "First media byte",
        "Track and album completion",
        "Pause/stop acknowledgement",
        "Active worker termination",
        "Scheduler dispatch",
        "Browser reconnect/reload",
        "Immediate/full library index",
        "Idle RSS/CPU",
        "Startup to healthy",
    ):
        rows.append({"metric": name, "status": "NOT MEASURED"})
    print(f"{'Metric':32} {'p50 ms':>10} {'p95 ms':>10} Status")
    print("-" * 78)
    for row in rows:
        print(
            f"{str(row['metric']):32} {str(row.get('p50_ms', '-')):>10} "
            f"{str(row.get('p95_ms', '-')):>10} {row['status']}"
        )
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(
            json.dumps({"samples": args.samples, "rows": rows}, indent=2) + "\n", encoding="utf-8"
        )
    if args.release or any(row["status"] == "FAIL" for row in rows):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
