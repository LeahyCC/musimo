import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The visualizer engine is linked from ../visualizer as source, so the dev
  // server needs to read outside frontend/ and must not pre-bundle it.
  server: { proxy: { '/api': 'http://127.0.0.1:8765' }, fs: { allow: ['..'] } },
  optimizeDeps: { exclude: ['@musimo/visualizer'] },
})
