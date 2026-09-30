# Now Playing visualizer

The visualizer is [butterchurn](https://github.com/jberg/butterchurn), the WebGL 2 port of Winamp's MilkDrop, drawing the presets in `butterchurn-presets`' base pack. It replaced visimo, Musimo's own WebGPU package, which is no longer a dependency.

## How it is wired in

```
frontend/package.json        butterchurn 3.0.0-beta.5, butterchurn-presets 3.0.0-beta.4 (exact pins)
visualizer-presets.ts        the base pack's preset names, and stepping through them
audio-graph.ts               the one AudioContext, and the bus the library elements feed
milkdrop-stage.tsx           butterchurn and the presets themselves, loaded lazily
now-playing-popout.tsx       mounts the stage, keeps the chosen preset
player.tsx                   routeToAnalyser: each library element into the bus
```

butterchurn 3 compiles each preset's equations to WebAssembly, so the backend's Content-Security-Policy carries `script-src 'self' 'wasm-unsafe-eval'` (`backend/main.py`, checked in `tests/test_foundation.py`). Without it every preset fails to load and butterchurn draws its blank default whatever is chosen. The Vite dev server sends no such policy, so only a built app shows that failure; `e2e/visualizer.spec.ts` catches it because `data-preset` is written only once a preset has loaded.

Both packages are 3.0 betas, pinned exactly. 2.6.7 is the latest stable release; the beta was chosen as the newest MilkDrop code. `src/butterchurn.d.ts` types the parts Musimo calls, since neither package ships types.

Which import lands where matters. `visualizer-presets.ts` imports only `getBasePresetKeys` from `butterchurn-presets/presetPackMeta.js`, so the main chunk carries the base pack's 107 names and nothing else (the other packs' names are shaken out). `milkdrop-stage.tsx` imports butterchurn and the presets themselves, about 1.1 MB (230 KB gzipped), and is only loaded when a stage mounts the visualizer. An import of the presets anywhere else pulls that into the main bundle, and nothing will fail, so watch the build output.

## What stays on Musimo's side

| Key                                    | What it holds                                        |
| -------------------------------------- | ---------------------------------------------------- |
| `musimo.now-playing-view`              | artwork or visualizer, toggled with V                |
| `musimo.now-playing-size`              | small or large docked stage, toggled with S          |
| `musimo.visualizer-auto`               | on or off: whether the preset changes with the music |
| `musimo.visualizer-preset`             | the chosen preset's name, walked with `[` and `]`    |
| `musimo.now-playing-visualizer-notice` | the one-time notice shown where WebGL 2 is missing   |

A stored preset name the pack does not have, including one of visimo's old ids, starts on the default, `Flexi, martin + geiss - dedicated to the sherwin maxawow`. visimo's `musimo.visualizer-scene` and `musimo.visualizer-fluid-grid` keys are no longer read, and are left where a browser has them.

The same choices can be made from `/settings/user`, under Visualizer: stage size (Small or Large), Show on Now Playing (Artwork or Visualizer; the same setting as the stage's own Visualizer button, and the hint under the select says so) and preset (the same list the stage's select shows). That section does not read or write the keys itself. It calls `useNowPlayingPopout()`, so it shares the provider's state with the stage: an open stage changes at once and the two cannot disagree. The view and preset are disabled with a one-line reason while `canVisualize` is false; the stage size is not, since it lays out the artwork too. The section links to Now Playing. `e2e/app.spec.ts` checks that the Show on Now Playing control writes `musimo.now-playing-view`, and that the section is disabled with its reason where there is no WebGL 2. See [settings](settings.md#your-settings).

A preset's full name is its authors, its title and years of mix notes (`Geiss - Cauldron - painterly 2 (saturation remix)`). The pickers show only the title (`Cauldron`), sorted A to Z, and `[` and `]` walk that same order. `presetLabel` in `visualizer-presets.ts` makes the label, with `LABEL_FIXES` for the few names the rule reads badly; `visualizer-presets.test.ts` checks every label is short and distinct. The full name is still the id that is stored, so a saved choice survives a change to a label.

Hovering either picker shows the chosen preset's full name as a tooltip, which credits its authors.

The way into all of this is a labeled Visualizer control on the stage (On or Off, with a `V` hint), and while it is on, the preset's name between `[` and `]` hints, where the name is the preset select. It fades with the rest of the overlay when the stage goes idle, and hovering the stage brings it back (`e2e/now-playing-chrome.spec.ts` checks the docked stage). See [the popout note](now-playing-popout.md#now-playing).

## Changing with the music

With Change with the music on (the default, in `/settings/user`), the preset moves by itself. `music-moments.ts` watches the bass level from an analyser on the bus (`bassLevel` in `audio-graph.ts`), sampled once a frame while the stage draws:

```
bass level ──► fast average (≈0.5 s)
           └─► slow average (≈6 s)

fast rises 0.12 above slow (a drop after a quieter part)  ──► random preset, 1.5 s blend
no drop for 90 s of steady music                          ──► random preset, 5 s blend
never sooner than 20 s after the last change; picking one yourself restarts that wait
```

The analyser reports the bass on a decibel scale squeezed into 0 to 1, where real music sits between about 0.5 and 0.95, so a drop is a rise by a fixed amount rather than a multiple. The numbers were tuned on 88 seconds of a real track with two drops and a song change: 0.12 caught both drops and nothing else. Silence (below 0.08) never triggers anything. It only listens while the stage draws, so a hidden or resting stage changes nothing. `music-moments.test.ts` covers the rules.

A new preset blends in over 2.7 seconds, the way MilkDrop moves between presets; the first one after a page load appears at once. A preset whose shaders will not compile in a browser leaves the previous one drawing.

## The command palette

Ctrl+K also offers four visualizer commands: Toggle visualizer, Next visualizer preset, Previous visualizer preset and Fullscreen visualizer. Each goes to `/now-playing` first if the tab is elsewhere, then calls the same `PopoutProvider` functions the stage's own controls call (`toggleView`, `cyclePreset`), so the palette never writes the keys above itself. The two preset commands and Fullscreen switch the stage to the visualizer first, since a preset change on artwork would show nothing. Toggle visualizer only toggles while Now Playing is in front; from another route it arrives with the visualizer on, since a toggle on a stage nobody can see could land on the page with the visuals just switched off. `e2e/app.spec.ts` checks that, and that the commands are absent without WebGL 2.

All four are left out of the list while `canVisualize` is false, so a browser without WebGL 2 never sees them, and while no library track is loaded (`usePlayer().libraryTrack`), since Now Playing has no stage then and a command would land on an empty page. A preview does not count. `e2e/now-playing-chrome.spec.ts` checks both states.

Fullscreen needs a user gesture, and the palette selection is one. `PopoutProvider` exposes the docked stage's element as `dockedStage`. If it is mounted the click handler calls `requestFullscreen()` on it directly. If it is not (another route, or the stage is playing in the popout) the handler calls `popoutToFullscreen`, which closes the popout, navigates, and lets the stage request fullscreen when it mounts. Either way a rejected request leaves the user on Now Playing with the "Press F" notice.

`palette.tsx` imports only `now-playing-popout`, which is already in the main chunk, so the palette adds nothing to the main bundle.

## Where it can draw

`canVisualize` starts as `typeof WebGL2RenderingContext !== 'undefined'`, which loads nothing and makes no context. The real check happens when the stage mounts: butterchurn's own `isSupported()` (WebGL 2 and Web Audio), then the visualizer itself. If either fails the stage calls `markUnsupported`, shows the artwork, and says so once under the stage. There is no fallback beyond the artwork.

WebGL 2 is in every current desktop and phone browser, so the fallback is rare where visimo's WebGPU one was common. Headless Chromium has it through its software renderer, so `e2e/visualizer.spec.ts` now runs its drawing tests in CI rather than skipping them.

## The audio graph

`audio-graph.ts` owns the one `AudioContext`. Each library element's source goes through a gain node of its own into a bus, and the bus goes to the speakers. butterchurn is connected to the bus with `connectAudio`, so it hears whichever element is playing, at the level that is heard.

```
each library element:  source -> GainNode -> bus -> speakers
                                               \-> butterchurn's analysers
```

Gapless playback (see [the player note](player.md#gapless-playback)) swaps two library elements at each track change, and a media element can be given to `createMediaElementSource` once only. `routeToAnalyser` in `player.tsx` wires each one the first time it plays, both the same way, so the stage keeps moving after a handover. `e2e/gapless.spec.ts` checks that both library elements get a source on the graph. The source is only made once the context is running, since a source on a suspended context is silent. `resumeAudio` waits for it with no time limit: Firefox takes about a second to start, and an earlier one second limit left the first track of a session unwired in Firefox. A context that waits for a click just waits, and the element plays without the graph until then.

The preview element is never wired: previews stream from provider CDNs without CORS headers, and a media element source on such audio is silenced permanently. Someone playing a preview who opens Now Playing is told so: the page says a preview is playing and that Now Playing, and its visuals where `canVisualize` is true, play with library tracks.

### The ReplayGain boost

An element's `volume` cannot pass 1, so a [ReplayGain](player.md#volume-levelling) gain above 1 is applied in the graph. The element keeps its own volume for everything up to 1 (`splitLevel`), and its gain node carries only the part above it. The bus sits after the node, so the stage sees the boosted level. The boost is used only when the track has a peak tag, only while the context is running, and never for a preview. `e2e/gapless.spec.ts` checks that a quiet fixture track gets the same gain on both elements across a handover.

## When it draws

Artwork is the default view. A browser that has never stored a choice starts on artwork, and the Visualizer toggle (or V, or the setting) is one click away. A browser that already stored `visualizer` or `artwork` keeps it.

The docked stage draws only while someone can see it. `useStageVisible` in `now-playing-popout.tsx` turns it off when the document is hidden and when the stage is scrolled out of view, and back on when both are true again. "Off" means the stage unmounts and the artwork shows in its place. Once playback has been paused for more than 10 seconds (`PAUSE_REST_MS`) it rests the same way, in the popout too, and play brings it back. The popout window counts as visible for as long as it is open.

butterchurn's visualizer outlives the stage. `milkdrop-stage.tsx` keeps one for the life of the tab and hands it each new canvas with `setCanvas`, so a remount (a hidden tab coming back, a trip to the popout and back) costs a canvas rather than a new WebGL context and a cold start, and the preset carries on. Frames come from the canvas's own window, so the popout draws at full rate while the tab behind it is throttled.

## How big it draws

The canvas's drawing buffer is its CSS size times `devicePixelRatio`, and follows it with a `ResizeObserver`. There is no render size cap, the same as visimo had. The docked Small stage, the Large stage and full screen can be a lot of pixels on a high-DPI screen; check `data-frame-ms` on the canvas on a low-end machine before trusting it. Headless Chromium on its software renderer measured about 6 ms a frame on a Small stage.

## The canvas attributes

`canvas.stage-visualizer` carries `data-preset` (the name of the preset butterchurn has actually loaded, so a preset that never loads leaves it unset) and `data-frame-ms` (the average `render()` time over the last 30 frames). `e2e/visualizer.spec.ts` asserts on both. They and the class name `stage-visualizer` are Musimo's own. Nothing on screen shows the frame time; read it from the attribute in dev tools.

## Checks

`e2e/visualizer.spec.ts` covers the artwork fallback without WebGL 2, artwork as the default, the view toggle and its keys, the hidden-tab and long-pause rests, the preset picker with `[` and `]`, and an old visimo preset id falling back to the default. The drawing tests skip in an engine that cannot make a WebGL 2 context.

A test that touches the Now Playing stage pins the view rather than rely on the default: a test that needs the canvas stores `visualizer` first, and one that needs the artwork stores `artwork`. Tests that need `canVisualize` false remove `window.WebGL2RenderingContext` in an init script. See [the testing note](testing.md).
