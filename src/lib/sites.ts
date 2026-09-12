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

/**
 * The one rule about coordinates: a pin is plotted only if a person confirmed it.
 *
 * The legacy pages carry no coordinates, so every one is either a geocoder's guess or a
 * hand-placed pin. Putting a guess on a map tells a reader "the birds are here", and if it
 * is wrong they drive to the wrong place -- the geocoder's first version proposed an
 * apartment building for Samish Flats. So this is a positive test for `confirmed` rather
 * than a blocklist of known-bad sources: a new source string added later cannot leak
 * through by being unlisted.
 *
 * Lives in src/lib rather than inside the map component so the guarantee can be tested.
 */
export function mappableSites<T extends MappableLike>(sites: readonly T[]): T[] {
  return sites.filter(
    (site) =>
      site.data.geocode_source === "confirmed" &&
      site.data.lat != null &&
      site.data.lon != null &&
      withinWashington(site.data.lat, site.data.lon),
  );
}

/** Sites still waiting for someone to place or confirm a pin. */
export function awaitingPin<T extends MappableLike>(sites: readonly T[]): T[] {
  const mapped = new Set(mappableSites(sites).map((s) => s.id));
  return sites.filter((s) => !mapped.has(s.id));
}
