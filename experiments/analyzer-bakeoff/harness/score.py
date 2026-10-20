"""Score the bake-off. Host side, reads runtime/analyzer-bakeoff/out, writes results.json.

Usage: python -I score.py <runtime/analyzer-bakeoff dir> [style threshold, default 0.15]

Tempo
- librosa: tempo-energy-v1 rows from the DB copy (sections) and the offline rerun (60 s).
- Beat This!: per window, two BPMs from the stored beat times.
  `median`: 60 / median inter-beat interval, as asked. Beats sit on a 20 ms frame grid, so
  this is quantised too (0.42 s -> 142.86, 0.44 s -> 136.36).
  `fine`: 60 / mean of the "steady" gaps, those within 12 % of the median gap. Averaging
  many grid-snapped gaps recovers sub-frame precision.
  The section value is the median of the three 10 s sections, as tempo-energy-v1 does.
- Agreement classes against a reference: same (within 2 BPM), double, half, other.
  "double" means the analyser reads twice the reference, within 2 BPM of 2x.
- Confidence rule: a Beat This! BPM is "sure" when at least 2 of the 3 sections gave a
  steady-gap value and their median agrees with the 60 s window within 2 BPM. Anything else,
  including a missing value, is "unsure".

Genre
- Song style score = mean sigmoid activation over the patches run_essentia.py keeps.
- Parent genre score = the max over its styles.
- A file tag maps to Discogs parents through Musimo's own broad genres
  (backend/library/genres.py, tag_profile), over the genre column and the genres list.
- Flag rule: the tag's parent is not in the model's top 3 and the top parent scores at least
  FLAG_SCORE.
"""

import importlib.util
import json
import statistics
import sys
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

TOL = 2.0
STEADY = 0.12

TOP_STYLES = 5
FLAG_SCORE = 0.3


def _load_genres():
    """backend/library/genres.py by path: it imports only the standard library."""
    path = Path(__file__).resolve().parents[3] / "backend" / "library" / "genres.py"
    spec = importlib.util.spec_from_file_location("musimo_genres", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


GENRES = _load_genres()

# Musimo broad genre -> Discogs parent genre. A tag with no broad genre (Alternative, by the
# 14 October decision in docs/genre-mapping.md) has no parent and is not scored.
BROAD_PARENT = {
    "electronic": "Electronic",
    "drum-and-bass": "Electronic",
    "rock-metal": "Rock",
    "hip-hop": "Hip Hop",
    "pop": "Pop",
    "soul-rnb": "Funk / Soul",
    "reggae": "Reggae",
    "jazz": "Jazz",
    "folk-country": "Folk, World, & Country",
    "world": "Folk, World, & Country",
    "classical": "Classical",
    "blues": "Blues",
    "latin": "Latin",
    "soundtrack": "Stage & Screen",
    "spoken": "Non-Music",
}

# Rock styles that count as metal without the word in their name. Electronic---Hardcore
# (gabber) is not one of them.
METAL_STYLES = {
    f"Rock---{name}"
    for name in (
        "Thrash",
        "Grindcore",
        "Goregrind",
        "Deathcore",
        "Metalcore",
        "Post-Hardcore",
        "Hardcore",
        "Melodic Hardcore",
    )
}

# Finer check, for folded tag words that are themselves a style family.
TAG_STYLES = {
    "trance": lambda s: "Trance" in s,
    "dubstep": lambda s: (
        s in {"Electronic---Dubstep", "Electronic---Halftime", "Hip Hop---Bass Music"}
    ),
    "metal": lambda s: (s.startswith("Rock---") and "Metal" in s) or s in METAL_STYLES,
}


def song_tags(song: dict) -> tuple[str, ...]:
    extra = json.loads(song.get("genres") or "[]")
    return tuple(t for t in (song.get("genre") or "", *extra) if t)


def classify(value: float | None, ref: float | None) -> str | None:
    if not value or not ref:
        return None
    if abs(value - ref) <= TOL:
        return "same"
    if abs(value - 2 * ref) <= TOL:
        return "double"
    if abs(value - ref / 2) <= TOL:
        return "half"
    return "other"


def window_bpm(beats: list[float]) -> dict:
    if len(beats) < 4:
        return {"median": None, "fine": None}
    gaps = np.diff(np.asarray(beats))
    gaps = gaps[gaps > 0]
    med = float(np.median(gaps))
    steady = gaps[np.abs(gaps - med) <= STEADY * med]
    fine = 60.0 / float(steady.mean()) if len(steady) >= 3 else None
    return {"median": round(60.0 / med, 2), "fine": round(fine, 2) if fine else None}


def beat_this(record: dict) -> dict:
    out = {}
    for method in ("median", "fine"):
        sections = []
        for name in ("s10", "s50", "s90"):
            w = record["windows"].get(name, {})
            value = window_bpm(w.get("beat_times", []))[method] if "beat_times" in w else None
            if value:
                sections.append(value)
        long = record["windows"].get("long60", {})
        out[f"{method}_sections"] = round(statistics.median(sections), 2) if sections else None
        out[f"{method}_long60"] = (
            window_bpm(long.get("beat_times", []))[method] if "beat_times" in long else None
        )
        out[f"{method}_section_values"] = sections
    return out


def sure(row: dict) -> bool:
    values = row.get("fine_section_values") or []
    return len(values) >= 2 and classify(row.get("fine_sections"), row.get("fine_long60")) == "same"


def confidence(core: dict, music: dict) -> dict:
    out = {"core_sure": f"{sum(sure(v) for v in core.values())} of {len(core)}"}
    for name, keep in (("sure", True), ("unsure", False)):
        rows = [v for v in music.values() if sure(v) == keep]
        out[name] = {
            "songs": len(rows),
            "vs_deezer_long60": agreement([(v["fine_long60"], v["deezer"]) for v in rows]),
            "with_deezer_but_no_value": sum(
                1 for v in rows if v["deezer"] and not v.get("fine_long60")
            ),
        }
    return out


def deezer_kind(entry: dict) -> str:
    if "error" in entry:
        return entry.get("error_kind") or ("no isrc" if entry["error"] == "no isrc" else "error")
    return "bpm" if entry.get("bpm") else "bpm 0"


def spread(values: list[float]) -> dict:
    values = [round(v, 1) for v in values if v]
    counts = Counter(values)
    top = counts.most_common(3)
    return {
        "n": len(values),
        "distinct": len(counts),
        "top_values": top,
        "top_share": round(top[0][1] / len(values), 3) if values else None,
        "bins_5bpm": dict(sorted(Counter(int(v // 5 * 5) for v in values).items())),
    }


def agreement(pairs: list[tuple[float | None, float | None]]) -> dict:
    classes = Counter(c for c in (classify(a, b) for a, b in pairs) if c)
    n = sum(classes.values())
    return {"n": n, **{k: classes.get(k, 0) for k in ("same", "double", "half", "other")}}


def load_dir(path: Path) -> dict:
    return {
        p.stem: json.loads(p.read_text(encoding="utf-8")) for p in sorted(path.glob("tr-*.json"))
    }


def timing(records: dict, key: str = "seconds_total") -> dict:
    times = sorted(r[key] for r in records.values() if r.get(key) is not None)
    peaks = [r["memory"]["cgroup_peak"] for r in records.values() if r.get("memory")]
    if not times:
        return {}
    return {
        "n": len(times),
        "median_s": round(statistics.median(times), 3),
        "p95_s": round(times[int(0.95 * (len(times) - 1))], 3),
        "max_s": round(times[-1], 3),
        "total_s": round(sum(times), 1),
        "cgroup_peak_mb": round(max(peaks) / 1e6, 1) if peaks else None,
    }


def tempo_report(root: Path, sample: dict, deezer: dict) -> dict:
    songs = sample["songs"]
    report = {}
    for checkpoint in ("final0", "small0"):
        bt = load_dir(root / "out" / f"beat_this-{checkpoint}")
        bt.update(load_dir(root / "out" / f"beat_this-{checkpoint}-extra"))
        if not bt:
            continue
        lib = load_dir(root / "out" / "librosa")
        lib.update(load_dir(root / "out" / "librosa-extra"))
        rows = {}
        for song_id, record in bt.items():
            if record.get("status") != "done":
                rows[song_id] = {"status": record.get("status"), "error": record.get("error")}
                continue
            db = (songs[song_id].get("tempo_energy_v1") or {}) if song_id in songs else {}
            rerun = lib.get(song_id, {})
            rows[song_id] = {
                **beat_this(record),
                "librosa_sections_db": db.get("tempo_bpm"),
                "librosa_sections": rerun.get("bpm_sections") or db.get("tempo_bpm"),
                "librosa_long60": rerun.get("bpm_long60"),
                "deezer": (deezer.get(song_id) or {}).get("bpm") or None,
                "genre": songs[song_id]["genre"],
                "in_tempo_100": song_id in sample["tempo_ids"],
            }
        music = {
            k: v
            for k, v in rows.items()
            if "median_sections" in v and (v["genre"] or "").casefold() != "podcast"
        }
        core = {k: v for k, v in music.items() if v["in_tempo_100"]}
        bt_records = {k: v for k, v in bt.items() if k in sample["tempo_ids"]}
        run = json.loads((root / "out" / f"beat_this-{checkpoint}" / "_run.json").read_text())
        end_path = root / "out" / f"beat_this-{checkpoint}" / "_end.json"
        end = json.loads(end_path.read_text()) if end_path.exists() else {}
        entry = {
            "songs": rows,
            "spread_core": {
                name: spread([v[name] for v in core.values() if v.get(name)])
                for name in (
                    "librosa_sections",
                    "librosa_long60",
                    "median_sections",
                    "median_long60",
                    "fine_sections",
                    "fine_long60",
                )
            },
            "vs_librosa_core": {
                f"{method}_{window}": agreement(
                    [(v[f"{method}_{window}"], v[f"librosa_{window}"]) for v in core.values()]
                )
                for method in ("median", "fine")
                for window in ("sections", "long60")
            },
            "vs_deezer": {
                name: {
                    "core": agreement([(v[name], v["deezer"]) for v in core.values()]),
                    "all": agreement([(v[name], v["deezer"]) for v in music.values()]),
                }
                for name in (
                    "librosa_sections",
                    "librosa_long60",
                    "median_sections",
                    "median_long60",
                    "fine_sections",
                    "fine_long60",
                )
            },
            "sections_vs_long60_fine": agreement(
                [(v["fine_sections"], v["fine_long60"]) for v in core.values()]
            ),
            "confidence_rule": confidence(core, music),
            "timing_core": timing(bt_records),
            "infer_core": timing(bt_records, "seconds_infer"),
            "decode_core": timing(bt_records, "seconds_decode"),
            "load_seconds": run["load_seconds"],
            "memory_after_load_mb": round(run["memory_after_load"]["cgroup_peak"] / 1e6, 1),
            "cgroup_peak_end_mb": round(end["memory_end"]["cgroup_peak"] / 1e6, 1) if end else None,
        }
        report[checkpoint] = entry
    lib = load_dir(root / "out" / "librosa")
    if lib:
        same_as_db = [
            abs(
                (r.get("bpm_sections") or 0)
                - (songs[k]["tempo_energy_v1"] or {}).get("tempo_bpm", 0)
            )
            < 0.01
            for k, r in lib.items()
            if r.get("status") == "done"
        ]
        report["librosa_rerun"] = {
            "matches_db": f"{sum(same_as_db)} of {len(same_as_db)}",
            "timing_sections": timing(lib, "seconds_sections"),
            "timing_long60": timing(lib, "seconds_long60"),
        }
    report["deezer_coverage"] = {
        "tempo_100": Counter(deezer_kind(deezer[s]) for s in sample["tempo_ids"]),
        "genre_300": Counter(deezer_kind(deezer[s]) for s in sample["genre_ids"]),
        "bpm_by_tag": Counter(
            songs[s]["genre"] for s in sample["genre_ids"] if deezer[s].get("bpm")
        ).most_common(),
    }
    return report


def parent(style: str) -> str:
    return style.split("---")[0]


def genre_report(root: Path, sample: dict, threshold: float) -> dict:
    songs = sample["songs"]
    records = load_dir(root / "out" / "essentia")
    classes = json.loads(
        (root / "models" / "essentia" / "genre_discogs400-discogs-effnet-1.json").read_text()
    )["classes"]
    parents = sorted({parent(c) for c in classes})
    per_song = {}
    for song_id, record in records.items():
        if record.get("status") != "done":
            per_song[song_id] = {"status": record.get("status"), "error": record.get("error")}
            continue
        scores = np.asarray(record["scores"])
        parent_scores = {p: 0.0 for p in parents}
        for c, s in zip(classes, scores, strict=True):
            parent_scores[parent(c)] = max(parent_scores[parent(c)], float(s))
        ranked = sorted(parent_scores.items(), key=lambda x: -x[1])
        order = np.argsort(scores)[::-1]
        above = [(classes[i], round(float(scores[i]), 3)) for i in order if scores[i] >= threshold]
        song = songs[song_id]
        tag = (song["genre"] or "").strip()
        words, broad = GENRES.tag_profile(song_tags(song))
        tag_parents = {BROAD_PARENT[g] for g in broad if g in BROAD_PARENT}
        top3 = [p for p, _ in ranked[:3]]
        kept = above[:TOP_STYLES]
        style_checks = {w: any(TAG_STYLES[w](c) for c, _ in kept) for w in words if w in TAG_STYLES}
        per_song[song_id] = {
            "title": song["title"],
            "artist": song["artist"],
            "tag": tag,
            "tag_parents": sorted(tag_parents),
            "top_styles": kept,
            "top_styles_any": [(classes[i], round(float(scores[i]), 3)) for i in order[:5]],
            "parents_ranked": [(p, round(s, 3)) for p, s in ranked[:5]],
            "top1_ok": bool(tag_parents) and ranked[0][0] in tag_parents,
            "top3_ok": bool(tag_parents) and bool(tag_parents & set(top3)),
            "style_checks": style_checks,
            "n_above": len(kept),
            "n_parents_above": len({parent(c) for c, _ in kept}),
            "gap": round(
                ranked[0][1] - max((s for p, s in ranked if p in tag_parents), default=0.0), 3
            ),
            "seconds_total": record["seconds_total"],
        }
    rated = {k: v for k, v in per_song.items() if v.get("tag_parents")}
    by_tag = defaultdict(list)
    for v in rated.values():
        by_tag[v["tag"]].append(v)
    style_by_tag = defaultdict(list)
    for v in rated.values():
        for p, ok in v["style_checks"].items():
            style_by_tag[p].append(ok)
    misses = sorted(
        (v | {"song_id": k} for k, v in rated.items() if not v["top3_ok"]),
        key=lambda v: -v["gap"],
    )
    done = [v for v in per_song.values() if "n_above" in v]
    flagged = [m for m in misses if m["parents_ranked"][0][1] >= FLAG_SCORE]
    unmapped = defaultdict(Counter)
    for v in done:
        if not v["tag_parents"]:
            unmapped[v["tag"] or "(none)"][v["parents_ranked"][0][0]] += 1
    run = json.loads((root / "out" / "essentia" / "_run.json").read_text())
    end_path = root / "out" / "essentia" / "_end.json"
    end = json.loads(end_path.read_text()) if end_path.exists() else {}
    top1_scores = sorted(v["top_styles_any"][0][1] for v in done)
    return {
        "threshold": threshold,
        "n_done": len(done),
        "n_rated": len(rated),
        "top1": sum(v["top1_ok"] for v in rated.values()),
        "top3": sum(v["top3_ok"] for v in rated.values()),
        "by_tag": {
            tag: {
                "n": len(vs),
                "top1": sum(v["top1_ok"] for v in vs),
                "top3": sum(v["top3_ok"] for v in vs),
            }
            for tag, vs in sorted(by_tag.items(), key=lambda x: -len(x[1]))
        },
        "unmapped_tags_top_parent": {k: c.most_common() for k, c in unmapped.items()},
        "style_check": {p: f"{sum(v)} of {len(v)}" for p, v in style_by_tag.items()},
        "mix_counts": {
            "0 styles above": sum(v["n_above"] == 0 for v in done),
            "1 style": sum(v["n_above"] == 1 for v in done),
            "2+ styles": sum(v["n_above"] >= 2 for v in done),
            "2+ parents": sum(v["n_parents_above"] >= 2 for v in done),
        },
        "top1_score_quartiles": [
            round(top1_scores[int(q * (len(top1_scores) - 1))], 3) for q in (0, 0.25, 0.5, 0.75, 1)
        ]
        if top1_scores
        else [],
        "threshold_sweep": threshold_sweep(per_song, records, classes, rated),
        "top_misses": misses[:15],
        "flagged": {
            "rule": f"tag parent not in top 3 and top parent >= {FLAG_SCORE}",
            "count": len(flagged),
            "songs": [(m["artist"], m["title"], m["tag"]) for m in flagged],
        },
        "per_song": per_song,
        "timing": timing(records),
        "infer": timing(records, "seconds_infer"),
        "load_seconds": run["load_seconds"],
        "memory_after_load_mb": round(run["memory_after_load"]["cgroup_peak"] / 1e6, 1),
        "cgroup_peak_end_mb": round(end["memory_end"]["cgroup_peak"] / 1e6, 1) if end else None,
    }


def threshold_sweep(per_song: dict, records: dict, classes: list[str], rated: dict) -> list:
    """For each threshold: how many styles a song keeps, and what share of the kept styles
    sit under a parent the file tag agrees with. Used to pick the threshold."""
    rows = []
    for t in (0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5):
        kept = agree = songs_with = 0
        counts = []
        for song_id, v in rated.items():
            scores = np.asarray(records[song_id]["scores"])
            order = np.argsort(scores)[::-1][:TOP_STYLES]
            styles = [classes[i] for i in order if scores[i] >= t]
            counts.append(len(styles))
            kept += len(styles)
            agree += sum(parent(s) in v["tag_parents"] for s in styles)
            songs_with += bool(styles)
        rows.append(
            {
                "threshold": t,
                "songs_with_a_style": songs_with,
                "mean_styles": round(sum(counts) / len(counts), 2),
                "kept_styles_agreeing": round(agree / kept, 3) if kept else None,
            }
        )
    return rows


def main() -> None:
    root = Path(sys.argv[1])
    threshold = float(sys.argv[2]) if len(sys.argv) > 2 else 0.15
    sample = json.loads((root / "sample.json").read_text(encoding="utf-8"))
    deezer = json.loads((root / "out" / "deezer.json").read_text(encoding="utf-8"))
    results = {"tempo": tempo_report(root, sample, deezer)}
    if (root / "out" / "essentia").exists():
        results["genre"] = genre_report(root, sample, threshold)
    (root / "results.json").write_text(
        json.dumps(results, ensure_ascii=False, indent=1, default=list), encoding="utf-8"
    )
    print("written", root / "results.json")


if __name__ == "__main__":
    main()
