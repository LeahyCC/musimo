// Band levels for the native study renderer. This is a port of Butterchurn's
// FFT, AudioProcessor.processAudio and AudioLevels so the native path feels the
// same as the presets do. It stays pure and DOM-free: input is the AudioFrame
// samplePcm already fills, output is a plain record of numbers.
//
// Only the mono path is ported. Butterchurn also runs the left and right
// channels through the FFT for waveform drawing; the level bands read the mono
// spectrum alone, so the two extra transforms would be wasted work here.
import type { AudioFrame } from './pcm.ts'

export type BandLevels = {
  bass: number
  mid: number
  treb: number
  vol: number
  bassAtt: number
  midAtt: number
  trebAtt: number
  volAtt: number
}

const SAMPLES_IN = 1024
const SAMPLES_OUT = 512
const NFREQ = SAMPLES_OUT * 2
const SAMPLE_RATE = 44100
// The renderer advances at a fixed 60 media steps per second, so the rate
// adjustment Butterchurn applies for a variable display refresh is constant.
const SIMULATION_FPS = 60
const BASE_FPS = 30
const FAST_AVERAGE_FRAMES = 50
const FRAME_SECONDS = 1 / SIMULATION_FPS
// Already quoted at 60 fps, unlike the band rates above, so it is used as-is.
const ONSET_LONG_RATE = 0.992
// Matches JourneyController's onset feature smoothing, so the native path's
// onset rises and falls on the same timescale as the score's.
const ONSET_ATTACK_SECONDS = 0.16
const ONSET_RELEASE_SECONDS = 0.65

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

const bucketHz = SAMPLE_RATE / NFREQ
const bandEdge = (hz: number) => clamp(Math.round(hz / bucketHz) - 1, 0, SAMPLES_OUT - 1)
const starts = [bandEdge(20), bandEdge(320), bandEdge(2800)]
const stops = [bandEdge(320), bandEdge(2800), bandEdge(11025)]

// Radix-2 decimation-in-time FFT with the bit-reversal, twiddle and equalize
// tables Butterchurn builds once per instance. The equalize curve lifts the
// upper bins so a band sum is not dominated by low frequencies.
class Fft {
  private readonly bitrev = new Uint16Array(NFREQ)
  private readonly cos: Float32Array
  private readonly sin: Float32Array
  private readonly equalize = new Float32Array(SAMPLES_OUT)
  private readonly real = new Float32Array(NFREQ)
  private readonly imag = new Float32Array(NFREQ)
  private readonly out = new Float32Array(SAMPLES_OUT)

  constructor() {
    for (let i = 0; i < SAMPLES_OUT; i++) {
      this.equalize[i] = -0.02 * Math.log((SAMPLES_OUT - i) / SAMPLES_OUT)
    }
    for (let i = 0; i < NFREQ; i++) this.bitrev[i] = i
    let j = 0
    for (let i = 0; i < NFREQ; i++) {
      if (j > i) {
        const swap = this.bitrev[i]
        this.bitrev[i] = this.bitrev[j]
        this.bitrev[j] = swap
      }
      let m = NFREQ >> 1
      while (m >= 1 && j >= m) {
        j -= m
        m >>= 1
      }
      j += m
    }
    let stages = 0
    for (let size = 2; size <= NFREQ; size <<= 1) stages++
    this.cos = new Float32Array(stages)
    this.sin = new Float32Array(stages)
    let index = 0
    for (let size = 2; size <= NFREQ; size <<= 1) {
      const theta = (-2 * Math.PI) / size
      this.cos[index] = Math.cos(theta)
      this.sin[index] = Math.sin(theta)
      index++
    }
  }

  // Returns an instance-owned array; read it before the next call.
  transform(samples: Int8Array): Float32Array {
    const { real, imag } = this
    for (let i = 0; i < NFREQ; i++) {
      const source = this.bitrev[i]
      real[i] = source < SAMPLES_IN ? samples[source] : 0
      imag[i] = 0
    }
    let stage = 0
    for (let size = 2; size <= NFREQ; size <<= 1) {
      const stepReal = this.cos[stage]
      const stepImag = this.sin[stage]
      let twiddleReal = 1
      let twiddleImag = 0
      const half = size >> 1
      for (let m = 0; m < half; m++) {
        for (let i = m; i < NFREQ; i += size) {
          const j = i + half
          const productReal = twiddleReal * real[j] - twiddleImag * imag[j]
          const productImag = twiddleReal * imag[j] + twiddleImag * real[j]
          real[j] = real[i] - productReal
          imag[j] = imag[i] - productImag
          real[i] += productReal
          imag[i] += productImag
        }
        const previous = twiddleReal
        twiddleReal = previous * stepReal - twiddleImag * stepImag
        twiddleImag = twiddleImag * stepReal + previous * stepImag
      }
      stage++
    }
    for (let i = 0; i < SAMPLES_OUT; i++) {
      this.out[i] = this.equalize[i] * Math.sqrt(real[i] * real[i] + imag[i] * imag[i])
    }
    return this.out
  }
}

// Butterchurn's rates are quoted per 30 frames per second.
const adjustRate = (rate: number) => rate ** (BASE_FPS / SIMULATION_FPS)

export class AudioLevelAnalyser {
  private readonly fft = new Fft()
  private readonly samples = new Int8Array(NFREQ)
  private readonly imm = new Float32Array(3)
  private readonly avg = new Float32Array(3)
  private readonly longAvg = new Float32Array(3)
  private readonly val = new Float32Array(3)
  private readonly att = new Float32Array(3)
  private readonly prevSpectrum = new Float32Array(SAMPLES_OUT)
  private fluxAvg = 1
  private onsetValue = 0
  private frames = 0

  constructor() {
    this.reset()
  }

  // The counter is the analyser's own, not the media frame. A seek builds a new
  // analyser, and the fast first-50-frame average is what lets that rebuild
  // converge inside the engine's 120-frame reconstruction budget.
  reset() {
    this.frames = 0
    this.imm.fill(0)
    this.avg.fill(1)
    this.longAvg.fill(1)
    this.val.fill(1)
    this.att.fill(1)
    this.prevSpectrum.fill(0)
    this.fluxAvg = 1
    this.onsetValue = 0
  }

  // Smoothed 0..1 spectral-flux onset for the frame most recently passed to
  // update(). The engine multiplies this by sensitivity before it becomes a
  // uniform; this module has no opinion on studio options.
  get onset(): number {
    return this.onsetValue
  }

  update(input: AudioFrame): BandLevels {
    for (let i = 0; i < NFREQ; i++) this.samples[i] = input.timeByteArray[i] - 128
    const spectrum = this.fft.transform(this.samples)
    this.updateOnset(spectrum)
    // Accumulate into the Float32Array rather than a float64 local: Butterchurn
    // rounds to single precision on every addition, and matching that keeps the
    // two implementations bit-for-bit identical.
    this.imm.fill(0)
    for (let band = 0; band < 3; band++) {
      for (let bin = starts[band]; bin < stops[band]; bin++) this.imm[band] += spectrum[bin]
    }
    for (let band = 0; band < 3; band++) {
      const immediate = this.imm[band]
      const shortRate = adjustRate(immediate > this.avg[band] ? 0.2 : 0.5)
      this.avg[band] = this.avg[band] * shortRate + immediate * (1 - shortRate)
      const longRate = adjustRate(this.frames < FAST_AVERAGE_FRAMES ? 0.9 : 0.992)
      this.longAvg[band] = this.longAvg[band] * longRate + immediate * (1 - longRate)
      if (this.longAvg[band] < 0.001) {
        this.val[band] = 1
        this.att[band] = 1
      } else {
        this.val[band] = immediate / this.longAvg[band]
        this.att[band] = this.avg[band] / this.longAvg[band]
      }
    }
    this.frames++
    return {
      bass: this.val[0],
      mid: this.val[1],
      treb: this.val[2],
      vol: (this.val[0] + this.val[1] + this.val[2]) / 3,
      bassAtt: this.att[0],
      midAtt: this.att[1],
      trebAtt: this.att[2],
      volAtt: (this.att[0] + this.att[1] + this.att[2]) / 3,
    }
  }

  // Half-wave-rectified spectral flux, normalised by its own slow average so a
  // click reads the same whether the mix around it is quiet or loud, then
  // clamped and run through an attack/release smoother.
  private updateOnset(spectrum: Float32Array) {
    let flux = 0
    for (let bin = 0; bin < SAMPLES_OUT; bin++) {
      const delta = spectrum[bin] - this.prevSpectrum[bin]
      if (delta > 0) flux += delta
      this.prevSpectrum[bin] = spectrum[bin]
    }
    this.fluxAvg = this.fluxAvg * ONSET_LONG_RATE + flux * (1 - ONSET_LONG_RATE)
    const ratio = this.fluxAvg < 1e-6 ? 0 : clamp(flux / this.fluxAvg, 0, 1)
    const tau = ratio > this.onsetValue ? ONSET_ATTACK_SECONDS : ONSET_RELEASE_SECONDS
    const kept = Math.exp(-FRAME_SECONDS / tau)
    this.onsetValue = ratio * (1 - kept) + this.onsetValue * kept
  }
}
