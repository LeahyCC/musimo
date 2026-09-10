"""Error code to hint and fix target mapping."""


def error_guidance(code: str) -> tuple[str, str]:
    """Map an error code to a plain hint and a fix target."""
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
            "YouTube is blocking requests. Check credentials and tools.",
            "diagnostics:sources",
        ),
        "RATE_LIMITED": (
            "YouTube rate limit reached. Wait before retrying.",
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
            "No matching recording was found on YouTube.",
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
