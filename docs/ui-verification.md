# UI verification

Checked 7 September 2026 against a local built frontend and backend on port 8766, using an isolated database and empty music root under ignored `runtime/ui-check`. Browser data used live catalog metadata and provider preview clips. No full recording was downloaded by these UI checks.

## Browser checks completed

- Album search displayed verified counts for mounted cards without hovering or opening them. Discovery reported 0 of 14 in the empty fixture library.
- Album cards displayed a download icon with an accessible missing-track label. The album page displayed both all-track and missing-only actions.
- An album submission with an unconfigured destination stayed on the page and showed the server error plus Retry. Queue success/idempotency is covered by the download task's API tests; a real full album was not queued by this browser check.
- A provider preview entered playback and its timeline advanced. The artist link navigated to the artist page while keeping the selected preview. The song link returned to its album with the track ID in the URL and the matching row highlighted.
- Volume changed to 35% and remained at that value after reload. Mute/unmute, restart/play and close were exercised. Closing restored the empty-player state.
- A 390 by 844 viewport exposed a compressed play button and cramped track titles. The corrected layout keeps the play button from shrinking and gives mobile track details two rows. The queue dock sits above the player. A second screenshot confirmed the corrected layout.
- Settings showed 34 generated activity/index events. The activity region measured 320px high with 1,530px of scrollable content and `overflow-y: auto`.
- Clear all emptied that test feed, disabled its button, and remained empty after reload. Real user activity and music were not cleared.

These checks inspect browser state and rendered layout. They do not establish audible quality on every output device, all browser engines, screen-reader usability, or every provider fallback failure.

## Automated checks

`tests/test_activity.py` checks persistent clearing, preserved SSE replay, events arriving after the observed cursor, invalid inputs and cross-origin rejection. The search regression covers background album detail parity and refreshed ownership after changing the index while catalog data stays cached.

The frontend production build and focused backend tests pass. The separate testing task owns broader browser regression automation and CI. [Download verification](downloads.md) records worker/publication/recovery checks, including the permitted fixture that appeared in Navidrome.

## Further coverage

Automate card success/retry against a fixture API, coverage loading/failure and filter reactivity, links to tracks outside the initial virtual window, slider keyboard behavior, close during a pending lookup, activity clear racing with a new event, and the player/queue at small and tablet widths. Preserve unsaved Settings drafts during live queue activity. Do not treat this targeted browser pass as the full release acceptance suite.
