/**
 * A debug overlay drawn on a 2D canvas above the scene: the band envelopes,
 * energy, the flux trace against its onset threshold with onset marks, the
 * tempo guess, the preset drawing, and frame timing. Toggled with H; it ships
 * in the build so a problem on someone else's machine can be read off a
 * screenshot.
 */
import { F } from '../audio/FeatureExtractor'

export type HudStats = {
  fps: number
  frameMs: number
  /** What the scene is doing, already summarised for the line. */
  scene: string
  adapter: string
  /** Which post stages are on, already summarised for the line. */
  post: string
  /** The preset drawing, by its name in the picker. */
  preset: string
}

const BARS = ['sub', 'bass', 'lowMid', 'highMid', 'treble', 'energy'] as const
const HISTORY = 240

export class Hud {
  private readonly context: CanvasRenderingContext2D | null
  private readonly flux = new Float32Array(HISTORY)
  private readonly threshold = new Float32Array(HISTORY)
  private readonly onsets = new Uint8Array(HISTORY)
  private at = 0
  private scale = 1
  visible = false

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.context = canvas.getContext('2d')
    canvas.hidden = true
  }

  setVisible(visible: boolean) {
    this.visible = visible
    this.canvas.hidden = !visible
  }

  resize(width: number, height: number, scale: number) {
    this.canvas.width = Math.max(1, Math.round(width * scale))
    this.canvas.height = Math.max(1, Math.round(height * scale))
    this.scale = scale
  }

  /** Record this frame's flux so the trace keeps history even while hidden. */
  record(packet: Float32Array) {
    this.flux[this.at] = packet[F.flux] ?? 0
    this.threshold[this.at] = packet[F.fluxThreshold] ?? 0
    this.onsets[this.at] = packet[F.onset] ? 1 : 0
    this.at = (this.at + 1) % HISTORY
  }

  draw(packet: Float32Array, stats: HudStats) {
    const ctx = this.context
    if (!this.visible || !ctx) return
    const { canvas, scale } = this
    ctx.setTransform(scale, 0, 0, scale, 0, 0)
    ctx.clearRect(0, 0, canvas.width / scale, canvas.height / scale)
    ctx.font = '11px ui-monospace, Menlo, monospace'
    ctx.textBaseline = 'middle'
    const x = 10
    const y = 10
    const width = 310
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)'
    // Tall enough for the four lines under the flux trace, the last of which
    // is the preset.
    ctx.fillRect(x, y, width, 240)

    BARS.forEach((name, index) => {
      const value = packet[index] ?? 0
      const row = y + 12 + index * 15
      ctx.fillStyle = '#cfd8d3'
      ctx.fillText(name, x + 8, row)
      ctx.fillStyle = 'rgba(255, 255, 255, 0.12)'
      ctx.fillRect(x + 68, row - 5, 200, 10)
      ctx.fillStyle = `hsl(${200 - index * 30} 80% 60%)`
      ctx.fillRect(x + 68, row - 5, 200 * value, 10)
      ctx.fillStyle = '#cfd8d3'
      ctx.fillText(value.toFixed(2), x + 274, row)
    })

    // Flux and its threshold share a scale so the crossing is visible.
    const top = y + 104
    const height = 56
    let max = 1
    for (let i = 0; i < HISTORY; i++) {
      max = Math.max(max, this.flux[i] ?? 0, this.threshold[i] ?? 0)
    }
    const step = (width - 16) / HISTORY
    ctx.fillStyle = 'rgba(255, 255, 255, 0.06)'
    ctx.fillRect(x + 8, top, width - 16, height)
    const trace = (values: Float32Array, colour: string) => {
      ctx.strokeStyle = colour
      ctx.lineWidth = 1
      ctx.beginPath()
      for (let i = 0; i < HISTORY; i++) {
        const value = values[(this.at + i) % HISTORY] ?? 0
        const px = x + 8 + i * step
        const py = top + height - (Math.min(value, max) / max) * height
        if (i === 0) ctx.moveTo(px, py)
        else ctx.lineTo(px, py)
      }
      ctx.stroke()
    }
    ctx.strokeStyle = 'rgba(255, 200, 80, 0.9)'
    for (let i = 0; i < HISTORY; i++) {
      if (!this.onsets[(this.at + i) % HISTORY]) continue
      const px = x + 8 + i * step
      ctx.beginPath()
      ctx.moveTo(px, top)
      ctx.lineTo(px, top + height)
      ctx.stroke()
    }
    trace(this.threshold, 'rgba(255, 120, 120, 0.9)')
    trace(this.flux, 'rgba(120, 220, 255, 0.95)')

    ctx.fillStyle = '#cfd8d3'
    const tempo = packet[F.tempo] ?? 0
    const beat = packet[F.beatPulse] ?? 0
    ctx.fillText(
      `flux ${(packet[F.flux] ?? 0).toFixed(2)}  thr ${(packet[F.fluxThreshold] ?? 0).toFixed(2)}  beat ${beat.toFixed(2)}  ${tempo ? `${Math.round(tempo)} bpm` : 'tempo ?'}`,
      x + 8,
      top + height + 12,
    )

    ctx.fillText(
      `${stats.fps.toFixed(0)} fps  ${stats.frameMs.toFixed(1)} ms  ${stats.scene}`,
      x + 8,
      top + height + 26,
    )
    ctx.fillText(stats.adapter.slice(0, 44), x + 8, top + height + 40)
    ctx.fillText(`post ${stats.post}`, x + 8, top + height + 54)
    ctx.fillText(`preset ${stats.preset}`, x + 8, top + height + 68)
  }
}
