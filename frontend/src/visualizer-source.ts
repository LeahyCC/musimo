import type { JourneyScore, Pcm } from '@musimo/visualizer'

export type VisualSource = {
  trackId: string
  pcm: Pcm
  score?: JourneyScore
  sha256?: string
}

const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, '0')).join('')

// The engine samples prepared PCM by media time, so the whole recording is
// decoded once at 44.1 kHz. This is a second download beside the audio
// element's own stream; the element itself is never rerouted. A prepared
// journey score is attached only when the recording's hash and duration match
// the analysis it came from.
export async function loadVisualSource(
  trackId: string,
  signal: AbortSignal,
): Promise<VisualSource> {
  const response = await fetch(`/api/player/stream/${encodeURIComponent(trackId)}`, { signal })
  if (!response.ok) throw new Error('This track could not be prepared for visuals.')
  const bytes = await response.arrayBuffer()
  signal.throwIfAborted()
  // Hashing needs a secure context. Without one the track still gets a generic study.
  const sha256 = globalThis.crypto?.subtle
    ? hex(await crypto.subtle.digest('SHA-256', bytes))
    : undefined
  const decoded = await new OfflineAudioContext(2, 1, 44100).decodeAudioData(bytes)
  signal.throwIfAborted()
  const pcm: Pcm = {
    sampleRate: decoded.sampleRate,
    left: decoded.getChannelData(0),
    right: decoded.getChannelData(Math.min(1, decoded.numberOfChannels - 1)),
  }
  let score: JourneyScore | undefined
  if (sha256) {
    const { journeyFor } = await import('@musimo/visualizer/songs')
    signal.throwIfAborted()
    const prepared = journeyFor(sha256)
    if (prepared && Math.abs(decoded.duration - prepared.recording.duration) <= 0.25)
      score = prepared
  }
  return { trackId, pcm, score, sha256 }
}
