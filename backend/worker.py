"""One controllable process group per job. Only validated server manifests enter here."""

import importlib.metadata
import json
import os
import random
import re
import sys
import time
from pathlib import Path
from typing import Protocol, cast

from backend.errors import error_guidance, geo_restricted, site_label, source_code
from backend.job_models import Candidate, Job, valid_candidate_id
from backend.matching import Matcher
from backend.sources import by_source, match_entry
from backend.tagging import Tagger, probe


class Downloader(Protocol):
    def extract_info(self, url: str, download: bool = True, process: bool = True) -> object: ...
    def process_ie_result(self, ie_result: object, download: bool = True) -> object: ...
    def close(self) -> None: ...


class Logger:
    def debug(self, message: str) -> None:
        pass

    def info(self, message: str) -> None:
        pass

    def warning(self, message: str) -> None:
        emit("warning", message=redact(message))

    def error(self, message: str) -> None:
        emit("log", message=redact(message))


def emit(kind: str, **values: object) -> None:
    print(json.dumps({"kind": kind, **values}), flush=True)


def redact(text: str) -> str:
    return re.sub(r"https?://\S+", "[URL]", text)[-3000:]


def base_options() -> dict[str, object]:
    """yt-dlp settings shared by downloads and link previews. No browser input reaches these."""
    options: dict[str, object] = {
        "quiet": True,
        "no_warnings": False,
        "logger": Logger(),
        "cachedir": False,
        "socket_timeout": 10,
        "retries": 0,
        "fragment_retries": 0,
        "extractor_retries": 0,
        "js_runtimes": {"deno": {}},
        "extractor_args": {"youtubepot-bgutilhttp": {"base_url": ["http://pot-provider:4416"]}},
    }
    if server_home := os.getenv("MUSIMO_POT_SERVER_HOME"):
        # Native installs can start the matching helper on demand instead of keeping a server up.
        options["extractor_args"] = {
            "youtubepot-bgutilscript": {"server_home": [server_home]},
        }
    return options


def live(info: dict[str, object]) -> bool:
    return info.get("is_live") is True or info.get("live_status") in {"is_live", "is_upcoming"}


def who(info: dict[str, object]) -> str:
    """The artist a downloaded recording names for itself, or its uploader."""
    artists = info.get("artists") or info.get("creators")
    listed = (
        [name.strip() for name in artists if isinstance(name, str) and name.strip()]
        if isinstance(artists, list)
        else []
    )
    return str(info.get("artist") or ", ".join(listed) or info.get("uploader") or "").strip()


def main() -> None:
    import yt_dlp  # type: ignore[import-untyped]

    folder = Path(sys.argv[1]).resolve()
    job = Job.model_validate_json((folder / "job.json").read_text(encoding="utf-8"))
    version = importlib.metadata.version("yt-dlp")
    last = 0.0
    stage = "matching"
    # Podcast episodes and pasted links download the address in the job: no search, no catalog.
    direct = job.catalog in {"podcast", "link"}
    link_site = by_source(job.source) if job.catalog == "link" else None
    site = site_label(job.source)

    def refuse(code: str, message: str) -> None:
        hint, fix = error_guidance(code, site)
        emit(
            "error",
            code=code,
            message=message,
            retryable=False,
            hint=hint,
            fix=fix,
            version=version,
        )

    def progress(raw: dict[str, object]) -> None:
        nonlocal last
        now = time.monotonic()
        if now - last < 0.25 and raw.get("status") != "finished":
            return
        last = now
        emit(
            "progress",
            downloaded=raw.get("downloaded_bytes", 0),
            total=raw.get("total_bytes") or raw.get("total_bytes_estimate") or 0,
            speed=raw.get("speed") or 0,
            eta=raw.get("eta"),
        )

    if job.catalog == "link" and link_site is None:
        refuse("SITE_NOT_ALLOWED", "This site is no longer on the download list")
        return
    # The allowlist below covers redirects. This covers the address itself: it has to belong to
    # the site the job says it is from, not only to some listed site.
    if link_site and match_entry(job.source_url) is not link_site:
        refuse("SITE_NOT_ALLOWED", f"The link is not a {site} address")
        return
    options = base_options() | {
        "noplaylist": True,
        "progress_hooks": [progress],
        "outtmpl": str(folder / "source.%(ext)s"),
        # Feed files and most other sites offer one format that may not be labelled audio-only.
        "format": link_site.audio_format
        if link_site
        else "bestaudio"
        if job.source == "youtube"
        else "bestaudio/best",
        "continuedl": True,
        "overwrites": False,
        "nopart": False,
        "sleep_interval_requests": random.uniform(0.3, 0.8),
    }
    if link_site:
        # Switches off the generic extractor, so a redirect to an unlisted site fails.
        options["allowed_extractors"] = link_site.allowed_extractors()
    try:
        downloader = cast(Downloader, yt_dlp.YoutubeDL(options))
        manifest = folder / "download.json"
        source: Path | None = None
        # Who the site says made the recording. A pasted list often gives the title and not this,
        # and the job then takes it from here so the file is not tagged with no artist.
        artist = ""
        if manifest.exists():
            saved: object = json.loads(manifest.read_text(encoding="utf-8"))
            if isinstance(saved, dict) and saved.get("selected") == job.selected:
                possible = folder / str(saved.get("file", ""))
                if possible.parent == folder and possible.is_file():
                    probe(possible)
                    source = possible
                    artist = str(saved.get("artist", ""))
        if source is None:
            selected = job.selected
            if not selected and not direct:
                emit("stage", stage="matching")
                search_options = options | {"extract_flat": True, "skip_download": True}
                searcher = cast(Downloader, yt_dlp.YoutubeDL(search_options))
                try:
                    raw = searcher.extract_info(
                        f"ytsearch8:{job.meta.artist} {job.meta.title} official audio",
                        download=False,
                    )
                finally:
                    searcher.close()
                entries = raw.get("entries", []) if isinstance(raw, dict) else []
                candidates: list[Candidate] = []
                if isinstance(entries, list):
                    for entry in entries:
                        if not isinstance(entry, dict) or not valid_candidate_id(
                            "youtube", str(entry.get("id", ""))
                        ):
                            continue
                        artist = str(entry.get("channel") or entry.get("uploader") or "")
                        candidates.append(
                            Candidate(
                                id=str(entry["id"]),
                                title=str(entry.get("title", "")),
                                artist=artist,
                                duration=float(entry.get("duration") or 0),
                                topic=artist.endswith(" - Topic"),
                                source="youtube",
                                url="https://www.youtube.com/watch?v=" + str(entry["id"]),
                            )
                        )
                matcher = Matcher()
                ranked = matcher.rank(job.meta, candidates)
                if not ranked:
                    review = matcher.rank(job.meta, candidates, min_score=0, min_title=0)
                    if review:
                        emit(
                            "candidates",
                            items=[row.model_dump() for row in review],
                            selected="",
                            check_match=True,
                        )
                    refuse("NO_MATCH", "No sufficiently close recording found")
                    return
                selected = ranked[0].id
                emit(
                    "candidates",
                    items=[row.model_dump() for row in ranked],
                    selected=selected,
                    check_match=ranked[0].score < 0.86,
                )
            emit("stage", stage="downloading")
            stage = "downloading"
            if link_site:
                # Look before downloading: a live stream never ends and a redirect may have
                # landed on a list page instead of one recording.
                info = downloader.extract_info(job.source_url, download=False)
                if not isinstance(info, dict):
                    raise ValueError("Download returned no media")
                if str(info.get("extractor", "")).lower() not in link_site.items:
                    refuse("SITE_NOT_ALLOWED", f"The link did not lead to one {site} recording")
                    return
                if live(info):
                    refuse("LIVE_STREAM", "Live streams never finish, so they can't be saved.")
                    return
                raw = downloader.process_ie_result(info, download=True)
            else:
                raw = downloader.extract_info(
                    job.source_url if direct else "https://www.youtube.com/watch?v=" + selected
                )
            if not isinstance(raw, dict):
                raise ValueError("Download returned no media")
            artist = who(raw)
            sources = [
                p
                for p in folder.glob("source.*")
                if p.suffix in {".webm", ".m4a", ".opus", ".mp3", ".ogg", ".flac", ".aac", ".mp4"}
                and p.is_file()
            ]
            if len(sources) != 1:
                raise ValueError("Download did not produce one complete audio file")
            source = sources[0]
            audio_info = probe(source)
            duration = float(str(audio_info["duration"]))
            # Direct files have no catalog length to check against: feed lengths are rough,
            # stitched-in ads change them, and a pasted link's length is the site's own.
            if (
                not direct
                and job.meta.duration
                and abs(duration - job.meta.duration) > max(15, job.meta.duration * 0.12)
            ):
                refuse("DURATION_MISMATCH", "Downloaded audio duration differs from the catalog")
                return
            temporary = manifest.with_suffix(".tmp")
            temporary.write_text(
                json.dumps({"selected": selected, "file": source.name, "artist": artist}),
                encoding="utf-8",
            )
            temporary.replace(manifest)
        downloader.close()
        emit("stage", stage="converting")
        stage = "converting"
        tagger = Tagger()
        ready = tagger.prepare(source, folder, job.format)
        emit("stage", stage="tagging")
        stage = "tagging"
        cover = folder / "cover.jpg"
        meta = job.meta
        if not meta.artist and artist:
            meta = meta.model_copy(
                update={"artist": artist, "album_artist": meta.album_artist or artist}
            )
        tagger.write(ready, meta, cover.read_bytes() if cover.exists() else None)
        emit(
            "ready", file=ready.name, version=version, artist=artist, **probe(ready, accurate=True)
        )
    except Exception as exc:
        message = redact(str(exc))
        lower = message.lower()
        code = (
            # Checked first: a site's words about location can also mention a 403.
            "GEO_RESTRICTED"
            if geo_restricted(lower)
            else "SITE_NOT_ALLOWED"
            if "no suitable extractor" in lower or "unsupported url" in lower
            else "SOURCE_BLOCKED"
            if "confirm you" in lower or "403" in lower
            else "RATE_LIMITED"
            if "429" in lower
            else "POT_MISSING"
            if "po token" in lower
            else "JS_RUNTIME_MISSING"
            if "javascript" in lower or "deno" in lower
            else "COOKIES_EXPIRED"
            if "sign in" in lower or "cookies" in lower
            else "DISK_FULL"
            if "no space left" in lower
            else "TIMEOUT"
            if "timed out" in lower
            else "DOWNLOAD_FAILED"
        )
        # A code only stands where it means something for this job's site, so another site's
        # refusal pauses that site alone and never YouTube.
        code = source_code(code, job.source)
        if code == "DOWNLOAD_FAILED" and stage in {"converting", "tagging"}:
            code = "TRANSCODE_FAILED" if stage == "converting" else "TAG_FAILED"
        hint, fix = error_guidance(code, site)
        if code == "GEO_RESTRICTED":
            # The tool's own wording is detail nobody can act on. The plain sentence is the answer.
            message = hint
        emit(
            "error",
            code=code,
            message=message,
            retryable=code in {"TIMEOUT", "RATE_LIMITED", "DOWNLOAD_FAILED"},
            hint=hint,
            fix=fix,
            version=version,
        )


if __name__ == "__main__":
    main()
