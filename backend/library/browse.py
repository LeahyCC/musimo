"""Filtering, sorting and filter choices for the library pages."""

import re
from collections.abc import Mapping
from dataclasses import dataclass

DIGITS = re.compile(r"(\d+)")


def song_id(row: Mapping[str, object]) -> str:
    value = row.get("id")
    return str(value) if value else ""


def track_text(row: dict[str, object], key: str) -> str:
    value = row.get(key)
    return value.casefold() if isinstance(value, str) else ""


def track_number(row: dict[str, object], key: str) -> float:
    # bool is an int in Python, and Subsonic sends booleans in neighbouring fields.
    value = row.get(key)
    return float(value) if isinstance(value, int | float) and not isinstance(value, bool) else 0.0


def filter_tracks(
    rows: list[dict[str, object]], genres: list[str], years: list[int]
) -> list[dict[str, object]]:
    wanted_genres = {genre.casefold() for genre in genres}
    wanted_years = set(years)
    return [
        row
        for row in rows
        if (not wanted_genres or track_text(row, "genre") in wanted_genres)
        and (not wanted_years or int(track_number(row, "year")) in wanted_years)
    ]


def sort_tracks(rows: list[dict[str, object]], sort: str) -> list[dict[str, object]]:
    if sort == "artist":
        return sorted(
            rows,
            key=lambda row: (
                track_text(row, "artist"),
                track_text(row, "album"),
                track_number(row, "track"),
            ),
        )
    if sort == "album":
        return sorted(
            rows,
            key=lambda row: (
                track_text(row, "album"),
                track_number(row, "discNumber"),
                track_number(row, "track"),
            ),
        )
    if sort == "year":
        # Negating the year sorts newest first and leaves a missing year (0) at the end.
        return sorted(rows, key=lambda row: (-track_number(row, "year"), track_text(row, "title")))
    if sort == "duration":
        return sorted(
            rows, key=lambda row: (-track_number(row, "duration"), track_text(row, "title"))
        )
    if sort == "newest":
        return sorted(rows, key=lambda row: track_text(row, "created"), reverse=True)
    return sorted(rows, key=lambda row: (track_text(row, "title"), track_text(row, "artist")))


@dataclass
class ArtistSummary:
    genres: set[str]
    years: set[int]
    added: str
    played: bool


@dataclass
class CatalogSnapshot:
    fetched: float
    artists: list[dict[str, object]]
    albums: list[dict[str, object]]
    summaries: dict[str, ArtistSummary]
    facets: dict[str, object]


def album_genres(album: dict[str, object]) -> list[str]:
    genres = album.get("genres")
    names = (
        [genre.get("name") for genre in genres if isinstance(genre, dict)]
        if isinstance(genres, list)
        else []
    )
    if not names:
        names = [album.get("genre")]
    return [name for name in names if isinstance(name, str) and name]


def album_artist_ids(album: dict[str, object]) -> set[str]:
    artists = album.get("artists")
    ids = {
        artist["id"]
        for artist in (artists if isinstance(artists, list) else [])
        if isinstance(artist, dict) and isinstance(artist.get("id"), str)
    }
    artist_id = album.get("artistId")
    if isinstance(artist_id, str):
        ids.add(artist_id)
    return ids


def artist_summaries(albums: list[dict[str, object]]) -> dict[str, ArtistSummary]:
    """What each artist's albums say about them: genres, years, newest addition, any plays."""
    summaries: dict[str, ArtistSummary] = {}
    for album in albums:
        genres = {genre.casefold() for genre in album_genres(album)}
        year = album.get("year")
        created = album.get("created")
        play_count = album.get("playCount")
        for artist_id in album_artist_ids(album):
            summary = summaries.setdefault(artist_id, ArtistSummary(set(), set(), "", False))
            summary.genres |= genres
            if isinstance(year, int) and not isinstance(year, bool) and year:
                summary.years.add(year)
            if isinstance(created, str) and created > summary.added:
                summary.added = created
            if isinstance(play_count, int) and play_count > 0:
                summary.played = True
    return summaries


def artist_facets(albums: list[dict[str, object]]) -> dict[str, object]:
    """Filter choices for the whole library, so picking one does not hide the others."""
    genres: dict[str, str] = {}
    years: set[int] = set()
    for album in albums:
        for genre in album_genres(album):
            genres.setdefault(genre.casefold(), genre)
        year = album.get("year")
        if isinstance(year, int) and not isinstance(year, bool) and year:
            years.add(year)
    return {
        "genres": sorted(genres.values(), key=str.casefold),
        "years": sorted(years, reverse=True),
    }


def filter_artists(
    snapshot: CatalogSnapshot, query: str, genres: list[str], years: list[int], show: str
) -> list[dict[str, object]]:
    needle = query.casefold()
    wanted_genres = {genre.casefold() for genre in genres}
    wanted_years = set(years)
    empty = ArtistSummary(set(), set(), "", False)

    def keep(row: dict[str, object]) -> bool:
        summary = snapshot.summaries.get(str(row.get("id", "")), empty)
        return (
            needle in track_text(row, "name")
            and (not wanted_genres or bool(summary.genres & wanted_genres))
            and (not wanted_years or bool(summary.years & wanted_years))
            and (show != "favourites" or bool(row.get("starred")))
            and (show != "played" or summary.played)
            and (show != "unplayed" or not summary.played)
        )

    return [row for row in snapshot.artists if keep(row)]


def natural(text: str) -> list[str | int]:
    """Sort key that compares runs of digits as numbers, so 9 comes before 100."""
    return [int(part) if index % 2 else part for index, part in enumerate(DIGITS.split(text))]


def filter_albums(
    rows: list[dict[str, object]], query: str, genres: list[str], years: list[int]
) -> list[dict[str, object]]:
    needle = query.casefold()
    wanted_genres = {genre.casefold() for genre in genres}
    wanted_years = set(years)
    return [
        row
        for row in rows
        if (needle in track_text(row, "name") or needle in track_text(row, "artist"))
        and (
            not wanted_genres
            or bool({genre.casefold() for genre in album_genres(row)} & wanted_genres)
        )
        and (not wanted_years or int(track_number(row, "year")) in wanted_years)
    ]


def sort_albums(rows: list[dict[str, object]], sort: str) -> list[dict[str, object]]:
    by_name = sorted(rows, key=lambda row: natural(track_text(row, "name")))
    if sort == "newest":
        return sorted(by_name, key=lambda row: track_text(row, "created"), reverse=True)
    if sort == "artist":
        return sorted(by_name, key=lambda row: natural(track_text(row, "artist")))
    if sort == "year":
        return sorted(by_name, key=lambda row: track_number(row, "year"), reverse=True)
    return by_name


def sort_artists(
    rows: list[dict[str, object]], summaries: dict[str, ArtistSummary], sort: str
) -> list[dict[str, object]]:
    def name(row: dict[str, object]) -> list[str | int]:
        return natural(track_text(row, "sortName") or track_text(row, "name"))

    by_name = sorted(rows, key=name)
    if sort == "albums":
        return sorted(by_name, key=lambda row: track_number(row, "albumCount"), reverse=True)
    if sort == "recent":
        empty = ArtistSummary(set(), set(), "", False)
        return sorted(
            by_name,
            key=lambda row: summaries.get(str(row.get("id", "")), empty).added,
            reverse=True,
        )
    return by_name


def artist_letters(rows: list[dict[str, object]]) -> list[dict[str, object]]:
    """First offset of each initial in a name-sorted artist list, for an A-Z jump rail.

    The letter is where the list itself files the name: the first character of the
    text it is sorted by. A name that starts with a digit or punctuation is sorted
    ahead of the As, so it is grouped under '#' with them — taking its first letter
    character instead would file "&ME" under M, far from where it actually sits.
    """
    letters: list[dict[str, object]] = []
    seen: set[str] = set()
    for offset, row in enumerate(rows):
        text = track_text(row, "sortName") or track_text(row, "name")
        initial = text[:1]
        letter = initial.upper() if initial.isalpha() else "#"
        if letter not in seen:
            seen.add(letter)
            letters.append({"letter": letter, "offset": offset})
    return letters


def track_facets(rows: list[dict[str, object]]) -> dict[str, object]:
    """Filter choices for the whole library, so picking one does not hide the others."""
    genres: dict[str, str] = {}
    years: set[int] = set()
    for row in rows:
        genre = row.get("genre")
        # Filtering casefolds, so fold here too or a library holding both Jazz and jazz
        # would offer two choices that select the same rows.
        if isinstance(genre, str) and genre:
            genres.setdefault(genre.casefold(), genre)
        year = row.get("year")
        if isinstance(year, int) and not isinstance(year, bool):
            years.add(year)
    return {
        "genres": sorted(genres.values(), key=str.casefold),
        "years": sorted(years, reverse=True),
    }
