import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Bind 0.0.0.0 so other machines on the LAN can hit it. Trade
    // exposure: dev server has no auth — keep this LAN-only behind
    // your firewall, never port-forward.
    host: true,
    // Serve fixture JSON folders as static assets at /fixtures/* so
    // MockDataProvider can fetch() them directly during dev.
    fs: { allow: ['..', '.'] },
  },
  publicDir: 'fixtures',
});
