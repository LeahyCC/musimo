# Broad-genre trial

14 October 2026. Milestone 2 follow-up. The resource gate passed, but Colin did not accept the earlier musical matches. Genre identification now takes priority over mood, similarity and permanent indexing.

> **Missing files (found 20 October 2026).** The harnesses under `experiments/genre-trial/` and `experiments/audio-trial/` were never committed, and the evidence under `runtime/genre-trial/` (including the review page) is no longer on disk. The figures and labels in this report and the [label review](genre-label-review.md) are all that remain, and the reproduction steps below cannot run as written. The [analyser bake-off](analyzer-bakeoff.md) reruns the EffNet comparison with a committed harness.

**Updated result:** Colin labelled all 28 recordings. On the thirteen held-out clips, exact genre-set matches were tags 7/13, EffNet 5/13 and CLAP 2/13. Neither frozen model is recommended for production. See the [label review](genre-label-review.md) for per-genre precision/recall, denominators and errors. The initial experiment and pre-label workflow are documented below.

## Smallest useful review

Open the local genre review on pancakes with Musimo running. Start with **First six**, listen to the middle section, and use Early or Late when needed. Select one or more broad genres, or choose ambiguous, unknown or outside the vocabulary. Save each answer, then export the JSON file. This first batch contains five music cases and a podcast-tagged case; it is an initial diagnostic, not coverage of every genre.

Names, tags and predictions are hidden initially. Saving allows comparison; revealing locks that answer so the original blind judgement survives. Answers can be updated before revealing. Browser storage preserves progress; JSON export/import is the portable copy. Storage failures are reported and export still works from the open tab. All 28 clips remain available for later review. No source audio is copied, uploaded, tagged or added to a playback queue.

The page is a local file, and its stream URLs point to this computer's loopback Musimo service. Phone-sized layout was tested; remote phone access is not configured. Moving the file to a phone will not make those loopback streams available there.

## Models and licences

The dedicated model is MTG's **Discogs-EffNet**, `discogs-effnet-bs1-1.pb`, version 1. It predicts 400 music styles and includes electronic music and non-music classes. This uses the batch-one export and its prediction output directly, not an extra classifier head. The model file is 18,384,890 bytes. Its SHA-256 is `58a577a603669b922589179bd85ae06031fe642ffcc0ee873d2d79fbfc0ff8e5`; metadata SHA-256 is `c1bd5ed062d5c60538dc6a45c6eb9e64c69784ac3d19b1eb2e6d14cab83d8cdf`. Both are checked before each worker run. The model's training catalogue is not public, so overlap with this library cannot be ruled out. [Official exports](https://essentia.upf.edu/models/feature-extractors/discogs-effnet/), [model metadata](https://essentia.upf.edu/models/feature-extractors/discogs-effnet/discogs-effnet-bs1-1.json).

MTG models carry **CC BY-NC-SA 4.0**; proprietary licensing is also offered. Essentia code uses **AGPL v3**. Those terms need to be considered before any production packaging or commercial use; this experiment does not settle that choice. The pinned Linux CPU package is `essentia-tensorflow==2.1b6.dev1389`. Its CPython 3.12 Linux wheel SHA-256 is `6812425191f47ac7a5c566484f86a67890d581977e4969d1af83dc2dbc1f56ee`. [Model licence policy](https://essentia.upf.edu/models.html), [code licence](https://github.com/MTG/essentia/blob/master/COPYING.txt), [package release](https://pypi.org/project/essentia-tensorflow/2.1b6.dev1389/).

EffNet receives mono 16 kHz audio. Essentia builds 128-frame mel patches with the default 62-frame hop, using `batchSize=1`, `lastPatchMode="repeat"` and output `PartitionedCall:0`. Each bounded ten-second decode produces patch predictions, averaged within the section. For each broad genre we take the maximum child-style score, then average those broad scores across sections. This avoids summing a large family into a larger score, but families with more styles still have more opportunities for a high maximum. Sigmoid outputs and aggregated scores are not calibrated probabilities. [Official inference parameters](https://essentia.upf.edu/reference/std_TensorflowPredictEffnetDiscogs.html).

CLAP reuses `laion/clap-htsat-unfused` revision `8fa0f1c6d0433df6e97c127f64b2a1d6c0dcda8a`, the verified 614.5 MB weights, and Transformers 4.51.3 from the [first report](audio-analysis-trial.md). Checkpoint and implementation are Apache-2.0. It receives only mono 48 kHz audio and thirteen frozen broad-category prompts. Unit-normalised audio/text vectors are scored by cosine, averaged across sections. Prompts, thresholds and broad mappings were not tuned after seeing results. [Checkpoint](https://huggingface.co/laion/clap-htsat-unfused), [implementation licence](https://github.com/huggingface/transformers/blob/v4.51.3/LICENSE).

The alternative `dima806/music_genres_classification` was researched but not run. Its Apache-2.0 GTZAN classifier has ten categories and no general electronic or non-music category. That is a poor match for this library's large electronic collection. Discogs-EffNet was selected before inference for its coverage and small batch-one checkpoint. [Alternative model card](https://huggingface.co/dima806/music_genres_classification).

## Frozen sample and taxonomy

The experiment reuses the earlier read-only catalogue snapshot, not a new scan. Verified production mounts still point to `/library` on the Toshiba 14 TB disk and the checkout's `runtime/music`. All inference runs on pancakes, the actual server described in the first report. No Ollama settings changed.

The vocabulary is electronic/dance, rock/metal, hip-hop/rap, pop, soul/funk/R&B, reggae/dub/ska, jazz, folk/country/world, classical, blues, Latin, spoken/non-music, and other. These are deliberately broad working groups. Subgenres are deferred. Folk/country/world in particular needs human review before being treated as a useful category.

Selection uses only metadata, with deterministic SHA-256 ordering and exact semicolon-separated tag aliases. For example, `Electro; Dance; Pop` maps to electronic and pop; plain `Alternative` stays unmapped rather than being assumed to mean rock. Within eligible snapshot rows, mapped electronic tags cover 17,317 entries and rock/metal 10,001; 6,779 rows have no mapped tag. These counts overlap where tags are multilabel. They are comparison coverage, not verified genre counts.

There are **15 development and 13 held-out tracks**, with one per category per split, plus two long development mixes. The sample has 23 Opus, three M4A and two MP3 files; it does not add FLAC coverage to the previous trial. It includes two podcast-tagged recordings and two untagged recordings. Two development mixes last about 71 and 75 minutes.

No exact normalised artist or title is repeated. Artists used in the earlier hundred-track listening trial are excluded. Artist aliases, collaborations, covers and training-set overlap remain possible; this is not a proven recording-level leakage audit. The small per-genre counts cannot support a reliable general accuracy claim.

`prepare.py` froze selection, tag aliases, prompts and decision rules before predictions, in `runtime/genre-trial/frozen.json`, SHA-256 `87697a6f8d5db553fa04ec5496cce37e29840729078e3748e1f8c0a3b39dfc28`. The worker verifies it and refuses changed source/runtime combinations on resume. Existing tags form a separate metadata baseline and never enter either audio model. Titles and artists also never enter inference.

Uncalibrated review rules: abstain if CLAP's top cosine is below 0.20, EffNet's top broad score is below 0.10, or the top category is other. Otherwise suggest the top label, plus the second when the gap is under 0.02. Close results are marked ambiguous; all others remain tentative. These arbitrary starting rules are frozen, not evidence-based confidence thresholds. The generic CLAP other prompt cannot reliably detect every unseen genre.

Held-out predictions were generated once with the frozen short recipe. All 26 result files are checksummed in `heldout-seal.json`. Their tag disagreements and genre rankings have not been used for tuning. The evaluator only seals a complete held-out set; an incomplete seal from an early progress snapshot was retained separately and the completeness check corrected. No held-out predictions were changed.

## Resource and sampling measurements

The optional Linux container enforces 2,000,000,000 bytes RAM, one CPU and no swap, with a read-only root, read-only music/model/source mounts, no network and a 128 MB temporary filesystem. Cgroup readings confirm memory maximum 1,999,998,976 bytes after page rounding, `memory.swap.max=0`, and CPU quota/period `100000/100000`. Decoder children share these limits. Compose init supports kernel-enforced alarms, as tested in the earlier trial.

Decodes are ten seconds each, input-seeked, mono float32 and limited to thirty seconds wall time. Startup has 180 seconds, short tracks 120 seconds and longer tracks 180 seconds. The host stops an invocation after an hour. There are no automatic retries. File size/mtime are checked before and after; symlinks and paths outside the library are rejected. Failed or killed tracks get explicit records.

Short sampling uses 10%, 50% and 90% of the available start range. Development-only longer sampling uses nine evenly spaced ten-second sections, including the beginning and end. This is at most ninety seconds, not a whole-track reference. Long mixes remain largely unheard. Every result saves positions, section duration, summed duration and unique coverage.

| Model / set / recipe               | Tracks |   Fresh load | Median per track | Tracks/min | Peak memory |
| ---------------------------------- | -----: | -----------: | ---------------: | ---------: | ----------: |
| EffNet development, three sections |     15 |       0.66 s |           1.46 s |       29.2 |      374 MB |
| EffNet development, nine sections  |     15 |       0.68 s |           3.72 s |       14.0 |      376 MB |
| EffNet held-out, three sections    |     13 |       0.79 s |           1.41 s |       28.6 |      380 MB |
| CLAP development, three sections   |     15 | 8.75–10.49 s |           0.99 s |       46.8 |    1,320 MB |
| CLAP development, nine sections    |     15 |       8.17 s |           1.86 s |       29.4 |      858 MB |
| CLAP held-out, three sections      |     13 |       9.21 s |           0.95 s |       47.6 |    1,003 MB |

These are shared-server, warmed-filesystem results. Loading means a fresh process, including imports and, for CLAP, genre text encoding. Track latency includes decoding and scoring. Each model runs separately. Lower long-run peaks do not imply that longer audio needs less memory. There were zero failed tracks, timeouts or OOM kills across these runs. The separate initial two-track EffNet smoke is preserved; two CLAP smoke records were resumed into its development run.

EffNet abstained on 1/15 development tracks in each recipe and 0/13 held-out tracks. CLAP abstained on 0/15 development tracks and 2/13 held-out tracks. Ambiguous counts were EffNet 0/15 short, 2/15 long, 2/13 held-out; CLAP 8/15 short, 6/15 long, 4/13 held-out. These are rule outcomes, not correctness or calibrated uncertainty.

Development suggestion records changed for 3/15 EffNet and 6/15 CLAP tracks with longer sampling. That includes changes in first-ranked genre, a second suggestion or abstention reason, not just changed label sets. For example, EffNet added hip-hop beside soul for G05; CLAP changed its first ranking between pop and hip-hop for G03 and G04. Both long mixes retained their first-ranked genre, which does not establish that all their sections agree.

Exact label sets disagree with source tags on 7/15 EffNet and 13/15 CLAP short-development tracks. EffNet's short proposals cover eight broad groups; CLAP's cover eight, but different ones. Neither proposes every represented group. Per-genre tag coverage, proposed counts, disagreements and sampling changes are in summary.json. These are diagnostics, never tag-derived accuracy. A notable case is G12: its podcast tag contrasts with CLAP's blues/Latin suggestions. Listen before deciding whether this is a classifier failure, music within the recording or a bad source tag.

Result JSON sizes, including per-section scores, are EffNet 44.8/95.4/39.0 KB and CLAP 43.4/92.2/37.6 KB for development short/long and held-out short respectively. No permanent feature index was created. This small genre-balanced sample is not suitable for a new full-library scan estimate. The earlier scan estimates remain provisional; no scan is authorised by these results.

## Evaluation after labels arrive

`evaluate.py --annotations <export.json>` validates the manifest and vocabulary, then reports each genre's true positives, false positives, false negatives, truth/predicted denominators and precision/recall for tags, CLAP and EffNet, separately for development and held-out. Undefined denominators remain null. It also lists missing and extra labels per recording. Ambiguous, unknown and outside answers are counted and excluded from clear-label accuracy; out-of-vocabulary detection needs a later dedicated assessment. Model failures/abstentions count as empty predictions on clear labelled tracks.

Human-labelled evaluation is now recorded in the [label review](genre-label-review.md). Synthetic annotations from browser tests are explicitly named `test-only-*` and were not used. Do not tune against held-out labels; a later tuned recipe needs a fresh held-out evaluation.

## Reproduce and check

Use the existing verified audio snapshot and CLAP download. Preserve this trial's output directory before making any new experiment; `prepare.py` refuses to overwrite its manifest. Rebuilding the original audio image uses its pinned Dockerfile and lockfile. The genre image adds NumPy 1.26.4, Essentia-TensorFlow 2.1b6.dev1389, six 1.17.0 and PyYAML 6.0.2. The resolved package list and image identity are saved in the output directory. The measured genre image is `sha256:137fdfaed19e9d6d061f1d65f119de124c0156f83e89712fdb2a8c729253b491`.

```powershell
# From the repository root. For a new trial only:
New-Item -ItemType Directory -Force runtime/genre-trial/model | Out-Null
uv run python experiments/genre-trial/prepare.py
$base='https://essentia.upf.edu/models/feature-extractors/discogs-effnet'
curl.exe --fail --location "$base/discogs-effnet-bs1-1.pb" -o runtime/genre-trial/model/discogs-effnet-bs1-1.pb
curl.exe --fail --location "$base/discogs-effnet-bs1-1.json" -o runtime/genre-trial/model/discogs-effnet-bs1-1.json
uv run python experiments/audio-trial/download.py runtime/audio-trial/model
docker build -t musimo-audio-trial:1 experiments/audio-trial
docker build -t musimo-genre-trial:1 experiments/genre-trial
# Re-verify the disk and production mount before assigning this on another machine.
$env:TRIAL_LIBRARY='M:\Media\Music'
uv run python experiments/genre-trial/run.py genre-smoke-effnet --candidate effnet --limit 2
uv run python experiments/genre-trial/run.py genre-smoke-clap --candidate clap --limit 2
# Inspect smoke records, then run sequentially:
uv run python experiments/genre-trial/run.py genre-dev-effnet --candidate effnet
uv run python experiments/genre-trial/run.py genre-dev-clap --candidate clap
uv run python experiments/genre-trial/run.py genre-long-effnet --candidate effnet --long
uv run python experiments/genre-trial/run.py genre-long-clap --candidate clap --long
uv run python experiments/genre-trial/run.py genre-held-effnet --candidate effnet --split heldout
uv run python experiments/genre-trial/run.py genre-held-clap --candidate clap --split heldout
uv run python experiments/genre-trial/evaluate.py
uv run python experiments/genre-trial/review.py
uv run python experiments/genre-trial/check.py
node experiments/genre-trial/check-review.cjs
uv run ruff check --config 'line-length=110' experiments/genre-trial
uv run ruff format --check experiments/genre-trial
node frontend/node_modules/prettier/bin/prettier.cjs --check experiments/genre-trial/review.html experiments/genre-trial/check-review.cjs experiments/genre-trial/compose.yaml docs/genre-analysis-trial.md
git diff --check
```

Checks passed: mapping and multilabel denominator tests, exact artist/title separation, blind review, streaming playback, save/reload, reveal locking, export/import, rejection of a foreign manifest and 390-pixel phone layout. Screenshots and test evidence are in review-check.json, phone and desktop. Ruff uses 110 columns for two literal checksum lines; formatting uses the repository defaults. The workers remain stopped after the trial.

## Files and review boundary

New files under `experiments/genre-trial/`: `Dockerfile`, `compose.yaml`, `prepare.py`, `worker.py`, `run.py`, `evaluate.py`, `review.html`, `review.py`, `check.py` and `check-review.cjs`. New report: `docs/genre-analysis-trial.md`. Updated: `docs/ai-music-plan.md`. Raw model downloads, annotations, predictions, logs, snapshots and screenshots remain ignored under `runtime/genre-trial/`. The earlier trial and unrelated uncommitted work are preserved.

Updated recommendation after all 28 labels: retain the resource measurements, but do not promote either frozen model to production. EffNet did not beat existing tags on exact held-out genre sets, and CLAP performed poorly. The [label review](genre-label-review.md) is ready for the next planning decision. Taxonomy usefulness, sampling choice and production licensing remain open.

The existing architecture documentation still describes schema 6 in one section and schema 8 in another, while code uses 8. That mismatch remains outside this experiment. No commits, deployment, migrations, permanent indexing, source-tag changes or full scan were made.
