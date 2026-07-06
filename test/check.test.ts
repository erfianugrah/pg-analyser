import { describe, expect, test } from "bun:test";
import { evaluateGate, renderGateText } from "../src/check.ts";
import type { Analysis } from "../src/schemas.ts";

function base(): Analysis {
  return {
    meta: {
      ref: "r",
      name: "n",
      region: "eu",
      status: "ACTIVE_HEALTHY",
      pgVersion: "17",
      createdAt: "x",
      collectedAt: "x",
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
      extensions: [],
      unindexedVectors: [],
      walArchiving: [],
    },
    metrics: { available: false, samples: [] },
    trends: [],
    sync: null,
    narrative: null,
    errors: [],
  };
}

/** A high-severity security advisor finding. */
function withHighSecurity(a: Analysis): Analysis {
  a.advisors.security = [
    { name: "rls_disabled", title: "RLS disabled on public table", level: "ERROR" },
  ];
  return a;
}
/** A med-severity performance finding (low cache hit). */
function withMedPerf(a: Analysis): Analysis {
  a.sql.cacheHitPct = 80;
  return a;
}

describe("evaluateGate", () => {
  test("clean project passes at fail-on high", () => {
    const r = evaluateGate(base(), null, { failOn: "high" });
    expect(r.pass).toBe(true);
    expect(r.failing).toHaveLength(0);
  });

  test("a high finding fails a fail-on-high gate", () => {
    const r = evaluateGate(withHighSecurity(base()), null, { failOn: "high" });
    expect(r.pass).toBe(false);
    expect(r.failing.some((f) => f.severity === "high")).toBe(true);
    expect(r.counts.high).toBe(1);
  });

  test("a med finding passes fail-on-high but fails fail-on-med", () => {
    const a = withMedPerf(base());
    expect(evaluateGate(a, null, { failOn: "high" }).pass).toBe(true);
    expect(evaluateGate(a, null, { failOn: "med" }).pass).toBe(false);
  });

  test("category scope: security gate ignores a performance finding", () => {
    const a = withMedPerf(base());
    expect(evaluateGate(a, null, { failOn: "med", category: "Security" }).pass).toBe(true);
    expect(evaluateGate(a, null, { failOn: "med", category: "Performance" }).pass).toBe(false);
  });

  test("new-only: a pre-existing high finding does not fail; a newly-added one does", () => {
    const baseline = withHighSecurity(base());
    const current = withHighSecurity(base()); // same high finding as baseline
    expect(evaluateGate(current, baseline, { failOn: "high", newOnly: true }).pass).toBe(true);

    const currentPlusNew = withHighSecurity(base());
    currentPlusNew.advisors.security.push({
      name: "exposed_auth_users",
      title: "Auth users exposed to anon",
      level: "ERROR",
    });
    const r = evaluateGate(currentPlusNew, baseline, { failOn: "high", newOnly: true });
    expect(r.pass).toBe(false);
    expect(r.failing.some((f) => f.title.includes("Auth users exposed"))).toBe(true);
  });
});

describe("renderGateText", () => {
  test("PASS line names the scope", () => {
    const txt = renderGateText(evaluateGate(base(), null, { failOn: "high" }));
    expect(txt).toContain("PASS");
    expect(txt).toContain("fail-on=high");
  });

  test("FAIL line lists the breaching findings", () => {
    const txt = renderGateText(evaluateGate(withHighSecurity(base()), null, { failOn: "high" }));
    expect(txt).toContain("FAIL");
    expect(txt).toContain("RLS disabled");
  });
});
