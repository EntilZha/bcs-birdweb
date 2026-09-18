import { expect, test, type Page } from "@playwright/test";

/**
 * Browser checks for the things that only fail in a browser.
 *
 * These were run ad-hoc while building the site and caught most of its real bugs: 854
 * contrast failures, a kiosk that disabled pinch-zoom, a grid column that forced a 474px
 * width inside a 343px container, a shared /whats-around/ link that overwrote itself on
 * open, and an ecoregion checklist table flattened into a paragraph. None of those were
 * visible to `astro check`, to Vitest, or to reading the page source.
 *
 * Running them by hand is how they stop being run, so they live here.
 */

const BASE = "/bcs-birdweb";

const PAGES: Array<[name: string, path: string]> = [
  ["home", "/"],
  ["species", "/birds/mallard/"],
  ["birds index", "/birds/"],
  ["birds a-z", "/birds/a-z/"],
  ["sites", "/sites/"],
  ["ecoregion", "/ecoregions/puget_trough/"],
  ["site", "/sites/marymoor_park/"],
  ["what's around", "/whats-around/"],
  ["species of concern", "/species-of-concern/"],
  ["resources", "/resources/"],
  ["credits", "/credits/"],
  ["kiosk", "/kiosk/"],
];

/** The four the plan named: iPhone, iPad, desktop, storefront panel. */
const VIEWPORTS: Array<[name: string, width: number, height: number]> = [
  ["iPhone", 375, 667],
  ["iPad", 768, 1024],
  ["desktop", 1440, 900],
  ["kiosk", 1920, 1080],
];

/** Scroll the whole page so lazy images commit, then return to the top. */
async function settle(page: Page) {
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += window.innerHeight) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 80));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(400);
}

test.describe("layout", () => {
  for (const [vpName, width, height] of VIEWPORTS) {
    for (const [pageName, path] of PAGES) {
      test(`${pageName} does not overflow at ${vpName}`, async ({ page }) => {
        await page.setViewportSize({ width, height });
        await page.goto(BASE + path);
        await page.waitForLoadState("networkidle");

        const result = await page.evaluate(() => {
          window.scrollTo(500, 0);
          const panned = window.scrollX > 0;
          window.scrollTo(0, 0);
          // Elements inside a deliberate clipping container are allowed to be wider than
          // the viewport -- that is what the container is for. `hidden` counts as well as
          // `auto`/`scroll`: a tile map lays its tiles out past its own edges and relies
          // on overflow:hidden to crop them, and reading only auto/scroll reports every
          // tile as an overflow bug.
          const clipped = (el: Element) => {
            for (let e: Element | null = el; e; e = e.parentElement) {
              const o = getComputedStyle(e).overflowX;
              if (o === "auto" || o === "scroll" || o === "hidden") return true;
            }
            return false;
          };
          const vw = document.documentElement.clientWidth;
          const over = [...document.querySelectorAll("body *")].filter(
            (e) => e.getBoundingClientRect().right > vw + 1 && !clipped(e),
          );
          return {
            panned,
            bodyWidth: document.body.scrollWidth,
            viewportWidth: vw,
            overflowing: over.map((e) => `${e.tagName.toLowerCase()}.${e.className}`.slice(0, 80)),
          };
        });

        expect(result.panned, "page must not pan horizontally").toBe(false);
        expect(result.overflowing).toEqual([]);
        expect(result.bodyWidth).toBeLessThanOrEqual(result.viewportWidth + 1);
      });
    }
  }
});

test.describe("images", () => {
  for (const [pageName, path] of PAGES) {
    test(`${pageName} has no broken images`, async ({ page }) => {
      const failed: string[] = [];
      page.on("response", (r) => {
        if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`);
      });
      await page.goto(BASE + path);
      await page.waitForLoadState("networkidle");
      await settle(page);

      const broken = await page.evaluate(() =>
        [...document.querySelectorAll("img")]
          .filter((i) => i.complete && i.naturalWidth === 0)
          .map((i) => i.currentSrc || i.src),
      );
      expect(broken).toEqual([]);
      expect(failed).toEqual([]);
    });
  }
});

test.describe("console", () => {
  for (const [pageName, path] of PAGES) {
    test(`${pageName} logs no errors`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      page.on("console", (m) => {
        // React hydration mismatches surface as warnings, and they matter here: every
        // interactive part of this site is an island hydrated from prerendered HTML.
        if (m.type() === "error" || m.text().includes("hydrat")) errors.push(m.text());
      });
      await page.goto(BASE + path);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(600);
      expect(errors).toEqual([]);
    });
  }
});

/** Wait for an island to hydrate before driving it. */
async function search(page: Page, text: string) {
  await page.waitForLoadState("networkidle");
  const input = page.locator("input[type=search]").first();
  await input.waitFor({ state: "visible" });
  await expect
    .poll(async () => page.evaluate(() => document.querySelectorAll("astro-island[ssr]").length))
    .toBe(0);
  await input.click();
  await input.pressSequentially(text, { delay: 15 });
  await page.waitForTimeout(400);
}

test.describe("search", () => {
  test("finds a bird by its current name, by keyboard alone", async ({ page }) => {
    await page.goto(BASE + "/");
    await search(page, "varied thr");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/birds\/varied_thrush\/$/);
  });

  test("finds a bird by the name BirdWeb published it under", async ({ page }) => {
    // Someone with a 2005 field guide looks up Gray Jay, not Canada Jay.
    await page.goto(BASE + "/");
    await search(page, "gray jay");
    await expect(page.locator("#search-results li").first()).toContainText("Canada Jay");
  });

  test("finds a bird by scientific name", async ({ page }) => {
    await page.goto(BASE + "/");
    await search(page, "Ixoreus");
    await expect(page.locator("#search-results li").first()).toContainText("Varied Thrush");
  });

  test("does not steal focus on a touch device", async ({ browser }) => {
    // Autofocus there raises the on-screen keyboard over the page before anyone asked.
    const context = await browser.newContext({
      viewport: { width: 390, height: 800 },
      hasTouch: true,
      isMobile: true,
    });
    const page = await context.newPage();
    await page.goto(BASE + "/");
    await page.waitForTimeout(600);
    expect(await page.evaluate(() => document.activeElement?.tagName.toLowerCase())).toBe("body");
    await context.close();
  });
});

test.describe("whats-around", () => {
  test("restores a shared link instead of overwriting it", async ({ page }) => {
    await page.goto(BASE + "/whats-around/?region=okanogan&month=1&min=5");
    await page.waitForTimeout(700);
    await expect(page.locator("select").first()).toHaveValue("okanogan");
    await expect(page.locator("select").nth(1)).toHaveValue("0");
    await expect(page).toHaveURL(/region=okanogan/);
  });

  test("falls back cleanly on a mangled link", async ({ page }) => {
    // month=99 would index past the end of a twelve-cell abundance row.
    await page.goto(BASE + "/whats-around/?region=atlantis&month=99");
    await page.waitForTimeout(700);
    await expect(page.locator("select").first()).toHaveValue("puget_trough");
    await expect(page.getByRole("heading", { level: 2 }).first()).toContainText("species");
  });

  test("an ecoregion page links to its own filtered view", async ({ page }) => {
    await page.goto(BASE + "/ecoregions/okanogan/");
    await page.click("main a[href*='whats-around/?region=']");
    await page.waitForTimeout(700);
    await expect(page.locator("select").first()).toHaveValue("okanogan");
  });
});

test.describe("abundance grid", () => {
  test("keeps the ecoregion label visible while the months scroll", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto(BASE + "/birds/mallard/");
    await page.waitForLoadState("networkidle");
    const label = page.locator("th[scope=row]").first();
    const before = (await label.boundingBox())!.x;
    await page.locator("#abundance div.overflow-x-auto").evaluate((e) => {
      e.scrollLeft = 300;
    });
    await page.waitForTimeout(300);
    const after = (await label.boundingBox())!.x;
    // Sticky, allowing for the table's border-spacing.
    expect(Math.abs(after - before)).toBeLessThan(4);
    await expect(label).toBeVisible();
  });
});

test.describe("ecoregion map", () => {
  // The map is a client:only island on a tile basemap, so it needs a scroll and a beat.
  async function openMap(page: import("@playwright/test").Page, path: string) {
    await page.goto(BASE + path);
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => window.scrollTo(0, 300));
    await page.waitForSelector(".leaflet-container", { timeout: 15000 });
    await page.waitForTimeout(1500);
  }

  test("draws all ten regions with their numbers", async ({ page }) => {
    await openMap(page, "/ecoregions/");
    const labels = await page.locator(".leaflet-marker-icon").allTextContents();
    expect(labels.map((t) => t.trim()).sort()).toEqual(
      ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"].sort(),
    );
  });

  test("region numbers do not sit on top of each other", async ({ page }) => {
    // A bounds-centre label falls outside any concave shape; Oceanic's landed on its
    // neighbour's. Labels come from a precomputed interior point instead.
    await openMap(page, "/ecoregions/");
    const boxes = await page.locator(".leaflet-marker-icon").evaluateAll((els) =>
      els.map((e) => e.getBoundingClientRect()).map((r) => ({ x: r.x, y: r.y })),
    );
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const d = Math.hypot(boxes[i].x - boxes[j].x, boxes[i].y - boxes[j].y);
        expect(d, `labels ${i} and ${j} overlap`).toBeGreaterThan(12);
      }
    }
  });

  test("clicking a region opens it", async ({ page }) => {
    await openMap(page, "/ecoregions/");
    await page.locator("path.leaflet-interactive").first().click({ force: true });
    await page.waitForTimeout(800);
    expect(page.url()).toMatch(/\/ecoregions\/[a-z_]+\/$/);
  });

  test("the regions are navigable before the island loads", async ({ browser }) => {
    // The legend is server-rendered on purpose: the map is client:only, so with
    // JavaScript off there would otherwise be nothing to click.
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto(BASE + "/ecoregions/");
    const links = await page.locator("a[href*='/ecoregions/']").count();
    expect(links).toBeGreaterThanOrEqual(10);
    await context.close();
  });

  test("the kiosk stays a lookup screen, with no tile map", async ({ page }) => {
    // Scope, not resilience: the storefront screen is for finding a species mid-
    // conversation, and Leaflet would add ~45KB to a page that already ships every
    // species. If that trade ever changes, delete this test rather than working around it.
    await page.goto(BASE + "/kiosk/");
    await page.waitForLoadState("networkidle");
    await expect(page.locator(".leaflet-container")).toHaveCount(0);
  });

  test("the map scrolls under the sticky header, not over it", async ({ page }) => {
    // Leaflet's panes are z-index 400 and its controls 800-1000, and `.leaflet-container`
    // opens no stacking context of its own, so those numbers competed with the page's own
    // and the map painted straight over the z-30 header while scrolling.
    await openMap(page, "/ecoregions/pacific_northwest_coast/");

    // Scroll so the header band sits halfway down the map — the only window in which the
    // two can overlap at all. A fixed offset is worthless here: scroll far enough and the
    // map is above the header, which passes without testing anything.
    const band = await page.evaluate(() => {
      const m = document.querySelector(".leaflet-container")!.getBoundingClientRect();
      const h = document.querySelector("header")!.getBoundingClientRect();
      return { target: window.scrollY + m.top + m.height / 2 - h.height, headerHeight: h.height };
    });
    await page.evaluate((y) => window.scrollTo(0, y), band.target);
    await page.waitForTimeout(400);

    const overlap = await page.evaluate(() => {
      const m = document.querySelector(".leaflet-container")!.getBoundingClientRect();
      const h = document.querySelector("header")!.getBoundingClientRect();
      const y = h.top + h.height / 2;
      if (y < m.top || y > m.bottom) return null; // no overlap to test — the test is void
      const probes: { x: number; covered: boolean }[] = [];
      for (const f of [0.25, 0.5, 0.75, 0.9]) {
        const x = m.left + m.width * f;
        const el = document.elementFromPoint(x, y);
        probes.push({ x: Math.round(x), covered: !!el?.closest(".leaflet-container") });
      }
      return probes;
    });

    expect(overlap, "the map and header do not overlap — reposition the scroll").not.toBeNull();
    for (const probe of overlap!) {
      expect(probe.covered, `the map covers the header at x=${probe.x}`).toBe(false);
    }
  });

  test("a region page frames its region, not the whole state", async ({ page }) => {
    // Fitting every page to Washington left a region's sites as a cluster of dots a
    // fingernail wide — not a view you can plan a morning from.
    //
    // Read the zoom off the tile URLs (.../{z}/{x}/{y}.png). The obvious metric — what
    // share of the map the region's polygon covers — looks right and is worthless: the
    // region page's map is a 457px sidebar and the index's is 1120px, so fitting the same
    // bounds to different aspect ratios changes that share on its own. It passed with the
    // zoom deliberately reverted.
    const zoomOf = async (path: string) => {
      await openMap(page, path);
      return page.evaluate(() => {
        const tile = document.querySelector(".leaflet-tile") as HTMLImageElement | null;
        const m = tile?.src.match(/\/(\d+)\/\d+\/\d+\.png/);
        return m ? Number(m[1]) : NaN;
      });
    };
    const onIndex = await zoomOf("/ecoregions/");
    const onOwnPage = await zoomOf("/ecoregions/pacific_northwest_coast/");
    expect(onIndex).toBeGreaterThan(0);
    expect(onOwnPage, `region page zoom ${onOwnPage} vs index ${onIndex}`).toBeGreaterThan(
      onIndex,
    );
  });

  test("the site list works whether or not the map does", async ({ page }) => {
    await page.goto(BASE + "/sites/");
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("69 of 69 sites")).toBeVisible();
    await page.getByRole("button", { name: /^Okanogan/ }).click();
    await page.waitForTimeout(300);
    await expect(page.getByText(/of 69 sites/)).toContainText("5 of 69");
  });
});

test.describe("indexing", () => {
  // src/config/site.ts gates this. The flag exists so the review-pending state is one line
  // to reverse; these fail if it is flipped without meaning to, and if the meta tag and
  // robots.txt ever disagree — which is exactly what a static public/robots.txt would let
  // happen.
  test("pages carry noindex while BCS review is pending", async ({ page }) => {
    for (const path of ["/", "/birds/mallard/", "/ecoregions/", "/kiosk/"]) {
      await page.goto(BASE + path);
      const robots = page.locator('meta[name="robots"]');
      await expect(robots, `no robots meta on ${path}`).toHaveCount(1);
      await expect(robots).toHaveAttribute("content", /noindex/);
    }
  });

  test("robots.txt agrees with the meta tag", async ({ request, page }) => {
    const res = await request.get(BASE + "/robots.txt");
    expect(res.status()).toBe(200);
    const body = await res.text();

    await page.goto(BASE + "/");
    const noindexed = (await page.locator('meta[name="robots"]').count()) > 0;
    expect(
      body.includes("Disallow: /"),
      `robots.txt says ${JSON.stringify(body.trim())} but the page is ${noindexed ? "" : "not "}noindexed`,
    ).toBe(noindexed);
  });
});

test.describe("kiosk", () => {
  test("search is reachable and opens a species without leaving the screen", async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(BASE + "/kiosk/");
    await search(page, "varied thrush");
    await page.locator("main button").first().click();
    await page.waitForTimeout(600);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Varied Thrush");
    // Still one screen: the kiosk never navigates away from itself.
    await expect(page).toHaveURL(/\/kiosk\/$/);
  });

  test("allows zoom, because the people at a shop screen may need it", async ({ page }) => {
    await page.goto(BASE + "/kiosk/");
    const viewport = await page.locator('meta[name="viewport"]').getAttribute("content");
    expect(viewport).not.toContain("user-scalable=no");
    expect(viewport).not.toContain("maximum-scale");
  });
});

test.describe("taxonomy", () => {
  test("an absorbed account keeps its own title and explains the merge", async ({ page }) => {
    await page.goto(BASE + "/birds/northwestern_crow/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Northwestern Crow");
    await expect(page.getByText(/Now treated as/)).toContainText("American Crow");
    await expect(page.getByText(/merged in 2020/)).toBeVisible();
  });

  test("a renamed species leads with its current name", async ({ page }) => {
    await page.goto(BASE + "/birds/gray_jay/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Canada Jay");
    await expect(page.getByText(/Published on BirdWeb as Gray Jay/)).toBeVisible();
  });
});
