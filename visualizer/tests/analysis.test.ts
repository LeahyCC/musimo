import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

test('local analysis identifies the recording and refuses to overwrite an existing result', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'musimo-analysis-test-'))
  const input = path.join(directory, 'tone.wav')
  const output = path.join(directory, 'song.json')
  const args = [
    'scripts/analyze.mjs',
    '--input',
    input,
    '--output',
    output,
    '--title',
    'Generated tone',
    '--artist',
    'Test fixture',
  ]
  try {
    execFileSync(
      'ffmpeg',
      ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', input],
      { windowsHide: true },
    )
    execFileSync(process.execPath, args, { windowsHide: true })
    const saved = readFileSync(output, 'utf8')
    const result: unknown = JSON.parse(saved)
    assert.ok(
      typeof result === 'object' &&
        result !== null &&
        'recording' in result &&
        'features' in result,
    )
    const recording = result.recording as {
      sha256: string
      duration: number
      sourceSampleRate: number
    }
    const features = result.features as number[][]
    assert.match(recording.sha256, /^[a-f0-9]{64}$/)
    assert.equal(recording.duration, 1)
    assert.equal(recording.sourceSampleRate, 44100)
    assert.ok(features.length > 20)
    assert.ok(features.every((row) => row.length === 5 && row.every(Number.isFinite)))
    assert.ok(features.every((row, i) => i === 0 || row[0] > features[i - 1][0]))
    assert.throws(() => execFileSync(process.execPath, args, { windowsHide: true, stdio: 'pipe' }))
    assert.equal(readFileSync(output, 'utf8'), saved)
  } finally {
    // Only this test's unique temporary directory is removed, never a user-supplied path.
    const root = path.resolve(tmpdir()) + path.sep
    assert.ok(
      path.resolve(directory).startsWith(root) &&
        path.basename(directory).startsWith('musimo-analysis-test-'),
    )
    rmSync(directory, { recursive: true, force: true })
  }
})
