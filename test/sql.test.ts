import { describe, expect, test } from "bun:test";
import { QUERIES } from "../src/sql.ts";

const WRITE = /\b(insert|update|delete|drop|alter|truncate|create|grant|revoke)\b/i;

describe("perf query set is read-only", () => {
  for (const [name, sql] of Object.entries(QUERIES)) {
    test(`${name} is a read-only SELECT/CTE with no write keywords`, () => {
      const head = sql.trim().toLowerCase();
      expect(head.startsWith("select") || head.startsWith("with")).toBe(true);
      // Strip single-quoted string literals before scanning: some queries carry
      // DDL/txn keywords inside literals (e.g. the outliers noise-filter patterns
      // and the NOT_APP_STATEMENT regex), which are data, not operations.
      const withoutLiterals = sql.replace(/'(?:[^']|'')*'/g, "''");
      expect(withoutLiterals).not.toMatch(WRITE);
    });
  }

  test("covers the monitor- best-practice diagnostics", () => {
    const keys = Object.keys(QUERIES);
    for (const k of [
      "topStatements",
      "indexStats",
      "seqScanHeavy",
      "deadTuples",
      "cacheHit",
      "bloat",
      "trafficProfile",
      "locks",
      "blocking",
      "longRunning",
    ]) {
      expect(keys).toContain(k);
    }
  });

  test("tableStatsResetAge reads the per-table counter reset from pg_stat_database", () => {
    expect(QUERIES.tableStatsResetAge).toBeDefined();
    expect(QUERIES.tableStatsResetAge).toContain("pg_stat_database");
    expect(QUERIES.tableStatsResetAge).toContain("stats_reset");
    // distinct from the pg_stat_statements window
    expect(QUERIES.tableStatsResetAge).not.toContain("pg_stat_statements");
  });

  test("longRunning excludes non-client backends (walsenders / autovacuum)", () => {
    expect(QUERIES.longRunning).toContain("backend_type = 'client backend'");
  });

  test("platform-noise denylist filters Realtime's publication poll", () => {
    // the outliers / latency-variance queries must exclude pg_publication[_tables]
    expect(QUERIES.queryIoStats).toContain("not ilike all");
    expect(QUERIES.topStatements).toContain("not ilike all");
    // the pattern list itself carries the pg_publication entry
    expect(QUERIES.topStatements).toContain("%pg_publication%");
    // and the replication-slot management calls (slot-ensure)
    expect(QUERIES.topStatements).toContain("%replication_slot%");
  });

  test("seqScanHeavy coalesces a null idx_scan to 0 (no blank cells / 100% pct)", () => {
    expect(QUERIES.seqScanHeavy).toContain("coalesce(idx_scan, 0) as idx_scan");
    expect(QUERIES.seqScanHeavy).toContain("seq_scan + coalesce(idx_scan, 0)");
  });

  test("walArchiving computes archiver_failing (last failure newer than last success)", () => {
    expect(QUERIES.walArchiving).toContain("archiver_failing");
    expect(QUERIES.walArchiving).toContain("last_failed_time > last_archived_time");
  });

  test("statsResetAge also captures dealloc (eviction count)", () => {
    expect(QUERIES.statsResetAge).toContain("dealloc");
  });

  test("sequenceExhaustion reads pg_sequences, app-scoped, above a usage floor", () => {
    expect(QUERIES.sequenceExhaustion).toContain("from pg_sequences");
    expect(QUERIES.sequenceExhaustion).toContain("pct_used");
    expect(QUERIES.sequenceExhaustion).toContain("0.70");
  });

  test("cronJobs collects run duration (overrun detection)", () => {
    expect(QUERIES.cronJobs).toContain("max_duration_s");
    expect(QUERIES.cronJobs).toContain("avg_duration_s");
  });

  test("index evidence cap raised to substantiate large advisor lists", () => {
    expect(QUERIES.indexStats).toContain("limit 100");
  });

  test("hbaRules includes the netmask column (address is ambiguous alone)", () => {
    expect(QUERIES.hbaRules).toContain("netmask");
  });

  test("connections split by backend_type (walsender not conflated with client)", () => {
    expect(QUERIES.connections).toContain("backend_type");
    expect(QUERIES.connections).toContain("group by state, backend_type");
  });
});
