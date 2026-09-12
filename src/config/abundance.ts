/**
 * The abundance scale BirdWeb has used since 2005, verbatim from its own code-definition
 * page. An empty string means the species is not recorded in that ecoregion that month —
 * which is data, not a gap, and is why "absent" is a rung on the scale rather than a null.
 */
export const ABUNDANCE_CODES = ["C", "F", "U", "R", "I", ""] as const;
export type AbundanceCode = (typeof ABUNDANCE_CODES)[number];

export interface AbundanceLevel {
  code: AbundanceCode;
  label: string;
  /** How to read it, in the site's own words. */
  description: string;
  /** Ordinal for sorting and heat-mapping. Higher = more likely to be seen. */
  rank: number;
  /** Tailwind class driven by the --color-abundance-* theme tokens. */
  swatch: string;
  /** Text colour that clears 4.5:1 on that swatch. */
  ink: string;
}

export const ABUNDANCE: Record<AbundanceCode, AbundanceLevel> = {
  C: {
    code: "C",
    label: "Common",
    description: "Found in moderate to large numbers, and easily found in suitable habitat.",
    rank: 5,
    swatch: "bg-abundance-c",
    ink: "text-white",
  },
  F: {
    code: "F",
    label: "Fairly common",
    description: "Found in small to moderate numbers, and usually easy to find.",
    rank: 4,
    swatch: "bg-abundance-f",
    ink: "text-white",
  },
  U: {
    code: "U",
    label: "Uncommon",
    description: "Present but not certain to be seen, even in suitable habitat.",
    rank: 3,
    swatch: "bg-abundance-u",
    ink: "text-brand",
  },
  R: {
    code: "R",
    label: "Rare",
    description: "Occurs annually in very small numbers; not to be expected on any given day.",
    rank: 2,
    swatch: "bg-abundance-r",
    ink: "text-brand",
  },
  I: {
    code: "I",
    label: "Irregular",
    description: "Numbers vary widely from year to year; may be absent entirely in some years.",
    rank: 1,
    swatch: "bg-abundance-i",
    ink: "text-brand",
  },
  "": {
    code: "",
    label: "Not recorded",
    description: "Not recorded in this ecoregion during this month.",
    rank: 0,
    swatch: "bg-abundance-none",
    ink: "text-black/35",
  },
};

export const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

export const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;
