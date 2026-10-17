# Music bot and audio indexing

Status: milestone 1 implemented for review, 13 October 2026. See [the review fixes](music-bot-review-fixes.md) for current checks, live Ollama results and remaining issues, and [the original handoff](music-bot-review.md) for the initial implementation. Audio indexing has not started.

14 October follow-up: milestone 2 passed its resource gate, but musical quality remains unaccepted. Colin labelled all 28 recordings in the [genre trial](genre-analysis-trial.md). Exact genre-set matches on thirteen held-out clips were existing tags 7/13, Discogs-EffNet 5/13 and CLAP 2/13. The [label review](genre-label-review.md) records per-genre precision/recall and errors. Neither frozen model is recommended for production genre indexing. These held-out labels must not become tuning data for a claimed independent validation.

15 October: the next approach is specified and implemented in [song characteristics](audio-profile-spec.md). It stores tempo, energy, and one sound vector in the existing SQLite file (schema 9), leases work to an optional worker container, and ranks with those measurements once a recipe is named in Settings. Both recipe settings ship empty: the scripted tempo listen, the embedding listen and the full scan have not happened, no scan was started, and the held-out genre labels were not used.

Two features: a local Ollama music bot, and background audio indexing that improves its recommendations. Analysis runs on the Musimo server with strict resource limits. Both use the existing library and player.

Agreed choices: ship the bot over existing tags first; keep SQLite; connect to a configurable local Ollama address with selectable installed models; run audio analysis in a separate worker on the Musimo server. Start the worker at a hard ceiling of two GB RAM, one CPU core and one song at a time. Trial CLAP first against a lightweight similarity baseline. Test three short sections spread across each song against fuller analysis before adopting sampling. Model selection and sample length remain benchmark decisions.

```text
Music files -> existing tag index --------------------+
                                                     |
Music files -> limited audio worker -> saved profiles +-> search -> playlist / queue
                                                     |
Chat -> selected Ollama model -> validated request ---+
```

## 1. Music bot

Open a chat panel from the player or navigation. Keep playback and chat available together on desktop; use a full page on phones. Settings holds the Ollama server address and connection test. The chat offers installed local models, remembers the selection, and reports unavailable or incompatible models. Changing the chat model never invalidates audio analysis.

Use the existing HTTP client dependency to call Ollama. Benchmark a few suitable installed local models on the same music requests before recommending a default; do not require a particular model or download one automatically. Record correctness and cold/warm response times separately. Ollama may run on this server or another machine on the local network; its configured address determines the location.

First version:

- Find music in the local library by artist, genre, year, duration, favourites and play history.
- Build a playlist or queue, then refine it with requests such as "more familiar", "only 90s tracks" or "remove that artist".
- Use the current song, proposed selection and upcoming queue as context for "more like this" and "make the rest calmer".
- Show playable track cards, total duration and short explanations based on saved evidence.
- Offer Play, Play next, Add to queue and Save playlist. Preview generated selections before applying them; direct pause, resume and skip requests act immediately.
- Provide Undo for the latest queue edit, without overwriting subsequent manual changes. Preserve the playing song when editing upcoming tracks.

Start with existing tags. Until audio profiles exist, explain when a request needs analysis instead of inventing mood or instrument facts. Search analysed songs as they become available and show coverage. Enforce explicit exclusions; report too few matches rather than silently breaking them.

Use one schema-constrained Ollama request to produce a small search/action plan. Backend services validate it and resolve real song IDs. Never accept model-written SQL, arbitrary paths or invented tracks. Limit context, candidate counts, response size and retries. Treat song tags and lyrics as data, not instructions. Keep conversation history bounded and clearable in the current browser session initially.

A cancelled, timed-out or superseded request cannot change playback. Recheck track availability and queue state before applying a proposal. Apply through the existing browser player, since updating the saved server queue alone does not control live audio. Respect its 500-entry queue limit and browser autoplay restrictions. Retry notices must not claim playback began when the browser refused it.

### Engine boundary (V2 package 1A)

A client that is not the chat can ask the engine directly. `POST /api/music-bot/intent` takes a versioned canonical intent (action, hard filters, scope, seed and the songs the request is about), adapts it onto the existing search plan and resolver, and returns real song ids with the snapshot they came from. It calls no model and changes no playback, queue, playlist or history. `GET /api/music-bot/capabilities` lists what the resolver supports now; duration comparators, audio certainty, a persona and an outside catalogue are listed as not available. A constraint the engine cannot honour is refused with a typed error, not dropped: that includes an unknown field, an unsupported version, audio fields with their recipe off and a negated description. The chat route and the frontend are unchanged. Shared recent-result memory, a duration solver, an interpreter and a persona are later packages. See [the architecture](architecture.md) for the fields, the snapshot and the error codes.

### Proposals and commit (V2 package 1B, backend)

A generated playlist or queue is a preview first. `POST /api/music-bot/proposals` runs the engine and stores the result as revision 1 of a proposal: the intent with the seed it drew, the ordered song ids and the full snapshot. A refinement is a new intent against the latest revision and becomes the next revision; older revisions stay readable. None of this touches playlists, the queue, playback or history. Committing names one revision, an operation id from the client and a target. It never runs selection again: it rechecks that each approved song is still there with a usable file and that what the request depended on for those songs (tags and length, and where asked, history, likes, measurements, the local day) has not changed. If anything has, it refuses with `proposal_stale` and says what, so the preview is refreshed; it never swaps songs. A playlist commit saves exactly those ids in that order once. A queue commit hands the ids back with a `ready_for_player` receipt and the browser applies them, because the browser owns live playback. Retrying the same operation id returns the first receipt. Committing an older revision, or the same revision again, has to be asked for explicitly. The store keeps the 20 most recent proposals and 20 revisions of each. Still to come in 1B: the summary and sample view, the chat frontend using these routes, persistent shown memory with its reset, and the duration modes (6A). Shown-id memory stays in the browser for now.

## 2. Music indexing for the bot

Reuse the existing tag scanner, song IDs and SQLite database. Add a durable analysis queue and versioned track profiles. Read files directly from configured music mounts; store predictions separately from original tags and leave music files untouched.

The worker runs in an optional Linux container on the same server, with read-only music mounts. FastAPI owns database writes. The worker leases one job through an internal authenticated API and submits its result; it does not open SQLite. Expired leases recover after crashes, and late or duplicate results cannot replace a newer profile.

Starting limits: one worker, one track at a time, two GB RAM, one CPU core and no swap for the worker. Enforce limits through Compose, including child decoders, rather than relying only on process monitoring. Add per-track deadlines, bounded decode buffers and finite retries. An oversized or corrupt file fails visibly without blocking the library. Long mixes require bounded sampling too.

Controls: start with a 100-song trial, then scan selected folders or the library; pause, resume, cancel and retry failures. Show completed/remaining counts, failures, peak memory, songs per minute and an estimated finish range based on measured work. Prioritise user-selected tracks, then new additions, then the backlog. Results become searchable after each completed job.

Pause new analysis during bot requests to reduce contention. Stop and release the worker when paused or idle, with a short grace period before terminating a stuck track. Playback remains usable under load. Ollama runs separately and needs its own memory budget; an indexer cap does not cap the language model.

Profile fields: song ID, file size and modification time, model/version, sampling recipe, status, measured descriptors, predicted tags with scores, and a compact sound vector. Recheck file identity before committing results. Reanalyse changed files and changed analysis recipes; exclude removed or unavailable files. Model upgrades retain the previous working index until replacement data is ready, and never compare vectors from different model versions.

## Model choice and speed gate

For the chat-model comparison, test `huihui_ai/qwen3.5-abliterated:9b` and the already-installed `huihui_ai/gemma-4-abliterated:12b`. The standard `qwen3.5:9b` download was cancelled and is no longer planned. Verify installation and model digests before testing. Keep the selected default unchanged pending review of the request corpus.

Musimo sends `num_ctx: 8192` and `keep_alive: "60s"`. Before each chat it reads `/api/show`: when `thinking.values` explicitly includes boolean `false`, it sends `think: false`. Otherwise it omits `think`, preserving compatibility with older metadata and models that only support named thinking levels. This does not claim to disable thinking on those models. These request options are implemented and need no Ollama restart. See [review evidence](music-bot-finish-review.md) for structured-output, follow-up and timing results.

Ollama was subsequently restarted. Its 14 October 2026 startup log at 08:55 HST confirms `OLLAMA_NUM_PARALLEL=1` and `OLLAMA_MAX_LOADED_MODELS=1`. The analysis trial verified that log without restarting Ollama or changing the selected `huihui_ai/qwen3.5-abliterated:9b` model. These server settings affect other callers too.

Trial a music/text model from the CLAP family first, against a lightweight sound-similarity baseline. The exact checkpoint must pass the resource and licence checks before adoption. A text/audio model supports open-ended descriptions such as "dreamy guitar"; sound similarity alone does not provide that. If CLAP cannot fit, record the failure and evaluate a smaller model rather than raising the limit.

Test three short sections spread across each song against fuller analysis on 100 varied songs, including long and changing tracks. Choose section length to match the candidate model's input requirements and record positions, aggregation and duration in the recipe. Decode only bounded sections rather than loading the entire recording to slice it. Measure cold loading, per-song time, peak process/container memory, index size and search latency. Record hardware, settings and model licence. Review actual recommendations by listening. Sampling must earn its place through acceptable results.

Proposed search target: warm retrieval below 500 ms at the intended library size, measured separately from Ollama generation. Start with bounded vector scoring and metadata filters; add a specialised index only if that target fails. Never load the entire library into the model prompt. Measure real audio analysis separately from synthetic large-catalogue search tests.

Before a full scan, estimate its cost from the trial and actual eligible track count. If the model exceeds the resource ceiling or gives poor matches, choose a lighter approach. Do not silently increase limits.

## Build order and checks

1. **Bot over existing tags.** Add Ollama settings, model selection, validated search plans, chat UI and the existing playlist/queue actions. Verify follow-up requests, exclusions, cancellation, invalid model output, unavailable Ollama, Undo and autoplay failures.
2. **Analysis trial.** Compare candidate models on 100 songs under enforced limits. Record results and select the model, sampling recipe and practical resource budget before shipping audio indexing.
3. **Durable indexing.** Add migrations, worker leases, profiles, progress controls and incremental search. Verify pause/restart, worker termination, changed/deleted files, partial coverage, retries and migration recovery.
4. **Audio-aware bot.** Connect similarity, mood/instrument evidence and text search. Verify "more like this", "less intense" and "no vocals" against known tracks, including missing evidence and conflicting requests.
5. **Release check.** Run normal repository checks, desktop/phone browser flows and playback while indexing. Publish measured memory and scan/search timing. Update player, settings, architecture and testing docs with shipped behaviour.

Reuse `backend/library/index.py`, `backend/library/player.py`, `backend/core/store.py`, the player API and `PlayerProvider`. Put bot interpretation and recommendation rules in services; keep generic scoring helpers independent. Existing uncommitted player/tagging changes need reconciliation before implementation.

First milestone acceptance: "Queue an hour of my favourite 90s music, excluding songs played today" produces a reviewable selection using real library IDs, respects the configured local day and exclusions, and applies through the live player. If the library cannot fill the duration, report the shortfall. A follow-up such as "remove that artist" revises the same proposal. This flow must work with audio indexing disabled.

## Handoff and review

Implement milestone 1 first and stop at a reviewable diff. Preserve existing unrelated changes and report exactly which files belong to this work. Supply tests run and results, desktop/phone UI evidence, any live Ollama measurements, and remaining issues. Mocked tests do not establish real model quality or performance. Do not merge, deploy or begin a full-library scan as part of this handoff.

Return the diff or PR to the planning chat for review before starting milestone 2. Review checks the complete request-to-playback flow, queue state and Undo, bounded requests, failure handling, and tests. After the analysis trial, review its measurements and listening results before selecting the production audio model or starting a full scan.

## Decisions still to settle

- Milestone 2 measurements are complete: [bounded trial report](audio-analysis-trial.md). The actual server is pancakes, with 44,070 indexed candidates. Both models completed 100 tracks under 2 GB, one CPU and no swap; CLAP peaked at 1.41 GB and warm text encoding plus synthetic full-size scoring took 34 ms median.
- Musical quality is not accepted. The next approach is built: [song characteristics](audio-profile-spec.md) ships schema 9, the lease, the `tempo-energy-v1` worker and the bot's gates behind empty settings. Still open, in this order: the scripted tempo listen (then `audio_scalar_recipe` may be set to `tempo-energy-v1`), the embedding checkpoint and its 100-song neighbour listen (text-encoder residency with it), the measured worker rate, and only then a full scan. Do not start a full scan until a recipe's listen has passed.
- The actual Ollama endpoint, discovered or configured during setup; both local deployment locations are supported.

Voice chat, automatic DJ narration, lyric transcription, permanent taste memory and continuously replenished radio queues are later features.

## References

- [Ollama model listing](https://docs.ollama.com/api/tags), [chat API](https://docs.ollama.com/api/chat) and [structured outputs](https://docs.ollama.com/capabilities/structured-outputs).
- [CLAP implementation](https://github.com/LAION-AI/CLAP) and [AudioMuse analysis pipeline](https://github.com/NeptuneHub/AudioMuse-AI/blob/main/docs/ALGORITHM.md).
- Existing Musimo contracts: [player](player.md), [search and indexing](search.md), [architecture](architecture.md) and [testing](testing.md).
