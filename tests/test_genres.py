import unittest
from pathlib import Path

from backend.library.genres import (
    GENRE_WORDS,
    TAG_GENRES,
    genre_words_in,
    is_genre_word,
    matches_genres,
    tag_profile,
)


class GenreTests(unittest.TestCase):
    def test_everyday_words_find_every_tag_in_the_broad_genre(self) -> None:
        for word in ("hip hop", "Hip-Hop", "rap", "hip hop music"):
            self.assertTrue(matches_genres((word,), ("Rap/Hip Hop",)), word)
            self.assertTrue(matches_genres((word,), ("Hip-Hop",)), word)
            self.assertTrue(matches_genres((word,), ("Grime",)), word)
        self.assertTrue(matches_genres(("electronic",), ("Electro", "Dance")))
        self.assertTrue(matches_genres(("electronic",), ("Trance",)))
        self.assertTrue(matches_genres(("latin music",), ("Reggaeton",)))
        self.assertTrue(matches_genres(("soundtrack",), ("Films/Games", "Film Scores")))

    def test_other_words_search_the_tag_as_written(self) -> None:
        self.assertTrue(matches_genres(("trance",), ("Trance",)))
        self.assertFalse(matches_genres(("trance",), ("House",)))
        self.assertTrue(matches_genres(("dance music",), ("Dance",)))
        self.assertFalse(matches_genres(("dance music",), ("Trance",)))
        self.assertTrue(matches_genres(("house",), ("Techno/House",)))
        self.assertTrue(matches_genres(("ALTERNATIVE",), ("Alternative",)))
        self.assertTrue(matches_genres(("vaporwave",), ("Vaporwave",)))
        self.assertFalse(matches_genres(("rock",), ("Alternative",)))

    def test_two_genre_tags_and_semicolon_values(self) -> None:
        self.assertEqual(tag_profile(("Indie Rock/Rock Pop",))[1], {"rock-metal", "pop"})
        self.assertEqual(tag_profile(("Electro; Dance; Pop",))[1], {"electronic", "pop"})
        self.assertTrue(matches_genres(("pop",), ("Electro; Dance; Pop",)))
        self.assertEqual(tag_profile(("", "  ")), (frozenset(), frozenset()))

    def test_genre_words(self) -> None:
        for word in ("rap", "Rock", "latin music", "Trance", "drum and bass"):
            self.assertTrue(is_genre_word(word), word)
        for word in ("Radiohead", "music", "Fixture Harbor"):
            self.assertFalse(is_genre_word(word), word)

    def test_genre_words_in_a_request(self) -> None:
        self.assertEqual(genre_words_in("some trance please"), ["trance"])
        self.assertEqual(genre_words_in("Some drum and bass!"), ["drum and bass"])
        self.assertEqual(genre_words_in("r&b and soul from the 70s"), ["r&b", "soul"])
        self.assertEqual(genre_words_in("popular songs from around the world"), [])
        self.assertEqual(genre_words_in("anything except hip hop"), [])
        self.assertEqual(genre_words_in("no rock"), [])

    def test_table_matches_the_documented_mapping(self) -> None:
        groups = set(GENRE_WORDS.values())
        self.assertTrue({g for found in TAG_GENRES.values() for g in found} <= groups)
        doc = Path("docs/genre-mapping.md").read_text(encoding="utf-8")
        for tag in TAG_GENRES:
            self.assertIn(tag, doc.casefold(), tag)


if __name__ == "__main__":
    unittest.main()
