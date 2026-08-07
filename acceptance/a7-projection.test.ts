// Acceptance - plan Task 7: freeze age is trended and projected to an ETA.
// Contract only. Do not edit to make the implementation pass.
import { describe, expect, test } from "bun:test";
import { deriveFindings } from "../src/findings.ts";
import { HistoryStore } from "../src/store.ts";
import { analysis, CEILING } from "./fixture.ts";

const DAY = 86_400;

function withAge(age: number, collectedAt: string) {
  const a = analysis((raw) => {
    (raw.meta as Record<string, unknown>).collectedAt = collectedAt;
    raw.sql.txidWraparound = [
      {
        schema: "public",
        table: "public.events",
        xid_age: age,
        toast_age: null,
        remaining: CEILING - age,
      },
    ];
  });
  return a;
}

describe("Task 7 - the store trends freeze age", () => {
  test("txid_max_age is recorded per snapshot", () => {
    const store = HistoryStore.open(":memory:");
    store.record(withAge(100_000_000, "2026-07-01T00:00:00Z"));
    store.record(withAge(150_000_000, "2026-07-02T00:00:00Z"));
    const snaps = store.loadForTrends("examplerefaaaaaaaaaa");
    expect(snaps).toHaveLength(2);
    expect(snaps[0]?.scalars.txid_max_age).toBe(100_000_000);
    expect(snaps[1]?.scalars.txid_max_age).toBe(150_000_000);
    store.close();
  });

  test("an analysis with no freeze rows records no scalar rather than a zero", () => {
    const store = HistoryStore.open(":memory:");
    store.record(analysis());
    const snaps = store.loadForTrends("examplerefaaaaaaaaaa");
    expect(snaps[0]?.scalars.txid_max_age ?? null).toBeNull();
    store.close();
  });
});

/** 31 daily points climbing linearly from `from` to `to`. */
function series(title: string, from: number, to: number) {
  const t0 = Math.floor(Date.parse("2026-07-01T00:00:00Z") / 1000);
  const n = 31;
  return {
    title,
    unit: "",
    points: Array.from({ length: n }, (_, i) => ({
      t: t0 + i * DAY,
      v: from + ((to - from) * i) / (n - 1),
    })),
  };
}

describe("Task 7 - the projection answers 'how long do I have'", () => {
  test("a climbing 30-day freeze-age series produces a dated projection", () => {
    const a = analysis((raw) => {
      raw.trends = [series("Transaction-ID age (max)", 1_000_000_000, 1_600_000_000)];
      raw.sql.txidWraparound = [
        {
          schema: "public",
          table: "public.events",
          xid_age: 1_600_000_000,
          remaining: CEILING - 1_600_000_000,
        },
      ];
    });
    const f = deriveFindings(a).find((x) => x.heuristicId === "wraparound_projected");
    expect(f).toBeDefined();
    expect(`${f?.title ?? ""} ${f?.evidence ?? ""}`).toMatch(/\d+\s*day/i);
    expect(f?.severity).toBe("high");
  });

  test("a flat series produces no projection (nothing is approaching anything)", () => {
    const a = analysis((raw) => {
      raw.trends = [series("Transaction-ID age (max)", 50_000_000, 50_000_100)];
    });
    expect(deriveFindings(a).some((x) => x.heuristicId === "wraparound_projected")).toBe(false);
  });

  test("too few points produces no projection (no ETA invented from two dots)", () => {
    const t0 = Math.floor(Date.parse("2026-07-01T00:00:00Z") / 1000);
    const a = analysis((raw) => {
      raw.trends = [
        {
          title: "Transaction-ID age (max)",
          unit: "",
          points: [
            { t: t0, v: 1_000_000_000 },
            { t: t0 + DAY, v: 1_600_000_000 },
          ],
        },
      ];
    });
    expect(deriveFindings(a).some((x) => x.heuristicId === "wraparound_projected")).toBe(false);
  });
});
