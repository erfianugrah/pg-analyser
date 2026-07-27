import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { type Analysis, MetricSample } from "./schemas.ts";
import type { SnapshotForTrends } from "./trends.ts";

/**
 * SQLite-backed history store. sbperf is its own collector: each `snapshot`
 * run appends one timestamped Analysis here, and `report` reads accumulated
 * snapshots to compute 30-day trends - no Prometheus/Grafana required.
 *
 * The full Analysis JSON is retained per snapshot (completeness); metric
 * samples and SQL scalars are also denormalized into child tables so trend
 * queries stay cheap. Deletes cascade via ON DELETE CASCADE (foreign_keys ON).
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS snapshots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ref           TEXT    NOT NULL,
  collected_at  TEXT    NOT NULL,
  collected_ts  INTEGER NOT NULL,
  analysis_json TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snap_ref_ts ON snapshots(ref, collected_ts);

CREATE TABLE IF NOT EXISTS metric_samples (
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  labels      TEXT    NOT NULL,
  value       REAL    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ms_snap ON metric_samples(snapshot_id);

CREATE TABLE IF NOT EXISTS sql_scalars (
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  key         TEXT    NOT NULL,
  value       REAL    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ss_snap ON sql_scalars(snapshot_id);

-- sbperf bench: pgbench run history (see bench.ts / docs/bench-design.md).
-- Independent of snapshots (no FK): a benchmark is a point-in-time event, not
-- part of the collected Analysis corpus. Keyed by (ref, script_hash) so a
-- script's runs form a comparable series. Connstrings are never stored.
CREATE TABLE IF NOT EXISTS bench_runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ref             TEXT    NOT NULL,
  ts              INTEGER NOT NULL,
  name            TEXT,
  script_hash     TEXT    NOT NULL,
  script_text     TEXT,
  scale           INTEGER NOT NULL,
  clients         INTEGER NOT NULL,
  threads         INTEGER NOT NULL,
  time_s          INTEGER NOT NULL,
  protocol        TEXT    NOT NULL,
  rate            INTEGER,
  runs_json       TEXT    NOT NULL,
  tps_median      REAL    NOT NULL,
  p50_us          INTEGER NOT NULL,
  p95_us          INTEGER NOT NULL,
  p99_us          INTEGER NOT NULL,
  failed_tx       INTEGER NOT NULL,
  guc_json        TEXT,
  client_cores    INTEGER NOT NULL,
  client_load_max REAL    NOT NULL,
  tainted         INTEGER NOT NULL DEFAULT 0,
  unstable        INTEGER NOT NULL DEFAULT 0,
  pgbench_version TEXT    NOT NULL,
  server_version  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bench_ref_script ON bench_runs(ref, script_hash, ts);
`;

/** One bench_runs row as inserted (id assigned by sqlite). */
export type BenchRunInput = {
  ref: string;
  ts: number;
  name: string | null;
  script_hash: string;
  script_text: string | null;
  scale: number;
  clients: number;
  threads: number;
  time_s: number;
  protocol: string;
  rate: number | null;
  runs_json: string;
  tps_median: number;
  p50_us: number;
  p95_us: number;
  p99_us: number;
  failed_tx: number;
  guc_json: string | null;
  client_cores: number;
  client_load_max: number;
  tainted: boolean;
  unstable: boolean;
  pgbench_version: string;
  server_version: string;
};

/** A hydrated bench_runs row (booleans + parsed pg_settings map). */
export type BenchRunRow = Omit<BenchRunInput, "tainted" | "unstable" | "guc_json"> & {
  id: number;
  tainted: boolean;
  unstable: boolean;
  guc: Record<string, string> | null;
};

/** SQL scalars we trend (SQL-derived numbers not present as metric samples). */
const SCALAR_KEYS: Array<{ key: string; pick: (a: Analysis) => number | null }> = [
  { key: "cache_hit_pct", pick: (a) => a.sql.cacheHitPct },
  { key: "index_hit_pct", pick: (a) => a.sql.indexHitPct },
  // Max WAL retained across ACTIVE replication slots. Trended so a slot whose
  // retention keeps climbing (consumer falling behind) is caught even below the
  // point-in-time 1 GiB threshold. Null when there are no active slots.
  {
    key: "slot_wal_retained_max_bytes",
    pick: (a) => {
      const active = a.sql.replicationSlots.filter((r) => r.active === true);
      if (!active.length) return null;
      return active.reduce((mx, r) => Math.max(mx, Number(r.retained_wal_bytes) || 0), 0);
    },
  },
];

export const DEFAULT_STORE = `${process.env.HOME ?? "."}/.sbperf/history.db`;

/** sqlite row -> BenchRunRow: booleans from ints, guc_json parsed. */
function hydrateBenchRow(r: Record<string, unknown>): BenchRunRow {
  const { guc_json, tainted, unstable, ...rest } = r;
  return {
    ...(rest as unknown as Omit<BenchRunRow, "id" | "tainted" | "unstable" | "guc"> & {
      id: number;
    }),
    tainted: Number(tainted) === 1,
    unstable: Number(unstable) === 1,
    guc: guc_json ? (JSON.parse(String(guc_json)) as Record<string, string>) : null,
  };
}

export class HistoryStore {
  private constructor(private db: Database) {}

  static open(path: string): HistoryStore {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(SCHEMA);
    return new HistoryStore(db);
  }

  /** Append one snapshot; returns its row id. */
  record(analysis: Analysis): number {
    const ts = Math.floor(Date.parse(analysis.meta.collectedAt) / 1000);
    const insertSnap = this.db.query(
      "INSERT INTO snapshots (ref, collected_at, collected_ts, analysis_json) VALUES (?, ?, ?, ?)",
    );
    const insertSample = this.db.query(
      "INSERT INTO metric_samples (snapshot_id, name, labels, value) VALUES (?, ?, ?, ?)",
    );
    const insertScalar = this.db.query(
      "INSERT INTO sql_scalars (snapshot_id, key, value) VALUES (?, ?, ?)",
    );

    const tx = this.db.transaction(() => {
      const res = insertSnap.run(
        analysis.meta.ref,
        analysis.meta.collectedAt,
        ts,
        JSON.stringify(analysis),
      );
      const id = Number(res.lastInsertRowid);
      for (const s of analysis.metrics.samples) {
        insertSample.run(id, s.name, JSON.stringify(s.labels), s.value);
      }
      for (const { key, pick } of SCALAR_KEYS) {
        const v = pick(analysis);
        if (v != null && Number.isFinite(v)) insertScalar.run(id, key, v);
      }
      return id;
    });
    return tx();
  }

  /** All accumulated snapshots for a ref, oldest first, hydrated for trends. */
  loadForTrends(ref: string): SnapshotForTrends[] {
    const snaps = this.db
      .query("SELECT id, collected_ts FROM snapshots WHERE ref = ? ORDER BY collected_ts ASC")
      .all(ref) as Array<{ id: number; collected_ts: number }>;
    const sampleQ = this.db.query(
      "SELECT name, labels, value FROM metric_samples WHERE snapshot_id = ?",
    );
    const scalarQ = this.db.query("SELECT key, value FROM sql_scalars WHERE snapshot_id = ?");

    return snaps.map((snap) => {
      const rawSamples = sampleQ.all(snap.id) as Array<{
        name: string;
        labels: string;
        value: number;
      }>;
      const samples = rawSamples.map((r) =>
        MetricSample.parse({ name: r.name, labels: JSON.parse(r.labels), value: r.value }),
      );
      const scalarRows = scalarQ.all(snap.id) as Array<{ key: string; value: number }>;
      const scalars: Record<string, number | null> = {};
      for (const r of scalarRows) scalars[r.key] = r.value;
      return { ts: snap.collected_ts, samples, scalars };
    });
  }

  snapshotCount(ref: string): number {
    const row = this.db.query("SELECT COUNT(*) AS n FROM snapshots WHERE ref = ?").get(ref) as {
      n: number;
    };
    return row.n;
  }

  /** Distinct refs with at least one snapshot. */
  refs(): string[] {
    const rows = this.db.query("SELECT DISTINCT ref FROM snapshots").all() as Array<{
      ref: string;
    }>;
    return rows.map((r) => r.ref);
  }

  /** The most recent stored Analysis for a ref, or null if none. */
  latestAnalysis(ref: string): Analysis | null {
    const row = this.db
      .query("SELECT analysis_json FROM snapshots WHERE ref = ? ORDER BY collected_ts DESC LIMIT 1")
      .get(ref) as { analysis_json: string } | null;
    return row ? (JSON.parse(row.analysis_json) as Analysis) : null;
  }

  /** The `n` most recent stored Analyses for a ref, newest first. Powers the
   *  store-based `sbperf diff --ref <ref>` (defaults to comparing the last two). */
  recentAnalyses(ref: string, n = 2): Analysis[] {
    const rows = this.db
      .query("SELECT analysis_json FROM snapshots WHERE ref = ? ORDER BY collected_ts DESC LIMIT ?")
      .all(ref, n) as Array<{ analysis_json: string }>;
    return rows.map((r) => JSON.parse(r.analysis_json) as Analysis);
  }

  /** Delete snapshots older than `retentionDays`; 0 = keep forever. Returns deleted count. */
  prune(ref: string, retentionDays: number): number {
    if (retentionDays <= 0) return 0;
    const cutoff = Math.floor(Date.now() / 1000) - retentionDays * 86400;
    const res = this.db
      .query("DELETE FROM snapshots WHERE ref = ? AND collected_ts < ?")
      .run(ref, cutoff);
    return Number(res.changes);
  }

  /** Append one bench run; returns its row id. */
  recordBenchRun(r: BenchRunInput): number {
    const res = this.db
      .query(
        `INSERT INTO bench_runs (ref, ts, name, script_hash, script_text, scale, clients,
          threads, time_s, protocol, rate, runs_json, tps_median, p50_us, p95_us, p99_us,
          failed_tx, guc_json, client_cores, client_load_max, tainted, unstable,
          pgbench_version, server_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.ref,
        r.ts,
        r.name,
        r.script_hash,
        r.script_text,
        r.scale,
        r.clients,
        r.threads,
        r.time_s,
        r.protocol,
        r.rate,
        r.runs_json,
        r.tps_median,
        r.p50_us,
        r.p95_us,
        r.p99_us,
        r.failed_tx,
        r.guc_json,
        r.client_cores,
        r.client_load_max,
        r.tainted ? 1 : 0,
        r.unstable ? 1 : 0,
        r.pgbench_version,
        r.server_version,
      );
    return Number(res.lastInsertRowid);
  }

  /** Bench runs, newest first; optionally scoped to a ref and/or script. */
  benchRuns(ref?: string, scriptHash?: string): BenchRunRow[] {
    const where = [ref ? "ref = ?" : null, scriptHash ? "script_hash = ?" : null]
      .filter(Boolean)
      .join(" AND ");
    const params = [ref, scriptHash].filter((x) => x != null);
    const rows = this.db
      .query(`SELECT * FROM bench_runs${where ? ` WHERE ${where}` : ""} ORDER BY ts DESC`)
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map(hydrateBenchRow);
  }

  /** One bench run by id, or null. */
  benchRun(id: number): BenchRunRow | null {
    const row = this.db.query("SELECT * FROM bench_runs WHERE id = ?").get(id) as Record<
      string,
      unknown
    > | null;
    return row ? hydrateBenchRow(row) : null;
  }

  /** Test helper: count child rows with no parent snapshot (should always be 0). */
  orphanRowCount(): number {
    const q = (child: string) =>
      (
        this.db
          .query(
            `SELECT COUNT(*) AS n FROM ${child} WHERE snapshot_id NOT IN (SELECT id FROM snapshots)`,
          )
          .get() as { n: number }
      ).n;
    return q("metric_samples") + q("sql_scalars");
  }

  close(): void {
    this.db.close();
  }
}
