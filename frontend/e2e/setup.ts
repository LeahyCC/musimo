import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { CI_PROJECT } from './env'

export default function setup() {
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
from mutagen.id3 import TIT2, TPE1, TALB, TRCK
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
`,
    ],
    { cwd: fileURLToPath(new URL('../../', import.meta.url)), stdio: 'inherit', timeout: 30_000 },
  )
}
