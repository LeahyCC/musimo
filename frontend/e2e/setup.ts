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
      "import wave; w=wave.open('/app/frontend/dist/assets/e2e-silence.wav','wb'); w.setparams((1,2,8000,0,'NONE','not compressed')); w.writeframes(bytes(30*8000*2)); w.close()",
    ],
    { cwd: fileURLToPath(new URL('../../', import.meta.url)), stdio: 'inherit', timeout: 30_000 },
  )
}
