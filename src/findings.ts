import type { Analysis, SqlRow } from "./schemas.ts";

export type Severity = "high" | "med" | "low";
export type Category = "Performance" | "Security" | "Capacity";

export interface Finding {
  severity: Severity;
  category: Category;
  title: string;
  anchor: string;
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
  if (a.sql.cacheHitPct != null && a.sql.cacheHitPct < 99) {
    out.push({
      severity: "med",
      category: "Performance",
      title: `Cache hit ratio ${a.sql.cacheHitPct}% (target > 99%)`,
      anchor: "#infra",
    });
  }
  const unwrapped = a.sql.rlsPolicies.filter((r) => r.unwrapped_auth === true).length;
  if (unwrapped > 0) {
    out.push({
      severity: "med",
      category: "Performance",
      title: `${unwrapped} RLS ${unwrapped === 1 ? "policy" : "policies"} re-evaluate auth per row - wrap in (select auth.*())`,
      anchor: "#rls",
    });
  }
  const seqScan = publicRows(a.sql.seqScanHeavy).length;
  if (seqScan > 0) {
    out.push({
      severity: "med",
      category: "Performance",
      title: `${seqScan} public ${seqScan === 1 ? "table" : "tables"} sequential-scan heavy (missing index?)`,
      anchor: "#seqscan",
    });
  }
  const unused = publicRows(a.sql.unusedIndexes).length;
  if (unused > 0) {
    out.push({
      severity: "low",
      category: "Performance",
      title: `${unused} unused ${unused === 1 ? "index" : "indexes"} in public (write overhead)`,
      anchor: "#unused",
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
    });
  }
  if (set.get("idle_in_transaction_session_timeout") === "0") {
    out.push({
      severity: "low",
      category: "Performance",
      title: "idle_in_transaction_session_timeout disabled (idle txns can block autovacuum)",
      anchor: "#config",
    });
  }
  if (set.get("statement_timeout") === "0") {
    out.push({
      severity: "low",
      category: "Performance",
      title: "statement_timeout disabled (runaway queries not capped)",
      anchor: "#config",
    });
  }

  // Capacity
  const conns = a.sql.connections.reduce((s, r) => s + num(r.connections), 0);
  const maxConn = num(set.get("max_connections"));
  if (maxConn > 0 && conns / maxConn >= 0.7) {
    out.push({
      severity: "med",
      category: "Capacity",
      title: `Direct connections at ${Math.round((conns / maxConn) * 100)}% of max (${conns}/${maxConn})`,
      anchor: "#connections",
    });
  }
  if (a.disk?.usedBytes != null && a.disk.availBytes != null) {
    const total = a.disk.usedBytes + a.disk.availBytes;
    if (total > 0 && a.disk.usedBytes / total >= 0.8) {
      out.push({
        severity: "med",
        category: "Capacity",
        title: `Disk ${Math.round((a.disk.usedBytes / total) * 100)}% full`,
        anchor: "#infra",
      });
    }
  }
  const vacuumBehind = a.sql.deadTuples.length;
  if (vacuumBehind > 0) {
    out.push({
      severity: "med",
      category: "Capacity",
      title: `${vacuumBehind} ${vacuumBehind === 1 ? "table" : "tables"} with significant dead tuples (autovacuum behind)`,
      anchor: "#deadtuples",
    });
  }
  const waiting = a.metrics.samples.find((s) => s.name === "pgbouncer_pools_cl_waiting");
  if (waiting && waiting.value > 0) {
    out.push({
      severity: "med",
      category: "Capacity",
      title: `${waiting.value} clients waiting on the pooler`,
      anchor: "#metrics",
    });
  }
  // Disk IOPS headroom (needs a Prometheus scraper for the rate; trends-derived).
  const latestTrend = (title: string) =>
    a.trends.find((t) => t.title === title)?.points.at(-1)?.v ?? 0;
  const iops = latestTrend("Disk read IOPS") + latestTrend("Disk write IOPS");
  if (a.disk?.iops && iops >= a.disk.iops * 0.8) {
    out.push({
      severity: "med",
      category: "Capacity",
      title: `Disk IOPS at ${Math.round((iops / a.disk.iops) * 100)}% of provisioned (${Math.round(iops)}/${a.disk.iops})`,
      anchor: "#trends",
    });
  }

  out.sort(
    (x, y) =>
      SEV_RANK[x.severity] - SEV_RANK[y.severity] || CAT_RANK[x.category] - CAT_RANK[y.category],
  );
  return out;
}
