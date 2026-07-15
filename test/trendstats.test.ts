import { describe, expect, test } from "bun:test";
import {
  DIRECTION_MIN_DRIFT_FRACTION,
  detectResizes,
  projectDaysTo,
  sufficient,
  sustainedFrac,
  trendStat,
} from "../src/trendstats.ts";

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

describe("detectResizes", () => {
  test("flags a step-change above the fraction, ignores organic growth", () => {
    const pts = [
      { t: 0, v: 50e9 },
      { t: 1, v: 51e9 }, // +2% organic
      { t: 2, v: 150e9 }, // +194% resize
      { t: 3, v: 151e9 },
    ];
    const ev = detectResizes(pts, 0.2);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toEqual({ at: 2, fromBytes: 51e9, toBytes: 150e9 });
  });
  test("no events on a flat / gently-growing series", () => {
    expect(
      detectResizes(
        [
          { t: 0, v: 100 },
          { t: 1, v: 105 },
          { t: 2, v: 108 },
        ],
        0.2,
      ),
    ).toEqual([]);
  });
  test("detects a shrink too (abs step)", () => {
    expect(
      detectResizes(
        [
          { t: 0, v: 150e9 },
          { t: 1, v: 50e9 },
        ],
        0.2,
      ),
    ).toHaveLength(1);
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

describe("projectDaysTo (fitted-line anchor, not raw last)", () => {
  test("DIRECTION_MIN_DRIFT_FRACTION is a named exported constant", () => {
    expect(DIRECTION_MIN_DRIFT_FRACTION).toBe(0.1);
  });
  test("fittedLast equals last on a perfectly linear series", () => {
    const s = trendStat(rising)!;
    expect(s.fittedLast).toBeCloseTo(s.last, 5);
  });
  test("anchors the projection on fittedLast when the last sample is a noisy outlier", () => {
    // ~+1/day for 9 points, then a spike outlier as the final sample.
    const pts = Array.from({ length: 9 }, (_, i) => ({ t: i * DAY, v: 10 + i }));
    pts.push({ t: 9 * DAY, v: 200 });
    const s = trendStat(pts)!;
    expect(s.last).toBe(200);
    // the fitted value at the last x sits far below the raw spike
    expect(s.fittedLast).toBeLessThan(100);
    expect(Math.abs(s.fittedLast - s.last)).toBeGreaterThan(50);
    // projection uses the fitted anchor, NOT the raw last point
    const target = 500;
    expect(projectDaysTo(s, target)).toBeCloseTo((target - s.fittedLast) / s.slopePerDay, 5);
    // and that differs materially from the old raw-last behaviour
    expect(projectDaysTo(s, target)).not.toBeCloseTo((target - s.last) / s.slopePerDay, 1);
  });
});
