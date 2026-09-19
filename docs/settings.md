# Settings reference

Settings are validated and stored in SQLite. Edit the form, then use Save changes. Successful saves apply without a restart and publish a durable event. They survive container recreation when the data volume remains attached.

A status summary at the top of the Settings page shows overall system readiness (ready or needs attention) with a link to Diagnostics for detailed component status.

## Editable settings

- `library_label`: Music by default, 1–60 characters.
- `output_format`: original, m4a, opus or mp3. Default original. M4A/Opus conversion depends on the actual source; the application must not promise lossless transcoding.
- `concurrency`: 1–3, default 2. Parallel download workers. Concurrency can also be changed from the Downloads page Parallel select and honours the lock.
- `max_attempts`: 1–4, default 4, including the first attempt. One disables automatic retries. Four allows up to three retries.
- `retry_base_seconds`: 1–30, default 2.
- `retry_cap_seconds`: 30–300, default 60.

Set `MUSIMO_` plus the uppercase key in the container environment to seed and lock a value on first creation, for example `MUSIMO_CONCURRENCY=3`. Later env changes do not replace an existing row. Its original env name remains visible in the UI and API, and PATCH returns 409 for a locked setting. Removing the variable does not unlock the database record. There is no unlock UI yet.

Deployment variables are separate: `MUSIMO_BIND`, `MUSIMO_PORT`, `PUID` and `PGID` control Compose. `MUSIMO_LIBRARY_ROOTS` lists the mounted Linux paths the scanner reads. `MUSIMO_WATCH_MODE` is `native` by default; use `poll` for external-change checks on Docker Desktop Windows or network shares. `MUSIMO_POLL_INTERVAL_SECONDS` defaults to 60; lowering it makes external changes appear sooner but uses more CPU. A label does not move or rename a folder. The image fixes application data at `/data`; `MUSIMO_DATA_DIR` is a local-development override, not a supported Compose mount relocation.

## Download settings

- `destination`: a writable root already listed in `MUSIMO_LIBRARY_ROOTS`, default `/music`. Read-only mounts are disabled in the destination selector and rejected by the API.
- `naming_template`: relative path tokens, default `{album_artist}/{album}/{track:02d} - {title}`. A live naming template preview is available at `/api/naming-preview`.
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

Appearance is its first section. It lists every theme as a card with a strip of its page, card, text and accent colors. Choosing a card applies that theme and remembers it at once; there is no save bar. The cards are a radio group, so arrow keys move between them, and the active one is marked with a tick and the word Active rather than by its border alone. "Musimo dark" is the built-in theme and the one the app falls back to.

- **Duplicate and edit** copies any theme, including the built-in one, and opens the editor. A built-in theme cannot be changed, only copied.
- **Edit**, **Export** and **Delete** appear on your own themes. Deleting asks once, and deleting the theme you are using puts the default back.
- **Reset to default** returns to Musimo dark without deleting anything.

The editor takes a name, a dark or light scheme, and one color per token, grouped as Surfaces, Text, Lines, Accent and Status. Each color has a native color picker and a hex field that stay in step; a half-typed hex is marked, says what it needs, and leaves the last whole color on screen. The app around the editor is the live preview, and a preview strip at the top of the editor shows the colors the page itself cannot: buttons, chips, status messages, ownership badges, rows under the pointer and text over artwork. Save and Cancel ride in a sticky bar with a line that says what is stopping a save, if anything. Save keeps the theme and turns it on. Cancel puts your saved theme back. Leaving the page with unsaved edits asks first, then does the same. Under the colors, the editor shows the contrast ratio for the pairs people read text through, names the low ones in words, and warns below 4.5:1. That warning never blocks a save. Every action leaves a short status line behind (saved, imported, deleted, cancelled) and puts keyboard focus on the Appearance heading.

### Where themes are stored

In this browser only, under `musimo.theme`, `musimo.custom-themes` and `musimo.theme-vars` in local storage. They are not in the database, not in the diagnostics export and not synced. Another browser, another device or a cleared site history starts from the default. Up to 50 of your own themes are kept; at that many, Duplicate and Import are off until one is deleted. If the browser refuses to write, the page says so and the theme is not reported as saved. A list written by a newer Musimo is left alone rather than replaced, and the page says that too.

### Import and export

Export writes `<theme name>.musimo-theme.json` through the browser's own download, with characters a file name cannot hold replaced by a dash. Import takes that file back through the same validation as stored themes: known color names only, six or eight digit hex values, a name of at most 40 characters. An imported theme always arrives as a new theme, so it cannot overwrite one you already have, and it is turned on once it is read. A file that is not a Musimo theme is refused with a message and changes nothing.

### Visualizer

The second section on Your settings. Three selects: Default view (Artwork or Visualizer; a browser that has stored nothing shows Artwork, since the visualizer is heavy on the GPU), Preset (grouped by scene, the same options as the stage's select) and Fluid detail (512 or 1024, used only by the fluid scene). Each applies as it is chosen and is remembered in this browser, like themes. They are the Now Playing stage's own state, not a copy: changing one here updates an open stage at once, and changing one on the stage shows here. Where the browser has no WebGPU, or the device could not be had, the selects are disabled and one line says why. An Open Now Playing link sits under them. The keys and the state behind them are in [the visualizer note](visualizer.md#what-stays-on-musimos-side).

## Recent activity

Settings and Diagnostics reuse the same activity component. It displays the latest 100 visible events in a keyboard-focusable region with a 320px maximum height. Clear all disables while pending, reports failures and stores a persistent clear point through the snapshot the user saw. Newer events remain visible.

`GET /api/activity` returns events, total visible count and cursor. `DELETE /api/activity` accepts `{ "through": <cursor> }`. It validates a nonnegative integer and applies the usual same-origin write checks. Clearing affects the feed and diagnostics export, not job history or the bounded SSE replay records. This prevents clearing a panel from breaking live queue updates in other tabs.
