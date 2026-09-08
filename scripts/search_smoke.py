"""Check live catalog APIs and record HTTP timings without browser automation."""

import argparse
import json
import math
import statistics
import time
from pathlib import Path

import httpx


def summary(values: list[float]) -> dict[str, float | int]:
    return {
        "samples": len(values),
        "median_ms": round(statistics.median(values), 2),
        "p95_ms": round(sorted(values)[math.ceil(len(values) * 0.95) - 1], 2),
    }


def server_timing(response: httpx.Response) -> dict[str, float]:
    result: dict[str, float] = {}
    for item in response.headers.get("server-timing", "").split(","):
        name, _, raw = item.strip().partition(";dur=")
        if name and raw:
            result[name] = float(raw)
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:8765")
    parser.add_argument("--output", default="docs/evidence/phase2-search.json")
    args = parser.parse_args()
    report: dict[str, object] = {}
    with httpx.Client(base_url=args.url, timeout=18) as client:
        samples: list[float] = []
        breakdown: dict[str, list[float]] = {
            name: [] for name in ("cache", "queue", "provider", "catalog", "library")
        }
        for query in [
            "Aphex Twin",
            "Boards of Canada",
            "Bonobo",
            "Floating Points",
            "Caribou",
            "Little Simz",
            "Yussef Dayes",
            "BADBADNOTGOOD",
            "Cleo Sol",
            "Sault",
        ]:
            started = time.perf_counter()
            response = client.get("/api/search", params={"q": query, "kind": "track"})
            response.raise_for_status()
            page = response.json()
            assert page["items"], query
            if not page["cached"]:
                samples.append((time.perf_counter() - started) * 1000)
                timing = server_timing(response)
                for name, values in breakdown.items():
                    values.append(timing[name])
        report["cold_search"] = (
            summary(samples) if samples else {"note": "Already cached; no cold samples"}
        )
        report["cold_search_breakdown"] = {
            name: summary(values) for name, values in breakdown.items() if values
        }
        cached: list[float] = []
        library: list[float] = []
        client.get("/api/search", params={"q": "Nina Simone", "kind": "track"}).raise_for_status()
        for _ in range(50):
            started = time.perf_counter()
            response = client.get("/api/search", params={"q": "Nina Simone", "kind": "track"})
            response.raise_for_status()
            assert response.json()["cached"]
            cached.append((time.perf_counter() - started) * 1000)
            timing = server_timing(response)
            if "library" in timing:
                library.append(timing["library"])
        report["cached_search"] = summary(cached)
        if library:
            report["library_badges_50_tracks"] = summary(library)
        for kind in ("album", "artist"):
            response = client.get("/api/search", params={"q": "Daft Punk", "kind": kind})
            response.raise_for_status()
            assert response.json()["items"]
        album = client.get("/api/albums/302127")
        album.raise_for_status()
        assert len(album.json()["tracks"]) == 14
        assert album.json()["album"]["year"] == 2001
        assert client.get("/api/album-years?ids=302127").json() == {"302127": 2001}
        artist = client.get("/api/artists/27")
        artist.raise_for_status()
        assert artist.json()["items"]
        preview = client.get("/api/preview/3135556")
        preview.raise_for_status()
        assert preview.json()["url"].startswith("https://")
        # A short range request checks clip availability without saving third-party media.
        clip = client.get(preview.json()["url"], headers={"Range": "bytes=0-255"})
        clip.raise_for_status()
        report["preview"] = {"source": preview.json()["source"], "http_status": clip.status_code}
        for path in (
            "/albums/302127",
            "/artists/27",
            "/search?q=Nina+Simone&tab=track&library=owned",
        ):
            assert client.get(path).status_code == 200
        report["library"] = client.get("/api/library").json()
    Path(args.output).write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    print("PASS: live track/album/artist search, album years, detail, preview and route reloads")


if __name__ == "__main__":
    main()
