import { useMemo, useState } from "react";
import { ECOREGIONS, ECOREGION_NAME, type EcoregionSlug } from "../config/ecoregions";

/**
 * Filter the birding sites by ecoregion and by name.
 *
 * The list is 69 items grouped into ten ecoregions, which is short enough that the grouped
 * view is genuinely useful and long enough that "is there anything near Spokane" means
 * scrolling past eight headings. So the grouping stays and this narrows it.
 *
 * Only the site names and ecoregions cross the wire, not the prose — the full text of 69
 * site accounts would be most of a megabyte for a filter that matches on names.
 */

export interface SiteEntry {
  slug: string;
  name: string;
  ecoregions: EcoregionSlug[];
  number: number | null;
  /** County, once someone has confirmed the pin. Null for most sites today. */
  county: string | null;
}

interface Props {
  sites: SiteEntry[];
  base: string;
}

export default function SiteFilter({ sites, base }: Props) {
  const [region, setRegion] = useState<EcoregionSlug | "all">("all");
  const [query, setQuery] = useState("");

  const matching = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sites.filter((site) => {
      if (region !== "all" && !site.ecoregions.includes(region)) return false;
      if (!q) return true;
      return (
        site.name.toLowerCase().includes(q) ||
        (site.county ?? "").toLowerCase().includes(q) ||
        site.ecoregions.some((e) => ECOREGION_NAME[e].toLowerCase().includes(q))
      );
    });
  }, [sites, region, query]);

  // Keep the ecoregion grouping in the results: it is how a birder thinks about the state,
  // and a straddling site appears under each of its regions on purpose.
  const groups = useMemo(
    () =>
      ECOREGIONS.map((eco) => ({
        ...eco,
        members: matching.filter((s) => s.ecoregions.includes(eco.slug)),
      })).filter((g) => g.members.length > 0),
    [matching],
  );

  const counts = useMemo(() => {
    const tally = new Map<string, number>();
    for (const eco of ECOREGIONS) {
      tally.set(eco.slug, sites.filter((s) => s.ecoregions.includes(eco.slug)).length);
    }
    return tally;
  }, [sites]);

  return (
    <div>
      <div className="rounded-2xl bg-white ring-1 ring-black/5 p-4 shadow-sm space-y-3">
        <label className="block">
          <span className="block text-xs font-semibold uppercase tracking-wide text-ink-muted mb-1.5">
            Find a site
          </span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Name, county or ecoregion…"
            className="w-full min-h-11 rounded-xl border-2 border-black/10 bg-white px-3 text-base focus:border-brand focus:outline-none"
          />
        </label>

        <div>
          <span className="block text-xs font-semibold uppercase tracking-wide text-ink-muted mb-1.5">
            Ecoregion
          </span>
          {/* One scrolling row, never wrapping: ten region names would wrap to three rows
              on a phone and push the results off the screen. */}
          <div className="flex gap-2 overflow-x-auto flex-nowrap pb-1">
            <button
              type="button"
              onClick={() => setRegion("all")}
              aria-pressed={region === "all"}
              className={[
                "shrink-0 rounded-full px-3.5 py-2 text-xs font-semibold transition active:scale-95 min-h-11 whitespace-nowrap",
                region === "all" ? "bg-pop text-brand" : "bg-black/5 text-ink hover:bg-black/10",
              ].join(" ")}
            >
              Anywhere ({sites.length})
            </button>
            {ECOREGIONS.map((eco) => (
              <button
                key={eco.slug}
                type="button"
                onClick={() => setRegion(eco.slug)}
                aria-pressed={region === eco.slug}
                className={[
                  "shrink-0 rounded-full px-3.5 py-2 text-xs font-semibold transition active:scale-95 min-h-11 whitespace-nowrap",
                  region === eco.slug
                    ? "bg-pop text-brand"
                    : "bg-black/5 text-ink hover:bg-black/10",
                ].join(" ")}
              >
                {eco.name} ({counts.get(eco.slug) ?? 0})
              </button>
            ))}
          </div>
        </div>
      </div>

      {matching.length === 0 ? (
        <p className="mt-8 text-ink-muted">
          No birding site matches “{query.trim()}”
          {region !== "all" && ` in the ${ECOREGION_NAME[region]}`}.
        </p>
      ) : (
        <>
          <p className="mt-6 text-sm text-ink-muted">
            {matching.length} of {sites.length} sites
          </p>
          {groups.map((group) => (
            <section key={group.slug} className="mt-6">
              <div className="flex flex-wrap items-baseline gap-x-3 mb-3">
                <h2 className="text-xl font-bold text-brand">
                  <a href={`${base}ecoregions/${group.slug}/`} className="hover:underline">
                    {group.name}
                  </a>
                </h2>
                <span className="text-xs text-ink-muted">{group.members.length} sites</span>
              </div>
              <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 p-0 list-none">
                {group.members.map((site) => (
                  <li key={`${group.slug}-${site.slug}`}>
                    <a
                      href={`${base}sites/${site.slug}/`}
                      className="flex h-full min-h-11 flex-col justify-center rounded-xl bg-white px-4 py-3 shadow-sm ring-1 ring-black/5 transition hover:shadow-md active:scale-[0.99]"
                    >
                      <span className="font-semibold text-brand">{site.name}</span>
                      {site.ecoregions.length > 1 && (
                        <span className="mt-0.5 block text-xs text-ink-muted">
                          Also in{" "}
                          {site.ecoregions
                            .filter((e) => e !== group.slug)
                            .map((e) => ECOREGION_NAME[e])
                            .join(", ")}
                        </span>
                      )}
                      {site.county && (
                        <span className="mt-0.5 block text-xs text-ink-muted">
                          {site.county} County
                        </span>
                      )}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </>
      )}
    </div>
  );
}
