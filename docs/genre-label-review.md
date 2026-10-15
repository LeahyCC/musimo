# Genre review against Colin's labels

14 October 2026. All 28 exported answers were marked clear: 15 development and 13 held-out. The review records answers before revealing predictions. These are Colin's judgements of the auditioned sections, not verified whole-recording genres or a population benchmark.

**Neither frozen model improves enough on existing tags to justify production indexing.** Keep the resource result, reject the current CLAP genre recipe, and do not promote EffNet on this evidence. No prompts, thresholds, predictions or sampling settings were changed after the labels arrived.

## Exact label sets

A match requires every selected genre and no extra genres. Partial matches are retained in the per-genre figures below.

| Baseline/model | Development | Held-out |
| -------------- | ----------: | -------: |
| tags           |        6/15 |     7/13 |
| effnet         |        9/15 |     5/13 |
| clap           |        2/15 |     2/13 |

EffNet was stronger on development than held-out. CLAP added unrelated genres and missed both podcast labels. EffNet recognised both podcasts, but missed both development jazz labels and added or missed genres on electronic/hip-hop mixtures. Existing tags also contain clear mismatches, so they should remain a baseline rather than an answer key.

## Per-genre precision and recall

Each cell is **precision; recall**, shown as counts: correct predictions / all predictions; found labels / Colin's labels. A dash means there was no denominator. Multilabel tracks contribute to more than one genre. Unknown, ambiguous and outside-vocabulary exclusions: 0. There are no human-positive pop or other cases in the held-out set, so their recall cannot be assessed.

### heldout (13 labelled recordings)

| Genre              | Tags P; R | EffNet P; R | CLAP P; R |
| ------------------ | --------- | ----------- | --------- |
| electronic         | 1/1; 1/4  | 2/4; 2/4    | 1/1; 1/4  |
| rock-metal         | 1/2; 1/1  | 0/2; 0/1    | -; 0/1    |
| hip-hop            | 2/2; 2/2  | 2/3; 2/2    | 0/1; 0/2  |
| pop                | 0/1; -    | -; -        | 0/5; -    |
| soul-funk-rnb      | 1/1; 1/2  | 0/1; 0/2    | -; 0/2    |
| reggae             | 1/1; 1/1  | 1/1; 1/1    | -; 0/1    |
| jazz               | 1/1; 1/1  | 1/1; 1/1    | 1/1; 1/1  |
| folk-country-world | 0/1; 0/2  | 1/1; 1/2    | -; 0/2    |
| classical          | 0/1; 0/1  | -; 0/1      | -; 0/1    |
| blues              | 1/1; 1/1  | 1/1; 1/1    | 1/3; 1/1  |
| latin              | 1/1; 1/1  | -; 0/1      | 1/4; 1/1  |
| spoken-nonmusic    | 1/1; 1/1  | 1/1; 1/1    | -; 0/1    |
| other              | -; -      | -; -        | -; -      |

### dev (15 labelled recordings)

| Genre              | Tags P; R | EffNet P; R | CLAP P; R |
| ------------------ | --------- | ----------- | --------- |
| electronic         | 1/3; 1/2  | 2/3; 2/2    | -; 0/2    |
| rock-metal         | 0/2; 0/1  | 1/1; 1/1    | 1/2; 1/1  |
| hip-hop            | 1/1; 1/5  | 3/4; 3/5    | 2/2; 2/5  |
| pop                | 0/1; 0/2  | -; 0/2      | 2/6; 2/2  |
| soul-funk-rnb      | 0/1; 0/1  | 0/1; 0/1    | -; 0/1    |
| reggae             | 1/1; 1/1  | 1/1; 1/1    | -; 0/1    |
| jazz               | 1/1; 1/2  | -; 0/2      | 2/2; 2/2  |
| folk-country-world | 2/2; 2/2  | 2/2; 2/2    | 2/2; 2/2  |
| classical          | 1/1; 1/1  | 1/1; 1/1    | 1/1; 1/1  |
| blues              | 0/1; -    | -; -        | 0/4; -    |
| latin              | 0/1; -    | -; -        | 0/4; -    |
| spoken-nonmusic    | 1/1; 1/1  | 1/1; 1/1    | -; 0/1    |
| other              | -; -      | -; -        | -; -      |

Most held-out genres have only one or two positives. These denominators are too small for a general accuracy estimate. The sample was balanced by noisy source tags, so its human-labelled distribution differs from that selection plan.

## Errors worth keeping

- G12 and G27: Colin labelled spoken/non-music. CLAP suggested blues/Latin or Latin; EffNet and the source tags retained spoken/non-music.
- G19: Colin labelled classical. Source tags say pop, EffNet suggests electronic, and CLAP abstains.
- G23: Colin selected electronic, hip-hop and soul/funk/R&B. EffNet retained only hip-hop; CLAP suggested pop. The frozen maximum of two proposals cannot fully represent this three-label answer.
- G28: Colin labelled electronic. EffNet added soul/funk/R&B; CLAP suggested hip-hop/pop; source tags were absent.

Full missing/extra-label lists for every model and both splits are in [label-evaluation.json](../runtime/genre-trial/label-evaluation.json). This is a multilabel error analysis, not a single-class confusion matrix.

## Evidence and next decision

The original export is preserved as [colin-answers-2026-10-14.json](../runtime/genre-trial/colin-answers-2026-10-14.json). Its SHA-256 is `94b7fc17db9fda6566653b2892c12abcdee20e9a02479f1729ea5cb69325a8b0`. The manifest matches the frozen trial, all 28 IDs are valid, and all 26 held-out prediction files still match their pre-label checksums. Browser test annotations were not used.

Reproduce from the repository root:

```powershell
uv run python experiments/genre-trial/evaluate.py --annotations runtime/genre-trial/colin-answers-2026-10-14.json
```

Stop for planning review. A new candidate or recipe would need a fresh held-out set; do not tune against these now-reviewed answers and describe the result as independent validation. The longer development recipe was exploratory and has not been selected using held-out labels. No additional listening task is needed for this handoff.

This follow-up adds this report and updates the plan and trial status. It changes no experiment code or production data. No commit, deployment or full scan. The existing architecture schema-6/schema-8 documentation mismatch remains open.
