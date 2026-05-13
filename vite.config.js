import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readdir, stat, readFile } from 'node:fs/promises';
import path from 'node:path';

// Where to look for .viz.json + .events.jsonl files when the
// Historical tab asks the server for a listing. Override with
// VITE_HISTORICAL_DIR=/absolute/path/to/dir in .env.local. Default
// points at the sibling algo-backtester clone's data/local/ so a
// fresh checkout "just works" for the existing viz output.
const HISTORICAL_DIR = process.env.VITE_HISTORICAL_DIR
  || path.resolve('../algo-backtester/data/local');

// Strategy-visualizer's playground.html is iframed by the Historical
// Playground route. Resolved from the sibling clone; override with
// VITE_PLAYGROUND_HTML=/absolute/path/playground.html in .env.local if
// you cloned elsewhere.
const PLAYGROUND_HTML = process.env.VITE_PLAYGROUND_HTML
  || path.resolve('../strategy-visualizer/playground.html');

// Strategy schemas are served by algo-coord (VITE_ALGO_COORD_URL +
// /strategy-schema/{strategy}), NOT by this dev server, so the same
// fetch path works in built/prod deploys too. See coord/main.py.

function isHistoricalFile(name) {
  const n = name.toLowerCase();
  return n.endsWith('.viz.json') || n.endsWith('.events.jsonl');
}

export default defineConfig({
  plugins: [
    react(),
    {
      // Custom middleware: list + stream historical replay files
      // from a server-side directory. Used by Historical route's
      // "Pick from server" UI so the user doesn't have to drag a
      // file across machines.
      name: 'historical-files',
      configureServer(server) {
        // /api/playground.html — serves strategy-visualizer/playground.html
        // so the Historical Playground route can iframe it from the
        // engine-ui's own origin (avoids cross-origin issues; no
        // separate server needed).
        server.middlewares.use('/api/playground.html', async (req, res, next) => {
          if (req.method !== 'GET') return next();
          try {
            const data = await readFile(PLAYGROUND_HTML);
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
            res.end(data);
          } catch (e) {
            res.statusCode = 404;
            res.setHeader('Content-Type', 'text/plain');
            res.end(`playground.html not found at ${PLAYGROUND_HTML}\n${e.message}`);
          }
        });

        server.middlewares.use('/api/historical-files', async (req, res, next) => {
          if (req.method !== 'GET') return next();
          const u = new URL(req.url, 'http://x');
          const file = u.searchParams.get('file');
          try {
            if (!file) {
              // Directory listing
              const names = await readdir(HISTORICAL_DIR);
              const entries = [];
              for (const name of names) {
                if (!isHistoricalFile(name)) continue;
                const st = await stat(path.join(HISTORICAL_DIR, name));
                entries.push({ name, size: st.size, mtime: st.mtimeMs });
              }
              entries.sort((a, b) => b.mtime - a.mtime);
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ dir: HISTORICAL_DIR, entries }));
              return;
            }
            // Single-file stream. Defensive path-join: refuse anything
            // that escapes HISTORICAL_DIR (e.g. ?file=../../secrets).
            if (!isHistoricalFile(file)) {
              res.statusCode = 400;
              res.end('not a historical file');
              return;
            }
            const target = path.resolve(HISTORICAL_DIR, file);
            if (!target.startsWith(path.resolve(HISTORICAL_DIR) + path.sep)) {
              res.statusCode = 400;
              res.end('path escape');
              return;
            }
            const data = await readFile(target);
            const ct = file.endsWith('.jsonl')
              ? 'application/x-ndjson'
              : 'application/json';
            res.setHeader('Content-Type', ct);
            res.setHeader('Cache-Control', 'no-store');
            res.end(data);
          } catch (e) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: e.message, dir: HISTORICAL_DIR }));
          }
        });
      },
    },
  ],
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
