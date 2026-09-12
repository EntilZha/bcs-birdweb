import {
  ABUNDANCE,
  type AbundanceCode,
  MONTHS,
} from "../config/abundance";
import { ECOREGION_SLUGS, type EcoregionSlug } from "../config/ecoregions";

/** Abundance for one species: ecoregion slug -> twelve monthly codes. */
export type AbundanceMatrix = Record<string, AbundanceCode[]>;

export interface SpeciesLike {
  slug: string;
  common_name: string;
  abundance: AbundanceMatrix;
}

/** Month index, 0 = January. Kept as a branded-ish alias so call sites read clearly. */
export type MonthIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;

export function codeAt(
  matrix: AbundanceMatrix,
  ecoregion: EcoregionSlug,
  month: MonthIndex,
): AbundanceCode {
  return matrix[ecoregion]?.[month] ?? "";
}

export function rankAt(
  matrix: AbundanceMatrix,
  ecoregion: EcoregionSlug,
  month: MonthIndex,
): number {
  return ABUNDANCE[codeAt(matrix, ecoregion, month)].rank;
}

/** True if the species is recorded anywhere in the state in any month. */
export function isRecordedAnywhere(matrix: AbundanceMatrix): boolean {
  return ECOREGION_SLUGS.some((slug) => (matrix[slug] ?? []).some((code) => code !== ""));
}

/** The ecoregions where this species is recorded at all, in canonical order. */
export function ecoregionsPresent(matrix: AbundanceMatrix): EcoregionSlug[] {
  return ECOREGION_SLUGS.filter((slug) => (matrix[slug] ?? []).some((c) => c !== ""));
}

/** The single best code this species reaches in a given ecoregion across the year. */
export function peakInEcoregion(
  matrix: AbundanceMatrix,
  ecoregion: EcoregionSlug,
): AbundanceCode {
  const codes = matrix[ecoregion] ?? [];
  let best: AbundanceCode = "";
  for (const code of codes) {
    if (ABUNDANCE[code].rank > ABUNDANCE[best].rank) best = code;
  }
  return best;
}

/**
 * Summarize when a species is present in an ecoregion as human-readable month ranges.
 *
 * Wraps across the year end, because a bird present Nov-Feb should read "November to
 * February", not "January to February and November to December" — that is the whole point
 * of saying it in words rather than showing the grid again.
 */
export function seasonSummary(
  matrix: AbundanceMatrix,
  ecoregion: EcoregionSlug,
): string {
  const codes = matrix[ecoregion] ?? [];
  const present = codes.map((c) => c !== "");
  if (present.every((p) => !p)) return "Not recorded";
  if (present.every((p) => p)) return "Year-round";

  // Rotate so a run never starts mid-wrap, then read off contiguous runs.
  const start = present.findIndex((p, i) => p && !present[(i + 11) % 12]);
  const runs: Array<[number, number]> = [];
  let i = 0;
  while (i < 12) {
    const m = (start + i) % 12;
    if (!present[m]) {
      i++;
      continue;
    }
    let len = 0;
    while (len < 12 && present[(start + i + len) % 12]) len++;
    runs.push([m, (start + i + len - 1) % 12]);
    i += len;
  }

  return runs
    .map(([a, b]) => (a === b ? MONTHS[a] : `${MONTHS[a]}–${MONTHS[b]}`))
    .join(", ");
}

/**
 * Invert the per-species matrices: what is around in one ecoregion in one month.
 * This is what powers /whats-around/ — the dataset the legacy site buried in a table.
 */
export function speciesPresentIn<T extends SpeciesLike>(
  species: readonly T[],
  ecoregion: EcoregionSlug,
  month: MonthIndex,
  minRank = 1,
): Array<T & { code: AbundanceCode }> {
  return species
    .map((s) => ({ ...s, code: codeAt(s.abundance, ecoregion, month) }))
    .filter((s) => ABUNDANCE[s.code].rank >= minRank)
    .sort(
      (a, b) =>
        ABUNDANCE[b.code].rank - ABUNDANCE[a.code].rank ||
        a.common_name.localeCompare(b.common_name),
    );
}
