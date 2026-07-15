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
  /** Minimum heap blocks accessed (since stats reset) before the cache-hit
   * ratio is trustworthy. Below this the DB is too small/idle for the ratio to
   * mean anything (cold-start reads dominate), so we neither warn nor praise.
   * 12500 blocks x 8KB = ~100MB of block access. */
  cacheHitMinBlocks: 12500,
  /** Idle-in-transaction backend age (seconds) at/above which to flag it. A
   * healthy transaction is sub-second; minutes means an abandoned/leaked one. */
  idleInTxnAgeS: 300,
  /** Temp blocks written by a single query (since stats reset) above which it is
   * spilling sorts/hashes to disk. 12500 blocks x 8KB = ~100MB written. */
  tempSpillBlocks: 12500,
  /** TOAST cache-hit ratio (toast_blks_hit / (hit+read)) at/below which a
   * table's out-of-line column is being re-read from disk rather than served
   * from cache - the de-toasting IO trap. */
  toastColdHitPct: 95,
  /** Minimum TOAST blocks read from disk (since stats reset) before the cold-
   * TOAST finding fires - the activity floor so a tiny/idle TOAST table doesn't
   * trip it. 50000 blocks x 8KB = ~400MB of de-toast reads. */
  toastColdMinReadBlocks: 50000,
  /** Coefficient of variation (stddev/mean) at/above which a query's latency is
   * unstable enough to flag - paired with a mean-ms floor so trivial fast
   * queries don't trip it. */
  queryCvWarn: 2,
  queryCvMinMeanMs: 10,
  /** Direct connections / max_connections warning fraction. */
  directConnFrac: 0.7,
  /** A role's connections / its conn_limit warning fraction (finding). */
  roleConnFrac: 0.8,
  /** A role's connections / its conn_limit at/above which the report shows the
   * role-usage table at all (display gate; below the finding threshold so the
   * table appears before saturation is critical). */
  roleConnShowFrac: 0.5,
  /** Disk used / total warning fraction. */
  diskFullFrac: 0.8,
  /** Disk over-provisioned (downsize candidate): filesystem used at/below this
   * fraction of the provisioned volume, AND at least diskOversizeMinWasteGb of
   * unused headroom (so a small volume with natural slack isn't flagged). */
  diskOversizeUsedFrac: 0.4,
  diskOversizeMinWasteGb: 20,
  /** work_mem blast radius: worst-case (work_mem x max_connections x parallel)
   * at/above this multiple of estimated RAM is an OOM risk worth flagging.
   * RAM is estimated from shared_buffers (Supabase sets it to ~25% of RAM). */
  workMemBlastFrac: 1.0,
  /** maintenance_work_mem is flagged low only RAM-relatively (Supabase
   * auto-scales it per tier): fire when it is below this fraction of estimated
   * RAM AND the instance has at least maintWorkMemMinRamGb of RAM, so small
   * tiers with a correctly-small value are never flagged. */
  maintWorkMemMinFrac: 0.03,
  maintWorkMemMinRamGb: 8,
  /** checkpoint_completion_target below this spreads checkpoint I/O too tightly
   * (spiky flushes); modern Postgres defaults to 0.9. */
  checkpointCompletionMin: 0.7,
  /** Derived disk IOPS / provisioned warning fraction. */
  diskIopsFrac: 0.8,
  /** Derived disk throughput / provisioned warning fraction. */
  diskThroughputFrac: 0.8,
  /** age(relfrozenxid) toward the 2B ceiling: warn / high percent. Reused for
   * the multixact-ID ceiling (relminmxid), which shares the same 2B limit. */
  txidWarnPct: 20,
  txidHighPct: 40,
  /** A single statement generating at/above this % of total WAL bytes is a
   * write-amplification hotspot worth attributing. */
  walHeavyPct: 40,
  /** Estimated reclaimable bloat: minimum to report / bump to med. */
  bloatMinBytes: 50 * 1024 * 1024,
  bloatMedBytes: 500 * 1024 * 1024,
  /** A single table this fraction (or more) of total DB size = worth
   * attributing in a finding ("table X is N% of the database"), so the disk
   * story names its dominant consumer instead of leaving it in a drill-down. */
  storageConcentrationFrac: 0.25,
  /** A large table whose indexes are this fraction (or more) of its total size
   * is index-heavy - worth reviewing for unused/redundant indexes (they cost
   * disk + write amplification). Gated by a size floor so small tables with a
   * couple of natural indexes don't trip it. */
  indexHeavyFrac: 0.4,
  indexHeavyMinBytes: 1024 * 1024 * 1024,
  /** Cap on how many index-heavy tables get their own finding (worst-first by
   * index size); the rest stay in the biggest-tables drill-down. */
  indexHeavyMaxFindings: 3,
  /** Write calls (UPDATE/DELETE) against one table above which it is a plausible
   * churn source for that table's bloat/dead-tuples - used to annotate the
   * bloat finding with the likely cause (a hot counter update, say). */
  hotWriteMinCalls: 100_000,
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
  /** Sustained major page faults/s (from >=2 snapshots): working set spilling
   * out of RAM to disk. A MemAvailable snapshot can look healthy while this
   * happens, so this is a rate-only signal. */
  majorFaultsPerSec: 20,
  /** Sustained swap-in pages/s: the box is actively paging anon memory back
   * from swap - real memory pressure, not benign cold-page parking. */
  swapInPagesPerSec: 2,
  /** Sustained PSI stall % (Linux /proc/pressure; fraction of time tasks waited
   * on a resource, from >=2 snapshots / a Prometheus). A truer saturation
   * signal than a utilization snapshot - work can stall while idle% looks fine. */
  psiStallPct: 20,
  /** EBS burst-balance % at/below which AWS gp2/gp3 throttling is imminent
   * (I/O or throughput credit depletion - a latency cliff in-guest metrics miss). */
  ebsBalancePct: 20,
  /** CPU sustained-high: fire when >= cpuSustainedFrac of the trend window sits
   * at/above cpuSustainedHighPct util. A trend signal (needs a real window). */
  cpuSustainedHighPct: 80,
  cpuSustainedFrac: 0.5,
  /** CPU over-provisioned (downsize candidate): p95 util at/below cpuOversizePct
   * across a window of at least cpuOversizeMinDays (long enough to be confident
   * before recommending a smaller tier). */
  cpuOversizePct: 20,
  cpuOversizeMinDays: 14,
  /** Memory sustained-high: >= memSustainedFrac of the window at/above this %. */
  memSustainedHighPct: 85,
  memSustainedFrac: 0.3,
  /** Disk-fill projection horizon: warn when a rising disk-used% trend is on
   * track to hit 100% within this many days (capped to ~3x the observed span
   * so we never extrapolate far past the data we actually have). */
  diskFillHorizonDays: 120,
  /** Checkpoint pressure: fraction of checkpoints that were REQUESTED (forced
   * by WAL filling) rather than timed. A high share means max_wal_size is too
   * small - Postgres is checkpointing on WAL pressure, not the interval. */
  checkpointReqFrac: 0.3,
  /** WAL archival backlog: sustained files-pending-archival at/above this = the
   * archiver is falling behind (PITR / backup-freshness risk). */
  walPendingMax: 1,
  /** Connection ceiling: peak backends at/above this fraction of max_connections
   * over the window = approaching the limit (pooler / max_connections sizing). */
  connCeilingFrac: 0.8,
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
  /** Auth password min length below which the policy is called out as weak. */
  passwordMinLength: 8,
  /** Access-token (jwt_exp) TTL above which a long-lived token is flagged (sec). */
  jwtExpMaxSec: 3600,
  /** Minimum stats-accumulation window (days) before a counter-derived finding
   * (unused index, cache-hit ratio, dead-tuple / autovacuum-overdue) is treated
   * as high-confidence. Below this the counters have not seen a full workload
   * cycle, so the finding carries a low-confidence caveat rather than acting. */
  minStatsWindowDays: 7,
  /** Byte floor for the stale-table-stats contradiction check: a table that
   * reports 0 live rows but occupies at least this much disk almost certainly
   * had its counters reset (pg_statistic / size survive), not truly empty. */
  staleStatsMinBytes: 10 * 1024 * 1024,
  /** Minimum slope (bytes/day) of an active slot's retained WAL before the
   * trend-based "retention climbing" finding fires - a floor so a trivially
   * rising series is not flagged. Catches the "396 MB and growing" case the
   * point-in-time 1 GiB threshold (slotLagBytes) misses. */
  slotWalGrowthMinBytesPerDay: 256 * 1024 * 1024,
  /** Fractional jump in provisioned volume size between consecutive trend
   * points that counts as a RESIZE (not organic growth). Used to segment the
   * disk series so a manual/auto expansion isn't trended as a fill/empty. */
  diskResizeStepFrac: 0.2,
  /** pct-used of a sequence's max at/above which exhaustion is HIGH (else MED).
   * The SQL surfaces sequences >=70% used; this is the escalation line. */
  sequenceExhaustionHighPct: 90,
  /** cron.job_run_details size past which the unpruned-history finding fires
   * (pg_cron never prunes its own run log). */
  cronHistoryMaxBytes: 50 * 1024 * 1024,
  /** Space-per-row cross-check: a table with >= this many bytes/row that the
   * pg_stats estimator still calls un-bloated is structurally suspect. */
  spacePerRowHighBytes: 8 * 1024,
  spacePerRowMinRows: 1000,
  spacePerRowMinBytes: 50 * 1024 * 1024,
  /** bloat_x below this = estimator says "not bloated" (so a huge bytes/row is
   * the estimator's blind spot, not a caught bloat). */
  spacePerRowEstMax: 1.5,
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
  /**
   * Optional Supabase changelog / known-issue URL documenting a platform change
   * behind this finding. Rendered as an extra "Changelog" reference and surfaced
   * to the narrate pass. MUST be a real, verified URL - never a guess.
   */
  changelogUrl?: string;
  /** Catalog vintage for this entry. */
  reviewed: string;
}

const R = HEURISTICS_REVIEWED;

/** Registry keyed by heuristic id. See docs/heuristics.md for the full grounding. */
export const HEURISTICS: Record<string, Heuristic> = {
  cron_history_unpruned: {
    id: "cron_history_unpruned",
    plane: "Storage",
    howToVerify:
      "After scheduling a cleanup, cron.job_run_details row count / size should stop growing unbounded; the table's WAL share drops.",
    whyItMatters:
      "pg_cron does not prune its own run log - cron.job_run_details grows forever (per-minute jobs add ~2,880 rows/day). Left alone it bloats, dominates writes (its bookkeeping INSERTs become top-frequency statements and a large share of WAL), and slows the scheduler's own queries.",
    remediation:
      "Schedule a cleanup, e.g. a daily cron job: DELETE FROM cron.job_run_details WHERE end_time < now() - interval '7 days'. Keep only the retention you actually query.",
    docUrl: "https://github.com/citusdata/pg_cron#viewing-job-run-details",
    reviewed: R,
  },
  bloat_estimate_suspect: {
    id: "bloat_estimate_suspect",
    plane: "Storage",
    howToVerify:
      "Run pgstattuple(<table>) (or pgstattuple_approx) for the exact live/dead/free bytes; compare against the pg_stats estimate to see which is right.",
    whyItMatters:
      "This table's on-disk footprint per live row is far larger than its column widths explain, yet the pg_stats bloat estimator reports it as roughly un-bloated. The estimator is structurally unreliable here (wide TOAST, or dead space it cannot see), so its ~1.0x reading should not be trusted for a downsize/repack decision.",
    remediation:
      "Do not rely on the estimate for this table. ANALYZE, then measure exactly with pgstattuple; if it is dead space, VACUUM (or repack); if it is legitimately wide (large TOAST values), the footprint is real.",
    docUrl: "https://www.postgresql.org/docs/current/pgstattuple.html",
    reviewed: R,
  },
  pg_minor_behind: {
    id: "pg_minor_behind",
    plane: "Config",
    howToVerify:
      "After the platform applies the minor upgrade, server_version should match the latest minor for the major line; minor upgrades are backward-compatible (no dump/restore).",
    whyItMatters:
      "The server is behind the latest minor release for its major version. Postgres minor releases are cumulative security and data-loss bugfixes only - running an old minor means shipping known, already-fixed defects. This is the single cheapest currency win: a minor upgrade needs no application change.",
    remediation:
      "Apply the latest minor for your major line. On Supabase this is a platform upgrade (Infrastructure -> Upgrade); self-hosted, bump the server package and restart.",
    docUrl: "https://www.postgresql.org/support/versioning/",
    reviewed: R,
  },
  cron_job_overrun: {
    id: "cron_job_overrun",
    plane: "Query",
    howToVerify:
      "Compare each job's run duration (cron.job_run_details end-start) against its schedule cadence; a healthy job finishes well inside its interval. Reduce the work or widen the schedule until max duration < interval.",
    whyItMatters:
      "A scheduled job whose runtime meets or exceeds its own cadence overlaps itself - a new run starts (or queues) before the last finished, so copies pile up, compete for the same rows, and can dominate DB time. This is invisible to the failure count (the runs succeed), so it hides behind a green 'no failed runs'.",
    remediation:
      "Make the job cheaper (incremental refresh, indexes, batching) or lengthen its schedule so a run comfortably finishes before the next fires. For a materialized-view refresh, consider REFRESH ... CONCURRENTLY and a longer interval.",
    docUrl: "https://github.com/citusdata/pg_cron",
    reviewed: R,
  },
  sequence_exhaustion: {
    id: "sequence_exhaustion",
    plane: "Storage",
    howToVerify:
      "Compare pg_sequences.last_value against max_value; after migrating the column to bigint the sequence's max_value jumps to ~9.2e18 and pct_used falls to ~0.",
    whyItMatters:
      "An int4/serial sequence caps at 2,147,483,647. When it runs out, every INSERT that needs a new id fails with 'nextval: reached maximum value' - a hard outage on a growing table, not a slowdown. High-insert workloads (bulk imports, append-heavy logs) burn through int4 space fastest.",
    remediation:
      "Migrate the owning column (and the sequence) from int4 to bigint before it fills: ALTER the column to bigint, which widens the sequence's ceiling. Plan it as a maintenance change - rewriting a large table's PK type is not instant.",
    docUrl: "https://www.postgresql.org/docs/current/datatype-numeric.html",
    reviewed: R,
  },
  statements_evicted: {
    id: "statements_evicted",
    plane: "Query",
    howToVerify:
      "pg_stat_statements_info.dealloc should stop rising after raising pg_stat_statements.max; a stable dealloc means the table now holds the working set.",
    whyItMatters:
      "pg_stat_statements hit its entry cap and is evicting statements (dealloc > 0). The top-N query list and the outlier/latency signals - and the stats-window confidence gating built on them - are then a lossy sample: a heavy query can be evicted between scrapes and never appear. Raising the cap restores a complete picture.",
    remediation:
      "Raise pg_stat_statements.max (default 5000) if query-level accuracy matters; it costs a little shared memory. On Supabase this is a platform GUC - request the change if needed.",
    docUrl: "https://www.postgresql.org/docs/current/pgstatstatements.html",
    reviewed: R,
  },
  archiver_failing: {
    id: "archiver_failing",
    plane: "Backups",
    howToVerify:
      "pg_stat_archiver.last_failed_time should stop advancing past last_archived_time; check the failing command in the Postgres logs and confirm archived_count resumes rising.",
    whyItMatters:
      "WAL archiving is failing right now (the most recent archive attempt errored). Continuous archiving is the mechanism PITR and WAL-based backups rely on - while it is stuck, pg_wal also cannot recycle failed segments, so the data volume grows until either archiving recovers or the disk fills.",
    remediation:
      "Inspect the archive_command failure in the Postgres logs (permissions, destination full/unreachable). On Supabase this is platform-managed - open a support ticket if it does not self-recover; on self-hosted, fix the archive destination.",
    docUrl: "https://www.postgresql.org/docs/current/continuous-archiving.html",
    reviewed: R,
  },
  wal_slot_growing: {
    id: "wal_slot_growing",
    plane: "Storage",
    howToVerify:
      "After the write burst settles, the slot's retained WAL (pg_replication_slots restart_lsn lag) should plateau or fall; if it keeps climbing the consumer is not keeping up.",
    whyItMatters:
      "An active replication slot whose retained WAL keeps rising means its consumer is falling behind. Retained WAL lives on the data volume and cannot be recycled until the slot advances, so unbounded growth fills the disk - the failure mode the point-in-time 1 GiB threshold misses while retention is still under a gig.",
    remediation:
      "Check the consumer's health (Realtime / logical-replication subscriber). If it never catches up, scale or fix the consumer; if the slot is abandoned, drop it. Retained WAL is only reclaimed once the slot advances or is dropped.",
    docUrl: "https://www.postgresql.org/docs/current/view-pg-replication-slots.html",
    reviewed: R,
  },
  disk_expanded: {
    id: "disk_expanded",
    plane: "Storage",
    howToVerify:
      "Confirm the new provisioned size in the dashboard (Database -> Disk); the used-% drop is the expansion, not a data loss.",
    whyItMatters:
      "The volume was expanded during the window, so the used-% series straddles a step-change and cannot be trended for fill risk across it - and provisioned disk is billed per GB. After any cleanup/repack lands, right-size back down (a project upgrade to ~1.2x the database size) so you are not paying for idle headroom.",
    remediation:
      "No immediate action - this notes the expansion so the used-% drop is not misread. Once storage work settles, right-size the volume to ~1.2x database size via a project upgrade.",
    docUrl: "https://supabase.com/docs/guides/platform/database-size",
    reviewed: R,
  },
  stale_table_stats: {
    id: "stale_table_stats",
    plane: "Vacuum",
    howToVerify:
      "After ANALYZE, pg_stat_user_tables.n_live_tup for the affected tables should reflect the real row count (no longer 0), and per-table counter-based signals become trustworthy.",
    whyItMatters:
      "A table reporting 0 live rows while holding real data means its pg_stat counters were reset (or never populated) - the planner and every counter-derived signal (unused index, dead tuples, cache hit) are working off blank statistics, so their verdicts cannot be trusted until stats are rebuilt.",
    remediation:
      "Run ANALYZE (or VACUUM ANALYZE) on the affected tables so per-table counters and planner estimates are repopulated; the counters were reset recently.",
    sql: "VACUUM (ANALYZE) <schema>.<table>;",
    docUrl: "https://www.postgresql.org/docs/current/monitoring-stats.html",
    reviewed: R,
  },
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
  query_temp_spill: {
    id: "query_temp_spill",
    plane: "Query",
    sql: "-- find where it spills (sort/hash), then raise work_mem for that path:\nEXPLAIN (ANALYZE, BUFFERS) <the query>;\n-- session/role scoped, so it doesn't inflate every backend's memory:\nSET work_mem = '64MB';  -- or: ALTER ROLE <role> SET work_mem = '64MB';",
    howToVerify:
      "EXPLAIN (ANALYZE, BUFFERS) the query - the 'Sort Method'/'Batches' should show it fitting in memory (no 'external merge' / Disk) after the change; temp_blks_written for its queryid stops growing.",
    whyItMatters:
      "A sort or hash that exceeds work_mem spills to temp files on disk - far slower than memory and burning IOPS on every run. Repeatedly-called spilling queries are a common hidden latency + IOPS drain that the total-time ranking alone doesn't explain.",
    remediation:
      "Raise work_mem for that query's path (per session/role, not globally - work_mem is per-operation per-connection so a global bump multiplies fast), or cut the working set the sort/hash touches (add an index so it sorts fewer rows, reduce the result set, or restructure the join). Start around 32-64MB and confirm the spill clears.",
    docUrl: "https://supabase.com/docs/guides/database/query-optimization",
    reviewed: R,
  },
  toast_cache_cold: {
    id: "toast_cache_cold",
    plane: "Storage",
    sql: "-- see the de-toast reads (avoid SELECT * on the big column):\nSELECT relname, toast_blks_read, toast_blks_hit\nFROM pg_statio_user_tables WHERE relname = '<table>';\n-- if it's a vector column with no ANN index, add HNSW so search hits the index:\nCREATE INDEX ON <schema>.<table> USING hnsw (<vector_col> vector_cosine_ops);",
    howToVerify:
      "Re-check pg_statio_user_tables for the table: toast_blks_hit / (toast_blks_hit + toast_blks_read) should climb once the out-of-line column is no longer read from disk on every scan.",
    whyItMatters:
      "When a large out-of-line (TOAST) column can't fit in cache, every query that reads it re-fetches it from disk - so latency and IOPS are dominated by de-toasting, not by the row count. This is the common IO-saturation trap for large JSON/blob and high-dimension vector columns, and the global cache-hit ratio hides it (the main heap stays hot while the TOAST relation thrashes).",
    remediation:
      "Stop reading the big column on hot paths (select only the columns you need, not SELECT *). If it's a vector, add an ANN index (HNSW) so search hits the index instead of exact-scanning the heap, or switch to halfvec to halve its size. For large blobs/JSON, consider storing them outside Postgres (object storage) and keeping only a reference in the row.",
    docUrl: "https://www.postgresql.org/docs/current/storage-toast.html",
    reviewed: R,
  },
  query_high_variance: {
    id: "query_high_variance",
    plane: "Query",
    howToVerify:
      "Track the query's stddev_exec_time vs mean_exec_time in pg_stat_statements over time, or EXPLAIN it under load - the spread should narrow once the cause (plan flip, lock wait, cold cache) is addressed.",
    whyItMatters:
      "A high spread between a query's slowest and average run means its p99 is much worse than the mean suggests - users hit the slow tail. Common causes are plan instability (parameter-sensitive plans), lock/contention waits, or a working set that only sometimes fits in cache.",
    remediation:
      "Look for the tail cause: a parameter-sensitive plan (consider a covering index so the fast plan is always chosen), lock contention (check blocking + idle-in-transaction), or cache misses (the query may be reading cold pages). Stabilising the plan usually collapses the variance.",
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
      "Route app traffic through the connection pooler (Supavisor). For serverless/edge use transaction mode (port 6543) with a small per-client pool (e.g. connection_limit=1-3 per function instance); reserve direct/session connections (5432) for migrations and long transactions. If the load is legitimate and already pooled, max_connections is bound to your compute tier - review the instance size (a larger tier raises both max_connections and the RAM those backends need) rather than only bumping the setting.",
    docUrl: "https://supabase.com/docs/guides/database/connecting-to-postgres",
    changelogUrl:
      "https://supabase.com/changelog/32755-supabase-connection-pooler-deprecating-session-mode-on-port-6543-on-february-28",
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
  storage_concentration: {
    id: "storage_concentration",
    plane: "Storage",
    howToVerify:
      "Confirm with pg_total_relation_size on the named table; the share of pg_database_size should match.",
    whyItMatters:
      "One or two tables usually account for most of the disk you pay for. Knowing which - and how much of it is indexes vs heap - is where capacity work (archival, partitioning, dropping indexes, reclaiming bloat) has the most leverage.",
    remediation:
      "Attribution, not a defect: this is where the disk goes. If it is growing, consider archiving cold rows, partitioning by time, dropping unused indexes on it, or reclaiming bloat (pg_repack) before sizing up.",
    docUrl: "https://supabase.com/docs/guides/platform/database-size",
    reviewed: R,
  },
  index_heavy_table: {
    id: "index_heavy_table",
    plane: "Storage",
    howToVerify:
      "Compare pg_indexes_size(relid) to pg_total_relation_size(relid) for the table; cross-check the unused-index list for candidates to drop.",
    whyItMatters:
      "When indexes rival or exceed the heap they can dominate disk and add write amplification on every insert/update. Some are load-bearing; unused or redundant ones are pure cost.",
    remediation:
      "Review this table's indexes against the unused-index list and query patterns; drop the ones no query uses (each is disk + write overhead), and de-duplicate overlapping ones.",
    docUrl: "https://supabase.com/docs/guides/database/query-optimization",
    reviewed: R,
  },
  multixact_wraparound: {
    id: "multixact_wraparound",
    plane: "Vacuum",
    sql: "-- find the oldest table by multixact age, then freeze it:\nSELECT relname, mxid_age(relminmxid) FROM pg_class WHERE relkind='r' ORDER BY mxid_age(relminmxid) DESC LIMIT 5;\nVACUUM (FREEZE, VERBOSE) <schema>.<table>;",
    howToVerify:
      "Check mxid_age(relminmxid) on the oldest table - it should fall well below the 2B ceiling after a freeze vacuum.",
    whyItMatters:
      "Multixact IDs have their OWN ~2B ceiling, separate from transaction IDs, consumed by heavy row-level locking (SELECT FOR SHARE/UPDATE, FK checks). At the limit Postgres halts writes exactly like xid wraparound - and a table can be healthy on xid age yet aging fast on mxid, so it is a distinct thing to watch.",
    remediation:
      "Freeze the oldest tables by mxid_age(relminmxid) with VACUUM (FREEZE). If mxid age climbs fast, reduce row-lock contention (long-held SELECT FOR UPDATE, unindexed FKs forcing wide locks) and tune autovacuum_multixact_freeze_max_age.",
    docUrl:
      "https://www.postgresql.org/docs/current/routine-vacuuming.html#VACUUM-FOR-MULTIXACT-WRAPAROUND",
    reviewed: R,
  },
  never_autovacuumed: {
    id: "never_autovacuumed",
    plane: "Vacuum",
    sql: "VACUUM (ANALYZE, VERBOSE) <schema>.<table>;",
    howToVerify:
      "After a manual VACUUM ANALYZE, confirm pg_stat_user_tables.last_vacuum / last_analyze are set and the planner has fresh row estimates.",
    whyItMatters:
      "A table autovacuum has never touched has never had its visibility map or statistics maintained: index-only scans cannot skip heap fetches, and the planner costs queries off stale/absent estimates - both silently slow. It usually means the table only ever grows (insert-only) so the dead-tuple trigger never fires, while analyze still matters.",
    remediation:
      "Run VACUUM (ANALYZE) once to seed the visibility map + stats. For insert-only tables, set autovacuum_vacuum_insert_scale_factor / _threshold so autovacuum maintains them going forward.",
    docUrl: "https://www.postgresql.org/docs/current/routine-vacuuming.html",
    reviewed: R,
  },
  fk_unindexed: {
    id: "fk_unindexed",
    plane: "Query",
    sql: "CREATE INDEX CONCURRENTLY ON <schema>.<child_table> (<fk_columns>);",
    howToVerify:
      "After indexing, a parent DELETE/UPDATE should use an index scan on the child (EXPLAIN ANALYZE) instead of a seq scan, and lock contention drops.",
    whyItMatters:
      "A foreign key with no index on its referencing columns forces a full sequential scan of the child table on every parent UPDATE/DELETE (to find referencing rows), and takes wider locks - so cascades are slow and contention spikes as the child grows. Postgres does NOT auto-create this index (unlike the one for a PRIMARY KEY).",
    remediation:
      "Add a btree index on the FK's referencing columns (leading columns matching the constraint) with CREATE INDEX CONCURRENTLY. This is the single most common missing-index class.",
    docUrl: "https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-FK",
    reviewed: R,
  },
  invalid_index: {
    id: "invalid_index",
    plane: "Query",
    sql: "-- rebuild it (drop the failed one, recreate concurrently):\nDROP INDEX CONCURRENTLY IF EXISTS <schema>.<index>;\nCREATE INDEX CONCURRENTLY ...;",
    howToVerify:
      "Confirm pg_index.indisvalid is true for the rebuilt index (\\d+ on the table, or query pg_index) - the planner will then use it.",
    whyItMatters:
      "An invalid or not-ready index is the debris of a CREATE INDEX CONCURRENTLY that failed midway. The planner ignores it, so it gives zero read benefit - yet it is still maintained on every write and occupies disk. It also blocks a clean re-create under the same name.",
    remediation:
      "Drop the invalid index (DROP INDEX CONCURRENTLY) and re-create it. Check why the concurrent build failed (a deadlock, a conflicting long transaction) before retrying.",
    docUrl:
      "https://www.postgresql.org/docs/current/sql-createindex.html#SQL-CREATEINDEX-CONCURRENTLY",
    reviewed: R,
  },
  visibility_map_low: {
    id: "visibility_map_low",
    plane: "Query",
    sql: "VACUUM (ANALYZE) <schema>.<table>;  -- refreshes the visibility map",
    howToVerify:
      "After VACUUM, check pg_class.relallvisible / relpages climbs, and EXPLAIN shows an Index Only Scan with few/zero Heap Fetches.",
    whyItMatters:
      "The visibility map marks pages where every tuple is visible to all transactions; index-only scans can only skip the heap fetch for those pages. A low all-visible fraction on a big table means index-only scans still hit the heap (slower reads) and signals vacuum is behind on that table. Vacuum maintains the map.",
    remediation:
      "Run VACUUM (ANALYZE) to refresh the visibility map, and tune autovacuum so it keeps up on high-churn tables (lower autovacuum_vacuum_scale_factor). Insert-only tables benefit from autovacuum_vacuum_insert_scale_factor.",
    docUrl: "https://www.postgresql.org/docs/current/indexes-index-only-scans.html",
    reviewed: R,
  },
  public_schema_create: {
    id: "public_schema_create",
    plane: "Config",
    sql: "REVOKE CREATE ON SCHEMA public FROM PUBLIC;",
    howToVerify:
      "Confirm the CREATE grant is gone: \\dn+ public (or check nspacl) should no longer list =UC for PUBLIC.",
    whyItMatters:
      "When the PUBLIC role can CREATE in schema public, any role that can connect can create objects (tables, functions) there - a privilege-escalation and supply-chain surface (a malicious function on the search_path can be invoked by a more-privileged role). Modern Postgres revokes this by default; a database that still grants it is usually older or migrated.",
    remediation:
      "REVOKE CREATE ON SCHEMA public FROM PUBLIC and grant it only to the specific roles that need it. Keep application objects in a dedicated schema owned by the app role.",
    docUrl: "https://www.postgresql.org/docs/current/ddl-schemas.html#DDL-SCHEMAS-PATTERNS",
    reviewed: R,
  },
  wal_heavy_statement: {
    id: "wal_heavy_statement",
    plane: "Query",
    howToVerify:
      "After batching / reducing the write, confirm the statement's share of pg_stat_statements.wal_bytes drops on the next window.",
    whyItMatters:
      "A single statement generating a large share of all WAL drives replication lag, backup/PITR size, and pg_wal growth on the data volume - a capacity and durability cost, not just a latency one. Full-page writes after a checkpoint and wide UPDATEs are common causes.",
    remediation:
      "Reduce write volume for the hot statement: batch or debounce high-frequency updates, avoid rewriting unchanged columns, and consider HOT-update-friendly fill factor. For bulk loads, group into fewer larger transactions.",
    docUrl: "https://www.postgresql.org/docs/current/wal-configuration.html",
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
  disk_oversized: {
    id: "disk_oversized",
    plane: "Storage",
    howToVerify:
      "Confirm the used fraction stays low across peak periods, then resize the volume down (or reclaim first with pg_repack / dropping unused indexes) and re-audit.",
    whyItMatters:
      "A volume provisioned far above its true footprint is paid-for headroom that is never used. Disk autoscaling is grow-only - it never shrinks back - so an over-provisioned volume keeps costing until an explicit resize. The true minimum footprint (used minus reclaimable) is the size to target.",
    remediation:
      "Reclaim first (pg_repack bloat, drop unused indexes), then resize the volume down to the true footprint plus a growth margin. Note providers cap disk modifications to ~4 per rolling 24h, and gp3 lets you buy IOPS/throughput independently of size.",
    docUrl: "https://supabase.com/docs/guides/platform/compute-and-disk",
    reviewed: R,
  },
  checksum_failure: {
    id: "checksum_failure",
    plane: "Storage",
    howToVerify:
      "After restoring the affected relation, confirm pg_stat_database.checksum_failures stops incrementing (it is cumulative since the last stats reset).",
    whyItMatters:
      "A non-zero page-checksum failure count is on-disk data corruption the checksum layer caught - a block whose contents no longer match its checksum. Left unaddressed it risks silent wrong-answer reads or a crash. This is the strongest integrity signal Postgres emits.",
    remediation:
      "Identify the affected relation, restore it from a known-good backup / PITR, and investigate the storage layer. Run amcheck (bt_index_check / verify_heapam) to scope the damage. Do not ignore even a single failure.",
    docUrl:
      "https://www.postgresql.org/docs/current/monitoring-stats.html#MONITORING-PG-STAT-DATABASE-VIEW",
    reviewed: R,
  },
  index_corruption: {
    id: "index_corruption",
    plane: "Storage",
    sql: "-- rebuild the corrupt index (online):\nREINDEX INDEX CONCURRENTLY <schema>.<index>;",
    howToVerify:
      "Re-run bt_index_check on the index after REINDEX - it should return without raising an error.",
    whyItMatters:
      "amcheck's bt_index_check found a B-tree index whose on-disk structure violates its invariants - queries using it can return wrong results or error. Structural index corruption usually points to a storage fault or a Postgres/OS bug and warrants investigating the heap too.",
    remediation:
      "REINDEX INDEX CONCURRENTLY the affected index to rebuild it from the heap. If verify_heapam also flags the table, restore from backup - a rebuild trusts a possibly-corrupt heap.",
    docUrl: "https://www.postgresql.org/docs/current/amcheck.html",
    reviewed: R,
  },
  heap_corruption: {
    id: "heap_corruption",
    plane: "Storage",
    howToVerify: "After restoring the relation, re-run verify_heapam - it should return zero rows.",
    whyItMatters:
      "amcheck's verify_heapam found structurally invalid or logically inconsistent heap pages - actual table-data corruption, not just an index. This risks silent wrong reads and cannot be fixed by a rebuild (a REINDEX would trust the corrupt heap).",
    remediation:
      "Restore the affected relation from a known-good backup / PITR and investigate the storage layer. Capture the verify_heapam output (block/offset) before restoring for root-cause.",
    docUrl: "https://www.postgresql.org/docs/current/amcheck.html",
    reviewed: R,
  },
  work_mem_blast: {
    id: "work_mem_blast",
    plane: "Config",
    sql: "-- lower the global default and raise per-session for heavy paths instead:\nALTER DATABASE postgres SET work_mem = '<smaller>';\n-- or per role/session: SET work_mem = '64MB';",
    howToVerify:
      "Recompute work_mem x max_connections x parallelism against RAM after lowering work_mem (or max_connections) - the worst case should sit well under available memory.",
    whyItMatters:
      "work_mem is per-operation per-connection, so a single complex query can use several multiples of it, and the whole server can multiply it by max_connections. When that worst case exceeds RAM the box is one busy moment away from OOM-killing backends. A high global work_mem trades a broad OOM risk for a narrow speedup.",
    remediation:
      "Keep the global work_mem modest and raise it per-session/role only for the specific heavy query paths that spill. Lowering max_connections (front with a pooler) also shrinks the worst case.",
    docUrl: "https://www.postgresql.org/docs/current/runtime-config-resource.html#GUC-WORK-MEM",
    reviewed: R,
  },
  maintenance_work_mem_low: {
    id: "maintenance_work_mem_low",
    plane: "Config",
    sql: "ALTER DATABASE postgres SET maintenance_work_mem = '256MB';",
    howToVerify:
      "After raising it, confirm autovacuum passes and CREATE INDEX complete faster (fewer index-build passes in the logs).",
    whyItMatters:
      "maintenance_work_mem bounds the memory autovacuum, VACUUM, and CREATE INDEX get. On a large instance a value left small relative to RAM forces multiple passes over dead tuples and slower index builds. (Supabase auto-scales this with the compute tier, so a small value on a small instance is correct - this only flags when it is lagging on a larger box.)",
    remediation:
      "Raise maintenance_work_mem (256MB-1GB is typical on larger instances) - it is only used by maintenance ops, not every backend, so it does not carry the work_mem blast risk. On Supabase it is tier-scaled; override it only if index builds / autovacuum are visibly slow.",
    docUrl:
      "https://www.postgresql.org/docs/current/runtime-config-resource.html#GUC-MAINTENANCE-WORK-MEM",
    reviewed: R,
  },
  checkpoint_completion_low: {
    id: "checkpoint_completion_low",
    plane: "Config",
    sql: "ALTER SYSTEM SET checkpoint_completion_target = 0.9;  -- then reload",
    howToVerify:
      "After the change, confirm checkpoint write I/O is smoother (pg_stat_bgwriter / checkpoint write time spread over the interval rather than spiking).",
    whyItMatters:
      "checkpoint_completion_target sets how much of the interval Postgres spreads checkpoint writes over. A low value bunches the flush into a short window, spiking disk I/O and latency. Modern Postgres defaults to 0.9 for this reason.",
    remediation:
      "Set checkpoint_completion_target to 0.9 so checkpoint writes are paced across the interval instead of flushed in a burst.",
    docUrl:
      "https://www.postgresql.org/docs/current/runtime-config-wal.html#GUC-CHECKPOINT-COMPLETION-TARGET",
    reviewed: R,
  },
  track_io_timing_off: {
    id: "track_io_timing_off",
    plane: "Config",
    sql: "ALTER SYSTEM SET track_io_timing = on;  -- then reload",
    howToVerify:
      "After enabling, confirm pg_stat_statements shows non-null blk_read_time/blk_write_time and EXPLAIN (ANALYZE, BUFFERS) reports I/O timings.",
    whyItMatters:
      "With track_io_timing off, Postgres cannot attribute time spent on disk I/O - pg_stat_statements I/O timings are null and EXPLAIN can't show read/write time. That blinds both this tool's I/O analysis and your own query tuning. The overhead is negligible on modern kernels.",
    remediation:
      "Enable track_io_timing so per-query and per-statement I/O time is captured. Overhead is measured in nanoseconds on clocksource=tsc hosts.",
    docUrl:
      "https://www.postgresql.org/docs/current/runtime-config-statistics.html#GUC-TRACK-IO-TIMING",
    reviewed: R,
  },
  lock_forensics: {
    id: "lock_forensics",
    plane: "Config",
    whyItMatters:
      "Lock incidents leave no forensic trail when log_lock_waits is off: a blocked ALTER that queues every reader for minutes produces zero log evidence, so the cascade is invisible after the fact. And without a session/role-scoped lock_timeout, a migration that cannot acquire its lock waits indefinitely, holding the queue open behind it - Postgres grants locks in queue order, so even non-conflicting readers pile up behind the waiting exclusive lock.",
    remediation:
      "Enable lock-wait logging: ALTER SYSTEM SET log_lock_waits = on (with deadlock_timeout at 1s, each wait past 1s logs one line - negligible except during the incidents you want recorded). For the guardrail, set lock_timeout on the MIGRATION SESSION OR ROLE only (e.g. ALTER ROLE migrator SET lock_timeout = '3s'), never on the whole cluster - a global lock_timeout cancels legitimate long waits. Pair it with a retry loop so a blocked ALTER fails fast instead of queueing readers.",
    sql: `-- enable lock-wait logging (superuser), then reload:\nALTER SYSTEM SET log_lock_waits = on;  -- SELECT pg_reload_conf();\n-- session-scoped migration guardrail (run INSIDE the migration, not globally):\nSET lock_timeout = '3s';`,
    howToVerify:
      "After enabling: SHOW log_lock_waits returns 'on'. After the next migration, confirm a blocked ALTER logs a 'still waiting for ...Lock' line and fails at the lock_timeout instead of stalling readers.",
    docUrl: "https://www.postgresql.org/docs/current/runtime-config-locks.html",
    reviewed: R,
  },
  contention_episode: {
    id: "contention_episode",
    plane: "Config",
    whyItMatters:
      "A synchronized burst of transaction rollbacks, active backends, and share-lock counts is the metrics-side signature of a mass-cancellation event: many sessions stall (active while waiting on a lock), then get killed by statement_timeout (each cancellation is a rollback). The event is minutes long; the 30-day resource panels average it into invisibility - this scan re-queries the same Prometheus at native resolution to surface it.",
    remediation:
      "Correlate the episode window with DDL and scheduled-job activity (cron.job_run_details start/end times bracket it). Enable log_lock_waits so the NEXT episode is attributable to a relation, and run migrations with a session-scoped lock_timeout + retry so a blocked ALTER cannot queue readers for minutes.",
    howToVerify:
      "Re-run the incident scan after the fix (--incident-scan-days): the window should contain no correlated bursts, and xact_rollback stays near its baseline.",
    docUrl: "https://www.postgresql.org/docs/current/monitoring-stats.html",
    reviewed: R,
  },
  live_lock_contention: {
    id: "live_lock_contention",
    plane: "Config",
    whyItMatters:
      "Multiple collection samples caught active backends waiting on a Lock - contention happening RIGHT NOW, during the audit. Unlike the retrospective log/metrics checks this is a live snapshot: it means sessions are blocked on a lock at collection time, so a blocking session is holding a lock others need.",
    remediation:
      "Identify the blocker with pg_blocking_pids() and its query; if it is a long transaction or an un-CONCURRENTLY DDL, end/reschedule it. This is point-in-time - for after-the-fact incidents use the lock_wave (logs) and contention_episode (metrics) findings.",
    sql: `-- who is blocking whom, right now:\nselect pid, wait_event_type, wait_event, state, pg_blocking_pids(pid) as blocked_by,\n       left(query, 80) as query\nfrom pg_stat_activity\nwhere wait_event_type = 'Lock';`,
    howToVerify:
      "Re-run collection: if the blocking transaction is gone, no Lock waits should appear across the samples.",
    docUrl: "https://www.postgresql.org/docs/current/monitoring-stats.html#WAIT-EVENT-LOCK-TABLE",
    reviewed: R,
  },
  mem_pressure_paging: {
    id: "mem_pressure_paging",
    plane: "Compute",
    howToVerify:
      "After sizing up, re-check the major-fault / swap-in rate (node_vmstat_pgmajfault, node_vmstat_pswpin) over a window - sustained paging should fall to ~0.",
    whyItMatters:
      "Sustained major page faults / swap-in mean the working set no longer fits in RAM, so the OS and Postgres keep reading pages back from disk. That is real query latency and disk I/O the instance cannot see as 'memory' - and a point-in-time MemAvailable reading can look perfectly healthy while it is happening (a swap-occupancy snapshot is NOT a reliable signal; the RATE over time is).",
    remediation:
      "Give the working set more RAM: bump the compute tier (the most direct fix on a small instance), or cut memory demand - lower work_mem / max_connections, shrink the hot set, add indexes so scans touch fewer pages. Occupancy alone is not the trigger; a sustained swap-IN or major-fault rate is.",
    docUrl: "https://supabase.com/docs/guides/platform/compute-and-disk",
    reviewed: R,
  },
  psi_saturation: {
    id: "psi_saturation",
    plane: "Compute",
    howToVerify:
      "After sizing up / reducing load, re-check the PSI stall % (node_pressure_{cpu,memory,io}_waiting_seconds_total rate) over a window - sustained stall should fall well below the threshold.",
    whyItMatters:
      "Pressure Stall Information is the fraction of time runnable tasks were stalled waiting for CPU, memory, or I/O. Unlike a utilization snapshot (idle% / MemAvailable can read healthy at the instant you look), sustained PSI is direct evidence that work is queueing behind a saturated resource - i.e. real, ongoing latency.",
    remediation:
      "Identify the stalled resource (CPU / memory / I/O) and relieve it: size up the compute tier, cut concurrency (max_connections / work_mem), or reduce I/O via indexing + cache hit. PSI names the bottleneck so you size the right axis instead of over-provisioning everything.",
    docUrl: "https://supabase.com/docs/guides/platform/compute-and-disk",
    reviewed: R,
  },
  oom_kill: {
    id: "oom_kill",
    plane: "Compute",
    howToVerify:
      "After adding RAM / cutting memory demand, confirm node_vmstat_oom_kill stops incrementing over a window (rate returns to 0).",
    whyItMatters:
      "The kernel OOM killer only fires when memory is genuinely exhausted - it terminates a process (often a Postgres backend) to survive. That is a far stronger signal than a high memory %: it means requests were killed, connections dropped, and possibly a crash-recovery cycle. Even a single event over the window is worth acting on.",
    remediation:
      "Give the instance more memory headroom: bump the compute tier, and/or cut demand - lower work_mem and max_connections, shrink the hot working set, add indexes so scans touch fewer pages. Recurrent OOM kills almost always mean the tier is undersized for the workload.",
    docUrl: "https://supabase.com/docs/guides/platform/compute-and-disk",
    reviewed: R,
  },
  ebs_balance_low: {
    id: "ebs_balance_low",
    plane: "Storage",
    howToVerify:
      "After provisioning steady IOPS/throughput (or reducing burst demand), confirm the EBS balance % (aws_ec2_ebsiobalance_percent_minimum / aws_ec2_ebsbyte_balance_percent_minimum) climbs back toward 100 and stops depleting.",
    whyItMatters:
      "AWS gp2/gp3 volumes serve burst I/O from a credit balance. When the balance depletes, throughput and IOPS are throttled HARD to the baseline - a sudden latency cliff that in-guest disk metrics cannot explain (the disk isn't full or busy by its own numbers; the cloud is throttling it). A depleting balance is an early warning before the cliff hits.",
    remediation:
      "Provision baseline IOPS/throughput to cover sustained demand (gp3 lets you buy IOPS/throughput independently of size), or reduce burst I/O via indexing, cache hit, and batching. Sizing to the sustained rate stops the credit balance from draining.",
    docUrl: "https://supabase.com/docs/guides/platform/compute-and-disk",
    reviewed: R,
  },
  cpu_saturated: {
    id: "cpu_saturated",
    plane: "Compute",
    howToVerify:
      "Re-check the CPU-utilization trend after sizing up / shedding load - the sustained-high fraction should drop well below threshold.",
    whyItMatters:
      "Sustained high CPU (not a brief spike) means queries are queueing for cores - latency rises and throughput plateaus. A point-in-time reading can miss it; the fraction of the window spent hot is the real signal.",
    remediation:
      "Size up the compute tier, or cut CPU demand: fix the heaviest pg_stat_statements queries (missing indexes, seq scans), reduce connection churn, and offload read traffic. Compute Nano..2XL can burst; Large+ is predictable (no burst) - a sustained-hot small tier is running on burst credits.",
    docUrl: "https://supabase.com/docs/guides/platform/compute-and-disk",
    reviewed: R,
  },
  cpu_oversized: {
    id: "cpu_oversized",
    plane: "Compute",
    howToVerify:
      "Confirm the CPU trend stays low across peak periods (not just quiet hours) over a couple of weeks before downsizing, then re-audit after the change.",
    whyItMatters:
      "A tier whose CPU sits near-idle for weeks is paying for headroom it never uses. Right-sizing down cuts cost with no performance loss - the counterpart to catching saturation.",
    remediation:
      "Consider a smaller compute tier. Verify memory and I/O also have headroom first (downsizing compute usually cuts RAM too), and keep enough margin for known traffic peaks / batch jobs.",
    docUrl: "https://supabase.com/docs/guides/platform/compute-and-disk",
    reviewed: R,
  },
  mem_saturated: {
    id: "mem_saturated",
    plane: "Compute",
    howToVerify:
      "After sizing up / cutting memory demand, confirm the memory-used% trend spends far less of the window near the ceiling (and paging - major faults / swap-in - stays low).",
    whyItMatters:
      "Memory sustained near the ceiling leaves no room for the page cache and pushes the working set toward swap - each spill becomes disk I/O and latency. Sustained high memory% is the leading indicator before the paging/OOM signals fire.",
    remediation:
      "Size up the tier, or cut demand: lower work_mem and max_connections, shrink the hot working set, add indexes so scans touch fewer pages. Pair with the paging (mem_pressure_paging) and OOM (oom_kill) signals to confirm it's real pressure, not healthy cache use.",
    docUrl: "https://supabase.com/docs/guides/platform/compute-and-disk",
    reviewed: R,
  },
  disk_fill_projection: {
    id: "disk_fill_projection",
    plane: "Storage",
    howToVerify:
      "Re-run after freeing space / growing the disk - the disk-used% slope should flatten and the projected days-to-full should recede.",
    whyItMatters:
      "A disk that hits 100% takes the database read-only (or down). Projecting the current growth slope to full gives lead time to act before the cliff, instead of finding out at the wall. The projection is only made within the span the data supports - a short history won't claim a far-future date.",
    remediation:
      "Grow the disk ahead of the projected date (Supabase disk auto-scales, but with a cooldown - don't rely on it under fast growth), and attack the growth source: prune/rotate large tables, drop dead bloat (VACUUM FULL / pg_repack in a window), archive cold data, and check for runaway WAL or unvacuumed dead tuples.",
    docUrl: "https://supabase.com/docs/guides/platform/compute-and-disk",
    reviewed: R,
  },
  checkpoint_pressure: {
    id: "checkpoint_pressure",
    plane: "Compute",
    howToVerify:
      "After raising max_wal_size, re-check the requested-vs-timed checkpoint mix over a window - requested checkpoints should fall back to a small share (most checkpoints timed).",
    whyItMatters:
      "A 'requested' checkpoint is forced because WAL filled before checkpoint_timeout. A high requested share means the DB is checkpointing under write pressure - each checkpoint is a burst of full-page writes and fsync, adding I/O and latency. Timed checkpoints (the interval) are the healthy case.",
    remediation:
      "Raise max_wal_size so WAL can absorb writes between timed checkpoints (fewer forced checkpoints, smoother I/O). Confirm checkpoint_timeout and checkpoint_completion_target are sane. On a write-heavy workload this is one of the highest-leverage knobs.",
    docUrl: "https://supabase.com/docs/guides/database/postgres/configuration",
    reviewed: R,
  },
  wal_archival_backlog: {
    id: "wal_archival_backlog",
    plane: "Storage",
    howToVerify:
      "Confirm the pending-WAL-archival count returns to ~0 and stays there after the archiver / storage issue is resolved.",
    whyItMatters:
      "WAL files pending archival pile up when the archiver can't keep pace or the archive destination is unhealthy. Backlog means point-in-time recovery falls behind (you can't restore to recent moments) and WAL accumulates on the data disk - a stealth contributor to disk fill.",
    remediation:
      "Check the archive command / destination health and network throughput; ensure the disk has headroom for the backlog. If it's a sustained rate problem, the write volume may be outrunning archival - raise instance/IO capacity or reduce WAL churn (fewer forced checkpoints, less bloat/churn).",
    docUrl: "https://supabase.com/docs/guides/platform/backups",
    reviewed: R,
  },
  connections_ceiling: {
    id: "connections_ceiling",
    plane: "Compute",
    howToVerify:
      "After routing through the pooler / raising the limit, confirm peak backends sit comfortably below max_connections across peak periods.",
    whyItMatters:
      "Peak connections approaching max_connections risks 'too many clients' errors that hard-fail new work, and each backend costs memory (work_mem x concurrency). Sustained near the ceiling means the app is one traffic spike from refusal.",
    remediation:
      "Route clients through the pooler (Supavisor / PgBouncer) in transaction mode so many clients share few backends, cap application pool sizes, and only then consider raising max_connections (it trades RAM for headroom). On Supabase max_connections tracks the compute tier, so if pooled demand is genuinely high the durable fix is sizing up the instance (more connections AND more RAM), not just the setting. Long-lived idle connections are the usual culprit.",
    docUrl: "https://supabase.com/docs/guides/database/connecting-to-postgres",
    changelogUrl:
      "https://supabase.com/changelog/32755-supabase-connection-pooler-deprecating-session-mode-on-port-6543-on-february-28",
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
  idle_in_txn_open: {
    id: "idle_in_txn_open",
    plane: "Connections",
    sql: "-- find the culprit, then close/cancel it if safe:\nSELECT pid, usename, state, now()-state_change AS idle_for, query\nFROM pg_stat_activity\nWHERE state = 'idle in transaction'\nORDER BY state_change;\n-- SELECT pg_terminate_backend(<pid>);",
    howToVerify:
      "Re-check pg_stat_activity - no backend should sit in 'idle in transaction' for more than a few seconds under normal operation.",
    whyItMatters:
      "A backend that has BEGUN a transaction and gone idle holds its locks and pins the xmin horizon for the WHOLE database - autovacuum can't reclaim dead tuples newer than that snapshot, so bloat and wraparound risk climb until the transaction ends. It's a common ORM/pool bug (a connection checked out mid-transaction and never committed).",
    remediation:
      "Find and fix the client holding the transaction open (missing commit/rollback in app or pool code). As a guardrail set idle_in_transaction_session_timeout so Postgres auto-aborts abandoned transactions.",
    docUrl: "https://www.postgresql.org/docs/current/runtime-config-client.html",
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

  // --- Security config (Management API: auth / network / SSL) ---
  network_restrictions_open: {
    id: "network_restrictions_open",
    plane: "Config",
    howToVerify:
      "Re-check Settings > Database > Network Restrictions (or GET /network-restrictions) - dbAllowedCidrs should list only your egress ranges, not 0.0.0.0/0.",
    whyItMatters:
      "With no CIDR allowlist the Postgres port is reachable from any IP on the internet, so the database's exposure rests entirely on credentials + RLS. Restricting to known egress ranges removes the whole class of drive-by connection + brute-force attempts.",
    remediation:
      "Add your application/egress CIDR ranges under Settings > Database > Network Restrictions so only they can reach Postgres. Keep it tight - avoid 0.0.0.0/0.",
    docUrl: "https://supabase.com/docs/guides/platform/network-restrictions",
    changelogUrl:
      "https://supabase.com/changelog/20522-supavisor-starts-enforcing-network-restrictions",
    reviewed: R,
  },
  hba_weak_auth: {
    id: "hba_weak_auth",
    plane: "Config",
    howToVerify:
      "Inspect pg_hba_file_rules for trust/password/ident auth on a non-loopback address; those rows should not exist for a public database. Confirm the offending rule against the intended access model.",
    whyItMatters:
      "A trust rule accepts connections with NO password; password/ident are weak or spoofable. From a non-loopback source that means anyone reaching the port can connect (or downgrade) - a direct authentication bypass, independent of RLS. (This is NOT the TLS posture: Supabase terminates SSL at the proxy, so a plain scram-sha-256 host rule is normal and not flagged.)",
    remediation:
      "Remove or tighten the rule so non-loopback connections require scram-sha-256 (or cert). Loopback trust (127.0.0.1 / ::1) is normal; a non-loopback trust/password/ident rule almost always indicates a misconfiguration.",
    docUrl: "https://www.postgresql.org/docs/current/auth-pg-hba-conf.html",
    reviewed: R,
  },
  pitr_absent: {
    id: "pitr_absent",
    plane: "Backups",
    howToVerify:
      "Check the PITR add-on in the Dashboard (Database > Backups > Point in Time), or confirm archive_mode + a recent pg_stat_archiver.last_archived_time on an active project.",
    whyItMatters:
      "Without continuous WAL archiving, recovery is limited to the daily physical/logical backup - you could lose up to a day of writes. PITR archives WAL every ~2 minutes, cutting the worst-case data loss to minutes. NOTE: archive_mode is inferred from SQL and isn't a guaranteed 1:1 with the PITR add-on; on an idle project WAL backups are skipped even with PITR on, so verify before acting.",
    remediation:
      "If minute-level recovery matters, enable the PITR add-on (Pro+ plan, requires at least a Small compute add-on). For non-production projects daily backups are usually sufficient.",
    docUrl: "https://supabase.com/docs/guides/platform/backups",
    reviewed: R,
  },
  ssl_not_enforced: {
    id: "ssl_not_enforced",
    plane: "Config",
    howToVerify:
      "Re-check GET /ssl-enforcement - currentConfig.database should be true; a psql connect with sslmode=disable should then be refused.",
    whyItMatters:
      "Without SSL enforcement the server still accepts unencrypted connections, so a misconfigured client can send credentials and data in plaintext - interceptable on the network path. Enforcing TLS closes that downgrade.",
    remediation:
      "Enable SSL enforcement (Settings > Database > SSL Configuration, or PUT /ssl-enforcement {database:true}) so unencrypted connections are refused. Confirm clients use sslmode=require first.",
    docUrl: "https://supabase.com/docs/guides/platform/ssl-enforcement",
    reviewed: R,
  },
  auth_email_autoconfirm: {
    id: "auth_email_autoconfirm",
    plane: "Auth",
    howToVerify:
      "Re-check GET /config/auth - mailer_autoconfirm should be false; a new signup should require clicking the confirmation link before the session is issued.",
    whyItMatters:
      "With email auto-confirm on, GoTrue issues a session without verifying the address, so anyone can sign up under an address they don't control - an account-farming and phishing-pretext surface, and it lets bogus emails accumulate.",
    remediation:
      "Turn OFF 'Confirm email' auto-confirm (Authentication > Providers > Email) unless you intentionally verify ownership another way, so new signups must confirm their address.",
    docUrl: "https://supabase.com/docs/guides/auth/auth-email",
    reviewed: R,
  },
  auth_mfa_disabled: {
    id: "auth_mfa_disabled",
    plane: "Auth",
    howToVerify:
      "Re-check GET /config/auth - at least one mfa_*_verify_enabled should be true, and users can then enrol a second factor.",
    whyItMatters:
      "With no MFA factor enabled project-wide, users cannot add a second factor, so any credential leak is a full account takeover. Enabling TOTP (a project setting, then opt-in per user) adds the standard phishing-resistant second step.",
    remediation:
      "Enable at least one MFA factor (Authentication > Multi-Factor - TOTP is the low-friction default) so users can enrol a second factor.",
    docUrl: "https://supabase.com/docs/guides/auth/auth-mfa",
    reviewed: R,
  },
  auth_weak_password_policy: {
    id: "auth_weak_password_policy",
    plane: "Auth",
    howToVerify:
      "Re-check GET /config/auth - password_min_length should be >= 8 and password_hibp_enabled true; a weak/known-breached password should be rejected at signup.",
    whyItMatters:
      "A short minimum length and no breached-password check let users pick guessable or already-leaked passwords, which is the entry point for credential-stuffing takeovers. Raising the floor + enabling HIBP blocks the weakest credentials up front.",
    remediation:
      "Set password min length to >= 8 (ideally with required character classes) and enable leaked-password protection (HIBP) under Authentication > Providers > Email.",
    docUrl: "https://supabase.com/docs/guides/auth/password-security",
    reviewed: R,
  },
  auth_anonymous_users: {
    id: "auth_anonymous_users",
    plane: "Auth",
    howToVerify:
      "Re-check GET /config/auth - external_anonymous_users_enabled reflects the setting; confirm RLS on user-facing tables distinguishes anon from authenticated.",
    whyItMatters:
      "Anonymous sign-ins are a legitimate feature but let anyone mint a real user row without any identity, so unbounded they enable row-spam and abuse. It only matters that RLS + rate limits are written with that in mind - flagged as awareness, not a defect.",
    remediation:
      "Anonymous sign-ins are enabled. Confirm RLS policies and rate limits account for un-verified anon users, and disable it if the app doesn't use anonymous auth.",
    docUrl: "https://supabase.com/docs/guides/auth/auth-anonymous",
    reviewed: R,
  },
  auth_long_jwt: {
    id: "auth_long_jwt",
    plane: "Auth",
    howToVerify:
      "Re-check GET /config/auth - jwt_exp should be <= 3600 (1h); a leaked access token then stops working within that window.",
    whyItMatters:
      "The access token can't be revoked before it expires, so a long jwt_exp widens the window a stolen token stays valid. The default 3600s (1h) balances that against refresh churn; much larger values extend the blast radius of a leak.",
    remediation:
      "Lower the access-token expiry (jwt_exp) toward the 3600s (1h) default unless a longer session is a deliberate tradeoff; refresh tokens keep sessions alive without a long-lived access token.",
    docUrl: "https://supabase.com/docs/guides/auth/sessions",
    reviewed: R,
  },

  // --- Extensions (SQL-derived; both PAT read-only + superuser tiers) ---
  pgvector_unindexed: {
    id: "pgvector_unindexed",
    plane: "Query",
    sql: "-- HNSW (fast, higher build cost) - tune m / ef_construction to recall:\nCREATE INDEX ON <schema>.<table> USING hnsw (<column> vector_cosine_ops);\n-- or IVFFlat (cheaper build; set lists ~ rows/1000):\n-- CREATE INDEX ON <schema>.<table> USING ivfflat (<column> vector_l2_ops) WITH (lists = 100);",
    howToVerify:
      "EXPLAIN a distance-ordered query (ORDER BY <col> <-> $1 LIMIT k) - it should use the ivfflat/hnsw index, not a full scan. Match the opclass (cosine/l2/ip) to your query operator.",
    whyItMatters:
      "A vector column queried by distance without an ANN index does an exact scan of every row per query, so similarity-search latency scales with table size and burns CPU - the classic pgvector slow path. It is worse when the vector is wide (>~500 dims): the vector type defaults to EXTENDED storage, so those values are TOASTed, and each exact scan de-toasts them from disk - and TOAST also defeats parallel seq scans. An HNSW index turns search into an index lookup (vectors live in the index, largely sidestepping de-toast).",
    remediation:
      "Add an ANN index - HNSW (opclass matching your operator: vector_cosine_ops / vector_l2_ops / vector_ip_ops); search then hits the index instead of exact-scanning + de-toasting the heap. For wide vectors also consider halfvec (float16, halves storage + index size at ~equal recall) or, if dimensions are small enough to fit inline, ALTER COLUMN ... SET STORAGE PLAIN (needs a table rewrite) so exact scans stay in-heap and can go parallel.",
    docUrl: "https://supabase.com/docs/guides/ai/vector-indexes",
    reviewed: R,
  },
  extensions_outdated: {
    id: "extensions_outdated",
    plane: "Config",
    sql: "ALTER EXTENSION <extension> UPDATE;",
    howToVerify:
      "Re-check extversion in pg_extension against pg_available_extensions.default_version - they should match after the update.",
    whyItMatters:
      "An installed extension behind the platform's available version misses bug/perf/security fixes shipped upstream. Updating is a cheap ALTER EXTENSION vs carrying known issues.",
    remediation:
      "Update lagging extensions to the platform's available version (ALTER EXTENSION <name> UPDATE), or via the Database > Extensions page.",
    docUrl: "https://supabase.com/docs/guides/database/extensions",
    reviewed: R,
  },
  cron_job_failing: {
    id: "cron_job_failing",
    plane: "Config",
    sql: "-- inspect the failures (message column carries the error):\nSELECT j.jobname, r.status, r.return_message, r.start_time\nFROM cron.job_run_details r JOIN cron.job j ON j.jobid = r.jobid\nWHERE r.status = 'failed' AND r.start_time > now() - interval '7 days'\nORDER BY r.start_time DESC;",
    howToVerify:
      "After fixing, cron.job_run_details shows status='succeeded' for the job's subsequent runs and no new failed rows.",
    whyItMatters:
      "A scheduled job that fails is a silent automation outage - the ETL/refresh/cleanup it does just stops, and nothing surfaces it until data is stale or something downstream breaks. This is read straight from the run log, so it's a confirmed failure, not a nudge.",
    remediation:
      "Read the failing job's return_message in cron.job_run_details, fix the underlying command (permissions, missing object, timeout), and re-run it. If the job is obsolete, unschedule it with cron.unschedule().",
    docUrl: "https://supabase.com/docs/guides/database/extensions/pg_cron",
    changelogUrl:
      "https://supabase.com/changelog/19298-directly-updating-rows-in-the-cron-job-table-is-no-longer-allowed",
    reviewed: R,
  },
  pg_cron_review: {
    id: "pg_cron_review",
    plane: "Config",
    howToVerify:
      "Query cron.job_run_details for recent status='failed' rows or runs whose duration approaches the schedule interval; a healthy job shows status='succeeded' and finishes well inside its window.",
    whyItMatters:
      "Scheduled jobs fail or overrun silently - a failing nightly job or one that runs longer than its interval (piling up overlapping runs) is invisible until data is stale or the DB is under load. sbperf can't read run history over the read-only endpoint, so this is a prompt to check it.",
    remediation:
      "Review cron.job_run_details for failed or overrunning jobs (SELECT jobid, status, start_time, end_time FROM cron.job_run_details ORDER BY start_time DESC).",
    docUrl: "https://supabase.com/docs/guides/database/extensions/pg_cron",
    changelogUrl:
      "https://supabase.com/changelog/19298-directly-updating-rows-in-the-cron-job-table-is-no-longer-allowed",
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
  changelogUrl?: string;
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
    changelogUrl: h.changelogUrl,
  };
}
