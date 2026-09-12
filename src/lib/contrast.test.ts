import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Guards the contrast fix from creeping back.
 *
 * An axe run over this site once reported 854 colour-contrast violations, all from
 * `text-black/50` and lighter on the cream background: 3.9:1 where WCAG 2.1 AA wants 4.5:1
 * for text of any size below 18pt. The opacities that look right are not the ones that
 * pass, so the palette now lives in named tokens whose ratios were measured
 * (`--color-ink`, `--color-ink-muted`, `--color-ink-faint` in src/styles/global.css).
 *
 * A raw opacity utility for *text* bypasses that and cannot be checked by eye, so it fails
 * here. Opacity on backgrounds, rings and borders is fine and deliberately not matched.
 */

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.(astro|tsx|ts|css)$/.test(name) && !name.endsWith(".test.ts")) out.push(path);
  }
  return out;
}

describe("text colour", () => {
  const files = sourceFiles("src");

  it("finds source files to check", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("uses no raw black text opacity, which cannot be contrast-checked by eye", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/text-black\/\d+/g)) {
        offenders.push(`${file}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the measured ink tokens defined", () => {
    const css = readFileSync("src/styles/global.css", "utf8");
    for (const token of ["--color-ink:", "--color-ink-muted:", "--color-ink-faint:"]) {
      expect(css).toContain(token);
    }
  });

  it("keeps zoom enabled on every layout, including the storefront display", () => {
    // Disabling pinch-zoom on a public display fails WCAG 2.1 SC 1.4.4, and the people
    // most likely to need it are the ones standing at a shop screen.
    for (const layout of sourceFiles("src/layouts")) {
      const text = readFileSync(layout, "utf8");
      const viewport = /<meta\s+name="viewport"[^>]*>/.exec(text)?.[0] ?? "";
      expect(viewport, layout).not.toMatch(/user-scalable\s*=\s*no/);
      expect(viewport, layout).not.toMatch(/maximum-scale/);
    }
  });
});
