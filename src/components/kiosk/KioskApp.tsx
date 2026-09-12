import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Fuse from "fuse.js";
import { QRCodeSVG } from "qrcode.react";
import { ABUNDANCE, MONTHS, MONTHS_LONG, type AbundanceCode } from "../../config/abundance";
import { ECOREGIONS, type EcoregionSlug } from "../../config/ecoregions";

/**
 * The storefront display.
 *
 * Built for the case that prompted it: someone walks into the shop with a photo on their
 * phone, and a staff member needs the bird on screen while the conversation is still
 * happening. That drives every decision here -- search is always one tap away and never
 * more than one screen deep, results are photographs rather than a list of names, and the
 * type is sized to be read at about 1.5 m rather than at arm's length.
 */

export interface KioskSpecies {
  slug: string;
  name: string;
  latin: string;
  family: string;
  status: string;
  aliases: string[];
  /** Ten strings of twelve abundance codes, in canonical ecoregion order. */
  a: string[];
  thumb: string | null;
  large: string | null;
  blurb: string;
}

interface Props {
  species: KioskSpecies[];
  base: string;
  /** Absolute origin, for the QR hand-off. Resolved at build time. */
  buildOrigin: string;
  initialMonth: number;
}

/** Idle timings. Long enough not to interrupt a real conversation at the screen. */
const IDLE_MS = 120_000;
const WARN_MS = 15_000;
const HOME_ECOREGION: EcoregionSlug = "puget_trough";

export default function KioskApp({ species, base, buildOrigin, initialMonth }: Props) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<KioskSpecies | null>(null);
  const [warning, setWarning] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const fuse = useMemo(
    () =>
      new Fuse(species, {
        keys: [
          { name: "name", weight: 1 },
          { name: "aliases", weight: 0.7 },
          { name: "latin", weight: 0.5 },
          { name: "family", weight: 0.3 },
        ],
        threshold: 0.35,
        ignoreLocation: true,
        minMatchCharLength: 2,
      }),
    [species],
  );

  // Nothing typed: show the birds someone is most likely to be asking about — the ones
  // that are common in the Puget Trough this month. A blank grid would waste the screen.
  const suggestions = useMemo(() => {
    const regionIndex = ECOREGIONS.findIndex((e) => e.slug === HOME_ECOREGION);
    return species
      .filter((s) => ((s.a[regionIndex] ?? "")[initialMonth] ?? " ") === "C")
      .filter((s) => s.thumb)
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 24);
  }, [species, initialMonth]);

  const results = useMemo(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) return suggestions;
    return fuse.search(trimmed, { limit: 24 }).map((r) => r.item);
  }, [fuse, query, suggestions]);

  const reset = useCallback(() => {
    setQuery("");
    setSelected(null);
    setWarning(false);
    inputRef.current?.blur();
  }, []);

  // Idle reset, so the screen is never left on one visitor's bird. pointermove is
  // deliberately not an activity signal: a large touch overlay emits spurious moves from
  // smudges and passing shadows, which would keep the timer alive forever.
  useEffect(() => {
    let warn: ReturnType<typeof setTimeout>;
    let idle: ReturnType<typeof setTimeout>;
    const schedule = () => {
      clearTimeout(warn);
      clearTimeout(idle);
      setWarning(false);
      if (!selected && !query) return; // Already home; nothing to reset to.
      warn = setTimeout(() => setWarning(true), IDLE_MS - WARN_MS);
      idle = setTimeout(reset, IDLE_MS);
    };
    const events = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
    for (const event of events) {
      window.addEventListener(event, schedule, { passive: true, capture: true });
    }
    schedule();
    return () => {
      clearTimeout(warn);
      clearTimeout(idle);
      for (const event of events) {
        window.removeEventListener(event, schedule, { capture: true });
      }
    };
  }, [selected, query, reset]);

  return (
    <div className="flex h-dvh flex-col bg-cream">
      <header className="bg-brand text-white px-6 py-4 flex items-center gap-5 shrink-0">
        <img
          src={`${base}bcs-logo-white.png`}
          alt="Birds Connect Seattle"
          className="h-14 w-14 shrink-0"
          width="56"
          height="56"
        />
        <div className="leading-tight shrink-0">
          <p className="text-k-title">BirdWeb</p>
          <p className="text-sage text-k-meta">Birds of Washington</p>
        </div>

        {/* Search lives in the header, not on a separate screen: from any state it is one
            tap away, which is the whole point of this display. */}
        <div className="flex-1 max-w-3xl ml-auto">
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(null);
            }}
            placeholder="Search for a bird…"
            aria-label="Search for a bird"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            className="w-full rounded-2xl bg-white/95 px-6 text-k-ui min-h-touch text-brand placeholder:text-ink-faint focus:outline-none focus:ring-4 focus:ring-pop"
          />
        </div>

        {(selected || query) && (
          <button
            type="button"
            onClick={reset}
            className="shrink-0 rounded-2xl bg-white/10 px-6 min-h-touch text-k-ui font-semibold text-sage transition active:scale-95 hover:bg-white/20 hover:text-white"
          >
            Start over
          </button>
        )}
      </header>

      {warning && (
        <div className="bg-pop text-brand px-6 py-3 flex items-center justify-between gap-4 shrink-0">
          <p className="text-k-meta font-semibold">Clearing the screen in a moment…</p>
          <button
            type="button"
            onClick={() => setWarning(false)}
            className="rounded-xl bg-brand text-white px-6 min-h-touch text-k-ui font-semibold transition active:scale-95"
          >
            Keep looking
          </button>
        </div>
      )}

      <main className="flex-1 overflow-y-auto overscroll-contain px-6 py-5">
        {selected ? (
          <SpeciesDetail
            species={selected}
            base={base}
            buildOrigin={buildOrigin}
            month={initialMonth}
          />
        ) : (
          <>
            <h1 className="text-k-day text-brand mb-4">
              {query.trim().length >= 2
                ? `${results.length} match${results.length === 1 ? "" : "es"}`
                : `Common around Seattle in ${MONTHS_LONG[initialMonth]}`}
            </h1>
            {results.length === 0 ? (
              <p className="text-k-title text-ink-muted">
                Nothing matched “{query.trim()}”.
              </p>
            ) : (
              <ul className="grid grid-cols-3 xl:grid-cols-4 2xl:grid-cols-6 gap-5 p-0 list-none">
                {results.map((s) => (
                  <li key={s.slug}>
                    <button
                      type="button"
                      onClick={() => setSelected(s)}
                      className="w-full text-left overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-black/5 transition active:scale-95 min-h-touch"
                    >
                      {s.thumb ? (
                        <img
                          src={s.thumb}
                          alt={s.name}
                          className="w-full aspect-square object-cover bg-black/5"
                          loading="lazy"
                        />
                      ) : (
                        <div className="w-full aspect-square bg-black/5" />
                      )}
                      <div className="px-4 py-3">
                        <p className="text-k-meta font-semibold text-brand leading-snug">
                          {s.name}
                        </p>
                        <p className="text-base italic text-ink-muted leading-snug">{s.latin}</p>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </main>
    </div>
  );
}

function SpeciesDetail({
  species,
  base,
  buildOrigin,
  month,
}: {
  species: KioskSpecies;
  base: string;
  buildOrigin: string;
  month: number;
}) {
  const url = `${buildOrigin}${base}birds/${species.slug}/`;
  const present = ECOREGIONS.map((eco, i) => ({
    eco,
    code: ((species.a[i] ?? "")[month] ?? " ").replace(" ", "") as AbundanceCode,
  })).filter((row) => row.code !== "");

  // A few accounts have no photograph. Keeping the two-column grid in that case leaves
  // half the screen blank and makes the display look broken from across the room.
  return (
    <div
      className={[
        "grid gap-7 items-start",
        species.large ? "lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]" : "max-w-5xl",
      ].join(" ")}
    >
      {species.large && (
        <img
          src={species.large}
          alt={species.name}
          className="w-full rounded-2xl bg-black/5 object-cover shadow-sm"
        />
      )}
      <div>
        <h1 className="text-k-hero text-brand">{species.name}</h1>
        <p className="text-k-title italic text-ink-muted mt-1">{species.latin}</p>
        {species.status && (
          <p className="text-k-title text-ink mt-4">{species.status}</p>
        )}
        {species.blurb && (
          <p className="text-k-meta leading-relaxed text-ink mt-4">{species.blurb}</p>
        )}

        {present.length > 0 && (
          <div className="mt-6">
            <h2 className="text-k-ui text-brand mb-2">
              In {MONTHS_LONG[month]} you can find it in
            </h2>
            <ul className="flex flex-wrap gap-2 p-0 list-none">
              {present.map(({ eco, code }) => (
                <li
                  key={eco.slug}
                  className={[
                    "rounded-full px-4 py-2 text-base font-semibold",
                    ABUNDANCE[code].swatch,
                    ABUNDANCE[code].ink,
                  ].join(" ")}
                >
                  {eco.name} · {ABUNDANCE[code].label}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Hand-off: the visitor keeps the page, the screen goes back to the shop. Level M
            error correction because a storefront screen collects glare and fingerprints. */}
        <div className="mt-7 flex items-center gap-5 rounded-2xl bg-white ring-1 ring-black/5 p-5">
          <QRCodeSVG value={url} size={120} level="M" fgColor="#0a3c23" bgColor="#ffffff" />
          <div>
            <p className="text-k-ui font-semibold text-brand">Take it with you</p>
            <p className="text-k-meta text-ink-muted mt-1">
              Scan for the full account — photos, sounds and where to find it all year.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Month abbreviations, re-exported so the page can label without importing the config. */
export { MONTHS };
