"""One-shot listening-state import. Both databases stay read-only unless --write is given."""

import argparse
import json
import sqlite3
from collections import defaultdict
from contextlib import closing
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath, PureWindowsPath

from backend.core.store import SCHEMA_VERSION, Store
from backend.core.text import normalize
from backend.library.player import frozen_id


def portable_path(value: str) -> PurePosixPath | PureWindowsPath:
    return PureWindowsPath(value) if "\\" in value or ":" in value else PurePosixPath(value)


def timestamp(value: object) -> str | None:
    if not value:
        return None
    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


@dataclass
class ImportPlan:
    matched_path: int = 0
    matched_tags: int = 0
    skipped: list[dict[str, object]] = field(default_factory=list)
    plays: list[tuple[str, int, str | None]] = field(default_factory=list)
    likes: list[str] = field(default_factory=list)
    artists: list[tuple[str, str]] = field(default_factory=list)
    playlists: list[tuple[str, list[str]]] = field(default_factory=list)
    queue: tuple[list[str], str, int] | None = None

    def report(self) -> dict[str, object]:
        return {
            "matched_by_path": self.matched_path,
            "matched_by_tags": self.matched_tags,
            "play_counts_or_dates_updated": len(self.plays),
            "song_likes_added": len(self.likes),
            "artist_favourites_added": len(self.artists),
            "playlists_created": len(self.playlists),
            "queue_entries": len(self.queue[0]) if self.queue else 0,
            "skipped_count": len(self.skipped),
            "skipped": self.skipped,
        }


class NavidromeImport:
    def __init__(self, source: sqlite3.Connection, user: str, roots: dict[str, str]) -> None:
        self.source = source
        self.roots = roots
        source.row_factory = sqlite3.Row
        users = source.execute(
            "SELECT id FROM user WHERE id=? OR user_name=?", (user, user)
        ).fetchall()
        if len(users) != 1:
            raise ValueError("Choose exactly one existing Navidrome user by name or id")
        self.user = str(users[0]["id"])

    def plan(self, target: sqlite3.Connection) -> ImportPlan:
        """Match against one target snapshot; apply rebuilds this plan under the writer lock."""
        target.row_factory = sqlite3.Row
        if not 6 <= target.execute("PRAGMA user_version").fetchone()[0] <= SCHEMA_VERSION:
            raise ValueError("Import requires an already-scanned compatible Musimo database")
        enabled = {
            portable_path(row[0])
            for row in target.execute("SELECT path FROM library_roots WHERE enabled=1")
        }
        if not self.roots or any(
            portable_path(root) not in enabled for root in self.roots.values()
        ):
            raise ValueError("Every root mapping must name an enabled Musimo root")
        rows = target.execute(
            "SELECT f.* FROM library_files f JOIN library_roots r ON r.path=f.root "
            "WHERE r.enabled=1 AND f.song_id!=''"
        ).fetchall()
        paths = {portable_path(row["path"]): row for row in rows}
        by_tags: dict[tuple[str, str, str], list[sqlite3.Row]] = defaultdict(list)
        for row in rows:
            by_tags[(row["artist_key"], row["album_key"], row["title_key"])].append(row)
        plan = ImportPlan()
        matches: dict[str, sqlite3.Row] = {}
        for song in self.source.execute(
            "SELECT m.id,m.path,m.artist,m.album,m.title,m.duration,l.path AS root "
            "FROM media_file m JOIN library l ON l.id=m.library_id WHERE m.missing=0"
        ):
            source_root = portable_path(song["root"])
            destination = next(
                (value for key, value in self.roots.items() if portable_path(key) == source_root),
                None,
            )
            if destination is None:
                plan.skipped.append({"kind": "unmapped_root", "path": song["path"]})
                continue
            source_path = source_root / portable_path(song["path"])
            try:
                relative = source_path.relative_to(source_root)
                if ".." in relative.parts:
                    raise ValueError("Path escapes root")
            except ValueError:
                plan.skipped.append({"kind": "unsafe_path", "path": song["path"]})
                continue
            matched = paths.get(portable_path(destination).joinpath(*relative.parts))
            if matched is not None:
                plan.matched_path += 1
            else:
                key = (
                    normalize(song["artist"]),
                    normalize(song["album"]),
                    normalize(song["title"]),
                )
                candidates = [
                    row
                    for row in by_tags.get(key, [])
                    if all(key) and abs(float(row["duration"]) - float(song["duration"])) <= 1
                ]
                if len(candidates) != 1:
                    plan.skipped.append(
                        {
                            "kind": "ambiguous" if candidates else "missing",
                            "path": song["path"],
                            "candidates": [row["path"] for row in candidates],
                        }
                    )
                    continue
                matched = candidates[0]
                plan.matched_tags += 1
            matches[str(song["id"])] = matched

        linked = target.execute(
            "SELECT p.id FROM linked_playlists l JOIN playlists p "
            "ON l.playlist_id='pl-' || p.id WHERE l.key='liked'"
        ).fetchone()
        liked = {
            str(row[0])
            for row in target.execute(
                "SELECT song_id FROM playlist_songs WHERE playlist_id=?",
                (linked[0] if linked else -1,),
            )
        }
        current_artists = {
            frozen_id("ar", str(row[0]))
            for row in target.execute(
                "SELECT CASE WHEN trim(album_artist)!='' THEN trim(album_artist) "
                "WHEN compilation=1 THEN 'Various Artists' WHEN trim(artist)!='' THEN trim(artist) "
                "ELSE 'Unknown artist' END FROM library_files f "
                "JOIN library_roots r ON f.root=r.path WHERE r.enabled=1"
            )
        }
        starred = {str(row[0]) for row in target.execute("SELECT artist_id FROM artist_favourites")}
        for item in self.source.execute(
            "SELECT a.*, ar.name AS artist_name FROM annotation a "
            "LEFT JOIN artist ar ON a.item_type='artist' AND ar.id=a.item_id WHERE a.user_id=?",
            (self.user,),
        ):
            if item["item_type"] == "media_file" and item["item_id"] in matches:
                row = matches[item["item_id"]]
                count = max(0, int(item["play_count"] or 0))
                when = timestamp(item["play_date"])
                old_when = timestamp(row["last_played"])
                if count > row["play_count"] or (when and (not old_when or when > old_when)):
                    plan.plays.append(
                        (
                            row["song_id"],
                            max(count, row["play_count"]),
                            max(filter(None, (when, old_when)), default=None),
                        )
                    )
                if item["starred"] and row["song_id"] not in liked:
                    plan.likes.append(row["song_id"])
                    liked.add(row["song_id"])
            elif item["item_type"] == "artist" and item["starred"]:
                artist_id = frozen_id("ar", str(item["artist_name"] or "").strip())
                if artist_id not in current_artists:
                    plan.skipped.append({"kind": "unmatched_artist", "name": item["artist_name"]})
                elif artist_id not in starred:
                    plan.artists.append(
                        (artist_id, timestamp(item["starred_at"]) or datetime.now(UTC).isoformat())
                    )
                    starred.add(artist_id)

        names = {str(row[0]) for row in target.execute("SELECT name FROM playlists")}
        for playlist in self.source.execute(
            "SELECT id,name,rules FROM playlist WHERE owner_id=? ORDER BY id", (self.user,)
        ):
            name = str(playlist["name"]).strip()
            reason = (
                "smart_playlist"
                if playlist["rules"]
                else "existing_playlist"
                if name in names
                else "invalid_playlist_name"
                if not name or len(name) > 200
                else ""
            )
            ids = [
                str(row[0])
                for row in self.source.execute(
                    "SELECT media_file_id FROM playlist_tracks WHERE playlist_id=? ORDER BY id",
                    (playlist["id"],),
                )
            ]
            songs = [str(matches[key]["song_id"]) for key in ids if key in matches]
            if not reason and len(songs) > 500:
                reason = "playlist_over_500"
            if reason:
                plan.skipped.append({"kind": reason, "name": name})
            else:
                plan.playlists.append((name, songs))
                names.add(name)
        has_queue = target.execute("SELECT 1 FROM play_queue_songs LIMIT 1").fetchone()
        has_source_queue = self.source.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='playqueue'"
        ).fetchone()
        queue = (
            self.source.execute(
                "SELECT items,current,position FROM playqueue WHERE user_id=?", (self.user,)
            ).fetchone()
            if has_source_queue
            else None
        )
        if has_queue:
            plan.skipped.append({"kind": "existing_queue"})
        elif queue:
            ids = str(queue["items"] or "").split(",")
            songs = [str(matches[key]["song_id"]) for key in ids if key in matches]
            if len(songs) > 500:
                plan.skipped.append({"kind": "queue_over_500"})
            elif songs:
                index = int(queue["current"])
                current = matches.get(ids[index]) if 0 <= index < len(ids) else None
                plan.queue = (
                    songs,
                    str(current["song_id"]) if current else "",
                    max(0, int(queue["position"])) if current else 0,
                )
        else:
            plan.skipped.append({"kind": "no_source_queue"})
        return plan

    def apply(self, store: Store) -> ImportPlan:
        """Commit all listening state together; a failed write leaves the old state intact."""
        with store.lock:
            db = store.db
            db.execute("BEGIN IMMEDIATE")
            try:
                plan = self.plan(db)
                now = store._timestamp()
                for song, count, when in plan.plays:
                    db.execute(
                        "UPDATE library_files SET play_count=max(play_count,?), "
                        "last_played=nullif(max(coalesce(last_played,''),coalesce(?,'')),'') "
                        "WHERE song_id=?",
                        (count, when, song),
                    )
                db.executemany("INSERT OR IGNORE INTO artist_favourites VALUES (?,?)", plan.artists)
                for name, songs in plan.playlists:
                    playlist_id = db.execute(
                        "INSERT INTO playlists(name,public,created,changed) VALUES (?,0,?,?)",
                        (name, now, now),
                    ).lastrowid
                    db.executemany(
                        "INSERT INTO playlist_songs VALUES (?,?,?)",
                        [(playlist_id, index, song) for index, song in enumerate(songs)],
                    )
                if plan.likes:
                    linked = db.execute(
                        "SELECT p.id FROM linked_playlists l JOIN playlists p "
                        "ON l.playlist_id='pl-' || p.id WHERE l.key='liked'"
                    ).fetchone()
                    playlist_id = (
                        linked[0]
                        if linked
                        else db.execute(
                            "INSERT INTO playlists(name,public,created,changed) "
                            "VALUES ('Liked',0,?,?)",
                            (now, now),
                        ).lastrowid
                    )
                    db.execute(
                        "INSERT OR REPLACE INTO linked_playlists VALUES ('liked',?)",
                        (f"pl-{playlist_id}",),
                    )
                    position = db.execute(
                        "SELECT count(*) FROM playlist_songs WHERE playlist_id=?", (playlist_id,)
                    ).fetchone()[0]
                    db.executemany(
                        "INSERT INTO playlist_songs VALUES (?,?,?)",
                        [(playlist_id, position + i, song) for i, song in enumerate(plan.likes)],
                    )
                    db.execute("UPDATE playlists SET changed=? WHERE id=?", (now, playlist_id))
                if plan.queue:
                    songs, current, position = plan.queue
                    db.executemany(
                        "INSERT INTO play_queue_songs VALUES (?,?)", list(enumerate(songs))
                    )
                    db.execute(
                        "UPDATE play_queue SET current_id=?,position_ms=?,changed=? WHERE id=1",
                        (current, position, now),
                    )
                db.execute("UPDATE library_revision SET value=value+1 WHERE id=1")
                store._event(
                    "library.import",
                    {key: value for key, value in plan.report().items() if key != "skipped"},
                )
                db.commit()
                return plan
            except Exception:
                db.rollback()
                raise


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("target", type=Path)
    parser.add_argument("--user", required=True)
    parser.add_argument("--root", action="append", required=True, help="SOURCE_ROOT=TARGET_ROOT")
    parser.add_argument(
        "--write", action="store_true", help="Apply after backup, with Musimo stopped"
    )
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    if args.source.resolve() == args.target.resolve():
        parser.error("Source and target must be different files")
    if args.report and args.report.resolve() in {args.source.resolve(), args.target.resolve()}:
        parser.error("The report cannot overwrite either database")
    if any("=" not in value or not all(value.split("=", 1)) for value in args.root):
        parser.error("Each --root must have the form SOURCE_ROOT=TARGET_ROOT")
    roots = dict(value.split("=", 1) for value in args.root)
    with closing(sqlite3.connect(args.source.resolve().as_uri() + "?mode=ro", uri=True)) as source:
        source.execute("BEGIN")
        importer = NavidromeImport(source, args.user, roots)
        with closing(
            sqlite3.connect(args.target.resolve().as_uri() + "?mode=ro", uri=True)
        ) as target:
            target.execute("BEGIN")
            plan = importer.plan(target)
        if args.write:
            store = Store(args.target)
            try:
                plan = importer.apply(store)
            finally:
                store.close()
        report = plan.report() | {"written": args.write}
        if args.report:
            args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(
            json.dumps({key: value for key, value in report.items() if key != "skipped"}, indent=2)
        )


if __name__ == "__main__":
    main()
