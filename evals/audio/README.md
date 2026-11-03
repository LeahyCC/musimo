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

The picker reads the live catalogue from the database, does not scan files,
and writes only to `runtime/label-4a/`:

```powershell
uv run python scripts/pick_label_4a.py --data-dir /data --seed label-4a-v1
```

It reports counts and any group that could not be filled. If a group is
short, do not pad it; note the shortfall in the PR.

## Labelling

Open `http://<musimo>/label-4a` on a phone or PC. The page is not linked from
the menu. It shows only a clip counter and the answer buttons; no title,
artist, tags, group or split is revealed. Each answer is saved to the server
immediately, so labelling can pause and resume on another device.

The manifest remains in `runtime/label-4a/manifest.json` and is not committed.

## Export

After labelling, export the manifest, dev and held-out labels, and the seal:

```powershell
uv run python scripts/export_label_4a.py --manifest runtime/label-4a/manifest.json --output evals/audio
```

The script prints dev and held-out counts only and never prints held-out
answers. It writes:

- `evals/audio/manifest.json`: clip id, song id, section start, group and
  split. No titles or artists.
- `evals/audio/dev.json`: answers for the development clips.
- `evals/audio/heldout.json`: answers for the held-out clips.
- `evals/audio/seal.json`: the SHA-256 of `heldout.json` and its case count.

## The seal rule

`seal.json` is the checksum of the parsed `heldout.json`. Any change to a case
or label breaks the seal. Do not open the held-out answers until every frozen
candidate has run once, just like the interpreter suite in
`evals/interpreter/README.md`.
