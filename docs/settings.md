# Settings reference

Settings are validated and stored in SQLite. Edit the form, then use Save changes. Successful saves apply without a restart and publish a durable event. They survive container recreation when the data volume remains attached.

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

Library's empty state links to `/settings#library`. The liked playlist link is persisted outside the settings table in `linked_playlists` and is untouched by settings saves.

See [downloads](downloads.md) for staging, formats and metadata. See [library player](player.md) for playback and shared Navidrome credentials.

## Later phases

Destination selection, naming templates and Navidrome watcher/API modes are implemented. Cookie uploads, notifications, source-specific budgets, proxy options and updater controls are not yet present. Paid providers remain unconfigured. Secrets will use dedicated files or encrypted storage, not this generic settings table.

Settings now includes a library scan panel with live counts, elapsed time, rescan and cancel. A cancelled scan retains the prior index.

The diagnostics export contains runtime versions, mount paths, library scan status, source test status and recent events. Navidrome API credentials are mounted as a separate JSON file and are shared by scan and player calls. ZIP log export and a secret-redaction layer are hardening tasks.

## Recent activity

Settings and Diagnostics reuse the same activity component. It displays the latest 100 visible events in a keyboard-focusable region with a 320px maximum height. Clear all disables while pending, reports failures and stores a persistent clear point through the snapshot the user saw. Newer events remain visible.

`GET /api/activity` returns events, total visible count and cursor. `DELETE /api/activity` accepts `{ "through": <cursor> }`. It validates a nonnegative integer and applies the usual same-origin write checks. Clearing affects the feed and diagnostics export, not job history or the bounded SSE replay records. This prevents clearing a panel from breaking live queue updates in other tabs.
