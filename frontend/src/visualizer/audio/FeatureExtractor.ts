/**
 * Turns analyser frames into a small packet of musical features for the
 * visualizer. Pure TypeScript, no DOM: the input is the Float32Array that
 * `AnalyserNode.getFloatFrequencyData` fills (dB per bin, -Infinity for
 * silence) plus the seconds since the previous frame, and the output is a
 * fixed-layout Float32Array the renderer uploads as one uniform buffer.
 *
 * Packet layout. WGSL structs must match this exactly, so it is four vec4s:
 *
 *   index  name            range     meaning
 *   0      sub             0..1      20 to 60 Hz envelope, scaled by its recent peak
 *   1      bass            0..1      60 to 250 Hz
 *   2      lowMid          0..1      250 to 1000 Hz
 *   3      highMid         0..1      1000 to 4000 Hz
 *   4      treble          0..1      4000 to 16000 Hz
 *   5      energy          0..1      smoothed RMS across 20 Hz to 16 kHz, scaled by its recent peak
 *   6      flux            0..       spectral flux over its rolling mean; about 1 in a steady passage
 *   7      fluxThreshold   0..       the adaptive onset threshold in the same units as flux
 *   8      onset           0 | 1     1 on the frame an onset was detected
 *   9      onsetStrength   0..1      how the onset compares with the loudest recent one
 *   10     beatPulse       0..1      jumps to 1 on an onset, then decays
 *   11     tempo           bpm       0 until the flux autocorrelation settles on a period
 *   12     time            s         seconds of features so far
 *   13     dt              s         this frame's step
 *   14, 15 reserved        0
 *
 *   struct Features {
 *     bands: vec4<f32>,   // sub, bass, lowMid, highMid
 *     levels: vec4<f32>,  // treble, energy, flux, fluxThreshold
 *     beat: vec4<f32>,    // onset, onsetStrength, beatPulse, tempo
 *     clock: vec4<f32>,   // time, dt, 0, 0
 *   }
 */

export const PACKET_LENGTH = 16

export const F = {
  sub: 0,
  bass: 1,
  lowMid: 2,
  highMid: 3,
  treble: 4,
  energy: 5,
  flux: 6,
  fluxThreshold: 7,
  onset: 8,
  onsetStrength: 9,
  beatPulse: 10,
  tempo: 11,
  time: 12,
  dt: 13,
} as const

export type BandSpec = {
  name: string
  /** Hz, inclusive. */
  low: number
  /** Hz, exclusive. */
  high: number
  attackMs: number
  releaseMs: number
}

// Treble moves fastest, sub slowest: a hi-hat is over in milliseconds and a
// bass note should not flicker.
export const DEFAULT_BANDS: readonly BandSpec[] = [
  { name: 'sub', low: 20, high: 60, attackMs: 20, releaseMs: 250 },
  { name: 'bass', low: 60, high: 250, attackMs: 12, releaseMs: 180 },
  { name: 'lowMid', low: 250, high: 1000, attackMs: 10, releaseMs: 150 },
  { name: 'highMid', low: 1000, high: 4000, attackMs: 8, releaseMs: 120 },
  { name: 'treble', low: 4000, high: 16000, attackMs: 5, releaseMs: 90 },
]

export type FeatureOptions = {
  sampleRate: number
  /** Must equal the analyser's fftSize; the frame has fftSize / 2 bins. */
  fftSize: number
  bands?: readonly BandSpec[]
  /** Rolling window for the flux mean and deviation. */
  fluxWindowSeconds?: number
  /** k in mean + k * sigma. */
  fluxThresholdSigma?: number
  /** Two onsets closer than this are one. */
  onsetRefractoryMs?: number
  /** beatPulse falls to 1/e in this long. */
  beatDecaySeconds?: number
  /** Only used to size the rolling windows; the real step comes with each frame. */
  nominalFrameRate?: number
}

const clamp01 = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value)

/** -Infinity (a silent bin) becomes 0, 0 dB becomes 1. */
export const dbToLinear = (db: number) => (db === -Infinity ? 0 : 10 ** (db / 20))

/** The half-open bin range [start, end) covering low to high Hz. */
export function bandBins(low: number, high: number, fftSize: number, sampleRate: number) {
  const bins = fftSize / 2
  const start = Math.min(bins - 1, Math.max(0, Math.round((low * fftSize) / sampleRate)))
  const end = Math.min(bins, Math.max(start + 1, Math.round((high * fftSize) / sampleRate)))
  return [start, end] as const
}

/** One-pole envelope follower with separate attack and release times. */
export class Envelope {
  value = 0
  private readonly attack: number
  private readonly release: number

  constructor(attackMs: number, releaseMs: number) {
    this.attack = attackMs / 1000
    this.release = releaseMs / 1000
  }

  step(input: number, dt: number) {
    const tau = input > this.value ? this.attack : this.release
    const keep = tau <= 0 ? 0 : Math.exp(-dt / tau)
    this.value = input + (this.value - input) * keep
    return this.value
  }
}

/**
 * A level that follows its input upwards at once and lets go slowly, for
 * scaling a band by the loudest it has recently been. The floor keeps
 * near-silence from being scaled up into noise.
 */
class PeakHold {
  value = 0
  constructor(
    private readonly halfLifeSeconds: number,
    private readonly floor: number,
  ) {}

  step(input: number, dt: number) {
    this.value = Math.max(input, this.value * 0.5 ** (dt / this.halfLifeSeconds))
    return Math.max(this.value, this.floor)
  }
}

// Linear magnitude of roughly -60 dB. Below this a band reads as quiet rather
// than being stretched to fill 0..1.
const QUIET = 1e-3
const PEAK_HALF_LIFE = 2
const MIN_DT = 0.001
const MAX_DT = 0.1
const TEMPO_MIN_BPM = 60
const TEMPO_MAX_BPM = 200
const TEMPO_WINDOW_SECONDS = 8
const TEMPO_EVERY_SECONDS = 1

export class FeatureExtractor {
  readonly packet = new Float32Array(PACKET_LENGTH)
  readonly bands: readonly BandSpec[]
  private readonly bins: number
  private readonly ranges: (readonly [number, number])[]
  private readonly span: readonly [number, number]
  private readonly magnitudes: Float32Array
  private readonly previous: Float32Array
  private readonly envelopes: Envelope[]
  private readonly peaks: PeakHold[]
  private readonly energyEnvelope = new Envelope(15, 300)
  private readonly energyPeak = new PeakHold(PEAK_HALF_LIFE, QUIET)
  private readonly fluxWindow: Float32Array
  private fluxAt = 0
  private fluxCount = 0
  private fluxSum = 0
  private fluxSumSquares = 0
  private fluxPeak = 0
  private lastFlux = 0
  private readonly sigma: number
  private readonly refractory: number
  private readonly beatDecay: number
  private sinceOnset = Infinity
  private beat = 0
  private readonly tempoWindow: Float32Array
  private tempoAt = 0
  private tempoFilled = 0
  private sinceTempo = 0
  private tempo = 0
  private averageDt: number
  private time = 0
  private frames = 0

  constructor(options: FeatureOptions) {
    const rate = options.nominalFrameRate ?? 60
    this.bands = options.bands ?? DEFAULT_BANDS
    this.bins = options.fftSize / 2
    this.ranges = this.bands.map((band) =>
      bandBins(band.low, band.high, options.fftSize, options.sampleRate),
    )
    this.span = bandBins(20, 16000, options.fftSize, options.sampleRate)
    this.magnitudes = new Float32Array(this.bins)
    this.previous = new Float32Array(this.bins)
    this.envelopes = this.bands.map((band) => new Envelope(band.attackMs, band.releaseMs))
    this.peaks = this.bands.map(() => new PeakHold(PEAK_HALF_LIFE, QUIET))
    this.fluxWindow = new Float32Array(
      Math.max(8, Math.round((options.fluxWindowSeconds ?? 1.5) * rate)),
    )
    this.sigma = options.fluxThresholdSigma ?? 2.5
    this.refractory = (options.onsetRefractoryMs ?? 80) / 1000
    this.beatDecay = options.beatDecaySeconds ?? 0.18
    this.tempoWindow = new Float32Array(Math.round(TEMPO_WINDOW_SECONDS * rate))
    this.averageDt = 1 / rate
  }

  /**
   * Consume one analyser frame. `spectrum` holds fftSize / 2 dB values and is
   * not kept, so the caller may reuse or transfer it. Returns the packet,
   * which is this instance's own array and is overwritten by the next call.
   */
  update(spectrum: Float32Array, dtSeconds: number): Float32Array {
    const dt = Math.min(MAX_DT, Math.max(MIN_DT, dtSeconds))
    const { magnitudes, previous, packet } = this
    for (let bin = 0; bin < this.bins; bin++)
      magnitudes[bin] = dbToLinear(spectrum[bin] ?? -Infinity)

    for (let band = 0; band < this.bands.length; band++) {
      const [start, end] = this.ranges[band] ?? [0, 1]
      let sum = 0
      for (let bin = start; bin < end; bin++) sum += magnitudes[bin] ?? 0
      const level = sum / (end - start)
      const envelope = this.envelopes[band]?.step(level, dt) ?? 0
      const peak = this.peaks[band]?.step(level, dt) ?? QUIET
      packet[band] = clamp01(envelope / peak)
    }

    const [from, to] = this.span
    let squares = 0
    let flux = 0
    for (let bin = from; bin < to; bin++) {
      const magnitude = magnitudes[bin] ?? 0
      squares += magnitude * magnitude
      const rise = magnitude - (previous[bin] ?? 0)
      if (rise > 0) flux += rise
    }
    previous.set(magnitudes)
    const width = to - from
    const rms = Math.sqrt(squares / width)
    packet[F.energy] = clamp01(this.energyEnvelope.step(rms, dt) / this.energyPeak.step(rms, dt))
    // The first frame has nothing to differ from; its "flux" would be the
    // whole spectrum and read as a hit.
    flux = this.frames === 0 ? 0 : flux / width

    // The threshold is measured against the window before this frame joins
    // it, so a hit cannot raise the bar it has to clear.
    const count = this.fluxCount
    const mean = count ? this.fluxSum / count : 0
    const variance = count ? Math.max(0, this.fluxSumSquares / count - mean * mean) : 0
    const threshold = mean + this.sigma * Math.sqrt(variance)
    this.pushFlux(flux)
    this.fluxPeak = Math.max(flux, this.fluxPeak * 0.5 ** (dt / 2))
    this.sinceOnset += dt
    // Rising through the threshold is the onset. Waiting for the peak would
    // cost a frame; the refractory time stops a long swell from counting
    // twice.
    const onset =
      count >= 8 &&
      flux > threshold &&
      flux > QUIET * QUIET &&
      flux >= this.lastFlux &&
      this.sinceOnset >= this.refractory
    this.lastFlux = flux
    // A hit is graded against the loudest recent hit, never against the
    // baseline alone: the mean of flux over its own mean is 1 by construction,
    // which would hide every hit in sustained music.
    const range = Math.max(this.fluxPeak - mean, 2 * mean)
    const strength = range > 0 ? clamp01((flux - mean) / range) : 0
    if (onset) {
      this.sinceOnset = 0
      this.beat = 1
    } else this.beat *= Math.exp(-dt / this.beatDecay)
    const unit = mean > 0 ? 1 / mean : 0
    packet[F.flux] = flux * unit
    packet[F.fluxThreshold] = threshold * unit
    packet[F.onset] = onset ? 1 : 0
    packet[F.onsetStrength] = onset ? strength : 0
    packet[F.beatPulse] = this.beat

    this.averageDt += (dt - this.averageDt) * 0.05
    this.trackTempo(flux, dt)
    packet[F.tempo] = this.tempo

    this.time += dt
    this.frames++
    packet[F.time] = this.time
    packet[F.dt] = dt
    return packet
  }

  private pushFlux(flux: number) {
    const window = this.fluxWindow
    if (this.fluxCount === window.length) {
      const old = window[this.fluxAt] ?? 0
      this.fluxSum -= old
      this.fluxSumSquares -= old * old
    } else this.fluxCount++
    window[this.fluxAt] = flux
    this.fluxSum += flux
    this.fluxSumSquares += flux * flux
    this.fluxAt = (this.fluxAt + 1) % window.length
  }

  // Autocorrelation of the last few seconds of flux, once a second, over the
  // lags that mean 60 to 200 beats per minute. The strongest lag wins if it
  // clearly beats the average correlation; otherwise the tempo stays unknown.
  private trackTempo(flux: number, dt: number) {
    const window = this.tempoWindow
    window[this.tempoAt] = flux
    this.tempoAt = (this.tempoAt + 1) % window.length
    this.tempoFilled = Math.min(window.length, this.tempoFilled + 1)
    this.sinceTempo += dt
    if (this.sinceTempo < TEMPO_EVERY_SECONDS || this.tempoFilled < window.length) return
    this.sinceTempo = 0
    const length = window.length
    let mean = 0
    for (let i = 0; i < length; i++) mean += window[i] ?? 0
    mean /= length
    const minLag = Math.max(1, Math.floor(60 / (TEMPO_MAX_BPM * this.averageDt)))
    const maxLag = Math.min(length >> 1, Math.ceil(60 / (TEMPO_MIN_BPM * this.averageDt)))
    let bestLag = 0
    let best = 0
    let total = 0
    let lags = 0
    for (let lag = minLag; lag <= maxLag; lag++) {
      let sum = 0
      for (let i = lag; i < length; i++) {
        const a = (window[(this.tempoAt + i) % length] ?? 0) - mean
        const b = (window[(this.tempoAt + i - lag) % length] ?? 0) - mean
        sum += a * b
      }
      total += sum
      lags++
      if (sum > best) {
        best = sum
        bestLag = lag
      }
    }
    const average = lags ? total / lags : 0
    this.tempo =
      bestLag && best > 0 && best > 3 * Math.max(average, 0) ? 60 / (bestLag * this.averageDt) : 0
  }
}
