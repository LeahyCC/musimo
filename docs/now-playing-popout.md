# Now Playing popout

Now Playing's hero is a stage that can go full screen in the tab or pop out into a floating window above other applications, keeping the artwork and playback controls in reach wherever it sits. The stage is a shell: it shows the [visualizer](visualizer.md) where the browser has WebGPU and the artwork otherwise, and the two swap without the shell caring. The stage and like button exist only for library tracks.

## Now Playing

The stage shows the visualizer, or the current track's artwork: a sharp, letterboxed copy of the cover over a blurred, cropped fill of the same image. Where WebGPU is available the visualizer is the default, and a button in the top bar (Show artwork, Show visualizer) or V switches between the two; the choice is remembered in the browser as `musimo.now-playing-view`. A particle count select sits beside it while the visualizer shows. Without WebGPU, or if the device cannot be had, the stage shows the artwork and says so in a short notice under it, once per browser. Hovering the stage reveals the player's controls along the bottom (artwork, byline showing artist and album, like, previous, play, next, position, shuffle, repeat, mute and volume) and a status line and the full-screen and popout buttons along the top. The controls fade after two and a half seconds without movement while music plays and the pointer leaves the stage, and the cursor hides with them. They stay while paused or while the pointer rests on a control.

## Full screen

The ⤢ button, double-clicking the stage, or F while the stage has focus puts the stage into full screen inside the tab. Esc leaves it.

## Popout

The ⧉ button opens the stage in a Document Picture-in-Picture window: 420 by 420 to start, resizable, always on top, with Chrome's own **Back to tab** and **Close** in its title bar. Music keeps playing in the tab whichever way the window closes. While it is open, Now Playing shows the dimmed artwork with **Bring back**. Moving around the app does not close it; closing or reloading the tab does.

Chrome reuses the window's last size and position on the next open, so nothing is stored for that.

The visualizer follows the stage into the popout. Its device, pipelines, particle state and post stack belong to a renderer that outlives the stage, so only the canvas is remade on each move and the field keeps running. The stack's offscreen textures are sized from the canvas, so they are rebuilt for the popout's size and again on the way back; see [the visualizer note](visualizer.md).

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
| H     | the visualizer's debug overlay                                    |

## Code

- `frontend/src/now-playing-popout.tsx`: the provider at the app root (the popout window, the request that carries full screen back to the tab) and the stage itself.
- `frontend/src/now-playing-overlay.tsx`: the hover controls, the view toggle and particle select, the idle fade and the shortcuts.
- `frontend/src/visualizer/`: the WebGPU renderer the stage mounts, loaded on demand; see [the visualizer note](visualizer.md).
- `frontend/src/player.tsx` exposes the transport (`seek`, `cycleRepeat`, `toggleShuffle`, `toggleMute`, `setVolume`, `audio()`, `liked`) the overlay needs to duplicate the footer's controls in a separate document.

## Checks

`frontend/e2e/now-playing-popout.spec.ts` runs on desktop Chromium: the stage appears on Now Playing, hovering shows the controls, and the idle fade rests and wakes. `frontend/e2e/visualizer.spec.ts` covers the artwork fallback and its one-time notice without WebGPU, and, where the browser has an adapter, the default visualizer view, the V and H keys, the toggle button and the remembered choice. The popout window itself cannot open headless, and neither can real full screen, so the following are checked by hand in desktop Chrome instead: full screen (button, double-click, F, Esc), popout open, resize, hover controls and idle fade inside it, every control and shortcut, Back to tab, close with music continuing, reopening at the same size and position, ⤢ from the popout landing in full screen in the tab, and moving around the app with it open.

## Later

- A ⧉ shortcut in the footer player.
