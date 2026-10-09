// The route map on the hunt designer at /designer (issue #61): a draft's
// area, its checkpoints and the loop through them, drawn with Leaflet over
// OpenStreetMap's standard tiles. What it draws is worked out in
// designer-logic.js (routeMap); this file only hands it to Leaflet.
//
// Leaflet is served by this app at /vendor/leaflet/, not from a CDN, and is
// loaded by a classic <script> before designer.js, as the global `L`. When
// it didn't load there's no map, and the page works without one.
//
// The coordinates are the answers to the clues: they're drawn on the map and
// nowhere else. Tiles are asked for by area and zoom, and with only this
// app's origin as the referrer, never the page's address.

const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors';
/** OpenStreetMap's standard tiles go no closer than this. */
const MAX_ZOOM = 19;
/** Fitting the view never zooms in closer than this, even on one place. */
const FIT_MAX_ZOOM = 17;
const MARKER_SIZE = 32;

/**
 * @typedef {NonNullable<ReturnType<typeof import('./designer-logic.js').routeMap>>} RouteView
 * @typedef {{
 *   draw(view: RouteView, fit: boolean): void,
 *   clear(): void,
 *   has(position: number): boolean,
 *   focus(position: number): boolean,
 * }} RouteMap
 */

/**
 * @param {string} text
 * @returns {HTMLElement} a span holding the text as text, never as HTML
 */
function textNode(text) {
  const span = document.createElement('span');
  span.textContent = text;
  return span;
}

/**
 * Makes the map in `container`, which must be on screen.
 *
 * @param {HTMLElement} container
 * @param {{
 *   onSelect: (position: number) => void,
 *   onTiles: (loaded: boolean) => void,
 * }} handlers `onSelect` when a marker is tapped; `onTiles(false)` when a
 *   tile fails, and `onTiles(true)` once a round of tiles loads without one
 * @returns {RouteMap | null} null when Leaflet didn't load
 */
export function createRouteMap(container, { onSelect, onTiles }) {
  const L = /** @type {any} */ (window).L;
  if (typeof L?.map !== 'function') {
    return null;
  }

  // The scroll wheel zooms only once the map has been clicked or tabbed
  // to, so scrolling down the page doesn't get caught by it. Quarter zoom
  // steps let the view fit the area closely, not just within a whole level.
  const map = L.map(container, { scrollWheelZoom: false, zoomSnap: 0.25 });
  map.on('focus', () => map.scrollWheelZoom.enable());
  map.on('blur', () => map.scrollWheelZoom.disable());

  const tiles = L.tileLayer(TILE_URL, {
    maxZoom: MAX_ZOOM,
    attribution: ATTRIBUTION,
    // The page itself sends no referrer (its address holds a draft's id);
    // OpenStreetMap's tile servers want one, so the tiles send the origin.
    referrerPolicy: 'strict-origin',
  }).addTo(map);
  let failed = 0;
  tiles.on('loading', () => {
    failed = 0;
  });
  tiles.on('tileerror', () => {
    failed += 1;
    onTiles(false);
  });
  tiles.on('load', () => onTiles(failed === 0));

  const layers = L.layerGroup().addTo(map);
  /** @type {Map<number, any>} */
  const markers = new Map();

  return {
    draw(view, fit) {
      layers.clearLayers();
      markers.clear();
      if (view.box) {
        const { south, west, north, east } = view.box;
        L.rectangle(
          [
            [south, west],
            [north, east],
          ],
          { className: 'route-area', color: '#312e81', weight: 2, dashArray: '6 6', fill: false, interactive: false },
        ).addTo(layers);
      }
      if (view.loop.length > 0) {
        L.polyline(view.loop, { className: 'route-loop', color: '#4f46e5', weight: 4, opacity: 0.9, interactive: false }).addTo(
          layers,
        );
      }
      for (const point of view.markers) {
        const marker = L.marker([point.lat, point.long], {
          icon: L.divIcon({
            className: point.className,
            html: textNode(String(point.position)),
            iconSize: [MARKER_SIZE, MARKER_SIZE],
          }),
          title: point.title,
          riseOnHover: true,
        });
        marker.bindTooltip(textNode(point.title), { direction: 'top', offset: [0, -MARKER_SIZE / 2] });
        marker.on('click', () => onSelect(point.position));
        // A button (Leaflet's own role for it) named for its place, not "1".
        // Its element is made once the map has a view: on the first draw,
        // that's after the fit below.
        marker.on('add', () => marker.getElement()?.setAttribute('aria-label', point.title));
        marker.addTo(layers);
        markers.set(point.position, marker);
      }
      // It may have been hidden, or changed size, since it was last drawn.
      map.invalidateSize();
      if (fit && view.bounds) {
        map.fitBounds(view.bounds, { padding: [24, 24], maxZoom: FIT_MAX_ZOOM });
      }
    },

    clear() {
      layers.clearLayers();
      markers.clear();
    },

    has(position) {
      return markers.has(position);
    },

    focus(position) {
      const marker = markers.get(position);
      if (!marker) {
        return false;
      }
      map.panTo(marker.getLatLng());
      marker.openTooltip();
      return true;
    },
  };
}
