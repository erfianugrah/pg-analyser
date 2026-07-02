import type { MetricSample } from "./schemas.ts";

/**
 * Parse Prometheus text-exposition format into samples. Handles the standard
 * `name{label="v",...} value [timestamp]` line shape and bare `name value`.
 * Comment (`#`) lines are skipped. Values like `1.98e+08`, `NaN`, `+Inf` are
 * handled; non-finite samples are dropped.
 */
export function parsePrometheus(text: string): MetricSample[] {
  const out: MetricSample[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const braceStart = line.indexOf("{");
    let name: string;
    let labels: Record<string, string> = {};
    let rest: string;

    if (braceStart !== -1) {
      const braceEnd = line.indexOf("}", braceStart);
      if (braceEnd === -1) continue;
      name = line.slice(0, braceStart);
      labels = parseLabels(line.slice(braceStart + 1, braceEnd));
      rest = line.slice(braceEnd + 1).trim();
    } else {
      const sp = line.indexOf(" ");
      if (sp === -1) continue;
      name = line.slice(0, sp);
      rest = line.slice(sp + 1).trim();
    }

    const valueTok = rest.split(/\s+/)[0];
    const value = Number(valueTok);
    if (!Number.isFinite(value)) continue;
    out.push({ name, labels, value });
  }
  return out;
}

function parseLabels(s: string): Record<string, string> {
  const labels: Record<string, string> = {};
  // key="value" pairs; values may contain escaped quotes/commas.
  const re = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  m = re.exec(s);
  while (m !== null) {
    labels[m[1]!] = m[2]!.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    m = re.exec(s);
  }
  return labels;
}

/**
 * Curate the full scrape down to the perf-relevant point-in-time families.
 * Drops the long tail (go_*, promhttp_*, per-cpu counters, etc.) so
 * analysis.json stays lean.
 */
// Verified against a live privileged-metrics scrape (2026-07). Supabase renames
// exporter families periodically (e.g. pgbouncer_pools_cl_* -> _client_*,
// counters gaining _total) - keep this list matched to the real endpoint. The
// metrics endpoint is NOT in the OpenAPI spec, so the API-drift check can't
// catch this; test/metrics.test.ts guards a representative slice instead.
const ALLOW = [
  // node_exporter - host
  "node_load1",
  "node_load5",
  "node_load15",
  "node_memory_MemTotal_bytes",
  "node_memory_MemAvailable_bytes",
  "node_memory_Active_bytes",
  "node_filesystem_size_bytes",
  "node_filesystem_avail_bytes",
  // postgres_exporter - database
  "pg_stat_database_num_backends",
  "pg_stat_database_deadlocks_total",
  "pg_stat_database_xact_commit_total",
  "pg_stat_database_xact_rollback_total",
  "pg_stat_database_blks_hit_total",
  "pg_stat_database_blks_read_total",
  "pg_stat_database_temp_bytes_total",
  "pg_database_size_bytes",
  "pg_wal_size_mb",
  "pg_stat_bgwriter_checkpoints_req_total",
  "pg_stat_bgwriter_checkpoints_timed_total",
  "pg_stat_replication_replay_lag",
  "pg_stat_replication_send_lag",
  "pg_up",
  // pgbouncer pooler
  "pgbouncer_pools_client_active_connections",
  "pgbouncer_pools_client_waiting_connections",
  "pgbouncer_pools_server_active_connections",
  "pgbouncer_pools_server_idle_connections",
  // auth / realtime
  "auth_users_user_count",
  "realtime_postgres_changes_total_subscriptions",
] as const;

export function curate(samples: MetricSample[]): MetricSample[] {
  const allow = new Set<string>(ALLOW);
  return samples.filter((s) => allow.has(s.name));
}
