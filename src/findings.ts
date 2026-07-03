import { meta, THRESHOLDS } from "./heuristics.ts";
import type { Analysis, SqlRow } from "./schemas.ts";

export type Severity = "high" | "med" | "low";
export type Category = "Performance" | "Security" | "Capacity";

export interface Finding {
  severity: Severity;
  category: Category;
  title: string;
  anchor: string;
  /** Heuristic id from src/heuristics.ts, if this finding is catalogued. */
  heuristicId?: string;
  /** One-line copy-pasteable fix guidance (from the heuristic). */
  remediation?: string;
  /** The consequence: business + technical impact (from the heuristic). */
  whyItMatters?: string;
  /** Canonical doc/source URL for the reader and the narrate pass to cite. */
  docUrl?: string;
  /** Optional measured evidence string (e.g. object name + size + %). */
  evidence?: string;
}

/** A confirmed-healthy observation - the "what's looking good" counterweight. */
export interface Positive {
  category: Category;
  title: string;
}

const SEV_RANK: Record<Severity, number> = { high: 0, med: 1, low: 2 };
const CAT_RANK: Record<Category, number> = { Performance: 0, Security: 1, Capacity: 2 };

function sevFromLevel(level: string): Severity {
  if (level === "ERROR") return "high";
  if (level === "WARN") return "med";
  return "low";
}
const worse = (a: string, b: string): string => (sevFromLevel(a) <= sevFromLevel(b) ? a : b);

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function settingsMap(rows: SqlRow[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of rows) m.set(String(r.name), String(r.setting));
  return m;
}

function groupAdvisors(
  list: Analysis["advisors"]["performance"],
  category: Category,
  anchor: string,
): Finding[] {
  const byTitle = new Map<string, { level: string; count: number }>();
  for (const a of list) {
    const g = byTitle.get(a.title) ?? { level: a.level, count: 0 };
    g.count += 1;
    g.level = worse(g.level, a.level);
    byTitle.set(a.title, g);
  }
  return [...byTitle].map(([title, g]) => ({
    severity: sevFromLevel(g.level),
    category,
    title: g.count > 1 ? `${title} (${g.count}x)` : title,
    anchor,
    ...meta(category === "Security" ? "advisor_security" : "advisor_performance"),
  }));
}

/** Derive a ranked, deduped findings list - the pyramid apex of the report. */
export function deriveFindings(a: Analysis): Finding[] {
  const out: Finding[] = [];
  const set = settingsMap(a.sql.pgSettings);
  const publicRows = (rows: SqlRow[]) => rows.filter((r) => String(r.schema ?? "") === "public");

  // Advisors (grouped by title)
  out.push(...groupAdvisors(a.advisors.performance, "Performance", "#adv-perf"));
  out.push(...groupAdvisors(a.advisors.security, "Security", "#adv-sec"));

  // Performance - SQL-derived
  if (a.sql.cacheHitPct != null && a.sql.cacheHitPct < THRESHOLDS.cacheHitPct) {
    out.push({
      severity: "med",
      category: "Performance",
      title: `Cache hit ratio ${a.sql.cacheHitPct}% (target > ${THRESHOLDS.cacheHitPct}%)`,
      anchor: "#infra",
      ...meta("cache_hit_low"),
    });
  }
  const unwrapped = a.sql.rlsPolicies.filter((r) => r.unwrapped_auth === true).length;
  if (unwrapped > 0) {
    out.push({
      severity: "med",
      category: "Performance",
      title: `${unwrapped} RLS ${unwrapped === 1 ? "policy" : "policies"} re-evaluate auth per row - wrap in (select auth.*())`,
      anchor: "#rls",
      ...meta("rls_initplan"),
    });
  }
  const seqScan = publicRows(a.sql.seqScanHeavy).length;
  if (seqScan > 0) {
    out.push({
      severity: "med",
      category: "Performance",
      title: `${seqScan} public ${seqScan === 1 ? "table" : "tables"} sequential-scan heavy (missing index?)`,
      anchor: "#seqscan",
      ...meta("seq_scan_heavy"),
    });
  }
  const unused = publicRows(a.sql.indexStats).filter((r) => r.unused === true).length;
  if (unused > 0) {
    out.push({
      severity: "low",
      category: "Performance",
      title: `${unused} unused ${unused === 1 ? "index" : "indexes"} in public (write overhead)`,
      anchor: "#unused",
      ...meta("unused_index"),
    });
  }
  const dupIdx = publicRows(a.sql.duplicateIndexes).length;
  if (dupIdx > 0) {
    out.push({
      severity: "med",
      category: "Performance",
      title: `${dupIdx} public ${dupIdx === 1 ? "table has" : "tables have"} duplicate indexes (drop the copies)`,
      anchor: "#dupidx",
      ...meta("duplicate_index"),
    });
  }
  const rlsUnindexed = publicRows(a.sql.rlsUnindexed).length;
  if (rlsUnindexed > 0) {
    out.push({
      severity: "med",
      category: "Performance",
      title: `${rlsUnindexed} RLS policy ${rlsUnindexed === 1 ? "column" : "columns"} lack a covering index (seq scan per check)`,
      anchor: "#rlsunindexed",
      ...meta("rls_col_unindexed"),
    });
  }
  if (
    a.upgrade?.current_app_version &&
    a.upgrade.latest_app_version &&
    a.upgrade.current_app_version !== a.upgrade.latest_app_version
  ) {
    out.push({
      severity: "low",
      category: "Performance",
      title: `Postgres update available (${a.upgrade.current_app_version} -> ${a.upgrade.latest_app_version})`,
      anchor: "#infra",
      ...meta("pg_update_available"),
    });
  }
  if (set.get("idle_in_transaction_session_timeout") === "0") {
    out.push({
      severity: "low",
      category: "Performance",
      title: "idle_in_transaction_session_timeout disabled (idle txns can block autovacuum)",
      anchor: "#config",
      ...meta("idle_in_txn_timeout_off"),
    });
  }
  if (set.get("statement_timeout") === "0") {
    out.push({
      severity: "low",
      category: "Performance",
      title: "statement_timeout disabled (runaway queries not capped)",
      anchor: "#config",
      ...meta("statement_timeout_off"),
    });
  }

  // Capacity
  const conns = a.sql.connections.reduce((s, r) => s + num(r.connections), 0);
  const maxConn = num(set.get("max_connections"));
  if (maxConn > 0 && conns / maxConn >= THRESHOLDS.directConnFrac) {
    out.push({
      severity: "med",
      category: "Capacity",
      title: `Direct connections at ${Math.round((conns / maxConn) * 100)}% of max (${conns}/${maxConn})`,
      anchor: "#connections",
      ...meta("direct_conn_high"),
    });
  }
  if (a.disk?.usedBytes != null && a.disk.availBytes != null) {
    const total = a.disk.usedBytes + a.disk.availBytes;
    if (total > 0 && a.disk.usedBytes / total >= THRESHOLDS.diskFullFrac) {
      out.push({
        severity: "med",
        category: "Capacity",
        title: `Disk ${Math.round((a.disk.usedBytes / total) * 100)}% full`,
        anchor: "#infra",
        ...meta("disk_full"),
      });
    }
  }
  const overdue = a.sql.deadTuples.filter((r) => r.overdue === "yes").length;
  if (overdue > 0) {
    out.push({
      severity: "med",
      category: "Capacity",
      title: `${overdue} ${overdue === 1 ? "table" : "tables"} past the autovacuum dead-tuple threshold (vacuum not keeping up)`,
      anchor: "#deadtuples",
      ...meta("autovacuum_overdue"),
    });
  }
  // Per-role connection exhaustion (a single role burning its own budget).
  for (const r of a.sql.roleStats) {
    const conns = num(r.connections);
    const limit = num(r.conn_limit);
    if (limit > 0 && conns / limit >= THRESHOLDS.roleConnFrac) {
      out.push({
        severity: "med",
        category: "Capacity",
        title: `Role ${String(r.role)} at ${Math.round((conns / limit) * 100)}% of its connection limit (${conns}/${limit})`,
        anchor: "#roles",
        ...meta("role_conn_high"),
      });
    }
  }
  // Transaction-ID wraparound headroom (age(relfrozenxid) toward the 2B ceiling).
  const maxXidPct = a.sql.txidWraparound.reduce((mx, r) => Math.max(mx, num(r.pct_wraparound)), 0);
  if (maxXidPct >= THRESHOLDS.txidWarnPct) {
    out.push({
      severity: maxXidPct >= THRESHOLDS.txidHighPct ? "high" : "med",
      category: "Capacity",
      title: `Transaction-ID wraparound at ${maxXidPct}% on the oldest table (freeze autovacuum falling behind)`,
      anchor: "#txid",
      ...meta("txid_wraparound"),
    });
  }
  // Replication slots: inactive slots pin WAL (disk-fill risk); large active lag
  // signals a slow downstream consumer.
  const inactiveSlots = a.sql.replicationSlots.filter(
    (r) => r.active === false && num(r.retained_wal_bytes) > 0,
  ).length;
  if (inactiveSlots > 0) {
    out.push({
      severity: "high",
      category: "Capacity",
      title: `${inactiveSlots} inactive replication ${inactiveSlots === 1 ? "slot" : "slots"} retaining WAL (pins disk until dropped)`,
      anchor: "#slots",
      ...meta("wal_retained_inactive_slot"),
    });
  }
  const laggingSlots = a.sql.replicationSlots.filter(
    (r) => r.active === true && num(r.retained_wal_bytes) >= THRESHOLDS.slotLagBytes,
  ).length;
  if (laggingSlots > 0) {
    out.push({
      severity: "med",
      category: "Capacity",
      title: `${laggingSlots} replication ${laggingSlots === 1 ? "slot" : "slots"} lagging >1GB WAL (slow consumer)`,
      anchor: "#slots",
      ...meta("wal_slot_lag"),
    });
  }
  // Estimated bloat: reclaimable space (>=50MB wasted or >=100MB with 2x+ bloat).
  const worstBloat = a.sql.bloat.reduce((mx, r) => Math.max(mx, num(r.waste_bytes)), 0);
  if (worstBloat >= THRESHOLDS.bloatMinBytes) {
    const top = a.sql.bloat.find((r) => num(r.waste_bytes) === worstBloat);
    out.push({
      severity: worstBloat >= THRESHOLDS.bloatMedBytes ? "med" : "low",
      category: "Capacity",
      title: `~${String(top?.waste ?? "")} reclaimable bloat on ${String(top?.name ?? "a table")} (VACUUM FULL / pg_repack)`,
      anchor: "#bloat",
      ...meta("table_bloat"),
    });
  }
  // Point-in-time: a blocking chain exists right now (real even as a snapshot).
  if (a.sql.blocking.length > 0) {
    out.push({
      severity: "high",
      category: "Performance",
      title: `${a.sql.blocking.length} blocking lock ${a.sql.blocking.length === 1 ? "chain" : "chains"} at collection time`,
      anchor: "#blocking",
      ...meta("blocking_locks"),
    });
  }
  // Point-in-time: queries running > 5 minutes at collection time.
  if (a.sql.longRunning.length > 0) {
    out.push({
      severity: "med",
      category: "Performance",
      title: `${a.sql.longRunning.length} quer${a.sql.longRunning.length === 1 ? "y" : "ies"} running > 5 min at collection time`,
      anchor: "#longrunning",
      ...meta("long_running"),
    });
  }
  // Edge-function server-error rate (from functions.combined-stats).
  for (const fn of a.functionStats) {
    if (
      fn.requests >= THRESHOLDS.fnMinRequests &&
      fn.serverErr / fn.requests >= THRESHOLDS.fnErrWarnFrac
    ) {
      const pct = Math.round((fn.serverErr / fn.requests) * 100);
      out.push({
        severity: fn.serverErr / fn.requests >= THRESHOLDS.fnErrHighFrac ? "high" : "med",
        category: "Performance",
        title: `Edge function ${fn.slug}: ${pct}% 5xx over ${fn.requests} requests`,
        anchor: "#functions",
        ...meta("fn_5xx"),
      });
    }
  }
  const latestTrend = (title: string) =>
    a.trends.find((t) => t.title === title)?.points.at(-1)?.v ?? 0;
  const maxMetric = (name: string) =>
    a.metrics.samples.filter((s) => s.name === name).reduce((mx, s) => Math.max(mx, s.value), 0);
  const sumMetric = (name: string) =>
    a.metrics.samples.filter((s) => s.name === name).reduce((sum, s) => sum + s.value, 0);
  const waiting = maxMetric("pgbouncer_pools_client_waiting_connections");
  if (waiting > 0) {
    out.push({
      severity: "med",
      category: "Capacity",
      title: `${waiting} client${waiting === 1 ? "" : "s"} waiting on the pooler`,
      anchor: "#metrics",
      ...meta("pooler_clients_waiting"),
    });
  }
  // Swap in use = memory pressure. Gauge, meaningful from a single scrape.
  const swapTotal = maxMetric("node_memory_SwapTotal_bytes");
  const swapFree = maxMetric("node_memory_SwapFree_bytes");
  const swapUsed = swapTotal - swapFree;
  if (swapTotal > 0 && swapUsed / swapTotal >= THRESHOLDS.swapUsedFrac) {
    out.push({
      severity: "med",
      category: "Capacity",
      title: `Swap ${Math.round((swapUsed / swapTotal) * 100)}% used (memory pressure)`,
      anchor: "#metrics",
      ...meta("swap_active"),
    });
  }
  // Deadlocks (cumulative counter since stats reset). A rate from >=2 snapshots
  // is stronger, but a nonzero cumulative count is still worth a glance.
  const deadlocks = Math.round(sumMetric("pg_stat_database_deadlocks_total"));
  if (deadlocks >= THRESHOLDS.deadlockMin) {
    out.push({
      severity: "low",
      category: "Performance",
      title: `${deadlocks} deadlocks recorded (cumulative since stats reset)`,
      anchor: "#metrics",
      ...meta("deadlocks"),
    });
  }
  // work_mem spill: sustained temp-file write rate (needs >=2 snapshots).
  const tempRate = latestTrend("Temp file bytes/s");
  if (tempRate >= THRESHOLDS.tempSpillBytesPerSec) {
    out.push({
      severity: "med",
      category: "Performance",
      title: "Sorts/hashes spilling to disk (raise work_mem)",
      anchor: "#trends",
      ...meta("work_mem_spill"),
    });
  }
  // Realtime postgres_changes nudge: it does not scale like Broadcast.
  const pgChanges = Math.round(sumMetric("realtime_postgres_changes_total_subscriptions"));
  if (pgChanges > 0) {
    out.push({
      severity: "low",
      category: "Performance",
      title: `postgres_changes has ${pgChanges} active subscription${pgChanges === 1 ? "" : "s"} (consider Broadcast for scale)`,
      anchor: "#metrics",
      ...meta("realtime_postgres_changes"),
    });
  }
  // Disk IOPS headroom (needs a Prometheus scraper for the rate; trends-derived).
  const iops = latestTrend("Disk read IOPS") + latestTrend("Disk write IOPS");
  if (a.disk?.iops && iops >= a.disk.iops * THRESHOLDS.diskIopsFrac) {
    out.push({
      severity: "med",
      category: "Capacity",
      title: `Disk IOPS at ${Math.round((iops / a.disk.iops) * 100)}% of provisioned (${Math.round(iops)}/${a.disk.iops})`,
      anchor: "#trends",
      ...meta("disk_iops_high"),
    });
  }

  out.sort(
    (x, y) =>
      SEV_RANK[x.severity] - SEV_RANK[y.severity] || CAT_RANK[x.category] - CAT_RANK[y.category],
  );
  return out;
}

/**
 * Confirmed-healthy observations - the counterweight to findings. Only emitted
 * when the underlying signal was actually COLLECTED and is genuinely good; on a
 * degraded/unreachable project we assert nothing (absence of data is not
 * health). Each positive mirrors a finding's threshold, so a positive and its
 * corresponding finding are mutually exclusive by construction.
 */
export function derivePositives(a: Analysis): Positive[] {
  const out: Positive[] = [];
  const errored = new Set(a.errors.map((e) => e.source));
  const set = settingsMap(a.sql.pgSettings);
  const publicRows = (rows: SqlRow[]) => rows.filter((r) => String(r.schema ?? "") === "public");

  // Never claim health when diagnostics were incomplete.
  if (a.meta.status !== "ACTIVE_HEALTHY" || errored.has("sql:dbSize")) return out;

  if (a.sql.cacheHitPct != null && a.sql.cacheHitPct >= THRESHOLDS.cacheHitPct) {
    out.push({
      category: "Performance",
      title: `Cache hit ratio ${a.sql.cacheHitPct}% (>= ${THRESHOLDS.cacheHitPct}% target)`,
    });
  }
  const totalPolicies = a.sql.rlsPolicies.length;
  const unwrapped = a.sql.rlsPolicies.filter((r) => r.unwrapped_auth === true).length;
  if (totalPolicies > 0 && unwrapped === 0) {
    out.push({
      category: "Performance",
      title: `All ${totalPolicies} RLS ${totalPolicies === 1 ? "policy wraps" : "policies wrap"} auth in a subselect`,
    });
  }
  if (
    totalPolicies > 0 &&
    !errored.has("sql:rlsUnindexed") &&
    publicRows(a.sql.rlsUnindexed).length === 0
  ) {
    out.push({ category: "Performance", title: "All RLS policy columns are indexed" });
  }
  if (
    !errored.has("sql:indexStats") &&
    publicRows(a.sql.indexStats).length > 0 &&
    publicRows(a.sql.indexStats).filter((r) => r.unused === true).length === 0
  ) {
    out.push({ category: "Performance", title: "No unused indexes in public" });
  }
  if (
    a.upgrade?.current_app_version &&
    a.upgrade.latest_app_version &&
    a.upgrade.current_app_version === a.upgrade.latest_app_version
  ) {
    out.push({ category: "Performance", title: "Postgres is on the latest platform version" });
  }
  if (set.get("statement_timeout") !== "0" && set.get("statement_timeout") != null) {
    out.push({ category: "Performance", title: "statement_timeout is configured" });
  }
  // Capacity
  if (a.disk?.usedBytes != null && a.disk.availBytes != null) {
    const total = a.disk.usedBytes + a.disk.availBytes;
    if (total > 0 && a.disk.usedBytes / total < THRESHOLDS.diskFullFrac) {
      out.push({
        category: "Capacity",
        title: `Disk ${Math.round((a.disk.usedBytes / total) * 100)}% full (headroom available)`,
      });
    }
  }
  const conns = a.sql.connections.reduce((s, r) => s + num(r.connections), 0);
  const maxConn = num(set.get("max_connections"));
  if (
    !errored.has("sql:connections") &&
    maxConn > 0 &&
    conns / maxConn < THRESHOLDS.directConnFrac
  ) {
    out.push({
      category: "Capacity",
      title: `Connections at ${Math.round((conns / maxConn) * 100)}% of max (${conns}/${maxConn})`,
    });
  }
  const maxXidPct = a.sql.txidWraparound.reduce((mx, r) => Math.max(mx, num(r.pct_wraparound)), 0);
  if (!errored.has("sql:txidWraparound") && maxXidPct < THRESHOLDS.txidWarnPct) {
    out.push({ category: "Capacity", title: "Transaction-ID wraparound headroom is healthy" });
  }
  if (a.backups?.pitr_enabled) {
    out.push({ category: "Capacity", title: "Point-in-time recovery (PITR) is enabled" });
  }
  // Edge functions all healthy (only when there are functions with real traffic).
  const fnsWithTraffic = a.functionStats.filter((f) => f.requests >= THRESHOLDS.fnMinRequests);
  if (
    fnsWithTraffic.length > 0 &&
    fnsWithTraffic.every((f) => f.serverErr / f.requests < THRESHOLDS.fnErrWarnFrac)
  ) {
    out.push({
      category: "Performance",
      title: `All ${fnsWithTraffic.length} active edge ${fnsWithTraffic.length === 1 ? "function is" : "functions are"} within the 5xx budget`,
    });
  }
  return out;
}
