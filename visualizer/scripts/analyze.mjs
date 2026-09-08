import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs, promisify } from 'node:util'

const run = promisify(execFile)
const { values } = parseArgs({
  options: {
    'input': { type: 'string' },
    'output': { type: 'string' },
    'title': { type: 'string' },
    'artist': { type: 'string' },
    'recording-id': { type: 'string' },
    'media-url': { type: 'string' },
    'offset': { type: 'string', default: '0' },
  },
})

try {
  if (!values.input || !values.output || !values.title || !values.artist) {
    throw new Error(
      'Usage: npm run analyze -- --input recording.opus --output song.analysis.json --title "Song" --artist "Artist" [--recording-id ID] [--media-url /local/song.opus] [--offset 0]',
    )
  }
  const offset = Number(values.offset)
  if (!Number.isFinite(offset) || Math.abs(offset) > 30)
    throw new Error('Offset must be a number between -30 and 30 seconds.')
  const input = path.resolve(values.input)
  const output = path.resolve(values.output)
  const source = await readFile(input)
  const sha256 = createHash('sha256').update(source).digest('hex')
  const options = { windowsHide: true, maxBuffer: 64 * 1024 * 1024 }
  const [probe, version] = await Promise.all([
    run(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'a:0',
        '-show_entries',
        'format=duration:stream=sample_rate,channels',
        '-of',
        'json',
        input,
      ],
      options,
    ),
    run('ffmpeg', ['-version'], options),
  ])
  const info = JSON.parse(probe.stdout)
  const duration = Number(info.format?.duration)
  const sourceRate = Number(info.streams?.[0]?.sample_rate)
  if (!(duration > 0 && duration <= 1800 && sourceRate > 0))
    throw new Error('Choose a decodable recording between 0 and 30 minutes long.')
  const filter =
    'aresample=44100,asetnsamples=n=2048:p=1,astats=metadata=1:reset=1:measure_perchannel=none:measure_overall=RMS_level,aspectralstats=win_size=2048:overlap=0:measure=centroid+flatness+flux,ametadata=mode=print:file=-'
  const result = await run(
    'ffmpeg',
    ['-v', 'error', '-i', input, '-map', '0:a:0', '-af', filter, '-f', 'null', '-'],
    options,
  )
  const frames = []
  let frame
  for (const line of result.stdout.split(/\r?\n/)) {
    const timestamp = /pts_time:([\d.e+-]+)/.exec(line)
    if (timestamp) {
      frame = { time: Number(timestamp[1]), values: {} }
      frames.push(frame)
    } else if (frame && line.startsWith('lavfi.')) {
      const [key, value] = line.split('=')
      frame.values[key] = Number(value)
    }
  }
  const finite = (value, fallback = 0) =>
    Number.isFinite(value) ? Number(value.toFixed(6)) : fallback
  const mean = (data, key) => {
    const first = data[`lavfi.aspectralstats.1.${key}`]
    const second = data[`lavfi.aspectralstats.2.${key}`] ?? first
    return finite((first + second) / 2)
  }
  const analysis = {
    schemaVersion: 1,
    recording: {
      id: values['recording-id'] ?? `sha256:${sha256}`,
      sha256,
      title: values.title,
      artist: values.artist,
      duration,
      sourceSampleRate: sourceRate,
      channels: Number(info.streams[0].channels),
      mediaUrl: values['media-url'] ?? null,
    },
    analysis: {
      version: 'ffmpeg-spectral-v1',
      tool: version.stdout.split(/\r?\n/)[0],
      sampleRate: 44100,
      windowSamples: 2048,
      hopSamples: 2048,
      timingOffsetSeconds: offset,
      timestamp: 'window-start',
      featureColumns: ['timeSeconds', 'rmsDb', 'centroidHz', 'flatness', 'flux'],
      notes:
        'Measured audio features only. Section, beat and recurrence judgments require listening review.',
    },
    features: frames
      .filter((item) => item.time < duration)
      .map((item) => [
        finite(item.time),
        finite(item.values['lavfi.astats.Overall.RMS_level'], -120),
        mean(item.values, 'centroid'),
        mean(item.values, 'flatness'),
        mean(item.values, 'flux'),
      ]),
  }
  if (!analysis.features.length) throw new Error('FFmpeg returned no audio features.')
  await mkdir(path.dirname(output), { recursive: true })
  // Refuse to replace a prior analysis or a timeline the user may already have reviewed.
  await writeFile(output, JSON.stringify(analysis), { flag: 'wx' })
  console.log(
    `Prepared ${analysis.features.length} audio windows, ${duration.toFixed(3)} seconds. Saved ${output}`,
  )
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
