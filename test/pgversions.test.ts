import { describe, expect, test } from "bun:test";
import { minorsBehind, PG_LATEST_MINOR, parsePgVersion } from "../src/pgversions.ts";

describe("parsePgVersion", () => {
  test("parses modern version strings incl. the Ubuntu suffix", () => {
    expect(parsePgVersion("15.1 (Ubuntu 15.1-1.pgdg20.04+1)")).toEqual({ major: "15", minor: 1 });
    expect(parsePgVersion("17.6")).toEqual({ major: "17", minor: 6 });
  });
  test("null on unparseable", () => {
    expect(parsePgVersion("weird")).toBeNull();
  });
});

describe("minorsBehind", () => {
  test("computes lag against the vendored latest minor", () => {
    const lag = minorsBehind("15.1 (Ubuntu 15.1-1.pgdg20.04+1)");
    expect(lag?.major).toBe("15");
    expect(lag?.current).toBe("15.1");
    // 15.1 vs the vendored latest 15.x -> well over 10 behind (asserts direction + math)
    expect(lag?.behind).toBeGreaterThan(10);
    expect(lag?.latest).toBe(PG_LATEST_MINOR["15"]?.latest);
  });
  test("null when current (or ahead)", () => {
    // Derived from the vendored table so refreshing it never breaks this test.
    expect(minorsBehind(PG_LATEST_MINOR["15"]?.latest ?? "")).toBeNull();
    expect(minorsBehind("15.99")).toBeNull();
  });
  test("null for a major not in the table", () => {
    expect(minorsBehind("9.6.24")).toBeNull();
  });
});
