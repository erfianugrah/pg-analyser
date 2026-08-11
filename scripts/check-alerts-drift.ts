#!/usr/bin/env bun
/**
 * Alert-pack drift-check (advisory, offline). Two layers, same shape as
 * check-api-drift.ts:
 *
 * PRIMARY - catalogue coverage. Every heuristic in HEURISTICS must be either
 * alerted on or explicitly excluded (per-id or by plane). A new heuristic that
 * nobody classified is the drift that actually happens: the pack silently stops
 * covering the catalogue it claims to be derived from.
 *
 * CROSS-CHECK - metric-name confirmation against the captured corpus in
 * test/fixtures/metrics-sample.txt. That file is a TRUNCATED real scrape
 * (39820 bytes, cut mid-line), so it can confirm a family exists and can never
 * prove one absent. Names it confirms are green; the rest must carry a
 * CORPUS_GAPS entry in src/alerts.ts saying why they are unconfirmed. A
 * CORPUS_GAPS entry the corpus now contains is stale and gets warned, so
 * recapturing the corpus promotes entries instead of rotting them.
 *
 *   bun run scripts/check-alerts-drift.ts        # warn on drift, exit 0
 *   PG_ANALYSER_ALERTS_STRICT=1 bun run ...           # exit 1 on drift (gated job)
 */

import { buildAlertRules, CORPUS_GAPS, unclassifiedHeuristics } from "../src/alerts.ts";

const IN_GHA = process.env.GITHUB_ACTIONS === "true";
const STRICT = process.env.PG_ANALYSER_ALERTS_STRICT === "1";
const warn = (m: string): void => console.error(IN_GHA ? `::warning::${m}` : `warning: ${m}`);
let drifted = false;

// --- PRIMARY: every heuristic classified ------------------------------------
const unclassified = unclassifiedHeuristics();
if (unclassified.length) {
  drifted = true;
  warn(
    `${unclassified.length} heuristic(s) are neither alerted nor excluded - add an ALERT_SPECS ` +
      `entry or an EXCLUSIONS entry in src/alerts.ts: ${unclassified.join(", ")}`,
  );
}

// --- CROSS-CHECK: metric names against the captured corpus ------------------
// Render with a sentinel matcher so EVERY selector carries braces, then read
// the family name off the left of each one. Exact, no PromQL-function denylist.
const PROBE = "__sbperf_probe__";
const rendered = buildAlertRules({ refMatcher: `${PROBE}="1"` })
  .map((r) => r.expr)
  .join("\n");
const used = new Set<string>();

for (const m of rendered.matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)\{[^}]*__sbperf_probe__/g))
  used.add(m[1]!);

if (used.size === 0) {
  warn("no metric families extracted from the rules - has buildPanels() stopped using matchers?");
  process.exit(STRICT ? 1 : 0);
}

const corpusPath = new URL("../test/fixtures/metrics-sample.txt", import.meta.url).pathname;
const corpus = await Bun.file(corpusPath).text();
const seen = new Set<string>();
for (const line of corpus.split("\n")) {
  if (!line || line.startsWith("#")) continue;
  const name = line.split(/[ {]/, 1)[0];
  if (name) seen.add(name);
}

const unconfirmed = [...used].filter((n) => !seen.has(n)).sort();
const undeclared = unconfirmed.filter((n) => !CORPUS_GAPS[n]);
const stale = Object.keys(CORPUS_GAPS)
  .filter((n) => seen.has(n))
  .sort();

if (undeclared.length) {
  drifted = true;
  warn(
    `${undeclared.length} alert metric(s) are not in the captured corpus and have no CORPUS_GAPS ` +
      `entry (confirm against a live scrape, then declare or fix): ${undeclared.join(", ")}`,
  );
}
if (stale.length) {
  drifted = true;
  warn(
    `${stale.length} CORPUS_GAPS entr(y/ies) are now present in the corpus - promote them by ` +
      `deleting the entry: ${stale.join(", ")}`,
  );
}

if (!drifted) {
  console.error(
    `alert pack in sync: ${used.size} metric families, ` +
      `${used.size - unconfirmed.length} confirmed by the corpus capture, ` +
      `${unconfirmed.length} declared unconfirmed; every heuristic classified`,
  );
  process.exit(0);
}
process.exit(STRICT ? 1 : 0);
