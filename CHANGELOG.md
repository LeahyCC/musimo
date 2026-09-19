# Changelog

## Unreleased

### Search and downloads

- Search podcasts from a new Podcasts tab, open a show's latest episodes and download them straight from the publisher's file into `Podcasts/<show>`

### Library and playback

- Give library playback its own audio element and a Web Audio analyser for the coming visualizer, keeping catalog previews off it (#51)
- Extract bands, energy, onsets, a beat pulse and tempo from library playback in a worker, ready for the visualizer (#52)
- Draw a WebGPU particle field on the Now Playing stage, with a view toggle, a debug overlay and a particle count setting; browsers without WebGPU keep the artwork (#53)
- Keep the visualizer running across the Now Playing popout round trip on one device, with its frame time reported in the popout window too (#54)
- Tune the particle field on real music and stop the tempo guess reading half-time (#56)
- Draw the visualizer through a post stack of feedback trails, bloom, beat-driven chromatic aberration, a tonemap and grain, so loud passages no longer clip to white (#57)
- Add a fluid scene to the visualizer, with a scene select in the stage's top bar (#58)
- Add a raymarched fractal scene to the visualizer, folded by the bass and detailed by the treble, with a step cap in the stage's top bar (#59)
- Add six visualizer presets, two per scene, each naming which feature drives which parameter, with a picker in the stage's top bar and `[` and `]` to cycle (#60)
- Cut the particle and raymarch visualizer scenes and their four presets, leaving the fluid and hiding the scene select while there is one scene to pick (#61)
- Move the visualizer into [visimo](https://github.com/LeahyCC/visimo) and consume it as a dependency, so scenes and presets can be tuned against a dropped track instead of a library
- Add visimo's Kaleidoscope scene and its Prism preset to the visualizer, which brings the scene select back to the stage's top bar
- Lay out the Artists grid like the Albums grid: big round picture, name and album count below, play on hover
- Show an artist's newest album cover in place of Navidrome's star when it has no photo of them
- Filter the Artists tab by genre, year, favourites and played or never played, sort it by recently added, and mark an artist as a favourite from their page
- Filter and sort Albums on the server, so genre and year cover the whole library instead of the albums already scrolled past
- Browse libraries up to 50,000 songs on the Tracks tab (it stopped at 10,000), keeping only the fields the page reads so the larger cap costs less memory than the old one
- Say "1 album" and "1 song" on an artist page instead of "1 ALBUMS"
- Show the release year on an artist's popular songs instead of a "…" that never filled in

### Testing and CI

- Add a Vitest unit test runner for the frontend (#49)
- Pin the stage view in the Now Playing popout test, which passed headless and failed on any machine with a WebGPU adapter (#62)
- Keep prettier out of `.git` and the agent worktrees under `.claude`, so `npm run format` finishes instead of dying on a plugin it cannot resolve (#62)

### Infrastructure and fixes

- Update React and its types together to 19.3.0, Vite to 8.3.0, TanStack Virtual to 3.14.11 and Ruff to 0.16.7
- Update the bgutil plugin and helper together to 2.0.0, including the exported runtime lock and native Windows setup instructions
- Let the dev proxy target another backend with `MUSIMO_API_TARGET`, and keep writes through it from being refused as cross-origin (#50)
- Let the dev proxy reach an https backend such as Tailscale Serve and still save (#55)
- Stop passing Navidrome's error for a missing item on as broken artwork, and stop sending a compressed length with a decoded body

### UI and accessibility

- Finish the Tailwind migration: the last handwritten screen rules are gone, so a theme now reaches every page, and a new browser check walks every route at desktop and phone width under a light theme

- Make every screen work on a phone: mini player, bottom-bar download count, safe-area insets, 44px touch targets, no focus zoom, tabs and sheets that fit (#48)
- Add a personal settings page at `/settings/user` where you pick a theme, build your own from the color tokens with the whole app as a live preview, and export or import one as a file. Settings is now a Server and Yours switch, and the command palette has Change theme
- Ship eleven more built-in themes: Musimo light, and Slate, Sunset, Violet, Graphite and Windows 95, each in light and dark
- Give the Windows 95 themes the whole look, not only its colors: the real Windows Standard and High Contrast Black schemes, square corners, raised and sunken bevels, a navy title bar, the W95FA pixel font, grey scrollbars and Windows 95 check boxes, drop-downs and track bars
- Make the selected sidebar item readable in Sunset light, Violet light, Graphite light and Windows 95, and add it, sidebar text and the downloads badge to the theme editor's readability report

## 0.4.0 (2026-09-10)

First tagged release of Musimo. This release provides search, library indexing, download workers, queue controls, album batches, Navidrome library playback and playlist management.

### Library and playback

- Add Navidrome library player and playlist tools (#13)
- Add artist songs subpage and track view mode (#18)
- Add playlist queue actions and liked playlist support (#19)
- Clean up library navigation and playback (#16)
- Fix flicker when starting library playback (#21)

### Search and catalog

- Keep artist results accurate (#9)
- Add popular music to artist pages (#8)
- Improve release checks and artist pages (#7)

### Downloads and queue

- Fix download recovery and update container runtimes (#5)
- Fix download options and document complete setup (#4)
- Improve download failures and infinite scrolling (#14)
- Explain failed downloads and show retry counts (#15)

### UI and accessibility

- Make long lists usable by keyboard, touch and screen reader (#44)
- Walk every screen at desktop and phone width and fix what is broken (#43)
- Fix mobile player overflow and queue button overlap (#32)
- Full screen and popout for Now Playing's artwork (#31)
- Fix library, playlist and download UI bugs (#29)

### Diagnostics and settings

- Add a readiness panel to Diagnostics that probes instead of assumes (#41)
- Add draft preservation and conflict detection to Settings (#42)
- Link every download failure to the setting or guide that fixes it (#40)

### User feedback

- Tell apart in library, already queued and another edition (#39)
- Show the destination and format before an album or track is queued (#37)
- Focus the highlighted track and give album pages a way back (#35)

### Infrastructure and fixes

- Fix 21 bugs from code audit (#38)
- Harden file selection and fix Linux audio tests (#3)
- Bump python from 3.12-slim-bookworm to 3.14-slim-bookworm (#1)
- Bump node from 24-bookworm-slim to 26-bookworm-slim (#2)

### Documentation

- Fix the last documentation drift before tagging 0.4.0 (#47)
- Prepare the 0.4.0 release cut (#45)
- Bring the docs in line with the code after PRs 13 to 34 (#36)
- Refresh README with product screenshot (#10)
- Fix README screenshot asset (#11)
- Add MUSICARES donation link (#12)
- Create FUNDING.yml (#6)

### Testing and CI

- Let several browser test stacks run side by side (#34)
- Pause pull request CI for the first release cut (#33)
- Serve an empty download queue from the browser fixtures (#30)

### Known limitations

From docs/measurements.md:

- Cold search latency misses 400ms target: ten distinct uncached queries had median 416.95 ms and p95 496.56 ms (measurements.md line 88)
- Sustained idle CPU misses 1% target: 120 samples over 737.9 seconds averaged 2.349% of one CPU core with the deployed 60-second polling watcher (measurements.md line 92)
- Music match accuracy corpus exists (100 distinct MusicBrainz recordings) but independent labels pending (measurements.md line 86)
- Fifty distinct permitted music downloads not measured (measurements.md line 94)
- Native arm64 emulated build passes but native ARM hardware and performance not measured (measurements.md line 90)
- Representative 50k mixed-format library not tested: current index is 3,681 files (measurements.md line 94)
- Provider album throughput not measured (measurements.md line 94)
- Document Picture in Picture (Now Playing popout) requires desktop Chrome or Edge
- No built-in login or multi-user support
- Catalog results do not guarantee permitted full-quality downloads exist
- Different album editions are flagged but worker appends job ID to avoid overwrites instead of replacing
- Some filesystem events do not cross Docker Desktop mounts on Windows, requiring polling mode

## 0.3.0 and earlier

Early development work integrated the FastAPI backend, React frontend, SQLite state, Docker composition, Deezer catalog search, library indexing, download workers with yt-dlp, Navidrome integration, queue controls and settings persistence. The brief and initial planning covered ambitions for the eventual feature set.
