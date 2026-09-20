# Now Playing popout

Now Playing is a stage that can go full screen in the tab or pop out into a floating window above other applications, keeping the artwork and playback controls in reach wherever it sits. In the tab it sits beside the track's controls and a tabbed panel of Up next and Lyrics, in one of two sizes: Small, beside the panel, or Large, a theater layout that takes the page's width. The stage is a shell: it shows the artwork, or the [visualizer](visualizer.md) where the browser has WebGPU and it has been switched on, and the two swap without the shell caring. The stage and like button exist only for library tracks.

## Layout

This is the Small size, the default; see [Stage size](#stage-size) for Large. Two columns under the top bar that together fit the window's height, so nothing on the page starts below the fold. The artwork and the controls are on the left, one tabbed panel on the right.

```
desktop                                    phone (under 768px)

+--------------------+-----------------+   +------------------+
|                    | Up next | Lyrics|   |     artwork      |
|      artwork       |-----------------|   +------------------+
|      (square)      | Playing from .. |   | title, artist    |
|                    | next track      |   | like, add        |
+--------------------+ next track      |   | seek             |
| title, artist      | next track      |   | transport, vol.  |
| like, add          |  ... scrolls    |   +------------------+
| seek               |  inside itself  |   | Up next | Lyrics |
| transport, volume  |                 |   |  list            |
+--------------------+-----------------+   +------------------+
```

**Left column.** The square stage takes the height the column has left above its controls: as wide as the column, or as tall as that room, whichever is smaller, so a short window shrinks the square instead of pushing the controls down. Under it, in this order: the title (drawn here and nowhere else while the stage is docked; two lines, then an ellipsis), the artist and album as links, the like button and Add to playlist, the seek bar, and one row with shuffle, previous, play or pause, next, repeat, mute, volume and the close button. Close empties the player, as the footer's does, and the page then says "Nothing playing yet." These are `NowPlayingControls` in `now-playing-controls.tsx`. The docked stage keeps only its top bar (status, the Visualizer control, popout and full screen); the same transport is drawn over the picture only in full screen and in the popout window, which have nothing else to hold it.

**Right column.** One panel with two tabs, Up next and Lyrics, that fills the column's height. Each tab scrolls inside itself with `overscroll-contain`, so a long queue never moves the page; on Lyrics it is the lines that scroll, under the timing controls. Up next lists what comes after the playing track, so the playing track is not its first row, and a row still plays from its own place in the whole queue. Above the rows it says how many tracks the queue holds and, when the player knows where the queue came from, "Playing from" and its name: an album, an artist, a playlist or a tracks search. A queue restored after a refresh has no known source, so it says nothing. The player keeps only an id for the source, so the name comes from the same cached reads the library pages make. The chosen tab is remembered in the browser as `musimo.now-playing-tab` (`up-next` or `lyrics`).

The tabs follow the ARIA tabs pattern (`TabList` in `ui/tabs.tsx`): `role="tablist"`, `role="tab"` with `aria-selected`, only the chosen tab in the tab order, and the left and right arrows (and Home and End) move between tabs and choose as they go. Both panels stay in the document, so each tab's `aria-controls` names something that exists, and the one not chosen is `hidden`.

## Stage size

The docked stage has two sizes, Small and Large. Small is the layout above and the default. Large is a theater layout: the stage takes the full content width and as much height as the window gives, the title and the control row sit under it, and the tab panel moves below that, so the page scrolls to reach the tabs.

```
Small (default)                            Large

+--------------------+-----------------+   +------------------------------------+
|      artwork       | Up next | Lyrics|   |                                    |
|      (square)      |-----------------|   |   artwork, letterboxed             |
+--------------------+ scrolls inside  |   |   (visualizer fills it)            |
| title, controls    |                 |   |                                    |
+--------------------+-----------------+   +------------------------------------+
                                           | title, controls, seek, transport   |
                                           +------------------------------------+
                                             page scrolls
                                           +------------------------------------+
                                           | Up next | Lyrics                   |
                                           |  list, scrolls inside itself       |
                                           +------------------------------------+
```

**Large.** The stage and the controls share one window's height (`100dvh` less the top bar and `--page-pad`, and at least 520px), so the stage is the container less the controls: its width and the height they leave, not a square. Artwork is letterboxed by the same layers as ever, a sharp copy over a blurred fill, so nothing is cropped; the visualizer canvas fills the box, as it already does in full screen. The panel gets a window's height of its own (at least 420px), and each tab still scrolls inside itself. Only classes change between the two, so the stage is not remounted: the visualizer keeps running through the switch, and focus stays where it was.

**Switching.** A button in the stage's top bar beside full screen, named for where it goes ("Large stage" from Small, "Small stage" from Large), or `S` while the page has focus and no field does (`usePageShortcuts`; it works with the stage focused too, since the stage has no `S` of its own). The choice is remembered in the browser as `musimo.now-playing-size` (`small` or `large`), and Your settings has the same choice under Visualizer, reading and writing the provider's state (see [settings](settings.md#visualizer)).

**What it does not touch.** Full screen and the popout are one size, so the button is not drawn in either, and `S` does nothing in full screen. A phone (under 768px) has one size too: the button is not drawn, `S` does nothing, and the layout is the phone layout below whatever was chosen. The choice is kept there, not applied, so it is still Large on the desktop the same browser opens next.

## Lyrics

The Lyrics tab is `LyricsPanel` in `frontend/src/lyrics.tsx`, keyed by track so each track starts fresh. The lines come from `GET /api/player/lyrics/{id}`; each line's `start` is in milliseconds and the item's `synced` flag says whether they are timed.

```
+-------------------------------------------+
| Earlier 0.5 s   +1.0 s   Later 0.5 s   [] |  <- timing, large type
|                                           |
|   line that has passed        (dim)       |
|   line that has passed        (dim)       |
|                                           |
|   > the current line          (bright)    |  <- about a third from the top
|   next line                   (dim)       |
+-------------------------------------------+
```

**Synced.** The current line is the last one whose start has passed, taken from the player's position. It is bright with `aria-current="true"`; the rest are dim. The list keeps that line about a third of the way down its box. A wheel, touch drag, scrollbar drag or scrolling key stops the following for four seconds, then it moves back to the current line. Choosing a line ends the pause at once. Under `prefers-reduced-motion` the list jumps instead of scrolling smoothly, and the first placement when the tab opens is always a jump. Every line is a button, so it can be reached with the keyboard, and its accessible name is its text (an empty line is announced as an instrumental break and its time). Choosing it calls the player's `seek` with the line's start.

**Timing.** Earlier and Later move every line by 0.5 s a press, and the current offset is shown between them (`+1.5 s`; a positive offset shows lines later). It is kept per track in the browser as one JSON map, track id to seconds, under `musimo.lyrics-offset`. The map holds at most 200 tracks: the newest write goes last and the oldest entries are dropped first, and an offset of zero is not stored. Seeking by a line uses the offset too, so the line you pick is the line that lights up.

**Large type.** The button at the top right, or `L`, fills the panel with large lines. `L` works anywhere on the page unless a text field has focus, a dialog is open or a modifier key is held. From the Up next tab it opens Lyrics in large type. The mode is not remembered. `Q` goes back to Up next.

**Not timed.** Lyrics with no times, or a synced flag with no times in it, are plain text under a small "Not timed" note, with no highlight, no timing controls and no seeking.

**No lyrics.** The panel says "No lyrics found for this track." with a **Search again** button that asks the server again. A failed request says "Lyrics could not be loaded." with the same button.

**Ticking.** The player's position changes several times a second. The lyrics panel is memoised on its own props and only the list of lines reads the position, and each line is memoised on its own highlight, so a tick redraws no more than the two lines that change. The player context itself still carries the position, so the page's other consumers (the seek bar above all) redraw with it as before; moving the position out of that context is left for later.

**Phone.** The lines sit in a box of their own (up to 60% of the screen height, 75% in large type) so the list has something to scroll and follow, even though the page scrolls for the rest.

**Fitting the window.** The page is `100dvh` less the top bar and `--page-pad` tall (`main`'s top padding of 36px, or 48px from 1500px, plus 24px at the bottom). `main` also pads its bottom by 130px to clear the footer player, which this page hides, so the page takes back all but 24px of that with a negative margin. If that padding ever changes, the two must change together.

**Phone.** Under 768px there is one column and the page scrolls. The stage takes the full content width, the title and controls follow, and the same two tabs sit directly beneath them, so Lyrics is one tap from the controls however long the queue is. The panel grows with its content and the page does the scrolling; there is no scroll box inside Up next. The lyrics are the exception (see [Lyrics](#lyrics)). The volume slider is left to the device's own buttons, as on the footer's mini player.

**While popped out.** The stage slot shows the dimmed artwork with Bring back, and the left column still shows the title and the whole control row, so the tab is never left without transport.

**The footer player** is hidden while a library track is on this page, at every width, because the page has every control the footer has: like, Add to playlist, seek, previous, play or pause, next, shuffle, repeat, mute, volume and close. If a control is ever added to the footer, it has to be added here in the same change, or the footer has to stay. On a phone the mini player steps aside too. Where a catalog preview is playing the page says so, and that Now Playing and its visuals play with library tracks, and the footer stays, because its controls are the only ones the preview has. Leaving the page brings the footer back. See [the player note](player.md) for how `--player-height` follows it.

**Status lines.** The footer's status line is repeated on the page, under the control row, only for errors and confirmations: a track that will not play, a playlist just created. "Your Navidrome library" and "Queue restored. Press play to continue." say what the title, the Playing from line and the play button already say, so the page leaves them in the footer (`isPassiveNotice` in `player.tsx`). The WebGPU notice keeps its once-per-browser rule (see below), so a returning visitor sees no line under the stage.

## Now Playing

The stage shows the visualizer, or the current track's artwork: a sharp, letterboxed copy of the cover over a blurred, cropped fill of the same image. Artwork is the default, even where WebGPU is available, because the visualizer is heavy on the GPU; a browser that already stored a choice keeps it. The docked stage stops drawing the visualizer while the tab is hidden or the stage is scrolled out of view, showing the artwork instead, and mounts it again when it is visible (the popout counts as visible while open); audio is unaffected. It rests the same way once playback has been paused for more than 10 seconds, in the docked stage and the popout alike, and comes back on play; a shorter pause keeps the picture. See [the visualizer note](visualizer.md#when-it-draws). Where WebGPU is available a labeled **Visualizer** button with an On or Off state and a `V` hint, at the top left under the status line, or V itself, switches between the two; the choice is remembered in the browser as `musimo.now-playing-view`. That control is not part of the bars that fade: while music plays and the stage is idle it drops to 70% opacity and stays, so the toggle is always findable. In full screen it fades away with the rest, to keep the visuals clean. While the visualizer shows, the current preset's name sits beside it between small `[` and `]` hints (hidden on a phone, like every `Kbd`), and the name is the preset select itself, so clicking it opens the list, grouped by scene. In the top bar, the scene's size control, the fluid's grid, sits with the scene select, Fluid or Kaleidoscope. A preset carries a scene and choosing either moves the other, so the two are never left disagreeing, and the grid control is drawn for Fluid only. Kaleidoscope can also run on WebGL2, but the stage still asks for WebGPU before it mounts, so a browser without it gets the artwork for both scenes. `[` and `]` walk the presets either way and wrap, and the choice is remembered as `musimo.visualizer-preset`. Without WebGPU, or if the device cannot be had, the stage shows the artwork and says so in a short notice under it, once per browser. Hovering the stage reveals a status line and the popout, size (docked only; see [Stage size](#stage-size)) and full-screen buttons along the top. Only in full screen and in the popout window does it also reveal the player's controls along the bottom (artwork, byline showing artist and album, like, previous, play, next, position, shuffle, repeat, mute and volume); docked, the page's control row under the stage holds them. The bars fade after two and a half seconds without movement while music plays and the pointer leaves the stage, and the cursor hides with them. They stay while paused or while the pointer rests on a control.

## Backdrop and track changes

**The wash.** A soft wash sits behind the page, taken from the cover. `NowPlayingWash` (`now-playing-wash.tsx`) reads the cover on a 24 by 24 canvas that is never attached (`sampleCover` in `cover-color.ts`; covers are same-origin through `/api/player/art/`, so the canvas is never tainted) and `dominantColor` picks the most represented colour: pixels are grouped into coarse buckets, a saturated pixel counts for up to three times a grey one, and near-black, near-white and see-through pixels are skipped. The colour is then mixed into the theme's canvas by `washFor` (`wash.ts`) rather than used as it is: it starts at a 30% mix and backs off in 3% steps until every text colour the theme reads on `--color-canvas` (the pairs in `CONTRAST_PAIRS` in `theme/contrast.ts`) is still at WCAG AA, 4.5:1. A pair the theme already has under 4.5 on the plain canvas may not get worse. This holds in light and dark themes alike, and it is worked out again when the theme changes. If no mix passes, there is no wash.

The wash is a vertical gradient from that colour at the top to nothing at the bottom, over the content area only (under the top bar, beside the sidebar; the whole width on a phone). It is `fixed`, behind the page (`-z-10`), has no pointer events and is `aria-hidden`. The colour is a runtime value, so it is handed to the element as the custom property `--now-wash` and not written in source; `no-raw-colors.test.ts` still passes. Any failure (the cover does not load, no canvas, a grey cover) is no wash and never an error. Finished reads are kept for the session, so a track that comes round again is not read twice.

**Cross-fade.** When the track changes, the artwork and the wash each cross-fade over about 300 ms (`FADE_MS` in `use-leaving.ts`). The new one is drawn at once and the old one stays on top with the `.leaving` class and fades out (`@keyframes leave` in `style.css`), then is removed. Under `prefers-reduced-motion` the old layer is never drawn, so the change is a cut. The visualizer is not cross-faded.

**Right-click menu.** Right-clicking the docked stage (not the popout, which has no page to go to, and not the stage's own buttons and selects) opens a small menu at the pointer: Go to album, Go to artist, Add to playlist and Full screen (Exit full screen while it is on). Go to album and Go to artist are disabled for a track Navidrome sent no id for. Add to playlist leaves full screen first, since the playlist sheet is a dialog of the page and would not be on screen. The menu is `role="menu"`, closes on Escape, a click elsewhere, a resize or choosing an item, moves with the arrow keys, Home and End, and keeps those keys from the stage's own shortcuts. The Menu key and Shift+F10 open it in the middle of the stage. It is drawn in the body, and inside the stage in full screen, where nothing else is on screen (`artwork-menu.tsx`).

## Full screen

The ⤢ button, double-clicking the stage, or F while the stage has focus puts the stage into full screen inside the tab. Esc leaves it.

## Popout

The ⧉ button opens the stage in a Document Picture-in-Picture window: 420 by 420 to start, resizable, always on top, with Chrome's own **Back to tab** and **Close** in its title bar. Music keeps playing in the tab whichever way the window closes. While it is open, Now Playing shows the dimmed artwork with **Bring back**. Moving around the app does not close it; closing or reloading the tab does.

Chrome reuses the window's last size and position on the next open, so nothing is stored for that.

The visualizer follows the stage into the popout. Its device, pipelines, whichever scene is drawing with its state, the post stack and the chosen preset all belong to a renderer that outlives the stage, so only the canvas is remade on each move and the scene keeps running. The preset and the scene, like the view, live above the stage, so both survive the round trip. Six round trips with Wash chosen kept `wash` and `fluid` on both canvases and the picker on Wash each time back. The stack's offscreen textures are sized from the canvas, so they are rebuilt for the popout's size and again on the way back; see [the visualizer note](visualizer.md).

A popout window cannot enter full screen; the Picture-in-Picture specification forbids it. The ⤢ button in the popout therefore closes the window, brings the tab forward, opens Now Playing and puts the docked stage into full screen. If the browser refuses that request, a short notice under the stage says to press F on the player.

The button only appears where the API exists: Chrome and Edge on desktop. Firefox and Safari keep the docked stage and full screen.

## Keyboard

Two sets. The page's own keys work anywhere on Now Playing; the stage's keys bind to the window the stage is in, and in the tab apply only while the stage is full screen or holds focus.

**The page** (`usePageShortcuts` in `now-playing-shortcuts.tsx`, and the tabs). `?` opens a small cheat sheet dialog that lists these and the stage's keys; Escape or its close button shuts it.

| Key       | Action                                               |
| --------- | ---------------------------------------------------- |
| Space     | play or pause (the player's own key; see below)      |
| ← →       | seek back or forward five seconds                    |
| Shift+← → | previous, next track                                 |
| ↑ ↓       | volume up or down                                    |
| M         | mute                                                 |
| L         | Lyrics tab; on it, large type. See [Lyrics](#lyrics) |
| Q         | Up next tab                                          |
| S         | small or large stage. See [Stage size](#stage-size)  |
| ?         | the cheat sheet                                      |

The page's keys are not taken from anything that uses them itself. Nothing fires while a text field, select or slider has focus (any `input`, so a range too), while a modifier key is held, while a dialog is open (the command palette, the playlist sheet, the cheat sheet), or when something else has already used the key. A focused tab list, menu or list box keeps the arrow keys, and a focused box that scrolls (the queue, the history, the lyrics) keeps Up and Down while it has something to scroll. Holding M, Q, L, S or Shift+arrow does not repeat. `?` and S work from anywhere but a text field, including with the stage focused; S, unlike `?`, also stays out of full screen and does nothing on a phone.

Space is not handled a second time here. The player already toggles playback on Space everywhere except on a text field, select, button or link, which use it themselves, so a focused button still presses. The page handler steps aside the same way for the stage: while the stage is full screen or holds focus, its own keys below handle the arrows and M, so a press is never applied twice (and Shift+← → there seeks, as the stage's arrows do).

**The stage.**

| Key   | Action                                                            |
| ----- | ----------------------------------------------------------------- |
| Space | play or pause (popout; the tab already handles it)                |
| ← →   | seek back or forward five seconds                                 |
| ↑ ↓   | volume up or down                                                 |
| M     | mute                                                              |
| F     | full screen (from the popout: back to the tab, full screen there) |
| Esc   | popout: close it. Tab: leave full screen                          |
| N, P  | next, previous track                                              |
| V     | artwork or visualizer, where WebGPU is available                  |
| H     | the visualizer's debug overlay, which names the preset            |
| [ ]   | previous, next visualizer preset                                  |

L, Q and S are bound to the page, not the stage, so they work without the stage focused.

## Code

- `frontend/src/library.tsx`: `NowPlayingPage` (the two columns and how they fit the window, or the single Large column, chosen by classes alone so the stage stays mounted) and `NowPlayingTabs` (the panel, the Playing from name, the remembered tab, the `L` key).
- `frontend/src/now-playing-shortcuts.tsx`: the page's keys (`usePageShortcuts`, S included, and `pageKeyIsFree`, the rule for when a key may be taken, which the tabs' L and Q use too) and the cheat sheet dialog.
- `frontend/src/now-playing-wash.tsx`, `frontend/src/cover-color.ts`, `frontend/src/wash.ts`: the backdrop. The component draws it, `cover-color.ts` reads the cover, and `wash.ts` is the rule that keeps the text readable (unit tested in `wash.test.ts`, with `cover-color.test.ts` for the colour pick and `theme/color.test.ts` for the mix). `frontend/src/use-leaving.ts` is the 300 ms cross-fade, shared by the wash and the artwork.
- `frontend/src/artwork-menu.tsx`: the right-click menu on the stage.
- `frontend/src/lyrics.tsx`: `LyricsPanel`, the synced list that follows the player, the timing offset and its storage. `frontend/src/lyrics.test.ts` covers the current-line lookup and the offset map.
- `frontend/src/now-playing-controls.tsx`: the title, byline and control row under the stage.
- `frontend/src/ui/tabs.tsx`: `TabList`, the tab row and its arrow keys.
- `frontend/src/now-playing-popout.tsx`: the provider at the app root (the popout window, the request that carries full screen back to the tab) and the stage itself. The docked stage's size is a container query: its slot is a size container, and the stage is `min(100cqw, 100cqh)` wide and square in Small, or `100cqw` by `100cqh` in Large (`dockedStageClassName`). The choice (`size`, `setSize`, `toggleSize`, kept as `musimo.now-playing-size`) and `phone`, whether the window is under the breakpoint, live in the provider beside the view and the preset. `useStageVisible` also carries the 10 second pause rest.
- `frontend/src/now-playing-overlay.tsx`: the top bar, the transport drawn over the picture in full screen and the popout (`StageControls`, switched by the `controls` prop), the always-visible Visualizer control (toggle and preset picker), the scene and grid selects, the small or large stage button (docked only, and not on a phone), the idle fade and the shortcuts. The idle fade is on the two bars, not on `.stage-overlay`, which is what lets the Visualizer control outlast it.
- `visimo`: the WebGPU renderer the stage mounts, loaded on demand from the package; see [the visualizer note](visualizer.md).
- `frontend/src/player.tsx` exposes the transport (`seek`, `cycleRepeat`, `toggleShuffle`, `toggleMute`, `setVolume`, `audio()`, `liked`, `stop`) the page's control row and the overlay need to duplicate the footer's controls, the overlay in a separate document.

## Checks

`frontend/e2e/now-playing-popout.spec.ts` runs on desktop Chromium: the stage appears on Now Playing, hovering shows its top bar and no transport, and the idle fade rests and wakes. It pins the view to artwork first, because the bar and the fade are the same either way and the default depends on whether the machine running the test has a WebGPU adapter. The same file checks the layout: at 1440 by 900 the panel sits beside the stage, the stage, the panel and the last control of the row all end inside the window, Lyrics is in view, the title is drawn once, Up next leaves out the playing track and counts the queue, every control the footer has is on the page, the footer is hidden and `--player-height` is `0px`, the playlist picker still opens from the page's button, and leaving the page brings the footer back; at 1440 by 600 the same four still hold with a smaller square stage; the close button empties the player; Large makes the stage at least 90% of the content width at 1440 by 900, wider than tall, with the controls under it and the tab panel under the controls and below the first screen, and Small puts it back; `S` switches the size (with the page or the stage focused, and not from a focused field), and the cheat sheet lists it; the choice is stored as `musimo.now-playing-size` and survives a reload; a phone draws no size control, ignores `S` and a stored Large, and keeps the full-width square; the tabs are real tabs, the arrow keys move and choose, and the choice survives a reload; the footer's "Your Navidrome library" and "Queue restored" lines are not repeated on the page; a long title stops after two lines under the stage and after one in Up next; on a phone the stage is the full content width, the Lyrics tab is within two screens of the top and opens the lyrics, the mini player is hidden and the page pads for the bottom bar alone. The popout test also checks the title and control row stay on the page while the popout is open, and that the popout draws its own transport. `frontend/e2e/now-playing-shortcuts.spec.ts` covers the wash (a hex value on the element, hidden from assistive tech, no pointer events), the page keys (volume, mute, L and Q, a focused slider and a focused tab keeping their arrows), the `?` cheat sheet and that a text field does not open it, the right-click menu and Go to album, and the cross-fade (a `.leaving` layer appears on a track change, and never under reduced motion). Whether the wash is pleasant to look at, and the cross-fade's feel, are checked by eye. `frontend/e2e/visualizer.spec.ts` covers the artwork fallback and its one-time notice without WebGPU, and, where the browser has an adapter, artwork as the default view, the canvas unmounting while the document is hidden and returning, the canvas resting after a pause of more than ten seconds (and staying through a short one) and returning on play, the V and H keys, the Visualizer toggle (its `aria-pressed` state), the remembered choice, the grid select changing the scene's workload and surviving a reload, and the preset picker with `[` and `]` moving it and the choice surviving a reload. The popout window itself cannot open headless, and neither can real full screen, so the following are checked by hand in desktop Chrome instead: full screen (button, double-click, F, Esc), popout open, resize, hover controls and idle fade inside it, every control and shortcut, Back to tab, close with music continuing, reopening at the same size and position, ⤢ from the popout landing in full screen in the tab, and moving around the app with it open.

## Later

- A ⧉ shortcut in the footer player.
