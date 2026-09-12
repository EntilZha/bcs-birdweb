/**
 * Washington's ten ecoregions, in the order the legacy BirdWeb abundance tables used.
 *
 * The order is not alphabetical and not arbitrary: it runs roughly west to east, ocean to
 * Columbia Plateau, which is how Washington birders describe the state. Every abundance
 * array in src/content/species is indexed by this order, so it is load-bearing — changing
 * it silently reassigns ~59,000 data cells to the wrong regions.
 *
 * Declared as a `const` tuple rather than derived from the objects below, because zod's
 * `z.enum` needs a literal tuple to produce a union type.
 */
export const ECOREGION_SLUGS = [
  "oceanic",
  "pacific_northwest_coast",
  "puget_trough",
  "north_cascades",
  "west_cascades",
  "east_cascades",
  "okanogan",
  "canadian_rockies",
  "blue_mountains",
  "columbia_plateau",
] as const;

export type EcoregionSlug = (typeof ECOREGION_SLUGS)[number];

const NAMES: Record<EcoregionSlug, string> = {
  oceanic: "Oceanic",
  pacific_northwest_coast: "Pacific Northwest Coast",
  puget_trough: "Puget Trough",
  north_cascades: "North Cascades",
  west_cascades: "West Cascades",
  east_cascades: "East Cascades",
  okanogan: "Okanogan",
  canadian_rockies: "Canadian Rockies",
  blue_mountains: "Blue Mountains",
  columbia_plateau: "Columbia Plateau",
};

export const ECOREGIONS: ReadonlyArray<{ slug: EcoregionSlug; name: string }> =
  ECOREGION_SLUGS.map((slug) => ({ slug, name: NAMES[slug] }));

export const ECOREGION_NAME: Record<string, string> = NAMES;

/** The legacy site numbered ecoregions 1-10 in this same order; site URLs used the id. */
export const ECOREGION_ID: Record<EcoregionSlug, number> = Object.fromEntries(
  ECOREGION_SLUGS.map((slug, i) => [slug, i + 1]),
) as Record<EcoregionSlug, number>;
