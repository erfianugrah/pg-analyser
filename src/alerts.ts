import { HEURISTICS, type Plane, THRESHOLDS } from "./heuristics.ts";
import { buildPanels } from "./prometheus.ts";

/**
 * Prometheus alerting rules generated from the SAME threshold catalogue that
 * ranks findings (heuristics.ts THRESHOLDS + HEURISTICS), so a rule and a
 * report card can never disagree about what "too high" means.
 *
 * The inclusion predicate is deliberately narrow. A finding earns a rule only
 * when BOTH hold:
 *   1. its signal is already a `buildPanels()` trend panel - i.e. a PromQL
 *      expression over metric families the scrape actually serves, proven by
 *      the panel path rather than remembered; and
 *   2. its threshold survives translation to a PromQL range window unchanged.
 * Everything else is listed in EXCLUSIONS / PLANE_EXCLUSIONS with the failing
 * clause named. A pack that alerts on what Prometheus cannot see is worse than
 * no pack, so the exclusion list is a deliverable, not an apology.
 */

/**
 * How a threshold becomes an expression. Every variant references a panel by
 * TITLE - the query text comes from buildPanels(), never from a literal here.
 *
 * - `threshold`: the panel value now, held for `hold` (point-in-time gauges).
 * - `mean`: the panel's mean over the window - mirrors findings.ts avgTrend().
 * - `sustained`: the FRACTION of window samples past the threshold - mirrors
 *   trendstats.ts sustainedFrac(), which counts points, not consecutive time,
 *   so `for:` is the wrong operator for these.
 * - `ratio`: num / (sum of den) - the checkpoint requested-share shape.
 */
export type AlertExpr =
  | { kind: "threshold"; panel: string; op: ">=" | "<="; value: number }
  | { kind: "mean"; panel: string; op: ">=" | ">"; value: number }
  | { kind: "sustained"; panel: string; value: number; frac: number }
  | { kind: "ratio"; num: string; den: string[]; op: ">="; value: number };

export interface AlertSpec {
  /** PascalCase Prometheus alert name. */
  name: string;
  /** Key into HEURISTICS - carries the annotations. */
  heuristicId: string;
  /** Mirrors the severity findings.ts assigns on this branch. */
  severity: "high" | "med";
  expr: AlertExpr;
  /** The catalogue constant(s) behind the number, quoted in the annotation. */
  threshold: string;
  /** One line, present tense, what is true when this fires. */
  summary: string;
  /**
   * Set when the rule needs a metric family the Supabase metrics endpoint does
   * NOT serve, naming the extra scrape source that provides it. Such rules are
   * emitted in a separate `-optional` group so an operator who does not run
   * that source drops one group instead of hunting rules - and so a silent
   * never-firing rule is never mistaken for coverage. Mirrors the report's
   * treatment of the optional PSI / EBS panels (docs/grafana-prometheus.md,
   * "What is and isn't present").
   */
  requires?: string;
}

/**
 * Defaults. THRESHOLDS values are catalogue constants; these three are CHOSEN
 * starting values with no catalogue equivalent - findings.ts evaluates over the
 * report's trend window (--trend-days, default 30), which is far too long for
 * an alert. Tune them per deployment; they are options, not constants.
 */
export const ALERT_WINDOW = "1h";
export const ALERT_RESOLUTION = "5m";
export const ALERT_HOLD = "10m";

export interface AlertOptions {
  /** Project-label selector, same idiom as buildPanels(). "" = unscoped. */
  refMatcher?: string;
  /** Range/subquery window for mean + sustained rules. */
  window?: string;
  /** Subquery step for sustained rules. */
  resolution?: string;
  /** `for:` on point-in-time threshold rules. */
  hold?: string;
}

export const ALERT_SPECS: AlertSpec[] = [
  {
    name: "SupabaseCpuSaturated",
    heuristicId: "cpu_saturated",
    severity: "high",
    expr: {
      kind: "sustained",
      panel: "CPU utilization (%)",
      value: THRESHOLDS.cpuSustainedHighPct,
      frac: THRESHOLDS.cpuSustainedFrac,
    },
    threshold: "THRESHOLDS.cpuSustainedHighPct / cpuSustainedFrac",
    summary: "CPU sustained high - queries are queueing for cores",
  },
  {
    name: "SupabaseMemorySaturated",
    heuristicId: "mem_saturated",
    severity: "med",
    expr: {
      kind: "sustained",
      panel: "Memory used (%)",
      value: THRESHOLDS.memSustainedHighPct,
      frac: THRESHOLDS.memSustainedFrac,
    },
    threshold: "THRESHOLDS.memSustainedHighPct / memSustainedFrac",
    summary: "Memory sustained near the ceiling",
  },
  {
    name: "SupabaseDiskFull",
    heuristicId: "disk_full",
    severity: "med",
    expr: {
      kind: "threshold",
      panel: "Disk used (%)",
      op: ">=",
      value: THRESHOLDS.diskFullFrac * 100,
    },
    threshold: "THRESHOLDS.diskFullFrac",
    summary: "Data disk past the fill threshold",
  },
  {
    name: "SupabaseMajorPageFaults",
    heuristicId: "mem_pressure_paging",
    severity: "med",
    expr: {
      kind: "mean",
      panel: "Major page faults/s",
      op: ">=",
      value: THRESHOLDS.majorFaultsPerSec,
    },
    threshold: "THRESHOLDS.majorFaultsPerSec",
    summary: "Working set paging in from disk (major faults)",
  },
  {
    name: "SupabaseSwapIn",
    heuristicId: "mem_pressure_paging",
    severity: "med",
    expr: {
      kind: "mean",
      panel: "Swap-in pages/s",
      op: ">=",
      value: THRESHOLDS.swapInPagesPerSec,
    },
    threshold: "THRESHOLDS.swapInPagesPerSec",
    summary: "Working set paging in from swap",
  },
  {
    name: "SupabasePsiCpuStall",
    heuristicId: "psi_saturation",
    severity: "med",
    expr: { kind: "mean", panel: "CPU stall (PSI %)", op: ">=", value: THRESHOLDS.psiStallPct },
    threshold: "THRESHOLDS.psiStallPct",
    summary: "Sustained CPU stall time (PSI)",
    requires: "a node_exporter with the pressure-stall collector enabled",
  },
  {
    name: "SupabasePsiMemoryStall",
    heuristicId: "psi_saturation",
    severity: "med",
    expr: { kind: "mean", panel: "Memory stall (PSI %)", op: ">=", value: THRESHOLDS.psiStallPct },
    threshold: "THRESHOLDS.psiStallPct",
    summary: "Sustained memory stall time (PSI)",
    requires: "a node_exporter with the pressure-stall collector enabled",
  },
  {
    name: "SupabasePsiIoStall",
    heuristicId: "psi_saturation",
    severity: "med",
    expr: { kind: "mean", panel: "I/O stall (PSI %)", op: ">=", value: THRESHOLDS.psiStallPct },
    threshold: "THRESHOLDS.psiStallPct",
    summary: "Sustained I/O stall time (PSI)",
    requires: "a node_exporter with the pressure-stall collector enabled",
  },
  {
    name: "SupabaseOomKill",
    heuristicId: "oom_kill",
    severity: "high",
    expr: { kind: "mean", panel: "OOM kills/s", op: ">", value: 0 },
    threshold:
      "implicit > 0 (any nonzero rate over the window; unlike majorFaultsPerSec has no explicit threshold constant)",
    summary: "Kernel OOM killer fired",
  },
  {
    name: "SupabaseEbsIopsBalanceLow",
    heuristicId: "ebs_balance_low",
    severity: "high",
    expr: {
      kind: "threshold",
      panel: "EBS IOPS balance (%)",
      op: "<=",
      value: THRESHOLDS.ebsBalancePct,
    },
    threshold: "THRESHOLDS.ebsBalancePct",
    summary: "EBS IOPS burst balance depleted - throttling imminent",
    requires: "a cloudwatch_exporter scrape job",
  },
  {
    name: "SupabaseEbsThroughputBalanceLow",
    heuristicId: "ebs_balance_low",
    severity: "high",
    expr: {
      kind: "threshold",
      panel: "EBS throughput balance (%)",
      op: "<=",
      value: THRESHOLDS.ebsBalancePct,
    },
    threshold: "THRESHOLDS.ebsBalancePct",
    summary: "EBS throughput burst balance depleted - throttling imminent",
    requires: "a cloudwatch_exporter scrape job",
  },
  {
    name: "SupabaseCheckpointPressure",
    heuristicId: "checkpoint_pressure",
    severity: "med",
    expr: {
      kind: "ratio",
      num: "Requested checkpoints/s",
      den: ["Requested checkpoints/s", "Timed checkpoints/s"],
      op: ">=",
      value: THRESHOLDS.checkpointReqFrac,
    },
    threshold: "THRESHOLDS.checkpointReqFrac",
    summary: "Most checkpoints are forced by WAL filling, not the timer",
  },
  {
    name: "SupabaseWalArchivalBacklog",
    heuristicId: "wal_archival_backlog",
    severity: "high",
    expr: {
      kind: "mean",
      panel: "WAL files pending archival",
      op: ">=",
      value: THRESHOLDS.walPendingMax,
    },
    threshold: "THRESHOLDS.walPendingMax",
    summary: "WAL archival falling behind - PITR and disk headroom at risk",
  },
];

function panelQuery(panels: { title: string; query: string }[], title: string): string {
  const p = panels.find((x) => x.title === title);
  if (!p) throw new Error(`alerts: no buildPanels() panel titled ${JSON.stringify(title)}`);
  return p.query;
}

export function renderExpr(
  expr: AlertExpr,
  panels: { title: string; query: string }[],
  window: string,
  resolution: string,
): string {
  switch (expr.kind) {
    case "threshold":
      return `(${panelQuery(panels, expr.panel)}) ${expr.op} ${expr.value}`;
    case "mean":
      return `avg_over_time((${panelQuery(panels, expr.panel)})[${window}:${resolution}]) ${expr.op} ${expr.value}`;
    case "sustained": {
      const q = panelQuery(panels, expr.panel);
      const hits = `count_over_time(((${q}) >= ${expr.value})[${window}:${resolution}])`;
      const all = `count_over_time((${q})[${window}:${resolution}])`;
      return `(${hits} / ${all}) >= ${expr.frac}`;
    }
    case "ratio": {
      const num = panelQuery(panels, expr.num);
      const den = expr.den.map((t) => `(${panelQuery(panels, t)})`).join(" + ");
      return `((${num}) / (${den})) ${expr.op} ${expr.value}`;
    }
  }
}

export interface AlertRule {
  alert: string;
  expr: string;
  for?: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  /** Copied from AlertSpec.requires; buckets the rule into the optional group. */
  requires?: string;
}

export function buildAlertRules(opts: AlertOptions = {}): AlertRule[] {
  const window = opts.window ?? ALERT_WINDOW;
  const resolution = opts.resolution ?? ALERT_RESOLUTION;
  const hold = opts.hold ?? ALERT_HOLD;
  const panels = buildPanels(opts.refMatcher ?? "");
  return ALERT_SPECS.map((spec) => {
    const h = HEURISTICS[spec.heuristicId];
    if (!h)
      throw new Error(`alerts: ${spec.name} references unknown heuristic ${spec.heuristicId}`);
    const rule: AlertRule = {
      alert: spec.name,
      expr: renderExpr(spec.expr, panels, window, resolution),
      labels: {
        severity: spec.severity,
        heuristic_id: h.id,
        plane: h.plane,
        ...(spec.requires ? { requires: spec.requires } : {}),
      },
      annotations: {
        summary: spec.summary,
        description: h.whyItMatters,
        remediation: h.remediation,
        verify: h.howToVerify,
        threshold: spec.threshold,
        runbook_url: h.docUrl,
      },
    };
    // The window already smooths mean/sustained/ratio rules; only the
    // point-in-time gauge comparison needs a hold to survive one bad scrape.
    if (spec.expr.kind === "threshold") rule.for = hold;
    if (spec.requires) rule.requires = spec.requires;
    return rule;
  });
}

/** Why a catalogued finding is not expressible as a Prometheus alert. */
export type ExclusionClause =
  /** No metric family carries the input (SQL diagnostic, Management API plane). */
  | "no-metric"
  /** A metric family exists but buildPanels() charts no panel over it. */
  | "no-panel"
  /** Metric + panel exist, but the catalogue threshold means something a
   * PromQL range window cannot reproduce. */
  | "semantics"
  /** Expressible, but it is a report recommendation, not a page. */
  | "not-an-alert";

/**
 * Planes with no metric family behind ANY of their findings. Excluding by plane
 * rather than by id keeps the list maintainable: a new Query-plane heuristic is
 * covered the day it lands. Ids inside these planes that need a MORE specific
 * reason get a per-id EXCLUSIONS entry, which wins.
 */
export const PLANE_EXCLUSIONS: Partial<Record<Plane, string>> = {
  Query:
    "pg_stat_statements / pg_stat_user_tables diagnostics; the scrape carries no per-query family",
  RLS: "pg_policies + pg_index catalogue analysis; no metric family",
  Vacuum: "pg_stat_user_tables and relfrozenxid age; no metric family",
  Config: "pg_settings values, not a metric family",
  Auth: "GoTrue config from the Management API auth plane, not the metrics endpoint",
  Backups: "Management API backups plane; no metric family",
  Advisor: "advisor/splinter lint output; no metric family",
  Functions: "analytics endpoint functions.combined-stats; no metric family",
};

export const EXCLUSIONS: Record<string, { clause: ExclusionClause; why: string }> = {
  // --- Query plane ---
  duplicate_index: { clause: "no-metric", why: "pg_stat_user_indexes SQL; no metric family" },
  fk_unindexed: { clause: "no-metric", why: "pg_constraint + pg_index SQL; no metric family" },
  index_advisor_rec: {
    clause: "no-metric",
    why: "index_advisor advisory output; no metric family",
  },
  index_advisor_signpost: {
    clause: "no-metric",
    why: "index_advisor advisory output; no metric family",
  },
  invalid_index: { clause: "no-metric", why: "pg_stat_user_indexes SQL; no metric family" },
  query_disk_reads_high: { clause: "no-metric", why: "pg_stat_statements SQL; no metric family" },
  query_high_variance: { clause: "no-metric", why: "pg_stat_statements SQL; no metric family" },
  query_temp_spill: { clause: "no-metric", why: "pg_stat_statements SQL; no metric family" },
  seq_scan_heavy: { clause: "no-metric", why: "pg_stat_user_tables SQL; no metric family" },
  statements_evicted: { clause: "no-metric", why: "pg_stat_statements SQL; no metric family" },
  top_query_db_time: { clause: "no-metric", why: "pg_stat_statements SQL; no metric family" },
  table_bloat: { clause: "no-metric", why: "pg_stat_user_tables SQL; no metric family" },
  unused_index: { clause: "no-metric", why: "pg_stat_user_indexes SQL; no metric family" },
  // --- RLS plane ---
  rls_col_unindexed: {
    clause: "no-metric",
    why: "pg_policies + pg_index catalogue analysis; no metric family",
  },
  rls_initplan: { clause: "no-metric", why: "pg_policies catalogue analysis; no metric family" },
  // --- Vacuum plane ---
  autovacuum_freeze_tuning: {
    clause: "no-metric",
    why: "pg_stat_user_tables and relfrozenxid age; no metric family",
  },
  autovacuum_overdue: { clause: "no-metric", why: "pg_stat_user_tables SQL; no metric family" },
  low_hot_update_ratio: { clause: "no-metric", why: "pg_stat_user_tables SQL; no metric family" },
  multixact_wraparound: {
    clause: "no-metric",
    why: "pg_stat_user_tables relminmxid age; no metric family",
  },
  never_autovacuumed: { clause: "no-metric", why: "pg_stat_user_tables SQL; no metric family" },
  stale_table_stats: { clause: "no-metric", why: "pg_stat_user_tables SQL; no metric family" },
  txid_wraparound: {
    clause: "no-metric",
    why: "pg_stat_database xid age SQL; the scrape serves no xid-age family. There IS a path: snapshot records txid_max_age as a store scalar and export-prometheus backfills it, so a Prometheus fed that way can alert on freeze age - but it is a store series, not a scrape family, so it is out of this pack's contract",
  },
  xmin_horizon_blocked: { clause: "no-metric", why: "pg_stat_activity SQL; no metric family" },
  prepared_xact_old: { clause: "no-metric", why: "pg_prepared_xacts SQL; no metric family" },
  freeze_blocked_no_holder: {
    clause: "no-metric",
    why: "pg_stat_database datfrozenxid age; no metric family",
  },
  wraparound_log_warning: {
    clause: "no-metric",
    why: "Postgres server-log evidence; no metric family",
  },
  wraparound_projected: {
    clause: "no-metric",
    why: "pg_stat_database xid age with trend projection; no metric family. Same store-scalar path as txid_wraparound (txid_max_age via export-prometheus), and predict_linear over it would duplicate the finding's own sufficiency-gated projection",
  },
  wal_heavy_statement: { clause: "no-metric", why: "pg_stat_statements SQL; no metric family" },
  visibility_map_low: { clause: "no-metric", why: "pg_class relallvisible SQL; no metric family" },
  public_schema_create: {
    clause: "no-metric",
    why: "pg_namespace aclexplode SQL; no metric family",
  },
  // --- Config plane ---
  checkpoint_completion_low: {
    clause: "no-metric",
    why: "pg_settings values, not a metric family",
  },
  idle_in_txn_timeout_off: { clause: "no-metric", why: "pg_settings values, not a metric family" },
  maintenance_work_mem_low: { clause: "no-metric", why: "pg_settings values, not a metric family" },
  statement_timeout_off: { clause: "no-metric", why: "pg_settings values, not a metric family" },
  track_io_timing_off: { clause: "no-metric", why: "pg_settings values, not a metric family" },
  work_mem_blast: { clause: "no-metric", why: "pg_settings values, not a metric family" },
  // --- Auth plane ---
  auth_anonymous_users: {
    clause: "no-metric",
    why: "GoTrue config from the Management API auth plane, not the metrics endpoint",
  },
  auth_email_autoconfirm: {
    clause: "no-metric",
    why: "GoTrue config from the Management API auth plane, not the metrics endpoint",
  },
  auth_long_jwt: {
    clause: "no-metric",
    why: "GoTrue config from the Management API auth plane, not the metrics endpoint",
  },
  auth_mfa_disabled: {
    clause: "no-metric",
    why: "GoTrue config from the Management API auth plane, not the metrics endpoint",
  },
  auth_weak_password_policy: {
    clause: "no-metric",
    why: "GoTrue config from the Management API auth plane, not the metrics endpoint",
  },
  // --- Backups plane ---
  pitr_absent: { clause: "no-metric", why: "Management API backups plane; no metric family" },
  // --- Advisor plane ---
  advisor_performance: {
    clause: "no-metric",
    why: "advisor/splinter lint output; no metric family",
  },
  advisor_security: { clause: "no-metric", why: "advisor/splinter lint output; no metric family" },
  // --- Connections plane ---
  blocking_locks: { clause: "no-metric", why: "pg_stat_activity SQL; no metric family" },
  contention_episode: { clause: "no-metric", why: "pg_stat_activity SQL; no metric family" },
  live_lock_contention: { clause: "no-metric", why: "pg_stat_activity SQL; no metric family" },
  lock_forensics: { clause: "no-metric", why: "pg_stat_activity SQL; no metric family" },
  lock_wave: { clause: "no-metric", why: "pg_stat_activity SQL; no metric family" },
  long_running: { clause: "no-metric", why: "pg_stat_activity SQL; no metric family" },
  // --- Cron plane ---
  cron_job_failing: { clause: "no-metric", why: "cron.job_run_details SQL; no metric family" },
  cron_job_overrun: { clause: "no-metric", why: "cron.job_run_details SQL; no metric family" },
  pg_cron_review: { clause: "no-metric", why: "cron.job SQL; no metric family" },
  // --- Extension plane ---
  extensions_outdated: { clause: "no-metric", why: "pg_extension SQL; no metric family" },
  pgvector_unindexed: { clause: "no-metric", why: "pg_index SQL; no metric family" },
  vector_index_economics: { clause: "no-metric", why: "pg_index/pg_class SQL; no metric family" },
  filtered_vector_query: { clause: "no-metric", why: "pg_stat_statements SQL; no metric family" },
  queue_poll_pressure: { clause: "no-metric", why: "pg_stat_statements SQL; no metric family" },
  recursive_cte_heavy: { clause: "no-metric", why: "pg_stat_statements SQL; no metric family" },
  // --- Health plane ---
  hba_weak_auth: { clause: "no-metric", why: "pg_hba_file_rules SQL; no metric family" },
  archiver_failing: { clause: "no-metric", why: "pg_stat_archiver SQL; no metric family" },
  // --- Schema plane (Realtime) ---
  fn_5xx: {
    clause: "no-metric",
    why: "analytics endpoint functions.combined-stats; no metric family",
  },
  // --- Network plane ---
  network_restrictions_open: {
    clause: "no-metric",
    why: "Management API network-restrictions plane; no metric family",
  },
  // --- Version plane ---
  pg_minor_behind: { clause: "no-metric", why: "Postgres version SQL; no metric family" },
  pg_update_available: { clause: "no-metric", why: "Postgres version SQL; no metric family" },
  // --- SSL plane ---
  ssl_not_enforced: {
    clause: "no-metric",
    why: "Management API ssl-enforcement plane; no metric family",
  },
  // --- Compute -------------------------------------------------------------
  cpu_oversized: {
    clause: "not-an-alert",
    why: "downsize recommendation - a cost finding for the report, never a page",
  },
  connections_ceiling: {
    clause: "no-metric",
    why: "the denominator is max_connections from pg_settings; pg_stat_database_num_backends has no max_connections counterpart on the scrape",
  },
  // --- Storage -------------------------------------------------------------
  disk_oversized: {
    clause: "not-an-alert",
    why: "downsize recommendation - a cost finding for the report, never a page",
  },
  disk_expanded: {
    clause: "not-an-alert",
    why: "records that a resize happened; informational context, not a page",
  },
  disk_fill_projection: {
    clause: "semantics",
    why: "projectDataDisk() segments the series on a disk RESIZE (diskResizeStepFrac) before fitting; predict_linear has no equivalent, so an auto-expansion would be extrapolated as a cliff",
  },
  disk_iops_high: {
    clause: "no-metric",
    why: "the denominator is provisioned IOPS from the Management API disk plane",
  },
  wal_slot_growing: { clause: "no-metric", why: "pg_replication_slots SQL; no metric family" },
  wal_retained_inactive_slot: {
    clause: "no-metric",
    why: "pg_replication_slots SQL; no metric family",
  },
  wal_slot_lag: { clause: "no-metric", why: "pg_replication_slots SQL; no metric family" },
  replication_slot_lost: { clause: "no-metric", why: "pg_replication_slots SQL; no metric family" },
  cron_history_unpruned: { clause: "no-metric", why: "cron.job_run_details SQL; no metric family" },
  bloat_estimate_suspect: {
    clause: "no-metric",
    why: "bloat estimator cross-check over catalogue stats; no metric family",
  },
  sequence_exhaustion: { clause: "no-metric", why: "pg_sequences SQL; no metric family" },
  toast_cache_cold: { clause: "no-metric", why: "pg_statio TOAST stats; no metric family" },
  storage_concentration: { clause: "no-metric", why: "table-size SQL; no metric family" },
  index_heavy_table: { clause: "no-metric", why: "index-vs-heap size SQL; no metric family" },
  checksum_failure: { clause: "no-metric", why: "pg_stat_database checksum SQL; no metric family" },
  managed_schema_no_pk: { clause: "no-metric", why: "catalogue SQL; no metric family" },
  index_corruption: { clause: "no-metric", why: "amcheck bt_index_check; no metric family" },
  heap_corruption: { clause: "no-metric", why: "amcheck verify_heapam; no metric family" },
  public_bucket: { clause: "no-metric", why: "storage buckets API plane; no metric family" },
  unlogged_table: { clause: "no-metric", why: "pg_class persistence SQL; no metric family" },
  // --- Connections ---------------------------------------------------------
  pooler_clients_waiting: {
    clause: "no-panel",
    why: "pgbouncer_pools_client_waiting_connections is on the scrape and in the metrics allowlist, but buildPanels() charts no pooler panel; add the panel first",
  },
  direct_conn_high: {
    clause: "no-metric",
    why: "compares pg_stat_activity direct connections against max_connections from pg_settings",
  },
  role_conn_high: { clause: "no-metric", why: "per-role pg_stat_activity SQL; no metric family" },
  idle_in_txn_open: { clause: "no-metric", why: "pg_stat_activity SQL; no metric family" },
  // --- Realtime ------------------------------------------------------------
  realtime_postgres_changes: {
    clause: "not-an-alert",
    why: "a scaling nudge on a working feature; any nonzero subscription count is normal",
  },
  // --- Boundary cases inside plane-excluded planes -------------------------
  cache_hit_low: {
    clause: "semantics",
    why: "the catalogue pairs cacheHitPct with cacheHitMinBlocks, a cumulative-since-reset volume floor that stops an idle database reporting a bad ratio; a rate window has no catalogued floor, so a rate-form rule would page on idle projects",
  },
  deadlocks: {
    clause: "semantics",
    why: "deadlockMin is a cumulative count since the last stats reset; increase() over a window answers a different question with the same number",
  },
  work_mem_spill: {
    clause: "no-panel",
    why: "pg_stat_database_temp_bytes_total is on the scrape and trends.ts derives 'Temp file bytes/s' from the store, but buildPanels() has no such panel, so the Prometheus path cannot see it",
  },
};

/** Markdown table of everything deliberately left out, for the pack README. */
export function renderExclusions(): string {
  const rows: string[] = ["| Finding | Plane | Clause | Why |", "| --- | --- | --- | --- |"];
  for (const [id, h] of Object.entries(HEURISTICS).sort(([a], [b]) => a.localeCompare(b))) {
    if (ALERT_SPECS.some((s) => s.heuristicId === id)) continue;
    const specific = EXCLUSIONS[id];
    if (specific) {
      rows.push(`| \`${id}\` | ${h.plane} | ${specific.clause} | ${specific.why} |`);
      continue;
    }
    const byPlane = PLANE_EXCLUSIONS[h.plane];
    if (byPlane) rows.push(`| \`${id}\` | ${h.plane} | no-metric | ${byPlane} |`);
  }
  return rows.join("\n");
}

/** Ids covered by no rule and no exclusion - the drift the test guards. */
export function unclassifiedHeuristics(): string[] {
  return Object.entries(HEURISTICS)
    .filter(([id]) => !ALERT_SPECS.some((s) => s.heuristicId === id) && !EXCLUSIONS[id])
    .map(([id]) => id)
    .sort();
}

function quote(s: string): string {
  return `'${s.replace(/\s+/g, " ").trim().replace(/'/g, "''")}'`;
}

/**
 * Two groups, always both emitted. `<name>` holds rules whose families the
 * Supabase metrics endpoint serves; `<name>-optional` holds the ones that need
 * an extra scrape source (PSI, CloudWatch EBS) and stay silent without it. The
 * split is the point: a never-firing rule sitting in the main group reads as
 * coverage.
 */
export function renderAlertsYaml(rules: AlertRule[], groupName = "sbperf"): string {
  const emit = (out: string[], r: AlertRule): void => {
    out.push(`      - alert: ${r.alert}`);
    out.push(`        expr: ${quote(r.expr)}`);
    if (r.for) out.push(`        for: ${r.for}`);
    out.push("        labels:");
    for (const k of Object.keys(r.labels)) out.push(`          ${k}: ${quote(r.labels[k]!)}`);
    out.push("        annotations:");
    for (const k of Object.keys(r.annotations))
      out.push(`          ${k}: ${quote(r.annotations[k]!)}`);
  };
  const out: string[] = [
    "# Generated by sbperf from the heuristics.ts threshold catalogue.",
    "# Every expression is a buildPanels() trend-panel query, so a rule and the",
    "# report card behind it read the same number. Regenerate; do not hand-edit.",
    "groups:",
    `  - name: ${groupName}`,
    "    rules:",
  ];
  for (const r of rules.filter((x) => !x.requires)) emit(out, r);
  out.push("  # These need a scrape source beyond the Supabase metrics endpoint and stay");
  out.push("  # silent without it - see the `requires` label. Delete the group if you do");
  out.push("  # not run that source, so an inert rule is never read as coverage.");
  out.push(`  - name: ${groupName}-optional`);
  out.push("    rules:");
  for (const r of rules.filter((x) => x.requires)) emit(out, r);
  return `${out.join("\n")}\n`;
}

/**
 * Metric families a rule references that the committed corpus capture does not
 * confirm. `test/fixtures/metrics-sample.txt` is a TRUNCATED real scrape (cut
 * mid-line at 39820 bytes), so it can prove a family EXISTS and can never prove
 * one absent - an undeclared miss is a typo or an invented name, a declared one
 * is a known blind spot. check-alerts-drift.ts warns on both an undeclared miss
 * and a stale entry, so recapturing the corpus promotes entries rather than
 * letting them rot. Confirm against a live scrape (see docs/alerts.md) and
 * delete the entry.
 */
export const CORPUS_GAPS: Record<string, string> = {
  node_pressure_cpu_waiting_seconds_total:
    "the pressure-stall collector is not enabled on the Supabase metrics endpoint (docs/grafana-prometheus.md); the panel and rule exist for a Prometheus that also scrapes a node_exporter with PSI on",
  node_pressure_memory_waiting_seconds_total:
    "the pressure-stall collector is not enabled on the Supabase metrics endpoint (docs/grafana-prometheus.md); the panel and rule exist for a Prometheus that also scrapes a node_exporter with PSI on",
  node_pressure_io_waiting_seconds_total:
    "the pressure-stall collector is not enabled on the Supabase metrics endpoint (docs/grafana-prometheus.md); the panel and rule exist for a Prometheus that also scrapes a node_exporter with PSI on",
  pg_stat_bgwriter_checkpoints_req_total:
    "postgres_exporter bgwriter collector; past the truncation point of the committed corpus capture",
  pg_stat_bgwriter_checkpoints_timed_total:
    "postgres_exporter bgwriter collector; past the truncation point of the committed corpus capture",
  pg_ls_archive_statusdir_wal_pending_count:
    "postgres_exporter archive-statusdir collector; past the truncation point of the committed corpus capture",
  aws_ec2_ebsiobalance_percent_minimum:
    "CloudWatch, not the Supabase metrics endpoint - present only when the Prometheus also scrapes cloudwatch_exporter, so this rule is inert otherwise",
  aws_ec2_ebsbyte_balance_percent_minimum:
    "CloudWatch, not the Supabase metrics endpoint - present only when the Prometheus also scrapes cloudwatch_exporter, so this rule is inert otherwise",
};
