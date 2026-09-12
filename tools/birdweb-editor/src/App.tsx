import { useCallback, useEffect, useMemo, useState } from "react";
import { api, assetUrl, type Collection, type IndexRecord } from "./api";
import { useAutosave, type SaveState } from "./useAutosave";
import AbundanceEditor from "./components/AbundanceEditor";
import MapPicker from "./components/MapPicker";

const ECOREGIONS = [
  { slug: "oceanic", name: "Oceanic" },
  { slug: "pacific_northwest_coast", name: "Pacific Northwest Coast" },
  { slug: "puget_trough", name: "Puget Trough" },
  { slug: "north_cascades", name: "North Cascades" },
  { slug: "west_cascades", name: "West Cascades" },
  { slug: "east_cascades", name: "East Cascades" },
  { slug: "okanogan", name: "Okanogan" },
  { slug: "canadian_rockies", name: "Canadian Rockies" },
  { slug: "blue_mountains", name: "Blue Mountains" },
  { slug: "columbia_plateau", name: "Columbia Plateau" },
] as const;

const SPECIES_SECTIONS: Array<[string, string]> = [
  ["general_description", "General Description"],
  ["habitat", "Habitat"],
  ["behavior", "Behavior"],
  ["diet", "Diet"],
  ["nesting", "Nesting"],
  ["migration_status", "Migration Status"],
  ["conservation_status", "Conservation Status"],
  ["when_where_wa", "When and Where to Find in Washington"],
];
const SITE_SECTIONS: Array<[string, string]> = [
  ["site", "The Site"],
  ["birds", "The Birds"],
  ["directions", "Directions and Suggestions"],
  ["references", "References"],
];

export default function App() {
  const [collection, setCollection] = useState<Collection>("species");
  const [records, setRecords] = useState<IndexRecord[]>([]);
  const [slug, setSlug] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    setSlug(null);
    api.list(collection).then(setRecords).catch(() => setRecords([]));
  }, [collection]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return records;
    return records.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.slug.includes(q) ||
        (r.scientific ?? "").toLowerCase().includes(q) ||
        (r.family ?? "").toLowerCase().includes(q),
    );
  }, [records, query]);

  return (
    <div className="flex h-dvh flex-col">
      <header className="bg-brand text-white px-4 py-2.5 flex items-center gap-4 shrink-0">
        <span className="font-semibold">BirdWeb editor</span>
        <nav className="flex gap-1.5">
          {(["species", "sites", "ecoregions"] as const).map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => setCollection(name)}
              aria-pressed={collection === name}
              className={[
                "rounded-full px-3 py-1 text-xs font-semibold capitalize transition",
                collection === name
                  ? "bg-pop text-brand"
                  : "bg-white/10 text-sage hover:bg-white/20",
              ].join(" ")}
            >
              {name}
            </button>
          ))}
        </nav>
        <span className="ml-auto text-xs text-sage">
          Editing files in <code>src/content/</code> — commit with <code>sl</code> to publish
        </span>
      </header>

      <div className="flex flex-1 min-h-0">
        <aside className="w-72 shrink-0 border-r border-black/10 bg-white flex flex-col">
          <div className="p-3 border-b border-black/10">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Filter ${records.length} ${collection}…`}
              className="w-full rounded-lg border border-black/15 px-3 py-2 text-sm focus:border-brand focus:outline-none"
            />
          </div>
          <ul className="flex-1 overflow-y-auto p-0 m-0 list-none">
            {filtered.map((record) => (
              <li key={record.slug}>
                <button
                  type="button"
                  onClick={() => setSlug(record.slug)}
                  className={[
                    "w-full text-left px-3 py-2 border-b border-black/5 transition",
                    slug === record.slug ? "bg-pop/40" : "hover:bg-black/[0.03]",
                  ].join(" ")}
                >
                  <span className="block text-sm font-medium text-brand">{record.name}</span>
                  <span className="block text-xs text-black/50 italic">
                    {record.scientific ?? record.family ?? record.slug}
                  </span>
                  <span className="mt-0.5 flex gap-1.5 text-[0.625rem] text-black/40">
                    {record.photoCount > 0 && <span>{record.photoCount} photos</span>}
                    {collection === "species" && !record.hasAbundance && (
                      <span className="text-amber-700">no abundance</span>
                    )}
                    {record.needsGeocode && <span className="text-amber-700">no location</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <main className="flex-1 overflow-y-auto">
          {slug ? (
            <RecordEditor key={`${collection}/${slug}`} collection={collection} slug={slug} />
          ) : (
            <Welcome collection={collection} count={records.length} />
          )}
        </main>
      </div>
    </div>
  );
}

function Welcome({ collection, count }: { collection: Collection; count: number }) {
  const [changed, setChanged] = useState<string[]>([]);
  useEffect(() => {
    api.status().then((s) => setChanged(s.changed)).catch(() => setChanged([]));
  }, [collection]);

  return (
    <div className="p-8 max-w-2xl">
      <h1 className="text-2xl font-bold text-brand">Pick a record to edit</h1>
      <p className="mt-2 text-black/70">
        {count} {collection} in <code>src/content/{collection}/</code>. Changes save as you
        type, straight into the YAML files.
      </p>
      <div className="mt-6 rounded-xl bg-white ring-1 ring-black/5 p-4">
        <h2 className="font-semibold text-brand">Publishing</h2>
        <p className="mt-1 text-sm text-black/70">
          Edits here only change files on this machine. To put them on the live site, commit
          and push:
        </p>
        <pre className="mt-2 rounded-lg bg-black/[0.04] p-3 text-xs overflow-x-auto"><code>sl add src/content
sl commit -m "Update species accounts"
sl push</code></pre>
        {changed.length > 0 && (
          <>
            <p className="mt-3 text-sm font-semibold text-black/70">
              {changed.length} uncommitted change{changed.length === 1 ? "" : "s"}:
            </p>
            <ul className="mt-1 text-xs text-black/60 font-mono space-y-0.5 max-h-40 overflow-y-auto">
              {changed.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

function StatusPill({ state }: { state: SaveState }) {
  const map: Record<SaveState, [string, string]> = {
    clean: ["All changes saved", "text-black/45"],
    dirty: ["Unsaved changes…", "text-amber-700"],
    saving: ["Saving…", "text-amber-700"],
    saved: ["All changes saved", "text-green-700"],
    error: ["Not saved — see errors below", "text-red-700"],
  };
  const [label, tone] = map[state];
  return <span className={`text-xs font-medium ${tone}`}>{label}</span>;
}

function RecordEditor({ collection, slug }: { collection: Collection; slug: string }) {
  const [record, setRecord] = useState<Record<string, any> | null>(null);

  useEffect(() => {
    api.get(collection, slug).then(setRecord);
  }, [collection, slug]);

  const save = useCallback(
    (value: Record<string, any>) => api.save(collection, slug, value),
    [collection, slug],
  );

  const { state, issues } = useAutosave(record ?? {}, save, { enabled: record !== null });

  if (!record) return <div className="p-8 text-black/50">Loading…</div>;

  const set = (patch: Record<string, any>) => setRecord({ ...record, ...patch });
  const setSection = (key: string, text: string) =>
    setRecord({ ...record, sections: { ...record.sections, [key]: text } });

  const sections = collection === "sites" ? SITE_SECTIONS : SPECIES_SECTIONS;
  const title = record.common_name || record.name || slug;

  return (
    <div className="p-6 max-w-4xl space-y-7">
      <div className="flex items-baseline justify-between gap-4 sticky top-0 bg-cream/95 backdrop-blur py-2 -mt-2 z-10">
        <div>
          <h1 className="text-2xl font-bold text-brand">{title}</h1>
          <p className="text-xs text-black/45 font-mono">
            src/content/{collection}/{slug}.yaml
          </p>
        </div>
        <StatusPill state={state} />
      </div>

      {issues.length > 0 && (
        <ul className="rounded-xl bg-red-50 ring-1 ring-red-200 p-4 text-sm text-red-800 space-y-1">
          {issues.map((issue) => (
            <li key={issue.path}>
              <code className="font-mono text-xs">{issue.path}</code>: {issue.message}
            </li>
          ))}
        </ul>
      )}

      {collection === "species" && (
        <Field label="Status">
          <input
            type="text"
            value={record.status ?? ""}
            onChange={(e) => set({ status: e.target.value })}
            placeholder="e.g. Common resident."
            className="w-full rounded-lg border border-black/15 px-3 py-2 focus:border-brand focus:outline-none"
          />
          <label className="mt-2 flex items-center gap-2 text-sm text-black/70">
            <input
              type="checkbox"
              checked={Boolean(record.species_of_concern)}
              onChange={(e) => set({ species_of_concern: e.target.checked })}
              className="h-4 w-4"
            />
            Species of Concern in Washington
          </label>
        </Field>
      )}

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-black/50 mb-2">
          Account
        </h2>
        <div className="space-y-4">
          {sections.map(([key, label]) => (
            <Field key={key} label={label}>
              <textarea
                value={record.sections?.[key] ?? ""}
                onChange={(e) => setSection(key, e.target.value)}
                rows={Math.min(14, Math.max(3, (record.sections?.[key] ?? "").split("\n").length + 2))}
                className="w-full rounded-lg border border-black/15 px-3 py-2 text-sm leading-relaxed focus:border-brand focus:outline-none font-[inherit]"
              />
            </Field>
          ))}
        </div>
        <p className="mt-2 text-xs text-black/45">
          Blank lines separate paragraphs. <code>*italics*</code> and{" "}
          <code>[links](https://…)</code> work.
        </p>
      </section>

      {collection === "species" && record.abundance && (
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-black/50 mb-2">
            Abundance
          </h2>
          <div className="rounded-xl bg-white ring-1 ring-black/5 p-4">
            <AbundanceEditor
              ecoregions={ECOREGIONS}
              value={record.abundance}
              onChange={(abundance) => set({ abundance })}
            />
          </div>
        </section>
      )}

      {collection === "sites" && (
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-black/50 mb-2">
              Location
            </h2>
          <div className="rounded-xl bg-white ring-1 ring-black/5 p-4 space-y-4">
            <MapPicker
              lat={record.lat ?? null}
              lon={record.lon ?? null}
              name={record.name ?? slug}
              confirmed={record.geocode_source === "confirmed"}
              onChange={(lat, lon) =>
                // Moving the pin invalidates any previous confirmation: the coordinate a
                // person signed off on is not the one now in the file.
                set({ lat, lon, geocode_source: "placed-by-hand" })
              }
            />

            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Latitude">
                <input
                  type="number"
                  step="0.00001"
                  value={record.lat ?? ""}
                  onChange={(e) =>
                    set({
                      lat: e.target.value === "" ? null : Number(e.target.value),
                      geocode_source: e.target.value === "" ? null : "placed-by-hand",
                    })
                  }
                  className="w-full rounded-lg border border-black/15 px-3 py-2 focus:border-brand focus:outline-none"
                />
              </Field>
              <Field label="Longitude">
                <input
                  type="number"
                  step="0.00001"
                  value={record.lon ?? ""}
                  onChange={(e) =>
                    set({
                      lon: e.target.value === "" ? null : Number(e.target.value),
                      geocode_source: e.target.value === "" ? null : "placed-by-hand",
                    })
                  }
                  className="w-full rounded-lg border border-black/15 px-3 py-2 focus:border-brand focus:outline-none"
                />
              </Field>
              <Field label="County">
                <input
                  type="text"
                  value={record.county ?? ""}
                  onChange={(e) => set({ county: e.target.value || null })}
                  className="w-full rounded-lg border border-black/15 px-3 py-2 focus:border-brand focus:outline-none"
                />
              </Field>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              {record.geocode_source === "confirmed" ? (
                <>
                  <span className="rounded-full bg-brand text-white px-3 py-1.5 text-xs font-semibold">
                    Confirmed
                  </span>
                  <button
                    type="button"
                    onClick={() => set({ geocode_source: "placed-by-hand" })}
                    className="text-xs text-black/50 hover:text-brand underline"
                  >
                    Un-confirm
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    disabled={record.lat == null || record.lon == null}
                    onClick={() => set({ geocode_source: "confirmed" })}
                    className="rounded-full bg-pop text-brand px-4 py-2 text-sm font-semibold transition hover:brightness-95 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Confirm this pin
                  </button>
                  <span className="text-xs text-amber-700">
                    {record.lat == null
                      ? "No coordinate yet — click the map to place one."
                      : record.geocode_source === "nominatim-unconfirmed"
                        ? "Proposed automatically. Check it before confirming."
                        : "Placed by hand, not yet confirmed."}
                  </span>
                </>
              )}
            </div>
            <p className="text-xs text-black/45">
              Only confirmed pins reach the site — <code>pixi run verify</code> fails while
              any unconfirmed coordinate is present.
            </p>
          </div>
        </section>
      )}

      {Array.isArray(record.photos) && record.photos.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-black/50 mb-2">
            Photographs
          </h2>
          <ul className="grid gap-3 sm:grid-cols-2 p-0 list-none">
            {record.photos.map((photo: any, i: number) => (
              <li key={photo.file} className="rounded-xl bg-white ring-1 ring-black/5 p-3 flex gap-3">
                <img
                  src={assetUrl(
                    `${collection === "sites" ? "sites" : "birds"}/${slug}/${photo.file.replace(/\.[^.]+$/, ".webp")}`,
                    160,
                  )}
                  alt=""
                  className="h-24 w-24 rounded-lg object-cover bg-black/5 shrink-0"
                />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <input
                    type="text"
                    value={photo.caption ?? ""}
                    onChange={(e) => {
                      const photos = [...record.photos];
                      photos[i] = { ...photo, caption: e.target.value };
                      set({ photos });
                    }}
                    placeholder="Caption"
                    className="w-full rounded border border-black/15 px-2 py-1 text-xs focus:border-brand focus:outline-none"
                  />
                  <input
                    type="text"
                    value={photo.credit?.name ?? ""}
                    onChange={(e) => {
                      const photos = [...record.photos];
                      photos[i] = { ...photo, credit: { ...photo.credit, name: e.target.value } };
                      set({ photos });
                    }}
                    placeholder="Photographer"
                    className="w-full rounded border border-black/15 px-2 py-1 text-xs focus:border-brand focus:outline-none"
                  />
                  <label className="flex items-center gap-1.5 text-xs text-black/60">
                    <input
                      type="radio"
                      name={`hero-${slug}`}
                      checked={Boolean(photo.hero)}
                      onChange={() => {
                        // Exactly one hero: the schema enforces it and the site assumes it.
                        set({
                          photos: record.photos.map((p: any, j: number) => ({
                            ...p,
                            hero: i === j,
                          })),
                        });
                      }}
                    />
                    Lead photo
                  </label>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-semibold text-black/60 mb-1">{label}</span>
      {children}
    </label>
  );
}
