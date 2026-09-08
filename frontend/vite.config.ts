import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), 'MUSIMO_')
  const api = environment.MUSIMO_API_URL || 'http://127.0.0.1:8765'
  const visuals = environment.MUSIMO_VISUALIZER_API_URL || api
  return {
    plugins: [react(), tailwindcss()],
    server: {
      proxy: {
        '/api/visualizer': { target: visuals, changeOrigin: false },
        '/api/preview': { target: visuals, changeOrigin: false },
        '/api': { target: api, changeOrigin: false },
      },
    },
  }
})
