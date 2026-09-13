# Third-party software and content

The [MIT licence](LICENSE) covers Musimo's original source. It does not relicense the entire container, dependencies, catalog data, artwork, lyrics or downloaded audio.

## Software inventory

The exact dependency versions are recorded in `uv.lock`, `requirements.lock`, `frontend/package-lock.json` and `Dockerfile`. The visualizer, `visimo`, is a git dependency of the frontend; it is MIT and its own notices travel with it. The container also installs Debian packages and copies a Deno binary. The optional helper image is specified in `compose.yaml`.

Major components include React, TanStack Query/Router/Virtual, Vite, TypeScript, Zod, Lucide, Tailwind CSS, visimo, FastAPI, uvicorn, httpx, SQLite, Mutagen, watchdog, yt-dlp, the bgutil provider/plugin, FFmpeg, Chromaprint, Deno, Python and the base operating system. This list is an orientation, not a complete dependency licence audit or SBOM.

Keep upstream copyright and licence files when redistributing packages. Python distributions contain their metadata/licence files; npm packages contain their own licence metadata; Debian packages generally place copyright information under `/usr/share/doc/<package>/copyright`. Inspect the exact build you ship, including transitive dependencies and executables.

FFmpeg's applicable licence depends on its build configuration. The project's [licensing page](https://ffmpeg.org/legal.html) explains the LGPL/GPL distinction. Do not label a bundled FFmpeg build MIT or assume every build has identical obligations. Publishing an image or binary can require corresponding source and notices beyond linking to upstream projects.

Before publishing binary/container releases, complete the dependency and source-distribution steps in [Releasing](docs/releasing.md). A source repository and a redistributed container are different distribution artifacts.

## Providers and media

Deezer, YouTube, Apple/iTunes, MusicBrainz, LRCLIB and Navidrome names identify integrations or external services. They do not imply affiliation or endorsement. Their APIs, data, trademarks and media have their own terms and rights.

Fixtures and screenshots contributed to the repository must be generated or used with permission, with provenance recorded where needed. Do not include an audio recording simply because its title appears in a test. See [Terms](TERMS.md) for responsible use.
