import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Built to static assets that apps/api serves (D-026). `pnpm dev` proxies API calls to the API on :8080.
const api = process.env.GETWORKDONE_API_URL || 'http://localhost:8080';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { '/api': api, '/auth': api, '/healthz': api },
  },
});
