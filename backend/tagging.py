import base64
import json
import re
import shutil
import subprocess
from pathlib import Path
from typing import Protocol, cast

from mutagen.flac import FLAC, Picture
from mutagen.id3 import (
    APIC,
    ID3,
    SYLT,
    TALB,
    TCON,
    TDRC,
    TIT2,
    TPE1,
    TPE2,
    TPOS,
    TPUB,
    TRCK,
    TSRC,
    TXXX,
    UFID,
    USLT,
)
from mutagen.mp3 import MP3
from mutagen.mp4 import MP4, MP4Cover
from mutagen.oggopus import OggOpus
from mutagen.oggvorbis import OggVorbis

from backend.job_models import Format, Metadata


class TagMap(Protocol):
    def clear(self) -> None: ...


def probe(path: Path, accurate: bool = False) -> dict[str, object]:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)],
        capture_output=True,
        text=True,
        timeout=15,
        check=True,
    )
    raw: object = json.loads(result.stdout)
    if not isinstance(raw, dict):
        raise ValueError("Invalid audio probe")
    streams = raw.get("streams", [])
    audio = (
        next(
            (
                stream
                for stream in streams
                if isinstance(stream, dict) and stream.get("codec_type") == "audio"
            ),
            None,
        )
        if isinstance(streams, list)
        else None
    )
    if audio is None:
        raise ValueError("No audio stream")
    fmt = raw.get("format", {})
    duration = float(str(fmt.get("duration", 0))) if isinstance(fmt, dict) else 0
    bitrate = int(
        str(
            audio.get("bit_rate") or (path.stat().st_size * 8 / duration if duration > 0 else 0)
        ).split(".")[0]
    )
    if accurate and duration > 0:
        packets = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "a:0",
                "-show_packets",
                "-show_entries",
                "packet=size",
                "-of",
                "csv=p=0",
                str(path),
            ],
            capture_output=True,
            text=True,
            check=True,
            timeout=15,
        )
        sizes = [line.split(",")[0] for line in packets.stdout.splitlines()]
        bitrate = round(sum(int(size) for size in sizes if size.isdigit()) * 8 / duration)
    return {"codec": str(audio.get("codec_name", "")), "bitrate": bitrate, "duration": duration}


def lrc_events(text: str) -> list[tuple[str, int]]:
    events: list[tuple[str, int]] = []
    for line in text.splitlines():
        stamps = list(re.finditer(r"\[(\d+):(\d+(?:\.\d+)?)\]", line))
        words = re.sub(r"\[[^\]]*\]", "", line).strip()
        events.extend(
            (words, round((int(stamp[1]) * 60 + float(stamp[2])) * 1000)) for stamp in stamps
        )
    return sorted(events, key=lambda item: item[1])


class Tagger:
    def prepare(self, source: Path, directory: Path, format: Format) -> Path:
        info = probe(source)
        codec = str(info["codec"])
        if format == "original" and codec not in {"aac", "opus", "mp3", "vorbis", "flac"}:
            raise ValueError("Source codec cannot be kept in a supported tagged container")
        extension = (
            {"aac": "m4a", "opus": "opus", "mp3": "mp3", "vorbis": "ogg", "flac": "flac"}.get(
                codec, "m4a"
            )
            if format == "original"
            else format
        )
        target = directory / ("ready." + extension)
        target.unlink(missing_ok=True)
        if source.suffix.lower() == "." + extension:
            shutil.copyfile(source, target)
            return target
        options = ["-c:a", "copy"]
        if extension == "mp3" and codec != "mp3":
            options = ["-c:a", "libmp3lame", "-b:a", "320k"]
        elif extension == "m4a" and codec != "aac":
            options = ["-c:a", "aac", "-b:a", "160k"]
        elif extension == "opus" and codec != "opus":
            options = ["-c:a", "libopus", "-b:a", "160k"]
        subprocess.run(
            [
                "ffmpeg",
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                str(source),
                "-map",
                "0:a:0",
                "-vn",
                *options,
                str(target),
            ],
            check=True,
            capture_output=True,
            timeout=180,
        )
        return target

    def write(self, path: Path, meta: Metadata, cover: bytes | None) -> None:
        extras = {
            "ISRC": meta.isrc,
            "BARCODE": meta.upc,
            "LABEL": meta.label,
            "EXPLICIT": "1" if meta.explicit else "0",
            "MUSICBRAINZ_TRACKID": meta.mb_recording,
            "MUSICBRAINZ_RELEASETRACKID": meta.mb_track,
            "MUSICBRAINZ_ALBUMID": meta.mb_release,
            "MUSICBRAINZ_RELEASEGROUPID": meta.mb_release_group,
            "MUSICBRAINZ_ARTISTID": meta.mb_artist,
            "CONTRIBUTORS": "; ".join(meta.contributors),
        }
        id_names = {
            "MUSICBRAINZ_TRACKID": "MusicBrainz Track Id",
            "MUSICBRAINZ_RELEASETRACKID": "MusicBrainz Release Track Id",
            "MUSICBRAINZ_ALBUMID": "MusicBrainz Album Id",
            "MUSICBRAINZ_RELEASEGROUPID": "MusicBrainz Release Group Id",
            "MUSICBRAINZ_ARTISTID": "MusicBrainz Artist Id",
        }
        if path.suffix == ".mp3":
            audio = MP3(path)
            if audio.tags is None:
                audio.add_tags()
            tags = cast(ID3, audio.tags)
            tags.clear()
            for frame in [
                TIT2(encoding=3, text=[meta.title]),
                TPE1(encoding=3, text=[meta.artist]),
                TPE2(encoding=3, text=[meta.album_artist]),
                TALB(encoding=3, text=[meta.album]),
                TRCK(encoding=3, text=[f"{meta.track}/{meta.tracks}"]),
                TPOS(encoding=3, text=[f"{meta.disc}/{meta.discs}"]),
                TDRC(encoding=3, text=[meta.date]),
                TCON(encoding=3, text=[meta.genre]),
                TPUB(encoding=3, text=[meta.label]),
                TSRC(encoding=3, text=[meta.isrc]),
                USLT(encoding=3, lang="eng", desc="", text=meta.lyrics or meta.synced_lyrics),
            ]:
                tags.add(frame)
            for key, value in extras.items():
                if value:
                    tags.add(TXXX(encoding=3, desc=id_names.get(key, key), text=[value]))
            if meta.mb_recording:
                tags.add(
                    UFID(owner="http://musicbrainz.org", data=meta.mb_recording.encode("ascii"))
                )
            if meta.synced_lyrics:
                tags.add(
                    SYLT(
                        encoding=3,
                        lang="eng",
                        format=2,
                        type=1,
                        desc="",
                        text=lrc_events(meta.synced_lyrics),
                    )
                )
            if cover:
                tags.add(APIC(encoding=3, mime="image/jpeg", type=3, desc="Cover", data=cover))
            audio.save()
        elif path.suffix == ".m4a":
            mp4 = MP4(path)
            mp4.clear()
            for key, value in {
                "\xa9nam": meta.title,
                "\xa9ART": meta.artist,
                "aART": meta.album_artist,
                "\xa9alb": meta.album,
                "\xa9day": meta.date,
                "\xa9gen": meta.genre,
                "\xa9lyr": meta.synced_lyrics or meta.lyrics,
            }.items():
                if value:
                    mp4[key] = [value]
            mp4["trkn"] = [(meta.track, meta.tracks)]
            mp4["disk"] = [(meta.disc, meta.discs)]
            mp4["rtng"] = [4 if meta.explicit else 2]
            for key, value in extras.items():
                if value:
                    mp4["----:com.apple.iTunes:" + id_names.get(key, key)] = [value.encode("utf-8")]
            if cover:
                mp4["covr"] = [MP4Cover(cover, imageformat=MP4Cover.FORMAT_JPEG)]
            mp4.save()
        else:
            vorbis = (
                FLAC(path)
                if path.suffix == ".flac"
                else OggOpus(path)
                if path.suffix == ".opus"
                else OggVorbis(path)
            )
            cast(TagMap, vorbis).clear()
            values = extras | {
                "TITLE": meta.title,
                "ARTIST": meta.artist,
                "ALBUMARTIST": meta.album_artist,
                "ALBUM": meta.album,
                "DATE": meta.date,
                "GENRE": meta.genre,
                "TRACKNUMBER": str(meta.track),
                "TRACKTOTAL": str(meta.tracks),
                "DISCNUMBER": str(meta.disc),
                "DISCTOTAL": str(meta.discs),
                "LYRICS": meta.synced_lyrics or meta.lyrics,
            }
            for key, value in values.items():
                if value:
                    vorbis[key] = [value]
            if cover:
                picture = Picture()
                picture.type, picture.mime, picture.desc, picture.data = (
                    3,
                    "image/jpeg",
                    "Cover",
                    cover,
                )
                if isinstance(vorbis, FLAC):
                    vorbis.clear_pictures()
                    vorbis.add_picture(picture)
                else:
                    vorbis["metadata_block_picture"] = [
                        base64.b64encode(picture.write()).decode("ascii")
                    ]
            vorbis.save()
        if meta.synced_lyrics:
            path.with_suffix(".lrc").write_text(meta.synced_lyrics, encoding="utf-8")
        probe(path)
