# Third-party software and content

The [MIT licence](LICENSE) covers Musimo's original source. It does not relicense the entire container, dependencies, catalog data, artwork, lyrics or downloaded audio.

## Software inventory

The exact dependency versions are recorded in `uv.lock`, `requirements.lock`, `frontend/package-lock.json` and `Dockerfile`. The visualizer is butterchurn with the butterchurn-presets base pack, both MIT; the presets are MilkDrop community presets whose authors are named in each preset's full name, shown when hovering the preset picker. The container also installs Debian packages and copies a Deno binary. The optional helper image is specified in `compose.yaml`.

Major components include React, TanStack Query/Router/Virtual, Vite, TypeScript, Zod, Lucide, Tailwind CSS, butterchurn, FastAPI, uvicorn, httpx, SQLite, Mutagen, watchdog, yt-dlp, the bgutil provider/plugin, NumPy (BSD-3-Clause, used to score song characteristics), FFmpeg, Chromaprint, Deno, Python and the base operating system. This list is an orientation, not a complete dependency licence audit or SBOM.

## Audio worker image

The optional analysis worker (`worker/`, Compose profile `analysis`) is a separate image with its own lock, `worker/uv.lock` and `worker/requirements.lock`. It installs librosa (ISC) for the `tempo-energy-v1` recipe, and with it librosa's dependencies as pinned there, among them NumPy, SciPy, scikit-learn, joblib and soundfile (BSD-3-Clause), numba and llvmlite (BSD-2-Clause), audioread (MIT) and python-soxr (LGPL-2.1-or-later, used as a shared library). It also installs Debian's FFmpeg package, to which the FFmpeg note above applies. No model weights are downloaded or shipped. AudioMuse-AI (AGPL-3.0) is the source of the behaviour described in [song characteristics](docs/audio-profile-spec.md); none of its code, exports or weights is included.

Keep upstream copyright and licence files when redistributing packages. Python distributions contain their metadata/licence files; npm packages contain their own licence metadata; Debian packages generally place copyright information under `/usr/share/doc/<package>/copyright`. Inspect the exact build you ship, including transitive dependencies and executables.

FFmpeg's applicable licence depends on its build configuration. The project's [licensing page](https://ffmpeg.org/legal.html) explains the LGPL/GPL distinction. Do not label a bundled FFmpeg build MIT or assume every build has identical obligations. Publishing an image or binary can require corresponding source and notices beyond linking to upstream projects.

Before publishing binary/container releases, complete the dependency and source-distribution steps in [Releasing](docs/releasing.md). A source repository and a redistributed container are different distribution artifacts.

## Windows 95 theme

The Windows 95 themes use the W95FA typeface by Alina Sava, licensed under the SIL Open Font License 1.1 and installed from the `@fontsource/win95fa` npm package, which carries the licence text. The bevel recipes in `frontend/src/theme/win95.css` follow [98.css](https://github.com/jdan/98.css), Copyright (c) 2020 Jordan Scales, MIT licence. Windows and Windows 95 are trademarks of Microsoft; the themes are an homage and imply no affiliation or endorsement.

## Providers and media

Deezer, YouTube, Apple/iTunes, MusicBrainz, LRCLIB and the library names identify integrations or external services. They do not imply affiliation or endorsement. Their APIs, data, trademarks and media have their own terms and rights.

Fixtures and screenshots contributed to the repository must be generated or used with permission, with provenance recorded where needed. Do not include an audio recording simply because its title appears in a test. See [Terms](TERMS.md) for responsible use.
