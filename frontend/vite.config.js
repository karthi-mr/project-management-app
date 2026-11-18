import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The development API runs on 8001 so it never touches the live app on 8000 (see MAKING-CHANGES.md).
    proxy: {
      '/api': { target: `http://127.0.0.1:${process.env.API_PORT || 8001}`, ws: true },
    },
  },
})
