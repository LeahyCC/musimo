import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BASE_URL, CI_PROJECT } from './env'

export default async function setup() {
  // WebKit can fetch media outside browser routing. Serve generated silence over real HTTP.
  execFileSync(
    'docker',
    [
      'compose',
      '-f',
      'compose.ci.yaml',
      '-p',
      CI_PROJECT,
      'exec',
      '-T',
      '--user',
      'root',
      'musimo',
      'python',
      '-c',
      `import wave
from pathlib import Path
from mutagen.wave import WAVE
from mutagen.id3 import TIT2, TPE1, TALB, TRCK, TDRC, TCON
def silence(path):
    with wave.open(str(path), 'wb') as stream:
        stream.setparams((1, 2, 8000, 0, 'NONE', 'not compressed'))
        stream.writeframes(bytes(30 * 8000 * 2))
silence('/app/frontend/dist/assets/e2e-silence.wav')
folder = Path('/music/e2e-local-player')
folder.mkdir(exist_ok=True)
for number, title in enumerate(('Local First Light', 'Local Second Light'), 1):
    path = folder / f'{number}.wav'
    silence(path)
    audio = WAVE(path)
    audio.add_tags()
    audio.tags.add(TIT2(encoding=3, text=title))
    audio.tags.add(TPE1(encoding=3, text='Generated Local Artist'))
    audio.tags.add(TALB(encoding=3, text='Local Playback Fixture'))
    audio.tags.add(TRCK(encoding=3, text=str(number)))
    audio.save()
folder = Path('/music/e2e-music-bot')
folder.mkdir(exist_ok=True)
for number, (title, artist, year) in enumerate((('Bot Harbor', 'Fixture Harbor', 1992), ('Bot Orchard', 'Fixture Orchard', 1996), ('Bot Played Today', 'Fixture Harbor', 1998), ('Bot Eighties', 'Fixture Orchard', 1985)), 1):
    path = folder / f'{number}.wav'
    silence(path)
    audio = WAVE(path)
    audio.add_tags()
    audio.tags.add(TIT2(encoding=3, text=title))
    audio.tags.add(TPE1(encoding=3, text=artist))
    audio.tags.add(TALB(encoding=3, text='Music Bot Fixture'))
    audio.tags.add(TDRC(encoding=3, text=str(year)))
    audio.tags.add(TCON(encoding=3, text='Rock'))
    audio.save()
`,
    ],
    { cwd: fileURLToPath(new URL('../../', import.meta.url)), stdio: 'inherit', timeout: 30_000 },
  )
  await ensureListener()
}

/** One name on the isolated stack, so listener routes have someone to answer. Not port 8765. */
async function ensureListener() {
  const url = new URL(BASE_URL)
  if (url.port === '8765') throw new Error('Refusing the live Musimo port')
  const created = await fetch(`${BASE_URL}/api/listeners`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Listener' }),
  })
  let id = ''
  if (created.ok) {
    const body: unknown = await created.json()
    if (body && typeof body === 'object' && 'id' in body && typeof body.id === 'string')
      id = body.id
  } else if (created.status === 409) {
    const list = await fetch(`${BASE_URL}/api/listeners`)
    const body: unknown = await list.json()
    const items =
      body && typeof body === 'object' && 'items' in body && Array.isArray(body.items)
        ? body.items
        : []
    const found = items.find(
      (item): item is { id: string; name: string } =>
        !!item &&
        typeof item === 'object' &&
        'name' in item &&
        item.name === 'Listener' &&
        'id' in item &&
        typeof item.id === 'string',
    )
    id = found?.id ?? ''
  } else {
    throw new Error(`listener setup failed: ${created.status}`)
  }
  if (!id) throw new Error('listener setup did not return an id')
  const root = fileURLToPath(new URL('../../runtime/', import.meta.url))
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'e2e-listener-id'), `${id}\n`, 'utf8')
}
