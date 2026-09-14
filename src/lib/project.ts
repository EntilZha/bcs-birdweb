import outline from "../data/washington-outline.json";

/**
 * Projection for the Washington locator map.
 *
 * Used for the static locator geometry. The interactive map is Leaflet + OpenStreetMap
 * (see EcoregionLeaflet.tsx); this projection still backs anything that needs to place a
 * coordinate without a tile layer, and its bounds and inset are what keep a pin at the far
 * corner of the state from being clipped.
 *
 * Equirectangular with a cos(latitude) correction on x. At Washington's latitude that is
 * within a couple of percent of Mercator over this small a span, and it keeps the maths
 * simple enough to read.
 */

export const WA_BOUNDS = {
  west: -124.85,
  east: -116.9,
  south: 45.5,
  north: 49.05,
} as const;

/** SVG viewBox, sized so the state roughly fills it at Washington's aspect ratio. */
const MID_LAT_RAD = (((WA_BOUNDS.north + WA_BOUNDS.south) / 2) * Math.PI) / 180;
const LON_SPAN = (WA_BOUNDS.east - WA_BOUNDS.west) * Math.cos(MID_LAT_RAD);
const LAT_SPAN = WA_BOUNDS.north - WA_BOUNDS.south;

export const VIEW_WIDTH = 1000;
export const VIEW_HEIGHT = Math.round((LAT_SPAN / LON_SPAN) * VIEW_WIDTH);

/**
 * Inset, in viewBox units, so the outline is not drawn on the edge of its own box.
 *
 * Washington reaches within two units of the eastern bound, so an un-inset projection puts
 * the border stroke half outside the viewBox and the browser clips it -- the state renders
 * with a missing right-hand edge. A pin dropped at the far corner of the state would clip
 * the same way. 14 units is comfortably more than the widest stroke or marker here.
 */
const PAD = 14;
const INNER_WIDTH = VIEW_WIDTH - PAD * 2;
const INNER_HEIGHT = VIEW_HEIGHT - PAD * 2;

export function project(lon: number, lat: number): { x: number; y: number } {
  const x = PAD + ((lon - WA_BOUNDS.west) * Math.cos(MID_LAT_RAD) * INNER_WIDTH) / LON_SPAN;
  // SVG y grows downward; latitude grows upward.
  const y = PAD + ((WA_BOUNDS.north - lat) * INNER_HEIGHT) / LAT_SPAN;
  return { x, y };
}

/** The state outline as SVG path data. */
export const WASHINGTON_PATH: string = (outline.rings as [number, number][][])
  .map((ring) => {
    const points = ring.map(([lon, lat]) => {
      const { x, y } = project(lon, lat);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    return `M${points.join("L")}Z`;
  })
  .join(" ");

/** True when a coordinate is inside the map's frame — a cheap guard against a bad pin. */
export function withinWashington(lat: number, lon: number): boolean {
  return (
    lat >= WA_BOUNDS.south &&
    lat <= WA_BOUNDS.north &&
    lon >= WA_BOUNDS.west &&
    lon <= WA_BOUNDS.east
  );
}
