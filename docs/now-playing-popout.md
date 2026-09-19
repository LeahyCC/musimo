# Now Playing popout

Now Playing's hero is a stage that can go full screen in the tab or pop out into a floating window above other applications, keeping the artwork and playback controls in reach wherever it sits. The stage is a shell: it shows the [visualizer](visualizer.md) where the browser has WebGPU and the artwork otherwise, and the two swap without the shell caring. The stage and like button exist only for library tracks.

## Layout

The stage is the largest thing on the page. On a desktop it takes 60% of the content width, square, with the track's details in a column beside it: the eyebrow, the title at the page heading size (three lines, then an ellipsis), the artist and album, and Add to playlist. On a phone the two stack and the stage takes the full content width. Up next and Lyrics sit below, as before.

The stage's width is also capped by the window's height (`100dvh` less the top bar and 84 px), so a short window shrinks the square instead of pushing its controls below the fold. At 1440 by 900 the cap does not bite; at 1440 by 600 the stage is about 430 px, well under 60%.

The footer player is hidden while a library track is on this page, at every width, because the stage carries the same title and transport and the page has its own Add to playlist button. On a phone that means the mini player steps aside too: it repeats the title, play or pause, next and the seek bar that the stage draws, and the stage's controls fade when idle and wake on a tap. Where a catalog preview is playing the page says so, and that Now Playing and its visuals play with library tracks, and the footer stays, because its controls are the only ones the preview has. The footer's status line (a track that will not play, a playlist just created) is repeated under the Add to playlist button, since it would otherwise be hidden with the footer. Leaving the page brings the footer back. See [the player note](player.md) for how `--player-height` follows it.

## Now Playing

The stage shows the visualizer, or the current track's artwork: a sharp, letterboxed copy of the cover over a blurred, cropped fill of the same image. Where WebGPU is available the visualizer is the default, and a labeled **Visualizer** button with an On or Off state and a `V` hint, at the top left under the status line, or V itself, switches between the two; the choice is remembered in the browser as `musimo.now-playing-view`. That control is not part of the bars that fade: while music plays and the stage is idle it drops to 70% opacity and stays, so the toggle is always findable. In full screen it fades away with the rest, to keep the visuals clean. While the visualizer shows, the current preset's name sits beside it between small `[` and `]` hints (hidden on a phone, like every `Kbd`), and the name is the preset select itself, so clicking it opens the list, grouped by scene. In the top bar, the scene's size control, the fluid's grid, sits with the scene select, Fluid or Kaleidoscope. A preset carries a scene and choosing either moves the other, so the two are never left disagreeing, and the grid control is drawn for Fluid only. Kaleidoscope can also run on WebGL2, but the stage still asks for WebGPU before it mounts, so a browser without it gets the artwork for both scenes. `[` and `]` walk the presets either way and wrap, and the choice is remembered as `musimo.visualizer-preset`. Without WebGPU, or if the device cannot be had, the stage shows the artwork and says so in a short notice under it, once per browser. Hovering the stage reveals the player's controls along the bottom (artwork, byline showing artist and album, like, previous, play, next, position, shuffle, repeat, mute and volume) and a status line and the full-screen and popout buttons along the top. The two bars fade after two and a half seconds without movement while music plays and the pointer leaves the stage, and the cursor hides with them. They stay while paused or while the pointer rests on a control.

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

- `frontend/src/now-playing-popout.tsx`: the provider at the app root (the popout window, the request that carries full screen back to the tab) and the stage itself.
- `frontend/src/now-playing-overlay.tsx`: the hover controls, the always-visible Visualizer control (toggle and preset picker), the size select, the idle fade and the shortcuts. The idle fade is on the two bars, not on `.stage-overlay`, which is what lets the Visualizer control outlast it.
- `visimo`: the WebGPU renderer the stage mounts, loaded on demand from the package; see [the visualizer note](visualizer.md).
- `frontend/src/player.tsx` exposes the transport (`seek`, `cycleRepeat`, `toggleShuffle`, `toggleMute`, `setVolume`, `audio()`, `liked`) the overlay needs to duplicate the footer's controls in a separate document.

## Checks

`frontend/e2e/now-playing-popout.spec.ts` runs on desktop Chromium: the stage appears on Now Playing, hovering shows the controls, and the idle fade rests and wakes. It pins the view to artwork first, because the hover controls and the fade are the same either way and the default depends on whether the machine running the test has a WebGPU adapter. The same file checks the layout: at 1440 by 900 the stage is at least 58% of the content width with the title beside it and smaller, the footer is hidden and `--player-height` is `0px`, the playlist picker still opens from the page's button, and leaving the page brings the footer back; at 1440 by 600 the stage ends inside the window; on a phone the stage is the full content width, the mini player is hidden and the page pads for the bottom bar alone. `frontend/e2e/visualizer.spec.ts` covers the artwork fallback and its one-time notice without WebGPU, and, where the browser has an adapter, the default visualizer view, the V and H keys, the Visualizer toggle (its `aria-pressed` state), the remembered choice, the grid select changing the scene's workload and surviving a reload, and the preset picker with `[` and `]` moving it and the choice surviving a reload. The popout window itself cannot open headless, and neither can real full screen, so the following are checked by hand in desktop Chrome instead: full screen (button, double-click, F, Esc), popout open, resize, hover controls and idle fade inside it, every control and shortcut, Back to tab, close with music continuing, reopening at the same size and position, ⤢ from the popout landing in full screen in the tab, and moving around the app with it open.

## Later

- A ⧉ shortcut in the footer player.
