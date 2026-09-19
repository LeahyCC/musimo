# Now Playing visualizer

The visualizer is [visimo](https://github.com/LeahyCC/visimo), a package of its own. What it does, how the fluid and the post stack work, what a preset is and every measurement taken on it are in that repository's README. This note is only what Musimo does around it.

It moved out so scenes and presets could be worked on against a dropped file rather than a music library. Nothing about the stage changed in the move.

## How it is wired in

```
frontend/package.json          "visimo": "github:LeahyCC/visimo#<commit>"
now-playing-popout.tsx         visimo/presets, visimo/catalog, and the stage
                               itself from visimo, loaded lazily
now-playing-overlay.tsx        visimo/presets, visimo/catalog for the top bar
player.tsx                     visimo/audio on the library element's first play
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
| `musimo.visualizer-preset`             | the chosen preset, walked with `[` and `]`        |
| `musimo.visualizer-scene`              | only consulted where no preset was ever stored    |
| `musimo.visualizer-fluid-grid`         | 512 or 1024                                       |
| `musimo.now-playing-visualizer-notice` | the one-time notice shown where WebGPU is missing |

A preset names a scene, so choosing a preset moves the scene select under it and choosing a scene moves to that scene's first preset. The scene select is not drawn while `SCENE_IDS` has one entry in it. H toggles the package's debug overlay.

The way into all of this is a labeled Visualizer control on the stage (On or Off, with a `V` hint), and while it is on, the preset's name between `[` and `]` hints, where the name is the preset select. It stays on screen while the rest of the overlay fades when idle, at reduced opacity, and hides with them only in full screen and in the popout window, which is too small to keep it. It is what makes the keys discoverable; the keys themselves are unchanged. See [the popout note](now-playing-popout.md#now-playing).

## The command palette

Ctrl+K also offers four visualizer commands: Toggle visualizer, Next visualizer preset, Previous visualizer preset and Fullscreen visualizer. Each goes to `/now-playing` first if the tab is elsewhere, then calls the same `PopoutProvider` functions the stage's own controls call (`toggleView`, `cyclePreset`), so the palette never writes the keys above itself. The two preset commands and Fullscreen switch the stage to the visualizer first, since a preset change on artwork would show nothing. Toggle visualizer only toggles while Now Playing is in front; from another route it arrives with the visualizer on, since a toggle on a stage nobody can see could land on the page with the visuals just switched off. `e2e/app.spec.ts` checks that, and that the commands are absent without WebGPU.

All four are left out of the list while `canVisualize` is false, so a browser without WebGPU never sees them.

Fullscreen needs a user gesture, and the palette selection is one. `PopoutProvider` exposes the docked stage's element as `dockedStage`. If it is mounted the click handler calls `requestFullscreen()` on it directly. If it is not (another route, or the stage is playing in the popout) the handler calls `popoutToFullscreen`, which closes the popout, navigates, and lets the stage request fullscreen when it mounts. Either way a rejected request leaves the user on Now Playing with the "Press F" notice.

`palette.tsx` imports only `now-playing-popout`, which is already in the main chunk, and nothing from `visimo`, so the palette adds nothing to the main bundle.

The two audio elements are Musimo's rule, not the package's: previews stream from provider CDNs without CORS headers, and a media element source on such audio is silenced permanently. `player.tsx` keeps one element for previews and one for library tracks, and only the library element is ever handed to `attachAudio`.

Where WebGPU is missing, or the adapter or device cannot be had, the stage shows artwork exactly as before and says so once. There is no WebGL fallback and none is planned.

## How big it draws

On Now Playing the stage is 60% of the content width, up to about 760 px square on a wide desktop, and the full content width on a phone (see [the popout note](now-playing-popout.md#layout)). It used to be at most 320 px. The canvas and the post stack's offscreen textures follow the stage, so a docked stage now has several times the pixels it had, and the fluid's grid setting does not shrink that. The frame times in visimo's README were taken at the smaller size and have not been measured again at this one; check `data-frame-ms` on the canvas (H shows it) on a low-end machine before trusting them.

## The canvas attributes

The package writes `data-adapter`, `data-frame-ms`, `data-scene`, `data-detail`, `data-post` and `data-preset` on the scene canvas, and `e2e/visualizer.spec.ts` asserts on all of them. They are visimo's public API, so a version bump that changes one breaks this suite; the class names `stage-visualizer` and `stage-hud` are Musimo's own and are passed to the stage as props.

## Checks

`e2e/visualizer.spec.ts` passes all four of its tests in headed Chromium, where an adapter exists. Headless Chromium, Firefox and WebKit have no adapter, so they run the artwork fallback test and skip the other three. That is the documented behaviour rather than a gap.

A test that touches the Now Playing stage has to pin the view rather than let the machine decide it, since the stage shows the visualizer wherever there is an adapter and the artwork where there is not. See [the testing note](testing.md).

The frame times, the preset screenshots, the popout round trips and the tuning history are all in visimo's README. They were taken while this code lived here and nothing in the move touched a shader, a parameter or a uniform.
