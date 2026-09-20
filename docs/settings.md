# Settings reference

Settings are validated and stored in SQLite. Edit the form, then use Save changes. Successful saves apply without a restart and publish a durable event. They survive container recreation when the data volume remains attached.

The sticky save bar appears only when there is something to say: while there are unsaved changes ("You have unsaved changes." with an enabled Save changes button), after a failed save (the error, with the draft kept), and for six seconds after a successful save ("Saved. You can safely refresh."). With nothing changed there is no bar and no idle Save button. The bar carries the `.save-bar` hook that `e2e/phone.spec.ts` measures against the bottom bar.

A status summary at the top of the Settings page shows overall system readiness (ready or needs attention) with a link to Diagnostics for detailed component status. The Diagnostics "Ready to download?" strip reads the same answer. Both call `systemIsReady` in `frontend/src/readiness.ts`, so they cannot disagree. The system is ready when every library root is mounted, writable and reporting free space, the library scan is `idle`, `scanning` or `done` (a finished scan is healthy, only a failed, cancelled or interrupted one is not), Navidrome is reachable whenever the server reports it at all, the YouTube helper is healthy, and the last download did not fail. `readiness.test.ts` covers each rule.

## Editable settings

- `library_label`: Music by default, 1–60 characters.
- `output_format`: original, m4a, opus or mp3. Default original. M4A/Opus conversion depends on the actual source; the application must not promise lossless transcoding.
- `concurrency`: 1–3, default 2. Parallel download workers. Concurrency can also be changed from the Downloads page Parallel select and honours the lock.
- `max_attempts`: 1–4, default 4, including the first attempt. One disables automatic retries. Four allows up to three retries.
- `retry_base_seconds`: 1–30, default 2.
- `retry_cap_seconds`: 30–300, default 60.

Set `MUSIMO_` plus the uppercase key in the container environment to seed and lock a value on first creation, for example `MUSIMO_CONCURRENCY=3`. An on or off setting takes `1`, `true`, `yes` or `on` for on and anything else for off (`MUSIMO_SOUNDCLOUD_FALLBACK=1`). Later env changes do not replace an existing row. Its original env name remains visible in the UI and API, and PATCH returns 409 for a locked setting. Removing the variable does not unlock the database record. There is no unlock UI yet.

Deployment variables are separate: `MUSIMO_BIND`, `MUSIMO_PORT`, `PUID` and `PGID` control Compose. `MUSIMO_LIBRARY_ROOTS` lists the mounted Linux paths the scanner reads. `MUSIMO_WATCH_MODE` is `native` by default; use `poll` for external-change checks on Docker Desktop Windows or network shares. `MUSIMO_POLL_INTERVAL_SECONDS` defaults to 60; lowering it makes external changes appear sooner but uses more CPU. A label does not move or rename a folder. The image fixes application data at `/data`; `MUSIMO_DATA_DIR` is a local-development override, not a supported Compose mount relocation.

## Download settings

- `destination`: a writable root already listed in `MUSIMO_LIBRARY_ROOTS`, default `/music`. Read-only mounts are disabled in the destination selector and rejected by the API.
- `naming_template`: relative path tokens, default `{album_artist}/{album}/{track:02d} - {title}`. A live naming template preview is available at `/api/naming-preview`.
- `soundcloud_fallback`: on or off, default off. When it is on, a catalog track that YouTube has no match for, or that YouTube is paused or blocked for, is searched on SoundCloud as well, at a higher matching bar. SoundCloud free streams are about 128 kbps, lower than YouTube. How it behaves is in [downloads](downloads.md#soundcloud-as-a-backup-match). It is a switch on the Settings page, under Audio quality.
- `navidrome_mode`: `off`, `watcher` or `api`, default `off`.
- `navidrome_url`: server URL for API scanning and library playback. It must be HTTP or HTTPS and cannot contain credentials, a query or fragment. The help text names `MUSIMO_NAVIDROME_CREDENTIALS_FILE`.
- `navidrome_library_id`: positive library number, default 1. The UI caps it at 100000; the backend requires 1 or more.

Library's empty state links to `/settings#library`. Any field id works as an anchor (`destination`, `naming_template`, `output_format` and the others); the page scrolls to and focuses it. Download failure links use these anchors. The liked playlist link is persisted outside the settings table in `linked_playlists` and is untouched by settings saves.

## Draft preservation

Settings keeps draft values separate from the live query data. The form renders `draft[key] ?? setting.value` so unsaved changes remain visible while background SSE events (library scans, job updates, unrelated setting changes) update the query cache. A "You have unsaved changes." status appears while the draft has keys.

When a setting changes elsewhere (another tab, another user, or the Downloads page's concurrency select), a conflict notice appears on that row showing "Changed elsewhere to X" where X is the new value. The draft is not overwritten, and the saved flag resets so a later save sends the user's intended value, not the externally changed one.

Navigation guards block in-app Link clicks and browser tab close/refresh while the draft holds unsaved keys. The blocker shows a confirmation dialog. Saving clears the draft, removes conflict notices, and shows "Saved. You can safely refresh."

See [downloads](downloads.md) for staging, formats and metadata. See [library player](player.md) for playback and shared Navidrome credentials.

## Not yet available

Destination selection, naming templates and Navidrome watcher/API modes are implemented. Cookie uploads, notifications, source-specific budgets, proxy options and updater controls are not yet present. Paid providers remain unconfigured. Secrets will use dedicated files or encrypted storage, not this generic settings table.

Settings now includes a library scan panel with live counts, elapsed time, rescan and cancel. A cancelled scan retains the prior index.

The diagnostics export contains runtime versions, mount paths, library scan status, source test status, navidrome, last_download and recent events. Navidrome API credentials are mounted as a separate JSON file and are shared by scan and player calls. ZIP log export and a secret-redaction layer are hardening tasks.

## Your settings

Settings has two pages behind one Settings entry, and a Server / Yours switch at the top of both. Everything above is the server's: shared by whoever opens Musimo, saved in SQLite, and locked by environment where the deployment says so. `/settings/user`, "Your settings", is the other page. Nothing on it reaches the server or another person.

Appearance is its first section. While a theme is being edited the sections under Appearance (playback and the visualizer) are not drawn: the editor's Save and Cancel ride in a bar that sticks to the bottom of the Appearance section, and anything below it would let the bar scroll away at the end of the page. They come back when the edit is saved or cancelled; `e2e/phone.spec.ts` holds the bar on screen at both ends of the page. It lists every theme as a card with a strip of its page, card, text and accent colors. Choosing a card applies that theme and remembers it at once; there is no save bar. The cards are a radio group, so arrow keys move between them, and the active one is marked with a tick and the word Active rather than by its border alone. "Musimo dark" is the built-in theme and the one the app falls back to.

- **Duplicate and edit** copies any theme, including the built-in one, and opens the editor. A built-in theme cannot be changed, only copied.
- **Edit**, **Export** and **Delete** appear on your own themes. Deleting asks once, and deleting the theme you are using puts the default back.
- **Reset to default** returns to Musimo dark without deleting anything.

The editor takes a name, a dark or light scheme, and one color per token, grouped as Surfaces, Text, Lines, Accent and Status. Each color has a native color picker and a hex field that stay in step; a half-typed hex is marked, says what it needs, and leaves the last whole color on screen. The app around the editor is the live preview, and a preview strip at the top of the editor shows the colors the page itself cannot: buttons, chips, status messages, ownership badges, rows under the pointer and text over artwork. Save and Cancel ride in a sticky bar with a line that says what is stopping a save, if anything. Save keeps the theme and turns it on. Cancel puts your saved theme back. Leaving the page with unsaved edits asks first, then does the same. Under the colors, the editor shows the contrast ratio for the pairs people read text through, names the low ones in words, and warns below 4.5:1. That warning never blocks a save. Every action leaves a short status line behind (saved, imported, deleted, cancelled) and puts keyboard focus on the Appearance heading.

### Where themes are stored

In this browser only, under `musimo.theme`, `musimo.custom-themes` and `musimo.theme-vars` in local storage. They are not in the database, not in the diagnostics export and not synced. Another browser, another device or a cleared site history starts from the default. Up to 50 of your own themes are kept; at that many, Duplicate and Import are off until one is deleted. If the browser refuses to write, the page says so and the theme is not reported as saved. A list written by a newer Musimo is left alone rather than replaced, and the page says that too.

### Import and export

Export writes `<theme name>.musimo-theme.json` through the browser's own download, with characters a file name cannot hold replaced by a dash. Import takes that file back through the same validation as stored themes: known color names only, six or eight digit hex values, a name of at most 40 characters. An imported theme always arrives as a new theme, so it cannot overwrite one you already have, and it is turned on once it is read. A file that is not a Musimo theme is refused with a message and changes nothing.

### Playback

Volume levelling and crossfade for library playback, kept in this browser like the rest. **Volume levelling** is a select: Off, Track (the default) or Album (automatic). **Pre-amp** is a second select, from −6 to +6 dB in 3 dB steps, default 0, and is disabled while levelling is Off. **Crossfade** is a third, Off (the default) or 1 to 12 seconds. All three apply as they are chosen, including to a track already playing, and are stored under `musimo.replay-gain`, `musimo.replay-gain-preamp` and `musimo.crossfade`. A missing or unreadable value means the default. How the gain is worked out is in [Volume levelling](player.md#volume-levelling).

A boost (a positive tag or pre-amp on a quiet track) is never pushed past the track's tagged peak. An audio element cannot go above full volume, so the part above it goes through a gain node in the audio graph, on both library elements, which means a quiet track is lifted even with the slider at 100%. A track with no peak tag is never boosted past full volume, and previews are never boosted. See [Volume levelling](player.md#volume-levelling).

Crossfade overlaps the end of one library track with the start of the next. It is never used between consecutive tracks of the same album played in order, which run on gaplessly, or for repeat one, and it needs the next track to have loaded in time, so on a metered connection (data saver) tracks simply follow one another. How it works is in [Crossfade](player.md#crossfade). The sleep timer is not a setting: it is on the Now Playing controls, and is not kept ([Sleep timer](player.md#sleep-timer)).

Musimo does not write ReplayGain tags when it downloads yet, so only files that were tagged elsewhere are levelled. A file without the tags plays as it is, whatever these say.

### Visualizer

The third section on Your settings. Four selects: Stage size (Small or Large; Small, the default, puts the stage beside the tabs, Large gives it the page's width with the tabs below, and a phone always uses Small), Show on Now Playing (Artwork or Visualizer; it is the live view, so the stage's own Visualizer button changes the same setting, which a hint under the select says; a browser that has stored nothing shows Artwork, since the visualizer is heavy on the GPU), Preset (grouped by scene, the same options as the stage's select) and Fluid detail (512 or 1024, used only by the fluid scene). Each applies as it is chosen and is remembered in this browser, like themes. They are the Now Playing stage's own state, not a copy: changing one here updates an open stage at once, and changing one on the stage (or with S) shows here. Where the browser has no WebGPU, or the device could not be had, the view, preset and fluid selects are disabled and one line says why; Stage size stays available, since it lays out the artwork as well. Stored as `musimo.now-playing-size`, see [Stage size](now-playing-popout.md#stage-size). An Open Now Playing link sits under them. The keys and the state behind them are in [the visualizer note](visualizer.md#what-stays-on-musimos-side).

## Recent activity

Settings and Diagnostics reuse the same activity component. It displays the latest 100 visible events in a keyboard-focusable region with a 320px maximum height. Clear all disables while pending, reports failures and stores a persistent clear point through the snapshot the user saw. Newer events remain visible.

A run of neighbouring events of the same kind, such as a hundred "Library index updated" in a row, is one row: the event name, a count (×100) and the time range from its oldest to its newest event. The row is a button that opens the run's individual events and closes it again (`aria-expanded`). Two runs of one kind with a different event between them stay two rows, so the feed still reads as a timeline. A single event is a plain row as before. The grouping is `groupRuns` in `frontend/src/activity-runs.ts`, which folds the list the server sends; the server and the "latest 100" limit are unchanged, so a run can be cut short by that limit.

`GET /api/activity` returns events, total visible count and cursor. `DELETE /api/activity` accepts `{ "through": <cursor> }`. It validates a nonnegative integer and applies the usual same-origin write checks. Clearing affects the feed and diagnostics export, not job history or the bounded SSE replay records. This prevents clearing a panel from breaking live queue updates in other tabs.
