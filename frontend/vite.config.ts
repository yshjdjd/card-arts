import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: process.env.CARDARTS_API_TARGET || 'http://127.0.0.1:8000', changeOrigin: true },
      '/game-icons': { target: process.env.CARDARTS_API_TARGET || 'http://127.0.0.1:8000', changeOrigin: true },
    },
  },
  worker: { format: 'es' },
  build: { outDir: 'dist', chunkSizeWarningLimit: 1600 },
});
