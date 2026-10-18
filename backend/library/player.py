"""Playback from the music folders Musimo already indexes.

Album and artist ids are a frozen hash of the names, not `normalize()`, so a later
change to ownership matching cannot move them. A retag that changes the album or
artist name is a new id, and a favourite on the old name is left behind.
"""

import asyncio
import base64
import binascii
import hashlib
import json
import os
import random
import re
import secrets
import sqlite3
import threading
import time
from collections import OrderedDict
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field, replace
from pathlib import Path

import httpx
import mutagen
from mutagen.flac import Picture
from mutagen.id3 import ID3
from mutagen.mp4 import MP4Cover

from backend.core.store import Store
from backend.library.browse import (
    ArtistSummary,
    CatalogSnapshot,
    artist_facets,
    artist_summaries,
    filter_albums,
    filter_artists,
    filter_tracks,
    song_id,
    sort_albums,
    sort_artists,
    sort_tracks,
    track_facets,
    track_text,
)
from backend.library.lyrics import lyric_lines
from backend.library.tags import CONTENT_TYPES, track_length
from backend.version import VERSION

# The request validator and the comparators share these names.
TRACK_SORTS = ("title", "artist", "album", "year", "duration", "newest")
ALBUM_SORTS = ("newest", "title", "artist", "year")
ARTIST_SORTS = ("name", "albums", "recent")
ARTIST_SHOWS = ("favourites", "played", "unplayed")
# Shuffle keeps its order in memory. One pass, refreshed when the next window is asked for.
SHUFFLE_ORDER_SECONDS = 24 * 60 * 60
# Reaching this many songs is an error, so a huge library is not quietly cut short.
SHUFFLE_GUARD = 1_000_000
# Shared by every client. Capped by how many ids are held, not by how many passes.
SHUFFLE_ID_LIMIT = 2 * SHUFFLE_GUARD
LIKED_PLAYLIST_KEY = "liked"
LIKED_PLAYLIST_NAME = "Liked"
PLAYING = "Playing from your music folders"
UNMOUNTED = "No music folder is mounted"
# Spaced separators only, so "AC/DC" stays one name.
ARTIST_SPLIT = re.compile(r" / | feat\. | & ", re.IGNORECASE)
DISC_FOLDER = re.compile(r"^(?:cd|disc)\s*\d+$", re.IGNORECASE)
IMAGE_NAMES = ("cover", "folder", "front", "album")
IMAGE_TYPES = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
}
FRONT_COVER = 3


def is_cover_image(path: Path) -> bool:
    """A cover the art route will serve: cover, folder, front, or album."""
    if path.suffix.casefold() not in IMAGE_TYPES:
        return False
    stem = path.stem.casefold()
    return any(stem == name or stem.startswith(name + ".") for name in IMAGE_NAMES)


def ranked_cover_names(names: list[str]) -> list[str]:
    """Cover filenames, preferred first. `cover.jpg` comes before `cover.1.jpg`."""
    ranked: list[tuple[tuple[int, int, str], str]] = []
    for name in names:
        if not is_cover_image(Path(name)):
            continue
        stem = Path(name).stem.casefold()
        for index, image_name in enumerate(IMAGE_NAMES):
            if stem == image_name or stem.startswith(image_name + "."):
                ranked.append(((index, 0 if stem == image_name else 1, stem), name))
                break
    ranked.sort(key=lambda item: item[0])
    return [name for _rank, name in ranked]


class PlayerError(RuntimeError):
    """The player cannot complete the request. The route answers 503."""


class SongMissing(Exception):
    """No such song, album, artist or playlist. The route answers 404."""


class ShuffleExpired(Exception):
    """The server no longer has this shuffle's order. The queued window can still play."""


class PlaylistProtected(RuntimeError):
    pass


@dataclass(frozen=True)
class StoredSong:
    song_id: str
    path: str
    root: str
    size: int
    mtime_ns: int
    title: str
    artist: str
    album: str
    duration: float
    track: int
    disc: int
    year: int
    genre: str
    genres: tuple[str, ...]
    album_artist: str
    compilation: bool
    track_gain: float | None
    album_gain: float | None
    track_peak: float | None
    album_peak: float | None
    suffix: str
    content_type: str
    bitrate: int
    sample_rate: int
    bit_depth: int | None
    channels: int
    has_art: bool
    labels: tuple[str, ...]
    play_count: int
    last_played: str | None
    added_at: str
    codec: str
    flac_id3: bool

    @property
    def playback_warning(self) -> str:
        if self.codec == "alac":
            return "ALAC may not play in this browser"
        if self.suffix in {"wma", "aiff"}:
            return f"{self.suffix.upper()} may not play in this browser"
        if self.flac_id3:
            return "FLAC with ID3 tags may not play in this browser"
        return ""


@dataclass(frozen=True)
class ArtSource:
    """Where a cover's bytes are, and the size and time that version the URL."""

    path: Path
    embedded: bool
    size: int
    mtime_ns: int


@dataclass(frozen=True)
class CoverBytes:
    body: bytes
    media_type: str
    etag: str


@dataclass(frozen=True)
class FolderCover:
    path: str
    size: int
    mtime_ns: int


@dataclass
class LibraryView:
    revision: int
    token: int
    tracks: list[dict[str, object]]
    albums: list[dict[str, object]]
    artists: list[dict[str, object]]
    summaries: dict[str, ArtistSummary]
    facets: dict[str, object]
    by_song: dict[str, dict[str, object]]
    stored: dict[str, StoredSong]
    album_songs: dict[str, list[StoredSong]]
    artist_albums: dict[str, list[dict[str, object]]]
    covers: dict[str, FolderCover]
    # Filled on first use. The dicts inside are the track rows, so a play count still shows.
    track_orders: dict[str, list[dict[str, object]]]
    track_facets: dict[str, object] | None
    album_orders: dict[str, list[dict[str, object]]] = field(default_factory=dict)


def frozen_id(kind: str, *parts: str) -> str:
    """`al-` or `ar-` plus 16 hex characters. The prefix is part of the frozen input."""
    blob = b"\0".join(part.encode("utf-8") for part in (kind, *parts))
    digest = hashlib.sha256(b"musimo-id-v1\0" + blob).hexdigest()[:16]
    return f"{kind}-{digest}"


def artist_pieces(name: str) -> list[str]:
    return [part.strip() for part in ARTIST_SPLIT.split(name) if part.strip()]


def album_artist_name(song: StoredSong) -> str:
    """Compilation with no album artist is Various Artists. Otherwise the album artist,
    then the track artist."""
    if song.compilation and not song.album_artist.strip():
        return "Various Artists"
    if song.album_artist.strip():
        return song.album_artist.strip()
    if song.artist.strip():
        return song.artist.strip()
    return "Unknown artist"


def linked_artist(track_artist: str, album_artist: str, names_with_albums: set[str]) -> str:
    """The artist page a song should open.

    The song's own artist, when that name has albums. Otherwise the first piece split
    off on a spaced separator that has albums. Otherwise the album artist. "AC/DC" is
    never split, because the separators all contain spaces.
    """
    own = track_artist.strip()
    if own and own in names_with_albums:
        return own
    for part in artist_pieces(own):
        if part != own and part in names_with_albums:
            return part
    return album_artist


def json_strings(raw: object) -> tuple[str, ...]:
    if not isinstance(raw, str) or not raw:
        return ()
    try:
        parsed: object = json.loads(raw)
    except ValueError:
        return ()
    if not isinstance(parsed, list):
        return ()
    return tuple(item.strip() for item in parsed if isinstance(item, str) and item.strip())


def optional_float(value: object) -> float | None:
    """Zero is a real ReplayGain value. Only a missing column is absent."""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    return None


def optional_int(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def cover_version(size: int, mtime_ns: int) -> str:
    return hashlib.sha256(f"{size}:{mtime_ns}".encode()).hexdigest()[:8]


def cover_etag(size: int, mtime_ns: int) -> str:
    return f'"{hashlib.sha256(f"{size}:{mtime_ns}".encode()).hexdigest()[:16]}"'


def cover_beside(covers: Mapping[str, FolderCover], folder: Path) -> FolderCover | None:
    """The image in this folder, or in the parent of a disc folder (`CD1`, `Disc 2`)."""
    found = covers.get(str(folder))
    if found is not None or not DISC_FOLDER.fullmatch(folder.name):
        return found
    parent = folder.parent
    if parent == folder:
        return None
    return covers.get(str(parent))


def unique_names(names: list[str]) -> list[str]:
    found: dict[str, str] = {}
    for name in names:
        text = name.strip()
        if text:
            found.setdefault(text.casefold(), text)
    return list(found.values())


def playlist_number(value: str) -> int | None:
    if not value.startswith("pl-"):
        return None
    rest = value[3:]
    if not rest.isdigit():
        return None
    return int(rest)


def owner_of(cover_id: str) -> str:
    """A cover id is the owner's id plus `_` and a version. The owner has no underscore."""
    if "_" not in cover_id:
        return cover_id
    owner, _version = cover_id.rsplit("_", 1)
    if owner.startswith(("tr-", "al-", "ar-")):
        return owner
    return cover_id


def _fts_usable(text: str) -> bool:
    """FTS misses short names, punctuation and some non-ASCII. Those stay on a scan."""
    tokens = text.split()
    return bool(tokens) and all(len(token) >= 3 and token.isalnum() for token in tokens)


def song_row(row: sqlite3.Row) -> StoredSong:
    depth = optional_int(row["bit_depth"])
    played = row["last_played"]
    return StoredSong(
        song_id=str(row["song_id"]),
        path=str(row["path"]),
        root=str(row["root"]),
        size=int(row["size"]),
        mtime_ns=int(row["mtime_ns"]),
        title=str(row["title"]),
        artist=str(row["artist"]),
        album=str(row["album"]),
        # Rows scanned before lengths were clamped can still hold inf.
        duration=track_length(row["duration"]),
        track=int(row["track"]),
        disc=int(row["disc"]),
        year=int(row["year"]),
        genre=str(row["genre"]),
        genres=json_strings(row["genres"]),
        album_artist=str(row["album_artist"]),
        compilation=bool(row["compilation"]),
        track_gain=optional_float(row["replaygain_track_gain"]),
        album_gain=optional_float(row["replaygain_album_gain"]),
        track_peak=optional_float(row["replaygain_track_peak"]),
        album_peak=optional_float(row["replaygain_album_peak"]),
        suffix=str(row["suffix"]),
        content_type=str(row["content_type"]),
        bitrate=int(row["bitrate"]),
        sample_rate=int(row["sample_rate"]),
        bit_depth=depth,
        channels=int(row["channels"]),
        has_art=bool(row["has_art"]),
        labels=json_strings(row["record_labels"]),
        play_count=int(row["play_count"]),
        last_played=str(played) if isinstance(played, str) and played else None,
        added_at=str(row["added_at"]),
        codec=str(row["codec"]),
        flac_id3=bool(row["flac_id3"]),
    )


def folder_identity(song: StoredSong) -> tuple[str, str]:
    """Untagged albums group per folder. The id uses the path; the screen uses the name."""
    parent = Path(song.path).parent
    try:
        relative = parent.relative_to(Path(song.root)).as_posix()
    except ValueError:
        relative = parent.as_posix()
    return "folder:" + relative, parent.name or "Unknown album"


def album_identity(song: StoredSong) -> tuple[str, str, str]:
    """Album artist, the frozen identity, and the name to show.

    A tagged album ignores its folder, so two copies of one album stay one album.
    """
    artist = album_artist_name(song)
    titled = song.album.strip()
    if titled:
        return artist, titled, titled
    identity, name = folder_identity(song)
    return artist, identity, name


def replay_fields(song: StoredSong) -> dict[str, float]:
    found: dict[str, float] = {}
    if song.track_gain is not None:
        found["trackGain"] = song.track_gain
    if song.album_gain is not None:
        found["albumGain"] = song.album_gain
    if song.track_peak is not None:
        found["trackPeak"] = song.track_peak
    if song.album_peak is not None:
        found["albumPeak"] = song.album_peak
    return found


def track_dict(
    song: StoredSong, album_name: str, album_id: str, artist_id: str, cover: str
) -> dict[str, object]:
    item: dict[str, object] = {
        "id": song.song_id,
        "title": song.title.strip() or "Unknown track",
        "artist": song.artist.strip() or "Unknown artist",
        "artistId": artist_id,
        "album": album_name,
        "albumId": album_id,
        "duration": song.duration,
        "created": song.added_at,
        "playCount": song.play_count,
        "codec": song.codec,
        "playbackWarning": song.playback_warning,
    }
    if song.track:
        item["track"] = song.track
    if song.disc:
        item["discNumber"] = song.disc
    if song.year:
        item["year"] = song.year
    if song.genre:
        item["genre"] = song.genre
    if cover:
        item["coverArt"] = cover
    gain = replay_fields(song)
    if gain:
        item["replayGain"] = gain
    return item


def pictures_in(path: Path) -> list[tuple[int, str, bytes]]:
    try:
        audio = mutagen.File(path)
    except (OSError, mutagen.MutagenError):
        return []
    if audio is None:
        return []
    found: list[tuple[int, str, bytes]] = []
    tags = getattr(audio, "tags", None)
    if tags is not None and hasattr(tags, "getall"):
        for frame in tags.getall("APIC"):
            data = getattr(frame, "data", b"")
            if isinstance(data, bytes) and data:
                mime = str(getattr(frame, "mime", "") or "image/jpeg")
                kind = getattr(frame, "type", 0)
                found.append((kind if isinstance(kind, int) else 0, mime, data))
    pictures = getattr(audio, "pictures", None)
    if isinstance(pictures, list):
        for picture in pictures:
            data = getattr(picture, "data", b"")
            if isinstance(data, bytes) and data:
                mime = str(getattr(picture, "mime", "") or "image/jpeg")
                kind = getattr(picture, "type", 0)
                found.append((kind if isinstance(kind, int) else 0, mime, data))
    if tags is not None and hasattr(tags, "get"):
        # Opus and Vorbis store FLAC picture blocks inside base64-encoded comments.
        blocks = tags.get("metadata_block_picture", [])
        if isinstance(blocks, list):
            for block in blocks:
                if not isinstance(block, str):
                    continue
                try:
                    picture = Picture(base64.b64decode(block, validate=True))
                except (ValueError, binascii.Error, mutagen.MutagenError):
                    continue
                if picture.data:
                    found.append((picture.type, picture.mime, picture.data))
        covers = tags.get("covr")
        if isinstance(covers, list):
            for cover in covers:
                if isinstance(cover, bytes) and cover:
                    imageformat = getattr(cover, "imageformat", None)
                    mime = "image/png" if imageformat == MP4Cover.FORMAT_PNG else "image/jpeg"
                    found.append((FRONT_COVER, mime, bytes(cover)))
    return found


def pick_picture(pictures: list[tuple[int, str, bytes]]) -> tuple[str, bytes] | None:
    """Front cover (type 3) wins. Otherwise the first picture."""
    for kind, mime, data in pictures:
        if kind == FRONT_COVER and data:
            return mime or "image/jpeg", data
    for _kind, mime, data in pictures:
        if data:
            return mime or "image/jpeg", data
    return None


def plain_lyrics(audio: object) -> str:
    tags = getattr(audio, "tags", None)
    if isinstance(tags, ID3):
        for frame in tags.getall("USLT"):
            text = getattr(frame, "text", "")
            if isinstance(text, str) and text.strip():
                return text
        return ""
    if tags is not None and hasattr(tags, "get"):
        lyr = tags.get("\xa9lyr")
        if isinstance(lyr, list):
            for item in lyr:
                if isinstance(item, str) and item.strip():
                    return item
    getter = getattr(audio, "get", None)
    if getter is None:
        return ""
    for key in ("lyrics", "unsyncedlyrics", "LYRICS", "UNSYNCEDLYRICS"):
        try:
            values = getter(key)
        except (KeyError, TypeError):
            continue
        if isinstance(values, list):
            for item in values:
                if str(item).strip():
                    return str(item)
        elif isinstance(values, str) and values.strip():
            return values
    return ""


def synced_lyrics(audio: object) -> list[dict[str, object]]:
    tags = getattr(audio, "tags", None)
    if not isinstance(tags, ID3):
        return []
    for frame in tags.getall("SYLT"):
        text = getattr(frame, "text", None)
        if not isinstance(text, list):
            continue
        lines: list[dict[str, object]] = []
        for item in text:
            if isinstance(item, tuple) and len(item) >= 2 and isinstance(item[1], int):
                lines.append({"start": item[1], "value": str(item[0]).strip()})
        if lines:
            return lines
    return []


def lyric_payload(
    artist: str, title: str, lines: list[dict[str, object]], synced: bool
) -> dict[str, object]:
    return {
        "displayArtist": artist,
        "displayTitle": title,
        "synced": synced,
        "line": lines,
    }


class Player:
    def __init__(
        self, store: Store, roots: list[Path], client: httpx.AsyncClient | None = None
    ) -> None:
        self.store = store
        self.roots = list(roots)
        self.client = client
        self._lock = threading.Lock()
        # One build at a time. A page opened while the background warm is running waits for it.
        self._build_lock = threading.Lock()
        self._token = 0
        self._cached: LibraryView | None = None
        # Absolute play and star values applied onto a catalog built from an older read.
        self._plays: dict[str, tuple[int, str | None]] = {}
        self._stars: dict[str, str | None] = {}
        self.shuffle_orders: OrderedDict[str, tuple[float, list[str]]] = OrderedDict()

    def _invalidate(self) -> None:
        with self._lock:
            self._token += 1
            self._cached = None

    async def _catalog(self) -> LibraryView:
        """Browse data from the index. Cover rows come from the scan, so folders are not listed."""
        return await asyncio.to_thread(self.view)

    def view(self) -> LibraryView:
        revision = self.store.library_revision()
        with self._lock:
            token = self._token
            cached = self._cached
            if cached is not None and cached.revision == revision and cached.token == token:
                return cached
        with self._build_lock:
            with self._lock:
                token = self._token
                cached = self._cached
                if cached is not None and cached.revision == revision and cached.token == token:
                    return cached
            built = self._build(
                self._load_rows(),
                self._load_covers(),
                self.store.artist_favourites(),
                revision,
                token,
            )
            with self._lock:
                if self._token != token:
                    self._overlay(built)
                    return built
                current = self._cached
                if current is not None and current.revision == revision and current.token == token:
                    return current
                self._overlay(built)
                self._cached = built
                return built

    async def warm(self) -> None:
        """Build the browse snapshot, and the sorts the home page and Tracks open with."""
        await asyncio.to_thread(self._warm_catalog)

    def _warm_catalog(self) -> None:
        snapshot = self.view()
        self._cached_order(snapshot.track_orders, "title", snapshot.tracks, sort_tracks)
        self._cached_order(snapshot.album_orders, "newest", snapshot.albums, sort_albums)
        self._facets(snapshot)

    async def keep_ready(self) -> None:
        """Rebuild after the index changes, so the next page is already in memory."""
        seen: int | None = None
        while True:
            try:
                revision = await asyncio.to_thread(self.store.library_revision)
                cached = self._cached
                if cached is None or cached.revision != revision or seen != revision:
                    await self.warm()
                    cached = self._cached
                    seen = cached.revision if cached is not None else None
            except asyncio.CancelledError:
                raise
            except Exception:
                # A failed warm leaves the next request to build the page itself.
                seen = None
            await asyncio.sleep(2)

    def _overlay(self, snapshot: LibraryView) -> None:
        """Play counts and stars that landed while this catalog was being built."""
        for played_id, (count, played) in self._plays.items():
            self._write_play(snapshot, played_id, count, played)
        for artist_id, starred in self._stars.items():
            self._write_star(snapshot, artist_id, starred)

    def _write_play(
        self, snapshot: LibraryView | None, song_id: str, count: int, played: str | None
    ) -> None:
        if snapshot is None:
            return
        song = snapshot.stored.get(song_id)
        if song is None:
            return
        updated = replace(song, play_count=count, last_played=played)
        snapshot.stored[song_id] = updated
        track = snapshot.by_song.get(song_id)
        if track is not None:
            track["playCount"] = count
            if played:
                track["played"] = played
            else:
                track.pop("played", None)
        album_id = track.get("albumId") if track is not None else None
        if not isinstance(album_id, str):
            return
        songs = snapshot.album_songs.get(album_id)
        if songs is None:
            return
        snapshot.album_songs[album_id] = [
            updated if item.song_id == song_id else item for item in songs
        ]
        total = sum(item.play_count for item in snapshot.album_songs[album_id])
        for album in snapshot.albums:
            if album.get("id") != album_id:
                continue
            album["playCount"] = total
            artist_id = album.get("artistId")
            if isinstance(artist_id, str) and total > 0:
                summary = snapshot.summaries.get(artist_id)
                if summary is not None:
                    summary.played = True
            break

    def _write_star(
        self, snapshot: LibraryView | None, artist_id: str, starred: str | None
    ) -> None:
        if snapshot is None:
            return
        for row in snapshot.artists:
            if row.get("id") != artist_id:
                continue
            if starred:
                row["starred"] = starred
            else:
                row.pop("starred", None)
            break

    def _load_rows(self) -> list[StoredSong]:
        with self.store.lock:
            rows = self.store.db.execute(
                """
                SELECT f.song_id, f.path, f.root, f.size, f.mtime_ns, f.title, f.artist, f.album,
                    f.duration, f.track, f.disc, f.year, f.genre, f.genres, f.album_artist,
                    f.compilation, f.replaygain_track_gain, f.replaygain_album_gain,
                    f.replaygain_track_peak, f.replaygain_album_peak, f.suffix, f.content_type,
                    f.bitrate, f.sample_rate, f.bit_depth, f.channels, f.has_art,
                    f.record_labels, f.play_count, f.last_played, f.added_at, f.codec, f.flac_id3
                FROM library_files f
                JOIN library_roots r ON r.path = f.root AND r.enabled = 1
                WHERE f.song_id != ''
                """
            ).fetchall()
        return [song_row(row) for row in rows]

    def _load_covers(self) -> dict[str, FolderCover]:
        return {
            folder: FolderCover(path, size, mtime_ns)
            for folder, (path, size, mtime_ns) in self.store.folder_covers().items()
        }

    def _cached_order(
        self,
        orders: dict[str, list[dict[str, object]]],
        sort: str,
        rows: list[dict[str, object]],
        order_fn: Callable[[list[dict[str, object]], str], list[dict[str, object]]],
    ) -> list[dict[str, object]]:
        """One sort of these rows, reused by later pages. A filter sorts its own rows."""
        with self._lock:
            found = orders.get(sort)
        if found is not None:
            return found
        ordered = order_fn(rows, sort)
        with self._lock:
            return orders.setdefault(sort, ordered)

    async def _page_order(
        self,
        plain: bool,
        orders: dict[str, list[dict[str, object]]],
        sort: str,
        everything: list[dict[str, object]],
        chosen: list[dict[str, object]],
        order_fn: Callable[[list[dict[str, object]], str], list[dict[str, object]]],
    ) -> list[dict[str, object]]:
        """The cached whole-library order, or a sort of the filtered rows."""
        if not plain:
            return order_fn(chosen, sort)
        found = orders.get(sort)
        if found is None:
            found = await asyncio.to_thread(self._cached_order, orders, sort, everything, order_fn)
        return found

    def _facets(self, snapshot: LibraryView) -> dict[str, object]:
        with self._lock:
            if snapshot.track_facets is not None:
                return snapshot.track_facets
        facets = track_facets(snapshot.tracks)
        with self._lock:
            if snapshot.track_facets is None:
                snapshot.track_facets = facets
            return snapshot.track_facets

    def _build(
        self,
        songs: list[StoredSong],
        covers: dict[str, FolderCover],
        favourites: Mapping[str, str],
        revision: int,
        token: int,
    ) -> LibraryView:
        grouped: dict[tuple[str, str], list[StoredSong]] = {}
        names: dict[tuple[str, str], str] = {}
        for song in songs:
            artist, identity, name = album_identity(song)
            key = (artist, identity)
            grouped.setdefault(key, []).append(song)
            names[key] = name
        album_artists = {artist for artist, _identity in grouped}
        albums: list[dict[str, object]] = []
        tracks: list[dict[str, object]] = []
        by_song: dict[str, dict[str, object]] = {}
        stored = {song.song_id: song for song in songs}
        album_songs: dict[str, list[StoredSong]] = {}
        artist_album_rows: dict[str, list[dict[str, object]]] = {}

        for key, members in grouped.items():
            artist, identity = key
            ordered = sorted(
                members, key=lambda song: (song.disc, song.track, song.title.casefold(), song.path)
            )
            album_id = frozen_id("al", artist, identity)
            album_songs[album_id] = ordered
            source = self._album_art(ordered, covers)
            cover = f"{album_id}_{cover_version(source.size, source.mtime_ns)}" if source else ""
            genre_names = [
                name
                for song in ordered
                for name in (song.genres or ((song.genre,) if song.genre else ()))
            ]
            genres = unique_names(genre_names)
            labels = unique_names([label for song in ordered for label in song.labels])
            years = [song.year for song in ordered if song.year]
            album: dict[str, object] = {
                "id": album_id,
                "name": names[key],
                "artist": artist,
                "artistId": frozen_id("ar", artist),
                "songCount": len(ordered),
                "duration": sum(song.duration for song in ordered),
                "playCount": sum(song.play_count for song in ordered),
                "created": max(song.added_at for song in ordered),
            }
            if cover:
                album["coverArt"] = cover
            if years:
                album["year"] = max(years)
            if genres:
                album["genre"] = genres[0]
                album["genres"] = [{"name": name} for name in genres]
            if labels:
                album["recordLabels"] = [{"name": name} for name in labels]
            for song in ordered:
                chosen = linked_artist(song.artist, artist, album_artists)
                song_cover = self._song_cover_id(song, covers)
                item = track_dict(song, names[key], album_id, frozen_id("ar", chosen), song_cover)
                by_song[song.song_id] = item
                tracks.append(item)
            albums.append(album)
            artist_album_rows.setdefault(artist, []).append(album)

        artists: list[dict[str, object]] = []
        artist_albums: dict[str, list[dict[str, object]]] = {}
        for name, rows in artist_album_rows.items():
            artist_id = frozen_id("ar", name)
            ordered_albums = sorted(rows, key=album_recency, reverse=True)
            artist_albums[artist_id] = ordered_albums
            artist_row: dict[str, object] = {
                "id": artist_id,
                "name": name,
                "albumCount": len(ordered_albums),
            }
            starred = favourites.get(artist_id)
            if starred:
                artist_row["starred"] = starred
            for album_row in ordered_albums:
                cover_id = album_row.get("coverArt")
                if isinstance(cover_id, str) and cover_id:
                    version = cover_id.rsplit("_", 1)[-1]
                    artist_row["coverArt"] = f"{artist_id}_{version}"
                    break
            artists.append(artist_row)

        return LibraryView(
            revision,
            token,
            tracks,
            albums,
            artists,
            artist_summaries(albums),
            artist_facets(albums),
            by_song,
            stored,
            album_songs,
            artist_albums,
            covers,
            {},
            None,
        )

    def _song_art(self, song: StoredSong, covers: Mapping[str, FolderCover]) -> ArtSource | None:
        """Embedded picture, otherwise the cover image the scan recorded for the folder."""
        if song.has_art:
            return ArtSource(Path(song.path), True, song.size, song.mtime_ns)
        found = cover_beside(covers, Path(song.path).parent)
        if found is None:
            return None
        return ArtSource(Path(found.path), False, found.size, found.mtime_ns)

    def _song_cover_id(self, song: StoredSong, covers: Mapping[str, FolderCover]) -> str:
        source = self._song_art(song, covers)
        if source is None:
            return ""
        return f"{song.song_id}_{cover_version(source.size, source.mtime_ns)}"

    def _album_art(
        self, songs: list[StoredSong], covers: Mapping[str, FolderCover]
    ) -> ArtSource | None:
        """The folder image beside the first track, otherwise the first track that has a picture."""
        if not songs:
            return None
        found = cover_beside(covers, Path(songs[0].path).parent)
        if found is not None:
            return ArtSource(Path(found.path), False, found.size, found.mtime_ns)
        for song in songs:
            if song.has_art:
                return ArtSource(Path(song.path), True, song.size, song.mtime_ns)
        return None

    def _safe_file(self, path: Path) -> Path | None:
        """A regular file inside a configured root. A symlink is refused, even after a scan."""
        try:
            if path.is_symlink():
                return None
            resolved = path.resolve(strict=True)
        except OSError:
            return None
        if not resolved.is_file():
            return None
        for root in self.roots:
            try:
                if resolved.is_relative_to(root.resolve()):
                    return resolved
            except OSError:
                continue
        return None

    def local_file(self, song_id: str) -> Path | None:
        with self.store.lock:
            row = self.store.db.execute(
                """
                SELECT f.path FROM library_files f
                JOIN library_roots r ON r.path = f.root AND r.enabled = 1
                WHERE f.song_id = ?
                """,
                (song_id,),
            ).fetchone()
        if row is None:
            return None
        return self._safe_file(Path(str(row["path"])))

    def _narrow(self, tracks: list[dict[str, object]], query: str) -> list[dict[str, object]]:
        text = query.strip()
        if not text:
            return tracks
        if _fts_usable(text):
            ids = self._fts_ids(text)
            if ids:
                matched = [row for row in tracks if song_id(row) in ids]
                if matched:
                    return matched
        needle = text.casefold()
        return [
            row
            for row in tracks
            if needle in track_text(row, "title")
            or needle in track_text(row, "artist")
            or needle in track_text(row, "album")
        ]

    def _fts_ids(self, text: str) -> set[str]:
        tokens = re.findall(r"\w+", text, flags=re.UNICODE)
        if not tokens:
            return set()
        match = " AND ".join(f'"{token}"' for token in tokens)
        try:
            with self.store.lock:
                rows = self.store.db.execute(
                    """
                    SELECT f.song_id FROM library_fts
                    JOIN library_files f ON f.path = library_fts.path
                    JOIN library_roots r ON r.path = f.root AND r.enabled = 1
                    WHERE library_fts MATCH ?
                    """,
                    (match,),
                ).fetchall()
        except sqlite3.OperationalError:
            return set()
        return {str(row[0]) for row in rows if row[0]}

    async def capabilities(self) -> dict[str, object]:
        if not self.roots:
            return {
                "configured": False,
                "available": False,
                "version": VERSION,
                "detail": UNMOUNTED,
            }
        readable = False
        for root in self.roots:
            try:
                if root.is_dir() and os.access(root, os.R_OK):
                    readable = True
                    break
            except OSError:
                continue
        if readable:
            return {
                "configured": True,
                "available": True,
                "version": VERSION,
                "detail": PLAYING,
            }
        return {
            "configured": True,
            "available": False,
            "version": VERSION,
            "detail": UNMOUNTED,
        }

    async def browse_albums(
        self,
        query: str,
        sort: str,
        genres: list[str],
        years: list[int],
        offset: int,
        size: int,
    ) -> dict[str, object]:
        snapshot = await self._catalog()
        plain = not query and not genres and not years
        chosen = snapshot.albums if plain else filter_albums(snapshot.albums, query, genres, years)
        ordered = await self._page_order(
            plain, snapshot.album_orders, sort, snapshot.albums, chosen, sort_albums
        )
        end = offset + size
        return {
            "items": ordered[offset:end],
            "next_offset": end if end < len(ordered) else None,
            "total": len(ordered),
            **snapshot.facets,
        }

    async def browse_artists(
        self,
        query: str,
        sort: str,
        genres: list[str],
        years: list[int],
        show: str,
        offset: int,
        size: int,
    ) -> dict[str, object]:
        snapshot = await self._catalog()
        catalog = CatalogSnapshot(
            0, snapshot.artists, snapshot.albums, snapshot.summaries, snapshot.facets
        )
        ordered = sort_artists(
            filter_artists(catalog, query, genres, years, show),
            snapshot.summaries,
            sort,
        )
        end = offset + size
        return {
            "items": ordered[offset:end],
            "next_offset": end if end < len(ordered) else None,
            "total": len(ordered),
            **snapshot.facets,
        }

    async def favourite_artist(self, artist_id: str, favourite: bool) -> None:
        starred = self.store.set_artist_favourite(artist_id, favourite)
        with self._lock:
            self._stars[artist_id] = starred
            self._write_star(self._cached, artist_id, starred)

    async def browse_tracks(
        self,
        query: str,
        sort: str,
        genres: list[str],
        years: list[int],
        offset: int,
        size: int,
    ) -> dict[str, object]:
        snapshot = await self._catalog()
        plain = not query and not genres and not years
        rows = snapshot.tracks if plain else self._narrow(snapshot.tracks, query)
        chosen = rows if plain else filter_tracks(rows, genres, years)
        ordered = await self._page_order(
            plain, snapshot.track_orders, sort, snapshot.tracks, chosen, sort_tracks
        )
        if query:
            facets = track_facets(rows)
        elif snapshot.track_facets is None:
            facets = await asyncio.to_thread(self._facets, snapshot)
        else:
            facets = snapshot.track_facets
        end = offset + size
        return {
            "items": ordered[offset:end],
            "next_offset": end if end < len(ordered) else None,
            "total": len(ordered),
            **facets,
        }

    async def tracks(self, query: str, offset: int, size: int) -> list[dict[str, object]]:
        return self._narrow((await self._catalog()).tracks, query)[offset : offset + size]

    async def select_tracks(
        self,
        query: str,
        sort: str,
        genres: list[str],
        years: list[int],
        shuffle: bool,
        limit: int,
    ) -> dict[str, object]:
        snapshot = await self._catalog()
        plain = not query and not genres and not years
        matched = (
            snapshot.tracks
            if plain
            else filter_tracks(self._narrow(snapshot.tracks, query), genres, years)
        )
        if not shuffle:
            order = await self._page_order(
                plain, snapshot.track_orders, sort, snapshot.tracks, matched, sort_tracks
            )
            return {
                "items": order[:limit],
                "rest": [],
                "total": len(matched),
                "seed": "",
                "cursor": 0,
            }
        if len(matched) > SHUFFLE_GUARD:
            raise PlayerError("This library is too large to shuffle")
        seen: set[str] = set()
        ids: list[str] = []
        by_id: dict[str, dict[str, object]] = {}
        for row in matched:
            text = song_id(row)
            if not text or text in seen:
                continue
            seen.add(text)
            ids.append(text)
            by_id[text] = row
        random.shuffle(ids)
        cursor = min(limit, len(ids))
        seed = ""
        if len(ids) > limit:
            seed = secrets.token_urlsafe(16)
            self.remember_shuffle(seed, ids)
        return {
            "items": [by_id[text] for text in ids[:cursor] if text in by_id],
            "rest": [],
            "total": len(ids),
            "seed": seed,
            "cursor": cursor,
        }

    def remember_shuffle(self, seed: str, ids: list[str], replaces: str = "") -> None:
        """Keep a pass under its seed. `replaces` is the finished pass this one follows."""
        now = time.monotonic()
        self.expire_shuffles(now)
        if replaces:
            self.shuffle_orders.pop(replaces, None)
        self.shuffle_orders[seed] = (now, ids)
        self.shuffle_orders.move_to_end(seed)
        held = sum(len(order) for _fetched, order in self.shuffle_orders.values())
        while held > SHUFFLE_ID_LIMIT and len(self.shuffle_orders) > 1:
            _seed, (_fetched, oldest) = self.shuffle_orders.popitem(last=False)
            held -= len(oldest)

    def expire_shuffles(self, now: float) -> None:
        stale = [
            key
            for key, (fetched, _ids) in self.shuffle_orders.items()
            if now - fetched > SHUFFLE_ORDER_SECONDS
        ]
        for key in stale:
            del self.shuffle_orders[key]

    def borrow_shuffle(self, seed: str) -> list[str]:
        now = time.monotonic()
        self.expire_shuffles(now)
        found = self.shuffle_orders.get(seed)
        if found is None:
            raise ShuffleExpired("That shuffle is no longer on the server")
        _fetched, ids = found
        self.shuffle_orders[seed] = (now, ids)
        self.shuffle_orders.move_to_end(seed)
        return ids

    async def shuffle_window(
        self, seed: str, cursor: int, limit: int, skip: list[str]
    ) -> dict[str, object]:
        """The next songs in a shuffle, or a new pass once that order is used up.

        Songs still in the queue are left out of the new pass so the join does not repeat them.
        """
        ids = self.borrow_shuffle(seed)
        if cursor >= len(ids):
            skip_set = set(skip)
            nxt = [text for text in ids if text not in skip_set]
            if not nxt:
                return {
                    "items": [],
                    "missing": [],
                    "seed": seed,
                    "cursor": len(ids),
                    "total": len(ids),
                }
            random.shuffle(nxt)
            finished = seed
            seed = secrets.token_urlsafe(16)
            self.remember_shuffle(seed, nxt, replaces=finished)
            ids = nxt
            cursor = 0
        chunk = ids[cursor : cursor + limit]
        if not chunk:
            return {"items": [], "missing": [], "seed": seed, "cursor": cursor, "total": len(ids)}
        looked = await self.tracks_by_ids(chunk)
        return {
            "items": looked["items"],
            "missing": looked["missing"],
            "seed": seed,
            "cursor": cursor + len(chunk),
            "total": len(ids),
        }

    async def tracks_by_ids(self, ids: list[str]) -> dict[str, object]:
        found = (await self._catalog()).by_song
        return {
            "items": [found[text] for text in ids if text in found],
            "missing": [text for text in ids if text not in found],
        }

    async def playlists(self) -> list[dict[str, object]]:
        snapshot = await self._catalog()
        items: list[dict[str, object]] = []
        for row in self.store.list_playlists():
            number = row_number(row)
            if number is None:
                continue
            detail = self.store.playlist(number)
            items.append(self._playlist_item(row, song_list(detail), snapshot, False))
        return items

    def liked_id(self) -> str:
        """The liked playlist's id, after a dead stored link is dropped or replaced.

        An older database can still hold an id from the previous playback server. Listing
        playlists has to return an id the screen can match, or Liked can be deleted.
        """
        stored = self.store.linked_playlist(LIKED_PLAYLIST_KEY) or ""
        number = playlist_number(stored) if stored else None
        if number is not None and self.store.playlist(number) is not None:
            return stored
        # An empty link is not a playlist the listener named Liked. Only a dead
        # stored id is replaced, so that name can still be deleted on its own.
        if not stored:
            return ""
        self.store.clear_linked_playlist(LIKED_PLAYLIST_KEY)
        for row in self.store.list_playlists():
            if str(row["name"]) == LIKED_PLAYLIST_NAME:
                adopted = f"pl-{row['id']}"
                self.store.set_linked_playlist(LIKED_PLAYLIST_KEY, adopted)
                return adopted
        return ""

    async def linked_playlist(self) -> dict[str, object]:
        current = self.liked_id()
        if current:
            return await self.playlist(current)
        created = await self.create_playlist(LIKED_PLAYLIST_NAME, [])
        created_id = created.get("id")
        if isinstance(created_id, str) and created_id:
            self.store.set_linked_playlist(LIKED_PLAYLIST_KEY, created_id)
        return created

    async def playlist(self, playlist_id: str) -> dict[str, object]:
        number = playlist_number(playlist_id)
        if number is None:
            raise SongMissing("Playlist not found")
        detail = self.store.playlist(number)
        if detail is None:
            raise SongMissing("Playlist not found")
        return self._playlist_item(detail, song_list(detail), await self._catalog(), True)

    def _playlist_item(
        self,
        row: Mapping[str, object],
        song_ids: list[str],
        snapshot: LibraryView,
        with_entry: bool,
    ) -> dict[str, object]:
        entry = [snapshot.by_song.get(text) or missing_track(text) for text in song_ids]
        duration = 0.0
        for track in entry:
            length = track.get("duration")
            if isinstance(length, (int, float)) and not isinstance(length, bool):
                duration += float(length)
        item: dict[str, object] = {
            "id": f"pl-{row['id']}",
            "name": str(row["name"]),
            "songCount": len(song_ids),
            "duration": duration,
            "public": bool(row["public"]),
            "owner": "",
            "changed": str(row["changed"]),
        }
        for track in entry:
            cover = track.get("coverArt")
            if isinstance(cover, str) and cover:
                item["coverArt"] = cover
                break
        if with_entry:
            item["entry"] = entry
        return item

    async def create_playlist(self, name: str, song_ids: list[str]) -> dict[str, object]:
        created = self.store.create_playlist(name, song_ids)
        return await self.playlist(f"pl-{created['id']}")

    async def update_playlist(self, playlist_id: str, name: str) -> dict[str, object]:
        number = playlist_number(playlist_id)
        if number is None or self.store.rename_playlist(number, name) is None:
            raise SongMissing("Playlist not found")
        return await self.playlist(playlist_id)

    async def add_playlist_song(self, playlist_id: str, song_id: str) -> dict[str, object]:
        number = playlist_number(playlist_id)
        if number is None or self.store.add_playlist_song(number, song_id) is None:
            raise SongMissing("Playlist not found")
        return await self.playlist(playlist_id)

    async def remove_playlist_song(self, playlist_id: str, song_index: int) -> dict[str, object]:
        number = playlist_number(playlist_id)
        if number is None or self.store.remove_playlist_song(number, song_index) is None:
            raise SongMissing("Playlist not found")
        return await self.playlist(playlist_id)

    async def delete_playlist(self, playlist_id: str) -> None:
        if playlist_id and playlist_id == self.liked_id():
            raise PlaylistProtected("The liked playlist cannot be deleted")
        number = playlist_number(playlist_id)
        if number is None or not self.store.delete_playlist(number):
            raise SongMissing("Playlist not found")

    async def album(self, album_id: str) -> dict[str, object]:
        snapshot = await self._catalog()
        songs = snapshot.album_songs.get(album_id)
        if songs is None:
            raise SongMissing("Album not found")
        for row in snapshot.albums:
            if row.get("id") == album_id:
                detail = dict(row)
                detail["song"] = [
                    snapshot.by_song[song.song_id]
                    for song in songs
                    if song.song_id in snapshot.by_song
                ]
                return detail
        raise SongMissing("Album not found")

    async def artist(self, artist_id: str) -> dict[str, object]:
        snapshot = await self._catalog()
        for row in snapshot.artists:
            if row.get("id") == artist_id:
                detail = dict(row)
                detail["album"] = list(snapshot.artist_albums.get(artist_id, []))
                return detail
        raise SongMissing("Artist not found")

    async def artist_tracks(self, artist_id: str) -> list[dict[str, object]]:
        snapshot = await self._catalog()
        if not any(row.get("id") == artist_id for row in snapshot.artists):
            raise SongMissing("Artist not found")
        tracks: list[dict[str, object]] = []
        seen: set[str] = set()
        for album in snapshot.artist_albums.get(artist_id, []):
            album_id = album.get("id")
            if not isinstance(album_id, str):
                continue
            for song in snapshot.album_songs.get(album_id, []):
                item = snapshot.by_song.get(song.song_id)
                if item is not None and song.song_id not in seen:
                    seen.add(song.song_id)
                    tracks.append(item)
        return tracks

    async def song(self, song_id: str) -> dict[str, object]:
        snapshot = await self._catalog()
        stored = snapshot.stored.get(song_id)
        if stored is None:
            raise SongMissing("Track not found")
        item: dict[str, object] = {"id": song_id, "path": relative_path(stored)}
        item["codec"] = stored.codec
        item["playbackWarning"] = stored.playback_warning
        if stored.suffix:
            item["suffix"] = stored.suffix
        if stored.content_type:
            item["contentType"] = stored.content_type
        if stored.bitrate:
            item["bitRate"] = stored.bitrate
        if stored.sample_rate:
            item["samplingRate"] = stored.sample_rate
        if stored.bit_depth:
            item["bitDepth"] = stored.bit_depth
        if stored.channels:
            item["channelCount"] = stored.channels
        if stored.size:
            item["size"] = stored.size
        if stored.track:
            item["track"] = stored.track
        if stored.disc:
            item["discNumber"] = stored.disc
        if stored.year:
            item["year"] = stored.year
        if stored.genre:
            item["genre"] = stored.genre
        if stored.genres:
            item["genres"] = [{"name": name} for name in stored.genres]
        item["playCount"] = stored.play_count
        if stored.last_played:
            item["played"] = stored.last_played
        return item

    def media_type(self, song_id: str) -> str:
        """The row's content type. Streaming must not build the catalog to learn it."""
        with self.store.lock:
            row = self.store.db.execute(
                """
                SELECT f.content_type, f.suffix FROM library_files f
                JOIN library_roots r ON r.path = f.root AND r.enabled = 1
                WHERE f.song_id = ?
                """,
                (song_id,),
            ).fetchone()
        if row is None:
            return "application/octet-stream"
        content = str(row["content_type"] or "")
        if content:
            return content
        return CONTENT_TYPES.get(f".{row['suffix']}", "application/octet-stream")

    async def play_queue(self) -> dict[str, object]:
        saved = self.store.read_play_queue()
        snapshot = await self._catalog()
        raw_ids = saved.get("song_ids")
        ids = [str(item) for item in raw_ids] if isinstance(raw_ids, list) else []
        position = saved.get("position")
        return {
            "current": str(saved.get("current") or ""),
            "position": position
            if isinstance(position, int) and not isinstance(position, bool)
            else 0,
            "entry": [snapshot.by_song[text] for text in ids if text in snapshot.by_song],
        }

    async def save_play_queue(
        self,
        ids: list[str],
        current: str,
        position: int,
        epoch: int | None = None,
        sequence: int | None = None,
    ) -> bool:
        return self.store.write_play_queue(ids, current, position, epoch, sequence)

    async def scrobble(self, song_id: str, submission: bool) -> None:
        if not submission:
            return
        if not self.store.record_play(song_id):
            raise SongMissing("Track not found")
        with self.store.lock:
            row = self.store.db.execute(
                "SELECT play_count, last_played FROM library_files WHERE song_id=?",
                (song_id,),
            ).fetchone()
        if row is None:
            return
        played = row["last_played"]
        count, when = int(row["play_count"]), str(played) if played else None
        with self._lock:
            self._plays[song_id] = (count, when)
            self._write_play(self._cached, song_id, count, when)

    async def lyrics(self, song_id: str) -> list[dict[str, object]]:
        snapshot = await self._catalog()
        stored = snapshot.stored.get(song_id)
        if stored is None:
            raise SongMissing("Track not found")
        artist = stored.artist.strip() or "Unknown artist"
        title = stored.title.strip() or "Unknown track"
        # The store lock is not held while the lyric file is read.
        own = await asyncio.to_thread(self._own_lyrics, song_id, artist, title)
        if own is not None:
            return [own]
        remote = await self._lrclib(stored, artist, title)
        return [remote] if remote is not None else []

    def _own_lyrics(self, song_id: str, artist: str, title: str) -> dict[str, object] | None:
        path = self.local_file(song_id)
        if path is None:
            raise SongMissing("Track not found")
        return self._file_lyrics(path, artist, title)

    def _file_lyrics(self, path: Path, artist: str, title: str) -> dict[str, object] | None:
        sidecar = self._safe_file(path.with_suffix(".lrc"))
        if sidecar is not None:
            try:
                text = sidecar.read_text(encoding="utf-8-sig", errors="replace")
            except OSError:
                text = ""
            lines, synced = lyric_lines(text, text)
            if lines:
                return lyric_payload(artist, title, lines, synced)
        try:
            audio = mutagen.File(path)
        except (OSError, mutagen.MutagenError):
            audio = None
        if audio is None:
            return None
        synced_lines = synced_lyrics(audio)
        if synced_lines:
            return lyric_payload(artist, title, synced_lines, True)
        plain = plain_lyrics(audio)
        if not plain:
            return None
        lines, synced = lyric_lines(plain, plain)
        if not lines:
            return None
        return lyric_payload(artist, title, lines, synced)

    async def _lrclib(self, song: StoredSong, artist: str, title: str) -> dict[str, object] | None:
        if self.client is None:
            return None
        try:
            response = await self.client.get(
                "https://lrclib.net/api/get",
                params={
                    "track_name": title,
                    "artist_name": artist,
                    "album_name": song.album,
                    "duration": round(song.duration),
                },
                timeout=4,
            )
            if response.status_code == 404:
                return None
            response.raise_for_status()
            raw: object = response.json()
        except (httpx.HTTPError, ValueError, TypeError):
            return None
        if not isinstance(raw, dict):
            return None
        lines, synced = lyric_lines(
            str(raw.get("syncedLyrics") or ""), str(raw.get("plainLyrics") or "")
        )
        if not lines:
            return None
        return lyric_payload(artist, title, lines, synced)

    async def cover(self, cover_id: str) -> CoverBytes | None:
        # Parsing a picture stays off the event loop, and off the store lock.
        return await asyncio.to_thread(self._cover, cover_id)

    def _cover(self, cover_id: str) -> CoverBytes | None:
        owner = owner_of(cover_id)
        if owner.startswith("tr-"):
            return self._cover_song(owner)
        if owner.startswith("al-"):
            return self._cover_album(owner)
        if owner.startswith("ar-"):
            return self._cover_artist(owner)
        return None

    def _cover_song(self, song_id: str) -> CoverBytes | None:
        snapshot = self.view()
        song = snapshot.stored.get(song_id)
        if song is None:
            return None
        return self._read_art(self._song_art(song, snapshot.covers))

    def _cover_album(self, album_id: str) -> CoverBytes | None:
        snapshot = self.view()
        songs = snapshot.album_songs.get(album_id)
        if not songs:
            return None
        return self._read_art(self._album_art(songs, snapshot.covers))

    def _cover_artist(self, artist_id: str) -> CoverBytes | None:
        snapshot = self.view()
        for album in snapshot.artist_albums.get(artist_id, []):
            if not album.get("coverArt"):
                continue
            album_id = album.get("id")
            if isinstance(album_id, str):
                found = self._cover_album(album_id)
                if found is not None:
                    return found
        return None

    def _read_art(self, source: ArtSource | None) -> CoverBytes | None:
        if source is None:
            return None
        safe = self._safe_file(source.path)
        if safe is None:
            return None
        try:
            stat = safe.stat()
        except OSError:
            return None
        if source.embedded:
            picture = pick_picture(pictures_in(safe))
            if picture is None:
                return None
            mime, body = picture
            return CoverBytes(body, mime, cover_etag(stat.st_size, stat.st_mtime_ns))
        try:
            body = safe.read_bytes()
        except OSError:
            return None
        mime = IMAGE_TYPES.get(safe.suffix.casefold(), "application/octet-stream")
        return CoverBytes(body, mime, cover_etag(stat.st_size, stat.st_mtime_ns))


def row_number(row: Mapping[str, object]) -> int | None:
    value = row.get("id")
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    return None


def song_list(detail: Mapping[str, object] | None) -> list[str]:
    if detail is None:
        return []
    raw = detail.get("song_ids")
    if not isinstance(raw, list):
        return []
    return [str(item) for item in raw]


def album_recency(row: dict[str, object]) -> tuple[int, str]:
    year = row.get("year")
    created = row.get("created")
    return (
        year if isinstance(year, int) and not isinstance(year, bool) else 0,
        created if isinstance(created, str) else "",
    )


def missing_track(song_id: str) -> dict[str, object]:
    """Keeps a playlist index stable when a saved id is not in the library."""
    return {
        "id": song_id,
        "title": "Unknown track",
        "artist": "Unknown artist",
        "album": "",
        "duration": 0,
        "playCount": 0,
    }


def relative_path(song: StoredSong) -> str:
    path = Path(song.path)
    root = Path(song.root)
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return path.name
