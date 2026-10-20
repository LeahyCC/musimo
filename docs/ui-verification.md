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

`e2e/library-controls.spec.ts` and `e2e/playlists.spec.ts` cover the Library work added on 9 September 2026. The tracks view is checked for sending its query, genre, sort and shuffle to the server and for offering whole-library filter choices; a track's play button is checked for turning into a pause button and back; an artist page is checked for album release years, album and song sort orders and the popularity chart's summary. The playlist checks cover the liked playlist leading the list with no delete control, the delete control appearing only on hover, the public/private filter, a playlist's song count, play, rename and non-duplicating add, and the picker being centred in the viewport, toggling Add to Remove, listing a playlist's songs in a fixed-height area, removing one of them, and the playlist page showing that change without a reload. Additional checks verify that the phone's library view chips carry aria-pressed state that updates when switching views, that Classic's toolbar chips are 36px, and that the Listening room's strip shows counts and its filter chips remove and add filters.

`e2e/player.spec.ts` covers the loading transition check. `e2e/now-playing-popout.spec.ts` checks the Now Playing hover and idle stage on desktop Chromium only, and the two-column layout: the tabbed panel beside the stage with everything inside the window, every footer control on the page, the footer hidden with `--player-height` at `0px`, the picker still opening, a short window keeping the controls in view, the tabs and their arrow keys, and the phone's full-width stage with the tabs under the controls and no mini player. `e2e/phone.spec.ts` checks the mini player steps aside once Now Playing opens from it, and `e2e/themed-walk.spec.ts` expects no footer on that route.
`e2e/download-failures.spec.ts` adds a nine-failure queue: it checks infinite scrolling, failure explanations and retry counts, error hints link to the relevant setting or diagnostic, done jobs with warnings show the count in their heading, the group chips split album no-matches from single tracks, errors are grouped by cause with the fix link on the group, Clear no match and Clear all finished call their queue commands, and that download cards flow inside one offset container rather than each carrying its own absolute position. That last check is the structural guard against overlapping cards. The overlap itself could not be reproduced by sampling scroll frames, so it is guarded by layout rather than by measurement; per-card absolute offsets could place a card over its neighbour whenever a measured height had not landed, and grid flow cannot. Additional checks verify that download errors on the last visible row at mobile viewport remain fully visible within the virtual list container, and that the History tab shows an empty state when no jobs have finished.

The tidy-screens work adds these specs. They describe what each one asserts; a run of them is recorded with the change that ships them, not here.

- `e2e/app.spec.ts`: Settings and Diagnostics both read ready after a `done` scan and both read "needs attention" after a `failed` one (a fixture Diagnostics response, so the answer does not depend on the machine); the Settings screen has no `.save-bar` and no Save changes button until a field is edited, and neither shows while settings are loading or have failed; a fixture feed of twelve, one and two events collapses to three rows, the first with ×12, and its button opens and closes the run's events.
- `e2e/download-failures.spec.ts`: a no-match job is on the No match tab, which offers Clear no match and no Retry all; Clear all finished on the Done tab sends nothing when the confirm is dismissed and sends `clear-finished` when it is accepted, and an empty queue shows Parallel downloads, Pause all and Cancel queued with no tab offering to retry or clear.
- `e2e/home.spec.ts`: a new install shows the four starter artists and neither new section; remembered searches replace the starters, a chip searches again and Clear empties the list and brings the starters back; a search that stands for a moment is stored, capped at eight; the newest library albums show under the hero and open their album page.
- `e2e/library-controls.spec.ts`: Tracks sorted A to Z has no number column and clamps the album name to two lines (`-webkit-line-clamp: 2`, checked on desktop only since a phone hides the album), and album order brings the numbers back.
- `e2e/playlists.spec.ts`: a playlist whose songs carry album numbers 5, 4, 5, 3, 3 is numbered 1 to 5, and an album page still shows its own numbers.

Unit tests (`vitest`) cover the shared readiness rule (`readiness.test.ts`), the feed grouping (`activity-runs.test.ts`) and the remembered searches (`recent-searches.test.ts`).

The frontend production build and focused backend tests pass. The separate testing task owns broader browser regression automation and CI. [Download verification](downloads.md) records worker/publication/recovery checks, including the permitted fixture that appeared in the library.

## Visual walk, 10 September 2026

A temporary Playwright script visited every screen at 1280 by 800 and 390 by 844 against the isolated CI stack, using the shared search, library, player and queue fixtures with invented long titles, and saved a screenshot per screen. Each screenshot was inspected by eye, with a probe reporting page-level sideways scroll and any element wider than its box. Screens covered: home, search results on the Top, Tracks, Albums and Artists tabs, no results, catalog error and loading, an album with a highlighted track and a playing preview, an artist page with both download sheets, album loading, missing album, library home in grid and list layout, albums, artists, tracks with the genre and year menus open, playlists, a playlist page with rename and add-song search, a library album and artist and its All songs view, Downloads queue, done, failed with a batch group selected, history, the queue dock and sheet, source paused, empty and unreadable queue, Settings clean, dirty, loading and failed, Diagnostics and its failure, Now Playing with a library track, the hover controls and the full screen stage, the command palette with and without matches, the mobile mini player, the add to playlist picker, and the empty, unconfigured and unavailable library states, plus the reconnecting, connecting and offline banners.

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
- A library request failure retries for several seconds before the inline error appears, and the loading line sits above the "Fresh in your library" heading rather than under it.

Closed with its Tailwind phase: Settings no longer renders its section headings or the "Settings are up to date" bar before settings have loaded or when they fail to load; `e2e/app.spec.ts` covers a delayed and a failed `/api/settings` response. Now Playing's "Up next" list cuts a long title, artist or album to one line with an ellipsis, the way the playlist picker rows already did, and the hero heading stops a very long title after three lines at its full size (today the title sits under the stage and stops after two; see [the popout note](now-playing-popout.md#layout)).

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

Looked at and left as they are: inline text links (track titles, artist links, the destination path) stay text-sized, as WCAG allows for links in running text; the playlist picker stays a centred modal because a bottom-anchored sheet with a text field at its foot sits under the on-screen keyboard.

Not verified on a device: the safe-area insets and the 16px zoom rule were reasoned from platform behaviour and checked only for their CSS effect in Chromium emulation, which reports no insets. A real notched iPhone in standalone mode and an Android phone with the keyboard open still need a look.

## Track rows and album cards, 19 September 2026

Every desktop track row carried a badge, Preview, a format select, a grey tick and a kebab, and every album card repeated "to /library · Original source quality". Changed in `frontend/src/features/downloads/downloads.tsx`, `search.tsx` and `download-target.tsx`, with checks in `e2e/cards.spec.ts`, `album.spec.ts`, `download-options.spec.ts` and `app.spec.ts`:

- The format select left the row on every screen; the options popover, already used on phones, holds Format beside Download to. The row is the badge, Preview, one download button and the kebab. The chosen format is on the button's tooltip and accessible name.
- An owned track shows its badge and no disabled tick. Edition matches, queued and downloaded-earlier badges, the retry state and the per-download override are unchanged.
- Album cards lost their destination line. It shows once above each grid ("Downloads go to /library · Original source quality", with the warning icon when the folder is not writable) and stays on the album page header.

Not run: this change was written without a shell, so the specs and a browser check of the desktop row, the popover and the grid line still need a pass.

## Library detail headers, 19 September 2026

A walk of the live app found that a library album page showed the big "Library" heading and the view tabs, then only a small album title and "1 song": no cover, artist or year. The artist page had a small avatar and a count, and the playlist page a title only.

Changed: the album, artist (and its All songs view) and playlist pages now share one header component, laid out like the catalog album page. The album header shows the cover, "ALBUM · year", the title, the artist as a link, and song count, length and genre; the artist header a large round photo with album and song counts; the playlist header a mosaic or first cover, owner, length and public or private. The page heading and eyebrow are dropped on these pages and the tabs shrink to a slim row with the back link. Long titles clamp to two lines. A phone first stacked the cover over the text; that pushed the track list below the fold and was changed in the next section. The description of each header is in [the player note](player.md).

Also changed with it: the title is now the page's `h1` (it was an `h2` under the Library `h1`), and the "Add songs" and "Popularity" headings moved from `h3` to `h2` so the heading order stays unbroken for axe.

Checks added, all on mocked library routes:

- `e2e/library-controls.spec.ts`: the album header's cover, "ALBUM · 2018", artist link, meta line and actions, no "Library" heading, and the header starting within 60px of the tab row; the artist header's photo, eyebrow and counts, kept in All songs.
- `e2e/playlists.spec.ts`: the playlist header's eyebrow, owner, cover, meta line and buttons; the four-cover mosaic and the single-cover fallback.
- `e2e/themed-walk.spec.ts`: each detail route under the light theme shows its eyebrow, a cover and the artist link, with no axe violations.
- `e2e/phone.spec.ts`: a long title clamps to two lines and nothing scrolls sideways at 360px (the stacking check this bullet first described was replaced, see the next section).
- `e2e/a11y.spec.ts`: axe on the album, artist and playlist pages.

Not yet verified in a browser: this change was written in an environment with no shell, so the builds, the specs above and a screenshot pass at desktop and 360px have still to be run.

## Phone first screens, 19 September 2026

Measured at 390 by 844, the Library's page title, tabs, search, three filters, count and view toggle filled the first screen and the first album was a sliver. Search results put the first track about two thirds of the way down, and a library album page's stacked 150px cover left the track list below the fold.

Changed, on a phone only unless noted (details in [the player note](player.md) and [the search note](search.md)):

- Library list views: one row with the search field and a Filter button. Sort, Show, Genres, Years, the grid or list toggle and Clear filters are in a bottom sheet; the button shows "Filter (n)" for n active filters. The loaded count reads under the list. The page title takes the small heading size.
- Search results: no eyebrow, "Results for" at the small heading size, Filters and Sort on one row under the tabs.
- Search results, every width: the "Filters and sort apply to loaded results…" line is gone and its text is help inside the Filters panel. A search where every section is empty shows one "No results for “query”" message instead of a stack of per-section ones.
- Library album, artist and playlist headers: a cover of about 104px beside the text, the actions on their own row under both.

Checks added or rewritten:

- `e2e/phone.spec.ts`: the header puts the cover (96 to 112px wide) beside the title, the actions row below both on the cover's left edge, a long title clamps, no sideways scroll at 360px; the first track row is inside the viewport, clear of the mini player, at 390 by 844 with a player loaded; the Library's first album card starts above 45% of the screen height and the Filter sheet holds Sort, Genres, Years and the view toggle with no control under 44px or under 16px text and no sideways scroll at 360px; the first search result row starts above 50% of the screen height, Filters and Sort share a row, and the hint is only visible once Filters is open.
- `e2e/cards.spec.ts`: on a phone the first search album card starts above 45% of the screen height.
- `e2e/app.spec.ts` (every project): an empty search shows "No results for “Zzzyx”." once and no "match this search" lines, on Top and on a single tab; the hint sits inside the Filters panel.
- `e2e/library-controls.spec.ts`, `e2e/player.spec.ts` and `e2e/playlists.spec.ts` open the Filter sheet on the phone project before reaching Sort, Genres, Years, Show, the playlist filter or the view toggle (`openLibraryFilters` and `closeLibraryFilters` in `e2e/library-fixtures.ts`), and the tracks spec checks the "Filter (1)" button label.

Not yet verified in a browser: this change was written in an environment with no shell, so the type check, lint, the specs above and screenshots at 390 by 844 and 360 wide have still to be run. The layout numbers (45% and 50% of the screen, the 104px cover) are estimates from the code's own heights until then.

## Music bot preview and confirm, 17 October 2026

The chat's result card now shows a stored proposal revision: an overview of its songs, about six representative songs for a long list with the whole list behind See all, and a stale or unknown-outcome panel in place of the actions when a confirmation did not go through. Screenshots from the four generated files in the isolated stack: [the preview](assets/music-bot-preview.png) and [a stale one after a like was removed](assets/music-bot-preview-stale.png).

Checked in Chromium, WebKit and the 390px mobile project, two runs each, in `e2e/music-bot.spec.ts`, `e2e/music-bot-pet.spec.ts`, `e2e/music-bot-proposals.spec.ts` and `e2e/queue-editing.spec.ts`: no page-level sideways scroll with a 20-song sample open; See all and Show the sample reached with the keyboard (Enter on the focused button) and `aria-expanded` set; the stale and unknown panels announced as alerts, with their only button a normal-height control (44px on a coarse pointer); axe clean on the card after a save; the card readable at 390px (screenshot inspected). Firefox could not launch on the machine that ran this, so it was not run. The Windows 95 list view only had the existing theme walk, which still passes in Chromium; the new panels have no Windows 95 specific check.

## Octive on a phone, 19 October 2026

A temporary Playwright script screenshotted `/music-bot` and the pet's chat sheet in both layouts at 320 by 568, 375 by 667, 390 by 844 and 430 by 932 with touch, against the isolated CI stack, using the mocked chat, proposal and player fixtures: no model, an empty chat, a long conversation, a 20-song card with See all open, a stale preview, Chat settings and a reply in flight. Found before changing anything:

- Classic page: the header took three rows (title, then Settings and Clear chat wrapped onto a row of their own, then the Model chip and Look in), about 250px of an 844px screen. The starter chips stayed above the box under a conversation, the footnote was two lines ending "Enter to send", and the pet perched on the mini player stood on that footnote. The page's 420px minimum was taller than the room at 320 by 568, so the box and Send sat under the mini player and Send could not be tapped.
- Listening room page: the Draft panel sat in the page under the chat, behind the floating mini player and tab bar, with the pet on it. Opening it made the page about 1,700px tall, so the box scrolled away and the card's actions sat under the mini player. The chat had 181px at 390 by 844 and none at 320 by 568.
- Both sheets: the card sat in from the reply's pet face, and a song row gave its title about 100px at 390 and 25px at 320 ("A r…"). Look in's buttons were 40px on touch.
- Nothing read `window.visualViewport`, so nothing kept the box above an on-screen keyboard or the newest message in view when the log shrank.

Changed (details in [the player note](player.md#on-a-phone)): one phone page for both layouts, fixed between the top bar and the player, with a single header row, Look in on the next, the card inline, no starter chips or footnote, and no perched pet on that page; the card's songs carry their length beside the artist; Look in is three 44px buttons across the row; `useKeyboard` seats the page and the sheet on the keyboard and hides the bars while it is up; the log follows its newest message when it shrinks.

Checks added in `e2e/music-bot-phone.spec.ts` (mobile project, both layouts): at 320 by 568 and 390 by 844 one header row, no Model chip, 44px Look in buttons inside the width, no perched pet, no Prompts or "Enter to send" under a conversation, no Draft, the box clear of the bars with Send the element under a finger, the log at least a third (320 by 568) or half (390 by 844) of the screen, a song title at least 90 or 160px wide, the card's Play inside the width and no sideways scroll. A stand-in `visualViewport` raises a 336px keyboard: `data-keyboard` set, no bar shown, the box on the keyboard's edge, the log at its newest message, and the bars back when it goes. The sheet: titles at least 160px, no footnote, the sheet and its box above the keyboard. `lib/keyboard.test.ts` covers the geometry. The Draft panel test in `e2e/music-bot-edits.spec.ts` now runs on wide windows only.

Not checked on a real phone: the keyboard handling was tested with a stand-in visual viewport in Chromium, which has no on-screen keyboard. iOS Safari's own scroll when a field takes focus, the keyboard's animation, the predictive-text bar, and Android Chrome were not seen. The Windows 95 skin's phone chat was left as it was.

## Known limits

Library albums, artists and tracks filter and sort on the server; playlist sorts still apply to the loaded list. Catalog search on the Search page is unchanged and says so in the help inside its Filters panel. the library's saved play queue holds 500 songs, so Play all over a larger library plays the first 500. Shuffle plays the whole filtered library, past the 50,000 song browse cap as well: the queue holds a window and the server fills the next one as it plays. Whole-library track browsing reads up to 50,000 songs from the library, so a library beyond that size describes the first 50,000 it returns.

Track navigation checks added on 10 September 2026 cover highlighted row focus (including tracks outside the initial virtual window), aria-current marking, "Back to results" restoring search state, and no-preview state showing disabled controls and labels. These join the existing automated browser regression suite.

Settings draft preservation is implemented with conflict detection (row notices when a value changes elsewhere), navigation guards (blocker for in-app links and beforeunload for tab close), and separation from the live query cache so SSE events do not erase unsaved forms. `e2e/app.spec.ts` includes a test that edits library label and folder naming without saving, then injects library scan/cancel, a concurrency PATCH (waits for SSE round trip), and a library label PATCH, asserting drafts survive each event, the conflict notice appears under the patched field, and the saved state is not shown until the form is saved. A second test verifies the navigation guard blocks in-app link clicks (dismissing the dialog leaves the draft intact, accepting allows navigation). The Downloads concurrency select's save sends only the draft key to avoid interfering with a dirty Settings form.

## Accessibility

Checked 10 September 2026. Automated and manual accessibility checks cover keyboard navigation, touch targets, screen reader support, contrast and zoom.

**Automated checks (e2e/a11y.spec.ts):** Run axe-core accessibility audits on every route (search, library, library album, artist and playlist pages, downloads, settings, diagnostics), once in Classic and once in the Listening room. All routes pass axe checks with no violations.

**Keyboard navigation:** Virtual lists (tracks, download queue) maintain focus without remounting on filter changes, with deliberate scroll reset when filters actually change. Escape key closes FilterMenu popovers. All icon-only buttons have aria-label attributes. TrackList uses stable keys to avoid losing focus on filter keystrokes.

**Touch targets:** Under `(pointer: coarse)` media query, all interactive elements meet 44px minimum: icon buttons, job buttons, text preview button, download action select, row actions, tabs, chips, text links, inline Retry buttons, filter rows and form controls. Each primitive carries its own `coarse:` 44px rule; the 16px text rule for inputs is the last block in the stylesheet, outside every cascade layer, so it outranks the size each control sets for itself. Text controls are 16px on touch screens so iOS Safari does not zoom on focus. Desktop density unchanged.

**Screen reader:** Virtual lists announce with role="region" and aria-label. Queue count changes announce via aria-live="polite" live region. Library tabs carry aria-pressed state. TrackRow elements have aria-current when selected.

**Contrast and text size:** Minimum text size raised from 9px to 10px for .nav-link and .connection at narrow widths to meet WCAG AA minimums.

**Dynamic layout:** Player footer height tracked via ResizeObserver and published as --player-height CSS variable. Save bar, queue dock, main padding and the virtual lists derive offsets from this variable plus --nav-height (the phone bottom bar) and the safe-area insets, to prevent overlap when footer height changes (library track playing, connection banner shown, error expanded, footer hidden while idle on a phone, or hidden on Now Playing at every width, where `--player-height` reads `0px`).

**Manual checks still needed:** Screen reader announcement quality across all flows (not just presence of ARIA attributes). Keyboard-only navigation completeness across all interactions. Focus visibility under different browser/OS high contrast modes. Touch target effectiveness on actual touch devices (automated check verifies size only).

## Themed walk, 17 September 2026

The Tailwind migration is finished, so every route was walked under the light fixture theme from `e2e/theme-fixtures.ts`, at 1280x800 and at 390x844 (the iPhone 13 phone project). `e2e/themed-walk.spec.ts` does this on every run now: eighteen routes (search results, search tracks, album, artist, library home, albums, album, artists, artist, artist songs, tracks, playlists, playlist, Now Playing, Downloads, Settings, Your settings and Diagnostics), each with a restored queue so the footer player shows. It checks that the page, the sidebar or bottom bar, the player and the first card or panel no longer paint the default theme's colors, runs axe, and saves a full-page screenshot.

All 40 passed (20 routes, Chromium at 1280 by 800 and the phone project at 390 by 844) with no axe findings. Every screenshot was looked over for a dark patch. There were none: the only dark areas are the fixture artwork placeholders and the Now Playing stage, which draws on `--color-media` and `--color-on-media` by design so it stays readable over any picture. Nothing escaped the tokens, so no component needed a fix.

One thing the walk did catch was in the test fixtures, not the app: a glob of `**/api/artists/7*` does not match `/api/artists/7/top`, so the artist page's popular songs went to the live provider. The walk's search fixture uses a regex instead.

## Both layouts, 18 October 2026

The UI refactor gave the app two layouts, picked in Settings › Yours: Classic (sidebar, top bar and a footer player) and the Listening room (a 72px icon rail, a page header with its own title, and the player docked on the right; on a phone a floating mini player above a five-tab bar with Queue as the fifth tab). This pass walked every route in both.

**Walk.** Twenty-three routes (home, discover, search, search tracks, search podcasts, podcast, album, artist, the library albums, album, artists, artist, artist album, artist songs, tracks, playlists and playlist views, Now Playing, Downloads, Settings, Octive, Your settings and Diagnostics) at 1280x800, 390x844 and 360x800, under the built-in dark theme and the light fixture theme, in Classic and in the Listening room: 276 pages against the isolated stack, each with a restored queue so the player shows and the library, search and player calls served from fixtures. For each page the walk read whether the document scrolled sideways, how many headings of level 1 were visible, and axe, and every layout and theme was looked over in screenshots. No page scrolled sideways and every page had exactly one visible h1. Axe found one thing, a contrast failure in the Listening room's Home on the dark theme (the song count under a playlist tile used `faint` on the hover surface); it now uses `muted`.

**Fixed in the pass.**

- In the Listening room the page name showed twice, in the header and again as the page's own heading. Downloads, Settings, Your settings and Diagnostics now keep the header's title and draw their heading for screen readers only (`PageTitle` does this for every page that uses it), so each page has one h1 and one visible title.
- Choosing a layout with the arrow keys in Settings › Yours used to lose focus, because the whole shell remounts. Focus now returns to the chosen layout radio, and the two radios sit in a group labelled Layout.
- With Follow system on, a theme card could announce the light half while the device was dark. The cards now show and announce the half on screen, and the button's name carries it ("Use Slate dark").
- The Diagnostics banner said "All systems ready" while some checks were only notes. It does so only when every check passes; otherwise it reads "Ready to download. 4 of 6 checks pass; the rest are notes, not faults."
- The hint under Show on Now Playing says "Art / MilkDrop switch" in the Listening room and "Visualizer button" in Classic.

**Automated.** `e2e/themed-walk.spec.ts` and `e2e/a11y.spec.ts` now run every route in both layouts. The themed walk checks the page, the nav (the sidebar, the room's rail, or the phone's bar), the player and the first card against the light theme's own values, which differ by layout: the room's wide window docks the player on the sunken surface, its phone mini player is raised, and its phone tab bar is on the canvas. See [testing](testing.md#browser-and-container-checks).

**Left open.** Firefox still would not launch on this Mac after `npx playwright install firefox` (`Could not find profile folder`), so nothing here was run in Firefox. The pet cat, which floats over the bottom left of the page, covers a little of the content beside it on a phone (a search field on a playlist page, a card title on Home), so it was left alone.

## Phone layouts, 19 October 2026

A temporary Playwright walk visited nineteen routes in both layouts at 320x568, 360x780, 390x844 and 430x932 with touch emulation, plus 820x1180 and 1280x800, against the isolated stack, using the invented library in `e2e/showcase-fixtures.ts`. Each screen was screenshotted and probed for sideways scroll and elements past the right edge.

Found and fixed:

- Classic on a phone was 17px wider than the screen whenever a name was chosen: the name, the search form and the Ask Octive pill could not shrink, so a phone zoomed the whole page out and the bottom bar fell below the fold. The form can now shrink, the name is its initial in a circle, and the Octive pill is a round button with its words for screen readers.
- Settings, Yours drew the desktop shapes of both layouts on a phone. A phone now gets phone-shaped pictures of each layout's phone arrangement, side by side, and says the choice is for this phone.
- The two layouts were near copies on a phone. Classic now docks a cover-tinted mini player on its bar; the Listening room floats its tab bar as a pill with the mini player above it (now with a progress line) and fades the page out behind them.
- Now Playing on a phone sat under the top bar and above the tab bar, which pushed the transport below the fold at 320x568. It is now a screen of its own with a close chevron and "Playing from".
- Classic's Search page drew a second search box under the top bar's on a phone; it has one now.
- The Listening room's Library view tabs were cut off at 390px ("Playlists" out of sight). They share the width, each with its count under it.
- The library and playlist headers' "…" button wrapped onto a row of its own at 390px in Classic; the phone's action buttons are tighter.
- At 820px (an iPad held upright) Classic's search results toolbar ran past the page edge; it wraps now.

`e2e/phone.spec.ts`, `e2e/now-playing-popout.spec.ts`, `e2e/search-layouts.spec.ts` and `e2e/themed-walk.spec.ts` carry the new expectations (the docked strip and its tint, the 64px pill 12px in from the edge, the full screen Now Playing and its close, one search box). `npx playwright test phone now-playing-popout settings-layouts search-layouts themed-walk` passed on the Chromium and phone projects: 164 tests.

Not verified on a device: the floating pill and the full screen Now Playing were checked in Chromium emulation only, which reports no safe-area insets. A notched iPhone in standalone mode still needs a look.

## Further coverage

Automate card success/retry against a fixture API, coverage loading/failure and filter reactivity, slider keyboard behavior, close during a pending lookup, activity clear racing with a new event, and the player/queue at small and tablet widths. Do not treat this targeted browser pass as the full release acceptance suite.
