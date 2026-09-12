# BirdWeb

A rebuild of [BirdWeb](https://birdweb.org/birdweb/), Birds Connect Seattle's guide to the
birds of Washington: 491 species accounts, 69 birding sites, 10 ecoregions, and
month-by-month abundance for every species in every ecoregion.

BirdWeb has been written and maintained by BCS volunteers since 1999. The original site's
source code and database were lost and its host could no longer be administered, so the
content was recovered from the live site and rebuilt as a static, mobile-first site.

**Nothing here replaces the accounts.** The prose is reproduced exactly as its authors
wrote it. Where taxonomy has changed since publication the current name is shown alongside
the historic one; the text is never rewritten.

## Quick start

Everything runs through [pixi](https://pixi.sh) — it provides Node and Python, so there is
no "install Node first" step.

```bash
pixi run install-js     # npm dependencies for the site and the editor
pixi run dev            # Astro dev server
pixi run editor         # the local content editor
```

## How the data gets here

```
  birdweb.org ──mirror──▶ archive/ ──extract──▶ src/content/*.yaml ──▶ Astro ──▶ dist/
   (once, ever)            (raw,      (offline)   (the source of         (build)
                         gitignored)               truth from here on)
```

The two stages are deliberately separate. `mirror` is the only thing that ever touches the
legacy server — a fragile, unattended IIS 7.5 box that nobody can restart if it falls over.
Everything downstream parses the local mirror, so iterating on a parser costs nothing and
the source is hit exactly once.

| Task | What it does |
|---|---|
| `pixi run mirror` | Crawl the legacy site into `archive/`. Resumable; skips what it has. |
| `pixi run verify-archive` | Re-hash every archived file against `manifest.jsonl`. |
| `pixi run archive-pack` | Pack `archive/` into a dated, checksummed tarball. |
| `pixi run extract` | Parse `archive/` into `src/content/` YAML. Offline. |
| `pixi run verify` | Hard QA gate over the extracted content. Non-zero exit on any gap. |
| `pixi run taxonomy` | Attach the eBird taxonomy layer to each species. |
| `pixi run images` | Convert archived photos and maps to WebP under `src/assets/`. |
| `pixi run geocode` | Propose coordinates for the birding sites (candidates, not answers). |

### The archive

`archive/` and `dist-archive/` are **gitignored**. The archive is ~500MB–1GB of 2005-era
JPEGs and MP3s; its durable home is the BCS Google Drive, not this repository.
`pixi run archive-pack` produces a single `.tar.gz` with a `SHA256SUMS` and a README inside
explaining what it is and how it is laid out, readable without any of this tooling.

**This is the only complete copy of the original BirdWeb.** Keep it somewhere safe.

## Editing content

`pixi run editor` starts a local app at http://localhost:5173 that reads and writes the
YAML in `src/content/` directly. Commit the changes and push; GitHub Actions builds and
deploys. There is no CMS and no database — the files in git are the content.

## Layout

```
src/
├── content.config.ts       zod schemas — the contract for everything below
├── content/                species/ sites/ ecoregions/ families/ orders/  (YAML)
├── config/                 ecoregions, abundance codes, taxonomy overrides
├── lib/                    pure functions (Vitest-covered)
├── components/             presentation, incl. kiosk/ for the storefront display
└── pages/                  routes
scripts/                    the mirror/extract/verify pipeline (Python, Typer)
tools/birdweb-editor/       the local content editor (Vite + React)
```

Pure logic lives in `src/lib/`, domain constants in `src/config/`, presentation in
components. `src/lib/abundance.ts` is the interesting one — it is entirely pure functions
over `(matrix, ecoregion, month)`, so the season-summary edge cases (a winter visitor
present Nov–Feb must read as one range, not two) are tested without a browser.

### Two things that are load-bearing

1. **`ECOREGIONS` order in `src/config/ecoregions.ts`.** Abundance arrays are positional.
   Reordering that list silently reassigns ~59,000 data cells to the wrong regions.
2. **`import.meta.env.BASE_URL` on every internal link.** The site deploys to
   `entilzha.github.io/bcs-birdweb/`, so a hardcoded `/` ships a page of 404s.

## Routes

`/` search-first landing · `/birds/` · `/birds/<slug>/` · `/families/<slug>/` ·
`/orders/<slug>/` · `/sites/` · `/sites/<slug>/` · `/ecoregions/` · `/ecoregions/<slug>/` ·
`/whats-around/` · `/kiosk/` · `/credits/` · `/about/`

`/whats-around/` inverts the abundance data — pick a region and a month, get what is there.
`/kiosk/` is the storefront touchscreen: big type, one-tap search, QR hand-off to a phone,
idle reset.

## Deploying

Push to `main`. The workflow type-checks, runs the tests, builds, and deploys to GitHub
Pages. This is a Sapling repository — use `sl`, and never push to `main` without asking.

## Open items

- **eBird / Macaulay integration.** Every species carries an `ebird_code`, so recent
  sightings and supplementary media are additive work once BCS confirms an API key.
- **Photo and audio licensing.** Photographs belong to the individual photographers
  credited on each page; the audio was licensed with BirdNote funding. Credits carry over
  verbatim, but BCS should confirm nothing was scoped to the old site.
- **birdweb.org DNS.** Recovering the domain preserves every inbound link and BCS's own
  printed references.
- **Site coordinates.** The legacy site pages have none, so all 69 need placing and
  checking by hand before the map ships.
- **Taxonomy review.** `src/config/taxonomy-overrides.yaml` holds 20 decisions about which
  daughter species occurs in Washington. The reasoning is written down; the BCS Science
  Committee owns the call.
