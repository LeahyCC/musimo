# Music match review

The [100-case corpus](evidence/match-review-corpus.json) pairs MusicBrainz recording IDs with public YouTube references sourced from unique Wikidata P4404 and P1651 values. The saved search candidates came from live `ytsearch8` results. Structured links establish provenance, but they do not prove that every alternative upload contains the right recording or edition.

An independent reviewer must listen to the reference and every plausible candidate. For each case, add `reviewed_candidate_ids` and `review_method` under `ground_truth`. Put known covers, live takes, remixes, edits or other wrong editions in `wrong_version_ids`. An empty `reviewed_candidate_ids` list means none of the retrieved candidates is correct.

Run the evaluator after review:

```sh
uv run python -m scripts.match_benchmark --output runtime/match-benchmark.json --release
```

The release option fails until all 100 distinct recordings have review labels and a recorded method. The linked reference retrieval figures are diagnostic only. They are not match precision.
