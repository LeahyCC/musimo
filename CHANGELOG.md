# Changelog

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

- Bring the docs in line with the code after PRs 13 to 34 (#36)
- Refresh README with product screenshot (#10)
- Fix README screenshot asset (#11)
- Add MUSICARES donation link (#12)
- Create FUNDING.yml (#6)

### Testing and CI

- Let several browser test stacks run side by side (#34)
- Pause pull request CI for the first release cut (#33)
- Serve an empty download queue from the browser fixtures (#30)

### AudioMuse integration

- Hide AudioMuse connection errors (#17)

### Visualizer experiments

These PRs add a native WebGL2 visualizer study renderer alongside the Butterchurn integration for exploring audio-reactive visual patterns.

- Give Kaleidoscope V3 one void that breathes open (#27)
- Remove Butterchurn from the visualizer package (#26)
- Move Dive to the native renderer (#25)
- Kaleidoscope V3 on the native renderer, plus Julia spiral and Liquid contours (#24)
- Give the native renderer a real onset signal and verify band levels (#23)
- Native WebGL2 study renderer beside Butterchurn (#22)

### Known limitations

From PR bodies and docs/measurements.md:

- Cold search latency misses the 400ms target (median 416.95ms)
- Sustained idle CPU usage at 2.349% average (target is 1%)
- Music match accuracy is not independently labeled (100-case corpus exists but needs review)
- Fifty distinct permitted music downloads not measured
- Native arm64 builds successfully but performance not measured on hardware
- Representative 50k mixed-format library not tested (synthetic 50k scan passes)
- Provider album throughput not measured
- Document Picture in Picture (Now Playing popout) requires desktop Chrome or Edge
- No built-in login or multi-user support
- Catalog results do not guarantee permitted full-quality downloads exist
- Different album editions are flagged but worker appends job ID to avoid overwrites instead of replacing
- Some filesystem events do not cross Docker Desktop mounts on Windows, requiring polling mode

## 0.3.0 and earlier

Early development work integrated the FastAPI backend, React frontend, SQLite state, Docker composition, Deezer catalog search, library indexing, download workers with yt-dlp, Navidrome integration, queue controls and settings persistence. The brief and initial planning covered ambitions for the eventual feature set.
