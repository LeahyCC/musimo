# Run directly on Windows

Musimo can run on Windows without Docker or WSL. Install Python 3.12 or newer, uv, Node 26, FFmpeg (including ffprobe), Deno and [Chromaprint's fpcalc](https://github.com/acoustid/chromaprint/releases). Put their executable directories on PATH. If a package-manager link cannot launch an executable, use its actual installation directory.

From a checkout:

```powershell
uv sync --locked
npm ci --prefix frontend
npm run build --prefix frontend
```

For downloads, install the matching [bgutil helper](https://github.com/Brainicism/bgutil-ytdlp-pot-provider/tree/1.3.2) outside the checkout. Its version must match the Python plugin in `pyproject.toml`:

```powershell
git clone --depth 1 --branch 1.3.2 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git "$env:LOCALAPPDATA\Musimo\bgutil"
Push-Location "$env:LOCALAPPDATA\Musimo\bgutil\server"
npm ci
npx tsc
Pop-Location
.\scripts\start-windows.ps1 -LibraryRoots 'C:\Music' -PotServerHome "$env:LOCALAPPDATA\Musimo\bgutil\server"
```

Use your actual music folder. Multiple roots are a PowerShell array, such as `-LibraryRoots 'C:\Music','E:\Collection'`. Select the destination in Settings before downloading. The helper runs on demand, with no permanent helper server. It uses more startup time per download than the Docker HTTP helper. Do not run the helper's HTTP server on a public interface.

Pause and cancel stop the entire Windows worker process tree, including FFmpeg and the token helper. Without `MUSIMO_POT_SERVER_HOME`, workers retain the Docker HTTP helper configuration.

The launcher binds to `127.0.0.1:8765`, uses the built frontend, native filesystem events and one worker. State defaults to `%LOCALAPPDATA%\Musimo\data`; `-DataDir` and `-Port` override those locations. Keep the data directory on a local disk. Python stays running until stopped. Use a hidden Task Scheduler action at logon for unattended startup after signing in, with a fixed checkout, PATH and arguments. Configure restart on failure and do not start a second instance against the same database.

Private Tailscale Serve works with the same loopback address as the Docker deployment. The launcher trusts forwarded headers only from loopback. Preserve existing Serve routes and check same-origin writes and SSE through the final URL. See [proxy configuration](reverse-proxy.md).

## Move an existing Docker installation

Finish or pause active jobs, stop only Musimo, and back up its complete `/data` directory. Preserve the original volume and music as rollback copies. Copy state to a new Windows directory; never run both installations against it.

Stored paths must be translated using the actual Docker mount mappings. This includes the destination setting, library roots/files/search index and download history targets/final paths. Change a Navidrome `host.docker.internal` URL to the host's loopback URL. Keep settings locks and all job IDs, metadata and history. Rescan after switching to reconcile filesystem timestamps. An unmodified Linux database is not ready for native Windows use.

Before retiring the container, verify database integrity and record counts, saved settings, search, library badges, playback, a permitted download, pause/cancel, restart, remote access and startup. Stop the native service before restoring the Docker copy. Keep personal migration records and backups outside Git.

Docker remains supported for deployment and isolated CI. Other containers may still require WSL; migrating Musimo alone does not remove that dependency.
