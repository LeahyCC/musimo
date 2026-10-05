// The one audio graph for library playback. Each library element's source goes through a gain
// stage of its own into `bus`, and `bus` goes to the speakers. The visualizer listens on `bus`, so
// it hears whichever element is playing, boosted as it is heard.
//
//   each library element:  source -> GainNode -> bus -> speakers
//                                                  \-> visualizer
//                                                  \-> analyser (the bass, for preset changes)
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

// The low end, about 40 to 190 Hz at 48 kHz, where a kick and a drop land.
const BASS_BINS = [1, 5] as const

/**
 * How loud the bass is, and how hard it just rose, both 0 to 1. `scratch` and `previous` are
 * reused between calls. The rise is what a kick looks like when the bass bed stays loud.
 */
export function bassReading(
  analyser: AnalyserNode,
  scratch: Uint8Array<ArrayBuffer>,
  previous: Float64Array,
) {
  analyser.getByteFrequencyData(scratch)
  return bassBands(scratch, previous, BASS_BINS[0], BASS_BINS[1])
}

/** Level and the upward jump across bins `start`..`end`. `previous` keeps the last frame. */
export function bassBands(
  bins: ArrayLike<number>,
  previous: Float64Array,
  start: number,
  end: number,
) {
  let sum = 0
  let flux = 0
  const count = end - start
  for (let bin = start; bin < end; bin++) {
    const value = (bins[bin] ?? 0) / 255
    sum += value
    const delta = value - (previous[bin] ?? 0)
    if (delta > 0) flux += delta
    previous[bin] = value
  }
  return { level: sum / count, flux: flux / count }
}
