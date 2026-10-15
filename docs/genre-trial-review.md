# Independent review of the genre trial

14 October 2026. A second look at the [genre trial](genre-analysis-trial.md) and [label review](genre-label-review.md), done read-only. No model was rerun, no evidence file was rewritten, no production data was touched.

## Verdict

The reported numbers are real, but they do not show what the reports imply. EffNet and the existing tags are tied. CLAP should be dropped for genre. The biggest genre problem in Musimo today is not audio at all: the music bot matches genre words as exact strings, so "hip hop" finds nothing.

## What was checked and holds up

- Frozen manifest, Colin's answer file and all 26 sealed held-out prediction files match their recorded SHA-256 values.
- An independent recount (separate script, not `evaluate.py`) reproduces every exact-set figure: tags 6/15 and 7/13, EffNet 9/15 and 5/13, CLAP 2/15 and 2/13.
- EffNet is wired correctly. The model's own metadata confirms `PartitionedCall:0` is the 400-style sigmoid output, input is 16 kHz mono, and the Essentia call matches the documented parameters. The FFmpeg decode gives mono float32 at the requested rate.
- Development and held-out artists and titles are disjoint.

## Problems found

**1. The held-out split is not the only fair test.** The short recipe was frozen before any prediction and nothing was tuned on development results. So the 15 development tracks are an equally fair test of the frozen recipe. Pooled over all 28:

|        | Exact set | Top label is one of Colin's |
| ------ | --------: | --------------------------: |
| Tags   |     13/28 |             17/28 (any tag) |
| EffNet |     14/28 |                       19/28 |
| CLAP   |      4/28 |                        weak |

"Tags beat EffNet on held-out" rests on 3 tracks against 1. That is noise. The honest reading is a tie, with both well short of Colin.

**2. The scoring favours whoever guesses the right number of labels.** Six of Colin's 28 answers have two or three genres. The frozen rule almost always gives EffNet one label. Tags often carry two or three. Exact-set matching then measures label count as much as genre.

**3. The sample does not look like the library.** One track per tag category gives Latin, blues and classical the same weight as electronic, which has about 17,000 tracks. Only two untagged tracks were included, yet untagged music is exactly where audio could help.

**4. Several "errors" are taxonomy arguments, not mistakes.** Latin and folk/country/world describe a region or culture, the others describe a sound. A Latin trap song is fairly hip-hop and pop (G11). Piano music tagged pop was heard as classical by Colin and electronic by EffNet (G19). Nobody is clearly wrong there.

**5. The labels are quick impressions.** All 28 were saved in 11 minutes, a median of 20 seconds apart, mostly from the middle ten seconds. That is fine for broad genre, but it is one listener, one pass, one section. Tags describe whole albums.

**6. The worker throws away the 400 style scores.** Only the 13 broad maxima are saved. The style-to-genre mapping cannot be re-examined (for example, what made G19 "electronic") without running inference again.

**7. CLAP's recipe could never work well.** Its scores sit in a narrow 0.45 to 0.60 band with a steady lean towards pop and Latin, so the 0.20 floor never triggers on music, and the 0.02 margin is mostly noise. It has no music-versus-speech check, which is why both podcasts got music genres. A music-trained checkpoint exists ([laion/larger_clap_music](https://huggingface.co/laion/larger_clap_music), Apache-2.0) but publishes no genre results, and published zero-shot CLAP genre accuracy is around 47% on GTZAN ([TP-CLAP, 2026](https://arxiv.org/pdf/2607.25085)). Not worth another trial for genre.

**8. The tag baseline mapping is incomplete.** The library has only 63 distinct genre words. The trial's alias table misses Grime, Drum and Bass, Dancehall, Reggaeton, Soul, Gospel, Opera, East Coast, Contemporary R&B, Indie Rock/Rock Pop and Chill Out/Trip-Hop/Lounge. It did not change these 28 results, but it would matter library-wide.

## The bigger finding: genre search already leaks

`MusicBot._matches` ([music_bot.py:329](../backend/library/music_bot.py)) keeps a song only if a requested genre equals one of its raw tag words, ignoring case. The bot is never told the library's genre words. From the read-only catalogue snapshot:

```
user asks       bot matches tag word     finds      should find
"hip hop"       hip hop                  0          ~5,900  (Rap/Hip Hop, Hip-Hop)
"electronic"    Electronic               5,015      ~17,300 (Electro, Dance, Trance, House...)
```

This is from reading the code and the snapshot. It was not tried against the live bot.

## Where the real gap is

```
/library  44,070 tracks in the snapshot
  tagged with a mapped genre word ........ 84% (37,233)
  "Alternative" only ..... 3,332 tracks from 104 artists
  no genre at all ........ 2,935 tracks from 178 artists
  soundtrack, comedy, kids ...  ~330
```

The gap is concentrated in about 280 artists (Linkin Park, Aphex Twin, Sub Focus, Bring Me The Horizon and so on). Solving it per artist is far cheaper and steadier than per track. "Alternative" cannot simply mean rock: it covers Aphex Twin and Tove Lo.

## Recommendation

```
1. Normalise the 63 tag words to broad genres      no model, 84% of library
   keep raw tags, bot searches both
2. Fill the gap per artist (~280 artists)          Colin confirms a suggested genre
   optional: EffNet suggests, from a few tracks
3. Drop CLAP for genre
4. No whole-library audio genre scan               not justified by this evidence
```

Step 1 is a small product change, not an experiment. It needs Colin's go-ahead because it touches the uncommitted bot code and adds a stored mapping.

Update, same day: step 1 is done. See [genre mapping](genre-mapping.md).

## Optional bounded experiment: EffNet per artist, for the gap only

Only worth running if Colin wants suggestions rather than labelling 280 artists by hand.

- **Population:** artists whose tracks are untagged or "Alternative" only.
- **Before running:** Colin settles the broad list (for example, whether Latin and world stay). The 28 existing labels become development data for the vote rule. Fix the worker to save all 400 style scores.
- **Run:** up to 5 tracks per artist, 3 sections each, same 2 GB, one-CPU, no-swap container. About 1,400 tracks, roughly 35 minutes at the measured warm rate, likely more from a cold disk.
- **Fresh holdout:** 40 artists drawn at random from the gap, not stratified by tags. Colin marks each suggestion right, partly right or wrong. He can answer from the artist name, so this should take about ten minutes.
- **Pass:** at least 34/40 accepted, at most 8 abstentions, and it must beat the simple rule "Alternative means rock" on the Alternative artists.
- **If it fails:** Colin labels the gap artists directly, or they stay unlabelled.

Licence note: MTG models are CC BY-NC-SA 4.0 ([MTG models](https://essentia.upf.edu/models.html)). Personal, non-commercial use on Colin's own server fits that. Shipping the model with Musimo would need a decision. Discogs publishes its release genres and styles as CC0 monthly dumps ([Discogs data](https://data.discogs.com/)); that is a possible later source for artist genres, but matching and download size are unexplored.

## Other issue raised

[architecture.md](architecture.md) says "This application opens version 6" in the schema paragraph, while the bot section and `SCHEMA_VERSION` in `backend/core/store.py` say 8. Not fixed here.
