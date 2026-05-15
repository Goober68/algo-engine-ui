import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Pure react-only dev server. Historical files (.viz.json + .events.jsonl)
// and strategy-visualizer/playground.html used to be served by custom
// vite middlewares here; both are now coord responsibilities:
//   - historical files: GET {coord}/historical-files[/{name}]
//                       (coord/main.py:1082, configured by coord's
//                        historical_dir setting, scoped per active coord)
//   - playground iframe: replaced by native React playground at
//                        src/routes/LabPlayground.jsx
// History: see git log for the deleted middleware shape if a future
// dev-only file-serving need recurs.

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Bind 0.0.0.0 so other machines on the LAN can hit it. Trade
    // exposure: dev server has no auth -- keep this LAN-only behind
    // your firewall, never port-forward.
    host: true,
    // Serve fixture JSON folders as static assets at /fixtures/* so
    // MockDataProvider can fetch() them directly during dev.
    fs: { allow: ['..', '.'] },
  },
  publicDir: 'fixtures',
});
