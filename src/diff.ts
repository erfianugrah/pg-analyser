/**
 * Compare two Analyses (a baseline and a current run) into a structured diff:
 * which findings appeared / resolved / changed severity, which tracked queries
 * regressed (matched by pg_stat_statements queryid), and how the headline
 * scalars moved. Pure - the CLI loads the two Analyses (from two report dirs or
 * the two most recent history-store snapshots) and renders the result.
 *
 * This is the "did my migration/index/tuning change actually help?" answer: it
 * reuses the deterministic deriveFindings pass on both sides, so a diff is
 * exactly the report's own ranking applied twice and subtracted.
 */
import { type Category, deriveFindings, type Finding, type Severity } from "./findings.ts";
import type { Analysis } from "./schemas.ts";

/** Factor by which a query's mean exec time must grow to count as a regression. */
const REGRESSION_FACTOR = 1.5;
/** Ignore sub-millisecond queries - noise, and the factor explodes near zero. */
const REGRESSION_FLOOR_MS = 1;

export interface FindingDelta {
  appeared: Finding[];
  resolved: Finding[];
  changed: Array<{ title: string; category: Category; from: Severity; to: Severity }>;
  unchanged: number;
}

export interface QueryChange {
  queryid: string;
  query: string;
  fromMeanMs: number;
  toMeanMs: number;
  factor: number;
  calls: number;
}

export interface ScalarDelta {
  label: string;
  from: number | null;
  to: number | null;
  unit: string;
}

export interface AnalysisDiff {
  refA: string;
  refB: string;
  collectedA: string;
  collectedB: string;
  findings: FindingDelta;
  regressions: QueryChange[];
  improvements: QueryChange[];
  /** True when neither side carried a queryid (query-level diff unavailable). */
  queryIdUnavailable: boolean;
  scalars: ScalarDelta[];
}

/**
 * Stable identity for a finding across runs: category + heuristic id + the
 * title with all numbers normalized to '#'. Normalizing digits means the SAME
 * finding whose measured value moved ("Cache hit 92%" -> "88%") collapses to
 * one key, so it shows as a value change (via scalars), never as a spurious
 * resolve+appear pair. Distinct advisor lints share a heuristic id but differ
 * in title, so the title component keeps them apart.
 */
function stableKey(f: Finding): string {
  const title = f.title.replace(/\d[\d.,]*/g, "#");
  return `${f.category}|${f.heuristicId ?? ""}|${title}`;
}

const num = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function diffFindings(a: Analysis, b: Analysis): FindingDelta {
  const oldF = new Map(deriveFindings(a).map((f) => [stableKey(f), f]));
  const newF = new Map(deriveFindings(b).map((f) => [stableKey(f), f]));
  const appeared: Finding[] = [];
  const resolved: Finding[] = [];
  const changed: FindingDelta["changed"] = [];
  let unchanged = 0;
  for (const [k, f] of newF) if (!oldF.has(k)) appeared.push(f);
  for (const [k, f] of oldF) if (!newF.has(k)) resolved.push(f);
  for (const [k, nf] of newF) {
    const of = oldF.get(k);
    if (!of) continue;
    if (of.severity !== nf.severity)
      changed.push({ title: nf.title, category: nf.category, from: of.severity, to: nf.severity });
    else unchanged++;
  }
  return { appeared, resolved, changed, unchanged };
}

/** Index top-statement rows by queryid -> { mean, calls, query }. */
function byQueryId(
  rows: Analysis["sql"]["topStatements"],
): Map<string, { mean: number; calls: number; query: string }> {
  const m = new Map<string, { mean: number; calls: number; query: string }>();
  for (const r of rows) {
    const id = r.queryid == null ? "" : String(r.queryid);
    if (!id) continue;
    const mean = num(r.mean_ms);
    if (mean == null) continue;
    m.set(id, { mean, calls: num(r.calls) ?? 0, query: String(r.query ?? "") });
  }
  return m;
}

function diffQueries(
  a: Analysis,
  b: Analysis,
): {
  regressions: QueryChange[];
  improvements: QueryChange[];
  unavailable: boolean;
} {
  const oldQ = byQueryId(a.sql.topStatements);
  const newQ = byQueryId(b.sql.topStatements);
  if (oldQ.size === 0 && newQ.size === 0)
    return { regressions: [], improvements: [], unavailable: true };
  const regressions: QueryChange[] = [];
  const improvements: QueryChange[] = [];
  for (const [id, nq] of newQ) {
    const oq = oldQ.get(id);
    if (!oq) continue;
    if (nq.mean < REGRESSION_FLOOR_MS && oq.mean < REGRESSION_FLOOR_MS) continue;
    const factor = oq.mean > 0 ? nq.mean / oq.mean : Number.POSITIVE_INFINITY;
    const change: QueryChange = {
      queryid: id,
      query: nq.query,
      fromMeanMs: oq.mean,
      toMeanMs: nq.mean,
      factor,
      calls: nq.calls,
    };
    if (factor >= REGRESSION_FACTOR) regressions.push(change);
    else if (factor <= 1 / REGRESSION_FACTOR) improvements.push(change);
  }
  regressions.sort((x, y) => y.factor - x.factor);
  improvements.sort((x, y) => x.factor - y.factor);
  return { regressions, improvements, unavailable: false };
}

function diffScalars(a: Analysis, b: Analysis): ScalarDelta[] {
  const fa = deriveFindings(a);
  const fb = deriveFindings(b);
  const count = (f: Finding[], s: Severity) => f.filter((x) => x.severity === s).length;
  return [
    { label: "High findings", from: count(fa, "high"), to: count(fb, "high"), unit: "" },
    { label: "Med findings", from: count(fa, "med"), to: count(fb, "med"), unit: "" },
    { label: "Low findings", from: count(fa, "low"), to: count(fb, "low"), unit: "" },
    { label: "Cache hit (table)", from: a.sql.cacheHitPct, to: b.sql.cacheHitPct, unit: "%" },
    { label: "Cache hit (index)", from: a.sql.indexHitPct, to: b.sql.indexHitPct, unit: "%" },
  ];
}

/** Compute the full diff of a baseline Analysis `a` against a current one `b`. */
export function computeDiff(a: Analysis, b: Analysis): AnalysisDiff {
  const q = diffQueries(a, b);
  return {
    refA: a.meta.ref,
    refB: b.meta.ref,
    collectedA: a.meta.collectedAt,
    collectedB: b.meta.collectedAt,
    findings: diffFindings(a, b),
    regressions: q.regressions,
    improvements: q.improvements,
    queryIdUnavailable: q.unavailable,
    scalars: diffScalars(a, b),
  };
}

const SEV_MARK: Record<Severity, string> = { high: "[H]", med: "[M]", low: "[L]" };

/** Render a diff as a plain-text report for the terminal / CI logs. */
export function renderDiffText(d: AnalysisDiff): string {
  const L: string[] = [];
  L.push(`sbperf diff: ${d.refA} @ ${d.collectedA}  ->  ${d.refB} @ ${d.collectedB}`);
  L.push("");

  const { appeared, resolved, changed, unchanged } = d.findings;
  if (!appeared.length && !resolved.length && !changed.length) {
    L.push(`Findings: no change (${unchanged} unchanged)`);
  } else {
    L.push(
      `Findings: +${appeared.length} new  -${resolved.length} resolved  ~${changed.length} severity-changed  =${unchanged} unchanged`,
    );
    for (const f of appeared) L.push(`  + NEW      ${SEV_MARK[f.severity]} ${f.title}`);
    for (const f of resolved) L.push(`  - RESOLVED ${SEV_MARK[f.severity]} ${f.title}`);
    for (const c of changed)
      L.push(`  ~ CHANGED  ${SEV_MARK[c.from]}->${SEV_MARK[c.to]} ${c.title}`);
  }
  L.push("");

  if (d.queryIdUnavailable) {
    L.push("Query regressions: n/a (no queryid captured - re-run analyze to enable)");
  } else if (!d.regressions.length && !d.improvements.length) {
    L.push("Query regressions: none (matched queries within +/-50% mean exec time)");
  } else {
    L.push(`Query changes (matched by queryid, mean exec time):`);
    for (const r of d.regressions)
      L.push(
        `  SLOWER x${r.factor.toFixed(1)}  ${r.fromMeanMs}ms -> ${r.toMeanMs}ms  (${r.calls} calls)  ${trunc(r.query)}`,
      );
    for (const r of d.improvements)
      L.push(
        `  FASTER x${(1 / r.factor).toFixed(1)}  ${r.fromMeanMs}ms -> ${r.toMeanMs}ms  (${r.calls} calls)  ${trunc(r.query)}`,
      );
  }
  L.push("");

  L.push("Scalars:");
  for (const s of d.scalars) {
    const from = s.from == null ? "-" : `${s.from}${s.unit}`;
    const to = s.to == null ? "-" : `${s.to}${s.unit}`;
    const arrow = s.from != null && s.to != null && s.from !== s.to ? "  (changed)" : "";
    L.push(`  ${s.label.padEnd(20)} ${from} -> ${to}${arrow}`);
  }
  return L.join("\n");
}

function trunc(s: string, n = 70): string {
  return s.length > n ? `${s.slice(0, n - 1)}...` : s;
}
