import { basename, dirname } from "node:path";
import type { SnapshotForTrends } from "./trends.ts";

/**
 * Render accumulated snapshots as OpenMetrics text with timestamps, suitable
 * for `promtool tsdb create-blocks-from-openmetrics` to backfill a Prometheus
 * TSDB - so Grafana can query sbperf's history RETROACTIVELY, instead of
 * sbperf reinventing a time-series store. The SQLite store stays the source of
 * truth; this is an export view.
 *
 * Every family is declared `unknown` type: it sidesteps OpenMetrics' strict
 * suffix rules for counter/histogram/summary while still letting PromQL rate()
 * over the raw samples. SQL-derived scalars are emitted as `sbperf_<key>`.
 */

type Point = { ts: number; v: number };
type Series = { labels: Record<string, string>; points: Point[] };

function labelKey(labels: Record<string, string>): string {
  return JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)));
}

function renderLabels(labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort();
  if (!keys.length) return "";
  const parts = keys.map((k) => {
    const v = labels[k]!.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
    return `${k}="${v}"`;
  });
  return `{${parts.join(",")}}`;
}

export function toOpenMetrics(snapshots: SnapshotForTrends[]): string {
  // family name -> series key -> series
  const families = new Map<string, Map<string, Series>>();

  const add = (name: string, labels: Record<string, string>, ts: number, v: number) => {
    let fam = families.get(name);
    if (!fam) {
      fam = new Map();
      families.set(name, fam);
    }
    const key = labelKey(labels);
    let series = fam.get(key);
    if (!series) {
      series = { labels, points: [] };
      fam.set(key, series);
    }
    series.points.push({ ts, v });
  };

  for (const snap of snapshots) {
    for (const s of snap.samples) add(s.name, s.labels, snap.ts, s.value);
    for (const [k, v] of Object.entries(snap.scalars)) {
      if (v != null && Number.isFinite(v)) add(`sbperf_${k}`, {}, snap.ts, v);
    }
  }

  const out: string[] = [];
  for (const name of [...families.keys()].sort()) {
    out.push(`# TYPE ${name} unknown`);
    const fam = families.get(name)!;
    for (const key of [...fam.keys()].sort()) {
      const series = fam.get(key)!;
      const lbl = renderLabels(series.labels);
      for (const p of series.points.sort((a, b) => a.ts - b.ts)) {
        out.push(`${name}${lbl} ${p.v} ${p.ts}`);
      }
    }
  }
  out.push("# EOF");
  return `${out.join("\n")}\n`;
}

/**
 * The backfill runbook printed after an export. promtool ships inside the
 * prom/prometheus image (no host install needed). We import blocks straight
 * into the scrape-init stack's named data volume as the prometheus uid (65534,
 * `nobody`) so the write is permitted, then restart. Verified against
 * prom/prometheus:v3.1.0 - the subcommand is `create-blocks-from openmetrics`
 * (two tokens) and the image entrypoint must be overridden to promtool.
 */
export function backfillInstructions(omPath: string, stackDir = "scraper-live"): string {
  return [
    "Backfill into the scrape-init Prometheus (promtool ships in prom/prometheus;",
    "run as its uid 65534 so it can write the data volume):",
    "",
    `  docker run --rm --user 65534:65534 \\`,
    `    -v "${dirname(omPath)}":/in:ro \\`,
    `    -v ${stackDir}_prometheus-data:/prometheus \\`,
    `    --entrypoint promtool prom/prometheus:v3.1.0 \\`,
    `    tsdb create-blocks-from openmetrics /in/${basename(omPath)} /prometheus`,
    "",
    `  (cd ${stackDir} && docker compose restart prometheus)`,
    "",
    "Grafana then queries the full accumulated history retroactively.",
  ].join("\n");
}
