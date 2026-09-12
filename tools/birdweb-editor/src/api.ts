/** Typed client for the Vite plugin's /api routes. */

export type Collection = "species" | "sites" | "ecoregions";

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

  clearBackups: () =>
    json<{ removed: number }>("/api/backups", { method: "DELETE" }).then((r) => r.removed),
};

/** Thumbnail URL for an asset path relative to src/assets/. */
export const assetUrl = (relative: string, width = 400) =>
  `/assets/${relative.split("/").map(encodeURIComponent).join("/")}?w=${width}`;
