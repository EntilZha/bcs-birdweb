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
| `pixi run audit-live` | Re-fetch 10 edge-case species and diff them field-by-field against the live site. |
| `pixi run taxonomy` | Attach the eBird taxonomy layer to each species. |
| `pixi run images` | Convert archived photos and maps to WebP under `src/assets/`. |
| `pixi run geocode` | Propose coordinates for the birding sites (candidates, not answers). |
| `pixi run test` | Vitest over `src/lib/`. |
| `pixi run test-py` | pytest over the pipeline scripts. |
| `pixi run test-all` | Both suites. |

### The archive

`archive/` and `dist-archive/` are **gitignored**. The archive is ~500MB–1GB of 2005-era
JPEGs and MP3s; its durable home is the BCS Google Drive, not this repository.
`pixi run archive-pack` produces a single `.tar.gz` with a `SHA256SUMS` and a README inside
explaining what it is and how it is laid out, readable without any of this tooling.

**This is the only complete copy of the original BirdWeb.** Keep it somewhere safe.

## Editing content

`pixi run editor` starts a local app at http://127.0.0.1:5173 that reads and writes the
YAML in `src/content/` directly. There is no CMS and no database — the files in git are
the content.

It has a species editor (including a click-and-drag grid for the abundance matrix), a site
editor with a map for placing pins, a photo caption/credit editor, and a publishing panel.
Publishing is two separate buttons on purpose: **Save to this computer** commits locally
and is reversible; **Save and publish** also pushes, which is visible to the world and
triggers a deploy.

Its YAML writer is byte-identical to the Python one, so changing one abundance cell
produces a one-line diff. That is load-bearing and covered by tests — if the two writers
ever drift, the first edit to a species reformats the whole file and buries the real
change.

### Confirming the birding-site pins

The legacy pages carry no coordinates, so all 69 are net-new data.

- **41** have a geocoder proposal that needs checking.
- **28** found no candidate worth proposing and need a pin dropped by hand.
- **0** are confirmed, so the map on `/sites/` is currently empty by design.

Open a site in the editor, look at where the pin sits, and press **Confirm this pin**.
Only confirmed pins are ever plotted — `src/lib/sites.ts` tests for `confirmed`
explicitly rather than excluding known-bad values, so a source string invented later
cannot leak onto the map by being unlisted.

The geocoder is deliberately conservative. Its first version took Nominatim's top hit and
proposed an apartment building for Samish Flats, a fire station for Green Lake and a notice
board for Naches Peak Loop — each a plausible-looking row in a table that a reviewer could
wave through. Candidates are now scored on what OpenStreetMap says the thing *is*, and
anything that does not clear the bar is reported as no match, because a blank asks you to
do the work while a wrong pin invites you to accept it.

## Layout

```
src/
├── content.config.ts       zod schemas — the contract for everything below
├── content/                species/ sites/ ecoregions/ families/ orders/  (YAML)
├── config/                 ecoregions, abundance codes, taxonomy overrides
├── lib/                    pure functions (Vitest-covered)
├── data/                   vendored Washington outline for the locator map
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
`/whats-around/` · `/kiosk/` · `/species-of-concern/` · `/credits/` · `/about/`

Ported from the legacy site as content: `/resources/` · `/abundance-codes/` ·
`/what-is-an-ecoregion/` · `/about-birding-sites/` · `/audio-sources/`

`/whats-around/` inverts the abundance data — pick a region and a month, get what is there.
`/kiosk/` is the storefront touchscreen: big type, one-tap search, QR hand-off to a phone,
idle reset.

## Deploying

Push to `main`. The workflow type-checks, runs the tests, builds, and deploys to GitHub
Pages. This is a Sapling repository — use `sl`, and never push to `main` without asking.

## How it is verified

Four independent checks, because each catches what the others cannot:

- **`pixi run verify`** — the data's internal shape: counts, required fields, 12×10
  abundance, every asset reference resolvable, no orphans.
- **`pixi run test-py`** — the parsers, against fixtures. 35 tests.
- **`pixi run audit-live`** — 10 edge-case species re-fetched from the live site and
  compared field by field. Deliberately a *separate* implementation from the extractor
  (substring matching over raw HTML, not the extractor's selectors), because a check that
  shares the code it is checking proves nothing. This is what would catch a selector
  quietly grabbing the wrong element on every page.
- **`pixi run test`** — the site's pure logic. 55 tests, including that an unconfirmed pin
  can never reach the map and that no text uses an opacity too light to pass WCAG AA.

The archive has its own: `pixi run verify-archive` re-hashes every file against the
manifest, and `archive/browsable/` is checked by driving it in a browser with every
non-`file://` request aborted.

## What still needs a person

1. **Confirm the 69 site pins** (see above). This is the largest remaining piece of
   content work and the only thing blocking the map.
2. **Review `src/config/taxonomy-overrides.yaml`.** Twenty species needed a judgement about
   which daughter species occurs in Washington — Barn Owl, Herring Gull, Whimbrel and
   friends, all post-2005 splits where the old binomial stayed with the Old World bird.
   Each entry records the reasoning; the BCS Science Committee owns the call.
3. **Publish the archive.** `dist-archive/birdweb-archive-*.tar.gz` and its `SHA256SUMS`
   need to reach the BCS Google Drive. It is the only complete copy of the original site.
4. **Push to GitHub and turn on Pages.** The repository has no remote yet, so nothing is
   deployed. `.github/workflows/deploy.yml` is ready and runs the full gate first.

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
