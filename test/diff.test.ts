import { describe, expect, test } from "bun:test";
import { computeDiff, renderDiffText } from "../src/diff.ts";
import type { Analysis } from "../src/schemas.ts";

function base(ref = "r", collectedAt = "2026-01-01T00:00:00Z"): Analysis {
  return {
    meta: {
      ref,
      name: "n",
      region: "eu",
      status: "ACTIVE_HEALTHY",
      pgVersion: "17",
      createdAt: "x",
      collectedAt,
      sbperfVersion: "t",
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
    security: null,
    advisors: { performance: [], security: [] },
    apiCounts: [],
    sql: {
      dbSize: null,
      cacheHitPct: null,
      indexHitPct: null,
      cacheBlocksAccessed: null,
      statsResetAge: null,
      pgSettings: [],
      topStatements: [],
      topByCalls: [],
      queryIoStats: [],
      biggestTables: [],
      indexStats: [],
      duplicateIndexes: [],
      rlsUnindexed: [],
      seqScanHeavy: [],
      bloat: [],
      trafficProfile: [],
      tableIoStats: [],
      deadTuples: [],
      txidWraparound: [],
      multixactWraparound: [],
      neverVacuumed: [],
      fkUnindexed: [],
      invalidIndexes: [],
      topByWal: [],
      replicationSlots: [],
      rlsPolicies: [],
      connections: [],
      roleStats: [],
      longRunning: [],
      locks: [],
      blocking: [],
      storageUsage: [],
      extensions: [],
      unindexedVectors: [],
      walArchiving: [],
      hbaRules: [],
      authAudit: [],
      authMfa: [],
      cronJobs: [],
      dbSizeBytes: null,
      bloatExact: [],
      checksumFailures: [],
      walDirSize: [],
      amcheckIndex: [],
      amcheckHeap: [],
    },
    metrics: { available: false, samples: [] },
    trends: [],
    sync: null,
    narrative: null,
    errors: [],
  };
}

describe("computeDiff - findings delta", () => {
  test("a new finding appears", () => {
    const a = base();
    const b = base();
    b.sql.cacheHitPct = 80; // triggers a cache-hit finding
    const d = computeDiff(a, b);
    expect(d.findings.appeared.some((f) => f.title.includes("Cache hit"))).toBe(true);
    expect(d.findings.resolved).toHaveLength(0);
  });

  test("a resolved finding is reported", () => {
    const a = base();
    a.sql.cacheHitPct = 80;
    const b = base();
    b.sql.cacheHitPct = 99.9;
    const d = computeDiff(a, b);
    expect(d.findings.resolved.some((f) => f.title.includes("Cache hit"))).toBe(true);
    expect(d.findings.appeared).toHaveLength(0);
  });

  test("same finding with a moved value is NOT appeared+resolved (number-normalized key)", () => {
    const a = base();
    a.sql.cacheHitPct = 80;
    const b = base();
    b.sql.cacheHitPct = 85; // still below target, same finding, different number
    const d = computeDiff(a, b);
    expect(d.findings.appeared).toHaveLength(0);
    expect(d.findings.resolved).toHaveLength(0);
    // both are "med" so it's unchanged (value delta shows via scalars)
    expect(d.findings.unchanged).toBeGreaterThanOrEqual(1);
  });

  test("severity change is reported as changed, not appeared+resolved", () => {
    // network restriction open (med) -> use security plane to flip severity is
    // hard; instead use a disk-fill projection whose severity depends on days.
    // Simpler: assert the changed bucket exists via a crafted pair on advisors.
    const a = base();
    a.advisors.security = [{ name: "rls_disabled", title: "RLS disabled", level: "WARN" }];
    const b = base();
    b.advisors.security = [{ name: "rls_disabled", title: "RLS disabled", level: "ERROR" }];
    const d = computeDiff(a, b);
    expect(d.findings.changed.some((c) => c.from === "med" && c.to === "high")).toBe(true);
    expect(d.findings.appeared).toHaveLength(0);
    expect(d.findings.resolved).toHaveLength(0);
  });
});

describe("computeDiff - query regressions (by queryid)", () => {
  test("a query whose mean exec time grew >=1.5x is a regression", () => {
    const a = base();
    a.sql.topStatements = [{ queryid: "111", mean_ms: 10, calls: 100, query: "select 1" }];
    const b = base();
    b.sql.topStatements = [{ queryid: "111", mean_ms: 40, calls: 120, query: "select 1" }];
    const d = computeDiff(a, b);
    expect(d.regressions).toHaveLength(1);
    expect(d.regressions[0]?.factor).toBeCloseTo(4, 5);
    expect(d.improvements).toHaveLength(0);
    expect(d.queryIdUnavailable).toBe(false);
  });

  test("a query that got faster is an improvement", () => {
    const a = base();
    a.sql.topStatements = [{ queryid: "222", mean_ms: 40, calls: 100, query: "select 2" }];
    const b = base();
    b.sql.topStatements = [{ queryid: "222", mean_ms: 10, calls: 100, query: "select 2" }];
    const d = computeDiff(a, b);
    expect(d.improvements).toHaveLength(1);
    expect(d.regressions).toHaveLength(0);
  });

  test("no queryid on either side -> query diff unavailable", () => {
    const a = base();
    a.sql.topStatements = [{ mean_ms: 10, calls: 100, query: "select 1" }];
    const b = base();
    b.sql.topStatements = [{ mean_ms: 40, calls: 100, query: "select 1" }];
    const d = computeDiff(a, b);
    expect(d.queryIdUnavailable).toBe(true);
    expect(d.regressions).toHaveLength(0);
  });

  test("sub-millisecond queries are ignored (noise floor)", () => {
    const a = base();
    a.sql.topStatements = [{ queryid: "333", mean_ms: 0.1, calls: 100, query: "select 3" }];
    const b = base();
    b.sql.topStatements = [{ queryid: "333", mean_ms: 0.5, calls: 100, query: "select 3" }];
    expect(computeDiff(a, b).regressions).toHaveLength(0);
  });
});

describe("renderDiffText", () => {
  test("renders headers, deltas, and scalars", () => {
    const a = base("proj", "2026-01-01T00:00:00Z");
    a.sql.topStatements = [{ queryid: "9", mean_ms: 10, calls: 50, query: "select foo" }];
    const b = base("proj", "2026-01-02T00:00:00Z");
    b.sql.cacheHitPct = 70;
    b.sql.topStatements = [{ queryid: "9", mean_ms: 30, calls: 50, query: "select foo" }];
    const txt = renderDiffText(computeDiff(a, b));
    expect(txt).toContain("sbperf diff: proj");
    expect(txt).toContain("NEW");
    expect(txt).toContain("SLOWER");
    expect(txt).toContain("Scalars:");
  });

  test("clean diff says no change", () => {
    const txt = renderDiffText(computeDiff(base(), base()));
    expect(txt).toContain("no change");
  });
});
