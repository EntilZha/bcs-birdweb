import type { CollectionEntry } from "astro:content";

export type Species = CollectionEntry<"species">;
export type SpeciesData = Species["data"];

/**
 * What to call a bird.
 *
 * The accounts were written against ~2005 AOU taxonomy and are preserved verbatim, but
 * several names have since changed (Gray Jay is now Canada Jay; Thayer's Gull is now a
 * subspecies of Iceland Gull). Where scripts/map_taxonomy.py has resolved a current name
 * we lead with it and keep the historic one visible, because someone who learned the old
 * name needs to recognize the page they landed on.
 */
export function displayName(data: SpeciesData): string {
  // An absorbed account keeps its published name: a lump can leave two accounts pointing
  // at one modern species, and titling both "American Crow" tells the reader nothing.
  if (data.taxonomy?.display_historic) return data.common_name;
  return data.taxonomy?.current_common_name || data.common_name;
}

/** The legacy name, only when it actually differs from what we display. */
export function historicName(data: SpeciesData): string | null {
  const current = data.taxonomy?.current_common_name;
  if (!current || current === data.common_name) return null;
  // Already shown as the title; the note carries the explanation instead.
  if (data.taxonomy?.display_historic) return null;
  return data.common_name;
}

export function scientificName(data: SpeciesData): string {
  return data.taxonomy?.current_scientific_name || data.scientific_name;
}

/**
 * Sort key for taxonomic order. Falls back to the family name then the common name for
 * species the Clements match could not resolve, so the list is always fully ordered
 * rather than clumping unmatched species at one end.
 */
export function taxonomicSort(a: SpeciesData, b: SpeciesData): number {
  const ax = a.taxonomy?.clements_sort;
  const bx = b.taxonomy?.clements_sort;
  if (ax != null && bx != null && ax !== bx) return ax - bx;
  if (ax != null && bx == null) return -1;
  if (ax == null && bx != null) return 1;
  return (
    a.family.name.localeCompare(b.family.name) ||
    displayName(a).localeCompare(displayName(b))
  );
}

export function alphabeticalSort(a: SpeciesData, b: SpeciesData): number {
  return displayName(a).localeCompare(displayName(b));
}

/** Every name this species should be findable by, for the search index. */
export function searchAliases(data: SpeciesData): string[] {
  return [
    displayName(data),
    data.common_name,
    data.scientific_name,
    data.taxonomy?.current_scientific_name,
    data.family.name,
    data.order.name,
  ].filter((value): value is string => Boolean(value));
}

/** Section headings, in the order the accounts were written to be read. */
export const SECTION_LABELS: Array<[keyof SpeciesData["sections"], string]> = [
  ["general_description", "General Description"],
  ["habitat", "Habitat"],
  ["behavior", "Behavior"],
  ["diet", "Diet"],
  ["nesting", "Nesting"],
  ["migration_status", "Migration Status"],
  ["conservation_status", "Conservation Status"],
  ["when_where_wa", "When and Where to Find in Washington"],
];
