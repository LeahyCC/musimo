# V2 identity: recordings, files and availability

Status: proposal, not signed off. Part of [#179](https://github.com/LeahyCC/musimo/issues/179), phase 1: separating recording identity from file and provider availability, in small steps, with remixes, live and remastered versions kept apart. Nothing here is built. Questions for Colin are at the end and are not answered.

## What the issue already decides

Taken from #179 (goal, phase 1, phase 7, edge-case table and "Existing behavior to extend, not repeat"). This page does not reopen these.

- Existing `tr-` ids are not invalidated, and live, remix and remaster versions are not collapsed by title alone. Identity and availability contracts are added incrementally. No catalogue-wide migration was required for 1A, and identity migration was outside it.
- Recommendation, availability, playback and acquisition are separate concepts and actions. Discovery never downloads, buys or changes a queue by itself.
- Exact identity stays deterministic. The same intent, seed and snapshot give the same ordered ids.
- A title shared by several tracks, or a seed that is a remix or live version, is resolved with version and artist context. Real ambiguity gets a clarifying question, not a silent pick.
- Unknown artist tags must not collapse unrelated tracks into one artist or duplicate group.
- An external candidate that already exists locally resolves to its recording and version and shows its local availability. No duplicate acquisition is suggested.
- A provider with only a preview, no audio, or an outage is reported as such. A preview is not whole-track analysis. Local features work offline.
- Provider adapters (phase 7, package 7A) come after stable local identity and retrieval. Providers are chosen after local acceptance, and no existing integration is assumed to supply playback rights or audio evidence.

## Today

### What a song id is

- A library song is `tr-` plus 16 hex characters from `new_song_id()` in `backend/core/store.py`. It is random and names no recording. Account songs use `dz-` ids (`backend/jobs/account_listen.py`), and their facts live in `account_tracks`.
- The id is stored on `library_files`, whose primary key is the file `path`. The scan in `backend/library/index.py` writes a new id only for a new path, and keeps the existing id when the same path is seen again (`ON CONFLICT(path)`, `song_id=CASE WHEN library_files.song_id=''...`).
- So today a song id means "the file at this path". There is no separate record of the recording. `library_files` also holds `title_key`, `artist_key`, `duration`, `isrc` and `mbid`, but they are only columns on a file row.

### Who holds a song id

- Playlists, the queue, play counts (`listener_plays`), waveforms, audio profiles and jobs (`audio_profile`, `audio_job`) and `holdings` all key on the `tr-` id.
- `holdings` links a Deezer track (`catalog`, `track_id`) to a library `song_id` and `path`, with a reason of `catalog`, `bytes` or `chosen` (`backend/jobs/holdings.py`). A holding is only live while the file at that path is still in its root.
- `library_trash` (`backend/library/trash.py`) remembers the Deezer track ids a trashed file stood for, so a download is refused while the file is in the trash.
- The music bot stores ids in `bot_proposal_revisions.song_ids`, in each stored snapshot and check list, in `bot_receipts` (`ids`), and in `bot_memory` (shown songs). `backend/library/engine_contract.py` types them as `SongId`, the pattern `^tr-[0-9a-f]{16}$`.

### How files are matched to wanted tracks

- Library to Deezer, in `index.py`: a wanted track is matched by a recorded download, then ISRC, then MusicBrainz id, then normalised tags (artist, title, duration). The order is the `priority` value in the SQL. The result is a `song_id` for that file.
- Downloader to a source result, in `backend/jobs/matching.py`: a title and artist similarity plus a duration score. A result with a version word the wanted title lacks (`VERSION_WORDS`: live, cover, remix, extended, acoustic, instrumental, and others) loses 0.3 and is flagged `version_mismatch`. A wanted version missing from the result is `version_missing`. These are per-source scores for picking a download, not a stored identity.
- Library search in `backend/library/music_bot.py`: the same normalised (title, artist) pair, when the request allows it, is kept once ("the duplicate-title rule"). It is a search rule, not a link between files.

### What the engine records

- `backend/library/engine.py` builds a snapshot per request: contract and engine version, a catalogue digest over each song's `song_id`, size, mtime, title, artist, genre, year and duration, a play-history digest, likes, audio recipe state, roots, the memory revision and the shown list. The same intent and snapshot give the same ids.
- A proposal (`backend/library/proposals.py`) stores the ordered `song_ids`, the snapshot and per-song checks. A commit writes a receipt with the same ids.
- Nothing in the snapshot says which recording a song is. It says which file rows existed.

### What breaks

| Event                  | Result today                                                                                                                                                                                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File moved or renamed  | New path, so a new `tr-` id. The old row is swept at the end of the scan and `drop_song_references` deletes it from playlists, queue, plays, waveforms, profiles and holdings. The new id has no history. Proposals, receipts and bot memory keep the old id, now unknown. |
| File re-tagged         | Same path, same id. Title and artist change under it, so the catalogue digest changes and a stored proposal no longer replays unchanged. The song's meaning has moved without the id noticing.                                                                             |
| File replaced in place | Same path, same id, new audio. Profiles are guarded by size and mtime, but a playlist silently points at a different recording.                                                                                                                                            |
| File trashed           | Row dropped on the next scan and references deleted as for a move. `library_trash` keeps Deezer track ids only, not the `tr-` id.                                                                                                                                          |
| Second copy            | A second row with its own id: same recording, different id. Plays and playlists split. Only the search duplicate rule hides it, and only when title and artist normalise equal.                                                                                            |
| Deezer track vs file   | Linked by `holdings` rows, one per Deezer track, to one file. A second file for the track is not represented.                                                                                                                                                              |

`drop_song_references` does not touch bot proposals, receipts or memory. Those stay readable and keep naming ids that may no longer exist.

## The problem

One recording legitimately has several files and sources: a FLAC and an MP3, a copy on two disks, a re-rip, a Deezer track, a YouTube upload. Treating each as a separate song splits plays, playlists and recommendations. Treating them all as one by title alone is worse, because these are different recordings that share a title:

- remix, live, acoustic, instrumental and extended versions (the downloader already refuses these by word);
- remastered releases, where the sound and sometimes the length differ;
- radio edit against album version, the same song at different lengths;
- covers, karaoke and sped-up edits, which share title and artist words with the original.

A merge by title is hard to undo, and the music bot would then offer or de-duplicate the wrong version. Splitting wrongly is the safer failure: a user sees two entries and can link them. So links must be evidence-based and reversible.

## Proposed contract

### Recording, file and availability are three things

- **Recording:** an identity with its own opaque id, such as `rc-` plus 16 hex. It carries the descriptive facts (title, artist, version label, duration range) and the identifiers known for it (ISRC, MusicBrainz recording id, Deezer track id).
- **File:** what `library_files` is now. It has a path, size, mtime, tags and a `song_id`. It stays as it is.
- **Availability:** a row per place the recording can be had, with a kind (below), a provider and a state.

The existing `tr-` id stays the id of the playable file entry. A new table maps `tr-` ids to a recording. This is additive: no existing column or key changes.

### Availability kinds

- `local_file`: a file in an enabled root, in the library now. Playable by Musimo.
- `externally_playable`: playable through an account or provider (for example a `dz-` song through the Deezer account) but not a file Musimo holds.
- `recommendation_only`: known by name and identifiers, with no way for Musimo to play or fetch it. Shown as a suggestion, never queued or committed.

A proposal or a queue may only contain `local_file` and `externally_playable` items. `recommendation_only` items are never selected as ids by the engine. Later external discovery fills this kind without changing the file model.

Acquisition is not an availability kind. It is a separate action that is never implied by a recommendation or by playability. A recording that has a `local_file` is never offered for acquisition. An availability row also says what evidence exists: a preview-only or metadata-only source has no audio evidence for analysis, and missing evidence is unknown, never a negative label. Losing a provider changes only that source's rows. Local files stay usable.

### What may link files to one recording

Strong, may link on their own:

- the same ISRC on both sides, when no version word differs and durations are within a few seconds;
- the same MusicBrainz recording id;
- an existing `holdings` row (Deezer track to file), which is already a recorded decision;
- a user's explicit "same song" or "not the same song" choice, which outranks all automatic signals.

Supporting, link only when combined and with no conflict:

- normalised artist and title, plus duration within a tight tolerance, plus no differing version words;
- identical audio bytes (hash) for a second copy.

Never enough alone:

- title alone, or artist and title alone;
- an empty or unknown artist or title key (untitled or untagged files never group, as the existing duplicate rule already treats them);
- album name, folder name or file name;
- a Deezer or ISRC match when version words or duration disagree (an ISRC is reused across some re-releases).

Any difference in version words (live, remix, remaster, radio edit, extended, acoustic, instrumental) keeps files on separate recordings unless a user links them. Duration far outside tolerance does the same.

When a request names a title that belongs to several recordings (or its seed is a remix or live version), the engine resolves it with artist and version context. If that still leaves more than one, it asks which one rather than picking. Exact identity lookups stay deterministic: with no recording rows they behave as today.

### Confidence and provenance

Each link records: the file or source, the recording, the signal that made it (`isrc`, `mbid`, `holding`, `tags_duration`, `bytes`, `user`), a confidence of `certain`, `likely` or `weak`, a timestamp, and the version of the rules that made it. Only `certain` and `user` links merge behaviour (shared plays, duplicate hiding). `likely` links are shown as a suggestion to confirm. `weak` links are not stored as links. A user "not the same" is a block that no later automatic run may override.

## Migration

- Existing `tr-` ids keep working and are never rewritten or invalidated. Nothing in this plan changes the `tr-` pattern, `library_files.song_id` or how ids are minted.
- Stored proposals, receipts and shown memory (kept per name since #230) stay as they are. Their ids resolve through the file as before. A song deleted to the trash already makes an open proposal stale at commit (#263, #264), and that stays the rule. A song with no recording row behaves exactly as today.
- No catalogue-wide pass is needed first. A recording row is created lazily, the first time something needs one (a link, a duplicate check, an external item).

Steps, each separately shippable:

1. **Tables only.** Add `recordings`, `recording_files` (maps `tr-` id to a recording) and `availability`, empty. Acceptance: a fresh database and an upgraded one both open; a library with no new rows behaves identically; the existing store and engine tests pass unchanged.
2. **Read-only grouping report.** A script lists candidate groups from the strong and supporting signals and the blocking version rules, writing nothing. Acceptance: tests with fixtures where a remix, a live version, a remaster and a radio edit each stay apart from the original; a second copy with the same ISRC groups; the report is identical across two runs.
3. **Record links, no behaviour.** Store links with confidence and provenance for `certain` signals only. Acceptance: a link can be removed and re-made; a "not the same" block survives a rescan; no playlist, queue or snapshot output changes.
4. **Survive a move.** When a vanished `tr-` id and a new file share a recording by a `certain` signal, carry plays, playlist places and holdings over, instead of dropping them. Acceptance: move and rename a file and its plays and playlist entry follow; a re-tag does not break the link; a real deletion still drops references.
5. **Duplicates in the engine.** The duplicate rule reads recording ids where present and falls back to title and artist. Acceptance: two copies of one recording appear once in a proposal; a remix and an original both appear; with no recording rows the output is byte-identical to today.
6. **Availability kinds.** Populate `local_file` from files and `externally_playable` from the existing account songs only. Acceptance: a `dz-` song shows as externally playable; a recommendation-only item is refused as a proposal id; a Deezer track held locally reports `local_file` and no acquisition offer; with the account offline, local results are unchanged. New provider adapters are 7A, after this, and have their own contract tests for duplicates, versions, unavailable tracks, rate limits and outages.

## Effect on the engine contract

- Steps 1 to 4 do not change the intent, the result or the receipt, so `CONTRACT_VERSION` stays 5 and `SUPPORTED_VERSIONS` is unchanged.
- Step 5 changes which songs are chosen, so it bumps `ENGINE_VERSION` (6), as an earlier selection change did. A replay of an old intent that names an older engine version is not claimed to match.
- A recording id in results or a proposal's items would be a visible shape change, so it would be a contract version 6, added only when a client needs it. `SongId` (today `tr-` only) is unchanged until then. Whether a recording id may appear as an id is open question 3.
- The snapshot gains one digest: recordings and links, over the rows the selection read. With no rows, the digest is constant and the snapshot differs only by that field, so snapshot ids change once at the step that adds it. Stored snapshots stay readable, and an old one that lacks the field is compared on the fields it has.
- Reproducibility: the same intent, library, links and seed give the same ids, and the snapshot records enough (rule version, link digest) to explain a difference instead of claiming the seed alone replays. A new link or a removed one changes the digest, like a re-tag does now. Link rule versions are recorded so a changed rule is visible.
- Duplicates: a proposal holds at most one song per recording, chosen by a fixed preference (stated in open question 5). The other file is not removed, only not offered twice. A proposal already stored keeps its ids and is not re-deduplicated.

## Open questions for Colin

1. Should a recording id be a new `rc-` id, or should a recording be named by its best external identifier (ISRC or MusicBrainz id) where there is one?
2. Should a stored `likely` link ever change behaviour without the user confirming it, for example hiding a second copy, or is user confirmation always required?
3. Should clients ever see a recording id (contract version 6), or should the `tr-` file id remain the only id the engine and the player expose?
4. When a file moves and a `certain` signal finds its twin, should plays and playlist places be carried over automatically, or asked about first?
5. When a recording has several playable copies, which does a proposal offer: the best quality, the newest, a local file before an account song, or the user's choice?
6. Is a remaster the same recording as the original (shared plays), or a different one that is only suggested as related?
7. Is a radio edit, or any cut of the same performance at another length, a separate recording?
8. May the music bot ever offer a `recommendation_only` item as text, and under what wording, or should it stay out of replies until external discovery is built?
9. Should "same song" and "not the same song" be a UI action, a settings screen or a command to the bot?
10. Is a byte-identical second copy always the same recording with no confirmation?
