"""Look up Deezer's public track API by ISRC for every song in the sample. Host only, no auth.

Usage: python -I deezer_bpm.py <sample.json> <out.json>
Keeps the raw bpm, title, artist and Deezer id per song, and every error as Deezer or the
network gave it. Throttled well under Deezer's 50 requests per 5 seconds. Then adds
`tempo_extra_ids` to the sample: songs outside the tempo 100 that have a Deezer BPM, so the
tempo analysers can be checked against more reference points.
"""

import http.client
import json
import sys
import time
import urllib.request


def lookup(isrc: str) -> dict:
    url = f"https://api.deezer.com/track/isrc:{isrc}"
    try:
        with urllib.request.urlopen(url, timeout=20) as reply:
            body = json.load(reply)
    except (OSError, http.client.HTTPException, json.JSONDecodeError) as exc:
        # URLError, timeouts and connection resets are all OSError.
        return {"error": f"{type(exc).__name__}: {exc}", "error_kind": "network"}
    if "error" in body:
        return {"error": body["error"], "error_kind": "deezer"}
    return {
        "deezer_id": body.get("id"),
        "bpm": body.get("bpm"),
        "gain": body.get("gain"),
        "title": body.get("title"),
        "artist": (body.get("artist") or {}).get("name"),
        "duration": body.get("duration"),
    }


def main() -> None:
    sample = json.load(open(sys.argv[1], encoding="utf-8"))
    out = {}
    for song_id in sample["genre_ids"]:
        isrc = (sample["songs"][song_id].get("isrc") or "").strip()
        found = lookup(isrc) if isrc else {"error": "no isrc", "error_kind": "no isrc"}
        out[song_id] = {"isrc": isrc, **found}
        time.sleep(0.25)
    with open(sys.argv[2], "w", encoding="utf-8") as handle:
        json.dump(out, handle, ensure_ascii=False, indent=1)
    tempo = set(sample["tempo_ids"])
    sample["tempo_extra_ids"] = [
        s for s in sample["genre_ids"] if s not in tempo and (out[s].get("bpm") or 0) > 0
    ]
    sample["tempo_extra_rule"] = "genre-sample songs outside the tempo 100 with Deezer bpm > 0"
    with open(sys.argv[1], "w", encoding="utf-8") as handle:
        json.dump(sample, handle, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
