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
          // Elements inside a deliberate scroll container are allowed to be wider than the
          // viewport -- that is what the container is for. Everything else is a bug.
          const inScroller = (el: Element) => {
            for (let e: Element | null = el; e; e = e.parentElement) {
              const o = getComputedStyle(e).overflowX;
              if (o === "auto" || o === "scroll") return true;
            }
            return false;
          };
          const vw = document.documentElement.clientWidth;
          const over = [...document.querySelectorAll("body *")].filter(
            (e) => e.getBoundingClientRect().right > vw + 1 && !inScroller(e),
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

test.describe("sites map", () => {
  test("draws approximate pins differently from confirmed ones", async ({ page }) => {
    await page.goto(BASE + "/sites/");
    await page.waitForLoadState("networkidle");

    const map = page.locator("figure svg");
    const markers = await map.locator("a circle:not([fill=transparent])").count();
    if (markers === 0) {
      // No empty outline: it reads as a rendering failure.
      await expect(page.locator("figure")).toHaveCount(0);
      await expect(page.getByText("A map is coming")).toBeVisible();
      return;
    }

    const approximate = await map.locator("a circle[stroke-dasharray]").count();
    const confirmed = await map.locator("a circle[stroke=white]").count();
    expect(approximate + confirmed).toBe(markers);

    // An unchecked pin must never be drawn as though someone had checked it.
    if (approximate > 0) {
      await expect(page.locator("figcaption")).toContainText(`${approximate} approximate`);
      await expect(page.locator("figcaption")).toContainText("placed automatically");
      await expect(map.locator("a[aria-label*='approximate location']").first()).toBeAttached();
    }
    if (confirmed > 0) {
      await expect(page.locator("figcaption")).toContainText(`${confirmed} confirmed`);
    }
  });

  test("a marker opens its site", async ({ page }) => {
    await page.goto(BASE + "/sites/");
    await page.waitForLoadState("networkidle");
    const marker = page.locator("figure svg a").first();
    if ((await marker.count()) === 0) test.skip();
    const href = await marker.getAttribute("href");
    await marker.click();
    await expect(page).toHaveURL(new RegExp(`${href}$`));
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
