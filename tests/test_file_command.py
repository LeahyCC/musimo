"""The account-file command: arguments, environment, and which file is kept."""

import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.integrations import deezer_cookie
from backend.jobs.file_command import FileCommandError, prepare


def plays(_path: Path) -> dict[str, object]:
    return {"codec": "flac", "duration": 180.0}


class FileCommandTests(unittest.TestCase):
    def test_an_empty_command_renames_a_file_that_plays(self) -> None:
        with tempfile.TemporaryDirectory() as directory, patch.dict("os.environ"):
            os.environ.pop("MUSIMO_FILE_COMMAND", None)
            folder = Path(directory)
            account = folder / "account.bin"
            account.write_bytes(b"audio-bytes")
            kept = prepare(folder, plays)
            self.assertEqual(kept.name, "source.flac")
            self.assertEqual(kept.read_bytes(), b"audio-bytes")
            self.assertFalse(account.exists())

    def test_an_empty_command_removes_a_file_that_does_not_play(self) -> None:
        def unreadable(_path: Path) -> dict[str, object]:
            raise subprocess.CalledProcessError(1, ["ffprobe"])

        with tempfile.TemporaryDirectory() as directory, patch.dict("os.environ"):
            os.environ.pop("MUSIMO_FILE_COMMAND", None)
            folder = Path(directory)
            account = folder / "account.bin"
            account.write_bytes(b"not-audio")
            with self.assertRaises(FileCommandError):
                prepare(folder, unreadable)
            self.assertFalse(account.exists())

    def test_the_child_gets_the_split_command_and_no_cookie(self) -> None:
        seen: dict[str, object] = {}

        def run(argv: list[str], **kwargs: object) -> subprocess.CompletedProcess[bytes]:
            seen["argv"] = list(argv)
            seen["env"] = kwargs["env"]
            seen["cwd"] = kwargs["cwd"]
            seen["shell"] = kwargs["shell"]
            seen["timeout"] = kwargs["timeout"]
            account = Path(argv[-1])
            account.unlink()
            (account.parent / "source.flac").write_bytes(b"playable")
            return subprocess.CompletedProcess(argv, 0, b"", b"")

        with (
            tempfile.TemporaryDirectory() as directory,
            patch.dict(
                "os.environ",
                {
                    "MUSIMO_FILE_COMMAND": 'tool --flag "two words"',
                    "MUSIMO_DEEZER_ARL": "secret-cookie",
                    deezer_cookie.ENV: "cookie-file",
                },
            ),
        ):
            folder = Path(directory)
            account = folder / "account.bin"
            account.write_bytes(b"saved")
            with patch("backend.jobs.file_command.subprocess.run", side_effect=run):
                kept = prepare(folder, plays)
            argv = seen["argv"]
            assert isinstance(argv, list)
            self.assertEqual(argv[:-1], ["tool", "--flag", "two words"])
            self.assertEqual(Path(str(argv[-1])), account.resolve())
            env = seen["env"]
            assert isinstance(env, dict)
            self.assertNotIn("MUSIMO_DEEZER_ARL", env)
            self.assertNotIn(deezer_cookie.ENV, env)
            self.assertNotIn("secret-cookie", "".join(str(value) for value in env.values()))
            self.assertIs(seen["shell"], False)
            self.assertEqual(seen["cwd"], folder)
            self.assertEqual(seen["timeout"], 120)
            self.assertEqual(kept.name, "source.flac")

    def test_a_command_that_leaves_the_account_file_playable_renames_it(self) -> None:
        def run(argv: list[str], **_kwargs: object) -> subprocess.CompletedProcess[bytes]:
            Path(argv[-1]).write_bytes(b"now-audio")
            return subprocess.CompletedProcess(argv, 0, b"", b"")

        with (
            tempfile.TemporaryDirectory() as directory,
            patch.dict("os.environ", {"MUSIMO_FILE_COMMAND": "tool"}),
        ):
            folder = Path(directory)
            (folder / "account.bin").write_bytes(b"saved")
            with patch("backend.jobs.file_command.subprocess.run", side_effect=run):
                kept = prepare(folder, plays)
            self.assertEqual(kept.read_bytes(), b"now-audio")
            self.assertFalse((folder / "account.bin").exists())

    def test_a_failed_command_logs_a_redacted_tail_and_not_the_command(self) -> None:
        command = "tool --flag"

        def run(argv: list[str], **_kwargs: object) -> subprocess.CompletedProcess[bytes]:
            return subprocess.CompletedProcess(argv, 1, b"", b"failed https://cdn.example/file")

        with (
            tempfile.TemporaryDirectory() as directory,
            patch.dict("os.environ", {"MUSIMO_FILE_COMMAND": command}),
        ):
            folder = Path(directory)
            (folder / "account.bin").write_bytes(b"saved")
            with (
                patch("backend.jobs.file_command.subprocess.run", side_effect=run),
                self.assertRaises(FileCommandError) as raised,
            ):
                prepare(folder, plays)
            self.assertFalse((folder / "account.bin").exists())
            text = raised.exception.output
            self.assertIn("[URL]", text)
            self.assertNotIn("https://", text)
            self.assertNotIn(command, text)

    def test_no_program_two_files_and_a_timeout_remove_the_attempt(self) -> None:
        def two_files(argv: list[str], **_kwargs: object) -> subprocess.CompletedProcess[bytes]:
            account = Path(argv[-1])
            account.unlink()
            (account.parent / "source.flac").write_bytes(b"a")
            (account.parent / "extra.mp3").write_bytes(b"b")
            return subprocess.CompletedProcess(argv, 0, b"", b"")

        def timed_out(argv: list[str], **_kwargs: object) -> subprocess.CompletedProcess[bytes]:
            raise subprocess.TimeoutExpired(argv, 120)

        cases: tuple[tuple[str, object], ...] = (
            ("   ", None),
            ("tool", two_files),
            ("tool", timed_out),
        )
        for command, run in cases:
            with self.subTest(command=command):
                with (
                    tempfile.TemporaryDirectory() as directory,
                    patch.dict("os.environ", {"MUSIMO_FILE_COMMAND": command}),
                ):
                    folder = Path(directory)
                    (folder / "account.bin").write_bytes(b"saved")
                    with (
                        patch("backend.jobs.file_command.subprocess.run", side_effect=run),
                        self.assertRaises(FileCommandError),
                    ):
                        prepare(folder, plays)
                    self.assertFalse((folder / "account.bin").exists())
                    self.assertEqual(list(folder.glob("source.*")), [])
                    self.assertEqual(list(folder.glob("extra.mp3")), [])
