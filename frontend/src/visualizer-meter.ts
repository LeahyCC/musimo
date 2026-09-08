declare const currentTime: number
declare const sampleRate: number
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort
  abstract process(inputs: Float32Array[][]): boolean
}
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void

/** A small clocked meter; FFT work stays in the browser's native AnalyserNode. */
class MusicMeter extends AudioWorkletProcessor {
  private sum = 0
  private peak = 0
  private difference = 0
  private stereo = 0
  private count = 0
  private packet = new Float64Array(4)

  process(inputs: Float32Array[][]) {
    const channels = inputs[0]
    const left = channels?.[0]
    if (!left) return true
    const right = channels?.[1] ?? left
    for (let i = 0; i < left.length; i++) {
      const l = left[i] ?? 0,
        r = right[i] ?? l
      const mixed = (l + r) * 0.5
      this.sum += mixed * mixed
      this.peak = Math.max(this.peak, Math.abs(mixed))
      this.difference += (l - r) ** 2
      this.stereo += l * l + r * r
    }
    this.count += left.length
    if (this.count >= 1024) {
      this.packet[0] = currentTime + left.length / sampleRate
      this.packet[1] = Math.sqrt(this.sum / this.count)
      this.packet[2] = this.peak
      this.packet[3] = Math.min(1, Math.sqrt(this.difference / Math.max(this.stereo, 1e-8)))
      this.port.postMessage(this.packet)
      this.sum = this.peak = this.difference = this.stereo = this.count = 0
    }
    return true
  }
}

registerProcessor('musimo-music-meter', MusicMeter)
export {}
