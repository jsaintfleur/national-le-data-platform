/**
 * Point MapLibre at a worker that exists inside this page.
 *
 * MapLibre derives its worker URL from `import.meta.url` and fetches a sibling
 * `maplibre-gl-worker.mjs`. In the served build that file is emitted next to the bundle; in a
 * self-contained page there is no sibling to fetch, the request 404s, and the map renders an
 * empty canvas with no error — the same silent failure the served build hit before the
 * worker was copied into the output.
 *
 * So the worker is bundled into a standalone script at build time, embedded in the page, and
 * handed to MapLibre as a blob URL.
 */
import * as maplibregl from 'maplibre-gl';
import { IS_STATIC } from './api';

let configured = false;

export function configureMapWorker(): void {
  if (configured || !IS_STATIC) return;
  configured = true;
  const el = document.getElementById('nledp-map-worker');
  if (!el?.textContent) return;
  const blob = new Blob([el.textContent], { type: 'text/javascript' });
  (maplibregl as any).setWorkerUrl(URL.createObjectURL(blob));
}
