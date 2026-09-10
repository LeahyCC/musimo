"""One controllable process group per job. Only validated server manifests enter here."""

import importlib.metadata
import json
import random
import re
import sys
import time
from pathlib import Path
from typing import Protocol, cast

from backend.errors import error_guidance
from backend.job_models import Candidate, Job
from backend.matching import Matcher
from backend.tagging import Tagger, probe


class Downloader(Protocol):
    def extract_info(self, url: str, download: bool = True) -> object: ...
    def close(self) -> None: ...


def emit(kind: str, **values: object) -> None:
    print(json.dumps({"kind": kind, **values}), flush=True)


def redact(text: str) -> str:
    return re.sub(r"https?://\S+", "[URL]", text)[-3000:]


def main() -> None:
    import yt_dlp  # type: ignore[import-untyped]

    folder = Path(sys.argv[1]).resolve()
    job = Job.model_validate_json((folder / "job.json").read_text(encoding="utf-8"))
    version = importlib.metadata.version("yt-dlp")
    last = 0.0
    stage = "matching"

    class Logger:
        def debug(self, message: str) -> None:
            pass

        def info(self, message: str) -> None:
            pass

        def warning(self, message: str) -> None:
            emit("warning", message=redact(message))

        def error(self, message: str) -> None:
            emit("log", message=redact(message))

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

    options: dict[str, object] = {
        "quiet": True,
        "no_warnings": False,
        "logger": Logger(),
        "noplaylist": True,
        "cachedir": False,
        "socket_timeout": 10,
        "retries": 0,
        "fragment_retries": 0,
        "extractor_retries": 0,
        "js_runtimes": {"deno": {}},
        "extractor_args": {"youtubepot-bgutilhttp": {"base_url": ["http://pot-provider:4416"]}},
        "progress_hooks": [progress],
        "outtmpl": str(folder / "source.%(ext)s"),
        "format": "bestaudio",
        "continuedl": True,
        "overwrites": False,
        "nopart": False,
        "sleep_interval_requests": random.uniform(0.3, 0.8),
    }
    try:
        downloader = cast(Downloader, yt_dlp.YoutubeDL(options))
        manifest = folder / "download.json"
        source: Path | None = None
        if manifest.exists():
            saved: object = json.loads(manifest.read_text(encoding="utf-8"))
            if isinstance(saved, dict) and saved.get("selected") == job.selected:
                possible = folder / str(saved.get("file", ""))
                if possible.parent == folder and possible.is_file():
                    probe(possible)
                    source = possible
        if source is None:
            selected = job.selected
            if not selected:
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
                        if not isinstance(entry, dict) or not re.fullmatch(
                            r"[A-Za-z0-9_-]{11}", str(entry.get("id", ""))
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
                    hint, fix = error_guidance("NO_MATCH")
                    emit(
                        "error",
                        code="NO_MATCH",
                        message="No sufficiently close recording found",
                        retryable=False,
                        hint=hint,
                        fix=fix,
                        version=version,
                    )
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
            raw = downloader.extract_info("https://www.youtube.com/watch?v=" + selected)
            if not isinstance(raw, dict):
                raise ValueError("Download returned no media")
            sources = [
                p
                for p in folder.glob("source.*")
                if p.suffix in {".webm", ".m4a", ".opus", ".mp3", ".ogg", ".flac"} and p.is_file()
            ]
            if len(sources) != 1:
                raise ValueError("Download did not produce one complete audio file")
            source = sources[0]
            audio_info = probe(source)
            duration = float(str(audio_info["duration"]))
            if job.meta.duration and abs(duration - job.meta.duration) > max(
                15, job.meta.duration * 0.12
            ):
                hint, fix = error_guidance("DURATION_MISMATCH")
                emit(
                    "error",
                    code="DURATION_MISMATCH",
                    message="Downloaded audio duration differs from the catalog",
                    retryable=False,
                    hint=hint,
                    fix=fix,
                    version=version,
                )
                return
            temporary = manifest.with_suffix(".tmp")
            temporary.write_text(
                json.dumps({"selected": selected, "file": source.name}), encoding="utf-8"
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
        tagger.write(ready, job.meta, cover.read_bytes() if cover.exists() else None)
        emit("ready", file=ready.name, version=version, **probe(ready, accurate=True))
    except Exception as exc:
        message = redact(str(exc))
        lower = message.lower()
        code = (
            "SOURCE_BLOCKED"
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
        if code == "DOWNLOAD_FAILED" and stage in {"converting", "tagging"}:
            code = "TRANSCODE_FAILED" if stage == "converting" else "TAG_FAILED"
        hint, fix = error_guidance(code)
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
