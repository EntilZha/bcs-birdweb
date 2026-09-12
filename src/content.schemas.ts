import { z } from "zod";
import { ABUNDANCE_CODES } from "./config/abundance";
import { ECOREGION_SLUGS } from "./config/ecoregions";

/**
 * The schema contract for everything BirdWeb knows.
 *
 * Deliberately free of any `astro:content` import so that it can be loaded from three
 * places at once: Astro's content config validates the site build against it,
 * tools/birdweb-editor imports it into its Vite plugin to validate on save, and
 * scripts/verify_extract.py mirrors it as the QA gate. If a field changes shape, it
 * changes here first.
 */

export const credit = z.object({
  /** Photographer or recordist, exactly as the legacy site credited them. */
  name: z.string(),
  url: z.string().url().nullable().default(null),
});

export const photo = z.object({
  /** Filename under src/assets/, already converted to WebP by scripts/build_images.py. */
  file: z.string(),
  /** The legacy title/alt text, e.g. "Female. Note: orange bill with black spots." */
  caption: z.string().default(""),
  credit,
  /** Exactly one photo per record is the hero. */
  hero: z.boolean().default(false),
});

/**
 * Twelve months of abundance codes for one ecoregion. Fixed length: a short array means
 * cells were dropped, which is a bug rather than sparse data.
 */
const monthlyAbundance = z.array(z.enum(ABUNDANCE_CODES)).length(12);

// The cast keeps the ten ecoregion keys in the inferred type. Without it z.object sees a
// plain index signature and every `abundance[slug].map(...)` downstream becomes `any`.
export const abundance = z.object(
  Object.fromEntries(ECOREGION_SLUGS.map((slug) => [slug, monthlyAbundance])) as Record<
    (typeof ECOREGION_SLUGS)[number],
    typeof monthlyAbundance
  >,
);

export const provenance = z.object({
  /** The legacy URL this record was extracted from. */
  url: z.string().url(),
  /** Crawl date of the archive it came from. */
  archived: z.string(),
});

export const taxonomy = z
  .object({
    ebird_code: z.string().nullable().default(null),
    current_common_name: z.string().nullable().default(null),
    current_scientific_name: z.string().nullable().default(null),
    clements_sort: z.number().nullable().default(null),
    /** Set only when the legacy name differs from the current one. */
    historic_common_name: z.string().nullable().default(null),
    /**
     * Lead with the BirdWeb name instead of the current one. Set for accounts absorbed
     * into a species that has its own account -- without it the site would show two pages
     * titled "American Crow" and two titled "Redpoll".
     */
    display_historic: z.boolean().default(false),
    note: z.string().nullable().default(null),
  })
  .default({});

export const speciesSchema = z.object({
  slug: z.string(),
  common_name: z.string(),
  scientific_name: z.string(),

  order: z.object({ name: z.string(), slug: z.string() }),
  family: z.object({ name: z.string(), slug: z.string() }),

  /**
   * The one-line status, e.g. "Common resident." Empty for the rarity accounts, which
   * were authored separately and carry neither a status line nor an abundance table.
   */
  status: z.string().default(""),
  species_of_concern: z.boolean().default(false),

  /**
   * The BCS-authored accounts, preserved verbatim. Only general_description is guaranteed:
   * the 2005 authors did not fill every section for every species, particularly rarities.
   */
  sections: z.object({
    general_description: z.string(),
    habitat: z.string().optional(),
    behavior: z.string().optional(),
    diet: z.string().optional(),
    nesting: z.string().optional(),
    migration_status: z.string().optional(),
    conservation_status: z.string().optional(),
    when_where_wa: z.string().optional(),
  }),

  photos: z.array(photo).default([]),
  audio: z
    .object({ file: z.string(), credit: credit.nullable().default(null) })
    .nullable()
    .default(null),
  maps: z.object({
    wa: z.string().nullable().default(null),
    north_america: z.string().nullable().default(null),
  }),

  abundance,
  taxonomy,
  source: provenance,
});

export const siteSchema = z.object({
  slug: z.string(),
  name: z.string(),
  /** The map number the legacy ecoregion pages used, e.g. 204 for Marymoor Park. */
  number: z.number().nullable().default(null),
  /**
   * Usually one ecoregion, but five sites genuinely straddle a boundary and the legacy
   * site listed them under both -- Washington Pass and Rainy Pass on the North
   * Cascades/Okanogan line, Naches Peak Loop across the Cascade crest. The first entry is
   * the primary.
   */
  ecoregions: z.array(z.enum(ECOREGION_SLUGS)).min(1),

  sections: z.object({
    site: z.string().optional(),
    birds: z.string().optional(),
    directions: z.string().optional(),
    references: z.string().optional(),
  }),

  photos: z.array(photo).default([]),

  /**
   * Net-new data: the legacy pages carry no coordinates at all. Null until a human has
   * confirmed the pin -- an unconfirmed geocode sends someone to the wrong place, so
   * `geocode_source: "nominatim-unconfirmed"` must never reach the deployed site.
   */
  lat: z.number().nullable().default(null),
  lon: z.number().nullable().default(null),
  county: z.string().nullable().default(null),
  geocode_source: z.string().nullable().default(null),

  source: provenance,
});

export const ecoregionSchema = z.object({
  slug: z.enum(ECOREGION_SLUGS),
  name: z.string(),
  sections: z.record(z.string(), z.string()).default({}),
  map: z.string().nullable().default(null),
  source: provenance,
});

const taxonGroup = {
  slug: z.string(),
  name: z.string(),
  /** e.g. "Ducks, Geese and Swans" -- the legacy index's plain-English label. */
  common_name: z.string().nullable().default(null),
  description: z.string().default(""),
  source: provenance.nullable().default(null),
};

/** The legacy site's standing pages, ported as content rather than hardcoded markup. */
export const pageSchema = z.object({
  slug: z.string(),
  title: z.string(),
  /** Markdown-ish prose: paragraphs, `## headings`, `*em*`, `[links](url)`. */
  body: z.string(),
  source: provenance,
});

export const familySchema = z.object({
  ...taxonGroup,
  order: z.string().nullable().default(null),
});
export const orderSchema = z.object(taxonGroup);

export type Species = z.infer<typeof speciesSchema>;
export type Site = z.infer<typeof siteSchema>;
export type Photo = z.infer<typeof photo>;
