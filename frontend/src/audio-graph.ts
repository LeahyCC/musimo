// The one audio graph for library playback. Each library element's source goes through a gain
// stage of its own into `bus`, and `bus` goes to the speakers. The visualizer listens on `bus`, so
// it hears whichever element is playing, boosted as it is heard.
//
//   each library element:  source -> GainNode -> bus -> speakers
//                                                  \-> visualizer
//                                                  \-> analyser (the bass level, for preset changes)
type AudioGraph = { context: AudioContext; bus: GainNode; analyser: AnalyserNode }

let graph: AudioGraph | undefined

/** The graph, built the first time anything asks for it. */
export function audioGraph(): AudioGraph {
  if (graph) return graph
  const context = new AudioContext()
  const bus = context.createGain()
  bus.connect(context.destination)
  const analyser = context.createAnalyser()
  analyser.fftSize = 1024
  analyser.smoothingTimeConstant = 0
  bus.connect(analyser)
  graph = { context, bus, analyser }
  return graph
}

/**
 * Wakes a suspended context and says whether it is running. Does not build a graph. There is no
 * time limit: Firefox takes about a second to start, and giving up sooner left the first track of
 * a session unwired. A context that waits for a click just waits, while the element plays on
 * without the graph until it is running.
 */
export async function resumeAudio(): Promise<boolean> {
  if (!graph) return false
  const { context } = graph
  if (context.state !== 'running') await context.resume().catch(() => undefined)
  return context.state === 'running'
}

// The low end, about 40 to 190 Hz at 48 kHz, where a drop lands.
const BASS_BINS = [1, 5] as const

/** How loud the bass is right now, 0 to 1. `scratch` is reused between calls. */
export function bassLevel(analyser: AnalyserNode, scratch: Uint8Array<ArrayBuffer>) {
  analyser.getByteFrequencyData(scratch)
  let sum = 0
  for (let bin = BASS_BINS[0]; bin < BASS_BINS[1]; bin++) sum += scratch[bin] ?? 0
  return sum / ((BASS_BINS[1] - BASS_BINS[0]) * 255)
}
