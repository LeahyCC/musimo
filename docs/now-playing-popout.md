# Now Playing popout

Now Playing is a stage that can go full screen in the tab or pop out into a floating window above other applications, keeping the artwork and playback controls in reach wherever it sits. In the tab it sits beside the track's controls and a tabbed panel of Up next and Lyrics. The stage is a shell: it shows the [visualizer](visualizer.md) where the browser has WebGPU and the artwork otherwise, and the two swap without the shell caring. The stage and like button exist only for library tracks.

## Layout

Two columns under the top bar that together fit the window's height, so nothing on the page starts below the fold. The artwork and the controls are on the left, one tabbed panel on the right.

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

**Right column.** One panel with two tabs, Up next and Lyrics, that fills the column's height. Each tab scrolls inside itself with `overscroll-contain`, so a long queue never moves the page. Up next lists what comes after the playing track, so the playing track is not its first row, and a row still plays from its own place in the whole queue. Above the rows it says how many tracks the queue holds and, when the player knows where the queue came from, "Playing from" and its name: an album, an artist, a playlist or a tracks search. A queue restored after a refresh has no known source, so it says nothing. The player keeps only an id for the source, so the name comes from the same cached reads the library pages make. The chosen tab is remembered in the browser as `musimo.now-playing-tab` (`up-next` or `lyrics`).

The tabs follow the ARIA tabs pattern (`TabList` in `ui/tabs.tsx`): `role="tablist"`, `role="tab"` with `aria-selected`, only the chosen tab in the tab order, and the left and right arrows (and Home and End) move between tabs and choose as they go. Both panels stay in the document, so each tab's `aria-controls` names something that exists, and the one not chosen is `hidden`.

**Fitting the window.** The page is `100dvh` less the top bar and `--page-pad` tall (`main`'s top padding of 36px, or 48px from 1500px, plus 24px at the bottom). `main` also pads its bottom by 130px to clear the footer player, which this page hides, so the page takes back all but 24px of that with a negative margin. If that padding ever changes, the two must change together.

**Phone.** Under 768px there is one column and the page scrolls. The stage takes the full content width, the title and controls follow, and the same two tabs sit directly beneath them, so Lyrics is one tap from the controls however long the queue is. The panel grows with its content and the page does the scrolling; there is no scroll box inside it. The volume slider is left to the device's own buttons, as on the footer's mini player.

**While popped out.** The stage slot shows the dimmed artwork with Bring back, and the left column still shows the title and the whole control row, so the tab is never left without transport.

**The footer player** is hidden while a library track is on this page, at every width, because the page has every control the footer has: like, Add to playlist, seek, previous, play or pause, next, shuffle, repeat, mute, volume and close. If a control is ever added to the footer, it has to be added here in the same change, or the footer has to stay. On a phone the mini player steps aside too. Where a catalog preview is playing the page says so, and that Now Playing and its visuals play with library tracks, and the footer stays, because its controls are the only ones the preview has. Leaving the page brings the footer back. See [the player note](player.md) for how `--player-height` follows it.

**Status lines.** The footer's status line is repeated on the page, under the control row, only for errors and confirmations: a track that will not play, a playlist just created. "Your Navidrome library" and "Queue restored. Press play to continue." say what the title, the Playing from line and the play button already say, so the page leaves them in the footer (`isPassiveNotice` in `player.tsx`). The WebGPU notice keeps its once-per-browser rule (see below), so a returning visitor sees no line under the stage.

## Now Playing

The stage shows the visualizer, or the current track's artwork: a sharp, letterboxed copy of the cover over a blurred, cropped fill of the same image. Where WebGPU is available the visualizer is the default, and a labeled **Visualizer** button with an On or Off state and a `V` hint, at the top left under the status line, or V itself, switches between the two; the choice is remembered in the browser as `musimo.now-playing-view`. That control is not part of the bars that fade: while music plays and the stage is idle it drops to 70% opacity and stays, so the toggle is always findable. In full screen it fades away with the rest, to keep the visuals clean. While the visualizer shows, the current preset's name sits beside it between small `[` and `]` hints (hidden on a phone, like every `Kbd`), and the name is the preset select itself, so clicking it opens the list, grouped by scene. In the top bar, the scene's size control, the fluid's grid, sits with the scene select, Fluid or Kaleidoscope. A preset carries a scene and choosing either moves the other, so the two are never left disagreeing, and the grid control is drawn for Fluid only. Kaleidoscope can also run on WebGL2, but the stage still asks for WebGPU before it mounts, so a browser without it gets the artwork for both scenes. `[` and `]` walk the presets either way and wrap, and the choice is remembered as `musimo.visualizer-preset`. Without WebGPU, or if the device cannot be had, the stage shows the artwork and says so in a short notice under it, once per browser. Hovering the stage reveals a status line and the full-screen and popout buttons along the top. Only in full screen and in the popout window does it also reveal the player's controls along the bottom (artwork, byline showing artist and album, like, previous, play, next, position, shuffle, repeat, mute and volume); docked, the page's control row under the stage holds them. The bars fade after two and a half seconds without movement while music plays and the pointer leaves the stage, and the cursor hides with them. They stay while paused or while the pointer rests on a control.

## Full screen

The ⤢ button, double-clicking the stage, or F while the stage has focus puts the stage into full screen inside the tab. Esc leaves it.

## Popout

The ⧉ button opens the stage in a Document Picture-in-Picture window: 420 by 420 to start, resizable, always on top, with Chrome's own **Back to tab** and **Close** in its title bar. Music keeps playing in the tab whichever way the window closes. While it is open, Now Playing shows the dimmed artwork with **Bring back**. Moving around the app does not close it; closing or reloading the tab does.

Chrome reuses the window's last size and position on the next open, so nothing is stored for that.

The visualizer follows the stage into the popout. Its device, pipelines, whichever scene is drawing with its state, the post stack and the chosen preset all belong to a renderer that outlives the stage, so only the canvas is remade on each move and the scene keeps running. The preset and the scene, like the view, live above the stage, so both survive the round trip. Six round trips with Wash chosen kept `wash` and `fluid` on both canvases and the picker on Wash each time back. The stack's offscreen textures are sized from the canvas, so they are rebuilt for the popout's size and again on the way back; see [the visualizer note](visualizer.md).

A popout window cannot enter full screen; the Picture-in-Picture specification forbids it. The ⤢ button in the popout therefore closes the window, brings the tab forward, opens Now Playing and puts the docked stage into full screen. If the browser refuses that request, a short notice under the stage says to press F on the player.

The button only appears where the API exists: Chrome and Edge on desktop. Firefox and Safari keep the docked stage and full screen.

## Keyboard

Shortcuts bind to the window the stage is in. In the tab they apply while the stage is full screen or holds focus; elsewhere the page's own Space shortcut still plays and pauses.

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

## Code

- `frontend/src/library.tsx`: `NowPlayingPage` (the two columns and how they fit the window) and `NowPlayingTabs` (the panel, the Playing from name, the remembered tab).
- `frontend/src/now-playing-controls.tsx`: the title, byline and control row under the stage.
- `frontend/src/ui/tabs.tsx`: `TabList`, the tab row and its arrow keys.
- `frontend/src/now-playing-popout.tsx`: the provider at the app root (the popout window, the request that carries full screen back to the tab) and the stage itself. The docked stage's size is a container query: its slot is a size container and the stage is `min(100cqw, 100cqh)` wide.
- `frontend/src/now-playing-overlay.tsx`: the top bar, the transport drawn over the picture in full screen and the popout (`StageControls`, switched by the `controls` prop), the always-visible Visualizer control (toggle and preset picker), the size select, the idle fade and the shortcuts. The idle fade is on the two bars, not on `.stage-overlay`, which is what lets the Visualizer control outlast it.
- `visimo`: the WebGPU renderer the stage mounts, loaded on demand from the package; see [the visualizer note](visualizer.md).
- `frontend/src/player.tsx` exposes the transport (`seek`, `cycleRepeat`, `toggleShuffle`, `toggleMute`, `setVolume`, `audio()`, `liked`, `stop`) the page's control row and the overlay need to duplicate the footer's controls, the overlay in a separate document.

## Checks

`frontend/e2e/now-playing-popout.spec.ts` runs on desktop Chromium: the stage appears on Now Playing, hovering shows its top bar and no transport, and the idle fade rests and wakes. It pins the view to artwork first, because the bar and the fade are the same either way and the default depends on whether the machine running the test has a WebGPU adapter. The same file checks the layout: at 1440 by 900 the panel sits beside the stage, the stage, the panel and the last control of the row all end inside the window, Lyrics is in view, the title is drawn once, Up next leaves out the playing track and counts the queue, every control the footer has is on the page, the footer is hidden and `--player-height` is `0px`, the playlist picker still opens from the page's button, and leaving the page brings the footer back; at 1440 by 600 the same four still hold with a smaller square stage; the close button empties the player; the tabs are real tabs, the arrow keys move and choose, and the choice survives a reload; the footer's "Your Navidrome library" and "Queue restored" lines are not repeated on the page; a long title stops after two lines under the stage and after one in Up next; on a phone the stage is the full content width, the Lyrics tab is within two screens of the top and opens the lyrics, the mini player is hidden and the page pads for the bottom bar alone. The popout test also checks the title and control row stay on the page while the popout is open, and that the popout draws its own transport. `frontend/e2e/visualizer.spec.ts` covers the artwork fallback and its one-time notice without WebGPU, and, where the browser has an adapter, the default visualizer view, the V and H keys, the Visualizer toggle (its `aria-pressed` state), the remembered choice, the grid select changing the scene's workload and surviving a reload, and the preset picker with `[` and `]` moving it and the choice surviving a reload. The popout window itself cannot open headless, and neither can real full screen, so the following are checked by hand in desktop Chrome instead: full screen (button, double-click, F, Esc), popout open, resize, hover controls and idle fade inside it, every control and shortcut, Back to tab, close with music continuing, reopening at the same size and position, ⤢ from the popout landing in full screen in the tab, and moving around the app with it open.

## Later

- A ⧉ shortcut in the footer player.
