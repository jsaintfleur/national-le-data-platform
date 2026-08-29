import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * MapLibre loads its worker at runtime via `new URL('./maplibre-gl-worker.mjs',
 * import.meta.url)` from inside the dependency. The bundler rewrites the import.meta.url
 * base to /assets/ but does not emit the worker itself, so the map silently renders an empty
 * canvas: the style loads, the legend draws, and no geometry ever appears. Copying the
 * worker and its shared chunk into the output directory is the fix; without it the map's
 * failure mode is invisible, which is the worst kind.
 */
function maplibreWorker(): Plugin {
  const files = ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs'];
  const from = (f: string) => resolve(__dirname, 'node_modules/maplibre-gl/dist', f);
  return {
    name: 'nledp:maplibre-worker',
    apply: 'build',
    closeBundle() {
      const outDir = resolve(__dirname, 'dist/assets');
      mkdirSync(outDir, { recursive: true });
      for (const f of files) {
        if (existsSync(from(f))) copyFileSync(from(f), resolve(outDir, f));
      }
    },
    configureServer(server) {
      // The dev server resolves the same paths from node_modules.
      server.middlewares.use((req, res, next) => {
        const match = files.find((f) => req.url?.endsWith(`/assets/${f}`));
        if (!match) return next();
        res.setHeader('Content-Type', 'text/javascript');
        res.end(readFileSync(from(match)));
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), maplibreWorker()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    // The API runs alongside the dev server; the frontend calls same-origin /api paths so
    // there is one deployment story in development and production.
    proxy: { '/api': { target: 'http://127.0.0.1:8000', changeOrigin: true } },
  },
  preview: {
    host: '127.0.0.1', port: 4173,
    proxy: { '/api': { target: 'http://127.0.0.1:8000', changeOrigin: true } },
  },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 1100 },
});
