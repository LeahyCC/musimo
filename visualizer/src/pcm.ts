export type Pcm = { sampleRate: number; left: Float32Array; right: Float32Array }
export type AudioFrame = {
  timeByteArray: Uint8Array
  timeByteArrayL: Uint8Array
  timeByteArrayR: Uint8Array
}

export function createAudioFrame(): AudioFrame {
  return {
    timeByteArray: new Uint8Array(1024),
    timeByteArrayL: new Uint8Array(1024),
    timeByteArrayR: new Uint8Array(1024),
  }
}

// Use the window ending at media time. Display refresh never advances the PCM cursor.
export function samplePcm(pcm: Pcm, seconds: number, target: AudioFrame, offset = 0) {
  const end = Math.round((seconds + offset) * pcm.sampleRate)
  const toByte = (value: number) => Math.max(0, Math.min(255, Math.floor(128 + value * 128)))
  for (let i = 0; i < 1024; i++) {
    const index = end - 1024 + i
    const left = pcm.left[index] ?? 0
    const right = pcm.right[index] ?? 0
    target.timeByteArrayL[i] = toByte(left)
    target.timeByteArrayR[i] = toByte(right)
    target.timeByteArray[i] = toByte((left + right) / 2)
  }
  return target
}
