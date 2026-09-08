# Musimo visualizer plan

Status: first world implemented locally, 7 September 2026. The [current implementation](visualizer.md) includes live audio features, offline song maps, ribbon geometry, musical transitions and full-screen controls. This document retains the broader design direction. Source separation, additional worlds and calibrated timing/performance measurements remain open.

Build a world that develops with the song. A phrase introduces a shape. Its return recalls that shape, carrying traces of what happened between. A buildup changes the pressure, depth and movement of the scene. The release changes its structure. Quiet passages leave room to breathe.

The agreed experience is pure visuals across the screen. Mouse movement, keyboard focus or a tap reveals the controls. This proposal replaces the earlier plan to embed MilkDrop. MilkDrop remains a reference for comparison.

```text
Sound now ----------> immediate movement -----+
                                             +--> one evolving world
Whole-song analysis -> musical choreography --+

       emerge -> build -> release -> return, changed
```

## What should make it special

Musical memory gives recurring phrases a recognisable visual identity. Start with repeated sections detected from acoustic similarity. Recognising a melody through a different arrangement or key is a separate research milestone. Every match carries confidence; weak matches must not force a visual callback.

Anticipation lets the world tighten before a release and open on the event itself. This requires an analysed recording. First playback starts with live reaction while analysis runs; a live stream cannot reliably reveal an unheard future section. Switch to the completed song map at a suitable boundary without a visual jump.

Independent musical layers create counterpoint. Percussion can disturb a surface while sustained tones stretch it and a vocal phrase draws a separate filament through it. Frequency bands alone cannot identify instruments. The full version uses optional local source separation to extract stronger part-specific signals, with confidence and overlap handling.

Transformation carries the experience between musical sections. The same structure can behave like liquid, a membrane, a lattice and a volume. Changes preserve a recognisable centre and follow the music. A track gets a stable starting identity derived from its acoustic features and a saved seed. Remix changes the seed; replay keeps the composition recognisable.

## The first visual language

The concept image shows an iridescent ribbon emerging, compressing, unfolding into an interior space, and returning with visible echoes. It is an art-direction study, not evidence of achievable render quality or musical sync.

Develop four connected techniques within this world:

- Resonant matter: travelling waves, tension and interference across translucent membranes. Transients enter at distinct points and propagate through the structure.
- Echo architecture: traces of previous phrases become layers behind the present. Decay follows musical time where a reliable pulse exists, otherwise elapsed audio time.
- Impossible interiors: continuous folds reveal spaces inside the original form. Section changes alter connectivity, scale and camera depth through controlled deformations.
- Interacting voices: separate fields move through and influence the same material. Their relationships determine intersections and light, with a global composition budget that prevents everything peaking at once.

Use a limited palette per track, intentional darkness and selective highlights. Camera motion, distortion and detail should have independent ranges. The loudest moment does not automatically demand the brightest frame. Material shifts and spatial scale can carry a climax.

## Implementation choices

Use Three.js WebGPURenderer and custom materials, simulations and choreography. Three provides the graphics foundation; Musimo owns the visual behaviour. WebGPU compute supports the ambitious simulation path. The renderer also offers a WebGL 2 backend, but that does not guarantee our compute effects have equivalent fallbacks. Build one explicit lighter rendering path and validate it separately. WebGPU requires a supported secure context, which matters for installations accessed over plain HTTP on a LAN. [Three.js renderer documentation](https://threejs.org/docs/pages/WebGPURenderer.html), [WebGPU documentation](https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API).

Keep React responsible for controls and lifecycle. A renderer outside React owns the frame loop, GPU resources and a bounded simulation step. Feed the simulation musical time and measured features. Avoid React state updates for every audio block or frame. Reuse generic maths helpers; keep musical decisions in the choreography service.

Extend the existing PlayerProvider to own one persistent Web Audio graph and expose transport actions to the full-screen controls. Analyse a branch of the existing audio signal without applying visual effects to the audible path. Create each media source once, resume the context from user gestures, and preserve the destination connection when the visualizer closes. Stop rendering on pause, hidden tabs and exit without suspending an audio context that is still playing music.

The shared player also plays provider previews from external URLs. Routing that element through Web Audio can silence media without suitable CORS permission, even after the visualizer closes. Resolve this before shipping the graph. Use a same-origin preview streaming endpoint with backend-resolved track IDs, reuse provider validation, validate redirect destinations, and bound response size and time. Preserve Deezer refresh and iTunes fallback. Never accept an arbitrary proxy URL. [Web Audio media-source restrictions](https://webaudio.github.io/web-audio-api/#MediaElementAudioSourceNode-security).

Collect live onset strength, energy, spectral shape and stereo features through an AudioWorklet and analysis worker. Keep the real-time callback small and allocation-bounded. It supplies immediate motion while a separate process analyses the full track for beat positions, changes in energy and harmony, and repeated sections.

Start offline analysis with FFmpeg and librosa. Librosa supplies music-analysis primitives, including beat tracking; selecting section boundaries and assigning visual meaning remain our work. Verify its pinned dependencies against the project's Python 3.12 and 3.14 targets before adoption. Essentia and a maintained source-separation model are research candidates if measured accuracy warrants them. Assess each code and model licence before distribution. [Librosa](https://github.com/librosa/librosa), [beat-tracker implementation](https://github.com/librosa/librosa/blob/main/librosa/beat.py).

Run one bounded analysis job at a time in a process separate from the API event loop. Prioritise the current track, then the next queued track. Playback must start without waiting. Reuse Navidrome's authenticated backend stream; process transient audio locally and retain compact features rather than a second music collection. Cache by content identity, decoded rendition and analysis version. Reject stale or mismatched maps after a source change.

Add an idempotent POST to request analysis by validated library track ID, plus a GET for status and available feature ranges. Return explicit queued, analysing, ready or failed states, source duration, version and confidence. Keep sampled curves separate from timestamped events and section identities. Bound payload size and window longer tracks. Store job/cache metadata in SQLite and compressed feature data under the application data directory. Recover interrupted jobs and evict cache entries within a configured storage limit.

## Sync and musical decisions

Align media position, AudioContext time and display time. Use getOutputTimestamp where available to estimate the output-device clock, then account for rendering and display delay. Provide a saved timing adjustment for outputs that need calibration. Re-anchor after seek, buffering, device changes and resume. Decoder delay and transcoded audio need alignment checks before applying a cached map. [Output timestamp API](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/getOutputTimestamp).

Distinguish detection error from scheduling error. A perfectly scheduled wrong beat is still wrong. Evaluate onsets against labelled audio and evaluate visual timing independently with generated impulse fixtures. Live detection inevitably arrives after some sounds; cached timestamps enable anticipation and scheduled accents.

The choreography service combines immediate accents, phrase development and whole-track pacing. It selects a few dominant actions at a time, reserves large transformations for strong evidence, and maintains continuity between them. Treat beat, downbeat and section confidence separately. Never infer every fourth beat is a bar. Free timing, odd metres and tempo changes need their own fixtures. Low confidence produces continuous timbral motion without invented rhythmic cuts.

Replay uses the same high-level choreography for a given track, seed and engine version. GPU simulations need not be pixel-identical across devices. Seeking restores the composition from the song map, clears obsolete trails and performs a bounded warm-up. Returning from a hidden tab must not replay minutes of simulation or missed accents.

## The complete player flow

Start a library track, open Now Playing, select Visualize, then enter the full-screen surface. Request native fullscreen directly from the gesture; if it is unavailable, use an immersive viewport. The track and queue continue through entry, exit and navigation.

Controls disappear after three seconds of inactivity and reappear on movement or tap. Keep them visible while focused, dragging or using a menu. Include play/pause, previous/next track, seek, volume, exit and one scene menu. That menu holds visual intensity, camera motion, quality, Remix, favourites and Hold. Hold preserves the current visual world while it continues responding to music. It does not freeze the canvas.

Space retains playback behaviour. Escape closes a menu first; native fullscreen exit returns to Now Playing, with focus restored to its entry control. Touch targets remain usable on a small screen. Honour reduced-motion preference by starting with artwork until the user explicitly enables motion. Offer a low-motion presentation and constrain flashes during effect design.

Keep errors outside the artwork when possible: failed analysis continues with live reaction; unsupported graphics or a lost device returns to artwork and leaves audio playing. Track changes invalidate previous analysis requests. Closing and reopening the view must not duplicate audio connections, controls or render loops.

## Build sequence and exit checks

1. Establish the audio and timing foundation in isolated feature work against the player interfaces. Preserve previews, library playback, queue restoration and media controls. Demonstrate measured audio-to-visual timing with impulse fixtures, including seek, pause/resume and repeated full-screen entry.
2. Build the complete four-stage ribbon sequence in the concept study. Use an explicitly authored musical event map to test the rendering and choreography independently of automatic analysis. Include material transformation, spatial continuity and visual memory. Record actual footage and frame timings on the Windows PC and a representative Mac.
3. Replace authored events with automatic song maps. Add bounded jobs, caching, repeat detection and confidence-aware direction. Compare authored and automatic results on the same recordings so analysis mistakes remain visible. A cold first play and a cached replay must both work.
4. Add source-separated musical layers and develop the other visual techniques. Benchmark processing cost before enabling this analysis automatically. Models run locally; the default playback path cannot depend on a model download or GPU availability. Curate mappings across electronic, acoustic, orchestral, dense rock and free-time material.
5. Finish the product flow and quality tiers. Save preferences and scene recipes, test the lightweight renderer, add device-loss recovery, and run the existing frontend/backend checks. Update player, architecture, testing and third-party notices in the same implementation work.

The performance target is sustained 60 fps on the nominated desktop configurations at an explicitly recorded internal resolution. Investigate 4K output on the PC, measuring internal resolution and upscale separately. Reduce simulation size, ray steps and render resolution before sacrificing music timing. Set a 30 fps tier for smaller devices. Profile transitions, long sessions, GPU memory and repeated entry; the concept image is not a performance promise.

Proposed timing gate: on a calibrated wired desktop fixture, at least 95% of scheduled visual accents land within 35 ms of the measured audible event, without accumulating drift over ten minutes. Report detector accuracy separately. Test Bluetooth and display-specific adjustments independently; browser clocks alone do not establish physical sound-to-screen accuracy.

Judge the experience on at least twelve varied tracks, including Colin's selections. Compare the correctly timed version with deliberately shifted controls and a MilkDrop reference. Ask listeners about perceived connection, recurring motifs, pacing and whether they want to keep watching. Reserve several tracks from tuning. A showcase designed around one drop does not establish a general visualizer.

## Open items

- Colin's two or three reference tracks will anchor the listening set. The architecture does not depend on those choices.
- Automatic recognition of transformed melodies, reliable instrument separation and high-fidelity material rendering are research milestones with measured exit checks.

This plan follows the vault's documented-spec and complete-user-flow rules. It describes proposed work rather than shipped behaviour.
