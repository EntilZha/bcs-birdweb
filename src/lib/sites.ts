import { withinWashington } from "./project";

export interface MappableLike {
  id: string;
  data: {
    name: string;
    lat: number | null;
    lon: number | null;
    geocode_source: string | null;
  };
}

/** How much a pin is trusted. Drives how it is drawn and what the caption claims. */
export type PinConfidence = "confirmed" | "approximate";

export interface Pin<T> {
  site: T;
  lat: number;
  lon: number;
  confidence: PinConfidence;
}

/**
 * Which sites go on the map, and how much each pin claims.
 *
 * The legacy pages carry no coordinates, so every one is either a geocoder's candidate or
 * a hand-placed pin. The first version of this refused anything but `confirmed`, reasoning
 * that a wrong pin sends someone to the wrong place. That is right for a navigation map
 * and wrong for this one: the whole state renders in ~1000 units, so a marker covers about
 * 8km and says only "this part of Washington", and every site page carries the original
 * directions prose that people actually navigate by. Refusing to draw anything left the
 * map empty for months, which helps nobody.
 *
 * So a scored candidate is drawn, but never as though someone had checked it -- hollow and
 * dashed against a solid marker, and the caption says so. Confirming one in the editor
 * promotes it. A coordinate outside Washington is still dropped whatever its source: that
 * is a transposed sign or a bad paste, not an approximation.
 */
export function mappableSites<T extends MappableLike>(sites: readonly T[]): Pin<T>[] {
  const pins: Pin<T>[] = [];
  for (const site of sites) {
    const { lat, lon, geocode_source } = site.data;
    if (lat == null || lon == null) continue;
    if (!withinWashington(lat, lon)) continue;
    // Anything that is not an explicit confirmation is treated as approximate, rather than
    // listing the source strings that are -- a value invented later must not arrive
    // claiming more confidence than it has earned.
    const confidence: PinConfidence =
      geocode_source === "confirmed" ? "confirmed" : "approximate";
    pins.push({ site, lat, lon, confidence });
  }
  return pins;
}

/** Sites with no usable coordinate at all — nobody has placed them yet. */
export function awaitingPin<T extends MappableLike>(sites: readonly T[]): T[] {
  const mapped = new Set(mappableSites(sites).map((p) => p.site.id));
  return sites.filter((s) => !mapped.has(s.id));
}

export function countByConfidence<T extends MappableLike>(sites: readonly T[]) {
  const pins = mappableSites(sites);
  return {
    confirmed: pins.filter((p) => p.confidence === "confirmed").length,
    approximate: pins.filter((p) => p.confidence === "approximate").length,
    unplaced: awaitingPin(sites).length,
  };
}
