import re
from dataclasses import dataclass
from difflib import SequenceMatcher

from backend.job_models import Candidate, Metadata
from backend.library import normalize

# Version words are musical differences, not harmless upload decoration.
VERSION_WORDS = ("live", "cover", "karaoke", "remix", "slowed", "sped", "instrumental")

# The score a match must reach to be accepted, and the score below which the job says
# "check match", per source. SoundCloud is full of remixes, reuploads and sped-up edits, and has
# no equivalent of YouTube's Topic channels to trust, so it needs a higher bar. Both SoundCloud
# numbers are provisional until `scripts/match_benchmark.py` measures them against the corpus.
YOUTUBE_MIN_SCORE = 0.55
YOUTUBE_CHECK_BELOW = 0.86
SOUNDCLOUD_MIN_SCORE = 0.70
SOUNDCLOUD_CHECK_BELOW = 0.90
MIN_SCORE = {"youtube": YOUTUBE_MIN_SCORE, "soundcloud": SOUNDCLOUD_MIN_SCORE}
CHECK_BELOW = {"youtube": YOUTUBE_CHECK_BELOW, "soundcloud": SOUNDCLOUD_CHECK_BELOW}


@dataclass(frozen=True)
class Score:
    total: float
    title: float
    # Includes the lift for an artist named inside the title, which suits YouTube upload titles.
    artist: float
    # The plain similarity, without that lift.
    artist_ratio: float
    delta: float
    # The other side has a version word that the wanted title lacks (a remix of what was asked for).
    version_mismatch: bool
    # The wanted title has a version word that the other side lacks (the original of a remix).
    version_missing: bool
    reason: str


class Matcher:
    def score(
        self, meta: Metadata, title: str, artist: str, duration: float, topic: bool = False
    ) -> Score | None:
        """How well one result fits the wanted recording, or None when its length is too far off."""
        wanted_title, wanted_artist = normalize(meta.title), normalize(meta.artist)
        result_title = normalize(title)
        result_artist = normalize(artist.removesuffix(" - Topic"))
        cleaned = result_title.removeprefix(wanted_artist + " ")
        cleaned = re.sub(r"\b(official|audio|video|lyrics|visualizer|hd|hq)\b", "", cleaned)
        cleaned = " ".join(cleaned.split())
        title_score = SequenceMatcher(None, wanted_title, cleaned).ratio()
        artist_ratio = SequenceMatcher(None, wanted_artist, result_artist).ratio()
        artist_score = artist_ratio
        if wanted_artist and wanted_artist in result_title:
            artist_score = max(artist_score, 0.9)
        delta = abs(meta.duration - duration)
        if meta.duration > 0 and (duration <= 0 or delta > max(15, meta.duration * 0.12)):
            return None
        duration_score = max(0, 1 - delta / max(8, meta.duration * 0.08)) if meta.duration else 0.5
        wanted_words, result_words = wanted_title.split(), cleaned.split()
        version_mismatch = any(
            token in result_words and token not in wanted_words for token in VERSION_WORDS
        )
        version_missing = any(
            token in wanted_words and token not in result_words for token in VERSION_WORDS
        )
        total = (
            0.5 * title_score + 0.3 * artist_score + 0.17 * duration_score + (0.03 if topic else 0)
        )
        if version_mismatch:
            total -= 0.3
        return Score(
            total=round(max(0, total), 3),
            title=title_score,
            artist=artist_score,
            artist_ratio=artist_ratio,
            delta=delta,
            version_mismatch=version_mismatch,
            version_missing=version_missing,
            reason=(
                f"Title {title_score:.0%}, artist {artist_score:.0%}, "
                f"duration difference {delta:.0f}s"
                + ("; version differs" if version_mismatch else "")
            ),
        )

    def rank(
        self,
        meta: Metadata,
        candidates: list[Candidate],
        *,
        min_score: float = YOUTUBE_MIN_SCORE,
        min_title: float = 0.5,
    ) -> list[Candidate]:
        ranked: list[Candidate] = []
        for candidate in candidates:
            score = self.score(
                meta, candidate.title, candidate.artist, candidate.duration, candidate.topic
            )
            if score is None:
                continue
            candidate.score, candidate.reason = score.total, score.reason
            if candidate.score >= min_score and score.title >= min_title:
                ranked.append(candidate)
        return sorted(ranked, key=lambda row: row.score, reverse=True)[:3]
