/**
 * Boundary geometry, from the network or from the page itself.
 *
 * The served build fetches the Census cartographic files from /geo. A self-contained build
 * has no /geo to fetch from, so the same geometry is embedded in the page and this module
 * hides the difference from the map.
 */
import { IS_STATIC } from './api';

const cache = new Map<string, unknown>();

export async function loadGeo(layer: 'states' | 'counties'): Promise<any> {
  const hit = cache.get(layer);
  if (hit) return hit;

  let data: any;
  if (IS_STATIC) {
    const el = document.getElementById(`nledp-geo-${layer}`);
    if (!el?.textContent) {
      // Counties are omitted from the self-contained build: 1.5 MB of geometry for one
      // optional layer. The map reports the layer as unavailable rather than drawing
      // nothing and leaving the user to wonder.
      throw new Error(`The ${layer} layer is not included in this self-contained build.`);
    }
    data = JSON.parse(el.textContent);
  } else {
    data = await fetch(`/geo/${layer}.geojson`).then((r) => r.json());
  }
  cache.set(layer, data);
  return data;
}
