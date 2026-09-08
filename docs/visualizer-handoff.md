# Visualizer discovery handoff

## Start here

Start a fresh discovery for Musimo's next-generation music visualizer. Use [MilkDrop3](https://github.com/milkdrop2077/MilkDrop3) as the main reference. The previous custom ribbon and membrane renderers were rejected. Their implementation has been removed from this checkout. Do not revive them or treat their architecture as a requirement.

The old visualizer system must stay removed, including its frontend integration, audio analysis code and backend service. This is a replacement from scratch, not a refactor of that system. Preserve Musimo's normal music player. Develop the new engine independently and integrate it through a small adapter only after the discovery and visual direction are established.

The goal is a medium in which songs come to life. Each song should have a characteristic visual journey. Forms grow, morph, dissolve and return as its rhythm, texture, tension and structure develop. Spacious tracks, heavy bass, liquid DnB and death metal should produce different experiences without reducing them to fixed genre templates. We are not bound to one shape. Returning musical ideas should recall recognisable visual ideas, changed by what happened between.

Build the visualizer as an independent engine with its own development preview. Musimo should bring it into the frontend through a small adapter. Discover the right package or process boundary; a separate engine does not automatically require a network service. Keep playback ownership clear and preserve normal playback through entry, exit, pause and seek.

## Discovery work

Research the strongest parts of MilkDrop3, [Butterchurn](https://github.com/jberg/butterchurn) and [projectM](https://github.com/projectM-visualizer/projectm): shader quality, feedback, preset authoring, transitions, audio input and reuse. Inspect real running examples and specific presets. Verify current compatibility, licensing, browser support and performance rather than assuming these engines support the same effects. MilkDrop3's README identifies newer features and some shaders exclusive to that application. Butterchurn is a browser implementation of MilkDrop 2, not proof of full MilkDrop3 compatibility.

Recommend how immediate audio response, whole-song analysis and visual memory should work together. Distinguish what can be inferred from frequency bands from what needs structure analysis or source separation. Live input cannot anticipate unheard music. Investigate seeking and deterministic replay explicitly, since feedback rendering depends on prior frames.

Produce a short recommendation grounded in visible examples, an independent-engine integration proposal, the main open risks and a first milestone: one real song with a compelling, continuous visual journey. Choose a small set of strong visual references before building. Do not start another full renderer during discovery. Ask for reference songs when needed, while continuing independent research.

The original mock at `docs/assets/visualizer-reference.png` remains inspiration for crispness, depth and fine detail. Its four phases and ribbon shape are not requirements. Do not use generated stills as evidence of an implemented renderer's quality.

## Workspace after reset

- Repository: `C:/Users/cclea/projects/musimo`.
- Branch: `feature/music-visualizer`. No new branch or task is needed unless requested.
- The old prototype is recoverable in Git at `4a5331e` for historical inspection only. The cleanup is recorded by the commit containing this handoff. Do not restore the old prototype or reset the whole repository. If starting a new branch from `main`, carry this discovery brief with you and verify that the old system is absent there too.
- Removed from the active source: both renderer experiments, studies, visualizer UI, audio analyser/worklet/director, backend analysis worker/routes, preview proxy introduced for Web Audio, feature-specific dependencies, tests and CI entries.
- Normal music playback remains. The queue-restoration race fix is preserved: a late saved queue must not replace playback the user has already started.
- Main backend: `http://127.0.0.1:8765`. Development frontend: `http://127.0.0.1:5174`. Existing running main and CI containers were not rebuilt by the reset.
- No visualizer engine has been selected or integrated. There is no working visualizer page after cleanup.
- The old detached `musimo-visualizer` worktree and its stopped preview container were removed. The separate analysis data volume was retained. It is not used by the current source.
- Verification: frontend build, lint and browser-test type checks pass; nine search/player backend tests pass; the existing Chromium player navigation and AudioMuse radio test passes against port 5174. That browser test mocks its audio response and does not prove audible playback. Dependencies were reinstalled from the restored lockfile. The build still reports the existing large main-chunk warning.

Keep replies short. Show actual visual results early. Colin wants the hardest architectural and graphics work identified so he can choose when to use Ultra.
