# 4A blind audio label set

This directory holds the labelled development and held-out data for package 4A
(audio evidence). The labels are Colin's blind judgements of short clip
sections, used to compare the tag/MFCC baseline against frozen audio
candidates.

Nothing in this directory is committed until Colin has finished labelling and
the export script has run. The committed files are this README, the export
script and its tests.

## What is being labelled

For each clip Colin hears a 30-second section and answers:

- **Vocals**: none, a bit, yes, or unknown.
- **Intensity**: calm, medium, intense, or unknown. This is perceived
  intensity, not mastering loudness.
- **Speech**: music, speech, both, or unknown.
- **Drum and bass**: no, yes, or unknown. If yes, whether it sounds like
  liquid drum and bass or other dnb.

Every answer can be "unknown".

## Building the set

Musimo runs in Docker on pancakes, and the image does not ship these scripts. So the picker
runs on a read-only copy of the database, and the manifest is copied into the data volume,
where it survives a rebuild. The answers are saved in the database beside it.

The library has no liquid tag and only a dozen drum and bass tags, so Colin lists the
artists in a JSON file kept out of the repo:

```json
{ "liquid": ["Artist A", "Artist B"], "other_dnb": ["Artist C"] }
```

```bash
# 1. Copy the live database without writing to it.
docker exec musimo-musimo-1 python -c "import sqlite3; s=sqlite3.connect('file:/data/musimo.sqlite3?mode=ro', uri=True); d=sqlite3.connect('/tmp/copy.sqlite3'); s.backup(d)"
docker cp musimo-musimo-1:/tmp/copy.sqlite3 <copy dir>/musimo.sqlite3
# 2. Pick. It opens the copy read-only and writes <copy dir>/label-4a/manifest.json.
.venv/Scripts/python.exe -m scripts.pick_label_4a --data-dir <copy dir> --artists <artists.json> --seed label-4a-v1
# 3. Put the manifest where the app reads it.
docker exec musimo-musimo-1 mkdir -p /data/label-4a
docker cp <copy dir>/label-4a/manifest.json musimo-musimo-1:/data/label-4a/manifest.json
```

The picker reports counts and any group it could not fill. Do not pad a short group. Up to
three songs per artist are allowed in the drum and bass and speech groups, which have few
artists, and an artist's songs always stay in one split.

## Labelling

Open `http://<musimo>/label-4a` on a phone or PC. The page is not linked from the menu. It
shows a clip counter and the answer buttons, never a title, artist, tag, group or split.
Middle plays the manifest start (the opening, for the long-intro group). Early and Late play
from 10% and 75% of the way through. Each answer saves to the server straight away, with
the sections actually played, and the page reopens at the first unanswered clip.

## Export

After labelling, copy the database out again (step 1), then:

```bash
.venv/Scripts/python.exe -m scripts.export_label_4a --data-dir <copy dir> --output evals/audio
```

It prints dev and held-out counts only and never prints held-out answers. It writes:

- `evals/audio/manifest.json`: clip id, song id, section start, group and split. No titles
  or artists.
- `evals/audio/dev.json`: answers for the development clips.
- `evals/audio/heldout.json`: answers for the held-out clips.
- `evals/audio/seal.json`: the SHA-256 of `heldout.json` and its case count.

## The seal rule

`seal.json` is the checksum of the parsed `heldout.json`. Any change to a case
or label breaks the seal. Do not open the held-out answers until every frozen
candidate has run once, just like the interpreter suite in
`evals/interpreter/README.md`.
