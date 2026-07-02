import { describe, expect, test } from "bun:test";
import { deriveFindings } from "../src/findings.ts";
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
      transport: "direct",
      sbperfVersion: "t",
    },
    health: [],
    disk: null,
    pgConfig: null,
    pooler: null,
    backups: null,
    upgrade: null,
    functions: [],
    buckets: [],
    advisors: { performance: [], security: [] },
    apiCounts: [],
    sql: {
      dbSize: null,
      cacheHitPct: null,
      pgSettings: [],
      topStatements: [],
      biggestTables: [],
      unusedIndexes: [],
      seqScanHeavy: [],
      deadTuples: [],
      rlsPolicies: [],
      connections: [],
      storageUsage: [],
    },
    metrics: { available: false, samples: [] },
    trends: [],
    errors: [],
  };
}

describe("deriveFindings", () => {
  test("clean project -> no findings", () => {
    expect(deriveFindings(base())).toHaveLength(0);
  });

  test("unwrapped RLS auth policies surface as a Performance finding", () => {
    const a = base();
    a.sql.rlsPolicies = [
      { table: "public.x", policyname: "p1", cmd: "SELECT", unwrapped_auth: true },
      { table: "public.x", policyname: "p2", cmd: "UPDATE", unwrapped_auth: true },
      { table: "public.x", policyname: "p3", cmd: "INSERT", unwrapped_auth: false },
    ];
    const f = deriveFindings(a).find((x) => x.anchor === "#rls");
    expect(f?.category).toBe("Performance");
    expect(f?.title).toContain("2 RLS");
  });

  test("low cache hit flagged", () => {
    const a = base();
    a.sql.cacheHitPct = 92;
    expect(deriveFindings(a).some((f) => f.title.includes("Cache hit ratio 92%"))).toBe(true);
  });

  test("advisors grouped by title with counts", () => {
    const a = base();
    a.advisors.performance = [
      { name: "unindexed_foreign_keys", title: "Unindexed foreign keys", level: "INFO" },
      { name: "unindexed_foreign_keys", title: "Unindexed foreign keys", level: "INFO" },
    ];
    const f = deriveFindings(a).find((x) => x.title.startsWith("Unindexed foreign keys"));
    expect(f?.title).toContain("(2x)");
    expect(f?.category).toBe("Performance");
  });

  test("only public-schema unused indexes counted", () => {
    const a = base();
    a.sql.unusedIndexes = [
      { schema: "auth", table: "auth.users", index: "i1" },
      { schema: "public", table: "public.x", index: "i2" },
    ];
    const f = deriveFindings(a).find((x) => x.anchor === "#unused");
    expect(f?.title).toContain("1 unused index in public");
  });

  test("connections near max -> Capacity finding", () => {
    const a = base();
    a.sql.pgSettings = [{ name: "max_connections", setting: "60", unit: null }];
    a.sql.connections = [{ state: "active", connections: 50 }];
    const f = deriveFindings(a).find((x) => x.anchor === "#connections");
    expect(f?.category).toBe("Capacity");
    expect(f?.title).toContain("83%");
  });

  test("idle-in-transaction disabled flagged", () => {
    const a = base();
    a.sql.pgSettings = [{ name: "idle_in_transaction_session_timeout", setting: "0", unit: "ms" }];
    expect(deriveFindings(a).some((f) => f.title.includes("idle_in_transaction"))).toBe(true);
  });

  test("findings sorted high -> low severity", () => {
    const a = base();
    a.advisors.security = [{ name: "x", title: "Critical thing", level: "ERROR" }];
    a.sql.cacheHitPct = 95; // med
    a.sql.unusedIndexes = [{ schema: "public", table: "public.x", index: "i" }]; // low
    const sev = deriveFindings(a).map((f) => f.severity);
    expect(sev).toEqual(
      [...sev].sort((x, y) => ({ high: 0, med: 1, low: 2 })[x] - { high: 0, med: 1, low: 2 }[y]),
    );
  });
});
