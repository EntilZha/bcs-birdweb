import { describe, expect, it } from "vitest";
import { awaitingPin, mappableSites, type MappableLike } from "./sites";
import { project, withinWashington, VIEW_WIDTH, VIEW_HEIGHT } from "./project";

const site = (
  id: string,
  lat: number | null,
  lon: number | null,
  geocode_source: string | null,
): MappableLike => ({ id, data: { name: id, lat, lon, geocode_source } });

describe("mappableSites", () => {
  it("plots a confirmed pin", () => {
    expect(mappableSites([site("marymoor", 47.6587, -122.111, "confirmed")])).toHaveLength(1);
  });

  it("refuses a geocoder proposal", () => {
    // The geocoder's first version proposed an apartment building for Samish Flats.
    const sites = [site("samish", 48.7358, -122.468, "nominatim-unconfirmed")];
    expect(mappableSites(sites)).toHaveLength(0);
  });

  it("refuses a hand-placed pin that nobody confirmed", () => {
    expect(mappableSites([site("x", 47, -122, "placed-by-hand")])).toHaveLength(0);
  });

  it("refuses an unknown future source rather than letting it through by default", () => {
    // The rule is a positive test for "confirmed", not a blocklist of bad values.
    expect(mappableSites([site("x", 47, -122, "imported-from-somewhere")])).toHaveLength(0);
  });

  it("refuses a site with no source at all", () => {
    expect(mappableSites([site("x", 47, -122, null)])).toHaveLength(0);
  });

  it("refuses a confirmed pin that is missing half its coordinate", () => {
    expect(mappableSites([site("x", 47, null, "confirmed")])).toHaveLength(0);
    expect(mappableSites([site("x", null, -122, "confirmed")])).toHaveLength(0);
  });

  it("refuses a confirmed pin that is not in Washington", () => {
    // A transposed sign or a bad paste should not draw a marker in the Pacific.
    expect(mappableSites([site("x", 47.6, 122.1, "confirmed")])).toHaveLength(0);
    expect(mappableSites([site("x", 40.7, -74.0, "confirmed")])).toHaveLength(0);
  });

  it("treats 0 as a real value, not a missing one", () => {
    // Guards the null check against being written as a truthiness test.
    expect(mappableSites([site("x", 0, 0, "confirmed")])).toHaveLength(0); // outside WA
    expect(awaitingPin([site("x", 0, 0, "confirmed")])).toHaveLength(1);
  });
});

describe("awaitingPin", () => {
  it("counts everything that is not plotted", () => {
    const sites = [
      site("a", 47.6, -122.3, "confirmed"),
      site("b", 47.6, -122.3, "nominatim-unconfirmed"),
      site("c", null, null, null),
    ];
    expect(mappableSites(sites).map((s) => s.id)).toEqual(["a"]);
    expect(awaitingPin(sites).map((s) => s.id)).toEqual(["b", "c"]);
  });
});

describe("project", () => {
  it("puts the northwest corner near the top left and the southeast near the bottom right", () => {
    const nw = project(-124.8, 49.0);
    const se = project(-117.0, 45.6);
    expect(nw.x).toBeLessThan(se.x);
    expect(nw.y).toBeLessThan(se.y);
  });

  it("keeps Washington inside the viewBox", () => {
    for (const [lon, lat] of [
      [-124.7, 48.4], // Cape Flattery
      [-122.3, 47.6], // Seattle
      [-117.0, 46.4], // Pullman
      [-122.7, 45.6], // Vancouver, WA
    ] as const) {
      const { x, y } = project(lon, lat);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(VIEW_WIDTH);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(VIEW_HEIGHT);
    }
  });

  it("places Seattle west of Spokane and north of Vancouver", () => {
    const seattle = project(-122.33, 47.61);
    const spokane = project(-117.43, 47.66);
    const vancouver = project(-122.67, 45.63);
    expect(seattle.x).toBeLessThan(spokane.x);
    expect(seattle.y).toBeLessThan(vancouver.y);
  });
});

describe("withinWashington", () => {
  it("accepts a Seattle coordinate and rejects a New York one", () => {
    expect(withinWashington(47.61, -122.33)).toBe(true);
    expect(withinWashington(40.71, -74.01)).toBe(false);
  });
});
