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
      sbperfVersion: "t",
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
      cacheHitPct: null,
      pgSettings: [],
      topStatements: [],
      topByCalls: [],
      biggestTables: [],
      unusedIndexes: [],
      seqScanHeavy: [],
      deadTuples: [],
      txidWraparound: [],
      replicationSlots: [],
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

  test("disk IOPS headroom flagged from trend rates", () => {
    const a = base();
    a.disk = {
      sizeGb: 8,
      iops: 3000,
      type: "gp3",
      throughputMibps: 125,
      usedBytes: 1,
      availBytes: 9,
    };
    a.trends = [
      { title: "Disk read IOPS", unit: "", points: [{ t: 1, v: 1800 }] },
      { title: "Disk write IOPS", unit: "", points: [{ t: 1, v: 900 }] },
    ];
    const f = deriveFindings(a).find((x) => x.title.includes("Disk IOPS"));
    expect(f?.category).toBe("Capacity");
    expect(f?.title).toContain("90% of provisioned (2700/3000)");
  });

  test("disk IOPS not flagged when well under provisioned", () => {
    const a = base();
    a.disk = {
      sizeGb: 8,
      iops: 3000,
      type: "gp3",
      throughputMibps: 125,
      usedBytes: 1,
      availBytes: 9,
    };
    a.trends = [{ title: "Disk read IOPS", unit: "", points: [{ t: 1, v: 100 }] }];
    expect(deriveFindings(a).some((x) => x.title.includes("Disk IOPS"))).toBe(false);
  });

  test("txid wraparound flagged high past 40%", () => {
    const a = base();
    a.sql.txidWraparound = [
      { schema: "public", table: "public.events", xid_age: 900000000, pct_wraparound: 45 },
      { schema: "public", table: "public.small", xid_age: 100, pct_wraparound: 0 },
    ];
    const f = deriveFindings(a).find((x) => x.anchor === "#txid");
    expect(f?.severity).toBe("high");
    expect(f?.category).toBe("Capacity");
    expect(f?.title).toContain("45%");
  });

  test("txid wraparound med between 20-40%, none below 20%", () => {
    const a = base();
    a.sql.txidWraparound = [{ schema: "public", table: "public.x", pct_wraparound: 25 }];
    expect(deriveFindings(a).find((x) => x.anchor === "#txid")?.severity).toBe("med");
    a.sql.txidWraparound = [{ schema: "public", table: "public.x", pct_wraparound: 12 }];
    expect(deriveFindings(a).some((x) => x.anchor === "#txid")).toBe(false);
  });

  test("inactive replication slot retaining WAL -> high Capacity finding", () => {
    const a = base();
    a.sql.replicationSlots = [
      { slot_name: "cdc", slot_type: "logical", active: false, retained_wal_bytes: 5_000_000 },
    ];
    const f = deriveFindings(a).find((x) => x.anchor === "#slots");
    expect(f?.severity).toBe("high");
    expect(f?.title).toContain("1 inactive replication slot");
  });

  test("active slot lagging >1GB -> med; small lag ignored", () => {
    const a = base();
    a.sql.replicationSlots = [
      { slot_name: "rep", slot_type: "physical", active: true, retained_wal_bytes: 2_147_483_648 },
    ];
    expect(deriveFindings(a).find((x) => x.anchor === "#slots")?.severity).toBe("med");
    a.sql.replicationSlots = [
      { slot_name: "rep", slot_type: "physical", active: true, retained_wal_bytes: 1000 },
    ];
    expect(deriveFindings(a).some((x) => x.anchor === "#slots")).toBe(false);
  });

  test("edge function high 5xx rate -> Performance finding", () => {
    const a = base();
    a.functionStats = [
      {
        slug: "boom",
        requests: 4,
        success: 0,
        clientErr: 0,
        serverErr: 4,
        avgExecMs: 500,
        maxExecMs: 900,
      },
      {
        slug: "hello",
        requests: 18,
        success: 10,
        clientErr: 8,
        serverErr: 0,
        avgExecMs: 470,
        maxExecMs: 2600,
      },
    ];
    const fns = deriveFindings(a).filter((x) => x.anchor === "#functions");
    expect(fns).toHaveLength(1);
    expect(fns[0]?.severity).toBe("high");
    expect(fns[0]?.title).toContain("boom");
    expect(fns[0]?.title).toContain("100% 5xx");
  });

  test("edge function low sample or clean -> no finding", () => {
    const a = base();
    a.functionStats = [
      {
        slug: "rare",
        requests: 2,
        success: 0,
        clientErr: 0,
        serverErr: 2,
        avgExecMs: 1,
        maxExecMs: 1,
      },
      {
        slug: "ok",
        requests: 100,
        success: 100,
        clientErr: 0,
        serverErr: 0,
        avgExecMs: 1,
        maxExecMs: 1,
      },
    ];
    expect(deriveFindings(a).some((x) => x.anchor === "#functions")).toBe(false);
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
