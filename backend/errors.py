"""Error code to hint and fix target mapping."""

from backend.sources import by_source

# Codes that name YouTube's own helpers (PO token, Deno, cookies). Another site never has them.
YOUTUBE_ONLY_CODES = frozenset(
    {"POT_MISSING", "JS_RUNTIME_MISSING", "COOKIES_EXPIRED", "AGE_RESTRICTED"}
)
# Shown instead of yt-dlp's age-check essay. One video, not a broken helper.
AGE_HINT = "YouTube wants a sign-in to confirm this video's age."
# A refusal from one site. Podcast episodes each come from a different host, so for them a
# refusal says nothing about the next episode and must not count toward a pause.
SITE_REFUSAL_CODES = frozenset({"SOURCE_BLOCKED", "RATE_LIMITED"})
# Three of these in a row pause the source that raised them.
BLOCKING_CODES = frozenset(
    {"SOURCE_BLOCKED", "POT_MISSING", "JS_RUNTIME_MISSING", "COOKIES_EXPIRED"}
)
SITE_LABELS = {"youtube": "YouTube", "podcast": "the podcast host", "deezer": "Deezer"}
# What yt-dlp says when a site will not play a recording in the server's country.
GEO_MARKERS = ("geolocation", "geo restriction", "geo-restricted", "geo restricted")
# Sites that say more than the general wording, keyed by their label.
GEO_HINTS = {"BBC Sounds": "BBC Sounds only plays in the UK, and this server is not there."}


def age_restricted(text: str) -> bool:
    lower = text.lower()
    return "confirm your age" in lower or "age-restricted" in lower or "age restricted" in lower


# The resolver was down. The site was never asked, so this is not "no recording".
LOOKUP_MARKERS = (
    "name or service not known",
    "no address associated with hostname",
    "failed to resolve",
    "temporary failure in name resolution",
    "nodename nor servname",
)


def name_lookup_failed(text: str) -> bool:
    """Whether the tool never reached the site because the name did not resolve."""
    lower = text.lower()
    return any(marker in lower for marker in LOOKUP_MARKERS)


# A dropped connection. Not a block: the next song may go through, and it must not pause the source.
# A name that did not resolve is LOOKUP_FAILED, so that wording stays out of these markers.
CONNECTION_LINE = "The connection dropped before the site answered."
_CONNECTION_MARKERS = (
    "unexpected_eof",
    "ssl",
    "connection reset",
    "connection aborted",
    "connection refused",
    "network is unreachable",
    "unable to download api page",
)


def connection_failure(text: str) -> bool:
    """Whether a tool line is a dropped connection rather than the site refusing the account."""
    lower = text.lower()
    return any(marker in lower for marker in _CONNECTION_MARKERS)


def plain_detail(text: str) -> str:
    """A stored tool line the status row can show. An age check or a dump becomes one sentence."""
    if age_restricted(text):
        return AGE_HINT
    # yt-dlp appends this to errors it cannot explain. It is not a sign-in check.
    if "confirm you are on the latest version" in text.lower():
        return "The download tool hit an error it could not explain."
    line = " ".join(text.split())
    if len(line) > 180:
        return line[:177].rstrip() + "..."
    return line


def health_line(code: str, source: str, detail: str) -> str:
    """The one sentence stored for a source after it fails. The code was chosen earlier."""
    hint = error_guidance(code, site_label(source))[0] if code else ""
    return hint or plain_detail(detail)


def shown_health(row: dict[str, object]) -> dict[str, object]:
    """What Diagnostics shows.

    A connection dump stored as a block, from before that failure had its own code, is shown
    as an error. New rows already carry the code's sentence.
    """
    raw = str(row.get("detail", ""))
    status = str(row.get("status", ""))
    if status == "blocked" and connection_failure(raw):
        return {**row, "status": "error", "detail": CONNECTION_LINE}
    return {**row, "status": status, "detail": plain_detail(raw)}


def geo_restricted(text: str) -> bool:
    lower = text.lower()
    return any(marker in lower for marker in GEO_MARKERS)


def site_label(source: str) -> str:
    site = by_source(source)
    return site.label if site else SITE_LABELS.get(source, "the download site")


def no_match_hint(labels: list[str]) -> str:
    """The no-match sentence for the sites that were actually asked."""
    if not labels:
        return "No matching recording was found."
    if len(labels) == 1:
        named = labels[0]
    elif len(labels) == 2:
        named = f"{labels[0]} or {labels[1]}"
    else:
        named = ", ".join(labels[:-1]) + ", or " + labels[-1]
    return f"No matching recording was found on {named}."


def source_code(code: str, source: str) -> str:
    """Keep a code only where it means something for the job's source."""
    if source != "youtube" and code in YOUTUBE_ONLY_CODES:
        return "DOWNLOAD_FAILED"
    if source == "podcast" and code in SITE_REFUSAL_CODES:
        return "DOWNLOAD_FAILED"
    return code


def error_guidance(code: str, site: str = "YouTube") -> tuple[str, str]:
    """Map an error code to a plain hint and a fix target.

    `site` names where the download came from, so the hints read right for any source.
    """
    lead = site[:1].upper() + site[1:]
    hints: dict[str, tuple[str, str]] = {
        "DEST_UNWRITABLE": (
            "The destination folder is missing or not writable.",
            "settings:destination",
        ),
        "DISK_FULL": (
            "Less than 128 MB is free on the destination drive.",
            "diagnostics:disk",
        ),
        "MOVE_FAILED": (
            "The file could not be moved to its final location.",
            "settings:naming_template",
        ),
        "SOURCE_BLOCKED": (
            f"{lead} is blocking requests. Check credentials and tools.",
            "diagnostics:sources",
        ),
        "RATE_LIMITED": (
            f"{lead} rate limit reached. Wait before retrying.",
            "diagnostics:sources",
        ),
        "POT_MISSING": (
            "The PO token is required for YouTube downloads.",
            "diagnostics:sources",
        ),
        "JS_RUNTIME_MISSING": (
            "Deno is required for extracting YouTube metadata.",
            "diagnostics:sources",
        ),
        "COOKIES_EXPIRED": (
            "YouTube cookies have expired or are invalid.",
            # The cookie box is under Settings, Sources.
            "settings:sources",
        ),
        "AGE_RESTRICTED": (
            AGE_HINT,
            "settings:sources",
        ),
        "CATALOG_FAILED": (
            "The music catalog could not be reached.",
            "diagnostics:sources",
        ),
        "TRANSCODE_FAILED": (
            "FFmpeg could not convert the audio to the target format.",
            "settings:output_format",
        ),
        "TAG_FAILED": (
            "The audio file could not be tagged with metadata.",
            "settings:output_format",
        ),
        "NO_MATCH": (
            f"No matching recording was found on {site}.",
            "card:pick",
        ),
        "DURATION_MISMATCH": (
            "The downloaded audio length differs from the catalog.",
            "card:pick",
        ),
        "TIMEOUT": (
            "The download stage timed out before completing.",
            "retry",
        ),
        "LOOKUP_FAILED": (
            "The site's name could not be looked up. It will be tried again.",
            "retry",
        ),
        "CONNECTION_FAILED": (
            CONNECTION_LINE,
            "diagnostics:sources",
        ),
        "LIVE_STREAM": (
            "Live streams never finish, so they can't be saved.",
            "card:dismiss",
        ),
        "GEO_RESTRICTED": (
            GEO_HINTS.get(site, f"{lead} does not play in the country this server is in."),
            "card:dismiss",
        ),
        "SITE_NOT_ALLOWED": (
            "The link led to a site Musimo does not download from.",
            "card:dismiss",
        ),
        "DOWNLOAD_FAILED": (
            "The download stopped without a specific cause.",
            "retry",
        ),
        "INTERNAL_ERROR": (
            "An unexpected error occurred during processing.",
            "report",
        ),
    }
    return hints.get(code, ("", ""))
