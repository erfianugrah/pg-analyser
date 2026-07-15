import { describe, expect, test } from "bun:test";
import { detectEpisodes } from "../src/contention.ts";
import type { IncidentSeries } from "../src/prometheus.ts";

const flat = (n: number, v: number): Array<[number, number]> =>
  Array.from({ length: n }, (_, i) => [1000 + i * 300, v]);

function spike(base: Array<[number, number]>, at: number, len: number, v: number) {
  const c = base.map((x) => [...x] as [number, number]);
  for (let i = at; i < at + len; i++) c[i]![1] = v;
  return c;
}

function series(over: Partial<IncidentSeries>): IncidentSeries {
  return { available: [], windowFrom: 1000, windowTo: 13000, stepSec: 300, ...over };
}

describe("detectEpisodes", () => {
  test("two correlated series over the same buckets -> one episode naming both", () => {
    const eps = detectEpisodes(
      series({
        rollbacks: spike(flat(40, 2), 10, 3, 90),
        activeBackends: spike(flat(40, 3), 10, 3, 40),
      }),
    );
    expect(eps.length).toBe(1);
    expect(eps[0]?.series.sort()).toEqual(["activeBackends", "rollbacks"]);
    expect(eps[0]?.rollbackTotal).toBeGreaterThanOrEqual(200);
  });

  test("chatty rollback baseline does not fire (k*median gate)", () => {
    // A steady ~120 rollbacks/bucket is the app's normal; median is 120, so the
    // 6x gate (720) is never exceeded.
    const eps = detectEpisodes(series({ rollbacks: flat(40, 120) }));
    expect(eps.length).toBe(0);
  });

  test("single-series spike -> episode marked single", () => {
    const eps = detectEpisodes(series({ rollbacks: spike(flat(40, 2), 5, 2, 90) }));
    expect(eps.length).toBe(1);
    expect(eps[0]?.series).toEqual(["rollbacks"]);
  });

  test("activeBackends needs 2 consecutive hot buckets", () => {
    // one lone hot active bucket -> not enough (minConsecutive=2)
    const eps = detectEpisodes(series({ activeBackends: spike(flat(40, 3), 8, 1, 40) }));
    expect(eps.length).toBe(0);
  });

  test("no series -> no episodes", () => {
    expect(detectEpisodes(series({}))).toEqual([]);
  });
});
