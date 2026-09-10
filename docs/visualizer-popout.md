# Visualizer popout

The visualizer's home in Musimo is Now Playing, where it takes the place of the large artwork. From there it can go full screen in the tab or pop out into a floating window that stays above other applications. This note describes that shell. The visual studies themselves are covered in the [build record](visualizer-build.md) and [the renderer note](visualizer-renderer.md).

## Now Playing

With a library track playing, the hero shows a 16:9 stage instead of the square artwork. **Show artwork** under the stage swaps back to the artwork and **Show visuals** returns; the choice is kept in the browser under `musimo.now-playing-visuals`. Catalog previews from Deezer or iTunes keep the artwork, because visuals need the whole recording.

The stage prepares its audio separately: the track is downloaded again from `/api/player/stream/{id}`, hashed, and decoded at 44.1 kHz for the engine. The player's own audio element is never rerouted; the engine reads only its clock. A prepared journey score (today, Dive) attaches when the hash and duration match its analysis. Six minutes of stereo audio hold about 127 MB of samples, which is fine on a desktop; the prepared audio is released when the track changes or visuals are switched off, and is only fetched while a stage can show it.

Hovering the stage reveals a study picker at the top and the player's controls along the bottom: artwork, title and album, like, previous, play, next, position, shuffle, repeat, mute and volume. The controls fade after two and a half seconds without movement while music plays, and the cursor hides with them. They stay while paused or while the pointer rests on a control. Dive appears in the picker only for a track with a matching score; the last choice is kept under `musimo.visualizer.study`.

Pause holds the picture. A seek, a study change, a track change, a return from a hidden tab and a full-screen change each rebuild the picture from the seed at the current position and dissolve into it, as in the studio. Rebuilding never touches the music.

## Full screen

The ⤢ button, double-clicking the stage, or F while the stage has focus puts the stage into full screen inside the tab. Esc leaves it. Full screen renders at 1920 pixels wide; the docked stage and the popout render at 1280 and scale to fit.

## Popout

The ⧉ button opens the stage in a Document Picture-in-Picture window: 640 by 360 to start, resizable, always on top, with Chrome's own **Back to tab** and **Close** in its title bar. Music keeps playing in the tab whichever way the window closes. While it is open, Now Playing shows the dimmed artwork with **Bring back**. Moving around the app does not close it; closing or reloading the tab does.

Chrome reuses the window's last size and position on the next open, so nothing is stored for that.

A popout window cannot enter full screen; the Picture-in-Picture specification forbids it. The ⤢ button in the popout therefore closes the window, brings the tab forward, opens Now Playing and puts the docked stage into full screen. If the browser refuses that request, a short notice under the stage says to press F on the visualizer.

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
| V     | next study                                                        |

## Code

- `frontend/src/visualizer.tsx`: the provider at the app root (prepared audio, study choice, popout window, the request that carries full screen back to the tab) and the Now Playing slot.
- `frontend/src/visualizer-stage.tsx`: one canvas and one engine at a time, rebuilt as the studio does.
- `frontend/src/visualizer-overlay.tsx`: the hover controls, the idle fade and the shortcuts.
- `frontend/src/visualizer-source.ts`: download, hash and decode. Checks the hash against `@musimo/visualizer/song-hashes` before importing the much larger `@musimo/visualizer/songs`.
- `visualizer/src/songs.ts`: prepared scores by recording hash, exported as `@musimo/visualizer/songs`.
- `visualizer/src/song-hashes.ts`: just the hash and duration for each prepared song, exported as `@musimo/visualizer/song-hashes`, so a track that cannot match never pays for the analysis behind `songs.ts`.

The frontend depends on the `visualizer/` package through a local `file:` link. Its build first emits the package's declaration files (`npm run types` in `visualizer/`, written to the ignored `visualizer/types/`), type-checks against those, and lets Vite bundle the engine source; the Docker image copies the package beside the frontend for the same steps.

## Checks

`frontend/e2e/visualizer.spec.ts` runs on desktop Chromium: the stage appears on Now Playing, hovering shows the controls, V changes the study, the artwork switch is remembered across a reload, and the popout button follows the browser's support. The popout window itself cannot open headless, so the following are checked by hand in desktop Chrome: open, resize, hover controls and idle fade, every control and shortcut, Back to tab, close with music continuing, reopening at the same size and position, ⤢ from the popout landing in full screen in the tab, track changes and seeks while popped out, a catalog preview while popped out, and moving around the app with it open.

## Later

- Per-study settings and the Customize panel inside the popout; both stay in the studio for now.
- A lighter feed than a second full download per track.
- A fill mode for popout shapes that are not 16:9.
- A ⧉ shortcut in the footer player.
