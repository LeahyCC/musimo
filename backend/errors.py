"""Error code to hint and fix target mapping."""

from backend.sources import by_source

# Codes that name YouTube's own helpers (PO token, Deno, cookies). Another site never has them.
YOUTUBE_ONLY_CODES = frozenset({"POT_MISSING", "JS_RUNTIME_MISSING", "COOKIES_EXPIRED"})
# A refusal from one site. Podcast episodes each come from a different host, so for them a
# refusal says nothing about the next episode and must not count toward a pause.
SITE_REFUSAL_CODES = frozenset({"SOURCE_BLOCKED", "RATE_LIMITED"})
# Three of these in a row pause the source that raised them.
BLOCKING_CODES = frozenset(
    {"SOURCE_BLOCKED", "POT_MISSING", "JS_RUNTIME_MISSING", "COOKIES_EXPIRED"}
)
SITE_LABELS = {"youtube": "YouTube", "podcast": "the podcast host"}


def site_label(source: str) -> str:
    site = by_source(source)
    return site.label if site else SITE_LABELS.get(source, "the download site")


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
            "diagnostics:sources",
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
        "LIVE_STREAM": (
            "Live streams never finish, so they can't be saved.",
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
