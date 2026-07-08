import { describe, expect, test } from "bun:test";
import { deriveFindings, derivePositives } from "../src/findings.ts";
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
    },
    metrics: { available: false, samples: [] },
    trends: [],
    sync: null,
    narrative: null,
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

  test("cache hit NOT flagged on a tiny/idle DB (below the access-volume floor)", () => {
    // Real-world footgun: a 20MB nearly-idle project reports ~59% cache hit,
    // which is cold-start noise, not a tuning problem. Gate on block volume.
    const a = base();
    a.sql.cacheHitPct = 59;
    a.sql.cacheBlocksAccessed = 500; // well under the floor
    expect(deriveFindings(a).some((f) => f.title.includes("Cache hit ratio"))).toBe(false);
    // ...and no false "healthy cache" praise either at low volume
    a.sql.cacheHitPct = 99.9;
    expect(derivePositives(a).some((p) => p.title.includes("Cache hit"))).toBe(false);
  });

  test("cache hit flagged once the DB has done enough block access", () => {
    const a = base();
    a.sql.cacheHitPct = 92;
    a.sql.cacheBlocksAccessed = 5_000_000; // well over the floor
    expect(deriveFindings(a).some((f) => f.title.includes("Cache hit ratio 92%"))).toBe(true);
  });

  test("finding: idle-in-transaction backend past the age threshold", () => {
    const a = base();
    a.sql.connections = [
      { state: "active", connections: 3, max_state_age_s: 2 },
      { state: "idle in transaction", connections: 1, max_state_age_s: 900 },
    ];
    const f = deriveFindings(a).find((x) => x.heuristicId === "idle_in_txn_open");
    expect(f?.severity).toBe("med");
    expect(f?.title).toContain("Idle-in-transaction backend open 15 min");
  });

  test("finding: idle-in-transaction ignored when short-lived / plain idle", () => {
    const a = base();
    a.sql.connections = [
      { state: "idle in transaction", connections: 1, max_state_age_s: 30 },
      { state: "idle", connections: 6, max_state_age_s: 63568 },
    ];
    expect(deriveFindings(a).some((x) => x.heuristicId === "idle_in_txn_open")).toBe(false);
  });

  test("per-query temp spill -> med Performance finding naming the query", () => {
    const a = base();
    a.sql.queryIoStats = [
      {
        queryid: "1",
        calls: 500,
        temp_blks_written: 50000,
        temp_written: "390 MB",
        query: "select * from big order by x",
      },
    ];
    const f = deriveFindings(a).find((x) => x.heuristicId === "query_temp_spill");
    expect(f?.severity).toBe("med");
    expect(f?.title).toContain("spilling to disk");
    expect(f?.evidence).toContain("select * from big");
  });

  test("per-query temp spill NOT flagged below the block floor", () => {
    const a = base();
    a.sql.queryIoStats = [{ queryid: "1", calls: 500, temp_blks_written: 100, query: "q" }];
    expect(deriveFindings(a).some((x) => x.heuristicId === "query_temp_spill")).toBe(false);
  });

  test("per-query latency variance -> low finding; trivial-fast query ignored", () => {
    const a = base();
    a.sql.queryIoStats = [{ queryid: "1", calls: 300, cv: 4, mean_ms: 40, query: "select slow()" }];
    const f = deriveFindings(a).find((x) => x.heuristicId === "query_high_variance");
    expect(f?.severity).toBe("low");
    expect(f?.title).toContain("unstable latency");
    // high CV but sub-10ms mean -> not worth flagging
    a.sql.queryIoStats = [{ queryid: "1", calls: 300, cv: 8, mean_ms: 0.4, query: "q" }];
    expect(deriveFindings(a).some((x) => x.heuristicId === "query_high_variance")).toBe(false);
  });

  test("advisors grouped: plain-English title, scale in evidence, catalogued fix", () => {
    const a = base();
    a.advisors.performance = [
      { name: "unindexed_foreign_keys", title: "Unindexed foreign keys", level: "INFO" },
      { name: "unindexed_foreign_keys", title: "Unindexed foreign keys", level: "INFO" },
    ];
    const f = deriveFindings(a).find((x) => x.category === "Performance" && x.sql);
    // plain-English title from the lint catalog (not the raw lint title)
    expect(f?.title).toBe("Foreign keys without a covering index");
    // the group count is surfaced as scale in "what's happening"
    expect(f?.evidence).toContain("Affects 2 objects");
    // concrete, copy-pasteable fix instead of "open the advisor"
    expect(f?.sql).toContain("CREATE INDEX CONCURRENTLY");
    expect(f?.dashUrl).toContain("/advisors/performance");
  });

  test("unused indexes: application schemas counted, Supabase-managed excluded", () => {
    const a = base();
    a.sql.indexStats = [
      { schema: "auth", table: "auth.users", index: "auth.i1", unused: true }, // managed -> excluded
      { schema: "storage", table: "storage.objects", index: "storage.i5", unused: true }, // managed
      { schema: "public", table: "public.x", index: "public.i2", unused: true }, // app
      { schema: "app1", table: "app1.matches", index: "app1.i4", unused: true }, // custom app schema
      { schema: "public", table: "public.x", index: "public.i3", unused: false },
    ];
    const f = deriveFindings(a).find((x) => x.anchor === "#unused");
    // public.i2 + app1.i4 (auth/storage dropped); wording is schema-neutral
    expect(f?.title).toContain("2 unused indexes");
    expect(f?.title).not.toContain("in public");
  });

  test("cold TOAST cache -> med Performance de-toasting finding", () => {
    const a = base();
    a.sql.tableIoStats = [
      // meaningful disk reads + low TOAST hit ratio = de-toasting from disk
      {
        schema: "public",
        table: "public.embeddings",
        toast_blks_read: 900000,
        toast_hit_pct: 11.5,
      },
    ];
    const f = deriveFindings(a).find((x) => x.anchor === "#tableio");
    expect(f?.severity).toBe("med");
    expect(f?.category).toBe("Performance");
    expect(f?.title).toContain("de-toasting");
    expect(f?.title).toContain("11.5%");
  });

  test("TOAST cache-cold below the read-volume floor does not fire", () => {
    const a = base();
    a.sql.tableIoStats = [
      // low hit ratio but trivial read volume -> no finding
      { schema: "public", table: "public.small", toast_blks_read: 100, toast_hit_pct: 5 },
    ];
    expect(deriveFindings(a).some((x) => x.anchor === "#tableio")).toBe(false);
  });

  test("advisor unused_index lint suppresses the SQL fallback (no double-report)", () => {
    const a = base();
    a.advisors.performance = [{ name: "unused_index", title: "Unused Index", level: "INFO" }];
    a.sql.indexStats = [{ schema: "app1", table: "app1.t", index: "app1.i", unused: true }];
    const perf = deriveFindings(a).filter((x) => x.category === "Performance");
    // exactly one unused-index card - the advisor's, not the SQL fallback
    expect(perf.filter((x) => x.anchor === "#unused")).toHaveLength(0);
    expect(perf.some((x) => x.anchor === "#adv-perf")).toBe(true);
  });

  test("duplicate indexes -> med Performance finding (managed schema excluded)", () => {
    const a = base();
    a.sql.duplicateIndexes = [
      { schema: "public", table: "public.x", indexes: "i1, i2", copies: 2 },
      { schema: "auth", table: "auth.y", indexes: "i3, i4", copies: 2 },
    ];
    const f = deriveFindings(a).find((x) => x.anchor === "#dupidx");
    expect(f?.severity).toBe("med");
    expect(f?.category).toBe("Performance");
    expect(f?.title).toContain("1 table has duplicate indexes");
    expect(f?.title).not.toContain("public");
  });

  test("RLS policy columns without an index -> med Performance finding", () => {
    const a = base();
    a.sql.rlsUnindexed = [
      { schema: "public", table: "public.docs", column: "owner_id" },
      { schema: "public", table: "public.docs", column: "team_id" },
      { schema: "storage", table: "storage.objects", column: "bucket_id" },
    ];
    const f = deriveFindings(a).find((x) => x.anchor === "#rlsunindexed");
    expect(f?.severity).toBe("med");
    expect(f?.title).toContain("2 RLS policy columns lack a covering index");
  });

  test("swap occupancy does NOT produce a finding (static swap-used is not pressure)", () => {
    const a = base();
    a.metrics.samples = [
      { name: "node_memory_SwapTotal_bytes", labels: {}, value: 1_000_000_000 },
      { name: "node_memory_SwapFree_bytes", labels: {}, value: 20_000_000 },
    ];
    expect(deriveFindings(a).some((x) => x.title.includes("Swap"))).toBe(false);
  });

  test("cumulative deadlocks past the floor -> low Performance finding", () => {
    const a = base();
    a.metrics.samples = [
      { name: "pg_stat_database_deadlocks_total", labels: { datname: "postgres" }, value: 6 },
      { name: "pg_stat_database_deadlocks_total", labels: { datname: "app" }, value: 1 },
    ];
    const f = deriveFindings(a).find((x) => x.title.includes("deadlocks"));
    expect(f?.severity).toBe("low");
    expect(f?.title).toContain("7 deadlocks");
    a.metrics.samples = [
      { name: "pg_stat_database_deadlocks_total", labels: { datname: "postgres" }, value: 2 },
    ];
    expect(deriveFindings(a).some((x) => x.title.includes("deadlocks"))).toBe(false);
  });

  test("work_mem spill from temp-file rate trend -> Performance finding", () => {
    const a = base();
    a.trends = [{ title: "Temp file bytes/s", unit: "bytes", points: [{ t: 1, v: 5_000_000 }] }];
    const f = deriveFindings(a).find((x) => x.title.includes("spilling to disk"));
    expect(f?.category).toBe("Performance");
    a.trends = [{ title: "Temp file bytes/s", unit: "bytes", points: [{ t: 1, v: 1000 }] }];
    expect(deriveFindings(a).some((x) => x.title.includes("spilling to disk"))).toBe(false);
  });

  test("realtime postgres_changes subscriptions -> low nudge", () => {
    const a = base();
    a.metrics.samples = [
      { name: "realtime_postgres_changes_total_subscriptions", labels: {}, value: 12 },
    ];
    const f = deriveFindings(a).find((x) => x.title.includes("postgres_changes"));
    expect(f?.severity).toBe("low");
    expect(f?.title).toContain("12 active subscriptions");
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

  test("autovacuum finding fires only on overdue tables", () => {
    const a = base();
    a.sql.deadTuples = [
      { table: "public.a", dead_rows: 9000, autovacuum_at: 500, overdue: "yes" },
      { table: "public.b", dead_rows: 10, autovacuum_at: 500, overdue: "no" },
    ];
    const f = deriveFindings(a).find((x) => x.anchor === "#deadtuples");
    expect(f?.category).toBe("Capacity");
    expect(f?.title).toContain("1 table past the autovacuum");
    a.sql.deadTuples = [{ table: "public.b", dead_rows: 10, autovacuum_at: 500, overdue: "no" }];
    expect(deriveFindings(a).some((x) => x.anchor === "#deadtuples")).toBe(false);
  });

  test("role near its connection limit -> Capacity finding", () => {
    const a = base();
    a.sql.roleStats = [
      { role: "authenticator", connections: 48, conn_limit: 60 },
      { role: "postgres", connections: 2, conn_limit: 60 },
    ];
    const f = deriveFindings(a).find((x) => x.anchor === "#roles");
    expect(f?.title).toContain("authenticator");
    expect(f?.title).toContain("80%");
    expect(deriveFindings(a).filter((x) => x.anchor === "#roles")).toHaveLength(1);
  });

  test("estimated bloat flagged over 50MB, med over 500MB", () => {
    const a = base();
    a.sql.bloat = [{ name: "public.big", bloat_x: 3.1, waste: "120 MB", waste_bytes: 125829120 }];
    const f = deriveFindings(a).find((x) => x.anchor === "#bloat");
    expect(f?.severity).toBe("low");
    expect(f?.title).toContain("public.big");
    a.sql.bloat = [{ name: "public.huge", bloat_x: 5, waste: "800 MB", waste_bytes: 838860800 }];
    expect(deriveFindings(a).find((x) => x.anchor === "#bloat")?.severity).toBe("med");
    a.sql.bloat = [{ name: "public.tiny", bloat_x: 2, waste: "1 MB", waste_bytes: 1048576 }];
    expect(deriveFindings(a).some((x) => x.anchor === "#bloat")).toBe(false);
  });

  test("estimate is labelled as an estimate; churn note names the hot-write source", () => {
    const a = base();
    a.sql.bloat = [
      { name: "public.churned", bloat_x: 4.1, waste: "7 GB", waste_bytes: 7_600_000_000 },
    ];
    a.sql.topByCalls = [
      {
        queryid: "1",
        calls: 3_000_000,
        query: 'UPDATE "public"."churned" SET "n" = "n" + $1 WHERE "id" = $2',
      },
    ];
    const f = deriveFindings(a).find((x) => x.anchor === "#bloat");
    expect(f?.title).toContain("estimated reclaimable");
    expect(f?.title).toContain("pg_stats estimate");
    expect(f?.evidence).toContain("3,000,000 UPDATE calls");
  });

  test("exact pgstattuple bloat is preferred over the estimate, labelled measured", () => {
    const a = base();
    // Estimate says one thing; the measured pgstattuple row should win.
    a.sql.bloat = [{ name: "public.est", bloat_x: 2, waste: "120 MB", waste_bytes: 125_829_120 }];
    a.sql.bloatExact = [
      { name: "public.churned", reclaimable_bytes: 900_000_000, reclaimable: "858 MB" },
    ];
    const f = deriveFindings(a).find((x) => x.anchor === "#bloat");
    expect(f?.title).toContain("public.churned");
    expect(f?.title).toContain("measured via pgstattuple");
    expect(f?.severity).toBe("med"); // 858MB > 500MB med threshold
    expect(deriveFindings(a).filter((x) => x.anchor === "#bloat")).toHaveLength(1);
  });

  test("storage concentration: largest table flagged as a share of the DB", () => {
    const a = base();
    a.sql.dbSizeBytes = 60_000_000_000;
    a.sql.biggestTables = [
      {
        schema: "public",
        table: "public.dominant",
        total_size: "33 GB",
        index_size: "15 GB",
        total_bytes: 33_000_000_000,
        index_bytes: 15_000_000_000,
        live_rows: 60_000_000,
      },
    ];
    const f = deriveFindings(a).find((x) => x.title.includes("of the database"));
    expect(f?.category).toBe("Capacity");
    expect(f?.title).toContain("public.dominant is 55% of the database");
    expect(f?.evidence).toContain("indexes");
  });

  test("storage concentration does NOT fire below the 25% threshold", () => {
    const a = base();
    a.sql.dbSizeBytes = 100_000_000_000;
    a.sql.biggestTables = [
      {
        table: "public.small",
        total_size: "10 GB",
        index_size: "1 GB",
        total_bytes: 10_000_000_000,
        index_bytes: 1_000_000_000,
        live_rows: 1,
      },
    ];
    expect(deriveFindings(a).some((x) => x.title.includes("of the database"))).toBe(false);
  });

  test("index-heavy tables flagged (>=40% indexes, >=1GB), capped at 3, worst-first", () => {
    const a = base();
    a.sql.dbSizeBytes = 500_000_000_000; // avoid tripping storage_concentration
    const mk = (name: string, totalGb: number, idxFrac: number) => ({
      table: name,
      total_size: `${totalGb} GB`,
      index_size: `${Math.round(totalGb * idxFrac)} GB`,
      total_bytes: totalGb * 1_000_000_000,
      index_bytes: Math.round(totalGb * idxFrac) * 1_000_000_000,
      live_rows: 1,
    });
    a.sql.biggestTables = [
      mk("public.a", 10, 0.5), // 5GB idx
      mk("public.b", 8, 0.6), // 4.8GB idx
      mk("public.c", 6, 0.45), // 2.7GB idx
      mk("public.d", 4, 0.45), // 1.8GB idx - should be capped out
      mk("public.small", 0.5, 0.9), // under 1GB floor -> ignored
    ];
    const heavy = deriveFindings(a).filter((x) => x.title.includes("index-heavy"));
    expect(heavy).toHaveLength(3);
    // Worst-first by absolute index size: a (5GB) before b (4.8GB) before c (2.7GB).
    expect(heavy[0]?.title).toContain("public.a");
    expect(heavy.some((x) => x.title.includes("public.d"))).toBe(false);
    expect(heavy.some((x) => x.title.includes("public.small"))).toBe(false);
  });

  test("point-in-time blocking + long-running fire when non-empty", () => {
    const a = base();
    a.sql.blocking = [{ blocked_pid: 1, blocking_pid: 2 }];
    a.sql.longRunning = [{ pid: 3, duration: "00:06:00" }];
    const f = deriveFindings(a);
    const blk = f.find((x) => x.anchor === "#blocking");
    const lr = f.find((x) => x.anchor === "#longrunning");
    expect(blk?.severity).toBe("high");
    expect(lr?.severity).toBe("med");
    expect(lr?.title).toContain("1 query running > 5 min");
  });

  test("pooler clients-waiting finding uses the current metric name", () => {
    const a = base();
    a.metrics.samples = [
      { name: "pgbouncer_pools_client_waiting_connections", labels: { db: "a" }, value: 4 },
      { name: "pgbouncer_pools_client_waiting_connections", labels: { db: "b" }, value: 1 },
    ];
    const f = deriveFindings(a).find((x) => x.title.includes("waiting on the pooler"));
    expect(f?.category).toBe("Capacity");
    expect(f?.title).toContain("4 clients");
  });

  test("idle-in-transaction disabled flagged", () => {
    const a = base();
    a.sql.pgSettings = [{ name: "idle_in_transaction_session_timeout", setting: "0", unit: "ms" }];
    expect(deriveFindings(a).some((f) => f.title.includes("idle_in_transaction"))).toBe(true);
  });

  test("positives: healthy cache + wrapped+indexed RLS + PITR emitted", () => {
    const a = base();
    a.sql.cacheHitPct = 99.6;
    a.sql.rlsPolicies = [
      { table: "public.x", policyname: "p1", cmd: "SELECT", unwrapped_auth: false },
    ];
    a.sql.rlsUnindexed = [];
    a.sql.indexStats = [{ schema: "public", table: "public.x", index: "public.i", unused: false }];
    a.backups = { pitr_enabled: true };
    const p = derivePositives(a).map((x) => x.title);
    expect(p.some((t) => t.includes("Cache hit ratio 99.6%"))).toBe(true);
    expect(p.some((t) => t.includes("All 1 RLS policy wraps auth"))).toBe(true);
    expect(p.some((t) => t.includes("All RLS policy columns are indexed"))).toBe(true);
    expect(p.some((t) => t.includes("No unused indexes"))).toBe(true);
    expect(p.some((t) => t.includes("PITR"))).toBe(true);
  });

  test("positives: WAL-archiving proxy fires only in no-PAT mode, worded as inference", () => {
    // No-PAT: backups plane absent, superuser SQL sees active WAL archiving.
    const a = base();
    a.backups = null;
    a.sql.walArchiving = [{ archive_mode: "on", archived_count: 1234, failed_count: 0 }];
    const p = derivePositives(a).map((x) => x.title);
    expect(p.some((t) => t.includes("Continuous WAL archiving is active"))).toBe(true);
    // Inference wording only - it must NOT claim the PITR add-on flag.
    expect(p.some((t) => t === "Point-in-time recovery (PITR) is enabled")).toBe(false);
  });

  test("positives: WAL-archiving proxy suppressed when the backups plane is present (PAT)", () => {
    // PAT mode owns the authoritative flag; the SQL proxy must not double-emit
    // or contradict it. pitr_enabled:false + archive_mode on -> no proxy claim.
    const a = base();
    a.backups = { pitr_enabled: false };
    a.sql.walArchiving = [{ archive_mode: "on", archived_count: 999, failed_count: 0 }];
    const p = derivePositives(a).map((x) => x.title);
    expect(p.some((t) => t.includes("WAL archiving"))).toBe(false);
    expect(p.some((t) => t.includes("PITR"))).toBe(false);
  });

  test("positives: WAL-archiving proxy silent when archive_mode is off", () => {
    const a = base();
    a.backups = null;
    a.sql.walArchiving = [{ archive_mode: "off", archived_count: 0, failed_count: 0 }];
    expect(derivePositives(a).some((x) => x.title.includes("WAL archiving"))).toBe(false);
  });

  test("finding: pitr_absent fires in no-PAT when WAL archiving is not live", () => {
    const a = base();
    a.backups = null;
    a.sql.walArchiving = [{ archive_mode: "off", archived_count: 0 }];
    const f = deriveFindings(a).map((x) => x.title);
    expect(f.some((t) => t.includes("No continuous WAL archiving detected"))).toBe(true);
  });

  test("finding: pitr_absent suppressed when the backups plane is present (PAT)", () => {
    const a = base();
    a.backups = { pitr_enabled: false };
    a.sql.walArchiving = [{ archive_mode: "off", archived_count: 0 }];
    expect(deriveFindings(a).some((x) => x.title.includes("WAL archiving"))).toBe(false);
  });

  test("finding: hba_weak_auth fires on trust auth from a non-loopback address", () => {
    const a = base();
    a.sql.hbaRules = [
      {
        type: "host",
        database: "all",
        user_name: "all",
        address: "10.0.0.0",
        auth_method: "trust",
      },
    ];
    const f = deriveFindings(a).map((x) => x.title);
    expect(f.some((t) => t.includes("weak/no authentication"))).toBe(true);
  });

  test("finding: hba_weak_auth silent on standard Supabase scram host rules (no noise)", () => {
    const a = base();
    // The real-world Supabase default: all host rules use scram-sha-256.
    a.sql.hbaRules = [
      {
        type: "host",
        database: "all",
        user_name: "all",
        address: "0.0.0.0",
        auth_method: "scram-sha-256",
      },
      {
        type: "host",
        database: "all",
        user_name: "all",
        address: "::",
        auth_method: "scram-sha-256",
      },
    ];
    expect(deriveFindings(a).some((x) => x.title.includes("weak/no authentication"))).toBe(false);
  });

  test("finding: hba_weak_auth ignores loopback trust and replication rules", () => {
    const a = base();
    a.sql.hbaRules = [
      {
        type: "host",
        database: "all",
        user_name: "all",
        address: "127.0.0.1",
        auth_method: "trust",
      },
      { type: "host", database: "all", user_name: "all", address: "::1", auth_method: "trust" },
      {
        type: "host",
        database: "replication",
        user_name: "all",
        address: "0.0.0.0",
        auth_method: "trust",
      },
    ];
    expect(deriveFindings(a).some((x) => x.title.includes("weak/no authentication"))).toBe(false);
  });

  test("positives: nothing asserted on a degraded/unreachable project", () => {
    const a = base();
    a.sql.cacheHitPct = 99.9;
    a.meta.status = "INACTIVE";
    expect(derivePositives(a)).toHaveLength(0);
    const b = base();
    b.sql.cacheHitPct = 99.9;
    b.errors = [{ source: "sql:dbSize", message: "unreachable" }];
    expect(derivePositives(b)).toHaveLength(0);
  });

  test("positives: a finding and its positive are mutually exclusive", () => {
    const a = base();
    a.sql.cacheHitPct = 92; // below target -> finding, not a positive
    expect(deriveFindings(a).some((f) => f.title.includes("Cache hit ratio 92%"))).toBe(true);
    expect(derivePositives(a).some((p) => p.title.includes("Cache hit"))).toBe(false);
  });

  test("findings sorted high -> low severity", () => {
    const a = base();
    a.advisors.security = [{ name: "x", title: "Critical thing", level: "ERROR" }];
    a.sql.cacheHitPct = 95; // med
    a.sql.indexStats = [{ schema: "public", table: "public.x", index: "public.i", unused: true }]; // low
    const sev = deriveFindings(a).map((f) => f.severity);
    expect(sev).toEqual(
      [...sev].sort((x, y) => ({ high: 0, med: 1, low: 2 })[x] - { high: 0, med: 1, low: 2 }[y]),
    );
  });

  test("memory-pressure finding fires on sustained major-fault / swap-in rate", () => {
    const pts = (v: number) => [
      { t: 1, v },
      { t: 2, v },
      { t: 3, v },
    ];
    // below threshold -> no finding (avg 5 faults/s, 0 swap-in)
    const calm = base();
    calm.trends = [
      { title: "Major page faults/s", unit: "", points: pts(5) },
      { title: "Swap-in pages/s", unit: "", points: pts(0) },
    ];
    expect(deriveFindings(calm).some((f) => f.title.includes("Memory pressure"))).toBe(false);

    // sustained above threshold -> med Capacity finding, names the rate
    const hot = base();
    hot.trends = [
      { title: "Major page faults/s", unit: "", points: pts(34) },
      { title: "Swap-in pages/s", unit: "", points: pts(7) },
    ];
    const f = deriveFindings(hot).find((x) => x.title.includes("Memory pressure"));
    expect(f).toBeDefined();
    expect(f?.severity).toBe("med");
    expect(f?.title).toContain("major faults/s");
  });

  test("PSI saturation finding fires on sustained stall %, names the resource", () => {
    const pts = (v: number) => [
      { t: 1, v },
      { t: 2, v },
    ];
    const calm = base();
    calm.trends = [{ title: "CPU stall (PSI %)", unit: "%", points: pts(5) }];
    expect(deriveFindings(calm).some((f) => f.title.includes("Resource saturation"))).toBe(false);

    const hot = base();
    hot.trends = [
      { title: "CPU stall (PSI %)", unit: "%", points: pts(45) },
      { title: "I/O stall (PSI %)", unit: "%", points: pts(30) },
      { title: "Memory stall (PSI %)", unit: "%", points: pts(2) },
    ];
    const f = deriveFindings(hot).find((x) => x.title.includes("Resource saturation"));
    expect(f).toBeDefined();
    expect(f?.severity).toBe("med");
    expect(f?.title).toContain("CPU");
    expect(f?.title).toContain("I/O");
    expect(f?.title).not.toContain("memory"); // below threshold, omitted
  });

  test("OOM-kill finding fires on any nonzero rate", () => {
    const zero = base();
    zero.trends = [{ title: "OOM kills/s", unit: "", points: [{ t: 1, v: 0 }] }];
    expect(deriveFindings(zero).some((f) => f.title.includes("OOM killer"))).toBe(false);

    const killed = base();
    killed.trends = [{ title: "OOM kills/s", unit: "", points: [{ t: 1, v: 0.01 }] }];
    const f = deriveFindings(killed).find((x) => x.title.includes("OOM killer"));
    expect(f).toBeDefined();
    expect(f?.severity).toBe("high");
  });

  test("EBS-balance finding fires only when the series exists (absent != 0%)", () => {
    // series absent -> must NOT fire (a missing series is not 0% balance)
    const noSeries = base();
    noSeries.trends = [];
    expect(deriveFindings(noSeries).some((f) => f.title.includes("EBS burst balance"))).toBe(false);

    // healthy balance present -> no finding
    const healthy = base();
    healthy.trends = [{ title: "EBS IOPS balance (%)", unit: "%", points: [{ t: 1, v: 95 }] }];
    expect(deriveFindings(healthy).some((f) => f.title.includes("EBS burst balance"))).toBe(false);

    // depleting balance present -> high Capacity finding
    const low = base();
    low.trends = [
      {
        title: "EBS IOPS balance (%)",
        unit: "%",
        points: [
          { t: 1, v: 60 },
          { t: 2, v: 12 },
        ],
      },
    ];
    const f = deriveFindings(low).find((x) => x.title.includes("EBS burst balance"));
    expect(f).toBeDefined();
    expect(f?.severity).toBe("high");
    expect(f?.title).toContain("IOPS");
  });
});

describe("trend-driven capacity findings (data-aware)", () => {
  const DAY = 86400;
  // n points evenly spaced over spanDays, values start..end linearly.
  const series = (n: number, spanDays: number, start: number, end: number) =>
    Array.from({ length: n }, (_, i) => ({
      t: Math.floor((i * spanDays * DAY) / (n - 1)),
      v: start + (i * (end - start)) / (n - 1),
    }));

  test("CPU sustained high -> cpu_saturated (high); a single snapshot does NOT fire", () => {
    const hot = base();
    hot.trends = [{ title: "CPU utilization (%)", unit: "%", points: series(15, 10, 85, 88) }];
    const f = deriveFindings(hot).find((x) => x.title.includes("CPU sustained high"));
    expect(f?.severity).toBe("high");

    // same values but only 3 points -> insufficient history -> dormant
    const thin = base();
    thin.trends = [{ title: "CPU utilization (%)", unit: "%", points: series(3, 10, 85, 88) }];
    expect(deriveFindings(thin).some((x) => x.title.includes("CPU sustained"))).toBe(false);
  });

  test("CPU idle over a long window -> cpu_oversized (downsize)", () => {
    const idle = base();
    idle.trends = [{ title: "CPU utilization (%)", unit: "%", points: series(15, 15, 8, 12) }];
    const f = deriveFindings(idle).find((x) => x.title.includes("consistently idle"));
    expect(f?.severity).toBe("low");

    // idle but only 5 days of history -> not confident enough to suggest downsize
    const short = base();
    short.trends = [{ title: "CPU utilization (%)", unit: "%", points: series(15, 5, 8, 12) }];
    expect(deriveFindings(short).some((x) => x.title.includes("consistently idle"))).toBe(false);
  });

  test("Memory sustained high -> mem_saturated", () => {
    const m = base();
    m.trends = [{ title: "Memory used (%)", unit: "%", points: series(15, 10, 90, 92) }];
    expect(deriveFindings(m).some((x) => x.title.includes("Memory sustained high"))).toBe(true);
  });

  test("Disk filling fast -> projection fires; slow fill (beyond trust horizon) does NOT", () => {
    const fast = base();
    fast.trends = [{ title: "Disk used (%)", unit: "%", points: series(15, 10, 50, 80) }];
    const f = deriveFindings(fast).find((x) => x.title.includes("Data disk filling"));
    expect(f).toBeDefined();
    expect(f?.severity).toBe("high"); // ~7 days to full
    expect(f?.title).toContain("days to full");

    // rising, but so slowly that 100% is ~490 days out (>> 3x the 10d span) -> suppressed
    const slow = base();
    slow.trends = [{ title: "Disk used (%)", unit: "%", points: series(15, 10, 50, 51) }];
    expect(deriveFindings(slow).some((x) => x.title.includes("filling"))).toBe(false);
  });
});

describe("trend-driven tuning findings", () => {
  const DAY = 86400;
  const flat = (n: number, spanDays: number, v: number) =>
    Array.from({ length: n }, (_, i) => ({ t: Math.floor((i * spanDays * DAY) / (n - 1)), v }));

  test("checkpoint pressure fires when requested checkpoints dominate, not when timed", () => {
    const hot = base();
    hot.trends = [
      { title: "Requested checkpoints/s", unit: "", points: flat(15, 10, 0.5) },
      { title: "Timed checkpoints/s", unit: "", points: flat(15, 10, 0.5) },
    ];
    expect(deriveFindings(hot).some((f) => f.title.includes("Checkpoint pressure"))).toBe(true);

    const calm = base();
    calm.trends = [
      { title: "Requested checkpoints/s", unit: "", points: flat(15, 10, 0.05) },
      { title: "Timed checkpoints/s", unit: "", points: flat(15, 10, 1) },
    ];
    expect(deriveFindings(calm).some((f) => f.title.includes("Checkpoint pressure"))).toBe(false);
  });

  test("WAL archival backlog fires on sustained pending files", () => {
    const a = base();
    a.trends = [{ title: "WAL files pending archival", unit: "", points: flat(15, 10, 3) }];
    const f = deriveFindings(a).find((x) => x.title.includes("WAL archival falling behind"));
    expect(f?.severity).toBe("high");
  });

  test("connections ceiling fires when peak nears max_connections (from pgSettings)", () => {
    const near = base();
    near.sql.pgSettings = [{ name: "max_connections", setting: "100" }];
    near.trends = [{ title: "DB connections", unit: "", points: flat(15, 10, 90) }];
    expect(deriveFindings(near).some((f) => f.title.includes("Connections near ceiling"))).toBe(
      true,
    );

    const fine = base();
    fine.sql.pgSettings = [{ name: "max_connections", setting: "100" }];
    fine.trends = [{ title: "DB connections", unit: "", points: flat(15, 10, 40) }];
    expect(deriveFindings(fine).some((f) => f.title.includes("Connections near ceiling"))).toBe(
      false,
    );
  });
});

describe("securityConfigFindings", () => {
  function withSec(sec: NonNullable<Analysis["security"]>): Analysis {
    const a = base();
    a.security = sec;
    return a;
  }
  const emptySec = {
    auth: null,
    networkRestrictions: null,
    sslEnforcement: null,
  } as NonNullable<Analysis["security"]>;

  test("no-PAT (security null) -> no security-config findings", () => {
    expect(deriveFindings(base()).some((f) => f.anchor === "#seccfg")).toBe(false);
  });

  test("empty network restrictions -> med finding, reachable from any IP", () => {
    const a = withSec({ ...emptySec, networkRestrictions: { config: {} } });
    const f = deriveFindings(a).find((x) => x.heuristicId === "network_restrictions_open");
    expect(f?.category).toBe("Security");
    expect(f?.severity).toBe("med");
    expect(f?.title).toContain("any IP");
  });

  test("0.0.0.0/0 allowlist -> still flagged as open", () => {
    const a = withSec({
      ...emptySec,
      networkRestrictions: { config: { dbAllowedCidrs: ["0.0.0.0/0"] } },
    });
    expect(deriveFindings(a).some((f) => f.heuristicId === "network_restrictions_open")).toBe(true);
  });

  test("restricted CIDRs -> no finding, positive instead", () => {
    const a = withSec({
      ...emptySec,
      networkRestrictions: { config: { dbAllowedCidrs: ["10.0.0.0/8"] } },
    });
    expect(deriveFindings(a).some((f) => f.heuristicId === "network_restrictions_open")).toBe(
      false,
    );
    expect(
      derivePositives(a).some((p) => p.title.includes("network restrictions are configured")),
    ).toBe(true);
  });

  test("ssl enforcement off -> med finding; on -> positive", () => {
    const off = withSec({ ...emptySec, sslEnforcement: { currentConfig: { database: false } } });
    expect(deriveFindings(off).some((f) => f.heuristicId === "ssl_not_enforced")).toBe(true);
    const on = withSec({ ...emptySec, sslEnforcement: { currentConfig: { database: true } } });
    expect(deriveFindings(on).some((f) => f.heuristicId === "ssl_not_enforced")).toBe(false);
    expect(derivePositives(on).some((p) => p.title.includes("SSL enforcement is on"))).toBe(true);
  });

  test("email auto-confirm -> med; MFA absent among known fields -> low", () => {
    const a = withSec({
      ...emptySec,
      auth: { mailer_autoconfirm: true, mfa_totp_verify_enabled: false },
    });
    const f = deriveFindings(a);
    expect(f.find((x) => x.heuristicId === "auth_email_autoconfirm")?.severity).toBe("med");
    expect(f.find((x) => x.heuristicId === "auth_mfa_disabled")?.severity).toBe("low");
  });

  test("MFA enabled -> no MFA finding, positive instead", () => {
    const a = withSec({ ...emptySec, auth: { mfa_totp_verify_enabled: true } });
    expect(deriveFindings(a).some((f) => f.heuristicId === "auth_mfa_disabled")).toBe(false);
    expect(derivePositives(a).some((p) => p.title.includes("MFA factor is enabled"))).toBe(true);
  });

  test("weak password policy (short min length) -> med", () => {
    const a = withSec({
      ...emptySec,
      auth: { password_min_length: 6, password_hibp_enabled: false },
    });
    const f = deriveFindings(a).find((x) => x.heuristicId === "auth_weak_password_policy");
    expect(f?.severity).toBe("med");
    expect(f?.evidence).toContain("min length 6");
  });

  test("anonymous users + long jwt -> low findings", () => {
    const a = withSec({
      ...emptySec,
      auth: { external_anonymous_users_enabled: true, jwt_exp: 7200 },
    });
    const f = deriveFindings(a);
    expect(f.find((x) => x.heuristicId === "auth_anonymous_users")?.severity).toBe("low");
    const jwt = f.find((x) => x.heuristicId === "auth_long_jwt");
    expect(jwt?.severity).toBe("low");
    expect(jwt?.title).toContain("120 min");
  });

  test("MFA fields entirely absent -> no MFA finding (can't assert)", () => {
    const a = withSec({ ...emptySec, auth: { jwt_exp: 3600 } });
    expect(deriveFindings(a).some((f) => f.heuristicId === "auth_mfa_disabled")).toBe(false);
  });
});

describe("extension health findings", () => {
  test("outdated extension -> low finding with version evidence", () => {
    const a = base();
    a.sql.extensions = [
      { name: "pg_stat_statements", installed: "1.10", latest: "1.10", outdated: false },
      { name: "postgis", installed: "3.3.2", latest: "3.4.0", outdated: true },
    ];
    const f = deriveFindings(a).find((x) => x.heuristicId === "extensions_outdated");
    expect(f?.severity).toBe("low");
    expect(f?.evidence).toContain("postgis 3.3.2->3.4.0");
  });

  test("unindexed pgvector column -> med finding", () => {
    const a = base();
    a.sql.unindexedVectors = [{ schema: "public", table: "docs", column: "embedding" }];
    const f = deriveFindings(a).find((x) => x.heuristicId === "pgvector_unindexed");
    expect(f?.severity).toBe("med");
    expect(f?.evidence).toContain("public.docs.embedding");
  });

  test("unindexed pgvector: dimension + out-of-line (TOAST) surfaced in evidence", () => {
    const a = base();
    a.sql.unindexedVectors = [
      {
        schema: "public",
        table: "docs",
        column: "embedding",
        dimensions: 1536,
        storage: "extended",
        out_of_line: true,
      },
    ];
    const f = deriveFindings(a).find((x) => x.heuristicId === "pgvector_unindexed");
    expect(f?.evidence).toContain("public.docs.embedding (1536d, TOASTed)");
    expect(f?.evidence).toContain("de-toast from disk");
  });

  test("pg_cron installed, no run visibility -> review nudge", () => {
    const a = base();
    a.sql.extensions = [{ name: "pg_cron", installed: "1.6", latest: "1.6", outdated: false }];
    expect(deriveFindings(a).some((x) => x.heuristicId === "pg_cron_review")).toBe(true);
  });

  test("failing cron jobs -> med finding naming them; supersedes the nudge", () => {
    const a = base();
    a.sql.extensions = [{ name: "pg_cron", installed: "1.6", latest: "1.6", outdated: false }];
    a.sql.cronJobs = [
      { jobname: "nightly-etl", schedule: "0 2 * * *", active: true, failed_runs: 3, runs_7d: 7 },
      { jobname: "cleanup", schedule: "*/5 * * * *", active: true, failed_runs: 0, runs_7d: 2016 },
    ];
    const f = deriveFindings(a).find((x) => x.heuristicId === "cron_job_failing");
    expect(f?.severity).toBe("med");
    expect(f?.title).toContain("1 scheduled job");
    expect(f?.evidence).toContain("nightly-etl");
    // run visibility exists -> the generic nudge must NOT also fire
    expect(deriveFindings(a).some((x) => x.heuristicId === "pg_cron_review")).toBe(false);
  });

  test("healthy cron jobs -> no finding", () => {
    const a = base();
    a.sql.extensions = [{ name: "pg_cron", installed: "1.6", latest: "1.6", outdated: false }];
    a.sql.cronJobs = [
      { jobname: "cleanup", schedule: "*/5 * * * *", active: true, failed_runs: 0, runs_7d: 2016 },
    ];
    expect(deriveFindings(a).some((x) => x.anchor === "#cron")).toBe(false);
    expect(deriveFindings(a).some((x) => x.heuristicId === "pg_cron_review")).toBe(false);
  });

  test("no extension data -> no extension findings", () => {
    expect(deriveFindings(base()).some((f) => f.anchor === "#extensions")).toBe(false);
  });
});
