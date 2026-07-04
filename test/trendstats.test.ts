import { describe, expect, test } from "bun:test";
import { projectDaysTo, sufficient, sustainedFrac, trendStat } from "../src/trendstats.ts";

const DAY = 86400;
// A rising series: 10 points over 9 days, +1/day.
const rising = Array.from({ length: 10 }, (_, i) => ({ t: i * DAY, v: 10 + i }));

describe("sufficient (data-aware gate)", () => {
  test("false for a single snapshot / too few points", () => {
    expect(sufficient([{ t: 0, v: 1 }])).toBe(false);
    expect(sufficient(rising.slice(0, 3))).toBe(false); // <12 points
  });
  test("false when points span too little time even if numerous", () => {
    const dense = Array.from({ length: 50 }, (_, i) => ({ t: i * 60, v: i })); // 50 pts over ~49min
    expect(sufficient(dense)).toBe(false); // span < 3 days
  });
  test("true with enough points over enough span", () => {
    const wide = Array.from({ length: 20 }, (_, i) => ({ t: i * DAY, v: i })); // 20 pts / 19d
    expect(sufficient(wide)).toBe(true);
  });
});

describe("trendStat", () => {
  test("computes slope/day, span, direction on a rising series", () => {
    const s = trendStat(rising)!;
    expect(s.n).toBe(10);
    expect(s.spanDays).toBeCloseTo(9, 5);
    expect(s.slopePerDay).toBeCloseTo(1, 5);
    expect(s.direction).toBe("rising");
    expect(s.first).toBe(10);
    expect(s.last).toBe(19);
    expect(s.max).toBe(19);
  });
  test("flat series -> flat direction, ~0 slope", () => {
    const flat = Array.from({ length: 10 }, (_, i) => ({ t: i * DAY, v: 42 }));
    const s = trendStat(flat)!;
    expect(s.slopePerDay).toBeCloseTo(0, 5);
    expect(s.direction).toBe("flat");
  });
  test("null on empty", () => {
    expect(trendStat([])).toBeNull();
  });
});

describe("sustainedFrac", () => {
  test("fraction at/above and at/below a threshold", () => {
    expect(sustainedFrac(rising, 15, ">=")).toBeCloseTo(0.5, 5); // 15..19 = 5 of 10
    expect(sustainedFrac(rising, 12, "<=")).toBeCloseTo(0.3, 5); // 10,11,12 = 3 of 10
  });
});

describe("projectDaysTo", () => {
  test("days to reach a target along the current slope", () => {
    const s = trendStat(rising)!; // last=19, +1/day
    expect(projectDaysTo(s, 100)).toBeCloseTo(81, 5); // (100-19)/1
  });
  test("null when the slope heads away from / never reaches the target", () => {
    const s = trendStat(rising)!;
    expect(projectDaysTo(s, 5)).toBeNull(); // rising, target below last -> never
  });
  test("null on a flat series (no movement)", () => {
    const flat = trendStat(Array.from({ length: 10 }, (_, i) => ({ t: i * DAY, v: 42 })))!;
    expect(projectDaysTo(flat, 100)).toBeNull();
  });
});
