import { describe, expect, it } from "vitest";
import {
  codeAt,
  ecoregionsPresent,
  isRecordedAnywhere,
  peakInEcoregion,
  seasonSummary,
  speciesPresentIn,
  type AbundanceMatrix,
  type MonthIndex,
} from "./abundance";
import { ECOREGION_SLUGS } from "../config/ecoregions";
import type { AbundanceCode } from "../config/abundance";

const blank = (): AbundanceMatrix =>
  Object.fromEntries(ECOREGION_SLUGS.map((s) => [s, Array(12).fill("") as AbundanceCode[]]));

function withRegion(slug: string, codes: string): AbundanceMatrix {
  const m = blank();
  m[slug] = codes.split("").map((c) => (c === "-" ? "" : c)) as AbundanceCode[];
  return m;
}

describe("codeAt", () => {
  it("reads a cell", () => {
    expect(codeAt(withRegion("puget_trough", "CCCCCCCCCCCC"), "puget_trough", 0)).toBe("C");
  });

  it("treats an unknown ecoregion as not recorded rather than throwing", () => {
    expect(codeAt({}, "okanogan", 5)).toBe("");
  });
});

describe("seasonSummary", () => {
  it("calls a full year year-round", () => {
    expect(seasonSummary(withRegion("puget_trough", "CCCCCCCCCCCC"), "puget_trough"))
      .toBe("Year-round");
  });

  it("reports absence", () => {
    expect(seasonSummary(blank(), "oceanic")).toBe("Not recorded");
  });

  it("summarizes a simple summer run", () => {
    // Present Apr-Aug.
    expect(seasonSummary(withRegion("east_cascades", "---FFFFF----"), "east_cascades"))
      .toBe("Apr–Aug");
  });

  it("wraps a winter visitor across the year end instead of splitting it", () => {
    // Present Nov, Dec, Jan, Feb — the case that makes naive range-finding read wrong.
    expect(seasonSummary(withRegion("puget_trough", "CC--------CC"), "puget_trough"))
      .toBe("Nov–Feb");
  });

  it("keeps genuinely separate runs separate", () => {
    // A spring and a fall passage, absent in between: two runs, not one.
    expect(seasonSummary(withRegion("puget_trough", "---UU---UU--"), "puget_trough"))
      .toBe("Apr–May, Sep–Oct");
  });

  it("handles a single isolated month", () => {
    expect(seasonSummary(withRegion("oceanic", "-----R------"), "oceanic")).toBe("Jun");
  });
});

describe("peakInEcoregion", () => {
  it("picks the highest rank reached across the year", () => {
    expect(peakInEcoregion(withRegion("okanogan", "RRUUFFCCFFUR"), "okanogan")).toBe("C");
  });

  it("returns absent when the species never occurs there", () => {
    expect(peakInEcoregion(blank(), "blue_mountains")).toBe("");
  });
});

describe("presence helpers", () => {
  it("detects a species recorded nowhere", () => {
    expect(isRecordedAnywhere(blank())).toBe(false);
  });

  it("lists present ecoregions in canonical order, not insertion order", () => {
    const m = blank();
    m.columbia_plateau = "CCCCCCCCCCCC".split("") as AbundanceCode[];
    m.oceanic = "RRRRRRRRRRRR".split("") as AbundanceCode[];
    // oceanic is index 0, columbia_plateau index 9 — canonical order must win.
    expect(ecoregionsPresent(m)).toEqual(["oceanic", "columbia_plateau"]);
  });
});

describe("speciesPresentIn", () => {
  const species = [
    { slug: "mallard", common_name: "Mallard", abundance: withRegion("puget_trough", "CCCCCCCCCCCC") },
    { slug: "brant", common_name: "Brant", abundance: withRegion("puget_trough", "UU--------UU") },
    { slug: "sora", common_name: "Sora", abundance: withRegion("puget_trough", "---RRRR-----") },
    { slug: "smew", common_name: "Smew", abundance: blank() },
  ];

  it("returns only species present that month, ranked by abundance", () => {
    const jan = speciesPresentIn(species, "puget_trough", 0 as MonthIndex);
    expect(jan.map((s) => s.slug)).toEqual(["mallard", "brant"]);
    expect(jan[0].code).toBe("C");
  });

  it("excludes species absent that month even if present other months", () => {
    const jun = speciesPresentIn(species, "puget_trough", 5 as MonthIndex);
    expect(jun.map((s) => s.slug)).toEqual(["mallard", "sora"]);
  });

  it("breaks ties alphabetically so the list is stable between builds", () => {
    const apr = speciesPresentIn(species, "puget_trough", 3 as MonthIndex);
    expect(apr.map((s) => s.slug)).toEqual(["mallard", "sora"]);
  });

  it("honours a minimum-abundance floor", () => {
    const jan = speciesPresentIn(species, "puget_trough", 0 as MonthIndex, 5);
    expect(jan.map((s) => s.slug)).toEqual(["mallard"]);
  });
});
