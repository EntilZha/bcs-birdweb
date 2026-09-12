import { useEffect, useMemo, useState } from "react";
import { ABUNDANCE, MONTHS_LONG, type AbundanceCode } from "../config/abundance";
import { ECOREGIONS, type EcoregionSlug } from "../config/ecoregions";

/**
 * One species, flattened for the client. Abundance arrives as ten 12-character strings
 * (one per ecoregion, in canonical order) rather than nested arrays -- at 491 species that
 * is the difference between a ~75KB payload and a ~300KB one, and the page has to stay
 * instant on shop wifi.
 */
export interface CompactSpecies {
  slug: string;
  name: string;
  latin: string;
  family: string;
  /** Ten strings of twelve abundance codes; a space means "not recorded". */
  a: string[];
  thumb: string | null;
}

interface Props {
  species: CompactSpecies[];
  base: string;
  /** Month to open on, 0-indexed. Resolved on the server so there is no hydration flash. */
  initialMonth: number;
  initialEcoregion: EcoregionSlug;
}

const RANKS: AbundanceCode[] = ["C", "F", "U", "R", "I"];

export default function WhatsAround({ species, base, initialMonth, initialEcoregion }: Props) {
  const [month, setMonth] = useState(initialMonth);
  const [ecoregion, setEcoregion] = useState<EcoregionSlug>(initialEcoregion);
  const [minRank, setMinRank] = useState(1);

  // Mirror the selection into the URL so a staff member can bookmark or share a view,
  // and so a reload keeps the state. replaceState, not push: this is a filter, not a
  // navigation, and it should not stack up back-button entries.
  useEffect(() => {
    const params = new URLSearchParams();
    params.set("region", ecoregion);
    params.set("month", String(month + 1));
    if (minRank > 1) params.set("min", String(minRank));
    window.history.replaceState(null, "", `?${params}`);
  }, [ecoregion, month, minRank]);

  const regionIndex = ECOREGIONS.findIndex((e) => e.slug === ecoregion);

  const results = useMemo(() => {
    const out: Array<CompactSpecies & { code: AbundanceCode; rank: number }> = [];
    for (const s of species) {
      const raw = (s.a[regionIndex] ?? "")[month] ?? " ";
      const code = (raw === " " ? "" : raw) as AbundanceCode;
      const rank = ABUNDANCE[code].rank;
      if (rank >= minRank) out.push({ ...s, code, rank });
    }
    return out.sort((a, b) => b.rank - a.rank || a.name.localeCompare(b.name));
  }, [species, regionIndex, month, minRank]);

  const counts = useMemo(() => {
    const tally = new Map<AbundanceCode, number>();
    for (const r of results) tally.set(r.code, (tally.get(r.code) ?? 0) + 1);
    return tally;
  }, [results]);

  return (
    <div>
      <div className="rounded-2xl bg-white ring-1 ring-black/5 p-4 sm:p-5 shadow-sm space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="block text-xs font-semibold uppercase tracking-wide text-ink-muted mb-1.5">
              Where
            </span>
            <select
              value={ecoregion}
              onChange={(e) => setEcoregion(e.target.value as EcoregionSlug)}
              className="w-full min-h-11 rounded-xl border-2 border-black/10 bg-white px-3 text-base focus:border-brand focus:outline-none"
            >
              {ECOREGIONS.map((e) => (
                <option key={e.slug} value={e.slug}>
                  {e.name}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="block text-xs font-semibold uppercase tracking-wide text-ink-muted mb-1.5">
              When
            </span>
            <select
              value={month}
              onChange={(e) => setMonth(Number(e.target.value))}
              className="w-full min-h-11 rounded-xl border-2 border-black/10 bg-white px-3 text-base focus:border-brand focus:outline-none"
            >
              {MONTHS_LONG.map((m, i) => (
                <option key={m} value={i}>
                  {m}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div>
          <span className="block text-xs font-semibold uppercase tracking-wide text-ink-muted mb-1.5">
            How likely
          </span>
          {/* One scrolling row rather than a wrapping grid: a second row moves every time
              the label lengths change, and this sits above the results on a phone. */}
          <div className="flex gap-2 overflow-x-auto flex-nowrap pb-1">
            {[1, 2, 3, 4, 5].map((rank) => {
              const label =
                rank === 1
                  ? "Anything recorded"
                  : `${ABUNDANCE[RANKS[5 - rank]].label} or better`;
              return (
                <button
                  key={rank}
                  type="button"
                  onClick={() => setMinRank(rank)}
                  aria-pressed={minRank === rank}
                  className={[
                    "shrink-0 rounded-full px-3.5 py-2 text-xs font-semibold transition active:scale-95 min-h-11 whitespace-nowrap",
                    minRank === rank
                      ? "bg-pop text-brand"
                      : "bg-black/5 text-ink hover:bg-black/10",
                  ].join(" ")}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="mt-6 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-xl font-bold text-brand">
          {results.length} species
        </h2>
        <p className="text-sm text-ink-muted">
          in the {ECOREGIONS[regionIndex]?.name} in {MONTHS_LONG[month]}
        </p>
      </div>

      <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-muted p-0 list-none">
        {RANKS.filter((code) => counts.get(code)).map((code) => (
          <li key={code} className="flex items-center gap-1.5">
            <span
              className={[
                "inline-flex h-4 w-4 items-center justify-center rounded-sm font-semibold",
                ABUNDANCE[code].swatch,
                ABUNDANCE[code].ink,
              ].join(" ")}
              aria-hidden="true"
            >
              {code}
            </span>
            {counts.get(code)} {ABUNDANCE[code].label.toLowerCase()}
          </li>
        ))}
      </ul>

      {results.length === 0 ? (
        <p className="mt-8 text-ink-muted">
          Nothing is recorded at that level in the {ECOREGIONS[regionIndex]?.name} in{" "}
          {MONTHS_LONG[month]}. Try a lower likelihood, or a different month.
        </p>
      ) : (
        <ul className="mt-5 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4 p-0 list-none">
          {results.map((s) => (
            <li key={s.slug}>
              <a
                href={`${base}birds/${s.slug}/`}
                className="group block overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-black/5 transition hover:shadow-md active:scale-[0.99]"
              >
                <div className="relative">
                  {s.thumb ? (
                    <img
                      src={s.thumb}
                      alt={s.name}
                      loading="lazy"
                      className="w-full aspect-square object-cover bg-black/5"
                    />
                  ) : (
                    <div className="w-full aspect-square bg-black/5 flex items-center justify-center text-xs text-ink-faint">
                      No photo
                    </div>
                  )}
                  <span
                    className={[
                      "absolute top-2 right-2 inline-flex h-7 w-7 items-center justify-center rounded-full text-sm font-bold shadow-sm",
                      ABUNDANCE[s.code].swatch,
                      ABUNDANCE[s.code].ink,
                    ].join(" ")}
                    title={ABUNDANCE[s.code].label}
                  >
                    <span aria-hidden="true">{s.code}</span>
                    <span className="sr-only">{ABUNDANCE[s.code].label}</span>
                  </span>
                </div>
                <div className="px-3 py-2">
                  <p className="text-sm font-semibold text-brand leading-snug group-hover:underline">
                    {s.name}
                  </p>
                  <p className="text-xs italic text-ink-muted leading-snug">{s.latin}</p>
                </div>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
