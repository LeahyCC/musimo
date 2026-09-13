import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Where /api goes during development. Point it at another machine's Musimo to
// work against that library.
const apiTarget = process.env.MUSIMO_API_TARGET ?? 'http://127.0.0.1:8765'
// The backend refuses writes whose Origin does not match its Host. Over plain
// http the browser's own Host goes through and the two agree. An https target
// (Tailscale Serve, a reverse proxy) needs its real name for TLS, so the proxy
// presents the target's name on both headers instead; only pages served by
// this dev server can reach it, so nothing else gains access.
const secure = apiTarget.startsWith('https:')

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // visimo ships TypeScript rather than a build, and its shaders are `?raw`
  // imports the dependency pre-bundler cannot load out of node_modules. The
  // exclusion is also what keeps its feature worker's asset URL intact.
  optimizeDeps: { exclude: ['visimo'] },
  server: {
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: secure,
        configure(proxy) {
          if (!secure) return
          proxy.on('proxyReq', (request) => {
            if (request.getHeader('origin')) request.setHeader('origin', new URL(apiTarget).origin)
          })
        },
      },
    },
  },
  // Unit tests are for pure TypeScript and run in Node. Anything that needs a
  // browser belongs in the Playwright suite under e2e.
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
})
