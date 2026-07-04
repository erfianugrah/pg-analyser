import { meta, THRESHOLDS } from "./heuristics.ts";
import { lintFix } from "./lints.ts";
import type { Analysis, SqlRow } from "./schemas.ts";
import { projectDaysTo, sufficient, sustainedFrac, trendStat } from "./trendstats.ts";

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
  /** How to confirm the fix worked (from the heuristic). */
  howToVerify?: string;
  /** Concrete SQL/DDL command template for the fix (from the heuristic). */
  sql?: string;
  /** Deep-link into the project's own dashboard (e.g. the Advisor page). */
  dashUrl?: string;
  /** Canonical doc/source URL for the reader and the narrate pass to cite. */
  docUrl?: string;
  /** Optional changelog / known-issue URL (documented platform change). */
  changelogUrl?: string;
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
  ref: string | undefined,
): Finding[] {
  const byTitle = new Map<
    string,
    { name: string; level: string; count: number; description?: string; remediation?: string }
  >();
  for (const a of list) {
    const g = byTitle.get(a.title) ?? {
      name: a.name,
      level: a.level,
      count: 0,
      description: a.description,
      remediation: a.remediation ?? undefined,
    };
    g.count += 1;
    g.level = worse(g.level, a.level);
    byTitle.set(a.title, g);
  }
  // Deep-link into the customer's own Advisor page (the '_' project redirects to
  // the active project in their session when the ref is unknown).
  const page = category === "Security" ? "security" : "performance";
  const dashUrl = `https://supabase.com/dashboard/project/${ref ?? "_"}/advisors/${page}`;
  const base = meta(category === "Security" ? "advisor_security" : "advisor_performance");
  return [...byTitle].map(([title, g]) => {
    // One-stop-shop: the per-lint catalog gives a plain-English title + concrete
    // fix + SQL + verify. Fall back to the lint's own text when uncatalogued.
    const fix = lintFix(g.name);
    // What's happening: the lint's own description + the affected-object scale.
    // Splinter text backslash-escapes quotes/backticks for markdown; unescape so
    // it doesn't render as literal \'role\'.
    const desc = g.description?.replace(/\\(['"`])/g, "$1");
    const scale = g.count > 1 ? `Affects ${g.count} objects.` : "";
    const evidence = [desc, scale].filter(Boolean).join(" ") || undefined;
    return {
      severity: sevFromLevel(g.level),
      category,
      title: fix?.plainTitle ?? (g.count > 1 ? `${title} (${g.count}x)` : title),
      anchor,
      evidence,
      dashUrl,
      ...base,
      remediation: fix?.whatToDo ?? base.remediation,
      sql: fix?.sql,
      howToVerify: fix?.howToVerify ?? base.howToVerify,
      docUrl: g.remediation ?? base.docUrl,
      changelogUrl: fix?.changelogUrl ?? base.changelogUrl,
    };
  });
}

/** Derive a ranked, deduped findings list - the pyramid apex of the report. */
export function deriveFindings(a: Analysis): Finding[] {
  const out: Finding[] = [];
  const set = settingsMap(a.sql.pgSettings);
  const publicRows = (rows: SqlRow[]) => rows.filter((r) => String(r.schema ?? "") === "public");

  // Advisors (grouped by title)
  out.push(...groupAdvisors(a.advisors.performance, "Performance", "#adv-perf", a.meta.ref));
  out.push(...groupAdvisors(a.advisors.security, "Security", "#adv-sec", a.meta.ref));

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
    // The GitHub release tag is the bare version (e.g. 17.6.1.141); the API
    // reports it prefixed (supabase-postgres-17.6.1.141). Extract the version
    // and link the release notes so the reader sees what the update carries.
    const ver = a.upgrade.latest_app_version.match(/\d+(?:\.\d+)+/)?.[0];
    out.push({
      severity: "low",
      category: "Performance",
      title: `Postgres update available (${a.upgrade.current_app_version} -> ${a.upgrade.latest_app_version})`,
      anchor: "#infra",
      ...meta("pg_update_available"),
      ...(ver ? { changelogUrl: `https://github.com/supabase/postgres/releases/tag/${ver}` } : {}),
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
  // Mean over the trend window - a "sustained" signal, robust to a single-point
  // lull/spike (unlike latestTrend, which is the last point only).
  const avgTrend = (title: string) => {
    const pts = a.trends.find((t) => t.title === title)?.points ?? [];
    return pts.length ? pts.reduce((sum, p) => sum + p.v, 0) / pts.length : 0;
  };
  // Whether a series is present at all - needed for "lower is worse" signals
  // (EBS balance) where an absent series must NOT be read as 0%.
  const hasTrend = (title: string) =>
    (a.trends.find((t) => t.title === title)?.points.length ?? 0) > 0;
  // Worst (min) point over the window - for depletion signals.
  const minTrend = (title: string) => {
    const pts = a.trends.find((t) => t.title === title)?.points ?? [];
    return pts.length ? Math.min(...pts.map((p) => p.v)) : Number.POSITIVE_INFINITY;
  };
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
  // Memory pressure from sustained PAGING (rate; needs >=2 snapshots / a
  // Prometheus). Deliberately NOT swap occupancy: swap is tiny (~1GB) and the
  // kernel parks cold anon pages there, so a full-but-idle swap is normal. The
  // real signal is a sustained swap-IN or major-fault RATE - the working set
  // spilling out of RAM to disk - which a MemAvailable snapshot cannot see.
  const majorFaults = avgTrend("Major page faults/s");
  const swapIn = avgTrend("Swap-in pages/s");
  if (majorFaults >= THRESHOLDS.majorFaultsPerSec || swapIn >= THRESHOLDS.swapInPagesPerSec) {
    const bits: string[] = [];
    if (majorFaults >= THRESHOLDS.majorFaultsPerSec)
      bits.push(`${Math.round(majorFaults)} major faults/s`);
    if (swapIn >= THRESHOLDS.swapInPagesPerSec) bits.push(`${Math.round(swapIn)} swap-ins/s`);
    out.push({
      severity: "med",
      category: "Capacity",
      title: `Memory pressure: working set paging to disk (${bits.join(", ")})`,
      anchor: "#trends",
      ...meta("mem_pressure_paging"),
    });
  }
  // PSI saturation: sustained stall time waiting on CPU / memory / I/O (rate;
  // needs >=2 snapshots / a Prometheus). PSI is the fraction of time work was
  // stalled for a resource - a truer saturation signal than a utilization
  // snapshot, and it names WHICH resource is the bottleneck.
  const stalled = (
    [
      ["CPU stall (PSI %)", "CPU"],
      ["Memory stall (PSI %)", "memory"],
      ["I/O stall (PSI %)", "I/O"],
    ] as const
  )
    .map(([title, label]) => [avgTrend(title), label] as const)
    .filter(([v]) => v >= THRESHOLDS.psiStallPct);
  if (stalled.length) {
    const bits = stalled.map(([v, label]) => `${label} ${Math.round(v)}%`);
    out.push({
      severity: "med",
      category: "Capacity",
      title: `Resource saturation: sustained stall time (${bits.join(", ")})`,
      anchor: "#trends",
      ...meta("psi_saturation"),
    });
  }
  // OOM kills: the kernel OOM killer fired - memory was genuinely exhausted and
  // a process was killed. Any nonzero rate over the window means kills happened.
  const oomKills = avgTrend("OOM kills/s");
  if (oomKills > 0) {
    out.push({
      severity: "high",
      category: "Capacity",
      title: "OOM killer fired (out-of-memory process kills)",
      anchor: "#trends",
      ...meta("oom_kill"),
    });
  }
  // EBS burst-balance depletion: gp2/gp3 throttle hard when credits run down.
  // Only evaluate when the series exists - an absent series is NOT 0% balance.
  const depleted = (
    [
      ["EBS IOPS balance (%)", "IOPS"],
      ["EBS throughput balance (%)", "throughput"],
    ] as const
  )
    .filter(([title]) => hasTrend(title))
    .map(([title, label]) => [minTrend(title), label] as const)
    .filter(([v]) => v <= THRESHOLDS.ebsBalancePct);
  if (depleted.length) {
    const bits = depleted.map(([v, label]) => `${label} ${Math.round(v)}%`);
    out.push({
      severity: "high",
      category: "Capacity",
      title: `EBS burst balance depleting (${bits.join(", ")})`,
      anchor: "#trends",
      ...meta("ebs_balance_low"),
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

  // --- Trend-driven capacity findings (data-aware) --------------------------
  // These read the 30/90-day series via trendstats. Each is gated by
  // sufficient() so it NEVER fires from a single snapshot - it lights up when a
  // Grafana source gives real history (or enough store snapshots accrue). This
  // is where the no-PAT + Grafana path earns its keep: the Management-API
  // provisioning planes are gone, so the trend IS the capacity signal.
  const pointsOf = (title: string) => a.trends.find((t) => t.title === title)?.points ?? [];

  // CPU sizing, both directions.
  const cpuPts = pointsOf("CPU utilization (%)");
  if (sufficient(cpuPts)) {
    const s = trendStat(cpuPts)!;
    const hotFrac = sustainedFrac(cpuPts, THRESHOLDS.cpuSustainedHighPct, ">=");
    if (hotFrac >= THRESHOLDS.cpuSustainedFrac) {
      out.push({
        severity: "high",
        category: "Capacity",
        title: `CPU sustained high: ${Math.round(hotFrac * 100)}% of ${Math.round(s.spanDays)}d at >=${THRESHOLDS.cpuSustainedHighPct}% (avg ${Math.round(s.mean)}%, peak ${Math.round(s.max)}%)`,
        anchor: "#trends",
        ...meta("cpu_saturated"),
      });
    } else if (s.spanDays >= THRESHOLDS.cpuOversizeMinDays && s.p95 <= THRESHOLDS.cpuOversizePct) {
      out.push({
        severity: "low",
        category: "Capacity",
        title: `CPU consistently idle: p95 ${Math.round(s.p95)}% over ${Math.round(s.spanDays)}d (peak ${Math.round(s.max)}%) - likely over-provisioned`,
        anchor: "#trends",
        ...meta("cpu_oversized"),
      });
    }
  }

  // Memory sustained near the ceiling.
  const memPts = pointsOf("Memory used (%)");
  if (sufficient(memPts)) {
    const s = trendStat(memPts)!;
    const frac = sustainedFrac(memPts, THRESHOLDS.memSustainedHighPct, ">=");
    if (frac >= THRESHOLDS.memSustainedFrac) {
      out.push({
        severity: "med",
        category: "Capacity",
        title: `Memory sustained high: ${Math.round(frac * 100)}% of ${Math.round(s.spanDays)}d at >=${THRESHOLDS.memSustainedHighPct}% (avg ${Math.round(s.mean)}%, peak ${Math.round(s.max)}%)`,
        anchor: "#trends",
        ...meta("mem_saturated"),
      });
    }
  }

  // Disk fill projection - rising used% -> days to full, capped to a horizon we
  // can actually see (~3x the observed span) so we never extrapolate a
  // far-future date off a short history. Checks BOTH the data disk (/data, where
  // the DB grows) and the root FS (/) - either filling takes the box down.
  for (const [title, label] of [
    ["Disk used (%)", "Data disk"],
    ["Root FS used (%)", "Root FS"],
  ] as const) {
    const pts = pointsOf(title);
    if (!sufficient(pts)) continue;
    const s = trendStat(pts)!;
    if (s.direction !== "rising") continue;
    const daysToFull = projectDaysTo(s, 100);
    const trustHorizon = Math.min(THRESHOLDS.diskFillHorizonDays, 3 * s.spanDays);
    if (daysToFull != null && daysToFull <= trustHorizon) {
      out.push({
        severity: daysToFull <= 30 ? "high" : "med",
        category: "Capacity",
        title: `${label} filling: ${Math.round(s.last)}% used, +${s.slopePerDay.toFixed(2)}%/day over ${Math.round(s.spanDays)}d -> ~${Math.round(daysToFull)} days to full`,
        anchor: "#trends",
        ...meta("disk_fill_projection"),
      });
    }
  }

  // Checkpoint pressure: share of checkpoints forced by WAL filling (requested)
  // vs the healthy timed interval. High requested share -> raise max_wal_size.
  const reqPts = pointsOf("Requested checkpoints/s");
  const timedPts = pointsOf("Timed checkpoints/s");
  if (sufficient(reqPts) && sufficient(timedPts)) {
    const req = trendStat(reqPts)!.mean;
    const timed = trendStat(timedPts)!.mean;
    const total = req + timed;
    if (total > 0 && req / total >= THRESHOLDS.checkpointReqFrac) {
      out.push({
        severity: "med",
        category: "Performance",
        title: `Checkpoint pressure: ${Math.round((req / total) * 100)}% of checkpoints forced by WAL filling (raise max_wal_size)`,
        anchor: "#trends",
        ...meta("checkpoint_pressure"),
      });
    }
  }

  // WAL archival backlog: sustained pending-archival files -> PITR/backup risk.
  const walPts = pointsOf("WAL files pending archival");
  if (sufficient(walPts)) {
    const s = trendStat(walPts)!;
    if (s.mean >= THRESHOLDS.walPendingMax) {
      out.push({
        severity: "high",
        category: "Capacity",
        title: `WAL archival falling behind: avg ${Math.round(s.mean)} files pending over ${Math.round(s.spanDays)}d (peak ${Math.round(s.max)})`,
        anchor: "#trends",
        ...meta("wal_archival_backlog"),
      });
    }
  }

  // Connection ceiling: peak backends vs max_connections (from pgSettings SQL,
  // so it works in no-PAT too). Needs both the trend and the setting.
  const connPts = pointsOf("DB connections");
  const maxConnections = num(settingsMap(a.sql.pgSettings).get("max_connections"));
  if (sufficient(connPts) && maxConnections > 0) {
    const peak = trendStat(connPts)!.max;
    if (peak >= maxConnections * THRESHOLDS.connCeilingFrac) {
      out.push({
        severity: "high",
        category: "Capacity",
        title: `Connections near ceiling: peaked ${Math.round(peak)}/${maxConnections} (${Math.round((peak / maxConnections) * 100)}% of max_connections)`,
        anchor: "#trends",
        ...meta("connections_ceiling"),
      });
    }
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

  // Never claim health when diagnostics were incomplete. In no-PAT mode the
  // project status is simply unknown (no Management API) - that's NOT degraded,
  // full SQL + trends were still collected - so gate on status only when the
  // Management API was available (mirrors the report banner logic).
  const degraded = a.meta.managementApi !== false && a.meta.status !== "ACTIVE_HEALTHY";
  if (degraded || errored.has("sql:dbSize")) return out;

  // Trend-health counterweights to the capacity findings (data-aware: only when
  // there's a real window). A finding and its positive are mutually exclusive.
  const tpoints = (title: string) => a.trends.find((t) => t.title === title)?.points ?? [];
  const cpuPts = tpoints("CPU utilization (%)");
  if (sufficient(cpuPts)) {
    const s = trendStat(cpuPts)!;
    const hot =
      sustainedFrac(cpuPts, THRESHOLDS.cpuSustainedHighPct, ">=") >= THRESHOLDS.cpuSustainedFrac;
    const oversized =
      s.spanDays >= THRESHOLDS.cpuOversizeMinDays && s.p95 <= THRESHOLDS.cpuOversizePct;
    if (!hot && !oversized)
      out.push({
        category: "Capacity",
        title: `CPU well-provisioned: avg ${Math.round(s.mean)}%, peak ${Math.round(s.max)}% over ${Math.round(s.spanDays)}d`,
      });
  }
  const memPts = tpoints("Memory used (%)");
  if (sufficient(memPts)) {
    const s = trendStat(memPts)!;
    if (sustainedFrac(memPts, THRESHOLDS.memSustainedHighPct, ">=") < THRESHOLDS.memSustainedFrac)
      out.push({
        category: "Capacity",
        title: `Memory within healthy range: avg ${Math.round(s.mean)}%, peak ${Math.round(s.max)}% over ${Math.round(s.spanDays)}d`,
      });
  }
  const diskPts = tpoints("Disk used (%)");
  if (sufficient(diskPts)) {
    const s = trendStat(diskPts)!;
    const daysToFull = projectDaysTo(s, 100);
    const filling =
      s.direction === "rising" &&
      daysToFull != null &&
      daysToFull <= Math.min(THRESHOLDS.diskFillHorizonDays, 3 * s.spanDays);
    if (!filling)
      out.push({
        category: "Capacity",
        title: `Disk stable: ${Math.round(s.last)}% used, no fill risk over ${Math.round(s.spanDays)}d`,
      });
  }

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
