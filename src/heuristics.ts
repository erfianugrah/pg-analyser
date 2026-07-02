/**
 * Evergreen heuristics: thresholds + per-finding metadata (remediation, doc
 * link, review vintage), grounded in docs/heuristics.md. findings.ts reads
 * THRESHOLDS for the numbers and attaches HEURISTICS[id] metadata to each
 * Finding, so the deterministic report shows what/why/how and the `narrate`
 * LLM pass has cited facts to synthesize from (it cites these, never invents a
 * threshold). The sync check reports each entry's `reviewed` vintage.
 *
 * When you change a threshold or remediation, bump `reviewed` and confirm it
 * against the source in docs/heuristics.md.
 */

/** Vintage of the catalog: when the thresholds were last confirmed upstream. */
export const HEURISTICS_REVIEWED = "2026-07";

/** Evergreen thresholds. Stable Postgres/Supabase facts - see docs/heuristics.md. */
export const THRESHOLDS = {
  /** Cache hit ratio target (blks_hit / (blks_hit + blks_read)). */
  cacheHitPct: 99,
  /** Direct connections / max_connections warning fraction. */
  directConnFrac: 0.7,
  /** A role's connections / its conn_limit warning fraction. */
  roleConnFrac: 0.8,
  /** Disk used / total warning fraction. */
  diskFullFrac: 0.8,
  /** Derived disk IOPS / provisioned warning fraction. */
  diskIopsFrac: 0.8,
  /** Derived disk throughput / provisioned warning fraction. */
  diskThroughputFrac: 0.8,
  /** age(relfrozenxid) toward the 2B ceiling: warn / high percent. */
  txidWarnPct: 20,
  txidHighPct: 40,
  /** Estimated reclaimable bloat: minimum to report / bump to med. */
  bloatMinBytes: 50 * 1024 * 1024,
  bloatMedBytes: 500 * 1024 * 1024,
  /** Active replication slot retained WAL that counts as lag. */
  slotLagBytes: 1_073_741_824,
  /** Edge-function server-error rate: warn / high fraction, and min sample. */
  fnErrWarnFrac: 0.1,
  fnErrHighFrac: 0.2,
  fnMinRequests: 3,
  /** Edge-function client-error (4xx) rate worth noting. */
  fnClientErrFrac: 0.2,
  /** Memory available / total below this = pressure. */
  memAvailFrac: 0.1,
  /** Realtime usage vs plan cap warning fraction. */
  realtimeNearFrac: 0.8,
  /** Realtime channels per connection cap. */
  channelsPerConnCap: 100,
  /** A single pg_stat_statements query consuming >= this % of total DB time. */
  topQueryDbTimePct: 10,
  /** Dead tuples >= this multiple of live tuples => autovacuum not keeping up. */
  deadTupleLiveMultiple: 2,
} as const;

export type Plane =
  | "Query"
  | "RLS"
  | "Connections"
  | "Vacuum"
  | "Compute"
  | "Storage"
  | "Config"
  | "Auth"
  | "Realtime"
  | "Functions"
  | "Backups"
  | "Advisor";

export interface Heuristic {
  id: string;
  plane: Plane;
  /** One-line, copy-pasteable fix guidance. ASCII only (commit-safe). */
  remediation: string;
  /** Canonical doc/source URL for the reader (and the narrate pass to cite). */
  docUrl: string;
  /** Catalog vintage for this entry. */
  reviewed: string;
}

const R = HEURISTICS_REVIEWED;

/** Registry keyed by heuristic id. See docs/heuristics.md for the full grounding. */
export const HEURISTICS: Record<string, Heuristic> = {
  // --- Advisors (live, always current via the Management API) ---
  advisor_performance: {
    id: "advisor_performance",
    plane: "Advisor",
    remediation: "Open the Performance Advisor for the full finding + affected objects.",
    docUrl: "https://supabase.com/docs/guides/database/database-advisors",
    reviewed: R,
  },
  advisor_security: {
    id: "advisor_security",
    plane: "Advisor",
    remediation: "Open the Security Advisor for the full finding + affected objects.",
    docUrl: "https://supabase.com/docs/guides/database/database-advisors",
    reviewed: R,
  },

  // --- RLS & security ---
  rls_initplan: {
    id: "rls_initplan",
    plane: "RLS",
    remediation:
      "Wrap the auth call in a subselect so it runs once per query, not per row: using ((select auth.uid()) = user_id). Same for auth.jwt()/auth.role()/current_setting(). Official test: 179ms -> 9ms.",
    docUrl:
      "https://supabase.com/docs/guides/database/postgres/row-level-security#call-functions-with-select",
    reviewed: R,
  },

  // --- Query & index ---
  seq_scan_heavy: {
    id: "seq_scan_heavy",
    plane: "Query",
    remediation:
      "Add a btree index on the filtered/joined columns. Confirm with EXPLAIN (ANALYZE, BUFFERS) that the seq scan becomes an index scan.",
    docUrl: "https://supabase.com/docs/guides/database/query-optimization",
    reviewed: R,
  },
  unused_index: {
    id: "unused_index",
    plane: "Query",
    remediation:
      "Confirm the index does not back an occasional feature, then DROP INDEX CONCURRENTLY IF EXISTS ... (no table lock). Each unused index is write overhead for zero read benefit.",
    docUrl: "https://supabase.com/docs/guides/database/database-advisors",
    reviewed: R,
  },

  // --- Connections & pooler ---
  direct_conn_high: {
    id: "direct_conn_high",
    plane: "Connections",
    remediation:
      "Route app traffic through the connection pooler (Supavisor). For serverless use transaction mode (6543) with a small connection_limit.",
    docUrl: "https://supabase.com/docs/guides/database/connecting-to-postgres",
    reviewed: R,
  },
  role_conn_high: {
    id: "role_conn_high",
    plane: "Connections",
    remediation:
      "This role is near its own connection limit - pool its connections or raise the role's limit if the load is legitimate.",
    docUrl: "https://supabase.com/docs/guides/database/connecting-to-postgres",
    reviewed: R,
  },
  pooler_clients_waiting: {
    id: "pooler_clients_waiting",
    plane: "Connections",
    remediation:
      "Clients are queued for a pooler slot. Increase the pool size, shorten transactions, or reduce client connection_limit so slots free up faster.",
    docUrl: "https://supabase.com/docs/guides/database/supavisor",
    reviewed: R,
  },

  // --- Vacuum, bloat, txid ---
  autovacuum_overdue: {
    id: "autovacuum_overdue",
    plane: "Vacuum",
    remediation:
      "Dead tuples are past the autovacuum trigger. Lower autovacuum_vacuum_scale_factor per-table (e.g. 0.05 on big tables) and check for a long-running txn pinning the xmin horizon.",
    docUrl: "https://supabase.com/blog/postgres-bloat",
    reviewed: R,
  },
  table_bloat: {
    id: "table_bloat",
    plane: "Vacuum",
    remediation:
      "Reclaim online with pg_repack (brief final lock); VACUUM FULL needs an exclusive lock throughout. Run when no long-running transactions are open.",
    docUrl: "https://supabase.com/blog/postgres-bloat",
    reviewed: R,
  },
  txid_wraparound: {
    id: "txid_wraparound",
    plane: "Vacuum",
    remediation:
      "Freeze autovacuum is falling behind. At ~2B unfrozen XIDs Postgres halts writes. Find the oldest table by age(relfrozenxid), clear any xmin-pinning txn, and let anti-wraparound vacuum complete (it cannot be killed).",
    docUrl: "https://www.postgresql.org/docs/current/routine-vacuuming.html",
    reviewed: R,
  },

  // --- Storage & disk ---
  disk_full: {
    id: "disk_full",
    plane: "Storage",
    remediation:
      "Reclaim bloat (pg_repack), drop unused indexes, or expand the disk. Note cloud providers limit disk modifications to ~4 per rolling 24h.",
    docUrl: "https://supabase.com/docs/guides/platform/database-size",
    reviewed: R,
  },
  disk_iops_high: {
    id: "disk_iops_high",
    plane: "Storage",
    remediation:
      "Reduce read/write IOPS via indexing + cache hit, or provision more IOPS. Effective IOPS = min(compute-supported, provisioned-disk).",
    docUrl: "https://supabase.com/docs/guides/platform/compute-and-disk",
    reviewed: R,
  },
  wal_retained_inactive_slot: {
    id: "wal_retained_inactive_slot",
    plane: "Storage",
    remediation:
      "An inactive replication slot pins WAL and will fill the disk. Drop it if the downstream consumer is gone: SELECT pg_drop_replication_slot('<name>').",
    docUrl: "https://www.postgresql.org/docs/current/warm-standby.html#STREAMING-REPLICATION-SLOTS",
    reviewed: R,
  },
  wal_slot_lag: {
    id: "wal_slot_lag",
    plane: "Storage",
    remediation:
      "An active slot is retaining a large amount of WAL - the downstream consumer is slow. Investigate the consumer's replay lag.",
    docUrl: "https://www.postgresql.org/docs/current/warm-standby.html#STREAMING-REPLICATION-SLOTS",
    reviewed: R,
  },

  // --- Config & memory ---
  cache_hit_low: {
    id: "cache_hit_low",
    plane: "Config",
    remediation:
      "Below the 99% target, reads hit disk. Improve via better indexing and more RAM (compute upgrade) rather than only raising shared_buffers.",
    docUrl: "https://supabase.com/docs/guides/platform/performance",
    reviewed: R,
  },
  idle_in_txn_timeout_off: {
    id: "idle_in_txn_timeout_off",
    plane: "Config",
    remediation:
      "Set idle_in_transaction_session_timeout so abandoned transactions cannot pin the xmin horizon and block autovacuum.",
    docUrl: "https://www.postgresql.org/docs/current/runtime-config-client.html",
    reviewed: R,
  },
  statement_timeout_off: {
    id: "statement_timeout_off",
    plane: "Config",
    remediation:
      "Set a statement_timeout (per-role is fine) so runaway queries are capped instead of running unbounded.",
    docUrl: "https://www.postgresql.org/docs/current/runtime-config-client.html",
    reviewed: R,
  },

  // --- Point-in-time locks ---
  blocking_locks: {
    id: "blocking_locks",
    plane: "Query",
    remediation:
      "A blocking lock chain exists. Identify the blocker in pg_stat_activity and cancel it if safe: SELECT pg_cancel_backend(<pid>). Look for long transactions holding locks.",
    docUrl: "https://www.postgresql.org/docs/current/monitoring-stats.html",
    reviewed: R,
  },
  long_running: {
    id: "long_running",
    plane: "Query",
    remediation:
      "Queries running over 5 minutes. Check pg_stat_activity, add missing indexes, or set a statement_timeout. Long transactions also block autovacuum.",
    docUrl: "https://www.postgresql.org/docs/current/monitoring-stats.html",
    reviewed: R,
  },

  // --- Functions ---
  fn_5xx: {
    id: "fn_5xx",
    plane: "Functions",
    remediation:
      "Investigate the function logs for the 5xx cause. Track p95 latency > 1s and error rate > 1% as SLA triggers.",
    docUrl: "https://supabase.com/docs/guides/functions",
    reviewed: R,
  },

  // --- Platform ---
  pg_update_available: {
    id: "pg_update_available",
    plane: "Config",
    remediation:
      "A Postgres platform update is available. Schedule the upgrade (incurs brief downtime).",
    docUrl: "https://supabase.com/docs/guides/platform/upgrading",
    reviewed: R,
  },
};

/** Attach heuristic metadata to a finding by id. Unknown ids return {} (safe). */
export function meta(id: string): {
  heuristicId?: string;
  remediation?: string;
  docUrl?: string;
} {
  const h = HEURISTICS[id];
  if (!h) return {};
  return { heuristicId: h.id, remediation: h.remediation, docUrl: h.docUrl };
}
