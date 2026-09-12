import { describe, expect, it } from "vitest";
import {
  alphabeticalSort,
  displayName,
  historicName,
  scientificName,
  searchAliases,
  taxonomicSort,
  type SpeciesData,
} from "./species";

/** Minimal species record; only the fields these functions read. */
function species(over: Partial<SpeciesData> = {}): SpeciesData {
  return {
    slug: "x",
    common_name: "Mallard",
    scientific_name: "Anas platyrhynchos",
    order: { name: "Anseriformes", slug: "anseriformes" },
    family: { name: "Anatidae", slug: "anatidae" },
    status: "",
    species_of_concern: false,
    sections: { general_description: "" },
    photos: [],
    audio: null,
    maps: { wa: null, north_america: null },
    abundance: {},
    taxonomy: {
      ebird_code: null,
      current_common_name: null,
      current_scientific_name: null,
      clements_sort: null,
      historic_common_name: null,
      display_historic: false,
      note: null,
    },
    source: { url: "https://birdweb.org/birdweb/bird/x", archived: "2026-09-12" },
    ...over,
  } as SpeciesData;
}

const withTaxonomy = (t: Partial<SpeciesData["taxonomy"]>, over: Partial<SpeciesData> = {}) =>
  species({ ...over, taxonomy: { ...species().taxonomy, ...t } });

describe("displayName", () => {
  it("uses the BirdWeb name when taxonomy has not been resolved", () => {
    expect(displayName(species({ common_name: "Mallard" }))).toBe("Mallard");
  });

  it("leads with the current name after a rename", () => {
    const gray_jay = withTaxonomy(
      { current_common_name: "Canada Jay", historic_common_name: "Gray Jay" },
      { common_name: "Gray Jay" },
    );
    expect(displayName(gray_jay)).toBe("Canada Jay");
    expect(historicName(gray_jay)).toBe("Gray Jay");
  });

  it("keeps the published name on an account absorbed into another species", () => {
    // Northwestern Crow merged into American Crow, which has its own account. Titling
    // both "American Crow" would leave a reader unable to tell the pages apart.
    const crow = withTaxonomy(
      { current_common_name: "American Crow", display_historic: true },
      { common_name: "Northwestern Crow" },
    );
    expect(displayName(crow)).toBe("Northwestern Crow");
  });

  it("does not repeat the historic name when it is already the title", () => {
    // The species page shows the taxonomy note instead, so a duplicate banner would be
    // noise directly under the heading.
    const crow = withTaxonomy(
      { current_common_name: "American Crow", display_historic: true },
      { common_name: "Northwestern Crow" },
    );
    expect(historicName(crow)).toBeNull();
  });

  it("reports no historic name when nothing changed", () => {
    expect(historicName(withTaxonomy({ current_common_name: "Mallard" }))).toBeNull();
  });
});

describe("scientificName", () => {
  it("prefers the current binomial after a genus move", () => {
    const yellow_warbler = withTaxonomy(
      { current_scientific_name: "Setophaga aestiva" },
      { scientific_name: "Dendroica petechia" },
    );
    expect(scientificName(yellow_warbler)).toBe("Setophaga aestiva");
  });

  it("falls back to the published binomial", () => {
    expect(scientificName(species({ scientific_name: "Anas platyrhynchos" }))).toBe(
      "Anas platyrhynchos",
    );
  });
});

describe("searchAliases", () => {
  it("indexes the pre-2005 name so an old field guide still finds the page", () => {
    const gray_jay = withTaxonomy(
      { current_common_name: "Canada Jay" },
      { common_name: "Gray Jay" },
    );
    expect(searchAliases(gray_jay)).toContain("Gray Jay");
    expect(searchAliases(gray_jay)).toContain("Canada Jay");
  });

  it("drops nulls rather than indexing empty strings", () => {
    expect(searchAliases(species()).every(Boolean)).toBe(true);
  });
});

describe("taxonomicSort", () => {
  it("orders by the eBird sequence when both are resolved", () => {
    const a = withTaxonomy({ clements_sort: 100 });
    const b = withTaxonomy({ clements_sort: 50 });
    expect([a, b].sort(taxonomicSort).map((s) => s.taxonomy!.clements_sort)).toEqual([50, 100]);
  });

  it("puts unresolved species after resolved ones rather than at the front", () => {
    const resolved = withTaxonomy({ clements_sort: 500 });
    const unresolved = species({ common_name: "Aardvark Bird" });
    expect([unresolved, resolved].sort(taxonomicSort)[0]).toBe(resolved);
  });

  it("still orders two unresolved species deterministically", () => {
    // Otherwise the birds index reshuffles between builds for no reason.
    const a = species({ common_name: "Zebra Finch", family: { name: "Estrildidae", slug: "e" } });
    const b = species({ common_name: "Albatross", family: { name: "Estrildidae", slug: "e" } });
    expect([a, b].sort(taxonomicSort).map(displayName)).toEqual(["Albatross", "Zebra Finch"]);
  });

  it("sorts an absorbed account by its displayed name", () => {
    const a = species({ common_name: "Bushtit" });
    const b = species({ common_name: "Auklet" });
    expect([a, b].sort(alphabeticalSort).map(displayName)).toEqual(["Auklet", "Bushtit"]);
  });
});
