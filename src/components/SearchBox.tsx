import { useEffect, useMemo, useRef, useState } from "react";
import Fuse from "fuse.js";
import type { SearchEntry } from "../lib/search";

interface Props {
  entries: SearchEntry[];
  base: string;
  autofocus?: boolean;
  /** Storefront display: larger type, taller rows, no hover-only affordances. */
  kiosk?: boolean;
  placeholder?: string;
}

export default function SearchBox({
  entries,
  base,
  autofocus = false,
  kiosk = false,
  placeholder = "Search birds and birding sites…",
}: Props) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const fuse = useMemo(
    () =>
      new Fuse(entries, {
        // Weighted so a common-name match always outranks a family match. Without this,
        // typing "Thrush" surfaces the whole thrush family above Varied Thrush itself.
        keys: [
          { name: "name", weight: 1 },
          { name: "aliases", weight: 0.7 },
          { name: "sub", weight: 0.5 },
          { name: "group", weight: 0.25 },
        ],
        threshold: 0.35,
        ignoreLocation: true,
        minMatchCharLength: 2,
      }),
    [entries],
  );

  const results = useMemo(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) return [];
    return fuse.search(trimmed, { limit: kiosk ? 8 : 12 }).map((r) => r.item);
  }, [fuse, query, kiosk]);

  useEffect(() => setActive(0), [query]);

  // Keep the highlighted row in view when arrowing through a list taller than the box.
  useEffect(() => {
    listRef.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [active]);

  useEffect(() => {
    if (!autofocus || kiosk) return;
    // Coarse pointer means a touch device, where focusing on load raises the on-screen
    // keyboard over the page before the visitor has asked to search for anything.
    const touch = window.matchMedia?.("(pointer: coarse)").matches;
    if (!touch) inputRef.current?.focus();
  }, [autofocus, kiosk]);

  function go(entry: SearchEntry) {
    window.location.href = `${base}${entry.href}`;
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (!results.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((i) => (i + 1) % results.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => (i - 1 + results.length) % results.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      go(results[active]);
    } else if (event.key === "Escape") {
      setQuery("");
    }
  }

  const inputClass = kiosk
    ? "w-full rounded-2xl border-2 border-brand/15 bg-white px-6 text-k-ui min-h-touch focus:border-brand focus:outline-none"
    : "w-full rounded-xl border-2 border-black/10 bg-white px-4 py-3 text-base focus:border-brand focus:outline-none";

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label="Search birds and birding sites"
        role="combobox"
        aria-expanded={results.length > 0}
        aria-controls="search-results"
        aria-autocomplete="list"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        className={inputClass}
      />

      {query.trim().length >= 2 && (
        <ul
          id="search-results"
          ref={listRef}
          role="listbox"
          className={[
            "absolute z-40 mt-2 w-full overflow-y-auto overscroll-contain rounded-xl bg-white shadow-lg ring-1 ring-black/10",
            kiosk ? "max-h-[28rem]" : "max-h-96",
          ].join(" ")}
        >
          {results.length === 0 && (
            <li className={kiosk ? "px-6 py-5 text-k-meta text-ink-muted" : "px-4 py-3 text-sm text-ink-muted"}>
              Nothing matched “{query.trim()}”.
            </li>
          )}
          {results.map((entry, i) => (
            <li key={entry.href} role="option" aria-selected={i === active}>
              <button
                type="button"
                onClick={() => go(entry)}
                onMouseEnter={() => setActive(i)}
                className={[
                  "w-full text-left transition active:scale-[0.99]",
                  kiosk ? "px-6 py-4 min-h-touch" : "px-4 py-2.5",
                  i === active ? "bg-pop/40" : "bg-transparent",
                ].join(" ")}
              >
                <span
                  className={[
                    "block font-semibold text-brand",
                    kiosk ? "text-k-meta" : "text-sm",
                  ].join(" ")}
                >
                  {entry.name}
                </span>
                <span
                  className={[
                    "block text-ink-muted",
                    kiosk ? "text-base" : "text-xs",
                  ].join(" ")}
                >
                  <span className="italic">{entry.sub}</span>
                  {entry.group && <span> · {entry.group}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
