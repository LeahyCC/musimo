import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Where /api goes during development. Point it at another machine's Musimo to
// work against that library.
const apiTarget = process.env.MUSIMO_API_TARGET ?? 'http://127.0.0.1:8765'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Vite rewrites the Host header to the target's by default, and the backend
  // refuses writes whose Origin does not match Host. Keep the browser's Host so
  // saving the queue, scrobbling and settings work through the proxy.
  server: { proxy: { '/api': { target: apiTarget, changeOrigin: false } } },
  // Unit tests are for pure TypeScript and run in Node. Anything that needs a
  // browser belongs in the Playwright suite under e2e.
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
})
