"""Mixes and radio shows: how a pasted recording of kind `mix` or `radio` is tagged and filed.

A mix or a show is one long recording, not a song. It skips the catalog tidy-up, lyrics and
MusicBrainz, and lands under `Mixes/<uploader>/` in the chosen music root whatever the naming
template says, the way an episode lands under `Podcasts/`. Its album is its show, or its uploader,
so a music server lists each DJ or show as one album.
"""

import re
from datetime import date
from urllib.parse import urlsplit

from backend.job_models import Metadata
from backend.naming import clean_component
from backend.sources import Kind, Site

FOLDER = "Mixes"
GENRES = {"mix": "DJ Mix", "radio": "Radio"}
DAY = re.compile(r"\d{4}-\d{2}-\d{2}")


def long_form(kind: Kind) -> bool:
    return kind in GENRES


def kind_of(site: Site, seconds: float) -> Kind:
    """The kind of one recording. A long track on a music site is a set, not a song."""
    if site.mix_after and site.kind == "music" and seconds > site.mix_after:
        return "mix"
    return site.kind


def unslug(text: str) -> str:
    return " ".join(word.capitalize() for word in text.replace("_", "-").split("-") if word)


def named(site: Site, url: str, title: str) -> tuple[str, str]:
    """The uploader and show name the site's row can read from an address and a title."""
    uploader = show = ""
    if site.url_names and (found := re.match(site.url_names, urlsplit(url).path)):
        names = found.groupdict()
        uploader = names.get("uploader") or ""
        show = unslug(names.get("show") or "")
    if not show and site.title_show and (found := re.fullmatch(site.title_show, title)):
        show = found["show"].strip()
    return uploader, show


def retag(meta: Metadata, site: Site, kind: Kind, url: str, album_list: bool) -> Metadata:
    """The tags of a mix or radio show. Applying it twice gives the same tags."""
    uploader, show = named(site, url, meta.title)
    artist = meta.artist or uploader or site.label
    # A set that is an album on its site keeps that album. Otherwise the show, else the uploader.
    album = show or (meta.album if album_list else "") or artist
    return meta.model_copy(
        update={
            "artist": artist,
            "album_artist": artist,
            "album": album,
            "genre": GENRES[kind],
            "track": 1,
            "tracks": 1,
        }
    )


def landing(meta: Metadata, today: date, extension: str = "") -> str:
    """Where a file lands, relative to the music root. `today` stands in for an unknown date.

    The site's day is used only when it is a whole one: a year alone would sort wrongly among
    dated files.
    """
    day = meta.date if DAY.fullmatch(meta.date) else today.isoformat()
    name = clean_component(f"{day} - {meta.title}")
    suffix = f".{extension}" if extension else ""
    return f"{FOLDER}/{clean_component(meta.artist)}/{name}{suffix}"
