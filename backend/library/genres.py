"""Broad genres over the library's raw genre tags.

Raw tags stay exactly as written. Each known tag word also belongs to zero, one or two broad
genres, so asking for "hip hop" finds both Rap/Hip Hop and Hip-Hop. The table and its reasons
are in docs/genre-mapping.md; keep the two in step.
"""

import re
from functools import lru_cache

TAG_GENRES: dict[str, tuple[str, ...]] = {
    "rock": ("rock-metal",),
    "electro": ("electronic",),
    "dance": ("electronic",),
    "electronic": ("electronic",),
    "rap/hip hop": ("hip-hop",),
    "trance": ("electronic",),
    "pop": ("pop",),
    "metal": ("rock-metal",),
    "hip-hop": ("hip-hop",),
    "r&b": ("soul-rnb",),
    "reggae": ("reggae",),
    "dubstep": ("electronic",),
    "techno/house": ("electronic",),
    "indie rock": ("rock-metal",),
    "jazz": ("jazz",),
    "indie pop": ("pop",),
    "films/games": ("soundtrack",),
    "house": ("electronic",),
    "hard rock": ("rock-metal",),
    "dub": ("reggae",),
    "film scores": ("soundtrack",),
    "podcast": ("spoken",),
    "country": ("folk-country",),
    "indie rock/rock pop": ("rock-metal", "pop"),
    "folk": ("folk-country",),
    "rock & roll/rockabilly": ("rock-metal",),
    "soundtrack": ("soundtrack",),
    "international pop": ("pop",),
    "chill": ("electronic",),
    "latin music": ("latin",),
    "comedy": ("spoken",),
    "dancehall/ragga": ("reggae",),
    "latin": ("latin",),
    "african music": ("world",),
    "soul & funk": ("soul-rnb",),
    "blues": ("blues",),
    "disco": ("electronic",),
    "classical": ("classical",),
    "grime": ("hip-hop",),
    "gospel": ("soul-rnb",),
    "ska": ("reggae",),
    "asian music": ("world",),
    "chill out/trip-hop/lounge": ("electronic",),
    "east coast": ("hip-hop",),
    "bluegrass": ("folk-country",),
    "contemporary r&b": ("soul-rnb",),
    "asian": ("world",),
    "tv soundtracks": ("soundtrack",),
    # Drum and bass stays electronic, and it is also its own group, so "dnb" finds the
    # subgenre tags below. Liquid on its own stays the liquid tag, not the whole group.
    "drum and bass": ("electronic", "drum-and-bass"),
    "liquid drum and bass": ("electronic", "drum-and-bass"),
    "neurofunk": ("electronic", "drum-and-bass"),
    "jungle": ("electronic", "drum-and-bass"),
    "dancehall": ("reggae",),
    "brazilian music": ("latin",),
    "opera": ("classical",),
    "indie pop/folk": ("pop", "folk-country"),
    "contemporary soul": ("soul-rnb",),
    "traditional mexicano": ("latin",),
    "reggaeton": ("latin",),
    "non-music - radioplay": ("spoken",),
    "african": ("world",),
    "soul": ("soul-rnb",),
    # Deliberately without a broad genre: alternative, singer & songwriter, kids, christian.
}

# Words a listener uses for a whole broad genre. Any other word searches tags as written.
GENRE_WORDS: dict[str, str] = {
    "electronic": "electronic",
    "electronica": "electronic",
    "edm": "electronic",
    "electronic dance": "electronic",
    "rock": "rock-metal",
    "rock/metal": "rock-metal",
    "rock and metal": "rock-metal",
    "hip hop": "hip-hop",
    "hip-hop": "hip-hop",
    "hiphop": "hip-hop",
    "rap": "hip-hop",
    "pop": "pop",
    "soul": "soul-rnb",
    "r&b": "soul-rnb",
    "rnb": "soul-rnb",
    "r and b": "soul-rnb",
    "rhythm and blues": "soul-rnb",
    "soul/r&b": "soul-rnb",
    "soul & funk": "soul-rnb",
    "soul and funk": "soul-rnb",
    "funk": "soul-rnb",
    "reggae": "reggae",
    "jazz": "jazz",
    "folk/country": "folk-country",
    "folk and country": "folk-country",
    "country and folk": "folk-country",
    "world": "world",
    "classical": "classical",
    "blues": "blues",
    "latin": "latin",
    "soundtrack": "soundtrack",
    "soundtracks": "soundtrack",
    "film score": "soundtrack",
    "film scores": "soundtrack",
    "film": "soundtrack",
    "movie": "soundtrack",
    "spoken": "spoken",
    "spoken word": "spoken",
    "drum and bass": "drum-and-bass",
    "dnb": "drum-and-bass",
    "drum n bass": "drum-and-bass",
}

# A shorter name for one tag. These are not the whole drum-and-bass group.
TAG_ALIASES: dict[str, tuple[str, ...]] = {
    "liquid": ("liquid drum and bass",),
    "liquid dnb": ("liquid drum and bass",),
    "liquid drum n bass": ("liquid drum and bass",),
}


def _fold(text: str) -> str:
    """Case, hyphens, spaces and & compare the same, so trip-hop and drum & bass fold."""
    return " ".join(text.casefold().replace("-", " ").replace("&", " and ").split())


def _index(table: dict[str, str]) -> dict[str, str]:
    folded: dict[str, str] = {}
    for key, value in table.items():
        name = _fold(key)
        previous = folded.get(name)
        if previous is not None and previous != value:
            raise RuntimeError(f"genre key {key!r} collapses onto a different value")
        folded[name] = value
    return folded


def _index_tags(table: dict[str, tuple[str, ...]]) -> dict[str, tuple[str, ...]]:
    folded: dict[str, tuple[str, ...]] = {}
    for key, value in table.items():
        name = _fold(key)
        previous = folded.get(name)
        if previous is not None and previous != value:
            raise RuntimeError(f"genre key {key!r} collapses onto a different value")
        folded[name] = value
    return folded


def _index_aliases(table: dict[str, tuple[str, ...]]) -> dict[str, tuple[str, ...]]:
    folded: dict[str, tuple[str, ...]] = {}
    for key, forms in table.items():
        name = _fold(key)
        value = tuple(_fold(item) for item in forms)
        previous = folded.get(name)
        if previous is not None and previous != value:
            raise RuntimeError(f"genre key {key!r} collapses onto a different value")
        folded[name] = value
    return folded


TAG_LOOKUP = _index_tags(TAG_GENRES)
WORD_LOOKUP = _index(GENRE_WORDS)
ALIAS_LOOKUP = _index_aliases(TAG_ALIASES)


@lru_cache(maxsize=4096)
def tag_profile(tags: tuple[str, ...]) -> tuple[frozenset[str], frozenset[str]]:
    """Searchable tag words and broad genres for one song's raw tags.

    A tag also answers to each part between slashes, so "house" finds Techno/House. Some files
    hold several genres in one value separated by semicolons; those are split first.
    """
    words: set[str] = set()
    groups: set[str] = set()
    for value in tags:
        for part in value.split(";"):
            tag = _fold(part)
            if not tag:
                continue
            words.add(tag)
            words.update(piece for piece in map(_fold, tag.split("/")) if piece)
            groups.update(TAG_LOOKUP.get(tag, ()))
    return frozenset(words), frozenset(groups)


@lru_cache(maxsize=256)
def genre_query(requested: tuple[str, ...]) -> tuple[tuple[frozenset[str], str | None], ...]:
    """Resolve requested words once: the tag words each may match, and its broad genre if any.

    A trailing "music" is optional, so "latin music" means latin and "dance music" means the
    Dance tag rather than every electronic song.
    """
    query = []
    for item in requested:
        key = _fold(item)
        bare = key.removesuffix(" music")
        forms = {form for form in (key, bare) if form}
        forms.update(ALIAS_LOOKUP.get(key, ()))
        forms.update(ALIAS_LOOKUP.get(bare, ()))
        group = WORD_LOOKUP.get(key)
        if group is None:
            group = WORD_LOOKUP.get(bare)
        query.append((frozenset(forms), group))
    return tuple(query)


# Genre words too common in ordinary sentences to pick out of a request on their own.
_AMBIGUOUS = {"world", "film", "movie", "films", "games", "music"}
# A request that negates anything is left to the model; "no hip hop" must not become hip hop.
_NEGATION = re.compile(r"\b(no|not|without|except|exclud\w*|other than|instead of|apart from)\b")


def _vocabulary() -> set[str]:
    words = set(WORD_LOOKUP) | set(TAG_LOOKUP) | set(ALIAS_LOOKUP)
    for tag in TAG_LOOKUP:
        words.update(piece for piece in map(_fold, tag.split("/")) if piece)
    return words - _AMBIGUOUS


VOCABULARY = frozenset(_vocabulary())
_LONGEST = max(len(word.split()) for word in VOCABULARY)


def genre_words_in(request: str) -> list[str]:
    """Known genre phrases in a request, longest first, for when the model left genres empty.

    "some drum and bass" gives ["drum and bass"], not also "bass". Punctuation other than the
    characters genre names use (&, /, -) separates words.
    """
    text = " ".join(request.casefold().split())
    if _NEGATION.search(text):
        return []
    words = re.sub(r"[^\w&/\-]+", " ", text).split()
    found: list[str] = []
    index = 0
    while index < len(words):
        for size in range(min(_LONGEST, len(words) - index), 0, -1):
            phrase = " ".join(words[index : index + size])
            if _fold(phrase) in VOCABULARY:
                found.append(phrase)
                index += size
                break
        else:
            index += 1
    return list(dict.fromkeys(found))


def is_genre_word(text: str) -> bool:
    """True for a broad-genre word or a known library tag word, with or without "music"."""
    key = _fold(text)
    bare = key.removesuffix(" music")
    return any(
        form in WORD_LOOKUP or form in TAG_LOOKUP or form in ALIAS_LOOKUP for form in (key, bare)
    )


def matches_genres(requested: tuple[str, ...], tags: tuple[str, ...]) -> bool:
    words, groups = tag_profile(tags)
    return any(
        (group is not None and group in groups) or not forms.isdisjoint(words)
        for forms, group in genre_query(requested)
    )
