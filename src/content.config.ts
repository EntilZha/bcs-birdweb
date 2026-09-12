import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import {
  ecoregionSchema,
  familySchema,
  orderSchema,
  siteSchema,
  speciesSchema,
} from "./content.schemas";

/**
 * Astro collections over src/content/. The schemas themselves live in content.schemas.ts
 * so tools/birdweb-editor can import and enforce the same contract when it saves.
 *
 * These are written out one by one rather than through a helper: a helper that takes the
 * schema as a parameter widens it to Astro's generic `BaseSchema`, and every `entry.data`
 * in the codebase silently becomes `any`.
 */
export const collections = {
  species: defineCollection({
    loader: glob({ pattern: "**/*.yaml", base: "./src/content/species" }),
    schema: speciesSchema,
  }),
  sites: defineCollection({
    loader: glob({ pattern: "**/*.yaml", base: "./src/content/sites" }),
    schema: siteSchema,
  }),
  ecoregions: defineCollection({
    loader: glob({ pattern: "**/*.yaml", base: "./src/content/ecoregions" }),
    schema: ecoregionSchema,
  }),
  families: defineCollection({
    loader: glob({ pattern: "**/*.yaml", base: "./src/content/families" }),
    schema: familySchema,
  }),
  orders: defineCollection({
    loader: glob({ pattern: "**/*.yaml", base: "./src/content/orders" }),
    schema: orderSchema,
  }),
};
