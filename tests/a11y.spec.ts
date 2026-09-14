import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * WCAG 2.1 A/AA, on every kind of page.
 *
 * An axe run found 854 colour-contrast failures and one critical violation on this site,
 * and neither was visible without a tool: the contrast came from secondary-text opacities
 * chosen by eye (black/50 on cream is 3.9:1 where AA wants 4.5:1), and the critical one
 * was the kiosk disabling pinch-zoom on a display meant for the public.
 */

const BASE = "/bcs-birdweb";

const PAGES: Array<[string, string]> = [
  ["home", "/"],
  ["species", "/birds/mallard/"],
  ["species with taxonomy note", "/birds/northwestern_crow/"],
  ["birds index", "/birds/"],
  ["birds a-z", "/birds/a-z/"],
  ["family", "/families/anatidae/"],
  ["order", "/orders/anseriformes/"],
  ["sites", "/sites/"],
  ["site", "/sites/marymoor_park/"],
  ["ecoregions", "/ecoregions/"],
  ["ecoregion", "/ecoregions/puget_trough/"],
  ["what's around", "/whats-around/"],
  ["species of concern", "/species-of-concern/"],
  ["credits", "/credits/"],
  ["about", "/about/"],
  ["resources", "/resources/"],
  ["kiosk", "/kiosk/"],
];

for (const [name, path] of PAGES) {
  test(`${name} has no WCAG 2.1 A/AA violations`, async ({ page }) => {
    // Phone width: the narrowest layout is where contrast and target-size problems bite.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(BASE + path);
    await page.waitForLoadState("networkidle");

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();

    // Name the offending element in the failure, or the report is unactionable.
    const summary = results.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      nodes: v.nodes.length,
      first: v.nodes[0]?.html?.slice(0, 120),
    }));
    expect(summary).toEqual([]);
  });
}
