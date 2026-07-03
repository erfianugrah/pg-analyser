import { describe, expect, test } from "bun:test";
import type { Analysis, MetricSample } from "../src/schemas.ts";
import { HistoryStore } from "../src/store.ts";

function makeAnalysis(opts: {
  ref: string;
  collectedAt: string;
  samples?: MetricSample[];
  cacheHit?: number | null;
  indexHit?: number | null;
}): Analysis {
  return {
    meta: {
      ref: opts.ref,
      name: "proj",
      region: "us-east-1",
      status: "ACTIVE_HEALTHY",
      pgVersion: "15.1",
      createdAt: "2026-01-01T00:00:00Z",
      collectedAt: opts.collectedAt,
      sbperfVersion: "0.0.0-test",
      sqlSource: "read-only",
    },
    health: [],
    disk: null,
    pgConfig: null,
    pooler: null,
    backups: null,
    upgrade: null,
    functions: [],
    functionStats: [],
    buckets: [],
    advisors: { performance: [], security: [] },
    apiCounts: [],
    sql: {
      dbSize: null,
      cacheHitPct: opts.cacheHit ?? null,
      indexHitPct: opts.indexHit ?? null,
      statsResetAge: null,
      pgSettings: [],
      topStatements: [],
      topByCalls: [],
      biggestTables: [],
      indexStats: [],
      duplicateIndexes: [],
      rlsUnindexed: [],
      seqScanHeavy: [],
      bloat: [],
      trafficProfile: [],
      deadTuples: [],
      txidWraparound: [],
      replicationSlots: [],
      rlsPolicies: [],
      connections: [],
      roleStats: [],
      longRunning: [],
      locks: [],
      blocking: [],
      storageUsage: [],
    },
    metrics: { available: (opts.samples?.length ?? 0) > 0, samples: opts.samples ?? [] },
    trends: [],
    errors: [],
  };
}

const sample = (
  name: string,
  value: number,
  labels: Record<string, string> = {},
): MetricSample => ({
  name,
  labels,
  value,
});

describe("HistoryStore", () => {
  test("records a snapshot and reads it back for trends", () => {
    const store = HistoryStore.open(":memory:");
    store.record(
      makeAnalysis({
        ref: "abc",
        collectedAt: "2026-07-01T00:00:00Z",
        samples: [sample("node_load1", 0.5, { cpu: "0" })],
        cacheHit: 99.5,
        indexHit: 98.0,
      }),
    );
    const snaps = store.loadForTrends("abc");
    expect(snaps).toHaveLength(1);
    expect(snaps[0]?.ts).toBe(Math.floor(Date.parse("2026-07-01T00:00:00Z") / 1000));
    expect(snaps[0]?.samples).toEqual([{ name: "node_load1", labels: { cpu: "0" }, value: 0.5 }]);
    expect(snaps[0]?.scalars.cache_hit_pct).toBe(99.5);
    expect(snaps[0]?.scalars.index_hit_pct).toBe(98.0);
    store.close();
  });

  test("scopes snapshots by ref", () => {
    const store = HistoryStore.open(":memory:");
    store.record(makeAnalysis({ ref: "a", collectedAt: "2026-07-01T00:00:00Z" }));
    store.record(makeAnalysis({ ref: "a", collectedAt: "2026-07-01T01:00:00Z" }));
    store.record(makeAnalysis({ ref: "b", collectedAt: "2026-07-01T00:00:00Z" }));
    expect(store.snapshotCount("a")).toBe(2);
    expect(store.snapshotCount("b")).toBe(1);
    expect(store.snapshotCount("missing")).toBe(0);
    expect(store.refs().sort()).toEqual(["a", "b"]);
    store.close();
  });

  test("loadForTrends returns snapshots ordered by time ascending", () => {
    const store = HistoryStore.open(":memory:");
    store.record(makeAnalysis({ ref: "a", collectedAt: "2026-07-03T00:00:00Z" }));
    store.record(makeAnalysis({ ref: "a", collectedAt: "2026-07-01T00:00:00Z" }));
    store.record(makeAnalysis({ ref: "a", collectedAt: "2026-07-02T00:00:00Z" }));
    const ts = store.loadForTrends("a").map((s) => s.ts);
    expect(ts).toEqual([...ts].sort((x, y) => x - y));
    store.close();
  });

  test("scalars omitted when null (not stored as rows)", () => {
    const store = HistoryStore.open(":memory:");
    store.record(
      makeAnalysis({ ref: "a", collectedAt: "2026-07-01T00:00:00Z", cacheHit: null, indexHit: 5 }),
    );
    const snap = store.loadForTrends("a")[0];
    expect(snap?.scalars.cache_hit_pct).toBeUndefined();
    expect(snap?.scalars.index_hit_pct).toBe(5);
    store.close();
  });

  test("prune removes snapshots older than the retention window", () => {
    const store = HistoryStore.open(":memory:");
    const now = Date.now();
    const daysAgo = (d: number) => new Date(now - d * 86400_000).toISOString();
    store.record(makeAnalysis({ ref: "a", collectedAt: daysAgo(100) }));
    store.record(makeAnalysis({ ref: "a", collectedAt: daysAgo(45) }));
    store.record(makeAnalysis({ ref: "a", collectedAt: daysAgo(1) }));
    const deleted = store.prune("a", 90);
    expect(deleted).toBe(1);
    expect(store.snapshotCount("a")).toBe(2);
    store.close();
  });

  test("prune with retention 0 keeps everything", () => {
    const store = HistoryStore.open(":memory:");
    store.record(
      makeAnalysis({ ref: "a", collectedAt: new Date(Date.now() - 500 * 86400_000).toISOString() }),
    );
    expect(store.prune("a", 0)).toBe(0);
    expect(store.snapshotCount("a")).toBe(1);
    store.close();
  });

  test("pruning cascades to child sample/scalar rows", () => {
    const store = HistoryStore.open(":memory:");
    store.record(
      makeAnalysis({
        ref: "a",
        collectedAt: new Date(Date.now() - 200 * 86400_000).toISOString(),
        samples: [sample("node_load1", 1)],
        cacheHit: 90,
      }),
    );
    store.prune("a", 90);
    // internal integrity: no orphaned child rows remain
    expect(store.orphanRowCount()).toBe(0);
    store.close();
  });

  test("stores the full analysis json for completeness", () => {
    const store = HistoryStore.open(":memory:");
    store.record(makeAnalysis({ ref: "a", collectedAt: "2026-07-01T00:00:00Z" }));
    const latest = store.latestAnalysis("a");
    expect(latest?.meta.ref).toBe("a");
    expect(latest?.meta.name).toBe("proj");
    store.close();
  });
});
