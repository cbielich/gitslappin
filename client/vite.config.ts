import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const target = 'http://127.0.0.1:4417';
const version = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  // Fonts must be real files (the CSP has font-src 'self', no data:).
  build: { assetsInlineLimit: 0 },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target,
        changeOrigin: true,
        configure: (proxy) => {
          // The server only accepts its own origin; rewrite the dev origin.
          proxy.on('proxyReq', (req) => req.setHeader('origin', target));
        },
      },
    },
  },
});
