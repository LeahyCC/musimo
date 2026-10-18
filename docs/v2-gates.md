# V2 gates: interpreter, persona and audio evidence

Status: signed off by Colin, 17 October 2026. Part of [#179](https://github.com/LeahyCC/musimo/issues/179), packages 2A, 3A and 4A. Nothing here is built, downloaded, scanned or benchmarked. These are the decisions and pass marks to freeze before any candidate is evaluated, so no threshold is chosen after seeing a result.

Owner answers are marked **Colin**. Everything else is a recommendation Colin asked for and signed off. A change to a threshold needs a dated note here saying why, made before the run it affects.

## 2A: local interpreter

### Host and models

- **Colin:** the model runs on another computer, through Ollama. Musimo reaches it at the `ollama_url` setting.
- **Colin:** that computer has 32 GB RAM and 16 GB VRAM.
- **Colin:** candidates are 9B to 12B models. Claude does not inspect or download models on that machine. Colin installs the candidates.
- Recommended shortlist rule: two to four instruct models in that range that Ollama can run with structured JSON output, at Q4_K_M or Q5_K_M, whose licence allows personal use. Each must fit in VRAM with `num_ctx` 8192 and no CPU offload. llama3.1:8b passed 20/20 in the [earlier check](music-bot-review-fixes.md) and is kept as the baseline, not as a candidate.
- Each model is run with temperature 0 and a fixed seed. Each case runs three times so the report shows whether answers change between runs.

### The prompt suite

- Version 1, about 120 cases, written and labelled before any candidate runs. Each case records the intended meaning (action, scope, every hard constraint, follow-up state), not only a valid JSON shape.
- Covers: entity lookup and ambiguous titles, fine genre ("liquid" versus broad drum and bass), every duration mode and its boundary words, negation ("no vocals"), similar songs, queue and transport commands, multi-turn follow-ups that must keep earlier constraints, out-of-scope requests, and outage cases (timeout, malformed output, truncated context, invented ids).
- Split: about 70 development cases for prompt work, about 50 held-out cases sealed with a checksum. The held-out set runs once per candidate, after its prompt is frozen.

### Pass marks

Hard gates, where one failure fails the model:

- No mutation of playback, queue or playlists that was not approved.
- No hard constraint silently dropped in an acceptance case.
- No invented song id reaching the engine.
- Every outage case ends in a usable reply (a template, a structured control or a clear retry).

Quality, measured on the held-out set:

| Measure                                   | Pass                          |
| ----------------------------------------- | ----------------------------- |
| Action and scope correct                  | at least 95%                  |
| Every hard constraint correct in a case   | at least 90%                  |
| Follow-ups keep untouched constraints     | at least 95%                  |
| Asks a question on a truly ambiguous case | at least 80%                  |
| Asks a question on a clear case           | at most 5%                    |
| Warm interpreter call, p50 / p95          | at most 2.5 s / 5 s           |
| Cold load                                 | at most 30 s                  |
| Peak VRAM at `num_ctx` 8192               | at most 14 GB, no CPU offload |

Latency includes the network hop to the other computer and is measured from the Musimo server. Retrieval and rendering time are reported separately.

## 3A: persona

- **Colin:** a playful voice.
- Recommended: the same model as the interpreter, called after it in a separate validated call, only once the engine has a verified outcome. The neutral templates stay, and are used whenever the persona is off, fails, or misses its time budget.
- The persona gets the outcome as data: counts, totals, ids, action status. Song titles and tags in it are untrusted text, never instructions. It cannot execute anything.

Pass marks, on at least 50 recorded engine outcomes rendered in both voices:

- Hard: the selected ids, constraints and action status are identical in both voices. No "playing", "saved" or "added" before a confirmed receipt. Any number or song title in the persona's text must match the deterministic fields, checked by code; a mismatch falls back to the neutral template.
- A failed or offline model gives a truthful neutral reply every time.
- Warm render p95 at most 3 s. Over budget, the neutral reply is shown.

## 4A: audio evidence

### Labels

- **Colin:** see the repo. The [genre trial](genre-analysis-trial.md) has 28 clips Colin labelled on 14 October. The 13 held-out answers have been opened and reviewed, so they cannot validate a new candidate ([label review](genre-label-review.md)). All 28 become development data.
- Recommended: a new blind set of about 120 clips, labelled with the existing review page. Half development, half held-out. The held-out export is checksummed and not opened until every frozen candidate has run once.
- The set is chosen for the hard cases in #179: liquid versus other drum and bass, vocal versus instrumental, loud but mellow versus quiet but intense, tempo changes, long intros and spoken word. Labels say what was heard in the section played, and allow "unknown".

### Candidates

| Candidate                               | Use                           | Status                                                                 |
| --------------------------------------- | ----------------------------- | ---------------------------------------------------------------------- |
| Saved tags plus MFCC                    | Baseline for every comparison | Kept                                                                   |
| `laion/clap-htsat-unfused` at `8fa0f1c` | Neighbours and text phrases   | Candidate. Apache-2.0, peak 1.41 GB in the worker                      |
| Discogs-EffNet                          | Style labels                  | Only if its weight licence allows Musimo's use; confirm before any run |
| MusiCNN                                 | Neighbours                    | Only after the weight file's own licence is confirmed                  |
| AudioMuse DCLAP                         | None                          | Excluded, AGPL-3.0                                                     |

A candidate that does not fit the worker's 2 GB, one-CPU, no-swap budget fails. The budget is not raised for it.

### Pass marks

On the held-out set:

| Measure                                                         | Pass                                                                    |
| --------------------------------------------------------------- | ----------------------------------------------------------------------- |
| A strict attribute (liquid, vocals present) when not abstaining | precision at least 0.90                                                 |
| Songs it decides on rather than abstains                        | at least 60%                                                            |
| Gain over the tag baseline's precision                          | at least 10 points                                                      |
| Neighbours: blind listen of 100 seeds, top 5 judged a fit       | at least 70%, and 10 points over MFCC                                   |
| Tempo within 4%, half and double time reported separately       | at least 85%                                                            |
| Worker peak memory                                              | at most 1.8 GB                                                          |
| Throughput                                                      | at least 5 songs a minute, so 44,070 tracks take about six days or less |

Missing, failed or stale rows count as abstentions, never as a negative label. A passing candidate still needs separate sign-off before activation and before a full-library scan.

## What happens next

1. Colin signed off this page on 17 October 2026.
2. 2A: write the prompt suite and seal its held-out part. Colin installs the shortlisted models on the Ollama computer. Then one evaluation run per model, reported with the SHA, model digests, settings, results and failures.
3. 3A starts after a 2A model passes.
4. 4A: build the 120-clip blind set and seal its held-out part, then run the frozen candidates once.
