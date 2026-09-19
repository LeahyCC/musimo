"""Error code to hint and fix target mapping."""

# Codes the worker only reports for YouTube, where they mean the site or its helpers refused.
YOUTUBE_ONLY_CODES = frozenset(
    {"SOURCE_BLOCKED", "RATE_LIMITED", "POT_MISSING", "JS_RUNTIME_MISSING", "COOKIES_EXPIRED"}
)
# Three of these in a row pause the source that raised them.
BLOCKING_CODES = frozenset(
    {"SOURCE_BLOCKED", "POT_MISSING", "JS_RUNTIME_MISSING", "COOKIES_EXPIRED"}
)
SITE_LABELS = {"youtube": "YouTube", "podcast": "the podcast host"}


def site_label(source: str) -> str:
    return SITE_LABELS.get(source, "the download site")


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
