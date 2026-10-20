# Install and run Musimo

What Musimo needs, how to start it, how to point it at your music, and how to keep it private and up to date. Want help with the whole thing? Give an assistant with access to your computer the [setup handoff prompt](setup-handoff.md).

## Requirements

The supported deployment uses Docker Engine with the Compose plugin, or Docker Desktop running Linux containers. You need a recent browser with JavaScript, HTML audio and Server-Sent Events support. The Now Playing popout requires Document Picture-in-Picture, available in desktop Chrome and Edge. The visualizer needs WebGL 2, which current desktop and phone browsers have. Without it the stage stays on the artwork. The music bot needs [Ollama](https://ollama.com) reachable from the Musimo server, and a model chosen in the chat. Search, the library and downloads do not.

Catalog queries, artwork, previews and enabled sources require internet access. Keep application state on local disk. The music destination needs room for temporary and final files, and the runtime user needs permission to read indexed folders and write to the selected destination.

Playback uses the files in the music folders. No separate playback server is included in Compose. No minimum CPU/RAM or maximum library-size guarantee has been established by the full release benchmarks.

The main image includes Python, FFmpeg, Deno, Chromaprint tools and Python dependencies. Host installations of these tools are unnecessary when using Docker. An optional YouTube helper runs as a second container.

## Quick start

```sh
git clone https://github.com/LeahyCC/musimo.git
cd musimo
docker compose up -d --build --wait
```

Open [Musimo](http://127.0.0.1:8765). The initial build can take several minutes.

If Musimo is useful, [star it on GitHub](https://github.com/LeahyCC/musimo).

If you want to support the people who make music possible, [Donate to MUSICARES](https://www.musicares.org/).

1. Search for an artist or track. Catalog access needs no credentials.
2. Open Diagnostics to verify all components are ready (library roots, destination, scan, helpers).
3. Open Settings and inspect the library paths and download destination.
4. Mount your collection using the instructions below, then scan it.
5. Preview a result and check its library badge.
6. For a download test, use material you have permission to obtain.

The default music mount is `./runtime/music`, an isolated test folder within the checkout. It does not automatically find your existing collection. SQLite lives in the `musimo-data` named volume.

For the worker's optional YouTube helper:

```sh
docker compose --profile youtube up -d --build --wait
```

The helper and Python plugin use matching pinned versions. Starting them does not guarantee that a source accepts requests. See [YouTube troubleshooting](youtube-troubleshooting.md).

Useful health checks:

```sh
docker compose ps
docker compose logs --tail 100 musimo
curl http://127.0.0.1:8765/api/health
```

Health means the app and database respond. It does not mean every provider works or a file is visible in the library.

## Music folders and permissions

Settings uses **container paths**. Docker mounts connect those to host folders. A library label does not mount, move or rename files.

Create an ignored `compose.override.yaml`. This example indexes a read-only collection and downloads into a separate writable folder:

```yaml
services:
  musimo:
    environment:
      MUSIMO_LIBRARY_ROOTS: /music:/collection
    volumes:
      - type: bind
        source: /absolute/host/music-incoming
        target: /music
      - type: bind
        source: /absolute/host/existing-music
        target: /collection
        read_only: true
```

Replace both host paths with real, existing folders. The `/music` target replaces the base Compose test-folder bind during the merge. Check the result:

```sh
docker compose config
docker compose up -d --wait
```

The merged output may contain environment values. Redact it before sharing.

Add further mounts and list their Linux paths in `MUSIMO_LIBRARY_ROOTS`, separated by colons. Only configured roots can receive downloads. Give the library access to the same host folder if it should play these files.

### Windows and network mounts

Use Compose's long bind syntax and quote a verified absolute Windows source path. Drive letters differ between machines and can change. Do not copy a machine-specific override without checking its paths.

For Windows Docker Desktop binds or network shares that do not deliver filesystem events, set these values in `.env`:

```dotenv
MUSIMO_WATCH_MODE=poll
MUSIMO_POLL_INTERVAL_SECONDS=300
```

Shorter polling intervals use more CPU. Both modes also reconcile periodically. Keep SQLite on the local named volume, not SMB/NFS. Music mounts can be network folders, subject to their permissions and filesystem behavior.

### File permissions

`PUID` and `PGID` default to `1000`. On Linux, choose non-root IDs with access to the mounted folders. The entrypoint adjusts the application data directory and database files, then drops privileges. It does not recursively change ownership of music folders.

Read-only mounts contribute to coverage but cannot receive downloads. Diagnostics shows existence, free space and a permission check. Workers check their destination too. Neither check guarantees a later write will succeed if permissions, free space or the mount change.

## Configuration

Copy `.env.example` to `.env` for Compose deployment values. Both `.env` and `compose.override.yaml` are ignored.

- `MUSIMO_BIND`: host interface, default `127.0.0.1`.
- `MUSIMO_PORT`: host port, default `8765`.
- `PUID`, `PGID`: runtime IDs, default `1000`, both nonzero.
- `MUSIMO_LIBRARY_ROOTS`: container paths, default `/music` in base Compose.
- `MUSIMO_WATCH_MODE`: `native` or `poll`.
- `MUSIMO_POLL_INTERVAL_SECONDS`: polling interval, default `300`.

Editable settings cover the label, destination, output format, naming template, concurrency and retry limits. See [Settings](settings.md) and `backend/core/models.py` for the current contract.

Setting environment variables are **first-run bootstrap values**. Pass a value such as `MUSIMO_CONCURRENCY=3` through the container's `environment:` block to seed and lock it. Merely adding an arbitrary key to `.env` does not pass it into the container.

Existing database values win on later starts. Removing a bootstrap variable does not unlock its stored setting. The UI/API show the origin and reject writes to locked fields. There is no general unlock UI yet. Do not delete the database to change one preference.

For local development, `MUSIMO_DATA_DIR` and `MUSIMO_STATIC_DIR` select data and built frontend directories. The supported Docker layout keeps application state at `/data`.

## Backups and updates

SQLite stores settings, cached catalog results, indexed tags/paths, jobs/history and events at `/data/musimo.sqlite3`. Download staging lives under `.musimo` within the selected music root, on the same filesystem as publication.

Back up the application volume, music and necessary staging files, private Compose overrides and separately stored credentials. Record the application revision used with each backup.

A simple consistent backup is to stop Musimo, back up the entire application volume and required host folders with your normal backup tool, then start it. Do not copy only a live SQLite main file while omitting its WAL.

Update from a reviewed revision:

```sh
git pull --ff-only
docker compose up -d --build --wait
```

Use the same Compose overrides and optional profiles as installation. Back up before schema changes. `git pull --ff-only` refuses divergence instead of silently merging local edits. A newer database schema may require a matching backup to roll back.

This application opens database version 8. Version 5 stores the pause between groups of downloads. Version 6 is the library player: playlists, favourites, play counts and the saved queue live in Musimo, and the settings for a separate player are removed. Version 7 records each file's codec, and whether a FLAC file also carries ID3 tags. Version 8 numbers queue saves, so an older save cannot overwrite a newer one. An older build refuses a newer database, so rolling back after an upgrade needs the backup taken before it.

Rebuilds retain named volumes. **Do not add `--volumes` or `-v` to `docker compose down` during an update.** Removing the data volume loses application state. To stop without removal, use `docker compose stop`. Music folders remain your files, not disposable application state.

## Network access and privacy

Loopback is the default. There is no built-in login or separate user permissions. A name picks whose queue and likes this browser shows. It is not a lock and not a password. Anyone who can reach an exposed instance may be able to inspect paths, change settings and queue work. Use a trusted network, or authentication and HTTPS at a reverse proxy before broader access. Do not expose a bare unauthenticated port publicly.

Keep UI/API on the same origin. [Reverse proxy instructions](reverse-proxy.md) cover SSE buffering, timeouts and trusted forwarded headers. Those examples do not install authentication.

Self-hosted does not mean offline. Catalog/enrichment providers receive requests from the server. Artwork and preview hosts receive requests from the browser. Musimo has no built-in analytics service, but providers and your own proxy may log requests. [Privacy](../PRIVACY.md) describes these flows.
