import dive from '../songs/dive-extended-mix.analysis.json'
import song from '../songs/dive-extended-mix.song.json'
import { studies, VisualizerEngine } from './engine.ts'
import type { Pcm } from './engine.ts'
import type { Study } from './engine.ts'
import type { JourneyScore } from './engine.ts'
import type { StudioOptions, Theme } from './engine.ts'
import {
  mergeStudioOptions,
  parseStudioOptions,
  resolveSeed,
  serializeStudioOptions,
  STUDIO_STORAGE_KEY,
} from './studio-options.ts'

import './style.css'

function element<T extends HTMLElement>(id: string) {
  const found = document.getElementById(id)
  if (!found) throw new Error(`Missing preview element: ${id}`)
  return found as T
}
const audio = element<HTMLAudioElement>('audio')
const play = element<HTMLButtonElement>('play')
const start = element<HTMLButtonElement>('start')
const restart = element<HTMLButtonElement>('restart')
const seek = element<HTMLInputElement>('seek')
const preset = element<HTMLSelectElement>('preset')
const quality = element<HTMLSelectElement>('quality')
const welcome = element('welcome')
const status = element('status')
const renderState = element('render-state')
let canvas = element<HTMLCanvasElement>('visual')
let engine: VisualizerEngine | undefined
let preparingEngine: VisualizerEngine | undefined
let pcm: Pcm | undefined
let loading = false
let rebuilding = false
let rebuildTask: Promise<void> = Promise.resolve()
let generation = 0
let recordingUrl: string | undefined
let pending: AbortController | undefined
let activeRequest = 0
let lastStats = 0
let raf = 0
let unloaded = false
let isDive = true
let recorder: MediaRecorder | undefined
let startingRecording = false
let clipUrl: string | undefined
let captureStream: MediaStream | undefined
let recordingTimeout = 0
const record = element<HTMLButtonElement>('record')
const recording = element<HTMLVideoElement>('recording')
const journeyScore: JourneyScore = {
  ...(song as JourneyScore),
  analysis: {
    hopSeconds: dive.analysis.hopSamples / dive.analysis.sampleRate,
    columns: dive.analysis.featureColumns,
    frames: dive.features,
  },
}

const time = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
const tell = (message: string) => {
  status.textContent = message
}

function ready(value: boolean) {
  play.disabled = !value
  start.disabled = !value
  restart.disabled = !value
  seek.disabled = !value
  record.disabled = !value || !engine
  for (const button of element('cue-list').querySelectorAll('button')) button.disabled = !value
}

function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : 'Something went wrong. Try opening a recording again.'
}

function rebuild() {
  // A capture belongs to one canvas. Finish it before replacing that surface.
  if (recorder?.state === 'recording') recorder.stop()
  const token = ++generation
  preparingEngine?.dispose()
  // Serialize expensive shader preparation, but only publish the most recent request.
  rebuildTask = rebuildTask.then(() => prepareRenderer(token))
  return rebuildTask
}

async function prepareRenderer(token: number) {
  if (!pcm || token !== generation || unloaded) return
  rebuilding = true
  record.disabled = true
  const nextCanvas = document.createElement('canvas')
  nextCanvas.id = 'visual'
  nextCanvas.setAttribute('aria-label', 'Live visualizer output')
  let next: VisualizerEngine | undefined
  try {
    renderState.textContent = 'Preparing visual…'
    next = new VisualizerEngine(
      nextCanvas,
      pcm,
      Number(quality.value),
      isDive ? journeyScore : undefined,
      studioOptions,
    )
    preparingEngine = next
    await next.load(preset.value as Study)
    if (token !== generation || unloaded) {
      next.dispose()
      return
    }
    await next.startAt(audio.currentTime, () => audio.currentTime)
    if (token !== generation || unloaded) {
      next.dispose()
      return
    }
    engine?.dispose()
    const previousCanvas = canvas
    previousCanvas.removeAttribute('id')
    previousCanvas.setAttribute('aria-hidden', 'true')
    previousCanvas.style.position = 'absolute'
    previousCanvas.style.inset = '0'
    previousCanvas.after(nextCanvas)
    nextCanvas.style.position = 'relative'
    void nextCanvas
      .animate([{ opacity: 0 }, { opacity: 1 }], { duration: 450, easing: 'ease-out' })
      .finished.then(
        () => previousCanvas.remove(),
        () => previousCanvas.remove(),
      )
    canvas = nextCanvas
    engine = next
    // Debug hook for soak checks and effect development.
    ;(window as unknown as { __engine?: VisualizerEngine }).__engine = next
    const study = studies[preset.value as Study]
    document.querySelector('.viewer-top > span')!.textContent =
      preset.selectedOptions[0].text.toUpperCase()
    element('credit').textContent =
      study.renderer === 'native'
        ? `Visual: ${study.author} · Native renderer`
        : `Visual: ${study.author} · Butterchurn 3.0.0-beta.5`
    element('quality-label').textContent = quality.selectedOptions[0].text
    renderState.textContent = audio.paused ? 'Ready · press play' : 'Live · audio clock'
    record.disabled = loading
  } catch (error) {
    next?.dispose()
    if (token !== generation || unloaded) return
    tell(`Visual unavailable: ${errorMessage(error)} Audio can still play.`)
    renderState.textContent = 'Visual unavailable · try 720p or another study'
  } finally {
    if (preparingEngine === next) preparingEngine = undefined
    rebuilding = false
    record.disabled = loading || !engine
  }
}

async function loadRecording(source: string | File) {
  const requestId = ++activeRequest
  pending?.abort()
  pending = new AbortController()
  loading = true
  ready(false)
  tell('Preparing audio samples…')
  try {
    const blob =
      typeof source === 'string'
        ? await fetch(source, { signal: pending.signal }).then((response) => {
            if (!response.ok)
              throw new Error('Recording unavailable. Use Open your song to choose a local file.')
            return response.blob()
          })
        : source
    const bytes = await blob.arrayBuffer()
    if (typeof source === 'string') {
      const hash = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
        (value) => value.toString(16).padStart(2, '0'),
      ).join('')
      if (hash !== dive.recording.sha256)
        throw new Error(
          'The recording does not match this song analysis. Prepare the matching recording again.',
        )
    }
    const decoded = await new OfflineAudioContext(2, 1, 44100).decodeAudioData(bytes)
    if (requestId !== activeRequest || unloaded) return
    if (typeof source === 'string' && Math.abs(decoded.duration - dive.recording.duration) > 0.25)
      throw new Error('The recording duration does not match the prepared song data.')
    audio.pause()
    // A failed replacement must never animate a new recording with old PCM.
    engine?.dispose()
    engine = undefined
    if (recordingUrl) URL.revokeObjectURL(recordingUrl)
    recordingUrl = URL.createObjectURL(blob)
    audio.src = recordingUrl
    audio.load()
    pcm = {
      sampleRate: decoded.sampleRate,
      left: decoded.getChannelData(0),
      right: decoded.getChannelData(Math.min(1, decoded.numberOfChannels - 1)),
    }
    isDive = typeof source === 'string'
    studioLabels()
    const diveOption = preset.querySelector<HTMLOptionElement>('option[value="dive"]')!
    diveOption.disabled = !isDive
    if (!isDive && preset.value === 'dive') preset.value = 'sherwin'
    element('journey').hidden = !isDive
    seek.max = String(decoded.duration)
    element('duration').textContent = time(decoded.duration)
    if (source instanceof File) {
      element('title').textContent = source.name.replace(/\.[^.]+$/, '')
      element('artist').textContent = 'Local recording'
      element('fixture-label').textContent = 'YOUR RECORDING · PRESET AUDITION'
      element('source').hidden = true
    }
    await rebuild()
    if (requestId !== activeRequest || unloaded) return
    start.textContent = 'Play the study'
    welcome.hidden = false
    tell('Ready to play')
  } catch (error) {
    if (requestId !== activeRequest || unloaded) return
    tell(errorMessage(error))
    start.textContent = 'Use Open your song below'
  } finally {
    if (requestId === activeRequest) {
      loading = false
      ready(Boolean(pcm))
    }
  }
}

async function toggle() {
  if (!audio.paused) {
    audio.pause()
    return
  }
  try {
    await audio.play()
  } catch {
    tell('Press play to allow audio, or open another recording.')
  }
}
play.onclick = () => {
  void toggle()
}
start.onclick = () => {
  void toggle()
}
restart.onclick = () => {
  audio.currentTime = 0
  void audio.play().catch(() => tell('Press play to continue.'))
}
seek.onchange = () => {
  audio.currentTime = Number(seek.value)
}
const volume = element<HTMLInputElement>('volume')
volume.oninput = () => {
  audio.volume = Number(volume.value)
  try {
    localStorage.setItem('musimo.studio.volume', volume.value)
  } catch {
    /* Volume still works when storage is disabled. */
  }
}
try {
  volume.value = localStorage.getItem('musimo.studio.volume') ?? '0.13'
} catch {
  volume.value = '0.13'
}
audio.volume = Number(volume.value)
preset.onchange = () => {
  void rebuild()
}
quality.onchange = () => {
  void rebuild()
}

// Customize panel: live tuning baked into the preset at rebuild time, persisted
// in localStorage. Slider input updates the label only; the rebuild fires on
// change (release), so dragging cannot storm shader recompiles.
const studioOptions = mergeStudioOptions(
  parseStudioOptions(
    (() => {
      try {
        return localStorage.getItem(STUDIO_STORAGE_KEY)
      } catch {
        return null
      }
    })(),
  ),
)
const theme = element<HTMLSelectElement>('theme')
const motion = element<HTMLInputElement>('motion')
const trails = element<HTMLInputElement>('trails')
const sensitivity = element<HTMLInputElement>('sensitivity')
const reroll = element<HTMLButtonElement>('reroll')
const seedScore = element<HTMLButtonElement>('seed-score')

function persistStudioOptions() {
  try {
    localStorage.setItem(STUDIO_STORAGE_KEY, serializeStudioOptions(studioOptions))
  } catch {
    /* Customization still works when storage is disabled. */
  }
}

function studioLabels() {
  element('motion-value').textContent =
    `${Number(motion.value).toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}×`
  element('trails-value').textContent = `${Math.round(Number(trails.value) * 100)}%`
  element('sensitivity-value').textContent =
    `${Number(sensitivity.value).toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}×`
  const activeSeed = resolveSeed(studioOptions, isDive ? journeyScore.seed : undefined)
  element('seed-value').textContent =
    studioOptions.seed === undefined
      ? `${activeSeed} · ${isDive ? 'score' : 'default'}`
      : String(activeSeed)
  seedScore.hidden = studioOptions.seed === undefined
}

const isNativeStudy = () => studies[preset.value as Study].renderer === 'native'

function applyStudioOptions(patch: StudioOptions) {
  Object.assign(studioOptions, mergeStudioOptions({ ...studioOptions, ...patch }))
  persistStudioOptions()
  studioLabels()
  // A native study carries the options as uniforms, so only the seed, which
  // generates the noise textures at load, still needs the rebuild.
  if (engine && isNativeStudy() && !('seed' in patch)) {
    engine.setOptions(studioOptions)
    return
  }
  void rebuild()
}

// Uniform updates are cheap enough to follow the drag rather than waiting for
// the release a Butterchurn rebuild needs.
function tuneLive(patch: StudioOptions) {
  studioLabels()
  if (!engine || !isNativeStudy()) return
  Object.assign(studioOptions, mergeStudioOptions({ ...studioOptions, ...patch }))
  engine.setOptions(studioOptions)
}

theme.value = studioOptions.theme
motion.value = String(studioOptions.motion)
trails.value = String(studioOptions.trails)
sensitivity.value = String(studioOptions.sensitivity)
theme.onchange = () => applyStudioOptions({ theme: theme.value as Theme })
motion.oninput = () => tuneLive({ motion: Number(motion.value) })
trails.oninput = () => tuneLive({ trails: Number(trails.value) })
sensitivity.oninput = () => tuneLive({ sensitivity: Number(sensitivity.value) })
motion.onchange = () => applyStudioOptions({ motion: Number(motion.value) })
trails.onchange = () => applyStudioOptions({ trails: Number(trails.value) })
sensitivity.onchange = () => applyStudioOptions({ sensitivity: Number(sensitivity.value) })
reroll.onclick = () => applyStudioOptions({ seed: Math.floor(Math.random() * (0x7fffffff + 1)) })
seedScore.onclick = () => {
  delete studioOptions.seed
  persistStudioOptions()
  studioLabels()
  void rebuild()
}
studioLabels()
element<HTMLInputElement>('file').onchange = (event) => {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (file) void loadRecording(file)
}
element('fullscreen').onclick = () => {
  if (document.fullscreenElement) void document.exitFullscreen()
  else
    void document
      .querySelector('.viewer')!
      .requestFullscreen()
      .catch(() => tell('Full screen is unavailable in this browser.'))
}
audio.onplay = () => {
  recording.pause()
  welcome.hidden = true
  play.textContent = 'Ⅱ'
  play.setAttribute('aria-label', 'Pause')
  tell('Playing')
}
audio.onpause = () => {
  play.textContent = '▶'
  play.setAttribute('aria-label', 'Play')
  tell(audio.ended ? 'Finished · replay from the beginning' : 'Paused')
}
audio.onseeked = () => {
  void rebuild()
}
audio.onerror = () => {
  tell('This recording could not be played. Open another audio file.')
  ready(false)
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !audio.paused) void rebuild()
})
document.addEventListener('keydown', (event) => {
  if (event.code !== 'Space' || event.ctrlKey || event.metaKey || event.altKey) return
  if (
    event.target instanceof HTMLElement &&
    event.target.closest('button,input,select,a,[contenteditable]')
  )
    return
  event.preventDefault()
  if (!play.disabled) void toggle()
})

function tick(now: number) {
  if (unloaded) return
  raf = requestAnimationFrame(tick)
  if (document.hidden || loading) return
  try {
    if (
      !audio.paused &&
      !audio.seeking &&
      !rebuilding &&
      engine &&
      engine.advance(audio.currentTime) === false
    )
      void rebuild()
  } catch (error) {
    engine?.dispose()
    engine = undefined
    tell(`Visual stopped: ${errorMessage(error)} Audio continues.`)
  }
  if (now - lastStats > 200) {
    lastStats = now
    element('position').textContent = time(audio.currentTime)
    if (document.activeElement !== seek) seek.value = String(audio.currentTime)
    if (engine)
      renderState.textContent = audio.paused
        ? 'Paused · visual held'
        : `Live · ${Math.round(engine.position * 60)} frames`
    if (engine && engine.costs.length) {
      const costs = [...engine.costs].sort((a, b) => a - b)
      element('metrics').textContent =
        `${canvas.width} × ${canvas.height} · render submission p95 ${costs[Math.floor((costs.length - 1) * 0.95)].toFixed(1)} ms · preset preparation ${engine.loadMs.toFixed(1)} ms · media/visual difference ${Math.abs(audio.currentTime - engine.position).toFixed(3)} s. Submission time excludes GPU completion.`
    }
    if (isDive) {
      const cue = song.cues.filter((item) => item.time <= audio.currentTime).at(-1) ?? song.cues[0]
      element('current-cue').textContent =
        engine?.journeyState?.label ?? `${cue.label} · preset audition`
      for (const button of element('cue-list').querySelectorAll('button'))
        button.setAttribute('aria-current', String(button.dataset.time === String(cue.time)))
    }
  }
}
raf = requestAnimationFrame(tick)
window.addEventListener('pagehide', (event) => {
  if (event.persisted) {
    audio.pause()
    return
  }
  unloaded = true
  generation++
  cancelAnimationFrame(raf)
  pending?.abort()
  audio.pause()
  engine?.dispose()
  preparingEngine?.dispose()
  if (recorder?.state === 'recording') recorder.stop()
  window.clearTimeout(recordingTimeout)
  if (clipUrl) URL.revokeObjectURL(clipUrl)
  if (recordingUrl) URL.revokeObjectURL(recordingUrl)
})

for (const [index, cue] of song.cues.entries()) {
  const button = document.createElement('button')
  button.textContent = cue.label
  button.title = `${time(cue.time)} · ${cue.label}`
  button.dataset.time = String(cue.time)
  button.dataset.motif = cue.motif
  button.style.flex = String((song.cues[index + 1]?.time ?? song.recording.duration) - cue.time)
  button.onclick = () => {
    if (!loading) audio.currentTime = cue.time
  }
  element('cue-list').append(button)
}
const waveform = element<HTMLElement>('waveform')
const bars = 300
for (let i = 0; i < bars; i++) {
  const from = Math.floor((i * dive.features.length) / bars)
  const to = Math.floor(((i + 1) * dive.features.length) / bars)
  const rms =
    dive.features.slice(from, to).reduce((sum, frame) => sum + Math.pow(10, frame[1] / 20), 0) /
    (to - from)
  const height = Math.max(1, Math.min(42, rms * 85))
  const bar = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
  bar.setAttribute('x', String(i * 4))
  bar.setAttribute('y', String(22 - height / 2))
  bar.setAttribute('width', '2')
  bar.setAttribute('height', String(height))
  bar.setAttribute('fill', '#65798e')
  waveform.append(bar)
}

record.onclick = async () => {
  if (startingRecording || rebuilding || loading || !engine) return
  if (recorder?.state === 'recording') {
    recorder.stop()
    return
  }
  startingRecording = true
  let stream: MediaStream | undefined
  try {
    await audio.play()
    if (rebuilding || loading || !engine || unloaded)
      throw new Error('Wait for the visual to finish preparing before recording.')
    const media = audio as HTMLAudioElement & { captureStream?: () => MediaStream }
    if (!media.captureStream || !window.MediaRecorder)
      throw new Error('Playback recording is unavailable in this browser.')
    const audioTracks = media.captureStream().getAudioTracks()
    if (!audioTracks.length)
      throw new Error('No audio track is available to record yet. Try again while the song plays.')
    stream = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...audioTracks])
    captureStream = stream
    const mimeType = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ].find((value) => MediaRecorder.isTypeSupported(value))
    if (!mimeType) throw new Error('This browser cannot record a WebM clip.')
    recorder = new MediaRecorder(captureStream, { mimeType, videoBitsPerSecond: 6_000_000 })
    const chunks: Blob[] = []
    const controls = [
      seek,
      restart,
      preset,
      quality,
      element<HTMLInputElement>('file'),
      ...element('cue-list').querySelectorAll('button'),
    ]
    controls.forEach((control) => {
      control.disabled = true
    })
    record.textContent = 'Stop recording'
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data)
    }
    recorder.onstop = () => {
      window.clearTimeout(recordingTimeout)
      stream?.getTracks().forEach((track) => track.stop())
      if (clipUrl) URL.revokeObjectURL(clipUrl)
      clipUrl = URL.createObjectURL(new Blob(chunks, { type: mimeType }))
      element<HTMLVideoElement>('recording').src = clipUrl
      element<HTMLAnchorElement>('save-capture').href = clipUrl
      element('capture').hidden = false
      record.textContent = 'Record clip'
      controls.forEach((control) => {
        control.disabled = false
      })
      if (loading) ready(false)
      tell('Playback clip ready below')
    }
    recorder.start(1000)
    recordingTimeout = window.setTimeout(
      () => recorder?.state === 'recording' && recorder.stop(),
      20_000,
    )
    tell('Recording 20 seconds of picture and sound…')
  } catch (error) {
    stream?.getTracks().forEach((track) => track.stop())
    tell(errorMessage(error))
  } finally {
    startingRecording = false
  }
}
audio.addEventListener('pause', () => {
  if (recorder?.state === 'recording') recorder.stop()
})
recording.onplay = () => audio.pause()

element('title').textContent = dive.recording.title
element('artist').textContent = `${dive.recording.artist} · Dive EP`
element('fixture-label').textContent = 'ONE-SONG STUDY'
element<HTMLAnchorElement>('source').href =
  'http://127.0.0.1:8765/library/albums/6dyk46CcyFRoIcNTMw4BPQ'
element('source').textContent = 'Open album in Musimo ↗'
void loadRecording(dive.recording.mediaUrl!)
