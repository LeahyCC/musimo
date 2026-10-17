"""The overview and sample of a proposal revision, from its actual songs: totals that match
the songs, coverage that counts what is unmeasured, and a sample drawn only from the proposal."""

import dataclasses
import math
import unittest

from backend.core.audio_recipes import RECIPES, SCALAR_RECIPE
from backend.library.audio_profile import Profile, ProfileSet
from backend.library.engine_contract import Intent
from backend.library.player import StoredSong
from backend.library.proposal_summary import FULL_LIST_LIMIT, SAMPLE_SIZE, pick_sample, summarize

BLANK = StoredSong(
    song_id="",
    path="",
    root="",
    size=10,
    mtime_ns=20,
    title="",
    artist="",
    album="",
    duration=200.0,
    track=0,
    disc=0,
    year=0,
    genre="",
    genres=(),
    album_artist="",
    compilation=False,
    track_gain=None,
    album_gain=None,
    track_peak=None,
    album_peak=None,
    suffix="mp3",
    content_type="audio/mpeg",
    bitrate=0,
    sample_rate=0,
    bit_depth=None,
    channels=2,
    has_art=False,
    labels=(),
    play_count=0,
    last_played=None,
    added_at="",
    codec="mp3",
    flac_id3=False,
)
INTENT = Intent.model_validate(
    {"contract_version": 2, "action": "search", "filters": {"genres": ["Rock"], "limit": 40}}
)
Songs = dict[str, StoredSong]


def song(number: int, artist: str, genres: tuple[str, ...], **fields: float) -> StoredSong:
    return dataclasses.replace(
        BLANK,
        song_id=f"tr-{number:04d}",
        title=f"Song {number}",
        artist=artist,
        genre=genres[0] if genres else "",
        genres=genres,
        **fields,  # type: ignore[arg-type]
    )


def library(count: int = 40) -> Songs:
    """Ten artists in blocks of four, three genres, lengths from 100 s up in 10 s steps."""
    made = [
        song(
            n,
            f"Artist {n // 4}",
            (("Rock", "Jazz", "Folk")[n % 3],),
            duration=100.0 + 10 * n,
            year=1980 + n,
        )
        for n in range(count)
    ]
    return {s.song_id: s for s in made}


def scalar_rows(songs: Songs, measured: dict[str, tuple[float, float]]) -> ProfileSet:
    rows = {
        sid: Profile(sid, "done", songs[sid].size, songs[sid].mtime_ns, bpm, energy, 0, 0, "")
        for sid, (bpm, energy) in measured.items()
    }
    return ProfileSet(RECIPES[SCALAR_RECIPE], rows, [], {}, None)


def section(found: dict[str, object], key: str) -> dict[str, object]:
    inner = found[key]
    assert isinstance(inner, dict)
    return inner


class SampleTests(unittest.TestCase):
    def test_a_short_proposal_is_its_own_sample_in_order(self) -> None:
        songs = library(FULL_LIST_LIMIT)
        ids = list(reversed(list(songs)))
        found = pick_sample(ids, songs)
        self.assertEqual(found.ids, ids)
        self.assertTrue(found.complete)

    def test_a_large_proposal_gets_about_six_of_its_own_songs_in_its_order(self) -> None:
        songs = library()
        ids = list(songs)[::-1]
        found = pick_sample(ids, songs, "pr-a")
        self.assertFalse(found.complete)
        self.assertEqual(len(found.ids), SAMPLE_SIZE)
        self.assertTrue(set(found.ids) <= set(ids))
        self.assertEqual(found.ids, [sid for sid in ids if sid in found.ids])

    def test_the_sample_is_stable_for_a_revision(self) -> None:
        songs = library()
        ids = list(songs)
        self.assertEqual(pick_sample(ids, songs, "pr-a"), pick_sample(ids, dict(songs), "pr-a"))

    def test_the_sample_spreads_over_artists_genres_and_lengths(self) -> None:
        songs = library()
        found = pick_sample(list(songs), songs, "pr-a").ids
        self.assertEqual(len({songs[sid].artist for sid in found}), SAMPLE_SIZE)
        self.assertEqual({songs[sid].genre for sid in found}, {"Rock", "Jazz", "Folk"})
        lengths = sorted(songs[sid].duration for sid in found)
        # Not the first six, and not one end of the range.
        self.assertGreater(lengths[-1] - lengths[0], 200)
        self.assertNotEqual(found, list(songs)[:SAMPLE_SIZE])

    def test_every_artist_of_a_large_proposal_with_two_reaches_the_sample(self) -> None:
        made = (song(n, "Solo" if n < 20 else "Duo", ("Rock",)) for n in range(30))
        songs = {s.song_id: s for s in made}
        found = pick_sample(list(songs), songs, "pr-a").ids
        self.assertEqual({songs[sid].artist for sid in found}, {"Solo", "Duo"})

    def test_songs_missing_from_the_library_are_not_sampled(self) -> None:
        songs = library()
        ids = list(songs)
        for gone in ids[:30]:
            del songs[gone]
        found = pick_sample(ids, songs, "pr-a").ids
        self.assertTrue(found)
        self.assertTrue(set(found) <= set(songs))

    def test_unknown_lengths_do_not_break_the_sample(self) -> None:
        songs = library()
        for sid in list(songs)[:20]:
            songs[sid] = dataclasses.replace(songs[sid], duration=0.0)
        self.assertEqual(len(pick_sample(list(songs), songs, "pr-a").ids), SAMPLE_SIZE)


class OverviewTests(unittest.TestCase):
    def test_the_measured_facts_match_the_songs(self) -> None:
        songs = library(10)
        measured = section(summarize(INTENT, list(songs), songs, None), "measured")
        self.assertEqual(measured["track_count"], 10)
        self.assertEqual(measured["total_seconds"], sum(s.duration for s in songs.values()))
        self.assertEqual(measured["artist_count"], 3)
        self.assertEqual(measured["year_range"], {"min": 1980, "max": 1989})
        genres = measured["genres"]
        assert isinstance(genres, list)
        # Most songs first.
        self.assertEqual(
            genres,
            [
                {"name": "Rock", "count": 4},
                {"name": "Folk", "count": 3},
                {"name": "Jazz", "count": 3},
            ],
        )

    def test_requested_is_what_the_intent_set_and_unknown_counts_what_is_unreadable(self) -> None:
        songs = library(10)
        ids = list(songs)
        songs[ids[0]] = dataclasses.replace(
            songs[ids[0]], duration=0.0, year=0, genres=(), genre=""
        )
        songs[ids[1]] = dataclasses.replace(songs[ids[1]], duration=math.nan)
        del songs[ids[2]]
        found = summarize(INTENT, ids, songs, None)
        self.assertEqual(
            found["requested"], {"scope": "library", "filters": {"genres": ["Rock"], "limit": 40}}
        )
        unknown = section(found, "unknown")
        self.assertEqual(unknown["duration_tracks"], 3)
        self.assertEqual(unknown["year_tracks"], 1)
        self.assertEqual(unknown["genre_tracks"], 1)
        self.assertEqual(unknown["missing_tracks"], 1)
        measured = section(found, "measured")
        self.assertEqual(measured["track_count"], 10)
        self.assertEqual(measured["total_seconds"], sum(songs[sid].duration for sid in ids[3:]))

    def test_no_tempo_or_energy_without_a_scalar_recipe(self) -> None:
        songs = library(10)
        found = summarize(INTENT, list(songs), songs, None)
        self.assertIsNone(section(found, "measured")["audio"])
        self.assertNotIn("tempo_tracks", section(found, "unknown"))

    def test_coverage_counts_only_fresh_measured_rows(self) -> None:
        songs = library(10)
        ids = list(songs)
        rows = scalar_rows(songs, {ids[0]: (120.0, 0.4), ids[1]: (140.0, 0.8), ids[2]: (90.0, 0.2)})
        # The third song's file changed after it was measured, so its row no longer counts.
        songs[ids[2]] = dataclasses.replace(songs[ids[2]], mtime_ns=999)
        found = summarize(INTENT, ids, songs, rows)
        audio = section(section(found, "measured"), "audio")
        self.assertEqual(audio["tempo"], {"min": 120.0, "max": 140.0})
        self.assertEqual(audio["energy"], {"min": 0.4, "max": 0.8})
        self.assertEqual(audio["tempo_coverage"], {"measured": 2, "total": 10})
        self.assertEqual(section(found, "unknown")["tempo_tracks"], 8)

    def test_a_recipe_with_no_fresh_rows_reports_no_range_and_zero_coverage(self) -> None:
        songs = library(10)
        found = summarize(INTENT, list(songs), songs, scalar_rows(songs, {}))
        audio = section(section(found, "measured"), "audio")
        self.assertIsNone(audio["tempo"])
        self.assertEqual(audio["tempo_coverage"], {"measured": 0, "total": 10})


if __name__ == "__main__":
    unittest.main()
