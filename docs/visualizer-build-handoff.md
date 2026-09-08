# Visualizer build handoff

Continue Musimo's visualizer buildout from the completed first discovery pass. The user has asked to move into implementation. Start with a working independent preview and one real song; bring it into Musimo through a small adapter once that journey works. Do not restart broad discovery or stop at another plan.

## Read first

1. `docs/visualizer-discovery.md`: recommendation, visual references, playback boundary and replay policy.
2. `docs/visualizer-evidence.md`: inspected versions, source findings, measurements and their limits.
3. `docs/player.md` and the current `frontend/src/player.tsx`: actual playback behaviour.
4. Relevant repository instructions and governing docs before editing code.

The discovery recommendation is provisional. Butterchurn is the first implementation candidate; no engine has been integrated or finally selected. Resolve specific capability gaps while building the small experiment. MilkDrop3 is the main visual reference, not a promise of compatible shaders.

## What to build

The goal is a medium in which a song develops a characteristic visual journey. Forms can grow, morph, dissolve and return. Returning musical ideas should recall recognisable visual ideas, changed by what happened between. Spacious music, heavy bass, liquid DnB and death metal should behave differently because of their musical content, without fixed genre templates.

Use a self-contained `visualizer/` package with its own build and development preview. Export the engine for Musimo to import. The preview owns its test player. The engine owns rendering and visual state; Musimo retains ownership of its audio element, queue and transport. Rendering does not need a network service.

Do not revive the rejected ribbon or membrane renderers, their analysis workers or their architecture. The original mock at `docs/assets/visualizer-reference.png` is inspiration for crispness, depth and detail. Its shape and four phases are not requirements.

Reference songs are still missing. Ask Colin for one main song and optionally two contrasting tracks, while continuing package setup and engine checks. Use an available real recording as an explicitly labelled development fixture if needed. Do not claim the one-song milestone is accepted before Colin has seen it.

## Start with these visual references

- `docs/assets/visualizer-discovery/witchcraft.png`: actual Butterchurn output from `martin - witchcraft reloaded`. Fine points, layered motion and dark space.
- `docs/assets/visualizer-discovery/sherwin.png`: actual Butterchurn output from `Flexi, martin + geiss - dedicated to the sherwin maxawow`. Flowing material and surface detail.
- [MilkDrop3 double presets](https://www.youtube.com/watch?v=6UXKyz4nOfI): coexistence and transformation.
- [MilkDrop3 3.31 footage](https://www.youtube.com/watch?v=Ppq2NkId9_A&t=40s): atmospheric depth. The pictured modern shader's name and reuse rights were not established.

These are reference qualities, not a required playlist. A sequence of unrelated presets will not satisfy the goal. Show actual moving renderer output early. Generated stills cannot demonstrate renderer quality.

## Build sequence

1. Run a named preset in the independent preview with a real recording and working play, pause and seek. Pin engine and preset versions. Establish the narrow controls needed for an authored journey before expanding the package.
2. Create a versioned song data file and a reviewed timeline for the main recording. Begin with a local analysis command, rather than another backend service. Include recording identity, duration, sample rate, analysis version and timing offset. Sample prepared PCM/features by media time, independently of display refresh.
3. Build the musical controller and two or three related visual ideas. Combine immediate attacks and texture with slower section development and recurrence. A repeated idea must return recognisably after a contrasting passage. Allow manual correction of the first song's analysis so detector errors do not dictate its art.
4. Prove deterministic replay from the start. Test seeking explicitly, including into a transition, and record the chosen restoration behaviour. Measure shader loading, sustained rendering and blends. Warm selected shaders before they are needed.
5. Add the small Musimo adapter after the independent journey is convincing. Verify the complete playback flow and update its documentation in the same work.

## Findings that change implementation

At discovery time, npm stable Butterchurn was `2.6.7`; beta was `3.0.0-beta.5`. Both rendered the tested MilkDrop 2 presets. The engine and preset package declare MIT licences. Preserve author attribution and notices and verify additional assets. Butterchurn's version 3 does not mean MilkDrop3 compatibility.

The beta's deterministic mode overrides global `Math.random`, `window.rand` and `window.randint`. Do not let it alter Musimo's randomness. Scope or isolate it before embedding. Its clock also advances through smoothed FPS, so merely supplying elapsed time does not establish a precise media-clock simulation. Inspect the selected version's implementation and make the smallest necessary changes.

MilkDrop3 3.33 includes newer FFT access, `.milk2` features and some closed shaders. Its public BSD code does not establish rights to every current binary asset. projectM stable 4.1.7 is an LGPL native library with a WASM build path; its explicit frame-time API was marked for unreleased 4.2. Keep it as an alternative, not an assumed drop-in browser upgrade.

Frequency bands reveal energy, not reliable instrument identity or song structure. Use onset/texture features for immediate response and recurrence/section analysis for longer development. Add source separation only if a musical distinction needs it. Live input cannot anticipate unheard music.

## Playback and replay rules

Musimo shares one audio element between same-origin library streams and external Deezer/iTunes previews. A Web Audio media-element source reroutes that element and can silence cross-origin previews. Disconnecting it does not restore the original native output path.

For the first library integration, use prepared audio data from the matching recording plus the existing player clock. Do not reroute sound as an incidental visualizer change. A future live tap requires a player-owned persistent audio graph and verified handling of every source.

Entry and exit must not restart or stop music. Pause freezes the score and feedback. Seek cancels stale preparation and moves the score to the new position. Track changes reject old song data. Hidden-tab recovery follows a defined catch-up policy. Preserve the guard that prevents a late saved queue from replacing playback already started by the user.

Musical memory and pixel history are separate. Use a fixed simulation step and instance-local randomness. Exact seek restoration needs feedback textures, equation memory, random state, audio smoothing, clocks and transition state. Neither candidate supplies a complete checkpoint API. Prove restoration on one preset before promising exact seeking. If its cost is unacceptable, document a brief dissolve into a seeded reconstruction at the destination. That can preserve musical identity but is not identical-pixel restoration.

## Verification and first milestone

Deliver a complete real song in the independent preview, with continuous transformations and a recognisable returning idea. Provide live inspection and a recording of actual playback, then demonstrate repeat playback and forward/backward seeks. After integration, check entry, exit, repeat entry, pause/resume, seeking, track changes and library-to-preview switching. A test with mocked audio does not prove audible playback.

Initial target: 1080p/60 on the chosen desktop, with a usable lower-resolution fallback and uninterrupted sound. Discovery measured short runs on an RTX 5080 in Chromium 152 only. The beta blend had whole-run render-plus-GPU-completion p95 of 9 ms. One same-seed replay produced identical PNGs on that machine. These are not laptop/mobile, Safari, exact-seek or cross-GPU guarantees.

The old benchmark advanced one roughly 30 Hz fixture entry per rendered frame while supplying a 1/60-second simulation step. It tested graphics cost and repeatability, not song synchronization. Do not copy that timing into the player. Its `gl.finish()` calls were measurement instrumentation, not a production rendering requirement.

Use Ultra for the musical controller, shader control surface and feedback restoration design. Routine package setup and adapter wiring do not need it. Colin wants to choose when to use Ultra; do not switch models or delegate automatically.

## Checkout and running services

- Repository: `C:/Users/cclea/projects/musimo`.
- Branch: `feature/music-visualizer`. Stay here; no new branch or task was requested.
- Cleanup commit: `d529b9f`. The old prototype at `4a5331e` is historical only. Do not restore it or reset the repository.
- Discovery changes are local and uncommitted: `docs/visualizer-discovery.md`, `docs/visualizer-evidence.md`, `docs/assets/visualizer-discovery/`, and edits to `docs/visualizer.md` and `docs/visualizer-plan.md`. This build handoff is also new. Preserve them.
- Main backend: `http://127.0.0.1:8765`. Development frontend: `http://127.0.0.1:5174`. Verify their current state before using or rebuilding anything. Existing containers may not match the checkout.
- No visualizer page, engine package or analysis service exists in active source. The previous detached visualizer worktree and stopped preview container were removed. The retained old analysis volume is unused.
- Disposable research sources and harness: `C:/Users/cclea/AppData/Local/Temp/musimo-discovery-20260908`. Its server on port 5188 was stopped. This is not the new development preview. Durable captures and measurements are in the repository docs.
- The cleanup handoff reported frontend build/lint/browser-test type checks, nine backend tests and a mocked Chromium player test passing. Discovery changed no application code or dependencies. Discovery formatting, diff checks and the comparison board's type check passed. Re-run checks appropriate to the build changes; do not claim the old checks validate the new engine.

Keep replies short and show real visual progress. Raise unrelated breakage without silently fixing it. List unresolved work at the end. Do not describe the milestone as complete while playback or the visual journey remains unverified.
