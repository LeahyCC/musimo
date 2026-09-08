# Visualizer evidence record

Inspected on 8 September 2026. Production source and dependencies were not changed. The checkout started clean on `feature/music-visualizer`, at `d529b9f` (the committed cleanup), rather than the uncommitted state described in the supplied handoff.

## MilkDrop3

The current free release is [3.33](https://github.com/milkdrop2077/MilkDrop3/releases), dated 3 March 2026 in its README. It adds shader-accessible FFT, selectable audio devices, mouse input and blending between double presets. Earlier additions include `.milk2` composition, more shapes/waves, expanded Q variables, many transition masks and shader editing. The README explicitly says some shaders are closed and run only in MilkDrop3. These are extensions beyond the common MilkDrop 2 vocabulary. [Feature history](https://github.com/milkdrop2077/MilkDrop3#history).

The strongest reference is the combination of a programmable image warp, accumulated feedback, shader composition and preset authoring tools. Double presets hold two visual systems together. Beat-triggered hard cuts are useful for live performance, but threshold crossings alone do not identify a song's sections or recurring ideas.

The application targets Windows; its site points Mac users to virtualization and Linux users to a separate recipe. It is not a browser library. The checked-out [code licence](https://github.com/milkdrop2077/MilkDrop3/blob/b59935a3d58b33faff7c918f73f7f9f628d24456/code/LICENSE.txt) is BSD-3-Clause. That does not establish permission to redistribute every current application asset: the [application site](https://www.milkdrop3.com/) distinguishes personal/non-remunerated use from PRO use. The public source inspected still declares `NUM_Q_VAR 32` in [state.h](https://github.com/milkdrop2077/MilkDrop3/blob/b59935a3d58b33faff7c918f73f7f9f628d24456/code/vis_milk2/state.h#L49), unlike the newer feature description. Do not assume this code reproduces the current binary. Verify each chosen shader, texture and compiled asset separately.

Watched the author's [double-preset recording](https://www.youtube.com/watch?v=6UXKyz4nOfI) and part of [3.31's first 100 visuals](https://www.youtube.com/watch?v=Ppq2NkId9_A). These establish implemented motion and visual range, not local speed or browser portability. No native MilkDrop3 benchmark was run. Claims about demanding presets and high FPS in the README remain the author's observations.

## Butterchurn

The npm registry reports `latest: 2.6.7` and `beta: 3.0.0-beta.5`. The inspected [master commit](https://github.com/jberg/butterchurn/tree/fbac2f6bab62fd9c6a50ebbeb29359c5eb05903e) is from 19 April 2026; npm stable identifies [d90f271](https://github.com/jberg/butterchurn/tree/d90f271be02969d8f16a3ed6b6960c971da6eff9). Pin the renderer and preset package together. A Butterchurn version numbered 3 is not MilkDrop3 compatibility.

This is the shortest browser route to the common MilkDrop 2 effects: programmable warp/composite shaders, feedback textures, blur, custom shapes/waves and time-based preset blending. Its [API](https://github.com/jberg/butterchurn#usage) accepts a Web Audio node; the inspected renderer also accepts externally supplied time-domain PCM windows through `render({audioLevels, elapsedTime})`. Despite the parameter name, those arrays are audio samples, not precomputed bass/mid/treble values. Presets can be authored as MilkDrop equations and HLSL, then translated with the [preset converter](https://github.com/jberg/milkdrop-preset-converter), or edited in the converted representation. Conversion and texture availability need preset-by-preset validation.

The engine and the [preset package](https://github.com/jberg/butterchurn-presets/blob/master/LICENSE) declare MIT licences. Preserve creator names and notices and inspect any additional third-party assets in the selected presets. This is not a licence for MilkDrop3-exclusive shaders.

The engine requires WebGL2. [MDN compatibility data](https://github.com/mdn/browser-compat-data/blob/main/api/WebGL2RenderingContext.json) lists Chrome 56, Firefox 51 and Safari 15 as introduction versions. That establishes API availability, not tested renderer behaviour on every current device. Only Windows Chromium was exercised here. Firefox, Safari/iOS, integrated GPUs, context loss and thermal throttling remain untested.

The public `butterchurnviz.com` page failed to become usable in this session and logged a `TypeError` while loading. Webamp did run Butterchurn while playing its supplied Diablo Swing Orchestra track, `Heroines`. Its visualizer and preset list were inspected. This was not a listening test of Musimo.

An isolated harness then ran unmodified npm engines and three named presets with the upstream recorded PCM fixture. Source inspection explains their different behaviour:

- [Sherwin Maxawow](https://github.com/jberg/butterchurn-presets/blob/master/presets/milkdrop/Flexi%2C%20martin%20%2B%20geiss%20-%20dedicated%20to%20the%20sherwin%20maxawow.milk) uses band-driven shapes and opposing per-pixel motion. Its feedback produces flowing surface detail.
- [Witchcraft Reloaded](https://github.com/jberg/butterchurn-presets/blob/master/presets/milkdrop/martin%20-%20witchcraft%20reloaded.milk) maintains equation memory arrays, combines several audio bands and uses image/blur sampling for bright strands and stars. Restoring just a clock and a texture would miss state.
- [Castle in the Air](https://github.com/jberg/butterchurn-presets/blob/master/presets/milkdrop/martin%20-%20castle%20in%20the%20air.milk) seeds fractal parameters at initialization. It demonstrates spatial complexity, but its sampled appearance was too diffuse for the leading visual references.

## Measured browser cost

Windows 11 host, in-app Chromium 152, ANGLE/D3D11, NVIDIA RTX 5080. Each run rendered 600 frames, excluded the first 60 from frame statistics, used a fixed supplied step of 1/60 second and advanced one upstream fixture entry per frame. The fixture itself was sampled around 30 Hz. These runs measure graphics cost and repeatability, not synchronization to an audible song. Pixel ratio and texture ratio were both 1; other test visualizer tabs were closed before measurements.

The measurement wraps `render()` and `gl.finish()`, so it includes a forced GPU completion wait rather than only JavaScript submission time. RequestAnimationFrame intervals reflect the host's roughly 180 Hz scheduling. They are not advertised playback FPS. The beta also copies its internal WebGL result to the output canvas, so cost is not directly comparable to a native render path.

- Beta Sherwin, 1280 × 720: render/finish p95 2.1 ms in the retained repeat run; preset load 5.1 ms with resources already warm.
- Beta Witchcraft, 1920 × 1080: render/finish p95 7.5 ms; initial preset load 44.9 ms.
- Beta Castle, 1920 × 1080: render/finish p95 1.3 ms; initial preset load 17.0 ms.
- Stable Witchcraft, 1920 × 1080: render/finish p95 5.0 ms; initial preset load 46.7 ms. It rendered successfully, but this single sample is not a fair engine speed ranking because stable does not provide the beta's seeded mode.
- Beta Sherwin into Witchcraft over a two-second simulated blend, 1920 × 1080: whole-run render/finish p95 9.0 ms, maximum 14.9 ms; transition preset load 12.1 ms; largest animation-frame interval 22.3 ms. The figures cover the whole run, not only the blend window. This was a visible blend, not a `.milk2` composition test.

All completed runs reported zero WebGL error and no measured animation-frame interval above 33.34 ms. Shader warnings/errors were absent in the inspected beta preset logs. These short runs on a strong desktop GPU do not establish sustained mobile performance. Initial shader loading can already exceed one 60 Hz frame, so warming selected shaders before a transition belongs in the next experiment.

Repeated the beta Sherwin run from a fresh page with the same seed and inputs. Both frame-600 PNG files had SHA-256 `1fd2454b6f225bd1f53765a70a760eb0114dc1b92538c039cf5706b82611a958`. This is one same-machine repeatability check, not a proof of arbitrary preset, seek or cross-GPU determinism.

The beta's [random context](https://github.com/jberg/butterchurn/blob/fbac2f6bab62fd9c6a50ebbeb29359c5eb05903e/src/utils/rngContext.js) overrides `Math.random`, `window.rand` and `window.randint`. Its [clock](https://github.com/jberg/butterchurn/blob/fbac2f6bab62fd9c6a50ebbeb29359c5eb05903e/src/rendering/renderer.js) advances using a smoothed FPS estimate. A production controller needs scoped randomness and a deliberate simulation clock. Neither supplied elapsed time nor a seed restores prior feedback, equation memory or audio history.

## projectM

[Stable 4.1.7](https://github.com/projectM-visualizer/projectm/releases/tag/v4.1.7) was released on 14 July 2026. It is a reusable C/C++ library with a C API, caller-supplied PCM and OpenGL rendering. It parses MilkDrop presets and translates HLSL shaders, with built-in transition shaders and separate preset/texture collections. Frontends supply audio capture and player integration. This is a strong precedent for keeping engine and playback ownership separate.

Its core is [LGPL-2.1](https://github.com/projectM-visualizer/projectm/blob/v4.1.7/LICENSE.txt); frontends and preset packs have their own terms. Browser distribution through a static WASM build needs the corresponding library source/modifications and a compliant relinking path. Packaging that obligation is additional work, not a reason to assume the whole application must use the same licence.

Official [Emscripten guidance](https://github.com/projectM-visualizer/projectm/blob/397f15eb21d2ad8be7dbdec00595e509193ef6e7/docs/emscripten.rst) requires WebGL2/OpenGL ES 3 compatibility. The [example repository](https://github.com/projectM-visualizer/examples-emscripten) is a basic wrapper and contains dated claims about browser threading. Its build instructions should be checked against current code rather than treated as a maintained browser product.

The development API's `projectm_set_frame_time` is marked [since 4.2.0](https://github.com/projectM-visualizer/projectm/blob/397f15eb21d2ad8be7dbdec00595e509193ef6e7/src/api/include/projectM-4/parameters.h). It is absent from stable 4.1.7. Even the newer clock does not restore feedback state or guarantee deterministic randomness.

Watched the [GStreamer offline render recording](https://www.youtube.com/watch?v=jJmLQGhYWys&t=40s) linked by the project's README. Around 0:49 it shows coloured shapes, trails and accumulated spatial deformation. It proves an implemented export path, not browser speed. A third-party fork's advertised browser URL resolved to a different experimental application, so it was rejected as compatibility evidence. No current native or WASM projectM performance benchmark was completed here. Neither its native library boundary nor its MilkDrop compatibility establishes support for `.milk2`, MilkDrop3 FFT functions or exclusive shaders.

## Reproduction and remaining evidence

The disposable harness, source checkouts and raw captures are under `C:/Users/cclea/AppData/Local/Temp/musimo-discovery-20260908`. The harness uses npm versions above and upstream fixture data. It is an evaluation tool, not Musimo's proposed development preview. The two selected reference frames and compact benchmark results are retained in `docs/assets/visualizer-discovery/`.

Still needed: reference songs; native MilkDrop3 inspection of the selected modern shaders; a matched-preset projectM run if it remains a candidate; Firefox/Safari and ordinary-device measurements; exact checkpoint restoration; and audible Musimo playback tests. No renderer was selected or integrated, no previous implementation restored, and the retained old analysis volume was not used.
