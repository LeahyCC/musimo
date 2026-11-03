"""Export 4A blind labels to evals/audio for the evidence trial.

Reads runtime/label-4a/manifest.json and the saved answers (or a synthetic answers file
for tests) and writes manifest.json, dev.json, heldout.json and seal.json.

Never prints held-out answers; only counts.
"""

import argparse
import hashlib
import json
import os
import sys
from datetime import UTC, datetime
from pathlib import Path

from backend.core.store import Store
from backend.library.label_4a import default_manifest_path, load_answers, load_manifest

DEFAULT_OUTPUT = "evals/audio"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export 4A blind labels")
    parser.add_argument(
        "--data-dir",
        default=os.environ.get("MUSIMO_DATA_DIR", "/data"),
        help="Musimo data directory (default: MUSIMO_DATA_DIR or /data)",
    )
    parser.add_argument(
        "--manifest",
        default=str(default_manifest_path()),
        help="Picker manifest path",
    )
    parser.add_argument(
        "--answers",
        help=(
            "Synthetic answers JSON file (for tests). "
            "If omitted, answers are read from the database."
        ),
    )
    parser.add_argument(
        "--output", default=DEFAULT_OUTPUT, help=f"Output directory (default: {DEFAULT_OUTPUT})"
    )
    return parser.parse_args()


def digest_file(path: Path) -> str:
    """SHA-256 of the parsed JSON, so a formatter cannot break the seal."""
    with path.open(encoding="utf-8") as handle:
        data = json.load(handle)
    canonical = json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def answer_to_dict(answer: object, clip_id: str = "") -> dict[str, object]:
    """Flatten a Label4AAnswer or a plain dict into the export shape."""
    if isinstance(answer, dict):
        return {
            "clip_id": answer.get("clip_id", clip_id),
            "sections_played": answer.get("sections_played", []),
            "vocals": answer.get("vocals"),
            "intensity": answer.get("intensity"),
            "speech": answer.get("speech"),
            "dnb": answer.get("dnb"),
            "dnb_subtype": answer.get("dnb_subtype"),
        }
    return {
        "clip_id": answer.clip_id,
        "sections_played": answer.sections_played,
        "vocals": answer.vocals,
        "intensity": answer.intensity,
        "speech": answer.speech,
        "dnb": answer.dnb,
        "dnb_subtype": answer.dnb_subtype,
    }


def load_synthetic_answers(path: Path) -> dict[str, dict[str, object]]:
    with path.open(encoding="utf-8") as handle:
        data = json.load(handle)
    if isinstance(data, dict):
        return data
    if isinstance(data, list):
        return {item["clip_id"]: item for item in data}
    raise ValueError("Answers file must be a dict or a list")


def main() -> None:
    args = parse_args()
    manifest_path = Path(args.manifest)
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)

    manifest = load_manifest(manifest_path)

    if args.answers:
        answers_path = Path(args.answers)
        if not answers_path.name.startswith("test-only-"):
            print(
                "Synthetic answers files must be named test-only-*",
                file=sys.stderr,
            )
            sys.exit(1)
        answers = load_synthetic_answers(answers_path)
    else:
        data = Path(args.data_dir)
        store = Store(data / "musimo.sqlite3")
        try:
            answers = {
                clip_id: answer_to_dict(answer) for clip_id, answer in load_answers(store).items()
            }
        finally:
            store.close()

    dev_clips = [clip for clip in manifest.clips if clip.split == "dev"]
    held_clips = [clip for clip in manifest.clips if clip.split == "held"]

    manifest_out = {
        "seed": manifest.seed,
        "snapshot_time": manifest.snapshot_time,
        "total": len(manifest.clips),
        "clips": [
            {
                "clip_id": clip.clip_id,
                "song_id": clip.song_id,
                "section_start": clip.section_start,
                "group": clip.group,
                "split": clip.split,
            }
            for clip in manifest.clips
        ],
        "exported_at": datetime.now(UTC).isoformat(),
    }

    def split_entries(clips: list[object]) -> list[dict[str, object]]:
        result: list[dict[str, object]] = []
        for clip in clips:
            clip_id = clip.clip_id
            entry = answer_to_dict(answers.get(clip_id, {"clip_id": clip_id}), clip_id)
            entry["clip_id"] = clip_id
            result.append(entry)
        return result

    dev_entries = split_entries(dev_clips)
    held_entries = split_entries(held_clips)

    (output / "manifest.json").write_text(json.dumps(manifest_out, indent=2), encoding="utf-8")
    (output / "dev.json").write_text(
        json.dumps({"split": "dev", "entries": dev_entries}, indent=2), encoding="utf-8"
    )
    (output / "heldout.json").write_text(
        json.dumps({"split": "held", "entries": held_entries}, indent=2), encoding="utf-8"
    )

    seal = {
        "file": "heldout.json",
        "sha256": digest_file(output / "heldout.json"),
        "cases": len(held_entries),
        "sealed": datetime.now(UTC).isoformat(),
        "note": "SHA-256 of the parsed heldout.json. Any change to a case breaks the seal.",
    }
    (output / "seal.json").write_text(json.dumps(seal, indent=2), encoding="utf-8")

    answered_dev = sum(1 for e in dev_entries if e["vocals"] is not None)
    answered_held = sum(1 for e in held_entries if e["vocals"] is not None)
    print(f"dev: {answered_dev}/{len(dev_entries)}, heldout: {answered_held}/{len(held_entries)}")


if __name__ == "__main__":
    main()
