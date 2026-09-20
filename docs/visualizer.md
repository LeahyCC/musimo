# Now Playing visualizer

The visualizer is [visimo](https://github.com/LeahyCC/visimo), a package of its own. What it does, how the fluid and the post stack work, what a preset is and every measurement taken on it are in that repository's README. This note is only what Musimo does around it.

It moved out so scenes and presets could be worked on against a dropped file rather than a music library. Nothing about the stage changed in the move.

## How it is wired in

```
frontend/package.json          "visimo": "github:LeahyCC/visimo#<commit>"
now-playing-popout.tsx         visimo/presets, visimo/catalog, and the stage
                               itself from visimo, loaded lazily
now-playing-overlay.tsx        visimo/presets, visimo/catalog for the top bar
player.tsx                     visimo/audio on each library element's plays
```

The pin is a full commit hash on visimo's `main`, not a tag, because `main` has moved past `v0.1.0` without a release. It currently points at the merge that added the Kaleidoscope scene and its Prism preset, so the stage's Scene select is drawn and Fluid stays the default.

Four entry points, and which one an import uses decides the bundle it lands in. `visimo/presets` and `visimo/catalog` are plain values, so the picker and the selects sit in the main chunk; `visimo` and `visimo/audio` are loaded on demand and the WebGPU tree stays out until a stage wants it. An import of the wrong one adds about 38 KB to the main bundle and nothing will fail, so watch the build output rather than trusting the change.

`now-playing-popout.tsx` keeps its own copy of `hasWebGpu` for the same reason. Importing the real one to answer a question about `navigator` would load the chunk the question is meant to avoid.

Two things the package needs from the repository:

- `frontend/vite.config.ts` carries `optimizeDeps: { exclude: ['visimo'] }`. The package ships TypeScript, its shaders are `?raw` imports the dependency pre-bundler cannot load out of `node_modules`, and without the exclusion the dev server does not start at all. The same exclusion keeps the feature worker's asset URL intact in a build.
- The `Dockerfile` installs git in the frontend stage. `node:26-bookworm-slim` has none and a git dependency cannot install without it.

Check after a build that `dist/assets/` still holds a `features.worker-*.js`. If it does not, the worker will 404 at runtime and the stage will draw with no features at all.

## What stays on Musimo's side

The stage, its keys and what the browser remembers:

| Key                                    | What it holds                                     |
| -------------------------------------- | ------------------------------------------------- |
| `musimo.now-playing-view`              | artwork or visualizer, toggled with V             |
| `musimo.now-playing-size`              | small or large docked stage, toggled with S       |
| `musimo.visualizer-preset`             | the chosen preset, walked with `[` and `]`        |
| `musimo.visualizer-scene`              | only consulted where no preset was ever stored    |
| `musimo.visualizer-fluid-grid`         | 512 or 1024                                       |
| `musimo.now-playing-visualizer-notice` | the one-time notice shown where WebGPU is missing |

The same choices can be made from `/settings/user`, under Visualizer: stage size (Small or Large), Show on Now Playing (Artwork or Visualizer; the same setting as the stage's own Visualizer button, and the hint under the select says so), preset (grouped by scene, the same list the stage's select shows) and fluid detail (512 or 1024). That section does not read or write the keys itself. It calls `useNowPlayingPopout()`, so it shares the provider's state with the stage: an open stage changes at once and the two cannot disagree. The view, preset and fluid detail are disabled with a one-line reason while `canVisualize` is false; the stage size is not, since it lays out the artwork too. The section links to Now Playing. `e2e/app.spec.ts` checks that the Show on Now Playing control writes `musimo.now-playing-view`, and that the section is disabled with its reason where there is no WebGPU. See [settings](settings.md#your-settings).

A preset names a scene, so choosing a preset moves the scene select under it and choosing a scene moves to that scene's first preset. The scene select is not drawn while `SCENE_IDS` has one entry in it. H toggles the package's debug overlay.

The way into all of this is a labeled Visualizer control on the stage (On or Off, with a `V` hint), and while it is on, the preset's name between `[` and `]` hints, where the name is the preset select. It stays on screen while the rest of the overlay fades when idle, at reduced opacity (`e2e/now-playing-chrome.spec.ts` checks the docked stage), and hides with them only in full screen and in the popout window, which is too small to keep it. It is what makes the keys discoverable; the keys themselves are unchanged. See [the popout note](now-playing-popout.md#now-playing).

## The command palette

Ctrl+K also offers four visualizer commands: Toggle visualizer, Next visualizer preset, Previous visualizer preset and Fullscreen visualizer. Each goes to `/now-playing` first if the tab is elsewhere, then calls the same `PopoutProvider` functions the stage's own controls call (`toggleView`, `cyclePreset`), so the palette never writes the keys above itself. The two preset commands and Fullscreen switch the stage to the visualizer first, since a preset change on artwork would show nothing. Toggle visualizer only toggles while Now Playing is in front; from another route it arrives with the visualizer on, since a toggle on a stage nobody can see could land on the page with the visuals just switched off. `e2e/app.spec.ts` checks that, and that the commands are absent without WebGPU.

All four are left out of the list while `canVisualize` is false, so a browser without WebGPU never sees them, and while no library track is loaded (`usePlayer().libraryTrack`), since Now Playing has no stage then and a command would land on an empty page. A preview does not count. `e2e/now-playing-chrome.spec.ts` checks both states.

Fullscreen needs a user gesture, and the palette selection is one. `PopoutProvider` exposes the docked stage's element as `dockedStage`. If it is mounted the click handler calls `requestFullscreen()` on it directly. If it is not (another route, or the stage is playing in the popout) the handler calls `popoutToFullscreen`, which closes the popout, navigates, and lets the stage request fullscreen when it mounts. Either way a rejected request leaves the user on Now Playing with the "Press F" notice.

`palette.tsx` imports only `now-playing-popout`, which is already in the main chunk, and nothing from `visimo`, so the palette adds nothing to the main bundle.

The separate preview element is Musimo's rule, not the package's: previews stream from provider CDNs without CORS headers, and a media element source on such audio is silenced permanently. `player.tsx` keeps one element for previews and a pair for library tracks (next section), and only the library pair is ever handed to `attachAudio`. Someone playing a preview who opens Now Playing is told so: the page says a preview is playing and that Now Playing, and its visuals where `canVisualize` is true, play with library tracks, rather than "Nothing playing yet". Without WebGPU the message leaves the visuals out, since there are none to promise.

Where WebGPU is missing, or the adapter or device cannot be had, the stage shows artwork exactly as before and says so once. There is no WebGL fallback and none is planned.

## The two library elements

Gapless playback (see [the player note](player.md#gapless-playback)) needs a second element to load the next track while the first plays, so the library has two, and the roles swap at each track change. The visualizer has to survive that, and a media element can be given to `createMediaElementSource` once only, so the split is:

- **visimo** builds the graph (the context and the analyser) and wires up the first element it is given. `attachAudio` was written for one element and refuses any other, and the source it makes is inside the package where a host cannot reach it.
- **Musimo** (`routeToAnalyser` in `player.tsx`) therefore gives `attachAudio` an element of its own that never has a source and never plays, the anchor, on every `play` event of a library element. That call is what builds the graph and what resumes a suspended context. Musimo then makes each library element's source itself and connects it to the analyser, read from `audioGraph()`, once, the first time that element plays. Both library elements go the same way, so neither is special. The visualizer reads the analyser, so it is unaware of which element feeds it.

If a real library element were handed to `attachAudio`, visimo would keep it, the other would be wired here, and the two would differ (see the boost below). If neither were wired here, the visualizer would go flat while the music kept playing, because the elements would play directly, unanalysed. That is the failure to look for whenever the visimo pin moves or this function changes: play two tracks in a row with the visualizer on and check that the stage still moves after the swap. WebGPU is missing from headless browsers, so `e2e/visualizer.spec.ts` cannot see the picture, but `e2e/gapless.spec.ts` checks that both library elements get a source on the graph. If visimo ever accepts several elements itself, or lets a host connect its own sources, the anchor can go.

Previews still never reach it. The preview element is separate, is not part of the pair, and is not swapped.

### The ReplayGain boost

An element's `volume` cannot pass 1, so a [ReplayGain](player.md#volume-levelling) gain above 1 has to be applied in the graph. Because Musimo makes both library elements' sources, both get the same chain:

```
each library element:  source -> GainNode -> analyser -> speakers
                                  ^ carries only the part above 1
the anchor:            source (in visimo, silent) -> analyser
```

`routeToAnalyser` puts a gain node between each element's source and the analyser, at 1 until `applyVolume` sets it. The element keeps its own volume for everything up to 1 (`splitLevel`), and the node carries only the part above it. The analyser sits after the node, so the stage sees the boosted level that is heard.

The boost is used only when the track has a peak tag, only while the context is running, and never for a preview. With no graph yet (nothing has played) or a suspended context, no node is used and the volume is set as before. `e2e/gapless.spec.ts` checks that a quiet fixture track gets the same gain on both elements across a handover. When the visimo pin moves, check that each element's chain is still source, gain node, analyser.

## When it draws

Artwork is the default view, because the visualizer is heavy on the GPU. A browser that has never stored a choice starts on artwork, even where WebGPU exists, and the Visualizer toggle (or V, or the setting) is one click away. A browser that already stored `visualizer` or `artwork` keeps it. The stored key cannot tell an old default from a deliberate choice, so a browser that only ever ran the old default keeps `visualizer` until it is switched.

The docked stage draws only while someone can see it. `useStageVisible` in `now-playing-popout.tsx` turns it off when the document is hidden (`visibilitychange`) and when the stage is scrolled out of view or under the phone layout's scroll (`IntersectionObserver` on the stage element), and turns it back on when both are true again. The stage component has no pause that Musimo uses, so "off" means the visualizer is unmounted and the artwork shows in its place, then it mounts again. The view setting is untouched (the toggle still reads On), the audio element is never touched, and the renderer outlives the stage, so coming back costs a canvas rather than a device. The popout window counts as visible for as long as it is open: it is a document of its own that stays on top, so neither of those checks runs there.

A third reason to rest is a long pause. Once playback has been paused for more than 10 seconds (`PAUSE_REST_MS`), `useStageVisible` returns false the same way, so the visualizer is unmounted and the artwork shows, in the popout as well as the docked stage. Play brings it back. The timer restarts from each pause, so a short one, or a pause that is undone in time, never swaps the picture. Nothing is drawn worth keeping while paused, and the canvas is the expensive part of the stage.

Fluid's grid default and the canvas size are unchanged; a render size cap was considered and declined.

## How big it draws

On Now Playing the docked stage is as wide as its column or as tall as the height the column leaves above its controls, whichever is smaller, and the full content width on a phone (see [the popout note](now-playing-popout.md#layout)). It used to be at most 320 px, and later 60% of the content width. The canvas and the post stack's offscreen textures follow the stage, so a docked stage in a tall window has several times the pixels a 320 px one had, and the fluid's grid setting does not shrink that. The frame times in visimo's README were taken at the smaller size and have not been measured again at this one; check `data-frame-ms` on the canvas (H shows it) on a low-end machine before trusting them.

The Large stage (see [the popout note](now-playing-popout.md#stage-size)) is bigger again. It is the page's full content width by the height a window leaves above the controls, so on a wide window it has several times the pixels of the Small square, and it is not a square: the canvas and the post stack's textures follow that box, as they do in full screen. There is no render size cap on it and the fluid's grid default is unchanged, both declined, so the same check applies, at Large.

## The canvas attributes

The package writes `data-adapter`, `data-frame-ms`, `data-scene`, `data-detail`, `data-post` and `data-preset` on the scene canvas, and `e2e/visualizer.spec.ts` asserts on all of them. They are visimo's public API, so a version bump that changes one breaks this suite; the class names `stage-visualizer` and `stage-hud` are Musimo's own and are passed to the stage as props.

## Checks

`e2e/visualizer.spec.ts` needs an adapter for all but its first test, so it runs in headed Chromium. Headless Chromium, Firefox and WebKit have no adapter, so they run the artwork fallback test and skip the rest. That is the documented behaviour rather than a gap. The pause test (canvas kept for three seconds of pause, gone before fifteen, back on play) is one of the skipped ones and has not been run headless; the rule it checks is in [When it draws](#when-it-draws).

A test that touches the Now Playing stage has to pin the view rather than rely on the default: a test that needs the canvas stores `visualizer` first, and one that needs the artwork stores `artwork`. `visualizer.spec.ts` also checks that artwork is the default with an adapter present, and that the canvas goes away while the document is hidden and comes back. See [the testing note](testing.md).

The frame times, the preset screenshots, the popout round trips and the tuning history are all in visimo's README. They were taken while this code lived here and nothing in the move touched a shader, a parameter or a uniform.
