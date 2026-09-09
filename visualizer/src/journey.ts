export type Motif = 'orbit' | 'current' | 'bloom'
export type JourneyCue = {
  time: number
  label: string
  motif: Motif
  transition: number
  intensity: number
  variation: number
}
export type JourneyScore = {
  schemaVersion: 1
  recording: {
    id: string
    sha256: string
    duration: number
    sourceSampleRate: number
    analysisSampleRate: number
    timingOffsetSeconds: number
  }
  seed: number
  reviewed: boolean
  cues: JourneyCue[]
  analysis?: { hopSeconds: number; columns: string[]; frames: number[][] }
}
export type JourneyState = {
  label: string
  motif: Motif
  orbit: number
  current: number
  bloom: number
  intensity: number
  variation: number
  energy: number
  onset: number
  texture: number
  progress: number
  transitionActivity: number
}

const motifs = ['orbit', 'current', 'bloom'] as const
const clamp = (value: number) => Math.max(0, Math.min(1, value))
const mix = (from: number, to: number, amount: number) => from + (to - from) * amount
const smooth = (value: number) => value * value * (3 - 2 * value)

// Own the musical interpretation here. Sampling has no playback history, so seeks and
// different display refresh rates always produce the same score and feature values.
export class JourneyController {
  readonly score: Readonly<JourneyScore>
  private features: [number, number, number][] = []

  constructor(score: JourneyScore) {
    if (score.schemaVersion !== 1 || !Number.isInteger(score.seed)) {
      throw new Error('Unsupported journey score or seed.')
    }
    if (
      !Number.isFinite(score.recording.duration) ||
      score.recording.duration <= 0 ||
      !Number.isFinite(score.recording.timingOffsetSeconds) ||
      score.recording.analysisSampleRate !== 44100 ||
      !/^[a-f0-9]{64}$/.test(score.recording.sha256)
    ) {
      throw new Error('The journey needs a matching recording and 44.1 kHz analysis.')
    }
    if (!score.cues.length || score.cues[0].time !== 0) {
      throw new Error('The first journey cue must begin at zero.')
    }
    for (const [index, cue] of score.cues.entries()) {
      const previous = score.cues[index - 1]
      if (
        !motifs.includes(cue.motif) ||
        !cue.label ||
        ![cue.time, cue.transition, cue.intensity, cue.variation].every(Number.isFinite) ||
        cue.time < 0 ||
        cue.time >= score.recording.duration ||
        cue.transition < 0 ||
        cue.intensity < 0 ||
        cue.intensity > 1 ||
        cue.variation < 0 ||
        cue.variation > 1 ||
        (index === 0 && cue.transition !== 0) ||
        (previous && (cue.time <= previous.time || cue.time < previous.time + previous.transition))
      ) {
        throw new Error('Journey cues must be ordered, finite and have no overlapping transitions.')
      }
    }
    const copy = structuredClone(score)
    copy.cues.forEach(Object.freeze)
    Object.freeze(copy.cues)
    Object.freeze(copy.recording)
    if (copy.analysis) {
      const { frames, columns, hopSeconds } = copy.analysis
      if (
        !(hopSeconds > 0) ||
        !Number.isFinite(hopSeconds) ||
        columns.join(',') !== 'timeSeconds,rmsDb,centroidHz,flatness,flux' ||
        !frames.length ||
        frames.some(
          (row, index) =>
            row.length !== 5 ||
            !row.every(Number.isFinite) ||
            Math.abs(row[0] - index * hopSeconds) > 0.001,
        )
      ) {
        throw new Error('The journey feature grid does not match its declared analysis.')
      }
      const flux = frames.map((row) => row[4]).sort((a, b) => a - b)
      const reference = Math.max(1e-9, flux[Math.floor((flux.length - 1) * 0.95)])
      let energy = 0
      let onset = 0
      let texture = 0
      this.features = frames.map((row) => {
        // Preserve absolute loudness. A locally quiet section stays visually quiet.
        const nextEnergy = clamp((row[1] + 48) / 40)
        const nextOnset = clamp(row[4] / reference)
        const nextTexture = clamp((row[2] / 6500) * 0.65 + row[3] * 2)
        energy = mix(nextEnergy, energy, Math.exp(-hopSeconds / (nextEnergy > energy ? 0.5 : 1.4)))
        onset = mix(nextOnset, onset, Math.exp(-hopSeconds / (nextOnset > onset ? 0.16 : 0.65)))
        texture = mix(nextTexture, texture, Math.exp(-hopSeconds / 0.55))
        Object.freeze(row)
        return [energy, onset, texture]
      })
      Object.freeze(frames)
      Object.freeze(columns)
      Object.freeze(copy.analysis)
    }
    this.score = Object.freeze(copy)
  }

  sample(seconds: number): JourneyState {
    const time = Math.max(0, Math.min(this.score.recording.duration, seconds))
    const cues = this.score.cues
    let index = 0
    while (index + 1 < cues.length && cues[index + 1].time <= time) index++
    const cue = cues[index]
    const previous = cues[Math.max(0, index - 1)]
    const amount = cue.transition > 0 ? smooth(clamp((time - cue.time) / cue.transition)) : 1
    // 0 outside transition windows, peaking at 1 mid-transition: cue changes can
    // drive visible events. Pure in media time, so a seek landing mid-transition
    // samples the same activity as continuous playback.
    const transitionActivity = amount * (1 - amount) * 4
    const weights = Object.fromEntries(
      motifs.map((motif) => [
        motif,
        mix(Number(previous.motif === motif), Number(cue.motif === motif), amount),
      ]),
    ) as Record<Motif, number>
    let energy = 0.6
    let onset = 0
    let texture = 0.3
    if (this.score.analysis) {
      const cursor =
        clamp(
          (time + this.score.recording.timingOffsetSeconds) /
            this.score.analysis.hopSeconds /
            Math.max(1, this.features.length - 1),
        ) *
        (this.features.length - 1)
      const left = this.features[Math.floor(cursor)]
      const right = this.features[Math.min(this.features.length - 1, Math.floor(cursor) + 1)]
      ;[energy, onset, texture] = left.map((value, column) => mix(value, right[column], cursor % 1))
    }
    return {
      label: cue.label,
      motif: cue.motif,
      ...weights,
      intensity: mix(previous.intensity, cue.intensity, amount),
      variation: mix(previous.variation, cue.variation, amount),
      energy,
      onset,
      texture,
      progress: time / this.score.recording.duration,
      transitionActivity,
    }
  }
}
