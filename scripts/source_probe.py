"""Repeat an accessible audio fixture in an isolated container, without credentials."""

import argparse
import importlib.metadata
import json
import math
import re
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="https://www.youtube.com/watch?v=aqz-KE-bpKQ")
    parser.add_argument("--samples", type=int, default=50)
    parser.add_argument("--provider", default="http://pot-provider:4416")
    parser.add_argument("--downloader", choices=["native", "aria2c"], default="native")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not 1 <= args.samples <= 100:
        parser.error("Use 1–100 samples")
    rows: list[dict[str, object]] = []
    times: list[float] = []
    failures = 0
    with tempfile.TemporaryDirectory(prefix="musimo-probe-") as folder:
        for i in range(args.samples):
            start = time.perf_counter()
            try:
                result = subprocess.run(
                    [
                        sys.executable,
                        "-m",
                        "yt_dlp",
                        "--ignore-config",
                        "--no-playlist",
                        "--no-cache-dir",
                        "--socket-timeout",
                        "8",
                        "--retries",
                        "0",
                        "--extractor-retries",
                        "0",
                        "--extractor-args",
                        f"youtubepot-bgutilhttp:base_url={args.provider}",
                        "-f",
                        "bestaudio",
                        "--downloader",
                        args.downloader,
                        "-o",
                        f"{folder}/{i}.%(ext)s",
                        args.url,
                    ],
                    capture_output=True,
                    text=True,
                    timeout=35,
                )
                ok = result.returncode == 0
                tail = re.sub(r"https?://\S+", "[URL]", result.stderr[-1400:])
            except subprocess.TimeoutExpired:
                ok, tail = False, "TIMEOUT"
            elapsed = round(time.perf_counter() - start, 3)
            if ok:
                times.append(elapsed)
            failures = 0 if ok else failures + 1
            rows.append({"i": i, "seconds": elapsed, "ok": ok, "tail": tail})
            print(json.dumps(rows[-1]), flush=True)
            if failures >= 3:
                print("Stopped after three consecutive failures; remaining samples not attempted.")
                break
            time.sleep(1)
    times.sort()
    report = {
        "yt_dlp": importlib.metadata.version("yt-dlp"),
        "downloader": args.downloader,
        "requested": args.samples,
        "attempted": len(rows),
        "successful": len(times),
        "p50_seconds": statistics.median(times) if times else None,
        "p95_seconds": times[math.ceil(len(times) * 0.95) - 1] if times else None,
        "scope": "Repeated single fixture, not representative music-catalog reliability",
        "rows": rows,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
