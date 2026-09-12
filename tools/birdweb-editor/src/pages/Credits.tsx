import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type Credit } from "../api";

/**
 * Every photographer across the whole site, with how many images each contributed.
 *
 * The credit lives per-photo in the source data and nowhere else, so a misspelled name is
 * invisible until you happen to open the one species that carries it — and unfixable
 * without editing every record by hand. These names were typed over twenty years by
 * different volunteers, so variants are inevitable. Getting a contributor's name right is
 * the least this rebuild owes them, and it has to be possible in one action or nobody will
 * do it across 2,200 photos.
 */
export default function Credits() {
  const [credits, setCredits] = useState<Credit[] | null>(null);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Credit | null>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const load = useCallback(() => {
    api.credits().then(setCredits).catch(() => setCredits([]));
  }, []);
  useEffect(load, [load]);

  function open(credit: Credit) {
    setEditing(credit);
    setName(credit.name);
    setUrl(credit.urls[0] ?? "");
    setResult(null);
  }

  async function rename() {
    if (!editing) return;
    setBusy(true);
    try {
      const response = await api.renameCredit(editing.name, name.trim(), url.trim() || null);
      setResult(
        response.error
          ? response.error
          : `Updated ${response.photos} photo${response.photos === 1 ? "" : "s"} across ${response.records} record${response.records === 1 ? "" : "s"}.`,
      );
      if (!response.error) {
        setEditing(null);
        load();
      }
    } finally {
      setBusy(false);
    }
  }

  const filtered = useMemo(() => {
    if (!credits) return [];
    const q = query.trim().toLowerCase();
    return q ? credits.filter((c) => c.name.toLowerCase().includes(q)) : credits;
  }, [credits, query]);

  /**
   * Names that are probably the same person. Surfacing them is the whole reason this
   * screen exists.
   *
   * Two keys per name, because one is not enough. Folding case and punctuation catches
   * "Joseph V Higbee" against "Joseph V. Higbee"; dropping single-letter initials as well
   * is what catches "Joseph Higbee", who is the same photographer and was credited all
   * three ways across 108 photos. A shared credit URL is treated as confirmation.
   */
  const suspected = useMemo(() => {
    if (!credits) return [] as string[][];
    const keysFor = (name: string) => {
      const words = name.toLowerCase().replace(/[^a-z ]/g, "").split(/\s+/).filter(Boolean);
      return [words.join(""), words.filter((w) => w.length > 1).join("")];
    };
    const buckets = new Map<string, Set<string>>();
    for (const credit of credits) {
      for (const key of new Set(keysFor(credit.name))) {
        buckets.set(key, (buckets.get(key) ?? new Set()).add(credit.name));
      }
      // A shared link is strong evidence regardless of spelling.
      for (const url of credit.urls) {
        const key = `url:${url.replace(/\/+$/, "")}`;
        buckets.set(key, (buckets.get(key) ?? new Set()).add(credit.name));
      }
    }
    // Merge overlapping buckets so all three spellings of one name appear as one group.
    const groups: Set<string>[] = [];
    for (const names of buckets.values()) {
      if (names.size < 2) continue;
      const existing = groups.find((g) => [...names].some((n) => g.has(n)));
      if (existing) names.forEach((n) => existing.add(n));
      else groups.push(new Set(names));
    }
    return groups.map((g) => [...g].sort());
  }, [credits]);

  if (!credits) return <div className="p-8 text-ink-muted">Loading…</div>;

  const total = credits.reduce((sum, c) => sum + c.count, 0);

  return (
    <div className="p-6 max-w-3xl space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-brand">Photographers</h1>
        <p className="mt-1 text-sm text-ink-muted">
          {credits.length} people credited across {total} photographs. Every photograph
          remains the property of its photographer.
        </p>
      </div>

      {suspected.length > 0 && (
        <div className="rounded-xl bg-pop/30 p-4 text-sm">
          <h2 className="font-semibold text-brand">
            {suspected.length} photographer{suspected.length === 1 ? "" : "s"} may be credited
            more than one way
          </h2>
          <p className="mt-1 text-ink">
            These match once case, punctuation or a middle initial is set aside, or they
            share a link — so they are probably one person. Use Edit to merge them onto a
            single spelling.
          </p>
          <ul className="mt-2 space-y-1">
            {suspected.map((names) => (
              <li key={names.join("|")} className="font-mono text-xs">
                {names.join("  ·  ")}
              </li>
            ))}
          </ul>
        </div>
      )}

      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={`Filter ${credits.length} photographers…`}
        className="w-full rounded-lg border border-black/15 px-3 py-2 text-sm focus:border-brand focus:outline-none"
      />

      <ul className="divide-y divide-black/5 rounded-xl bg-white ring-1 ring-black/5 p-0 list-none">
        {filtered.map((credit) => (
          <li key={credit.name} className="flex items-center gap-3 px-4 py-2.5">
            <div className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-brand">{credit.name}</span>
              {credit.urls.length > 0 && (
                <span className="block truncate text-xs text-ink-muted">
                  {credit.urls.join("  ·  ")}
                </span>
              )}
            </div>
            <span className="shrink-0 text-xs tabular-nums text-ink-muted">
              {credit.count}
            </span>
            <button
              type="button"
              onClick={() => open(credit)}
              className="shrink-0 rounded-lg bg-black/5 px-3 py-1.5 text-xs font-semibold text-brand transition hover:bg-black/10"
            >
              Edit
            </button>
          </li>
        ))}
      </ul>

      {editing && (
        <div className="rounded-xl bg-white ring-1 ring-black/5 p-4 space-y-3">
          <h2 className="font-semibold text-brand">
            Rename “{editing.name}” everywhere
          </h2>
          <p className="text-sm text-ink-muted">
            This changes {editing.count} photo{editing.count === 1 ? "" : "s"} across the
            site. Nothing is published until you publish.
          </p>
          <label className="block">
            <span className="block text-xs font-semibold text-ink-muted mb-1">Name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg border border-black/15 px-3 py-2 text-sm focus:border-brand focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="block text-xs font-semibold text-ink-muted mb-1">
              Link (optional)
            </span>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://…"
              className="w-full rounded-lg border border-black/15 px-3 py-2 text-sm focus:border-brand focus:outline-none"
            />
          </label>
          <details className="text-xs text-ink-muted">
            <summary className="cursor-pointer hover:text-brand">
              Show {Math.min(editing.where.length, 40)} of the records this touches
            </summary>
            <ul className="mt-1 font-mono space-y-0.5">
              {editing.where.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </details>
          <div className="flex gap-3">
            <button
              type="button"
              disabled={busy || !name.trim() || name.trim() === editing.name}
              onClick={rename}
              className="rounded-full bg-pop px-4 py-2 text-sm font-semibold text-brand transition hover:brightness-95 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Rename {editing.count} photo{editing.count === 1 ? "" : "s"}
            </button>
            <button
              type="button"
              onClick={() => setEditing(null)}
              className="rounded-full bg-black/5 px-4 py-2 text-sm font-semibold text-ink transition hover:bg-black/10"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {result && <p className="rounded-lg bg-pop/30 px-3 py-2 text-sm text-brand">{result}</p>}
    </div>
  );
}
