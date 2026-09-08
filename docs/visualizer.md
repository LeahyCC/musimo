# Music visualizer

The previous visualizer prototype has been removed. Normal playback remains available, but there is no Visualize action or analysis service in the current source.

The new direction is an independent visualizer engine, brought into Musimo through a small frontend adapter. Its visuals should evolve organically with each song and retain a recognisable identity across its musical journey.

Discovery starts with MilkDrop3 and compatible engines. No replacement engine has been selected. See the [discovery handoff](visualizer-handoff.md) for the brief, references and workspace state.

The [first discovery recommendation](visualizer-discovery.md) proposes a browser package and a one-song experiment, with [measured preset evidence](visualizer-evidence.md). It leaves engine selection open until visual control and replay are proved.

Implementation has started in the independent [`visualizer/` package](../visualizer/README.md). Colin selected Ben Böhmer's “Dive (Extended Mix)” and asked for fluid, soothing motion after inspecting the first preset auditions. See the [build record](visualizer-build.md) for the current preview, song preparation, verification and remaining work. Musimo's normal player still has no Visualize action.
