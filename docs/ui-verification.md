# UI verification

Checked 7 September 2026 against a local built frontend and backend on port 8766, using an isolated database and empty music root under ignored `runtime/ui-check`. Browser data used live catalog metadata and provider preview clips. No full recording was downloaded by these UI checks.

## Browser checks completed

- Album search displayed verified counts for mounted cards without hovering or opening them. Discovery reported 0 of 14 in the empty fixture library.
- Album cards displayed a download icon with an accessible missing-track label. The album page displayed both all-track and missing-only actions.
- An album submission with an unconfigured destination stayed on the page and showed the server error plus Retry. Queue success/idempotency is covered by the download task's API tests; a real full album was not queued by this browser check.
- A provider preview entered playback and its timeline advanced. The artist link navigated to the artist page while keeping the selected preview. The song link returned to its album with the track ID in the URL and the matching row highlighted.
- Volume changed to 35% and remained at that value after reload. Mute/unmute, restart/play and close were exercised. Closing restored the empty-player state.
- A 390 by 844 viewport exposed a compressed play button and cramped track titles. The corrected layout keeps the play button from shrinking and gives mobile track details two rows. The queue dock is hidden with no active download. A second screenshot confirmed the corrected layout. This 375x812 mobile check was recorded in PR #32.
- Settings showed 34 generated activity/index events. The activity region measured 320px high with 1,530px of scrollable content and `overflow-y: auto`.
- Clear all emptied that test feed, disabled its button, and remained empty after reload. Real user activity and music were not cleared.

These checks inspect browser state and rendered layout. They do not establish audible quality on every output device, all browser engines, screen-reader usability, or every provider fallback failure.

## Automated checks

The download-options regression runs two-song and 30-song fixtures across Chromium, Firefox, WebKit and a mobile viewport. All eight cases passed on 7 September 2026. It checks popup hit testing above virtual rows, viewport bounds, keyboard focus, Escape and outside dismissal, switching between song popups, scrolling dismissal and access from the final row. The popup uses the browser's top layer so scrolling containers cannot clip it. No download requests are submitted.

`tests/test_activity.py` checks persistent clearing, preserved SSE replay, events arriving after the observed cursor, invalid inputs and cross-origin rejection. The search regression covers background album detail parity and refreshed ownership after changing the index while catalog data stays cached.

`e2e/library-controls.spec.ts` and `e2e/playlists.spec.ts` cover the Library work added on 9 September 2026. The tracks view is checked for sending its query, genre, sort and shuffle to the server and for offering whole-library filter choices; a track's play button is checked for turning into a pause button and back; an artist page is checked for album release years, album and song sort orders and the popularity chart's summary. The playlist checks cover the liked playlist leading the list with no delete control, the delete control appearing only on hover, the public/private filter, a playlist's song count, play, rename and non-duplicating add, and the picker being centred in the viewport, toggling Add to Remove, listing a playlist's songs in a fixed-height area, removing one of them, and the playlist page showing that change without a reload.

`e2e/player.spec.ts` covers the loading transition check and AudioMuse radio. `e2e/now-playing-popout.spec.ts` checks the Now Playing hover and idle stage on desktop Chromium only.

`e2e/download-failures.spec.ts` adds a nine-failure queue: it checks infinite scrolling, failure explanations and retry counts, the group chips split album failures from single tracks, that Clear failed calls the queue command, and that download cards flow inside one offset container rather than each carrying its own absolute position. That last check is the structural guard against overlapping cards. The overlap itself could not be reproduced by sampling scroll frames, so it is guarded by layout rather than by measurement; per-card absolute offsets could place a card over its neighbour whenever a measured height had not landed, and grid flow cannot.

The frontend production build and focused backend tests pass. The separate testing task owns broader browser regression automation and CI. [Download verification](downloads.md) records worker/publication/recovery checks, including the permitted fixture that appeared in Navidrome.

## Known limits

Library album genre and year filters still apply to the pages loaded so far; only the tracks view filters and sorts on the server. Catalog search on the Search page is unchanged and says so in its own hint. Navidrome's saved play queue holds 500 songs, so Play all and Shuffle over a larger library play a 500-song selection. Whole-library track browsing reads up to 10,000 songs from Navidrome, so a library beyond that size describes the first 10,000 it returns.

## Further coverage

Automate card success/retry against a fixture API, coverage loading/failure and filter reactivity, links to tracks outside the initial virtual window, slider keyboard behavior, close during a pending lookup, activity clear racing with a new event, and the player/queue at small and tablet widths. Preserve unsaved Settings drafts during live queue activity. Do not treat this targeted browser pass as the full release acceptance suite.
