# Now Playing visualizer

A WebGPU visualizer for the Now Playing stage, built in small steps. This note records what each step added and what was checked by hand, in the style of [the popout note](now-playing-popout.md). Where WebGPU is unavailable the stage shows artwork exactly as before.

## Audio graph

Library playback feeds one Web Audio `AudioContext` and one `AnalyserNode` (`fftSize` 2048, no smoothing; the feature extractor smooths per band). The graph lives in `frontend/src/visualizer/audio/AudioGraph.ts`, a module singleton that survives any remount, and the player loads it on demand from the library element's first `play` event.

Two rules keep playback safe:

- Only the library element is ever attached. Catalog previews stream straight from the provider's CDN with no CORS headers; a `MediaElementSource` on such media is silenced by the browser, and a source can only be created once per element, so the damage would be permanent. This is why `player.tsx` has one element for previews and one for library tracks.
- The source is attached only once the context is running. A context made outside a user gesture starts suspended, and a source on a suspended context is silent. Building it from a `play` event that was itself allowed to start, and checking `state === 'running'` after `resume()`, means the track keeps playing on its own if the browser refuses. The next play tries again, and the player also resumes the context when the tab becomes visible.

## Code

- `frontend/src/visualizer/audio/AudioGraph.ts`: the context, the analyser and the attach and resume rules above.
- `frontend/src/player.tsx`: the two audio elements, the handlers they share (each ignores events from the element that is not current), and the visibility resume.

## Checks

Playwright cannot hear audio and headless engines stop it early, so the suite only proves the structure: the preview checks in `e2e/app.spec.ts` drive the preview element, the phone player checks drive the library element, and the player shortcut checks still pass.

Checked by hand, each on a named machine and browser:

- The analyser reports non-zero frequency data during library playback.
- A catalog preview is still audible after a library track has played, and vice versa.
- Pausing the tab, switching tabs for a minute and coming back resumes the context.
