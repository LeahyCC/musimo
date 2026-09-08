# Music visualizer

Play a library track, open Now Playing and select **Visualize**. The world fills the screen. Movement or a tap reveals playback controls; three seconds of inactivity hides them. Controls stay available while focused or in use. Escape exits, and the music continues. Browsers without native fullscreen use the available viewport.

## Current visual language

The first world consists of folded, iridescent ribbons, fine filaments and a surrounding particle field. Bass displaces the surface, midrange changes its folds, high frequencies add fine movement and light, and detected attacks send short accents through it. Camera movement follows song time and stops on pause.

A completed song map adds anticipation before a stronger section and recalls forms when a similar harmonic section returns. These are estimates from energy and chroma similarity. They do not identify instruments, melody, choruses or downbeats. The current renderer uses parametric geometry, not a fluid simulation or neural video generator.

The settings menu provides intensity, camera motion, automatic/high/lightweight quality and a saved timing adjustment. Positive timing values bring the visual forward. **Remix** chooses a different seed, **Save** remembers that seed for this track, and **Hold** keeps the current fold and tension while the surface responds to music. General settings are saved in browser storage. Reduced-motion preference starts camera motion at zero.

## Audio and graphics

`PlayerProvider` owns one audio element and one persistent Web Audio graph. Analysis branches before volume control, so muting does not remove the visual signal. An AudioWorklet measures block energy and stereo width; native analysers provide frequency bands and spectral changes. If worklets are unavailable, native analysis remains available. Closing the world disposes its renderer while retaining the audio connection.

The visual controls load separately from Three.js. `WebGPURenderer` chooses WebGPU when available and supports a WebGL 2 path. Lightweight quality caps drawing at roughly 30 frames per second and skips bloom. Automatic quality adjusts drawing resolution from frame duration. It is a performance policy, not a measured guarantee of 60 fps on every device. Hidden tabs stop drawing. A graphics failure shows a way back to Now Playing without stopping audio.

Catalog previews use `GET /api/preview/{track_id}/stream`, including the existing iTunes fallback. The backend resolves the provider URL, validates every redirect, accepts audio content and limits the response to 10 MiB and 25 seconds after lookup. The endpoint accepts a catalog ID, never an arbitrary URL. This keeps later previews audible after the shared element has entered Web Audio.

## Song analysis

`POST /api/visualizer/analysis/{id}` requests analysis. `GET` at the same path returns `missing`, `queued`, `analysing`, `ready` or `failed`. Ready responses include version, duration, sampled curves, beat timestamps, pulse regularity and sections. The browser checks the recording duration before using the map. A failed or unavailable map leaves live visuals running.

One worker serves a queue of up to eight waiting jobs. It obtains the authenticated Navidrome stream on the backend, writes temporary audio under the application data directory, then runs FFmpeg and librosa in a separate process. Audio is removed after each job. Recordings over 30 minutes or 256 MiB use live visuals. Fetching and analysis have separate 180-second and 240-second deadlines. Long recordings can still consume substantial worker memory within those limits.

The private `visualizer/` directory holds a SQLite index and compressed maps. Metadata and server identity invalidate changed recordings; completed maps are keyed by downloaded content and analysis version. Unchanged metadata is rechecked after 24 hours. Map files are limited to 128 MiB in total. Interrupted jobs become retriable failures on startup and abandoned temporary audio is removed. No credentials or source audio are sent to a third-party analysis service.

## Development

The usual Vite development proxy targets `http://127.0.0.1:8765`. A local `frontend/.env` can set `MUSIMO_API_URL` and, when testing a separate analysis backend, `MUSIMO_VISUALIZER_API_URL`. Both default to the same server. Keep the original browser Origin and Host through the proxy so same-origin write checks work.

Run `npm run test:director --prefix frontend` for choreography checks. With a local app at port 5174, run `npm run test:visualizer --prefix frontend`; set `MUSIMO_TEST_URL` for another address. The browser tests generate audio and mock library/player writes. `uv run python -m unittest tests.test_visualizer tests.test_search tests.test_player` covers offline analysis, cache behaviour, provider proxy rules and playback APIs.

## Still open

The broader [visualizer plan](visualizer-plan.md) includes source separation, stronger phrase recognition, additional material worlds, preparing the next queued song, automatic recovery after graphics-device loss and measured audio-to-display timing. Those are not implemented in this first world. Real iOS/Safari and Firefox devices, Bluetooth outputs and sustained high-resolution GPU performance still need validation. The displayed beat and section estimates need evaluation against labelled recordings before making musical-accuracy claims.
