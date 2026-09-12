/** Typed client for the Vite plugin's /api routes. */

export type Collection = "species" | "sites" | "ecoregions";

/** One entry in src/config/taxonomy-overrides.yaml. */
export interface TaxonomyOverride {
  birdweb_common_name?: string | null;
  birdweb_scientific_name?: string | null;
  why?: string | null;
  suggested_ebird_code?: string | null;
  suggested_common_name?: string | null;
  ebird_code?: string | null;
  current_common_name?: string | null;
  current_scientific_name?: string | null;
  clements_sort?: number | null;
  display_historic?: boolean;
  note?: string | null;
}

export interface Credit {
  name: string;
  count: number;
  urls: string[];
  /** Up to 40 record ids that carry this credit, for spot-checking a rename. */
  where: string[];
}

export interface IndexRecord {
  slug: string;
  name: string;
  scientific: string | null;
  family: string | null;
  photoCount: number;
  hasAbundance: boolean;
  needsGeocode: boolean;
}

export interface SaveResult {
  ok?: boolean;
  saved?: string;
  error?: string;
  issues?: Array<{ path: string; message: string }>;
}

async function json<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const body = await response.json();
  if (!response.ok && !body.issues) throw new Error(body.error || response.statusText);
  return body as T;
}

export const api = {
  list: (collection: Collection) =>
    json<{ records: IndexRecord[] }>(`/api/${collection}`).then((r) => r.records),

  get: <T = Record<string, unknown>>(collection: Collection, slug: string) =>
    json<{ data: T }>(`/api/${collection}/${encodeURIComponent(slug)}`).then((r) => r.data),

  save: (collection: Collection, slug: string, data: unknown) =>
    json<SaveResult>(`/api/${collection}/${encodeURIComponent(slug)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data }),
    }),

  status: () =>
    json<{ vcs: string | null; changed: string[]; remote: string | null }>("/api/status"),

  publish: (message: string, push: boolean) =>
    json<{
      ok?: boolean;
      pushed?: boolean;
      error?: string;
      steps?: Array<{ step: string; output: string }>;
    }>("/api/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, push }),
    }),

  backups: () => json<{ backups: string[] }>("/api/backups").then((r) => r.backups),

  taxonomyOverrides: () =>
    json<{ species: Record<string, TaxonomyOverride>; header: string }>(
      "/api/taxonomy-overrides",
    ),

  saveTaxonomyOverrides: (species: Record<string, TaxonomyOverride>, header: string) =>
    json<{ ok?: boolean; error?: string }>("/api/taxonomy-overrides", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ species, header }),
    }),

  credits: () => json<{ credits: Credit[] }>("/api/credits").then((r) => r.credits),

  renameCredit: (from: string, to: string, url?: string | null) =>
    json<{ ok?: boolean; photos?: number; records?: number; error?: string }>(
      "/api/credits/rename",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from, to, url }),
      },
    ),

  clearBackups: () =>
    json<{ removed: number }>("/api/backups", { method: "DELETE" }).then((r) => r.removed),
};

/** Thumbnail URL for an asset path relative to src/assets/. */
export const assetUrl = (relative: string, width = 400) =>
  `/assets/${relative.split("/").map(encodeURIComponent).join("/")}?w=${width}`;
