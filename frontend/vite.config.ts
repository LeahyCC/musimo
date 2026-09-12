import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { proxy: { '/api': 'http://127.0.0.1:8765' } },
  // Unit tests are for pure TypeScript and run in Node. Anything that needs a
  // browser belongs in the Playwright suite under e2e.
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
})
