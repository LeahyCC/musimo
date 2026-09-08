import re
from difflib import SequenceMatcher

from backend.job_models import Candidate, Metadata
from backend.library import normalize


class Matcher:
    def rank(
        self,
        meta: Metadata,
        candidates: list[Candidate],
        *,
        min_score: float = 0.55,
        min_title: float = 0.5,
    ) -> list[Candidate]:
        ranked: list[Candidate] = []
        wanted_title, wanted_artist = normalize(meta.title), normalize(meta.artist)
        for candidate in candidates:
            title = normalize(candidate.title)
            artist = normalize(candidate.artist.removesuffix(" - Topic"))
            title = title.removeprefix(wanted_artist + " ")
            title = re.sub(r"\b(official|audio|video|lyrics|visualizer|hd|hq)\b", "", title)
            title = " ".join(title.split())
            title_score = SequenceMatcher(None, wanted_title, title).ratio()
            artist_score = SequenceMatcher(None, wanted_artist, artist).ratio()
            if wanted_artist and wanted_artist in normalize(candidate.title):
                artist_score = max(artist_score, 0.9)
            delta = abs(meta.duration - candidate.duration)
            if meta.duration > 0 and (
                candidate.duration <= 0 or delta > max(15, meta.duration * 0.12)
            ):
                continue
            duration_score = (
                max(0, 1 - delta / max(8, meta.duration * 0.08)) if meta.duration else 0.5
            )
            # Version words are musical differences, not harmless upload decoration.
            version_mismatch = any(
                token in title.split() and token not in wanted_title.split()
                for token in ("live", "cover", "karaoke", "remix", "slowed", "sped", "instrumental")
            )
            score = (
                0.5 * title_score
                + 0.3 * artist_score
                + 0.17 * duration_score
                + (0.03 if candidate.topic else 0)
            )
            if version_mismatch:
                score -= 0.3
            candidate.score = round(max(0, score), 3)
            candidate.reason = (
                f"Title {title_score:.0%}, artist {artist_score:.0%}, "
                f"duration difference {delta:.0f}s"
                + ("; version differs" if version_mismatch else "")
            )
            if candidate.score >= min_score and title_score >= min_title:
                ranked.append(candidate)
        return sorted(ranked, key=lambda row: row.score, reverse=True)[:3]
