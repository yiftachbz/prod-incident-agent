import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  // In dev, proxy /api to the local server unless VITE_API_URL is an absolute URL.
  const devServerTarget = env.VITE_API_URL || 'http://127.0.0.1:3001'

  return {
    plugins: [react()],
    server: {
      port: 3000,
      proxy: {
        '/api': {
          target: devServerTarget,
          changeOrigin: true,
        },
      },
    },
  }
})
