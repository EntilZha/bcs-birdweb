import { describe, expect, it } from "vitest";
import {
  parseWhatsAroundUrl,
  whatsAroundQuery,
  type WhatsAroundState,
} from "./whatsAroundUrl";

const fallback: WhatsAroundState = { ecoregion: "puget_trough", month: 8, minRank: 1 };
const parse = (search: string) => parseWhatsAroundUrl(search, fallback);

describe("parseWhatsAroundUrl", () => {
  it("restores a shared link", () => {
    expect(parse("?region=okanogan&month=1&min=5")).toEqual({
      ecoregion: "okanogan",
      month: 0,
      minRank: 5,
    });
  });

  it("falls back when there is nothing to read", () => {
    expect(parse("")).toEqual(fallback);
  });

  it("converts the 1-indexed month in the URL to a 0-indexed one", () => {
    expect(parse("?month=12").month).toBe(11);
    expect(parse("?month=1").month).toBe(0);
  });

  it("rejects a month outside 1-12 rather than indexing past a 12-cell row", () => {
    // month=0 or month=13 would read undefined out of an abundance row and report the
    // species as absent everywhere, which looks like data rather than a bad link.
    for (const bad of ["0", "13", "-1", "99", "1.5", "abc", ""]) {
      expect(parse(`?month=${bad}`).month, bad).toBe(fallback.month);
    }
  });

  it("rejects an unknown region", () => {
    for (const bad of ["atlantis", "Puget_Trough", "puget trough", ""]) {
      expect(parse(`?region=${bad}`).ecoregion, bad).toBe(fallback.ecoregion);
    }
  });

  it("rejects a minimum rank outside 1-5", () => {
    for (const bad of ["0", "6", "-2", "x"]) {
      expect(parse(`?min=${bad}`).minRank, bad).toBe(fallback.minRank);
    }
  });

  it("keeps the good parameters when one is bad", () => {
    const out = parse("?region=okanogan&month=999");
    expect(out.ecoregion).toBe("okanogan");
    expect(out.month).toBe(fallback.month);
  });
});

describe("round trip", () => {
  it("parses back whatever it writes", () => {
    for (const state of [
      { ecoregion: "oceanic", month: 0, minRank: 1 },
      { ecoregion: "columbia_plateau", month: 11, minRank: 5 },
      { ecoregion: "blue_mountains", month: 5, minRank: 3 },
    ] as WhatsAroundState[]) {
      expect(parseWhatsAroundUrl(whatsAroundQuery(state), fallback)).toEqual(state);
    }
  });

  it("leaves min out of the URL at the default so a plain link stays short", () => {
    expect(whatsAroundQuery({ ecoregion: "oceanic", month: 0, minRank: 1 })).toBe(
      "region=oceanic&month=1",
    );
  });
});
