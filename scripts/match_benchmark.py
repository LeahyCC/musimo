"""Evaluate the matcher against a saved, resolver-independent review corpus."""

import argparse
import json
from collections import Counter
from pathlib import Path

from backend.job_models import Candidate, Metadata
from backend.matching import Matcher


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--corpus", type=Path, default=Path("docs/evidence/match-review-corpus.json")
    )
    parser.add_argument("--output", type=Path)
    parser.add_argument("--release", action="store_true")
    args = parser.parse_args()

    raw: object = json.loads(args.corpus.read_text(encoding="utf-8"))
    if not isinstance(raw, dict) or not isinstance(raw.get("cases"), list):
        parser.error("Corpus must contain a cases list")
    cases = raw["cases"]
    reference_search = reference_top1 = reference_top3 = accepted = 0
    reviewed = True
    reviewed_cases = correct = wrong_versions = reviewed_top3 = 0
    risks: Counter[str] = Counter()

    for index, case in enumerate(cases, 1):
        if not isinstance(case, dict):
            parser.error(f"Case {index} is not an object")
        target = case.get("target")
        truth = case.get("ground_truth")
        candidates = case.get("candidates")
        if not isinstance(target, dict) or not isinstance(truth, dict):
            parser.error(f"Case {index} is missing target or ground truth")
        if not isinstance(candidates, list):
            parser.error(f"Case {index} has no candidate list")
        expected = truth.get("youtube_ids")
        if not isinstance(expected, list) or not all(isinstance(value, str) for value in expected):
            parser.error(f"Case {index} has invalid reference video IDs")
        rows = [Candidate.model_validate(row) for row in candidates]
        ranked = Matcher().rank(
            Metadata.model_validate({"id": index, **target}),
            rows,
        )
        reference = set(expected)
        reference_search += any(row.id in reference for row in rows)
        reference_top1 += bool(ranked and ranked[0].id in reference)
        reference_top3 += any(row.id in reference for row in ranked)
        accepted += bool(ranked)
        case_risks = case.get("risks", [])
        if isinstance(case_risks, list):
            risks.update(value for value in case_risks if isinstance(value, str))

        labels = truth.get("reviewed_candidate_ids")
        review_method = truth.get("review_method")
        if (
            not isinstance(labels, list)
            or not all(isinstance(value, str) for value in labels)
            or not isinstance(review_method, str)
            or not review_method.strip()
        ):
            reviewed = False
            continue
        reviewed_cases += 1
        labelled = set(labels)
        correct += bool(ranked and ranked[0].id in labelled)
        reviewed_top3 += any(row.id in labelled for row in ranked)
        wrong = truth.get("wrong_version_ids", [])
        wrong_versions += bool(ranked and isinstance(wrong, list) and ranked[0].id in set(wrong))

    count = len(cases)
    report: dict[str, object] = {
        "cases": count,
        "distinct_recordings": len(
            {
                str(case["target"].get("recording_mbid", ""))
                for case in cases
                if isinstance(case, dict) and isinstance(case.get("target"), dict)
            }
        ),
        "risk_counts": dict(sorted(risks.items())),
        "resolver_acceptance": accepted,
        "reference_video": {
            "search_recall": reference_search,
            "ranked_top_1": reference_top1,
            "ranked_top_3": reference_top3,
            "note": "Retrieval check only; other uploads may contain the same recording",
        },
        "accuracy": {"status": "NOT MEASURED", "reviewed_cases": reviewed_cases},
    }
    if reviewed:
        report["accuracy"] = {
            "status": "MEASURED",
            "reviewed_cases": reviewed_cases,
            "correct_accepted": correct,
            "accepted": accepted,
            "precision": round(correct / accepted, 4) if accepted else None,
            "coverage": round(accepted / count, 4) if count else None,
            "wrong_version_rate": round(wrong_versions / accepted, 4) if accepted else None,
            "top_three_recall": round(reviewed_top3 / count, 4) if count else None,
        }
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    distinct = report["distinct_recordings"]
    if args.release and (count < 100 or distinct != count or not reviewed):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
