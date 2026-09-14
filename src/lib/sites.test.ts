import { describe, expect, it } from "vitest";
import { awaitingPin, countByConfidence, mappableSites, type MappableLike } from "./sites";
import { project, withinWashington, VIEW_WIDTH, VIEW_HEIGHT } from "./project";

const site = (
  id: string,
  lat: number | null,
  lon: number | null,
  geocode_source: string | null,
): MappableLike => ({ id, data: { name: id, lat, lon, geocode_source } });

describe("mappableSites", () => {
  it("plots a confirmed pin as confirmed", () => {
    const pins = mappableSites([site("marymoor", 47.6587, -122.111, "confirmed")]);
    expect(pins).toHaveLength(1);
    expect(pins[0].confidence).toBe("confirmed");
  });

  it("plots a geocoder candidate, but only as approximate", () => {
    // A state-scale locator marker covers about 8km and the site page carries the real
    // directions, so a scored candidate is worth drawing -- but never as though someone
    // had checked it.
    const pins = mappableSites([site("samish", 48.7358, -122.468, "nominatim-unconfirmed")]);
    expect(pins[0].confidence).toBe("approximate");
  });

  it("treats a hand-placed but unconfirmed pin as approximate", () => {
    expect(mappableSites([site("x", 47, -122, "placed-by-hand")])[0].confidence).toBe(
      "approximate",
    );
  });

  it("treats an unknown future source as approximate rather than confirmed", () => {
    // The test is positive for "confirmed", not a blocklist: a value invented later must
    // not arrive claiming more confidence than it has earned.
    expect(mappableSites([site("x", 47, -122, "imported-from-somewhere")])[0].confidence).toBe(
      "approximate",
    );
  });

  it("does not plot a site with no coordinate", () => {
    expect(mappableSites([site("x", null, null, "confirmed")])).toHaveLength(0);
    expect(mappableSites([site("x", 47, null, "confirmed")])).toHaveLength(0);
    expect(mappableSites([site("x", null, -122, "confirmed")])).toHaveLength(0);
  });

  it("drops a coordinate outside Washington whatever its source", () => {
    // A transposed sign or a bad paste is not an approximation, and a marker in the
    // Pacific is worse than no marker.
    expect(mappableSites([site("x", 47.6, 122.1, "confirmed")])).toHaveLength(0);
    expect(mappableSites([site("x", 40.7, -74.0, "nominatim-unconfirmed")])).toHaveLength(0);
  });

  it("treats 0 as a real value, not a missing one", () => {
    // Guards the null checks against being written as truthiness tests.
    expect(mappableSites([site("x", 0, 0, "confirmed")])).toHaveLength(0); // outside WA
    expect(awaitingPin([site("x", 0, 0, "confirmed")])).toHaveLength(1);
  });
});

describe("countByConfidence", () => {
  it("separates confirmed, approximate and unplaced", () => {
    const sites = [
      site("a", 47.6, -122.3, "confirmed"),
      site("b", 47.6, -122.3, "nominatim-unconfirmed"),
      site("c", 48.0, -122.0, "placed-by-hand"),
      site("d", null, null, null),
      site("e", 40.7, -74.0, "confirmed"), // out of state, so not on the map at all
    ];
    expect(countByConfidence(sites)).toEqual({ confirmed: 1, approximate: 2, unplaced: 2 });
  });
});

describe("awaitingPin", () => {
  it("counts everything that is not plotted", () => {
    const sites = [
      site("a", 47.6, -122.3, "confirmed"),
      site("b", 47.6, -122.3, "nominatim-unconfirmed"),
      site("c", null, null, null),
    ];
    expect(mappableSites(sites).map((p) => p.site.id)).toEqual(["a", "b"]);
    expect(awaitingPin(sites).map((s) => s.id)).toEqual(["c"]);
  });
});

describe("project", () => {
  it("puts the northwest corner near the top left and the southeast near the bottom right", () => {
    const nw = project(-124.8, 49.0);
    const se = project(-117.0, 45.6);
    expect(nw.x).toBeLessThan(se.x);
    expect(nw.y).toBeLessThan(se.y);
  });

  it("insets the state so its border stroke is not clipped by the viewBox", () => {
    // Washington reaches within two units of the eastern bound; without the inset the
    // border is drawn half outside the box and the state renders with a missing edge.
    const east = project(-116.92, 47.0);
    const north = project(-120, 49.0);
    expect(east.x).toBeLessThan(VIEW_WIDTH - 4);
    expect(north.y).toBeGreaterThan(4);
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
