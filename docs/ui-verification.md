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

The download-options regression runs two-song and 30-song fixtures across Chromium, Firefox, WebKit and a mobile viewport. All eight cases passed on 7 September 2026. It checks popup hit testing above virtual rows, viewport bounds, keyboard focus, Escape and outside dismissal, switching between song popups, scrolling dismissal and access from the final row. The popup uses the browser's top layer so scrolling containers cannot clip it. No download requests are submitted. Additional mobile viewport checks verify all five navigation items remain visible within the 64px bottom bar, and that the Diagnostics item does not wrap out of the bar.

`tests/test_activity.py` checks persistent clearing, preserved SSE replay, events arriving after the observed cursor, invalid inputs and cross-origin rejection. The search regression covers background album detail parity and refreshed ownership after changing the index while catalog data stays cached. Additional `e2e/app.spec.ts` checks verify that the Diagnostics page renders both catalog and download sources with appropriate headings, that only sources with test routes show a Test now button, that read-only destination options are disabled in Settings, the command palette includes Library and Now Playing commands, and readiness panel components (library roots, destination test write, not ready state, finished scan counts as ready). `e2e/album.spec.ts` checks that the album download button is disabled with "Checking coverage" text while coverage is unverified. `e2e/cards.spec.ts` checks badge states (owned, edition, queued, downloaded earlier) and card links.

`e2e/library-controls.spec.ts` and `e2e/playlists.spec.ts` cover the Library work added on 9 September 2026. The tracks view is checked for sending its query, genre, sort and shuffle to the server and for offering whole-library filter choices; a track's play button is checked for turning into a pause button and back; an artist page is checked for album release years, album and song sort orders and the popularity chart's summary. The playlist checks cover the liked playlist leading the list with no delete control, the delete control appearing only on hover, the public/private filter, a playlist's song count, play, rename and non-duplicating add, and the picker being centred in the viewport, toggling Add to Remove, listing a playlist's songs in a fixed-height area, removing one of them, and the playlist page showing that change without a reload. Additional checks verify that library view tabs carry aria-pressed state that updates when switching views.

`e2e/player.spec.ts` covers the loading transition check and AudioMuse radio. `e2e/now-playing-popout.spec.ts` checks the Now Playing hover and idle stage on desktop Chromium only.

`e2e/download-failures.spec.ts` adds a nine-failure queue: it checks infinite scrolling, failure explanations and retry counts, error hints link to the relevant setting or diagnostic, done jobs with warnings show the count in their heading, the group chips split album failures from single tracks, that Clear failed calls the queue command, and that download cards flow inside one offset container rather than each carrying its own absolute position. That last check is the structural guard against overlapping cards. The overlap itself could not be reproduced by sampling scroll frames, so it is guarded by layout rather than by measurement; per-card absolute offsets could place a card over its neighbour whenever a measured height had not landed, and grid flow cannot. Additional checks verify that download errors on the last visible row at mobile viewport remain fully visible within the virtual list container, and that the History tab shows an empty state when no jobs have finished.

The frontend production build and focused backend tests pass. The separate testing task owns broader browser regression automation and CI. [Download verification](downloads.md) records worker/publication/recovery checks, including the permitted fixture that appeared in Navidrome.

## Visual walk, 10 September 2026

A temporary Playwright script visited every screen at 1280 by 800 and 390 by 844 against the isolated CI stack, using the shared search, library, player and queue fixtures with invented long titles, and saved a screenshot per screen. Each screenshot was inspected by eye, with a probe reporting page-level sideways scroll and any element wider than its box. Screens covered: home, search results on the Top, Tracks, Albums and Artists tabs, no results, catalog error and loading, an album with a highlighted track and a playing preview, an artist page with both download sheets, album loading, missing album, library home in grid and list layout, albums, artists, tracks with the genre and year menus open, playlists, a playlist page with rename and add-song search, a library album and artist and its All songs view, Downloads queue, done, failed with a batch group selected, history, the queue dock and sheet, source paused, empty and unreadable queue, Settings clean, dirty, loading and failed, Diagnostics and its failure, Now Playing with a library track, AudioMuse radio, the hover controls and the full screen stage, the command palette with and without matches, the mobile mini player, the add to playlist picker, and the empty, unconfigured and unavailable library states, plus the reconnecting, connecting and offline banners.

Fixed in that pass, each with a browser check in the spec for its screen:

- Download cards widened the page (and clipped the queue sheet) when one title was long; the card list grid track now has a zero minimum.
- Failure group chips with a long album name stretched across the page or wrapped and were clipped; they cut to one line.
- The Queue tab label broke onto two lines on a phone; tab labels no longer wrap.
- The destination warning triangle sat on a line of its own on album pages and cards; it now sits beside its link.
- Playlist cards let a long name run under the play button; the name cuts short of the controls.
- The add to playlist sheet let long playlist and song names run past its edge.
- The genre and year menus pushed a phone page sideways; they fit their filter now.
- The library tracks view printed the same note under both Play all and Shuffle; one note covers both.
- The library home view said "Loading home…"; it says "Loading albums…".
- An album or playlist heading said "0 songs" while its songs were loading; the count waits.
- Downloads showed "No queued downloads" under the error when the queue could not be read; only the error shows.
- Diagnostics marked a finished scan "Not ready" beside "Scan complete"; a finished scan counts as ready.
- "1 fans", "1 albums", "1 songs" and "1 songs already in library" are singular when the count is one.

Looked at and left as they are: the search empty state, the catalog error with retry, the library empty, unconfigured and unavailable panels, the Now Playing empty state, the queue dock, source paused banner, history empty state, Settings dirty state, the reconnecting, connecting and offline banners, the command palette, the full screen stage and the mobile mini player.

Still open after the walk:

- A path outside the allow-listed screens (for example `/nope`) gets the backend's JSON 404, so the app's own "Page not found" screen only appears under `/library`. The backend tests assert that 404, so it was left alone.
- Search sections still offer "View all" when they have no results.
- Settings renders its section headings and the "Settings are up to date" bar before settings have loaded or when they fail to load.
- A library request failure retries for several seconds before the inline error appears, and the loading line sits above the "Fresh in your library" heading rather than under it.
- Long titles in the Now Playing "Up next" list wrap across several lines on desktop.

## Phone walk, 11 September 2026

A second temporary Playwright script visited every screen at 390 by 844 and 360 by 780 with touch emulation against a local uvicorn backend serving the built frontend, using the same invented catalog, library, player and queue fixtures with long titles and a three-job queue. Each screen was screenshotted and probed for page-level sideways scroll, elements past the viewport edge, text under 11px, text controls under 16px and tap targets under 44px. Screens covered the same list as the desktop walk plus the download options popover, the artist download sheet, a preview and a library track in the footer, the playlist picker, the queue sheet, the genre menu, the playlist form and a dirty Settings form.

Fixed in that pass, each with a check in `e2e/phone.spec.ts` or the spec for its screen:

- The footer player took two or three rows (114 to 160px) on top of the 64px bottom bar, and rendered even with nothing playing. It is now a one-row mini player with a seek bar along its top edge, hidden while idle. Previous, shuffle, repeat, like, volume and add to playlist moved to the Now Playing stage and page.
- The queue dock and the Settings save bar were placed from the footer height alone, so both sat behind the footer on a phone; the save bar was invisible with unsaved changes. Both now add the bottom bar and home-indicator inset. On a phone the dock is replaced by a count on the Downloads item in the bottom bar, since a floating pill covered the Save button and the last row's controls.
- The five library tabs overflowed sideways with Playlists cut off, and the four download tabs with counts wrapped at 360px; both fit one row now.
- The track row's format select left a long title about 108px; on a phone the format lives in the download options popover and the title has the row.
- The search input, settings fields, format and filter selects and playlist inputs were 11 to 13px, which makes iOS Safari zoom the page when one gains focus; touch screens now get 16px text controls.
- Footer and stage icon buttons were 36px on touch screens (a more specific desktop rule beat the touch rule), the play button 35px, card play 38px, chips, tabs, text links and inline Retry buttons under 30px; all are 44px on touch screens, with the touch rules last in the stylesheet so they win.
- The artist download sheet was a centred box whose album list scrolled with nothing to say so; on a phone it is a bottom sheet with a fade above its sticky footer, and a long mount path no longer widens its Download to select, or the download options popover's.
- The explicit badge was the first thing cut off beside a long track title; it stays visible after the ellipsis.
- The Library's inline load and detail errors had no styling at all.
- 7 to 10px text (welcome tag, footer byline, ownership badges, event times, save bar status, artist download eyebrow) is 10 to 12px on phones, and the unused welcome, record, setup grid and queue pill rules are gone.
- The page declares `viewport-fit=cover`, and the bottom bar, footer, sheets and top bar pad by the safe-area insets so a phone installed to the home screen keeps its controls clear of the home indicator and notch.
- Inner scrollers (track lists, the lyrics panel, filter menus, sheets and popovers) contain overscroll so a flick does not carry into the page, and the virtual track and job lists size themselves from the room left under the top bar and above the player and bottom bar.

Looked at and left as they are: inline text links (track titles, artist links, the destination path) stay text-sized, as WCAG allows for links in running text; the playlist picker stays a centred modal because a bottom-anchored sheet with a text field at its foot sits under the on-screen keyboard; the Now Playing hero heading still wraps a very long title across several lines.

Not verified on a device: the safe-area insets and the 16px zoom rule were reasoned from platform behaviour and checked only for their CSS effect in Chromium emulation, which reports no insets. A real notched iPhone in standalone mode and an Android phone with the keyboard open still need a look.

## Known limits

Library album genre and year filters still apply to the pages loaded so far; only the tracks view filters and sorts on the server. Catalog search on the Search page is unchanged and says so in its own hint. Navidrome's saved play queue holds 500 songs, so Play all and Shuffle over a larger library play a 500-song selection. Whole-library track browsing reads up to 10,000 songs from Navidrome, so a library beyond that size describes the first 10,000 it returns.

Track navigation checks added on 10 September 2026 cover highlighted row focus (including tracks outside the initial virtual window), aria-current marking, "Back to results" restoring search state, and no-preview state showing disabled controls and labels. These join the existing automated browser regression suite.

Settings draft preservation is implemented with conflict detection (row notices when a value changes elsewhere), navigation guards (blocker for in-app links and beforeunload for tab close), and separation from the live query cache so SSE events do not erase unsaved forms. `e2e/app.spec.ts` includes a test that edits library label and folder naming without saving, then injects library scan/cancel, a concurrency PATCH (waits for SSE round trip), and a library label PATCH, asserting drafts survive each event, the conflict notice appears under the patched field, and the saved state is not shown until the form is saved. A second test verifies the navigation guard blocks in-app link clicks (dismissing the dialog leaves the draft intact, accepting allows navigation). The Downloads concurrency select's save sends only the draft key to avoid interfering with a dirty Settings form.

## Accessibility

Checked 10 September 2026. Automated and manual accessibility checks cover keyboard navigation, touch targets, screen reader support, contrast and zoom.

**Automated checks (e2e/a11y.spec.ts):** Run axe-core accessibility audits on every route (search, library, library album page, downloads, settings, diagnostics). All routes pass axe checks with no violations.

**Keyboard navigation:** Virtual lists (tracks, download queue) maintain focus without remounting on filter changes, with deliberate scroll reset when filters actually change. Escape key closes FilterMenu popovers. All icon-only buttons have aria-label attributes. TrackList uses stable keys to avoid losing focus on filter keystrokes.

**Touch targets:** Under `(pointer: coarse)` media query, all interactive elements meet 44px minimum: icon buttons, job buttons, text preview button, download action select, row actions, tabs, chips, text links, inline Retry buttons, filter rows and form controls. The touch rules are the last block in the stylesheet so they outrank the size each control sets for itself. Text controls are 16px on touch screens so iOS Safari does not zoom on focus. Desktop density unchanged.

**Screen reader:** Virtual lists announce with role="region" and aria-label. Queue count changes announce via aria-live="polite" live region. Library tabs carry aria-pressed state. TrackRow elements have aria-current when selected.

**Contrast and text size:** Minimum text size raised from 9px to 10px for .nav-link and .connection at narrow widths to meet WCAG AA minimums.

**Dynamic layout:** Player footer height tracked via ResizeObserver and published as --player-height CSS variable. Save bar, queue dock, main padding and the virtual lists derive offsets from this variable plus --nav-height (the phone bottom bar) and the safe-area insets, to prevent overlap when footer height changes (library track playing, connection banner shown, error expanded, footer hidden while idle on a phone).

**Manual checks still needed:** Screen reader announcement quality across all flows (not just presence of ARIA attributes). Keyboard-only navigation completeness across all interactions. Focus visibility under different browser/OS high contrast modes. Touch target effectiveness on actual touch devices (automated check verifies size only).

## Further coverage

Automate card success/retry against a fixture API, coverage loading/failure and filter reactivity, slider keyboard behavior, close during a pending lookup, activity clear racing with a new event, and the player/queue at small and tablet widths. Do not treat this targeted browser pass as the full release acceptance suite.
