import type { CollectionEntry } from "astro:content";
import { displayName, historicName, scientificName } from "./species";

/**
 * The client-side search index.
 *
 * Kept deliberately small -- name, scientific name, family and one alias line per record
 * -- because the whole thing ships in the page bundle. At ~560 records that is well under
 * 100KB, which is the price of search that works instantly and offline on a shop display
 * with unreliable wifi.
 */
export interface SearchEntry {
  /** URL path relative to BASE_URL. */
  href: string;
  kind: "species" | "site";
  name: string;
  /** Scientific name for a bird, ecoregion for a site. */
  sub: string;
  /** Family name, or the site's ecoregions. */
  group: string;
  /**
   * Other names this record should match: the pre-2005 common name, the historic
   * scientific name. Someone who learned "Gray Jay" must still find Canada Jay.
   */
  aliases: string[];
}

export function buildSearchIndex(
  species: CollectionEntry<"species">[],
  sites: CollectionEntry<"sites">[],
): SearchEntry[] {
  const entries: SearchEntry[] = species.map((entry) => {
    const data = entry.data;
    const historic = historicName(data);
    return {
      href: `birds/${entry.id}/`,
      kind: "species" as const,
      name: displayName(data),
      sub: scientificName(data),
      group: data.family.name,
      aliases: [
        historic,
        historic ? `formerly ${historic}` : null,
        data.scientific_name !== scientificName(data) ? data.scientific_name : null,
        data.order.name,
      ].filter((v): v is string => Boolean(v)),
    };
  });

  for (const entry of sites) {
    entries.push({
      href: `sites/${entry.id}/`,
      kind: "site",
      name: entry.data.name,
      sub: "Birding site",
      group: entry.data.ecoregions.join(", ").replace(/_/g, " "),
      aliases: [],
    });
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}
