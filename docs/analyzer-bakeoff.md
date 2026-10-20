# Analyser bake-off: tempo and genre

19 to 20 October 2026. A measurement, not a build. Nothing is activated, no production code changed, the live app and its volume were not touched. The harness is in `experiments/analyzer-bakeoff/`. Models, the sample and raw outputs stay in `runtime/analyzer-bakeoff/`, which git ignores.

## Answer first

```
job                     use                                   confidence rule
tempo                   Beat This!, steady-gap BPM            keep the BPM only when at least 2 of the
                        (not librosa, not median gap)         10 s sections gave one and their median
                                                              agrees with the 60 s window within 2 BPM
genre: check the tags   Essentia discogs-effnet, flag only    flag when the top parent genre scores >= 0.3
                                                              and the tag's genre is not in the model's top 3
genre: the genre itself keep the file tags                    the model never overwrites a tag
```

- **Tempo can drop most of the listening.** Beat This! matches Deezer within 2 BPM on 63 of 84 songs, against librosa's 43. Songs that pass the rule above matched Deezer 67 of 68 times up to half/double. One listen stays: half-time songs (below).
- **Genre: the check can replace a full listen, the tags stay.** The model agrees with the tag's broad genre (in its top 3) on 267 of 279 songs. The 7 it flags are a short review list. It cannot judge speech clips, and Colin's own labels on 14 October had it tied with the tags ([genre label review](genre-label-review.md)).
- **Licence:** Beat This! is MIT, code and weights, and can ship. Essentia's models are non-commercial and the Essentia library is AGPL. Fine on Colin's own server, not something Musimo's MIT release can bundle.

## Tempo

Same 100 songs as the `tempo-energy-v1` run. 99 are music; the podcast is left out of every count. "Steady gap" is explained under [Method](#method).

### Does the clustering go away?

| Analyser and window         | Distinct values (99 songs) | Most common value |
| --------------------------- | -------------------------: | ----------------- |
| librosa, 3 x 10 s (v1)      |                         12 | 143.6, 54%        |
| librosa, 60 s               |                         13 | 143.6, 56%        |
| Beat This!, median gap, 10s |                         20 | 142.9, 49%        |
| Beat This!, median gap, 60s |                         20 | 142.9, 52%        |
| Beat This!, steady gap, 10s |                         66 | 144.9, 7%         |
| Beat This!, steady gap, 60s |                         64 | 145.0, 9%         |

Only the steady-gap reading clears it. The 53 songs librosa puts at 143.6 spread out under Beat This!, 49 of them between 140 and 148, so 138 and 145 now look different.

### Against Deezer

Deezer's public API by ISRC gave a BPM for **23 of the 100** (75 gave 0, 2 have no ISRC). To get more reference points both tempo analysers also ran on the **61 other sample songs that have a Deezer BPM**, so 84 in all. Deezer's BPM is its own estimate, not the truth.

| 84 songs with a Deezer BPM | Same (±2) | Reads half | Reads double | Other | Typical gap when same |
| -------------------------- | --------: | ---------: | -----------: | ----: | --------------------: |
| librosa, 3 x 10 s (v1)     |        40 |          1 |            1 |    42 |               1.1 BPM |
| librosa, 60 s              |        43 |          1 |            1 |    39 |               1.0 BPM |
| Beat This!, median gap 60s |        38 |         10 |            0 |    36 |               0.8 BPM |
| Beat This!, steady 10 s    |        58 |         12 |            2 |    12 |               0.2 BPM |
| Beat This!, steady 60 s    |    **63** |         11 |            1 |     9 |           **0.1 BPM** |

On the original 23 only: librosa 15, Beat This! steady 22 (10 s) and 21 (60 s). librosa scores as well as it does partly because Deezer's 142 to 145 all land within 2 of 143.6.

Beat This! against librosa on the 99: same 56, Beat This! reads half 3, double 1, other 39. Most of the "other" is librosa's grid.

### The confidence rule, tested

```
160 songs analysed by Beat This!
  sure: 2+ sections, median agrees with 60 s (±2)   135  ->  vs Deezer: 56 same, 11 half/double, 1 other
  unsure: everything else                            25  ->  vs Deezer:  7 same,  1 half,        8 other
```

On the core 99, 87 are sure. An unsure song gets no BPM, and the bot reports it as not covered. `score.py` writes these counts as `confidence_rule`.

## Genre and style

300 songs: the 100 plus 200 drawn with seed `musimo-bakeoff-20261019`, so every one of the 14 biggest tags has at least 18. The draw is a blake2b hash of the seed and the song id, so `chain.ps1 -Steps sample` gives the same ids again from the same DB copy. 279 have a tag that maps to a broad genre (Alternative has none, by Colin's 14 October decision; 2 are untagged).

### Mapping table

Discogs parent genre (the part before `---`) to Musimo's broad genres in [genre mapping](genre-mapping.md), and the tags in the sample.

| Discogs parent                                        | Musimo broad genre    | File tags in the sample                     |
| ----------------------------------------------------- | --------------------- | ------------------------------------------- |
| Electronic                                            | electronic            | Electronic, Electro, Dance, Trance, Dubstep |
| Rock                                                  | rock/metal            | Rock, Metal                                 |
| Hip Hop                                               | hip-hop               | Rap/Hip Hop, Hip-Hop                        |
| Pop                                                   | pop                   | Pop                                         |
| Funk / Soul                                           | soul/R&B              | R&B                                         |
| Folk, World, & Country                                | folk/country or world | African Music                               |
| Non-Music                                             | spoken                | Podcast                                     |
| Reggae, Jazz, Latin, Blues, Classical, Stage & Screen | same names            | none in the sample                          |
| (none)                                                | (none)                | Alternative                                 |

The tags go through Musimo's own `tag_profile` (`backend/library/genres.py`), over both the genre column and the genres list, so the bake-off maps tags exactly as the app does. A song agrees if any of its broad genres agrees. A parent genre's score is its best style's score.

### Agreement

| File tag         |   n | Top 1 | Top 3 |
| ---------------- | --: | ----: | ----: |
| Dance            |  53 |    52 |    53 |
| Rap/Hip Hop      |  19 |    19 |    19 |
| Electro; Dance   |  19 |    19 |    19 |
| Electro          |  19 |    18 |    19 |
| Electronic       |  19 |    17 |    19 |
| Trance           |  19 |    17 |    19 |
| Rock             |  19 |    15 |    19 |
| Hip-Hop          |  19 |    15 |    17 |
| Dance; Trance    |  18 |    18 |    18 |
| Metal            |  18 |    16 |    18 |
| Electro; Dubstep |  18 |    16 |    18 |
| Pop              |  19 |     7 |    14 |
| R&B              |  18 |     5 |    14 |
| African Music    |   1 |     0 |     0 |
| Podcast          |   1 |     0 |     1 |
| **All**          | 279 |   234 |   267 |

Style level, where the tag names a style: Trance 26 of 37 (24 of 29 without the 8 radio clips below), Metal 16 of 18, Dubstep 14 of 18 (the rest are Grime, Bassline, Electro House, Trap).

Alternative (19 songs, not scored): the model's top genre is Rock 8, Electronic 5, Pop 3, Hip Hop 2, Folk/World 1.

### Threshold and mixes

| Threshold | Songs with a style (of 279) | Styles per song | Kept styles under the tag's genre |
| --------: | --------------------------: | --------------: | --------------------------------: |
|      0.05 |                         279 |             4.8 |                               80% |
|      0.10 |                         271 |             3.6 |                               83% |
|  **0.15** |                     **255** |         **2.5** |                           **85%** |
|      0.20 |                         234 |             1.8 |                               87% |
|      0.30 |                         189 |             1.1 |                               90% |

**0.15**: below it the extra styles are mostly noise, above it songs lose their only style fast (66 more have none at 0.3). Top 5 styles are kept only if they reach it.

At 0.15, counting only the kept top 5, of all 300: 30 have no style, 56 have one, **214 have 2 or more**, but most of those are siblings (Trance with Progressive Trance). **38 span 2 or more parent genres**, which is the real "mix" count (Trap with Reggaeton, Contemporary R&B with RnB/Swing, Industrial with Deathcore).

### The 10 biggest disagreements

For Colin to judge: is the tag wrong or the model? The first 7 are the ones the flag rule catches.

| Artist - title                              | Tag           | Model's top styles                                   |
| ------------------------------------------- | ------------- | ---------------------------------------------------- |
| Afroman - Mississippi                       | Pop           | Gangsta 0.78, G-Funk 0.40, Screw 0.27                |
| Alicia Keys - Diary (Hani Mixshow)          | R&B           | House 0.60, Deep House 0.16, Tribal House 0.14       |
| Crazy Town - Hurt You So Bad                | Pop           | Alternative Rock 0.55, Grunge 0.31, Nu Metal 0.30    |
| The Weeknd - Till Dawn (Here Comes The Sun) | R&B           | Tropical House 0.44, Deep House 0.24, Downtempo 0.21 |
| DJ Goja - Mi Chico (BL3SS Remix)            | African Music | House 0.35, Euro House 0.28, Trance 0.22             |
| Aktive - You're Perfect (Instrumental)      | Pop           | Trap 0.34, Grime 0.16, Cloud Rap 0.13                |
| The Weeknd - Often                          | R&B           | Trap 0.31, K-pop 0.17, Reggaeton 0.17                |
| The Weeknd - Best Friends                   | R&B           | Reggaeton 0.30, Tropical House 0.18, Dance-pop 0.15  |
| XXYYXX - Closer                             | Pop           | Trap 0.21, Cloud Rap 0.14, Downtempo 0.12            |
| Ellie Goulding - Intro (Delirium)           | Pop           | Ambient 0.21, Experimental 0.12, Downtempo 0.08      |

My read: Afroman and Crazy Town look like wrong tags. The Alicia Keys file is a house "mixshow" remix, so the model may be right. DJ Goja is both (the tag names a place, the model a sound). The rest are arguable.

## What each one gets wrong

- **librosa (`tempo-energy-v1`)**: its tempo can only be 60 x 22050 / 512 / n for a whole number n. So 136.0 (n = 19) and 143.6 (n = 18) with nothing between. A longer window does not help (13 values). It is fast and light.
- **Beat This!**: about 1 in 8 songs come out at **half time**, mostly slow vocal songs (Ellie Goulding, Linkin Park, Yuna, Anderson .Paak). That moves a song from "fast" to "slow". Live tracks with talking go wrong (The Doors, Slipknot live). It reads a tempo from speech too (the podcast got 79 to 120), so the podcast skip stays. Its beats sit on a 20 ms grid, which is why "median gap" is coarse. About 20 times slower than librosa.
- **Essentia**: Pop and R&B do not match Discogs' taxonomy (Discogs files a lot of pop under Electronic, Dance-pop and Synth-pop, and R&B under Hip Hop RnB/Swing or House). **It calls speech over a beat music**: the 8 A State of Trance clips in the sample (30 to 50 s shout-outs and interviews, tagged Trance) came out Trap, House and Hands Up, with every Non-Music style under 0.03. The podcast was Trap 0.184 over Spoken Word 0.178. Scores are not probabilities.
- **Deezer**: no BPM for 72% of the sample, and for 77 of the tempo 100.

## Resources

All under 2 GB with no swap (kernel `memory.swap.max` 0), 1 CPU (`cpu.max 100000 100000`), read-only root, music and models, UID 1000, no network, own compose project. "Container peak" is the cgroup high-water mark, which includes file cache, so it moves between runs: the same Essentia code peaked at 697 MB once and 1,221 MB the next time, with the process itself at 766 MB both times. Tempo times cover all four windows (90 s of audio). Essentia skips the middle section, which sits inside the 60 s window (80 s of audio). Decoding is included.

|                           |               librosa v1 | Beat This! final0 | Beat This! small0 |              Essentia effnet |
| ------------------------- | -----------------------: | ----------------: | ----------------: | ---------------------------: |
| Model download            |                     none |           81.1 MB |            8.5 MB |                18.4 + 2.1 MB |
| Biggest Python download   |                        - |    torch 178.6 MB |    torch 178.6 MB | essentia-tensorflow 291.9 MB |
| Image on disk             |                   1.5 GB |           2.03 GB |           2.03 GB |                      1.84 GB |
| Model load                |              9.8 s (JIT) |             1.3 s |             0.7 s |                        1.9 s |
| Per song, median / p95    | 0.26 / 0.28 s (sections) |       5.6 / 5.9 s |       3.2 / 3.4 s |                  3.3 / 3.4 s |
| Container peak            |                   813 MB |            745 MB |            509 MB |                     1,221 MB |
| Process peak              |                   422 MB |            851 MB |            641 MB |                       766 MB |
| 50,510 files at this rate |                     ~4 h |             ~79 h |             ~45 h |                        ~46 h |

small0 is as good as final0 on the 23 Deezer songs (21 of 23 within 2 BPM, both windows) and 40% faster. It was not run on the extra 61.

## Licences

| Piece                                                  | Terms                                                            | Source                                                                                                                        |
| ------------------------------------------------------ | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Beat This! code                                        | MIT                                                              | [LICENSE](https://github.com/CPJKU/beat_this/blob/main/LICENSE)                                                               |
| Beat This! weights (final0, small0)                    | MIT, per the README; it warns some training audio is copyrighted | [README, License](https://github.com/CPJKU/beat_this#license), [weights](https://cloud.cp.jku.at/index.php/s/7ik4RrBKTS273gp) |
| torch, torchaudio, einops, rotary-embedding-torch      | permissive (BSD, Apache, MIT)                                    | PyPI metadata                                                                                                                 |
| soxr (Beat This! resampler)                            | LGPL-2.1-or-later                                                | PyPI metadata                                                                                                                 |
| Essentia MTG models (discogs-effnet, genre_discogs400) | CC BY-NC-SA 4.0, commercial licence on request                   | [models page](https://essentia.upf.edu/models.html), [LICENSE](https://essentia.upf.edu/models/LICENSE)                       |
| Essentia library                                       | AGPL-3.0                                                         | [COPYING](https://github.com/MTG/essentia/blob/master/COPYING.txt)                                                            |

Two oddities: the models' LICENSE file is titled "Attribution-NonCommercial-NoDerivatives" but links the BY-NC-SA licence, and neither model's JSON metadata has a licence field. [audio-profile-spec.md](audio-profile-spec.md#licences) lists Essentia and its models as "Out", so using it at all is a change to that decision.

## Method

- Windows: the three 10 s sections of `tempo-energy-v1` (10, 50, 90% of duration - 10) and 60 s centred on the middle. FFmpeg decoding copies the worker's rules.
- librosa: the worker's own `recipe.analyse`, run offline in `musimo-audio-worker:0.4.0`. It reproduced the stored rows 99 of 99.
- Beat This! 1.1.0, CPU, no DBN, one thread. BPM per window two ways: **median gap** (60 / median time between beats, as asked) and **steady gap** (60 / mean of the gaps within 12% of the median). The authors publish no tempo method. Song BPM from sections is the median of the three, like v1.
- Essentia 2.1b6.dev1438, `discogs-effnet-bs64-1` embeddings into `genre_discogs400-discogs-effnet-1`. Style score is the mean over every 2 s patch of the 60 s window and the sections outside it, so no audio counts twice. All 400 scores are saved per song and per window. A first run that also counted the middle section was replaced; it moved top 3 agreement by one song.
- Agreement classes: same within 2 BPM; half or double within 2 BPM of half or double the reference.

To rerun, check the music drive letter first, then from the repository root:

```powershell
$env:BAKEOFF_MUSIC = 'M:/Media/Music'
powershell -File experiments/analyzer-bakeoff/harness/chain.ps1
```

`chain.ps1` exports the sample from the trial stack's DB copy (and stops it again), queries Deezer, builds both images, runs the six jobs one at a time and writes `runtime/analyzer-bakeoff/results.json`. `-Steps` picks a subset. The models are downloaded by hand into `runtime/analyzer-bakeoff/models/` and checked against these SHA-256s:

| File                                          | SHA-256                                                            |
| --------------------------------------------- | ------------------------------------------------------------------ |
| beat_this/final0.ckpt                         | `8c328b45f59d8dd3dff219253ff6a8d6482be57d0133a29140e2febbf8eb8331` |
| beat_this/small0.ckpt                         | `6074be2c4d490c5f6101fcc374a1ec72ae93456e23bb6019783b849f5dc7d47b` |
| essentia/discogs-effnet-bs64-1.pb             | `3ed9af50d5367c0b9c795b294b00e7599e4943244f4cbd376869f3bfc87721b1` |
| essentia/genre_discogs400-discogs-effnet-1.pb | `3885ba078a35249af94b8e5e4247689afac40deca4401a4bc888daf5a579c01c` |

Package versions are pinned in the two Dockerfiles.

## Not covered

- Energy. RMS is still not validated as "intensity".
- Beat This! with its DBN, a 60 s-only timing, and small0 on the extra 61 songs.
- How stable a song's styles are across its windows (the per-window scores are saved).
- The library has **781 A State of Trance voice clips**, all under 90 s and tagged Trance, and 1,711 files under 60 s. Neither tags nor these models handle them. They need their own rule.
