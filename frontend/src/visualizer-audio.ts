import meterUrl from './visualizer-meter.ts?worker&url'

export type AudioFeatures = {
  time: number
  bass: number
  body: number
  air: number
  energy: number
  onset: number
  width: number
}

export const silentFeatures = (): AudioFeatures => ({
  time: 0,
  bass: 0,
  body: 0,
  air: 0,
  energy: 0,
  onset: 0,
  width: 0,
})

/** The graph belongs to the player. Closing a visual must never disconnect the speakers. */
export class VisualizerAudio {
  context: AudioContext | null = null
  private source: MediaElementAudioSourceNode | null = null
  private analyser: AnalyserNode | null = null
  private gain: GainNode | null = null
  private waveform = new Float32Array(2048)
  private spectrum = new Float32Array(1024)
  private previous = new Float32Array(1024)
  private left: AnalyserNode | null = null
  private right: AnalyserNode | null = null
  private leftWave = new Float32Array(256)
  private rightWave = new Float32Array(256)
  private fluxAverage = 0.002
  private pulse = 0
  private previousTime = -1
  private lastFrame = 0
  private value = silentFeatures()
  private meterTime = -1
  private meterRms = 0
  private meterWidth = 0
  private meter: AudioWorkletNode | null = null

  async connect(element: HTMLAudioElement) {
    if (!this.context) {
      this.context = new AudioContext()
      this.source = this.context.createMediaElementSource(element)
      this.analyser = this.context.createAnalyser()
      this.analyser.fftSize = 2048
      this.analyser.smoothingTimeConstant = 0.5
      this.gain = this.context.createGain()
      this.gain.gain.value = element.muted ? 0 : element.volume
      element.volume = 1
      element.muted = false
      this.source.connect(this.gain)
      this.gain.connect(this.context.destination)
      this.source.connect(this.analyser)
      const splitter = this.context.createChannelSplitter(2)
      this.left = this.context.createAnalyser()
      this.right = this.context.createAnalyser()
      this.left.fftSize = this.right.fftSize = 256
      this.source.connect(splitter)
      splitter.connect(this.left, 0)
      splitter.connect(this.right, 1)
      // Older/insecure browsers retain the native analyser path if worklets are unavailable.
      if (this.context.audioWorklet) void this.installMeter().catch(() => undefined)
    }
    await this.context.resume()
  }

  private async installMeter() {
    const context = this.context
    if (!context || !this.source) return
    await context.audioWorklet.addModule(meterUrl)
    this.meter = new AudioWorkletNode(context, 'musimo-music-meter')
    this.meter.port.onmessage = (event: MessageEvent<unknown>) => {
      const data = event.data
      if (!(data instanceof Float64Array) || data.length !== 4) return
      this.meterTime = data[0] ?? -1
      this.meterRms = data[1] ?? 0
      this.meterWidth = data[3] ?? 0
    }
    this.source.connect(this.meter)
    // The meter's output is silence. Connecting it keeps processing alive on all engines.
    this.meter.connect(context.destination)
  }

  resume() {
    return this.context?.resume()
  }

  setVolume(element: HTMLAudioElement, volume: number, muted: boolean) {
    if (this.context && this.gain) {
      this.gain.gain.setTargetAtTime(muted ? 0 : volume, this.context.currentTime, 0.015)
      element.volume = 1
      element.muted = false
    } else {
      element.volume = volume
      element.muted = muted
    }
  }

  reset() {
    this.previous.fill(0)
    this.value = silentFeatures()
    this.fluxAverage = 0.002
    this.pulse = 0
    this.previousTime = -1
  }

  sample(element: HTMLAudioElement, offsetMs = 0): AudioFeatures {
    const context = this.context
    if (!context || !this.analyser) return { ...silentFeatures(), time: element.currentTime }
    const now = performance.now()
    const dt = Math.min(0.1, Math.max(0, (now - this.lastFrame) / 1000))
    this.lastFrame = now
    const jumped = Math.abs(element.currentTime - this.previousTime) > 0.5
    if (element.paused && !jumped) return this.value
    if (jumped) this.reset()
    this.previousTime = element.currentTime
    // Timestamp estimates are device-dependent; a user offset also covers display/Bluetooth delay.
    const stamp = context.getOutputTimestamp?.()
    const latency =
      stamp &&
      typeof stamp.contextTime === 'number' &&
      stamp.contextTime > 0 &&
      typeof stamp.performanceTime === 'number'
        ? Math.max(
            0,
            context.currentTime - stamp.contextTime - (now - stamp.performanceTime) / 1000,
          )
        : context.outputLatency || context.baseLatency || 0
    this.value.time = Math.max(0, element.currentTime - latency + offsetMs / 1000)
    if (element.paused || element.readyState < 3) return this.value
    this.analyser.getFloatFrequencyData(this.spectrum)
    this.analyser.getFloatTimeDomainData(this.waveform)
    let rms = 0
    for (const sample of this.waveform) rms += sample * sample
    rms = Math.sqrt(rms / this.waveform.length)
    if (context.currentTime - this.meterTime < 0.15) rms = this.meterRms
    const binHz = context.sampleRate / this.analyser.fftSize
    let low = 0,
      mid = 0,
      high = 0,
      lc = 0,
      mc = 0,
      hc = 0,
      flux = 0
    for (let i = 1; i < this.spectrum.length; i++) {
      const hz = i * binHz
      const magnitude = Math.pow(10, (this.spectrum[i] ?? -100) / 20)
      flux += Math.max(0, magnitude - (this.previous[i] ?? 0))
      this.previous[i] = magnitude
      if (hz < 220) {
        low += magnitude
        lc++
      } else if (hz < 2600) {
        mid += magnitude
        mc++
      } else if (hz < 14000) {
        high += magnitude
        hc++
      }
    }
    flux /= this.spectrum.length
    this.fluxAverage += (flux - this.fluxAverage) * (1 - Math.exp(-dt * 1.5))
    this.pulse = Math.max(
      this.pulse * Math.exp(-dt * 9),
      rms > 0.003
        ? Math.min(1, Math.max(0, flux / Math.max(this.fluxAverage, 0.00003) - 1.5) * 0.45)
        : 0,
    )
    const smooth = 1 - Math.exp(-dt * 10)
    this.value.bass +=
      (Math.min(1, Math.sqrt(low / Math.max(1, lc)) * 2.2) - this.value.bass) * smooth

    this.value.body +=
      (Math.min(1, Math.sqrt(mid / Math.max(1, mc)) * 2.8) - this.value.body) * smooth
    this.value.air += (Math.min(1, Math.sqrt(high / Math.max(1, hc)) * 4) - this.value.air) * smooth
    this.value.energy += (Math.min(1, rms * 3) - this.value.energy) * smooth
    this.value.onset = this.pulse
    if (this.left && this.right) {
      this.left.getFloatTimeDomainData(this.leftWave)
      this.right.getFloatTimeDomainData(this.rightWave)
      let difference = 0,
        sum = 0
      for (let i = 0; i < this.leftWave.length; i++) {
        const l = this.leftWave[i] ?? 0,
          r = this.rightWave[i] ?? 0
        difference += (l - r) ** 2
        sum += l * l + r * r
      }
      this.value.width +=
        (Math.min(1, Math.sqrt(difference / Math.max(sum, 0.0001))) - this.value.width) * smooth
    }
    if (context.currentTime - this.meterTime < 0.15) this.value.width = this.meterWidth
    return this.value
  }
}
