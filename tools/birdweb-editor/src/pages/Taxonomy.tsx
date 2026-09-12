import { useCallback, useEffect, useState } from "react";
import { api, type TaxonomyOverride } from "../api";

/**
 * The taxonomy decisions that could not be made mechanically.
 *
 * Each of these species matched the current eBird taxonomy on its 2005 binomial but not on
 * its name — the signature of a post-2005 split where the old binomial stayed with the Old
 * World daughter species — or was lumped into another species, or is simply gone from the
 * checklist. Deciding which daughter occurs in Washington is a factual ornithological call
 * that belongs to the BCS Science Committee, so this screen is for reviewing the reasoning
 * rather than for guessing.
 *
 * `why` and the `suggested_*` fields are evidence written by scripts/map_taxonomy.py and
 * are shown read-only: they record what the matcher saw, and editing them would destroy
 * the audit trail for a decision someone has to be able to re-examine.
 *
 * Changes here take effect on the next `pixi run taxonomy`.
 */
export default function Taxonomy() {
  const [species, setSpecies] = useState<Record<string, TaxonomyOverride> | null>(null);
  const [header, setHeader] = useState("");
  const [state, setState] = useState<"clean" | "dirty" | "saving" | "saved">("clean");

  const load = useCallback(() => {
    api
      .taxonomyOverrides()
      .then((r) => {
        setSpecies(r.species);
        setHeader(r.header);
        setState("clean");
      })
      .catch(() => setSpecies({}));
  }, []);
  useEffect(load, [load]);

  async function save(next: Record<string, TaxonomyOverride>) {
    setSpecies(next);
    setState("saving");
    const response = await api.saveTaxonomyOverrides(next, header);
    setState(response.error ? "dirty" : "saved");
  }

  function update(slug: string, patch: Partial<TaxonomyOverride>) {
    if (!species) return;
    void save({ ...species, [slug]: { ...species[slug], ...patch } });
  }

  if (!species) return <div className="p-8 text-ink-muted">Loading…</div>;

  const slugs = Object.keys(species).sort();
  const resolved = slugs.filter((s) => species[s]?.ebird_code);

  return (
    <div className="p-6 max-w-3xl space-y-5">
      <div className="flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-brand">Taxonomy decisions</h1>
          <p className="mt-1 text-sm text-ink-muted">
            {resolved.length} of {slugs.length} resolved. Changes take effect the next time
            someone runs <code>pixi run taxonomy</code>.
          </p>
        </div>
        <span className="shrink-0 text-xs font-medium text-ink-muted">
          {state === "saving" ? "Saving…" : state === "saved" ? "Saved" : ""}
        </span>
      </div>

      <div className="rounded-xl bg-pop/25 p-4 text-sm text-ink">
        Each of these is a bird whose name or classification changed after its BirdWeb
        account was written. Leaving one unresolved is safe: the site then shows the name the
        account itself uses, which is never wrong — only out of date.
      </div>

      {slugs.map((slug) => {
        const entry = species[slug] ?? {};
        const done = Boolean(entry.ebird_code);
        return (
          <section
            key={slug}
            className={[
              "rounded-xl bg-white p-4 ring-1 space-y-3",
              done ? "ring-black/5" : "ring-amber-300",
            ].join(" ")}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="font-semibold text-brand">
                {entry.birdweb_common_name || slug}
                {entry.birdweb_scientific_name && (
                  <span className="ml-2 font-normal italic text-ink-muted">
                    {entry.birdweb_scientific_name}
                  </span>
                )}
              </h2>
              <span
                className={[
                  "rounded-full px-2.5 py-0.5 text-xs font-semibold",
                  done ? "bg-brand text-white" : "bg-amber-100 text-amber-900",
                ].join(" ")}
              >
                {done ? "Resolved" : "Needs a decision"}
              </span>
            </div>

            {entry.why && (
              <p className="rounded-lg bg-black/[0.03] px-3 py-2 text-xs text-ink-muted">
                {entry.why}
                {entry.suggested_common_name && (
                  <>
                    {" "}
                    Suggested: <strong>{entry.suggested_common_name}</strong>
                    {entry.suggested_ebird_code && ` (${entry.suggested_ebird_code})`}.
                  </>
                )}
              </p>
            )}

            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Current common name">
                <input
                  type="text"
                  value={entry.current_common_name ?? ""}
                  onChange={(e) => update(slug, { current_common_name: e.target.value || null })}
                  className="w-full rounded-lg border border-black/15 px-3 py-2 text-sm focus:border-brand focus:outline-none"
                />
              </Field>
              <Field label="Current scientific name">
                <input
                  type="text"
                  value={entry.current_scientific_name ?? ""}
                  onChange={(e) =>
                    update(slug, { current_scientific_name: e.target.value || null })
                  }
                  className="w-full rounded-lg border border-black/15 px-3 py-2 text-sm italic focus:border-brand focus:outline-none"
                />
              </Field>
              <Field label="eBird code">
                <input
                  type="text"
                  value={entry.ebird_code ?? ""}
                  onChange={(e) => update(slug, { ebird_code: e.target.value || null })}
                  placeholder={entry.suggested_ebird_code ?? ""}
                  className="w-full rounded-lg border border-black/15 px-3 py-2 font-mono text-sm focus:border-brand focus:outline-none"
                />
              </Field>
            </div>

            <Field label="Note shown to readers on the species page">
              <textarea
                value={entry.note ?? ""}
                onChange={(e) => update(slug, { note: e.target.value || null })}
                rows={3}
                placeholder="Say what the bird was called on BirdWeb and what happened to the name."
                className="w-full rounded-lg border border-black/15 px-3 py-2 text-sm leading-relaxed focus:border-brand focus:outline-none"
              />
            </Field>

            <label className="flex items-start gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={Boolean(entry.display_historic)}
                onChange={(e) => update(slug, { display_historic: e.target.checked })}
                className="mt-0.5 h-4 w-4"
              />
              <span>
                Keep the BirdWeb name as the page title
                <span className="block text-xs text-ink-muted">
                  For an account absorbed into a species that has its own account — without
                  this the site shows two pages with the same title.
                </span>
              </span>
            </label>
          </section>
        );
      })}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold text-ink-muted">{label}</span>
      {children}
    </label>
  );
}
