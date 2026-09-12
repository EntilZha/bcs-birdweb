import { ECOREGION_SLUGS, type EcoregionSlug } from "../config/ecoregions";

export interface WhatsAroundState {
  ecoregion: EcoregionSlug;
  /** 0-indexed internally; 1-indexed in the URL, because that is what a reader expects. */
  month: number;
  minRank: number;
}

/**
 * Read the /whats-around/ filter state out of a query string.
 *
 * Every value is validated against its real domain rather than trusted, because these
 * parameters arrive from whatever someone pasted into a chat. An out-of-range month would
 * index past the end of an abundance row and quietly report a species as absent
 * everywhere; an unknown region would do the same. Anything unparseable falls back to the
 * caller's default instead of throwing, so a mangled link still shows a usable page.
 */
export function parseWhatsAroundUrl(
  search: string,
  fallback: WhatsAroundState,
): WhatsAroundState {
  const params = new URLSearchParams(search);
  const out = { ...fallback };

  const region = params.get("region");
  if (region && (ECOREGION_SLUGS as readonly string[]).includes(region)) {
    out.ecoregion = region as EcoregionSlug;
  }

  const month = Number(params.get("month"));
  if (Number.isInteger(month) && month >= 1 && month <= 12) {
    out.month = month - 1;
  }

  const min = Number(params.get("min"));
  if (Number.isInteger(min) && min >= 1 && min <= 5) {
    out.minRank = min;
  }

  return out;
}

/** The query string for a given state. Kept next to the parser so the two cannot drift. */
export function whatsAroundQuery(state: WhatsAroundState): string {
  const params = new URLSearchParams();
  params.set("region", state.ecoregion);
  params.set("month", String(state.month + 1));
  if (state.minRank > 1) params.set("min", String(state.minRank));
  return params.toString();
}
