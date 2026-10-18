"""Tag facts for one audio file, from the single object Mutagen already opened.

Easy tags drop ReplayGain, the compilation flag and pictures. The raw frames are on that
same object, so a scan does not open the file twice.
"""

import json
import math
from dataclasses import dataclass

from mutagen.id3 import ID3
from mutagen.mp4 import MP4Tags

# Rows indexed before this version keep empty player columns until the file is read again.
TAGS_VERSION = 2

CONTENT_TYPES = {
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".flac": "audio/flac",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
    ".wav": "audio/wav",
    ".aiff": "audio/aiff",
    ".webm": "audio/webm",
    ".wma": "audio/x-ms-wma",
}


@dataclass(frozen=True)
class AudioFacts:
    title: str
    artist: str
    album: str
    album_artist: str
    duration: float
    isrc: str
    mbid: str
    track: int
    disc: int
    year: int
    genre: str
    genres: str
    compilation: int
    replaygain_track_gain: float | None
    replaygain_album_gain: float | None
    replaygain_track_peak: float | None
    replaygain_album_peak: float | None
    suffix: str
    content_type: str
    bitrate: int
    sample_rate: int
    bit_depth: int | None
    channels: int
    has_art: int
    record_labels: str
    codec: str


def text_list(value: object) -> list[str]:
    if isinstance(value, (list, tuple)):
        return [str(item).strip() for item in value if str(item).strip()]
    if value is None:
        return []
    text = str(value).strip()
    return [text] if text else []


def first(values: list[str]) -> str:
    return values[0] if values else ""


def clamped_number(raw: str) -> int:
    """The number before a slash. A blank or absurd value is stored as absent (0)."""
    head = raw.split("/", 1)[0].strip()
    try:
        value = int(head)
    except ValueError:
        return 0
    if value < 0 or value > 9999:
        return 0
    return value


def year_of(raw: str) -> int:
    digits = ""
    for char in raw:
        if char.isdigit():
            digits += char
            if len(digits) == 4:
                break
        elif digits:
            break
    if len(digits) != 4:
        return 0
    value = int(digits)
    return value if 1000 <= value <= 9999 else 0


def replay_gain(raw: str) -> float | None:
    """Decibels. Empty, NaN and unreadable text are absent. Zero is a real value."""
    text = raw.strip().casefold().removesuffix("db").strip()
    if not text:
        return None
    try:
        value = float(text)
    except ValueError:
        return None
    if math.isnan(value) or math.isinf(value):
        return None
    return value


def r128_gain(raw: str) -> float | None:
    """Opus R128 is a Q7.8 integer against -23 LUFS. ReplayGain's reference is 5 dB louder."""
    try:
        value = int(raw.strip())
    except ValueError:
        return None
    converted = value / 256.0 + 5.0
    if math.isnan(converted) or math.isinf(converted):
        return None
    return converted


def compilation_flag(values: list[str]) -> int:
    return int(any(item.casefold() in {"1", "true", "yes"} for item in values))


def id3_texts(tags: ID3, frame: str) -> list[str]:
    found = tags.get(frame)
    if found is None:
        return []
    return text_list(getattr(found, "text", None))


def id3_user(tags: ID3, description: str) -> list[str]:
    wanted = description.casefold()
    values: list[str] = []
    for frame in tags.getall("TXXX"):
        if str(getattr(frame, "desc", "")).casefold() == wanted:
            values.extend(text_list(getattr(frame, "text", None)))
    return values


def mp4_texts(tags: MP4Tags, key: str) -> list[str]:
    return text_list(tags.get(key))


def mp4_freeform(tags: MP4Tags, name: str) -> list[str]:
    raw = tags.get(f"----:com.apple.iTunes:{name}")
    if not isinstance(raw, list):
        return []
    values: list[str] = []
    for item in raw:
        if isinstance(item, bytes):
            text = item.decode("utf-8", "replace").strip()
        else:
            text = str(item).strip()
        if text:
            values.append(text)
    return values


class _Collected:
    def __init__(self) -> None:
        self.title: list[str] = []
        self.artist: list[str] = []
        self.album: list[str] = []
        self.album_artist: list[str] = []
        self.track: list[str] = []
        self.disc: list[str] = []
        self.date: list[str] = []
        self.genre: list[str] = []
        self.compilation: list[str] = []
        self.isrc: list[str] = []
        self.mbid: list[str] = []
        self.label: list[str] = []
        self.track_gain: list[str] = []
        self.album_gain: list[str] = []
        self.track_peak: list[str] = []
        self.album_peak: list[str] = []
        self.r128_track: list[str] = []
        self.r128_album: list[str] = []
        self.has_art = False
        self.mbid_bytes = b""


def from_id3(tags: ID3) -> _Collected:
    found = _Collected()
    found.title = id3_texts(tags, "TIT2")
    found.artist = id3_texts(tags, "TPE1")
    found.album = id3_texts(tags, "TALB")
    found.album_artist = id3_texts(tags, "TPE2")
    found.track = id3_texts(tags, "TRCK")
    found.disc = id3_texts(tags, "TPOS")
    found.date = id3_texts(tags, "TDRC") or id3_texts(tags, "TYER")
    found.genre = id3_texts(tags, "TCON")
    found.compilation = id3_texts(tags, "TCMP")
    found.isrc = id3_texts(tags, "TSRC")
    found.label = id3_texts(tags, "TPUB")
    found.mbid = id3_user(tags, "MusicBrainz Track Id")
    found.track_gain = id3_user(tags, "REPLAYGAIN_TRACK_GAIN")
    found.album_gain = id3_user(tags, "REPLAYGAIN_ALBUM_GAIN")
    found.track_peak = id3_user(tags, "REPLAYGAIN_TRACK_PEAK")
    found.album_peak = id3_user(tags, "REPLAYGAIN_ALBUM_PEAK")
    found.has_art = bool(tags.getall("APIC"))
    frame = tags.get("UFID:http://musicbrainz.org")
    data = getattr(frame, "data", b"")
    found.mbid_bytes = data if isinstance(data, bytes) else b""
    return found


def from_mp4(tags: MP4Tags) -> _Collected:
    found = _Collected()
    found.title = mp4_texts(tags, "\xa9nam")
    found.artist = mp4_texts(tags, "\xa9ART")
    found.album = mp4_texts(tags, "\xa9alb")
    found.album_artist = mp4_texts(tags, "aART")
    found.date = mp4_texts(tags, "\xa9day")
    found.genre = mp4_texts(tags, "\xa9gen")
    found.label = mp4_texts(tags, "\xa9pub")
    found.isrc = mp4_freeform(tags, "ISRC")
    found.mbid = mp4_freeform(tags, "MusicBrainz Track Id")
    found.track_gain = mp4_freeform(tags, "replaygain_track_gain")
    found.album_gain = mp4_freeform(tags, "replaygain_album_gain")
    found.track_peak = mp4_freeform(tags, "replaygain_track_peak")
    found.album_peak = mp4_freeform(tags, "replaygain_album_peak")
    track = tags.get("trkn")
    if isinstance(track, list) and track and isinstance(track[0], tuple) and track[0]:
        found.track = [str(track[0][0])]
    disc = tags.get("disk")
    if isinstance(disc, list) and disc and isinstance(disc[0], tuple) and disc[0]:
        found.disc = [str(disc[0][0])]
    compiled = tags.get("cpil")
    if compiled == [True] or compiled is True:
        found.compilation = ["1"]
    found.has_art = bool(tags.get("covr"))
    return found


def mapping_values(audio: object, key: str) -> list[str]:
    getter = getattr(audio, "get", None)
    if getter is None:
        return []
    try:
        return text_list(getter(key))
    except (KeyError, TypeError):
        return []


def from_mapping(audio: object) -> _Collected:
    """Vorbis comments, and the easy-tag shape the scan tests hand in."""
    found = _Collected()
    found.title = mapping_values(audio, "title") or mapping_values(audio, "TIT2")
    found.artist = mapping_values(audio, "artist") or mapping_values(audio, "TPE1")
    found.album = mapping_values(audio, "album") or mapping_values(audio, "TALB")
    found.album_artist = mapping_values(audio, "albumartist") or mapping_values(audio, "TPE2")
    found.track = mapping_values(audio, "tracknumber") or mapping_values(audio, "TRCK")
    found.disc = mapping_values(audio, "discnumber") or mapping_values(audio, "TPOS")
    found.date = mapping_values(audio, "date") or mapping_values(audio, "TDRC")
    found.genre = mapping_values(audio, "genre") or mapping_values(audio, "TCON")
    found.compilation = mapping_values(audio, "compilation") or mapping_values(audio, "TCMP")
    found.isrc = mapping_values(audio, "isrc") or mapping_values(audio, "TSRC")
    found.label = mapping_values(audio, "label") or mapping_values(audio, "organization")
    found.mbid = mapping_values(audio, "musicbrainz_trackid") or mapping_values(
        audio, "TXXX:MusicBrainz Track Id"
    )
    found.track_gain = mapping_values(audio, "replaygain_track_gain")
    found.album_gain = mapping_values(audio, "replaygain_album_gain")
    found.track_peak = mapping_values(audio, "replaygain_track_peak")
    found.album_peak = mapping_values(audio, "replaygain_album_peak")
    found.r128_track = mapping_values(audio, "r128_track_gain")
    found.r128_album = mapping_values(audio, "r128_album_gain")
    pictures = getattr(audio, "pictures", None)
    found.has_art = bool(pictures) or bool(mapping_values(audio, "metadata_block_picture"))
    getter = getattr(audio, "get", None)
    frame = getter("UFID:http://musicbrainz.org") if getter else None
    identifier = getattr(frame, "data", b"")
    found.mbid_bytes = identifier if isinstance(identifier, bytes) else b""
    return found


def collect(audio: object) -> _Collected:
    tags = getattr(audio, "tags", None)
    if isinstance(tags, ID3):
        return from_id3(tags)
    if isinstance(tags, MP4Tags):
        return from_mp4(tags)
    return from_mapping(audio)


def info_number(info: object, name: str) -> int:
    raw = getattr(info, name, None)
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        return 0
    if math.isnan(raw) or raw <= 0:
        return 0
    return int(raw)


def track_length(raw: object) -> float:
    """A stored length in seconds, 0 when unknown. A broken header can report inf or NaN:
    SQLite keeps inf (and refuses NaN in a NOT NULL column) and JSON can carry neither."""
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        return 0.0
    seconds = float(raw)
    return seconds if math.isfinite(seconds) and seconds > 0 else 0.0


def facts_for(audio: object, suffix: str, size: int) -> AudioFacts:
    found = collect(audio)
    info = getattr(audio, "info", None)
    duration = track_length(getattr(info, "length", 0))
    bitrate = info_number(info, "bitrate")
    if bitrate >= 1000:
        bitrate = int(round(bitrate / 1000))
    elif bitrate == 0 and duration > 0 and size > 0:
        bitrate = int(round(size * 8 / duration / 1000))
    codec = str(getattr(info, "codec", "") or "").casefold()
    depth: int | None = None
    if suffix in {".flac", ".wav", ".aiff"} or codec == "alac":
        bits = info_number(info, "bits_per_sample")
        depth = bits or None
    mbid = first(found.mbid)
    if not mbid and found.mbid_bytes:
        mbid = found.mbid_bytes.decode("ascii", errors="ignore")
    track_gain = replay_gain(first(found.track_gain)) if found.track_gain else None
    album_gain = replay_gain(first(found.album_gain)) if found.album_gain else None
    if track_gain is None and found.r128_track:
        track_gain = r128_gain(first(found.r128_track))
    if album_gain is None and found.r128_album:
        album_gain = r128_gain(first(found.r128_album))
    genres = found.genre
    labels = list(dict.fromkeys(found.label))
    return AudioFacts(
        title=first(found.title),
        artist=first(found.artist),
        album=first(found.album),
        album_artist=first(found.album_artist),
        duration=duration,
        isrc=first(found.isrc).upper().replace("-", ""),
        mbid=mbid,
        track=clamped_number(first(found.track)),
        disc=clamped_number(first(found.disc)),
        year=year_of(first(found.date)),
        genre=first(genres),
        genres=json.dumps(genres),
        compilation=compilation_flag(found.compilation),
        replaygain_track_gain=track_gain,
        replaygain_album_gain=album_gain,
        replaygain_track_peak=replay_gain(first(found.track_peak)) if found.track_peak else None,
        replaygain_album_peak=replay_gain(first(found.album_peak)) if found.album_peak else None,
        suffix=suffix.lstrip("."),
        content_type=CONTENT_TYPES.get(suffix, ""),
        bitrate=bitrate,
        sample_rate=info_number(info, "sample_rate"),
        bit_depth=depth,
        channels=info_number(info, "channels"),
        has_art=int(found.has_art),
        record_labels=json.dumps(labels),
        codec=codec,
    )
