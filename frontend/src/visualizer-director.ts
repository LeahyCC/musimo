import { z } from 'zod'

import type { AudioFeatures } from './visualizer-audio'

const sectionSchema = z.object({
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  identity: z.number().int().nonnegative(),
  energy: z.number().min(0).max(1),
})
export const songMapSchema = z.object({
  version: z.literal(1),
  duration: z.number().positive(),
  hop: z.number().positive(),
  energy: z.array(z.number().min(0).max(1)).max(40000),
  bass: z.array(z.number().min(0).max(1)).max(40000),
  body: z.array(z.number().min(0).max(1)).max(40000),
  air: z.array(z.number().min(0).max(1)).max(40000),
  beats: z.array(z.number().nonnegative()).max(40000),
  confidence: z.number().min(0).max(1),
  sections: z.array(sectionSchema).max(500),
})
export type SongMap = z.infer<typeof songMapSchema>
export type WorldState = {
  time: number
  energy: number
  bass: number
  body: number
  air: number
  pulse: number
  opening: number
  tension: number
  memory: number
  identity: number
  width: number
  phase: 'Emerge' | 'Build' | 'Release' | 'Return'
}

export function seedFor(value: string): number {
  let hash = 2166136261
  for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619)
  return (hash >>> 0) / 4294967296
}

/** Musical decisions live here, separately from the renderer's geometry and materials. */
export class VisualizerDirector {
  private lastTime = -1
  private slowEnergy = 0
  private fastEnergy = 0
  private opening = 0.2
  private tension = 0
  private memory = 0
  private identity = 0
  private lastSection = -1
  private lastBeat = 0
  private visits = new Set<number>()
  private phase: WorldState['phase'] = 'Emerge'
  private activeMap: SongMap | null = null
  private mapWeight = 0

  reset() {
    this.lastTime = -1
    this.slowEnergy = this.fastEnergy = 0
    this.opening = 0.2
    this.tension = this.memory = this.identity = 0
    this.lastSection = -1
    this.visits.clear()
  }

  update(features: AudioFeatures, map: SongMap | null, hold: boolean): WorldState {
    const time = features.time
    const jump = this.lastTime >= 0 && (time < this.lastTime - 0.1 || time - this.lastTime > 0.5)
    if (jump) {
      const held = [this.opening, this.tension, this.identity] as const
      this.reset()
      if (hold) [this.opening, this.tension, this.identity] = held
    }
    const dt = this.lastTime < 0 ? 1 / 60 : Math.min(0.1, Math.max(0, time - this.lastTime))
    this.lastTime = time
    const interpolate = (values: number[], at: number) => {
      const index = Math.max(0, Math.min(values.length - 1, at / (map?.hop ?? 1)))
      const whole = Math.floor(index),
        weight = index - whole
      return (
        (values[whole] ?? 0) * (1 - weight) + (values[whole + 1] ?? values[whole] ?? 0) * weight
      )
    }

    if (map !== this.activeMap) {
      this.activeMap = map
      this.mapWeight = 0
    }
    this.mapWeight = Math.min(1, this.mapWeight + dt * 0.8)
    const mapped = (values: number[] | undefined, live: number) =>
      values ? live + (interpolate(values, time) - live) * this.mapWeight : live
    const energy = mapped(map?.energy, features.energy)
    this.fastEnergy += (energy - this.fastEnergy) * (1 - Math.exp(-dt * 1.8))
    this.slowEnergy += (energy - this.slowEnergy) * (1 - Math.exp(-dt * 0.14))
    let targetOpening = 0.16 + energy * 0.72
    let targetTension = Math.max(0, this.fastEnergy - this.slowEnergy) * 1.8
    let pulse = features.onset
    if (map) {
      const index = map.sections.findIndex((section) => section.start <= time && time < section.end)
      const section = map.sections[index]
      const next = map.sections[index + 1]
      if (section) {
        if (index !== this.lastSection) {
          // Rebuild repeat history on seeks so a jump cannot invent a first-time section.
          this.visits = new Set(map.sections.slice(0, index).map((item) => item.identity))
          this.phase = this.visits.has(section.identity)
            ? 'Return'
            : section.energy > 0.65
              ? 'Release'
              : 'Emerge'
          this.memory = this.visits.has(section.identity) ? 1 : 0.2
          this.lastSection = index
        }
        if (!hold) this.identity += (section.identity - this.identity) * (1 - Math.exp(-dt * 0.9))
        const until = section.end - time
        if (next && next.energy > section.energy + 0.12 && until < 5) {
          targetTension = (1 - until / 5) * 0.95
          targetOpening *= 1 - targetTension * 0.55
          this.phase = 'Build'
        }
      }

      if (map.confidence > 0.45) {
        if (jump || (map.beats[this.lastBeat] ?? 0) > time) this.lastBeat = 0
        while (
          this.lastBeat + 1 < map.beats.length &&
          (map.beats[this.lastBeat + 1] ?? Infinity) <= time
        )
          this.lastBeat++
        const age = time - (map.beats[this.lastBeat] ?? -100)
        if (age >= 0 && age < 0.4) pulse = Math.max(pulse, Math.exp(-age * 12) * energy)
      }
    } else {
      // A live spectrum supports energy movement, not claims about choruses or unheard drops.
      this.phase = targetTension > 0.32 ? 'Build' : energy > 0.62 ? 'Release' : 'Emerge'
      this.memory += ((time > 20 ? 0.35 : 0) - this.memory) * dt * 0.2
    }

    if (!hold) {
      this.opening += (targetOpening - this.opening) * (1 - Math.exp(-dt * 0.85))
      this.tension += (targetTension - this.tension) * (1 - Math.exp(-dt * 1.2))
    }
    return {
      time,
      energy,
      bass: mapped(map?.bass, features.bass),
      body: mapped(map?.body, features.body),
      air: mapped(map?.air, features.air),
      pulse,
      opening: this.opening,
      tension: this.tension,
      memory: this.memory,
      identity: this.identity,
      width: features.width,
      phase: this.phase,
    }
  }
}
