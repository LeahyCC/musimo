# Visualizer discovery

8 September 2026. Recommendation, not an engine selection or implementation.

Start the one-song experiment with Butterchurn inside an independent browser package. Use MilkDrop3 as the visual standard. Prove control over musical development, shader detail and seeking before committing to a fork. Keep projectM as the alternative if native rendering or offline export becomes central.

Butterchurn already gives us convincing feedback and programmable materials. It does not give us a song's visual identity or memory. Those need a separate controller that understands the recording and directs a small, deliberately authored set of visual ideas. Random preset changes will not meet the brief.

## Choose these references first

- [MilkDrop3 double-preset recording](https://www.youtube.com/watch?v=6UXKyz4nOfI): interwoven fields, cellular structures and circular forms occupying one image. Borrow coexistence and transformation. The recording's rapid cuts are not the proposed pacing.
- [MilkDrop3 3.31 recording, around 0:40–0:50](https://www.youtube.com/watch?v=Ppq2NkId9_A&t=40s): atmospheric depth and luminous forms with room around them. This is an application recording, not evidence that its shaders can run in a browser. The visible scene's preset name and reuse rights remain unverified.
- **Flexi, martin + geiss - dedicated to the sherwin maxawow:** live Butterchurn inspection showed flowing, finely textured surfaces. Borrow the material detail; its dense neon palette should not govern every song. [Actual rendered frame](assets/visualizer-discovery/sherwin.png).
- **martin - witchcraft reloaded:** live Butterchurn inspection showed luminous strands, fine points and substantial dark space. Borrow the layered motion and small highlights, without making strands the engine's required form. [Actual rendered frame](assets/visualizer-discovery/witchcraft.png).

Also inspected `martin - castle in the air`. Its moving spatial field is useful technically, but the sampled output was too hazy to anchor the crispness target. The original [mock](assets/visualizer-reference.png) remains an artistic reference only. None of the new frames are generated illustrations.

## How the music becomes a journey

```text
Audio samples now ──────────────┐
                               v
Whole-song map ────────> Musical controller ────────> Renderer
                               ^                       |
Returning musical ideas ───────┘                  Pixel feedback
```

Immediate features drive small, fast changes: attacks, weight, brightness, roughness and stereo spread. Bands measure energy in a range; bass energy does not identify a kick, and treble energy does not identify a hi-hat. Add onset strength, spectral flux, flatness and harmonic/percussive estimates. Use separate attack and release smoothing and retain both absolute loudness and a slowly changing local reference, so a quiet passage can stay quiet.

Whole-song analysis supplies beat confidence, section boundaries, novelty and recurrence. Compare beat-synchronous harmony and timbre over time, then review the proposed structure by ear for the first song. A recurrence group can recall a form, palette or motion rule, with its next appearance changed by the intervening score. Tension is an interpretation of several cues, not an FFT output. The [librosa segmentation example](https://librosa.org/doc/main/auto_tutorials/03-advanced/plot_segmentation.html) demonstrates recurrence-based structure; it does not establish the right artistic mapping.

Use source separation only when an important musical distinction is obscured by the mix. [Demucs](https://github.com/facebookresearch/demucs) separates drums, bass, vocals and accompaniment, but it does not reliably turn every instrument or metal drum hit into a clean event. Its original repository is archived. Evaluate maintenance, model terms and processing cost before adopting a replacement. Stems should inform the visuals, not replace the audible recording.

A known recording can use future sections to prepare a transition. Live input can only respond to heard material and estimate what may come next. It must not present a prediction as known song structure. Genre labels are not controller inputs.

## Independent engine and playback

Use one self-contained `visualizer/` package with an exported engine, a development preview and its own build. The preview owns its test player. Musimo imports the package through a small adapter; rendering stays in the browser. No renderer network service is needed. Start whole-song analysis as a separate local command that writes a versioned data file; an optional backend job can be considered after the experiment.

The engine receives audio frames, playback time/state, a song score and dimensions. It owns visual state, preset resources and rendering. It never owns Musimo's audio element, queue, source URL, play/pause decisions or scrobbles. The adapter should sit alongside the existing `PlayerProvider`, rather than adding visualizer logic throughout the UI.

For the first library integration, use prepared PCM windows/features from the same recording and read the existing audio element's clock. This supplies an immediate response at the current song position without rerouting sound. Include recording identity, duration, sample rate, analysis version and timing offset in the data contract. Reject a score for a different recording or edit.

This boundary matters: Musimo currently shares one audio element between same-origin library streams and external Deezer/iTunes previews. A `MediaElementAudioSourceNode` changes that element's output path, and CORS-cross-origin media must produce silence through it. Attaching and then disconnecting a visualizer does not undo that association. A future live tap therefore needs a player-owned, persistent audio graph and a verified policy for every source. It is separate playback work, not an incidental adapter change. [Web Audio specification](https://www.w3.org/TR/webaudio/#MediaElementAudioSourceNode-security).

Entry reads the current time and prepares visuals while playback continues. Exit frees visual resources. Pause freezes the score and feedback steps. Seek cancels outdated preparation, moves the score to the player's new position and follows the replay policy below. Hidden tabs follow the same catch-up policy instead of integrating a huge elapsed interval. Preserve the late-queue-restoration guard. Prove entry, exit, repeat entry, pause/resume, seek, track change and library-to-preview switching with real audible media before integrating.

## Seeking and memory

Musical memory belongs in the score: motif identities, recurrence groups, event history and variation seeds. Pixel feedback is a different kind of memory. Loading a preset at 90 seconds cannot reproduce the pixels accumulated during the first 90 seconds.

Use a fixed simulation step, recorded audio inputs and instance-local randomness. Tie presentation to the media clock, not monitor refresh. Checkpoints must include feedback textures, blur/history buffers where needed, equation variables and memory arrays, random state, audio smoothing, clocks and both sides of an active transition. Two RGBA8 feedback textures alone cost about 15.8 MiB at 1080p per checkpoint; actual state can be larger. Changing resolution or GPU can also change the result.

The first experiment should reproduce the same journey from the start and restore the correct musical idea after a seek. For exact visual seeking, prove checkpoint restoration and bounded catch-up on one preset before promising it for the whole song. If that cost is unacceptable, explicitly choose a brief dissolve into a seeded reconstruction at the destination. That preserves musical identity but does not reproduce identical pixels. Neither examined engine exposes a complete, ready-made checkpoint API.

## First milestone and Ultra work

One real song, played from beginning to end in the independent preview, with a reviewed musical map and two or three related visual ideas. Returning material must visibly recall an earlier idea after a contrasting passage. Transitions should share motion, space or material and feel continuous. Do not build a broad preset catalogue first.

The milestone includes a recording of actual playback, live inspection, a repeat run, forward/backward seeks and measured transition cost on the target hardware. Initial targets: 1080p/60 on the chosen desktop, a usable lower-resolution fallback, and no interruption to sound. Laptop/mobile targets need their own measurements. Reference songs are still pending from Colin; the Webamp demo track was only an audition source.

Use Ultra for the visual controller and shader control surface, and for the state/checkpoint prototype. These are the hardest decisions: how forms transform while keeping identity, and how that identity survives missing rendering history. Package scaffolding, the preview shell and routine adapter wiring do not need that level of reasoning.

Open gates: Colin's songs and preferred references; enough artistic control without a large renderer fork; native MilkDrop3 shader reuse rights and compatibility; checkpoint cost; real-device browser performance; audible playback integration. See the [evidence record](visualizer-evidence.md) for versions, measurements and limits.
