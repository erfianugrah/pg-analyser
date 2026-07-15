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
`;

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
