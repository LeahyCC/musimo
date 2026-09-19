"""Repeat an accessible audio fixture in an isolated container, without credentials.

Give it one `--url` and a sample count, or `--site-list` to make one attempt against one public
URL per allowed site from `source_probe_sites.json`. Both write the same report.
"""

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
from urllib.parse import urlsplit

SITES = Path(__file__).with_name("source_probe_sites.json")
# Only these get the PO token provider. It is YouTube's own helper, and another site has no use
# for it. Kept beside `backend.sources` (a test compares them) because this script runs alone.
YOUTUBE_HOSTS = frozenset(
    {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"}
)


def is_youtube(url: str) -> bool:
    return urlsplit(url).hostname in YOUTUBE_HOSTS


def command(
    url: str,
    output: str,
    downloader: str,
    provider: str,
    audio_format: str = "bestaudio",
) -> list[str]:
    """The yt-dlp command for one attempt."""
    args = [
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
    ]
    if is_youtube(url):
        args += ["--extractor-args", f"youtubepot-bgutilhttp:base_url={provider}"]
    return [*args, "-f", audio_format, "--downloader", downloader, "-o", output, url]


def attempt(index: int, args: list[str]) -> dict[str, object]:
    """Run one download and describe it. Nothing in the row can carry a URL."""
    start = time.perf_counter()
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=35)
        ok = result.returncode == 0
        tail = re.sub(r"https?://\S+", "[URL]", result.stderr[-1400:])
    except subprocess.TimeoutExpired:
        ok, tail = False, "TIMEOUT"
    return {"i": index, "seconds": round(time.perf_counter() - start, 3), "ok": ok, "tail": tail}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="https://www.youtube.com/watch?v=aqz-KE-bpKQ")
    parser.add_argument("--samples", type=int, default=50)
    parser.add_argument("--provider", default="http://pot-provider:4416")
    parser.add_argument("--downloader", choices=["native", "aria2c"], default="native")
    parser.add_argument(
        "--site-list",
        action="store_true",
        help="one attempt per listed site instead of --url and --samples",
    )
    parser.add_argument("--only", help="with --site-list, attempt just this source")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not 1 <= args.samples <= 100:
        parser.error("Use 1–100 samples")
    if args.only and not args.site_list:
        parser.error("--only goes with --site-list")
    rows: list[dict[str, object]] = []
    times: list[float] = []
    failures = 0
    if args.site_list:
        listed: list[dict[str, str]] = json.loads(SITES.read_text(encoding="utf-8"))
        sites = [site for site in listed if args.only in (None, site["source"])]
        if not sites:
            parser.error(f"No site called {args.only} in {SITES.name}")
        scope = "One attempt per allowed site, not representative reliability"
    else:
        sites = [{"source": "", "url": args.url, "format": "bestaudio"}] * args.samples
        scope = "Repeated single fixture, not representative music-catalog reliability"
    with tempfile.TemporaryDirectory(prefix="musimo-probe-") as folder:
        for i, site in enumerate(sites):
            row = attempt(
                i,
                command(
                    site["url"],
                    f"{folder}/{i}.%(ext)s",
                    args.downloader,
                    args.provider,
                    site["format"],
                ),
            )
            if args.site_list:
                # Sites are independent, so one failing says nothing about the next.
                row["site"] = site["source"]
            if row["ok"]:
                times.append(float(str(row["seconds"])))
            failures = 0 if row["ok"] else failures + 1
            rows.append(row)
            print(json.dumps(row), flush=True)
            if failures >= 3 and not args.site_list:
                print("Stopped after three consecutive failures; remaining samples not attempted.")
                break
            time.sleep(1)
    times.sort()
    report = {
        "yt_dlp": importlib.metadata.version("yt-dlp"),
        "downloader": args.downloader,
        "requested": len(sites),
        "attempted": len(rows),
        "successful": len(times),
        "p50_seconds": statistics.median(times) if times else None,
        "p95_seconds": times[math.ceil(len(times) * 0.95) - 1] if times else None,
        "scope": scope,
        "rows": rows,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
