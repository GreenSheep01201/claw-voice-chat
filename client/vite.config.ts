import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const DEV_PROXY_TARGET = process.env.VITE_DEV_PROXY_TARGET || 'http://127.0.0.1:8888'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Keep the browser-facing protocol identical to production (same-origin /api + /ws).
      '/api': {
        target: DEV_PROXY_TARGET,
        changeOrigin: true,
      },
      '/ws': {
        target: DEV_PROXY_TARGET,
        ws: true,
        changeOrigin: true,
      },
      '/bridge': {
        target: DEV_PROXY_TARGET,
        changeOrigin: true,
      },
    },
  },
})
