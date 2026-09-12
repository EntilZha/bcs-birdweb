import outline from "../data/washington-outline.json";

/**
 * Projection for the Washington locator map.
 *
 * Deliberately not a tile map. A slippy map would mean a runtime dependency on a third
 * party for every page view -- an API key to manage, a service that can rate-limit the
 * storefront display, and nothing to show when the shop wifi drops. The whole state fits
 * in one small SVG, so the map ships as markup: no JavaScript, no network, no key, and it
 * prints.
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

export function project(lon: number, lat: number): { x: number; y: number } {
  const x = ((lon - WA_BOUNDS.west) * Math.cos(MID_LAT_RAD) * VIEW_WIDTH) / LON_SPAN;
  // SVG y grows downward; latitude grows upward.
  const y = ((WA_BOUNDS.north - lat) * VIEW_HEIGHT) / LAT_SPAN;
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
