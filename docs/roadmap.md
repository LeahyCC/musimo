# Roadmap and UX follow-ups

This is a priority list, not a release promise. The [brief](brief.md) preserves the original scope; [measurements](measurements.md) records completed checks. [Discover](discover.md) is planned separately.

## Shipped in 0.4.0

Version 0.4.0 (10 September 2026) completed the core search, download and playback journey:

- ✓ Automatic album coverage checks with verified counts and progress bars
- ✓ Album cards show destination and format before queueing
- ✓ Track download controls show destination and format before queueing
- ✓ Job cards display destination and format
- ✓ Actionable source errors that link to the relevant setting, diagnostic or action
- ✓ Warning counts appear in done job headings
- ✓ Highlighted-track links focus the row with visible focus indicators
- ✓ Album and artist pages show "Back to results" when reached from search
- ✓ Library playback has previous, next, shuffle and repeat over a saved queue
- ✓ Distinct badges for "in library", "already queued" and "another edition matched"
- ✓ Edition matches keep the download control enabled with explanation
- ✓ Diagnostics shows library roots (mounted, writable, free space)
- ✓ Diagnostics shows selected destination with write-test button
- ✓ Diagnostics shows last library scan (state, file count, when)
- ✓ Diagnostics shows Navidrome status (configured, available, version, mode)
- ✓ Diagnostics shows YouTube helper availability with pause state
- ✓ Diagnostics shows last download outcome with error code
- ✓ Settings displays overall status summary with link to Diagnostics
- ✓ Keyboard focus works across virtualized lists without remounting
- ✓ Touch targets meet 44px minimum on coarse pointers
- ✓ Player height adapts dynamically to prevent queue button overlap
- ✓ Automated axe accessibility checks run on every route
- ✓ Minimum text size raised from 9px to 10px
- ✓ Queue count changes announce via live region
- ✓ Settings drafts survive SSE events
- ✓ Conflict notices appear when a value changes elsewhere
- ✓ Navigation guards block unsaved changes from being lost
- ✓ Navidrome library browsing for albums, artists, tracks and playlists
- ✓ Playlist CRUD with inline rename
- ✓ Linked liked playlist with thumbs up button
- ✓ Add to playlist picker with inline creation
- ✓ Artist All songs subpage with popularity chart
- ✓ Server side Tracks view filters by search, genre, year and sort order
- ✓ Now Playing full screen and popout stage
- ✓ Download failure explanations with plain language messages
- ✓ Failure grouping by download group with reason chips
- ✓ Per card and bulk Clear failed actions
- ✓ Infinite scrolling for download results and history
- ✓ Bounded activity feed with persistent clearing

## Finish the existing journey first

Search → inspect recording → choose destination/format → queue → see progress → handle failure → find the finished file in Navidrome. The core flow is working in 0.4.0; validation of the complete path still depends on your chosen provider, Navidrome setup and storage configuration.

## Next improvements

1. **Preview navigation context.** Library playback has previous, next, shuffle and repeat. The open question is whether catalog previews should have previous and next, and if so, whether that follows the album order, search results or an explicit preview queue.
2. **File replacement flow.** Different album editions are flagged and keep the download control enabled, but the worker currently appends the job ID to the filename when the target exists instead of offering to replace or keep both versions.
3. **Long-list performance.** Virtualized lists work for accessibility and touch targets but may benefit from further optimization for very large libraries or result sets.

## Release continuation

Public documentation and contribution templates are in place. Container releases need an inventory and licence/source-distribution review for the exact image, plus SBOM generation. [Releasing](releasing.md) lists concrete remaining checks.

Known measurement gaps after 0.4.0:

- Independent labels for the 100-case music-match corpus (corpus exists, labels pending)
- Fifty distinct permitted music downloads (one public-domain fixture verified)
- Provider album throughput
- Representative 50k mixed-format library (synthetic 50k scan passes in 45s)
- Native arm64 performance on hardware (emulated build passes)
- Cold search latency still misses 400ms target (417ms median, provider at 410ms)
- Sustained idle CPU at 2.35% average (target 1%)

## Deferred implementation

Artist/playlist imports, Discover recommendations, notifications, cookies, account connections, authentication, multi-user support and automatic release-edition filtering remain separate work. Do not add additional preview transport controls or autoplay until the user flow is defined.
