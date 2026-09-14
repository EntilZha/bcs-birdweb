# BirdWeb — notes for Claude

A rebuild of [birdweb.org](https://birdweb.org/birdweb/), Birds Connect Seattle's guide to
the birds of Washington. Read this before changing anything; most of it is the reasoning
behind decisions that look arbitrary from the outside.

## What this project is

BCS volunteers wrote these 491 species accounts starting in 1999. The original site's
source code and database were **lost**, and its host — an unmaintained IIS 7.5 box — can no
longer be administered by anyone at BCS. The live site was the only surviving copy. BCS
staff endorsed this rebuild on 2026-09-11.

Two consequences run through everything:

1. **The archive is the point.** If a change would risk `archive/`, don't make it.
2. **The prose is a historical document.** BCS volunteers wrote it; we reproduce it, never
   rewrite it. Where taxonomy has moved on we *add* a layer alongside.

## Commands

Everything goes through pixi — never invoke `npm`, `python`, `pytest` or `playwright`
directly. `pixi run` with no argument lists the tasks.

```
pixi run dev            # site at http://localhost:4321/bcs-birdweb/   (note the base path)
pixi run editor         # content editor at http://127.0.0.1:5173
pixi run test-all       # Vitest + pytest + Playwright
```

Pipeline: `mirror` → `extract` → `taxonomy` → `images`, then `verify`, `audit-live`,
`archive-pack`, `geocode`.

## Things that will bite you

**`ECOREGIONS` order in `src/config/ecoregions.ts` is positional.** Abundance arrays index
into it. Reordering that list silently reassigns ~59,000 data cells to the wrong regions.

**Every internal link needs `import.meta.env.BASE_URL`.** The site deploys under
`/bcs-birdweb/`. A hardcoded `/` ships a page of 404s and the build will not warn you.

**`extract` must never own fields it did not produce.** It preserves site coordinates and
the species `taxonomy` block (see `PRESERVED_FIELDS`). It once wiped all 69 geocodes and
all 491 taxonomy blocks silently, and a confirmed pin cannot be recomputed — only
re-confirmed by a person.

**The two YAML writers must stay byte-identical.** `scripts/extract_birdweb.py` and
`tools/birdweb-editor/src/server/contentApi.ts` both write `src/content/`. If they drift,
the first edit to a species reformats the whole file and buries the real change. The one
place they disagreed was abundance rows: PyYAML emits them in flow style, js-yaml has no
per-key style control, so the editor renders that block by hand. Tested both sides.

**Pin confidence is a two-state thing, and the map must show which.** `src/lib/sites.ts`
plots every in-Washington coordinate but marks anything that is not exactly
`geocode_source: "confirmed"` as *approximate*, drawn hollow and dashed with a caption that
says so. The test is positive for `"confirmed"`, not a blocklist, so a source string
invented later cannot arrive claiming more confidence than it has earned. A coordinate
outside Washington is dropped whatever its source — that is a transposed sign, not an
approximation.

**Don't pick colours by eye.** Secondary text uses `--color-ink`, `--color-ink-muted`,
`--color-ink-faint`, whose contrast ratios against the cream background were measured. The
opacities that *look* right fail AA: `black/50` on cream is 3.9:1. A test fails the build
if any raw `text-black/N` reappears.

## Architecture

```
archive/            raw mirror of the legacy site — GITIGNORED, ~0.5GB, the only full copy
src/content/        the source of truth: species/ sites/ ecoregions/ pages/ families/ orders/
src/content.schemas.ts   zod schemas, imported by Astro AND by the editor's Vite plugin
src/lib/            pure functions, Vitest-covered
src/config/         ecoregions, abundance codes, taxonomy overrides
scripts/            the Python pipeline (Typer CLIs) + pytest suite
tools/birdweb-editor/    local Vite+React editor; backend is a Vite plugin writing YAML
tests/              Playwright, against a production build
```

**Two-stage scrape.** `mirror` is the only thing that touches the legacy server, and it is
meant to run once. Everything downstream parses the local mirror offline, so iterating on a
parser is free and the fragile box is hit as little as possible.

**No CMS, no database.** The YAML files in version control are the content. The editor is a
local app that reads and writes them.

## Verification — four checks, each catching what the others cannot

| | |
|---|---|
| `pixi run verify` | the data's internal shape: counts, required fields, 12×10 abundance, asset references, orphans |
| `pixi run test-py` | the parsers, against fixtures (35 tests) |
| `pixi run audit-live` | 10 edge-case species re-fetched from the live site, diffed field by field |
| `pixi run test` + `test-e2e` | pure logic (56) and browser behaviour (91) |

`audit-live` is deliberately a **separate implementation** from the extractor — substring
matching over raw HTML, not the extractor's selectors — because a check that shares the code
it checks proves nothing. It is what would catch a selector quietly grabbing the wrong
element on every page.

Bugs the browser suite caught that nothing else could see: 854 contrast failures, the kiosk
disabling pinch-zoom, a grid column forcing 474px inside a 343px container, a
`/whats-around/` link that overwrote itself on open, and an ecoregion checklist table
flattened into a paragraph.

## Deliberate design decisions

**No tabs, anywhere.** The legacy site used them, and that is how the abundance matrix
ended up buried at the bottom of one. Species pages get a jump nav instead. Don't "restore"
tabs.

**The sites map is inline SVG, not a tile map.** A slippy map means a third-party
dependency on every page view: a key to manage, a service that can rate-limit the storefront
display, and a grey box when shop wifi drops. The whole state is one 12KB path — no JS, no
network, no key, and it prints.

**`/sites/` renders no map when there is nothing to plot.** An empty state outline is not a
placeholder; it reads as a rendering failure and pushes the list that works below the fold.

**Approximate pins are shown rather than withheld.** The first version refused anything
unconfirmed, reasoning that a wrong pin sends someone to the wrong place. That is correct
for a navigation map and wrong for this one: the whole state renders in ~1000 units, so a
marker covers about 8km and says only "this part of Washington", and every site page
carries the original directions prose people actually navigate by. Withholding them left
the map empty for months. Showing them *as though confirmed* would still be wrong, hence
the two marker styles.

**The geocoder refuses rather than guesses.** Its first version proposed an apartment
building for Samish Flats, a fire station for Green Lake, a notice board for Naches Peak —
each a plausible-looking row a reviewer could wave through. It now scores candidates on what
OSM says the thing *is* and requires a name match. A blank asks a human to do the work; a
wrong pin invites them to accept it.

**Taxonomy matching is common-name-first and only auto-applies when both names agree.**
Matching on the 2005 binomial alone relabels Washington's Barn Owl as the Eurasian Western
Barn Owl — and did, for eight species, before this was fixed. The 20 genuine decisions live
in `src/config/taxonomy-overrides.yaml` with their reasoning, for the BCS Science Committee.

## Working style in this repo

- Sapling, not git. `sl add` before committing. **Never push to `main` without asking.**
- There is no remote yet. Nothing is deployed.
- Prefer fixing the extractor over hand-editing `src/content/` — 491 records came out of a
  parser and will come out of it again.
- When something looks like a layout bug, check whether it is a content bug first. The
  ecoregion overflow was a 266-row table poured into a `<p>`.

## Open items needing a person

1. **Confirm 69 site pins** in the editor — 41 are on the map as approximate and need
   checking, 28 need placing by hand. Confirming promotes a marker from dashed to solid.
2. **Science Committee review** of `src/config/taxonomy-overrides.yaml`.
3. **Upload the archive tarball** (`dist-archive/`) to the BCS Google Drive.
4. **Push to GitHub, enable Pages.** `.github/workflows/deploy.yml` is ready.
5. **birdweb.org DNS**, **photo/audio licensing** confirmation, **eBird API key** — all
   with BCS. Every species already carries an `ebird_code` for when the key arrives.
