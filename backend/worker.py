"""One controllable process group per job. Only validated server manifests enter here."""

import importlib.metadata
import json
import os
import random
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Protocol, cast

from backend.deezer_audio import DeezerCookieRejected, DeezerNoTrack, configured, fetch
from backend.errors import (
    BLOCKING_CODES,
    age_restricted,
    error_guidance,
    geo_restricted,
    no_match_hint,
    site_label,
    source_code,
)
from backend.job_models import Candidate, Job, valid_candidate_id
from backend.matching import CHECK_BELOW, MIN_SCORE, Matcher
from backend.sources import by_source, match_entry
from backend.tagging import Tagger, probe
from backend.youtube_cookies import private_copy

# How each source is searched for a catalog track. A source missing here is never searched.
SEARCHES = {"youtube": "ytsearch8:", "soundcloud": "scsearch8:"}
# Words added to the search. YouTube writes "Provided to YouTube by <label>" on every label
# upload, so the phrase pulls those to the top: on the 100-song corpus it matched 89 songs
# against 78 for "official audio" (docs/measurements.md). SoundCloud titles carry neither, so
# there a hint only filters real results out.
SEARCH_HINT = {"youtube": ' "provided to youtube by"'}


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


def turned_off() -> set[str]:
    return {part for part in os.environ.get("MUSIMO_DISABLED_SOURCES", "").split(",") if part}


# A block or a rate limit stops that source for the rest of the walk: asking again at once only
# prolongs it. A timeout usually means the next try times out too. The queue's backoff retries the
# song later instead.
STOPPING_CODES = BLOCKING_CODES | {"RATE_LIMITED", "TIMEOUT"}
# Failures worth the queue's own backoff retry once the walk is over.
TRANSIENT_CODES = frozenset({"RATE_LIMITED", "TIMEOUT"})
# What yt-dlp says when one recording cannot be had. The next match may still play.
RECORDING_GONE = (
    "video unavailable",
    "private video",
    "video is private",
    "been removed",
    "no longer available",
    "members-only",
    "requested format is not available",
    # One region-locked upload. YouTube itself still plays, so it is not a country block.
    "available in your country",
)


def own_fault(code: str, message: str) -> bool:
    """A failure of this one recording, which says nothing about the source's next match."""
    lower = message.lower()
    if code in {"GEO_RESTRICTED", "AGE_RESTRICTED"} or age_restricted(lower):
        return True
    return any(words in lower for words in RECORDING_GONE)


class WrongLength(Exception):
    """The file length is not the catalog track. Another try would fetch the same file."""


def account_preview(catalog: float, actual: float) -> bool:
    """The account file is already the track id. Only a short clip is the wrong file.

    A radio edit can sit half a minute off the length Deezer lists. That is still the song.
    """
    if catalog <= 0 or actual <= 0:
        return False
    return actual < 45 and actual < catalog * 0.5


AUDIO_SUFFIXES = {".webm", ".m4a", ".opus", ".mp3", ".ogg", ".flac", ".aac", ".mp4"}
# How long tagging waits for lyrics, catalog tags and cover art started alongside the download.
# Longer than the enrichment budget plus the cover fetches, so a fast file still gets its tags.
SIDE_WAIT_SECONDS = 60
# DASH and HLS otherwise arrive one piece at a time. A single file ignores this.
FRAGMENT_DOWNLOADS = 4


def bound_count(name: str) -> int:
    """A settings count from the environment. Missing or junk is one, so a test does not loop."""
    try:
        value = int(os.environ.get(name, "1"))
    except ValueError:
        return 1
    return min(4, max(1, value))


def source_plan() -> tuple[list[str], int, int]:
    """Catalog order, tries on the current source, and laps around the list."""
    allowed = ("deezer", "youtube", "soundcloud")
    seen: list[str] = []
    for part in os.environ.get("MUSIMO_SOURCE_ORDER", "deezer,youtube").split(","):
        name = part.strip()
        if name in allowed and name not in seen:
            seen.append(name)
    paused = {part for part in os.environ.get("MUSIMO_PAUSED_SOURCES", "").split(",") if part}
    order = [name for name in seen if name not in turned_off() and name not in paused]
    return order, bound_count("MUSIMO_TRIES_PER_SOURCE"), bound_count("MUSIMO_MAX_ATTEMPTS")


def classify(message: str) -> str:
    lower = message.lower()
    if geo_restricted(lower):
        return "GEO_RESTRICTED"
    # "confirm your age" also contains "confirm you", which is the bot check. Age comes first,
    # and it is one video, so it must not pause YouTube.
    if age_restricted(lower):
        return "AGE_RESTRICTED"
    if "no suitable extractor" in lower or "unsupported url" in lower:
        return "SITE_NOT_ALLOWED"
    if "confirm you" in lower or "403" in lower:
        return "SOURCE_BLOCKED"
    if "429" in lower:
        return "RATE_LIMITED"
    if "po token" in lower:
        return "POT_MISSING"
    if "javascript" in lower or "deno" in lower:
        return "JS_RUNTIME_MISSING"
    if "sign in" in lower or "cookies" in lower:
        return "COOKIES_EXPIRED"
    if "no space left" in lower:
        return "DISK_FULL"
    if "timed out" in lower:
        return "TIMEOUT"
    return "DOWNLOAD_FAILED"


def emit(kind: str, **values: object) -> None:
    print(json.dumps({"kind": kind, **values}), flush=True)


def redact(text: str) -> str:
    return re.sub(r"https?://\S+", "[URL]", text)[-3000:]


def cache_dir() -> str | bool:
    """yt-dlp's player cache, or False when this process has no data directory."""
    raw = os.getenv("MUSIMO_YTDLP_CACHE", "").strip()
    if not raw:
        return False
    try:
        Path(raw).mkdir(parents=True, exist_ok=True)
    except OSError:
        return False
    return raw


def base_options() -> dict[str, object]:
    """yt-dlp settings shared by downloads and link previews. No browser input reaches these."""
    options: dict[str, object] = {
        "quiet": True,
        "no_warnings": False,
        "logger": Logger(),
        # A shared cache keeps the YouTube player script between tracks. Unset in tests.
        "cachedir": cache_dir(),
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
    # A signed-in cookies file lets an age-restricted video through. The path is the server's,
    # never a path from the browser, and yt-dlp gets its own copy because it writes back to it.
    if cookies := private_copy():
        options["cookiefile"] = cookies
    return options


def live(info: dict[str, object]) -> bool:
    return info.get("is_live") is True or info.get("live_status") in {"is_live", "is_upcoming"}


def address(source: str, candidate_id: str, url: str) -> str:
    """Where one candidate is downloaded from, or "" when it is not a page of its own source."""
    if not valid_candidate_id(source, candidate_id):
        return ""
    if source == "youtube":
        return "https://www.youtube.com/watch?v=" + candidate_id
    site = by_source(source)
    return url if site is not None and match_entry(url) is site else ""


def found(source: str, entries: object) -> list[Candidate]:
    """One search's results, keeping only rows that are a single recording on that source."""
    rows: list[Candidate] = []
    if not isinstance(entries, list):
        return rows
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        candidate_id = str(entry.get("id", ""))
        url = address(source, candidate_id, str(entry.get("url") or entry.get("webpage_url") or ""))
        if not url:
            continue
        artist = str(
            entry.get("channel") or entry.get("uploader") or ""
            if source == "youtube"
            else entry.get("artist") or entry.get("uploader") or entry.get("channel") or ""
        )
        rows.append(
            Candidate(
                id=candidate_id,
                title=str(entry.get("title", "")),
                artist=artist,
                duration=float(entry.get("duration") or 0),
                # Only YouTube has Topic channels, so only a YouTube row can earn their lift.
                topic=source == "youtube" and artist.endswith(" - Topic"),
                source=source,
                url=url,
            )
        )
    return rows


def metadata_ready(folder: Path, job: Job) -> Job:
    """Re-read tags the parent finished while the file was downloading.

    Without ``wait-side`` there is nothing to wait for: a test, or a job that already has
    its lyrics and cover. ``side.json`` is written after ``job.json`` and ``cover.jpg``.
    """
    if not (folder / "wait-side").is_file():
        return job
    deadline = time.monotonic() + SIDE_WAIT_SECONDS
    marker = folder / "side.json"
    while not marker.is_file():
        if time.monotonic() >= deadline:
            emit("warning", message="Optional metadata was not ready before tagging")
            return job
        time.sleep(0.05)
    try:
        return Job.model_validate_json((folder / "job.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return job


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
    # A match from the backup source changes where the job downloads from, so the site name, the
    # error codes and the pause follow it from that point on.
    origin = job.source
    site = site_label(origin)
    # The source being asked right now. A failure reports this, not the site the job started on.
    asking = origin

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
            source=asking,
        )

    def sources_off(
        message: str = "The sources for this track are turned off in Settings.",
    ) -> None:
        emit(
            "error",
            code="DOWNLOAD_FAILED",
            message=message,
            retryable=False,
            hint=message,
            fix="settings:sources",
            version=version,
            source=asking,
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

    if job.catalog == "podcast" and "podcast" in turned_off():
        sources_off("Podcasts are turned off in Settings.")
        return
    if job.catalog == "link" and job.source in turned_off():
        sources_off(f"{site} is turned off in Settings.")
        return
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
        "concurrent_fragment_downloads": FRAGMENT_DOWNLOADS,
        # One lost piece should not throw away the rest of a parallel fragment download.
        "fragment_retries": 2,
        "sleep_interval_requests": random.uniform(0.3, 0.8),
    }
    if link_site:
        # Switches off the generic extractor, so a redirect to an unlisted site fails.
        options["allowed_extractors"] = link_site.allowed_extractors()

    search_options: dict[str, object] = {"extract_flat": True, "skip_download": True}
    # Assigned in the try below. Declared here so the source walk can replace the client.
    downloader: Downloader | None = None
    # The source whose format and extractor list that client carries. A catalog job starts with
    # the plain options, which only suit YouTube, so any other site's pick builds its own client.
    client_for = job.source if link_site or job.source == "youtube" else ""

    def search(source_name: str) -> list[Candidate]:
        """Ask one source for the wanted recording. Nothing is downloaded here."""
        searcher = cast(Downloader, yt_dlp.YoutubeDL(options | search_options))
        try:
            raw = searcher.extract_info(
                f"{SEARCHES[source_name]}{job.meta.artist} {job.meta.title}"
                f"{SEARCH_HINT.get(source_name, '')}",
                download=False,
            )
        finally:
            searcher.close()
        return found(source_name, raw.get("entries", []) if isinstance(raw, dict) else [])

    def drop_audio(partial: bool = False) -> None:
        """Remove downloaded audio.

        `partial` also clears yt-dlp's unfinished pieces, which must never be resumed into a
        different recording.
        """
        for path in folder.glob("source.*"):
            if path.is_file() and (partial or path.suffix in AUDIO_SUFFIXES):
                path.unlink(missing_ok=True)

    def account_once() -> Path | None:
        """One account file. None means the length was wrong, so a retry is the same file."""
        nonlocal stage
        emit("stage", stage="downloading")
        stage = "downloading"

        def on_progress(downloaded: int, total: int) -> None:
            progress(
                {
                    "downloaded_bytes": downloaded,
                    "total_bytes": total,
                    "status": "downloading",
                }
            )

        saved_file = fetch(job.track_id, folder, on_progress)
        try:
            try:
                audio_info = probe(saved_file)
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
                # The tool's own message carries the command and the local path.
                raise ValueError("The Deezer file could not be read") from exc
            duration = float(str(audio_info["duration"]))
            if duration <= 0:
                # ffprobe reads some garbage as a zero-length file and exits cleanly.
                raise ValueError("The Deezer file has no audio in it")
            if account_preview(job.meta.duration, duration):
                saved_file.unlink(missing_ok=True)
                return None
            write_manifest("", saved_file, job.meta.artist, "deezer", False)
        except BaseException:
            # The next source still gets asked, and this file would fail its single-file check.
            saved_file.unlink(missing_ok=True)
            raise
        return saved_file

    def write_manifest(
        selected: str, audio: Path, artist: str, source: str, check_match: bool
    ) -> None:
        """Record a verified file. A resume reads where it came from and how sure the match was."""
        temporary = manifest.with_suffix(".tmp")
        temporary.write_text(
            json.dumps(
                {
                    "selected": selected,
                    "file": audio.name,
                    "artist": artist,
                    "source": source,
                    "check_match": check_match,
                }
            ),
            encoding="utf-8",
        )
        temporary.replace(manifest)

    def make_room(picked: Candidate) -> None:
        """Clear an earlier attempt's files before this recording downloads.

        This recording's own unfinished file stays, so a paused or restarted download resumes
        where it stopped. Anything else would be resumed into the wrong recording, or fail the
        single-file check.
        """
        marker = folder / "partial.json"
        mine = {"source": picked.source, "id": picked.id}
        try:
            earlier: object = json.loads(marker.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            earlier = None
        if earlier != mine:
            drop_audio(partial=True)
            marker.write_text(json.dumps(mine), encoding="utf-8")
        else:
            # A finished file with no manifest may be another source's, left when a worker was
            # stopped. Two files fail the single-file check, so only the unfinished one stays.
            drop_audio()

    def use_client(picked: Candidate) -> None:
        """Point the download client at the picked recording's own site.

        Pauses and error codes follow that site from here on, and so does the source a failure
        names.
        """
        nonlocal origin, site, asking, downloader, client_for
        if downloader is None:
            raise RuntimeError("Downloader was not started")
        matched = by_source(picked.source)
        if matched is None:
            raise ValueError("The chosen recording is from an unlisted site")
        if picked.source != origin:
            origin, site = picked.source, matched.label
            emit("source", source=origin)
        asking = origin
        if picked.source != client_for:
            downloader.close()
            downloader = cast(
                Downloader,
                yt_dlp.YoutubeDL(
                    options
                    | {
                        "format": matched.audio_format,
                        "allowed_extractors": matched.allowed_extractors(),
                    }
                ),
            )
            client_for = picked.source

    def download_chosen(picked: Candidate) -> tuple[Path, str]:
        nonlocal stage
        use_client(picked)
        if downloader is None:
            raise RuntimeError("Downloader was not started")
        emit("stage", stage="downloading")
        stage = "downloading"
        chosen = address(picked.source, picked.id, picked.url)
        if not chosen:
            raise ValueError(f"The chosen recording is not a {site} address")
        raw = downloader.extract_info(chosen)
        if not isinstance(raw, dict):
            raise ValueError("Download returned no media")
        named = who(raw)
        files = [
            path
            for path in folder.glob("source.*")
            if path.suffix in AUDIO_SUFFIXES and path.is_file()
        ]
        if len(files) != 1:
            raise ValueError("Download did not produce one complete audio file")
        audio = files[0]
        audio_info = probe(audio)
        duration = float(str(audio_info["duration"]))
        limit = max(15, job.meta.duration * 0.12)
        if job.meta.duration and abs(duration - job.meta.duration) > limit:
            audio.unlink(missing_ok=True)
            raise WrongLength()
        write_manifest(
            picked.id, audio, named, picked.source, picked.score < CHECK_BELOW[picked.source]
        )
        return audio, named

    def note_source(name: str, lap: int, total: int, next_stage: str) -> None:
        """Tell the queue which source is being asked, before the search or the file."""
        nonlocal asking, stage
        asking = name
        stage = next_stage
        emit("source", source=name, lap=lap, laps=total)
        emit("stage", stage=next_stage)

    def walk_sources() -> tuple[Path, str, str, str] | None:
        """Ask the catalog list in order, then start again.

        A search with no song settles that source, and so do matches that are all the wrong
        length: neither is asked again. A failed download is tried again up to the tries count,
        then the next source is asked, and a later lap tries it once more. A recording that fails
        for itself (a country block, an age check, a removed video) is skipped for the next
        match. A block, a rate limit or a timeout stops that source for this run, and the queue's
        backoff retries the song later. A full disk stops the walk.
        """
        nonlocal origin, site
        order, tries, laps = source_plan()
        usable = [name for name in order if name != "deezer" or configured()]
        if not usable:
            sources_off()
            return None
        matcher = Matcher()
        review: list[Candidate] = []
        ranked_rows: list[Candidate] = []
        # Settled: not asked again this run.
        missed: set[str] = set()
        # Stopped by a block, a rate limit, a timeout or a refused cookie.
        stopped: set[str] = set()
        no_song: list[str] = []
        # Recordings that failed for themselves or had the wrong length.
        bad: set[tuple[str, str]] = set()
        # source, code, message, and whether one recording failed rather than the source. The
        # pause follows the source on the error, not the job's start.
        hits: list[tuple[str, str, str, bool]] = []

        def remember(name: str, code: str, message: str) -> None:
            hits.append((name, code, message, False))
            # Count the block even when a later source saves the song.
            if code in BLOCKING_CODES:
                emit("blocked", source=name, code=code, message=message)
            if code in STOPPING_CODES:
                stopped.add(name)

        def settle(name: str) -> None:
            """The source has answered. An earlier failure there no longer explains the job.

            A recording that failed for itself is part of that answer, so it stays.
            """
            missed.add(name)
            hits[:] = [hit for hit in hits if hit[0] != name or hit[3]]

        def keep_rows(rows: list[Candidate]) -> None:
            known = {(row.source, row.id) for row in ranked_rows}
            ranked_rows.extend(row for row in rows if (row.source, row.id) not in known)

        wrong_length = False
        wrong_from = ""
        for lap in range(1, laps + 1):
            for name in usable:
                if name in missed or name in stopped:
                    continue
                if name == "deezer":
                    note_source(name, lap, laps, "downloading")
                    for _attempt in range(tries):
                        try:
                            saved = account_once()
                        except DeezerNoTrack as exc:
                            emit("log", message=str(exc))
                            no_song.append("deezer")
                            settle("deezer")
                            break
                        except Exception as exc:
                            # Whatever failed, the next source still gets asked. The attempt has
                            # already removed the file it saved.
                            message = redact(str(exc)) or "Deezer audio failed"
                            if classify(message) == "DISK_FULL":
                                raise
                            emit("log", message=message)
                            remember("deezer", "DOWNLOAD_FAILED", message)
                            if isinstance(exc, DeezerCookieRejected):
                                stopped.add("deezer")
                                break
                            continue
                        if saved is None:
                            wrong_length = True
                            wrong_from = "deezer"
                            emit("log", message="Deezer file length did not match the catalog")
                            settle("deezer")
                            break
                        origin, site = "deezer", site_label("deezer")
                        emit("source", source="deezer")
                        # The file is Deezer's own. A recording another source tried first is not
                        # the job's pick, and keeping it would point a resume at that recording.
                        emit(
                            "candidates",
                            items=[row.model_dump() for row in ranked_rows],
                            selected="",
                            check_match=False,
                        )
                        return saved, job.meta.artist, origin, site
                    continue
                note_source(name, lap, laps, "matching")
                candidates: list[Candidate] | None = None
                for _attempt in range(tries):
                    try:
                        candidates = search(name)
                    except Exception as exc:
                        message = redact(str(exc)) or "Search failed"
                        code = source_code(classify(message), name)
                        if code == "DISK_FULL":
                            raise
                        remember(name, code, message)
                        if name in stopped:
                            break
                        continue
                    break
                if candidates is None:
                    continue
                matched = matcher.rank(job.meta, candidates, min_score=MIN_SCORE[name])
                if not matched:
                    review += matcher.rank(job.meta, candidates, min_score=0, min_title=0)
                    no_song.append(name)
                    settle(name)
                    continue
                keep_rows(matched)
                for picked in matched:
                    if (picked.source, picked.id) in bad:
                        continue
                    emit(
                        "candidates",
                        items=[row.model_dump() for row in matched],
                        selected=picked.id,
                        check_match=picked.score < CHECK_BELOW[picked.source],
                    )
                    make_room(picked)
                    got: tuple[Path, str] | None = None
                    for _attempt in range(tries):
                        try:
                            got = download_chosen(picked)
                        except WrongLength:
                            wrong_length = True
                            wrong_from = name
                            bad.add((picked.source, picked.id))
                            drop_audio()
                            break
                        except Exception as exc:
                            message = redact(str(exc)) or "Download failed"
                            code = source_code(classify(message), picked.source)
                            if code == "DISK_FULL":
                                raise
                            drop_audio()
                            if own_fault(code, message):
                                # One recording's problem. A private video reads like expired
                                # cookies, and must neither stop the source nor count as a block.
                                fault = (
                                    code
                                    if code in {"GEO_RESTRICTED", "AGE_RESTRICTED"}
                                    else "DOWNLOAD_FAILED"
                                )
                                hits.append((picked.source, fault, message, True))
                                bad.add((picked.source, picked.id))
                                break
                            remember(picked.source, code, message)
                            if picked.source in stopped:
                                break
                            continue
                        break
                    if got is not None:
                        return got[0], got[1], origin, site
                    if picked.source in stopped or (picked.source, picked.id) not in bad:
                        # The source stopped, or the tries are used and a later lap asks again.
                        break
                if all((row.source, row.id) in bad for row in matched):
                    settle(name)
        rows = list(ranked_rows)
        seen_rows = {(row.source, row.id) for row in rows}
        for row in review:
            key = (row.source, row.id)
            if key not in seen_rows:
                rows.append(row)
                seen_rows.add(key)
        if rows:
            # An automatic pick is not a hand pick. Leave it unselected so Retry walks the list.
            emit(
                "candidates",
                items=[row.model_dump() for row in rows],
                selected="",
                check_match=True,
            )

        def report(chosen: tuple[str, str, str, bool], retryable: bool) -> None:
            label = site_label(chosen[0])
            hint, fix = error_guidance(chosen[1], label)
            if chosen[0] == "deezer" and chosen[1] == "DOWNLOAD_FAILED":
                hint = chosen[2]
            extra: list[str] = []
            seen_bits: set[str] = set()
            for source_name, code, message, _fault in hits:
                if source_name == chosen[0] and code == chosen[1]:
                    continue
                if source_name == "deezer" and message not in seen_bits:
                    extra.append(message)
                    seen_bits.add(message)
            if no_song:
                extra.append(no_match_hint([site_label(name) for name in no_song]))
            if extra:
                hint = f"{hint} {' '.join(extra)}"
            emit(
                "error",
                code=chosen[1],
                message=hint if chosen[1] in {"AGE_RESTRICTED", "GEO_RESTRICTED"} else chosen[2],
                retryable=retryable,
                hint=hint,
                fix=fix,
                version=version,
                source=chosen[0],
            )

        live = [hit for hit in hits if not hit[3]]
        if live:
            # A block needs a person, so it is named first. A rate limit or a timeout anywhere
            # earns the queue's backoff retry, as it did before the walk, even when a later lap
            # left another source's failure last.
            blocking = [hit for hit in live if hit[1] in BLOCKING_CODES]
            transient = [hit for hit in live if hit[1] in TRANSIENT_CODES]
            report(
                blocking[-1] if blocking else transient[-1] if transient else live[-1],
                retryable=bool(transient),
            )
            return None
        if wrong_length:
            failed = wrong_from or asking
            _, fix = error_guidance("DURATION_MISMATCH", site_label(failed))
            hint = f"The {site_label(failed)} file length differs from the catalog."
            if no_song:
                hint = f"{hint} {no_match_hint([site_label(name) for name in no_song])}"
            skipped = [
                site_label(name)
                for name in ("deezer", "youtube", "soundcloud")
                if name in turned_off()
            ]
            if len(skipped) == 1:
                hint = f"{hint} {skipped[0]} is turned off, so it was not asked."
            elif skipped:
                hint = f"{hint} {' and '.join(skipped)} are turned off, so they were not asked."
            emit(
                "error",
                code="DURATION_MISMATCH",
                message="Downloaded audio duration differs from the catalog",
                retryable=False,
                hint=hint,
                fix=fix,
                version=version,
                source=failed,
            )
            return None
        if hits:
            # Every match that was left failed for itself: a country block, an age check, a
            # removed video.
            report(hits[-1], retryable=False)
            return None
        names = no_song or [name for name in usable if name not in missed] or list(usable)
        emit(
            "error",
            code="NO_MATCH",
            message="No sufficiently close recording found",
            retryable=False,
            hint=no_match_hint([site_label(name) for name in names]),
            fix="card:pick",
            version=version,
            source=names[-1] if names else asking,
        )
        return None

    try:
        downloader = cast(Downloader, yt_dlp.YoutubeDL(options))
        manifest = folder / "download.json"
        source: Path | None = None
        # Who the site says made the recording. A pasted list often gives the title and not this,
        # and the job then takes it from here so the file is not tagged with no artist.
        artist = ""
        if manifest.exists():
            saved: object = json.loads(manifest.read_text(encoding="utf-8"))
            # A hand pick resumes only its own recording. An automatic job resumes whatever the
            # last walk saved: the walk records its picks as it goes, and Retry clears them.
            if isinstance(saved, dict) and (
                saved.get("selected") == job.selected or not job.hand_picked
            ):
                possible = folder / str(saved.get("file", ""))
                if possible.parent == folder and possible.is_file():
                    probe(possible)
                    source = possible
                    artist = str(saved.get("artist", ""))
                    # Retry resets an automatic job's source and pick. The file is still the
                    # earlier pick's, so the card, the match check and the block count follow it.
                    kept = str(saved.get("source", ""))
                    if kept and kept != origin and (kept == "deezer" or by_source(kept)):
                        origin, site = kept, site_label(kept)
                        asking = origin
                        emit("source", source=origin)
                    if saved.get("selected") != job.selected:
                        emit(
                            "candidates",
                            items=[row.model_dump() for row in job.candidates],
                            selected=str(saved.get("selected", "")),
                            check_match=saved.get("check_match") is True,
                        )
        # A catalog song with no hand-picked match walks the source list. A pasted link does not.
        # `selected` is not the test: the walk stores its own pick there before each download, so
        # a job paused or restarted mid-walk would skip the walk and refetch a passed-over match.
        if source is None and not job.hand_picked and not direct and job.catalog == "deezer":
            walked = walk_sources()
            if walked is None:
                if downloader is not None:
                    downloader.close()
                return
            source, artist, origin, site = walked
        if source is None:
            selected = job.selected
            picked = next((row for row in job.candidates if row.id == selected), None)
            if picked:
                if by_source(picked.source) is None:
                    refuse("SITE_NOT_ALLOWED", "The chosen recording is from an unlisted site")
                    return
                if picked.source in turned_off():
                    # Off means no new downloads from that source, a hand pick included.
                    sources_off(f"{site_label(picked.source)} is turned off in Settings.")
                    return
                # Pauses and error codes follow the site the recording was picked from.
                use_client(picked)
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
            elif direct:
                raw = downloader.extract_info(job.source_url)
            else:
                # Never the ID a stored job carries on its own: the address is rebuilt from the
                # chosen candidate and has to be a page of that candidate's own source.
                chosen = (
                    address(picked.source, picked.id, picked.url)
                    if picked
                    else address(origin, selected, "")
                )
                if not chosen:
                    refuse("SITE_NOT_ALLOWED", f"The chosen recording is not a {site} address")
                    return
                raw = downloader.extract_info(chosen)
            if not isinstance(raw, dict):
                raise ValueError("Download returned no media")
            artist = who(raw)
            sources = [
                p for p in folder.glob("source.*") if p.suffix in AUDIO_SUFFIXES and p.is_file()
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
            write_manifest(selected, source, artist, origin, job.check_match)
        if downloader is not None:
            downloader.close()
        emit("stage", stage="converting")
        stage = "converting"
        tagger = Tagger()
        ready = tagger.prepare(source, folder, job.format)
        emit("stage", stage="tagging")
        stage = "tagging"
        job = metadata_ready(folder, job)
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
        code = classify(message)
        # A code only stands where it means something for this job's site, so another site's
        # refusal pauses that site alone and never YouTube.
        code = source_code(code, origin)
        # A private or members-only video says "sign in", which reads as expired cookies. It is
        # one recording: it must not pause the site, and asking again would fetch the same file.
        one_recording = own_fault(code, message) and code in BLOCKING_CODES | {"DOWNLOAD_FAILED"}
        if code in BLOCKING_CODES and one_recording:
            code = "DOWNLOAD_FAILED"
        if code == "DOWNLOAD_FAILED" and stage in {"converting", "tagging"}:
            code = "TRANSCODE_FAILED" if stage == "converting" else "TAG_FAILED"
            one_recording = False
        hint, fix = error_guidance(code, site)
        if code in {"GEO_RESTRICTED", "AGE_RESTRICTED"}:
            # The tool's own wording is detail nobody can act on. The plain sentence is the answer.
            message = hint
        emit(
            "error",
            code=code,
            message=message,
            retryable=code in {"TIMEOUT", "RATE_LIMITED", "DOWNLOAD_FAILED"} and not one_recording,
            hint=hint,
            fix=fix,
            version=version,
            source=asking,
        )


if __name__ == "__main__":
    main()
