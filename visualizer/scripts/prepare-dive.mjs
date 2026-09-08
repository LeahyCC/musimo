import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

const analysis = JSON.parse(
  await readFile(new URL('../songs/dive-extended-mix.analysis.json', import.meta.url), 'utf8'),
)
const output = new URL('../public/local/dive.opus', import.meta.url)
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
try {
  const existing = await readFile(output).catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (existing) {
    if (digest(existing) !== analysis.recording.sha256)
      throw new Error(
        'The existing local recording differs. Keep it and prepare the matching recording separately.',
      )
    console.log('The matching Dive recording is already prepared.')
  } else {
    const response = await fetch(
      `http://127.0.0.1:8765/api/player/stream/${encodeURIComponent(analysis.recording.id)}`,
    )
    if (!response.ok)
      throw new Error(
        `Musimo returned HTTP ${response.status}. Start your local Musimo server and try again.`,
      )
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (digest(bytes) !== analysis.recording.sha256)
      throw new Error(
        'The library recording differs from the prepared source identity. Analyze this version separately.',
      )
    await mkdir(new URL('../public/local/', import.meta.url), { recursive: true })
    await writeFile(output, bytes, { flag: 'wx' })
    console.log('Prepared Dive locally. Its audio is excluded from git.')
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
