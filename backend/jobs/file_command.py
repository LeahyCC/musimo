"""Turn the saved account file into the one audio file the worker keeps.

The command, when one is set, is a program and its own arguments. Musimo does not run a shell.
The account file path is added as the last argument. YouTube, SoundCloud, pasted links and
podcasts never come through here.
"""

import os
import shlex
import subprocess
from collections.abc import Callable
from pathlib import Path

from backend.integrations import deezer_cookie
from backend.jobs.ytdlp import redact

ACCOUNT_NAME = "account.bin"
TIMEOUT_SECONDS = 120
# The same containers tagging already keeps. A probed codec outside this list does not play.
CODEC_SUFFIX = {"aac": "m4a", "opus": "opus", "mp3": "mp3", "vorbis": "ogg", "flac": "flac"}
Probe = Callable[[Path], dict[str, object]]


class FileCommandError(Exception):
    """This try did not leave one playable file. The worker can ask the next source."""

    def __init__(self, message: str, output: str = "") -> None:
        super().__init__(message)
        # A redacted tail of command output. The command text itself is not here.
        self.output = output


def audio_suffixes() -> set[str]:
    """The suffixes worker.py already allows. Imported here so the two lists cannot drift."""
    from backend.jobs.worker import AUDIO_SUFFIXES

    return AUDIO_SUFFIXES


def clear_attempt(folder: Path) -> None:
    """Remove the account file and any audio this try left, so the next source sees one file."""
    (folder / ACCOUNT_NAME).unlink(missing_ok=True)
    (folder / f"{ACCOUNT_NAME}.part").unlink(missing_ok=True)
    allowed = audio_suffixes()
    for path in folder.iterdir():
        if path.is_file() and path.suffix.lower() in allowed:
            path.unlink(missing_ok=True)


def audio_files(folder: Path) -> list[Path]:
    allowed = audio_suffixes()
    return sorted(
        path for path in folder.iterdir() if path.is_file() and path.suffix.lower() in allowed
    )


def suffix_for(info: dict[str, object]) -> str | None:
    """The file suffix for a probe that found audio, or None when the file does not play."""
    ext = CODEC_SUFFIX.get(str(info.get("codec", "")))
    if ext is None or f".{ext}" not in audio_suffixes():
        return None
    try:
        duration = float(str(info.get("duration", 0)))
    except ValueError:
        return None
    if duration <= 0:
        return None
    return ext


def prepare(folder: Path, probe: Probe, command: str | None = None) -> Path:
    """The one playable file for this try.

    An empty command keeps the account file only when that file itself plays. A command runs
    first, and the result is kept only in one of the two shapes the worker can tag.
    `command` None reads MUSIMO_FILE_COMMAND, which is how the download worker passes it.
    """
    account = folder / ACCOUNT_NAME
    if command is None:
        command = os.environ.get("MUSIMO_FILE_COMMAND", "")
    if command == "":
        return keep_saved(folder, account, probe)
    return run_command(folder, account, command, probe)


def keep_saved(folder: Path, account: Path, probe: Probe) -> Path:
    if not account.is_file():
        clear_attempt(folder)
        raise FileCommandError("The Deezer file could not be read")
    ext: str | None
    try:
        ext = suffix_for(probe(account))
    except (OSError, subprocess.SubprocessError, ValueError):
        ext = None
    others = [path for path in audio_files(folder) if path != account]
    if ext is None or others:
        clear_attempt(folder)
        raise FileCommandError("The Deezer file could not be read")
    target = folder / f"source.{ext}"
    account.replace(target)
    return target


def run_command(folder: Path, account: Path, command: str, probe: Probe) -> Path:
    try:
        argv = shlex.split(command, posix=True)
    except ValueError:
        clear_attempt(folder)
        raise FileCommandError("The account file command could not start") from None
    if not argv:
        clear_attempt(folder)
        raise FileCommandError("The account file command could not start")
    argv.append(str(account.resolve()))
    env = os.environ.copy()
    env.pop("MUSIMO_DEEZER_ARL", None)
    env.pop(deezer_cookie.ENV, None)
    try:
        completed = subprocess.run(
            argv,
            cwd=folder,
            env=env,
            shell=False,
            capture_output=True,
            timeout=TIMEOUT_SECONDS,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        clear_attempt(folder)
        raise FileCommandError(
            "The account file command failed", output_tail(exc.stdout, exc.stderr)
        ) from None
    except OSError:
        clear_attempt(folder)
        raise FileCommandError("The account file command could not start") from None
    if completed.returncode != 0:
        clear_attempt(folder)
        raise FileCommandError(
            "The account file command failed", output_tail(completed.stdout, completed.stderr)
        )
    return accept(folder, account, probe)


def accept(folder: Path, account: Path, probe: Probe) -> Path:
    """One of the two shapes that count as a playable result. Anything else is a failed try."""
    files = audio_files(folder)
    if not account.is_file() and len(files) == 1 and files[0].stem == "source":
        return files[0]
    if account.is_file() and not files:
        return keep_saved(folder, account, probe)
    clear_attempt(folder)
    raise FileCommandError("The account file command did not leave one audio file")


def output_tail(stdout: bytes | str | None, stderr: bytes | str | None) -> str:
    """A short redacted tail of command output. The command text is not included."""
    parts: list[str] = []
    for chunk in (stdout, stderr):
        if not chunk:
            continue
        if isinstance(chunk, bytes):
            parts.append(chunk.decode("utf-8", errors="replace"))
        else:
            parts.append(chunk)
    if not parts:
        return ""
    return redact("\n".join("\n".join(parts).splitlines()[-8:]))
