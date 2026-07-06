/**
 * CI gate: turn a run's findings into a pass/fail decision so a pipeline can
 * block a deploy on regressions. Pure - the CLI loads the Analysis (and an
 * optional baseline for --new-since), calls evaluateGate, prints the summary,
 * and exits nonzero when the gate fails. Reuses the deterministic deriveFindings
 * pass, so the gate sees exactly what the report ranks.
 */
import { computeDiff } from "./diff.ts";
import { type Category, deriveFindings, type Finding, type Severity } from "./findings.ts";
import type { Analysis } from "./schemas.ts";

const SEV_ORDER: Record<Severity, number> = { low: 0, med: 1, high: 2 };

export interface GateOptions {
  /** Fail when any in-scope finding is at or above this severity. */
  failOn: Severity;
  /** Restrict the gate to a single finding category. */
  category?: Category;
  /** Gate only on findings that are NEW vs the baseline (needs a baseline). */
  newOnly?: boolean;
}

export interface GateResult {
  pass: boolean;
  failOn: Severity;
  category?: Category;
  newOnly: boolean;
  /** The in-scope findings that breach the threshold. */
  failing: Finding[];
  /** Severity counts across ALL findings in the run (context, not the gate). */
  counts: { high: number; med: number; low: number };
}

/**
 * Evaluate the gate. `baseline` is only consulted when opts.newOnly is set; in
 * that mode the candidate set is the findings that APPEARED vs the baseline
 * (via computeDiff), so a pre-existing high finding never fails a gate that only
 * cares about new regressions.
 */
export function evaluateGate(
  a: Analysis,
  baseline: Analysis | null,
  opts: GateOptions,
): GateResult {
  const all = deriveFindings(a);
  const counts = {
    high: all.filter((f) => f.severity === "high").length,
    med: all.filter((f) => f.severity === "med").length,
    low: all.filter((f) => f.severity === "low").length,
  };

  let candidates: Finding[];
  if (opts.newOnly && baseline) {
    candidates = computeDiff(baseline, a).findings.appeared;
  } else {
    candidates = all;
  }
  if (opts.category) candidates = candidates.filter((f) => f.category === opts.category);

  const threshold = SEV_ORDER[opts.failOn];
  const failing = candidates.filter((f) => SEV_ORDER[f.severity] >= threshold);
  return {
    pass: failing.length === 0,
    failOn: opts.failOn,
    category: opts.category,
    newOnly: !!opts.newOnly,
    failing,
    counts,
  };
}

const SEV_MARK: Record<Severity, string> = { high: "[H]", med: "[M]", low: "[L]" };

/** Human/CI-log summary of a gate evaluation. */
export function renderGateText(r: GateResult): string {
  const scope = [
    `fail-on=${r.failOn}`,
    r.category ? `category=${r.category}` : null,
    r.newOnly ? "new-only" : null,
  ]
    .filter(Boolean)
    .join(" ");
  const L: string[] = [];
  L.push(
    `sbperf check (${scope}): ${r.counts.high} high / ${r.counts.med} med / ${r.counts.low} low findings`,
  );
  if (r.pass) {
    L.push(`PASS - no ${r.newOnly ? "new " : ""}findings at or above ${r.failOn}`);
  } else {
    L.push(`FAIL - ${r.failing.length} finding(s) at or above ${r.failOn}:`);
    for (const f of r.failing) L.push(`  ${SEV_MARK[f.severity]} ${f.category}: ${f.title}`);
  }
  return L.join("\n");
}
