import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The UI is served same-origin by the Fastify server in production; in dev Vite proxies /api to the server (port 3004).
 * Set API_TARGET to use another one, e.g. the sample-data mock on http://127.0.0.1:4318 (`pnpm demo` does).
 */
const apiTarget = process.env.API_TARGET ?? 'http://127.0.0.1:3004';

export default defineConfig({
  root: 'web',
  base: './',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: { '/api': { target: apiTarget, changeOrigin: false } },
  },
  preview: { port: 4173, host: '127.0.0.1', proxy: { '/api': { target: apiTarget, changeOrigin: false } } },
});
