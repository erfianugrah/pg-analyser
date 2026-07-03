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
  /** Cumulative deadlocks (since stats reset) worth surfacing point-in-time. */
  deadlockMin: 5,
  /** Sustained temp-file spill rate (bytes/s, from >=2 snapshots) worth flagging. */
  tempSpillBytesPerSec: 1_048_576,
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
  /**
   * The consequence: why this finding matters to the business + engineer -
   * the impact (latency, cost/compute, capacity, risk of outage). This is the
   * "Why it matters" leg of the What/Why/How finding format. ASCII only.
   */
  whyItMatters: string;
  /**
   * How to confirm the fix worked: the specific inspect command / advisor lint /
   * dashboard panel to re-check, plus the value to expect. One sentence. ASCII.
   */
  howToVerify: string;
  /**
   * Optional concrete SQL/DDL command template for the fix, rendered as a
   * copy-pasteable code block. Placeholders in <angle> brackets for the reader
   * to fill from the evidence. ASCII only. Omit when there is no single command.
   */
  sql?: string;
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
    howToVerify:
      "Re-open the Performance Advisor after the change - the lint should drop off the list.",
    whyItMatters:
      "Performance lints flag concrete slow-path issues (missing/unindexed FKs, RLS re-evaluation). Left alone they inflate query latency and CPU, pushing you toward a bigger, costlier compute tier.",
    remediation: "Open the Performance Advisor for the full finding + affected objects.",
    docUrl: "https://supabase.com/docs/guides/database/database-advisors",
    reviewed: R,
  },
  advisor_security: {
    id: "advisor_security",
    plane: "Advisor",
    howToVerify: "Re-open the Security Advisor - the lint should clear once the object is fixed.",
    whyItMatters:
      "Security lints (exposed data, weak RLS/auth config) are direct exposure risk. A leak or unauthorized access is far costlier - in trust and remediation - than the fix.",
    remediation: "Open the Security Advisor for the full finding + affected objects.",
    docUrl: "https://supabase.com/docs/guides/database/database-advisors",
    reviewed: R,
  },

  // --- RLS & security ---
  rls_initplan: {
    id: "rls_initplan",
    plane: "RLS",
    sql: "-- rewrite the policy so the auth call runs once, not per row:\nusing ( (select auth.uid()) = <user_id_column> );",
    howToVerify:
      "EXPLAIN the policy query (or re-run the auth_rls_initplan lint) - the per-row auth call should be gone.",
    whyItMatters:
      "An auth.*() call in an RLS policy re-runs for every row scanned, so latency scales with table size, not result size (Supabase test: 179ms -> 9ms). It burns CPU on every authenticated read and caps throughput.",
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
    sql: "CREATE INDEX CONCURRENTLY ON <schema>.<table> (<filtered_or_joined_columns>);",
    howToVerify:
      "EXPLAIN (ANALYZE, BUFFERS) the query - the sequential scan should become an index scan.",
    whyItMatters:
      "Sequential scans read the whole table per query; as it grows, latency and IOPS grow with it - raising p99 latency and the compute/IOPS you provision to keep up.",
    remediation:
      "Add a btree index on the filtered/joined columns. Confirm with EXPLAIN (ANALYZE, BUFFERS) that the seq scan becomes an index scan.",
    docUrl: "https://supabase.com/docs/guides/database/query-optimization",
    reviewed: R,
  },
  unused_index: {
    id: "unused_index",
    plane: "Query",
    sql: "DROP INDEX CONCURRENTLY IF EXISTS <schema>.<index>;",
    howToVerify:
      "Watch pg_stat_user_indexes.idx_scan over a full cycle - it should stay 0 before you drop it.",
    whyItMatters:
      "An index never scanned is still maintained on every INSERT/UPDATE/DELETE - pure write amplification plus wasted storage you pay for, with zero read benefit.",
    remediation:
      "Confirm the index does not back an occasional feature, then DROP INDEX CONCURRENTLY IF EXISTS ... (no table lock). Each unused index is write overhead for zero read benefit.",
    docUrl: "https://supabase.com/docs/guides/database/database-advisors",
    reviewed: R,
  },
  duplicate_index: {
    id: "duplicate_index",
    plane: "Query",
    sql: "DROP INDEX CONCURRENTLY IF EXISTS <schema>.<redundant_index>; -- keep one copy",
    howToVerify:
      "Re-run the duplicate-index lint (or check pg_indexes) - only one definition should remain.",
    whyItMatters:
      "Identical indexes each pay full write-maintenance cost and consume storage for no additional read benefit - redundant compute and disk spend on every write.",
    remediation:
      "Two+ indexes have an identical definition on the same table - each copy is maintained on every write for zero read benefit. Keep one and DROP INDEX CONCURRENTLY IF EXISTS the rest (no table lock).",
    docUrl: "https://supabase.com/docs/guides/database/database-linter?lint=0009_duplicate_index",
    reviewed: R,
  },
  rls_col_unindexed: {
    id: "rls_col_unindexed",
    plane: "RLS",
    sql: "CREATE INDEX CONCURRENTLY ON <schema>.<table> (<policy_column>);",
    howToVerify:
      "EXPLAIN the policy-filtered query after indexing - the check should use the new index, not a seq scan.",
    whyItMatters:
      "A policy-compared column with no covering index forces a seq scan on every row check (Supabase test: 171ms -> <0.1ms once indexed) - user-facing latency and needless CPU on every authenticated read.",
    remediation:
      "A column compared in an RLS policy has no covering index, so each policy check seq-scans. Add a btree index on it: CREATE INDEX CONCURRENTLY ON <table> (<col>). Official test: 171ms -> <0.1ms once indexed.",
    docUrl: "https://supabase.com/docs/guides/database/postgres/row-level-security#add-indexes",
    reviewed: R,
  },

  // --- Connections & pooler ---
  direct_conn_high: {
    id: "direct_conn_high",
    plane: "Connections",
    howToVerify:
      "Watch pg_stat_activity - direct backends should fall once traffic moves to the pooler.",
    whyItMatters:
      "Nearing max_connections risks 'too many connections' errors that surface as user-facing failures. Each backend also costs 5-10MB RAM, so unpooled connections waste the memory that sets your compute tier.",
    remediation:
      "Route app traffic through the connection pooler (Supavisor). For serverless/edge use transaction mode (port 6543) with a small per-client pool (e.g. connection_limit=1-3 per function instance); reserve direct/session connections (5432) for migrations and long transactions.",
    docUrl: "https://supabase.com/docs/guides/database/connecting-to-postgres",
    reviewed: R,
  },
  role_conn_high: {
    id: "role_conn_high",
    plane: "Connections",
    howToVerify:
      "Compare this role's active connections in pg_stat_activity against its limit - it should sit well below.",
    whyItMatters:
      "This role is close to its own connection ceiling; hitting it fails that role's queries while the rest of the DB looks healthy - a silent, hard-to-diagnose partial outage.",
    remediation:
      "This role is near its own connection limit - pool its connections or raise the role's limit if the load is legitimate.",
    docUrl: "https://supabase.com/docs/guides/database/connecting-to-postgres",
    reviewed: R,
  },
  pooler_clients_waiting: {
    id: "pooler_clients_waiting",
    plane: "Connections",
    howToVerify:
      "Watch the pooler's clients-waiting metric - it should return to about zero after tuning pool size or transaction length.",
    whyItMatters:
      "Clients queued for a pooler slot wait before any query even runs, adding latency the DB-side metrics never show. Sustained queueing is a capacity signal.",
    remediation:
      "Clients are queued for a pooler slot. Increase the pool size, shorten transactions, or reduce client connection_limit so slots free up faster.",
    docUrl: "https://supabase.com/docs/guides/database/supavisor",
    reviewed: R,
  },

  // --- Vacuum, bloat, txid ---
  autovacuum_overdue: {
    id: "autovacuum_overdue",
    plane: "Vacuum",
    howToVerify:
      "Check pg_stat_user_tables.n_dead_tup and last_autovacuum - dead tuples should fall after autovacuum runs.",
    whyItMatters:
      "Dead tuples past the autovacuum threshold accumulate as bloat: tables and indexes grow, cache hit drops, scans slow, and disk fills with dead space you pay for.",
    remediation:
      "Dead tuples are past the autovacuum trigger. Lower autovacuum_vacuum_scale_factor per-table (e.g. 0.05 on big tables) and check for a long-running txn pinning the xmin horizon.",
    docUrl: "https://supabase.com/blog/postgres-bloat",
    reviewed: R,
  },
  table_bloat: {
    id: "table_bloat",
    plane: "Vacuum",
    howToVerify:
      "Re-run the bloat estimate (supabase inspect db bloat) - the table's waste should drop after pg_repack.",
    whyItMatters:
      "Reclaimable bloat is disk you pay for that holds no live data, and bloated tables/indexes slow scans and lower cache efficiency across the board.",
    remediation:
      "Reclaim online with pg_repack (brief final lock); VACUUM FULL needs an exclusive lock throughout. Run when no long-running transactions are open.",
    docUrl: "https://supabase.com/blog/postgres-bloat",
    reviewed: R,
  },
  txid_wraparound: {
    id: "txid_wraparound",
    plane: "Vacuum",
    sql: "-- find the oldest table, then vacuum to freeze it:\nSELECT relname, age(relfrozenxid) FROM pg_class WHERE relkind='r' ORDER BY age(relfrozenxid) DESC LIMIT 5;\nVACUUM (FREEZE, VERBOSE) <schema>.<table>;",
    howToVerify:
      "Check age(relfrozenxid) on the oldest table - it should fall well below the 2B ceiling after vacuum.",
    whyItMatters:
      "Transaction-ID age nearing the ~2B ceiling is existential: at the limit Postgres stops accepting writes until an unkillable anti-wraparound vacuum completes - a hard, self-inflicted outage.",
    remediation:
      "Freeze autovacuum is falling behind. At ~2B unfrozen XIDs Postgres halts writes. Find the oldest table by age(relfrozenxid), clear any xmin-pinning txn, and let anti-wraparound vacuum complete (it cannot be killed).",
    docUrl: "https://www.postgresql.org/docs/current/routine-vacuuming.html",
    reviewed: R,
  },

  // --- Storage & disk ---
  disk_full: {
    id: "disk_full",
    plane: "Storage",
    howToVerify:
      "Re-check disk usage (Database settings in the dashboard, or pg_database_size) - it should drop after reclaiming or expanding.",
    whyItMatters:
      "A full disk forces Postgres read-only - a complete outage. Providers also cap disk changes to ~4 per rolling 24h, so you cannot always grow your way out in time.",
    remediation:
      "Reclaim bloat (pg_repack), drop unused indexes, or expand the disk. Note cloud providers limit disk modifications to ~4 per rolling 24h.",
    docUrl: "https://supabase.com/docs/guides/platform/database-size",
    reviewed: R,
  },
  disk_iops_high: {
    id: "disk_iops_high",
    plane: "Storage",
    howToVerify:
      "Re-check disk I/O after indexing or provisioning more IOPS - utilisation should sit below saturation.",
    whyItMatters:
      "Sustained IOPS near the ceiling throttles every query behind disk I/O, spiking latency. Effective IOPS is the min of compute and disk, so both must be sized - and over-provisioned IOPS is money spent on headroom you never use.",
    remediation:
      "Reduce read/write IOPS via indexing + cache hit, or provision more IOPS. Effective IOPS = min(compute-supported, provisioned-disk).",
    docUrl: "https://supabase.com/docs/guides/platform/compute-and-disk",
    reviewed: R,
  },
  wal_retained_inactive_slot: {
    id: "wal_retained_inactive_slot",
    plane: "Storage",
    sql: "SELECT pg_drop_replication_slot('<slot_name>'); -- only if the consumer is gone",
    howToVerify:
      "Check pg_replication_slots - the inactive slot should be gone and retained WAL should fall.",
    whyItMatters:
      "An inactive replication slot pins WAL indefinitely and will fill the disk - an eventual write outage caused by a consumer that no longer exists.",
    remediation:
      "An inactive replication slot pins WAL and will fill the disk. Drop it if the downstream consumer is gone: SELECT pg_drop_replication_slot('<name>').",
    docUrl: "https://www.postgresql.org/docs/current/warm-standby.html#STREAMING-REPLICATION-SLOTS",
    reviewed: R,
  },
  wal_slot_lag: {
    id: "wal_slot_lag",
    plane: "Storage",
    howToVerify:
      "Check retained WAL in pg_replication_slots - it should shrink once the consumer catches up.",
    whyItMatters:
      "A large WAL backlog on an active slot means a slow downstream consumer; the retained WAL grows disk use and risks the same disk-full write outage.",
    remediation:
      "An active slot is retaining a large amount of WAL - the downstream consumer is slow. Investigate the consumer's replay lag.",
    docUrl: "https://www.postgresql.org/docs/current/warm-standby.html#STREAMING-REPLICATION-SLOTS",
    reviewed: R,
  },

  // --- Config & memory ---
  cache_hit_low: {
    id: "cache_hit_low",
    plane: "Config",
    howToVerify:
      "Re-check the cache-hit ratio (supabase inspect db cache) - it should climb toward 99% after indexing or more RAM.",
    whyItMatters:
      "Below the 99% target, reads fall through to disk - higher latency and IOPS, and a signal the working set no longer fits in RAM (a memory/compute sizing decision, not just a knob).",
    remediation:
      "Below the 99% target, reads hit disk. Aim for >= 99%: improve via better indexing on hot tables and more RAM (a compute-tier upgrade sizes shared_buffers/effective_cache_size for you) rather than only raising shared_buffers - a working set larger than RAM is a sizing decision, not a knob.",
    docUrl: "https://supabase.com/docs/guides/platform/performance",
    reviewed: R,
  },
  idle_in_txn_timeout_off: {
    id: "idle_in_txn_timeout_off",
    plane: "Config",
    sql: "-- per role (fine to tune the value):\nALTER ROLE authenticator SET idle_in_transaction_session_timeout = '2min';\n-- or globally, then reload:\nALTER DATABASE postgres SET idle_in_transaction_session_timeout = '2min';",
    howToVerify: "SHOW idle_in_transaction_session_timeout - it should return a non-zero value.",
    whyItMatters:
      "With no idle-in-transaction timeout, an abandoned transaction pins the xmin horizon, blocking autovacuum and driving bloat + wraparound risk across the whole database.",
    remediation:
      "Set a concrete bound so abandoned transactions cannot pin the xmin horizon: '2min' is a safe default for most roles (raise to '5min'-'10min' for long batch/ETL roles). Set it per role (authenticator/postgres/custom) or on the database.",
    docUrl: "https://www.postgresql.org/docs/current/runtime-config-client.html",
    reviewed: R,
  },
  statement_timeout_off: {
    id: "statement_timeout_off",
    plane: "Config",
    sql: "-- per role (recommended - matches Supabase's own per-role defaults):\nALTER ROLE authenticator SET statement_timeout = '30s';\n-- or set the global cap for any role without its own:\nALTER DATABASE postgres SET statement_timeout = '60s';",
    howToVerify:
      "Query pg_roles.rolconfig for the role (per-role settings don't show via SHOW), or SHOW statement_timeout for the global cap - it should return a non-zero value.",
    whyItMatters:
      "With no statement_timeout, a runaway query runs unbounded - holding locks, pinning resources, and degrading everyone until it finishes or is manually killed. Supabase ships per-role defaults (anon 3s, authenticated 8s), but the postgres role and any custom roles are only bounded by the 2min global cap, so a global 0 leaves them uncapped.",
    remediation:
      "Set a concrete cap. Good starting values: interactive/API roles '30s'-'60s', analytics/batch roles '2min'-'5min'. Supabase's own defaults are anon 3s and authenticated 8s; set the postgres role and any custom roles explicitly (they otherwise inherit only the 2min global cap). Per-role: ALTER ROLE <role> SET statement_timeout = '30s'; global: ALTER DATABASE postgres SET statement_timeout = '60s'.",
    docUrl: "https://supabase.com/docs/guides/database/postgres/timeouts",
    reviewed: R,
  },

  // --- Point-in-time locks ---
  blocking_locks: {
    id: "blocking_locks",
    plane: "Query",
    sql: "-- identify the blocker in pg_stat_activity, then if safe:\nSELECT pg_cancel_backend(<blocking_pid>);",
    howToVerify:
      "Re-check pg_stat_activity / the blocking view - no rows should remain blocked once the blocker clears.",
    whyItMatters:
      "A blocking lock chain stalls every waiter behind it - user-facing latency or timeouts concentrated on the locked rows/tables.",
    remediation:
      "A blocking lock chain exists. Identify the blocker in pg_stat_activity and cancel it if safe: SELECT pg_cancel_backend(<pid>). Look for long transactions holding locks.",
    docUrl: "https://www.postgresql.org/docs/current/monitoring-stats.html",
    reviewed: R,
  },
  long_running: {
    id: "long_running",
    plane: "Query",
    howToVerify:
      "Watch pg_stat_activity for a large query_start age - nothing should exceed 5 minutes.",
    whyItMatters:
      "Queries over 5 minutes hold resources and (in a transaction) block autovacuum; they usually signal a missing index or an unbounded scan that will only get slower.",
    remediation:
      "Queries running over 5 minutes. Check pg_stat_activity, add missing indexes, or set a statement_timeout. Long transactions also block autovacuum.",
    docUrl: "https://www.postgresql.org/docs/current/monitoring-stats.html",
    reviewed: R,
  },

  // --- Functions ---
  fn_5xx: {
    id: "fn_5xx",
    plane: "Functions",
    howToVerify: "Watch the function's invocation stats - the 5xx rate should return below 1%.",
    whyItMatters:
      "Server errors are failed user requests - direct product impact. A sustained 5xx rate is an SLA-breach signal, not a cosmetic one.",
    remediation:
      "Investigate the function logs for the 5xx cause. Track p95 latency > 1s and error rate > 1% as SLA triggers.",
    docUrl: "https://supabase.com/docs/guides/functions",
    reviewed: R,
  },

  // --- Compute / memory (metrics-derived) ---
  deadlocks: {
    id: "deadlocks",
    plane: "Query",
    howToVerify:
      "Check pg_stat_database.deadlocks over the next window - the count should stop increasing.",
    whyItMatters:
      "Deadlocks abort a transaction outright, surfacing as errors to users. Recurring deadlocks mean inconsistent lock ordering that will keep failing writes until fixed.",
    remediation:
      "Deadlocks have occurred (pg_stat_database_deadlocks). Order writes consistently across transactions, keep transactions short, and take row locks in a fixed order. Investigate the involved statements in the logs.",
    docUrl: "https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-DEADLOCKS",
    reviewed: R,
  },
  work_mem_spill: {
    id: "work_mem_spill",
    plane: "Config",
    howToVerify:
      "Watch temp-file bytes (pg_stat_database.temp_bytes) - spill should drop after raising work_mem or indexing.",
    whyItMatters:
      "Sorts/hash joins spilling to disk are far slower than in-memory and add IOPS. Raising work_mem fixes latency, but total = max_connections x work_mem must stay within RAM or you risk OOM.",
    remediation:
      "Sorts/hash joins are spilling to disk (temp files). Raise work_mem for the offending queries - the Supabase default is small (usually a few MB), so try '16MB'-'64MB' per-role or per-session (SET work_mem = '32MB'), or reduce the sort/hash volume with better indexing. Keep the ceiling max_connections x work_mem within RAM so you don't OOM - tune per-session, not globally.",
    docUrl: "https://www.postgresql.org/docs/current/runtime-config-resource.html",
    reviewed: R,
  },
  realtime_postgres_changes: {
    id: "realtime_postgres_changes",
    plane: "Realtime",
    howToVerify:
      "Check active logical replication slots and Realtime subscriptions - postgres_changes usage should fall after moving to Broadcast.",
    whyItMatters:
      "postgres_changes holds a logical replication slot and polls it per WAL record; it does not scale and can pin WAL. Broadcast is the scalable, cheaper-at-load path.",
    remediation:
      "postgres_changes has active subscriptions. It acquires a logical replication slot and polls it (appending subscription IDs per WAL record) and does not scale as well as Broadcast. For scale/security, migrate to realtime.broadcast_changes() triggers.",
    docUrl: "https://supabase.com/docs/guides/realtime/subscribing-to-database-changes",
    reviewed: R,
  },

  // --- Platform ---
  pg_update_available: {
    id: "pg_update_available",
    plane: "Config",
    howToVerify:
      "Check the platform version in the dashboard - it should match the latest after the upgrade.",
    whyItMatters:
      "Running behind the platform version misses performance, security, and stability fixes; the upgrade is brief scheduled downtime now versus carrying known issues indefinitely.",
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
  whyItMatters?: string;
  howToVerify?: string;
  sql?: string;
  docUrl?: string;
} {
  const h = HEURISTICS[id];
  if (!h) return {};
  return {
    heuristicId: h.id,
    remediation: h.remediation,
    whyItMatters: h.whyItMatters,
    howToVerify: h.howToVerify,
    sql: h.sql,
    docUrl: h.docUrl,
  };
}
