"""Embedded Opus/Vorbis covers use the same picture preference as other formats."""

import base64
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

import mutagen
from mutagen.flac import Picture

from backend.library.player import pick_picture, pictures_in


@unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg is required")
class CommentArtworkTests(unittest.TestCase):
    def test_real_comment_pictures_and_malformed_entries(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            for extension, codec in (("opus", "libopus"), ("ogg", "libvorbis")):
                with self.subTest(extension=extension):
                    path = Path(directory) / f"song.{extension}"
                    subprocess.run(
                        [
                            "ffmpeg",
                            "-v",
                            "error",
                            "-f",
                            "lavfi",
                            "-i",
                            "anullsrc=r=48000:cl=mono",
                            "-t",
                            "0.1",
                            "-c:a",
                            codec,
                            str(path),
                        ],
                        check=True,
                        capture_output=True,
                    )
                    audio = mutagen.File(path)
                    assert audio is not None and audio.tags is not None
                    blocks = ["not base64!", base64.b64encode(b"truncated").decode()]
                    for kind, data in ((4, b"back"), (3, b"front")):
                        picture = Picture()
                        picture.type = kind
                        picture.mime = "image/png"
                        picture.data = data
                        blocks.append(base64.b64encode(picture.write()).decode())
                    audio.tags["metadata_block_picture"] = blocks
                    audio.save()
                    self.assertEqual(pick_picture(pictures_in(path)), ("image/png", b"front"))
                    audio.tags["metadata_block_picture"] = blocks[:2]
                    audio.save()
                    self.assertIsNone(pick_picture(pictures_in(path)))
