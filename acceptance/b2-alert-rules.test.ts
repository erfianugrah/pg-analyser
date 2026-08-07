// Acceptance - alert pack Task 2: rules carry the catalogue's numbers and prose,
// not restated copies.
// Contract only. Do not edit to make the implementation pass.
import { describe, expect, test } from "bun:test";
import { ALERT_SPECS, buildAlertRules } from "../src/alerts.ts";
import { HEURISTICS, THRESHOLDS } from "../src/heuristics.ts";

const rules = () => buildAlertRules();
const byName = (n: string) => rules().find((r) => r.alert === n);

describe("thresholds trace to the heuristics catalogue", () => {
  test("no rule invents a number: every threshold string names a THRESHOLDS key", () => {
    const keys = Object.keys(THRESHOLDS);
    for (const s of ALERT_SPECS) {
      expect(
        keys.some((k) => s.threshold.includes(k)),
        `${s.name} threshold "${s.threshold}" names no THRESHOLDS key`,
      ).toBe(true);
    }
  });

  test("the CPU rule carries the sustained percentage AND the sustained fraction", () => {
    const r = byName("SupabaseCpuSaturated");
    expect(r).toBeDefined();
    expect(r?.expr).toContain(`>= ${THRESHOLDS.cpuSustainedHighPct}`);
    expect(r?.expr).toContain(`>= ${THRESHOLDS.cpuSustainedFrac}`);
  });

  test("the disk rule converts the fraction to a percentage", () => {
    expect(byName("SupabaseDiskFull")?.expr).toContain(`>= ${THRESHOLDS.diskFullFrac * 100}`);
  });
});

describe("annotations are lifted from the heuristic, never restated", () => {
  test("every rule's annotations are byte-identical to its heuristic's", () => {
    for (const s of ALERT_SPECS) {
      const h = HEURISTICS[s.heuristicId];
      expect(h, `no heuristic ${s.heuristicId}`).toBeDefined();
      const r = byName(s.name);
      expect(r, `no rule ${s.name}`).toBeDefined();
      expect(r?.annotations.remediation).toBe(h?.remediation ?? "");
      expect(r?.annotations.verify).toBe(h?.howToVerify ?? "");
      expect(r?.annotations.runbook_url).toBe(h?.docUrl ?? "");
      expect(r?.labels.plane).toBe(h?.plane ?? "");
      expect(r?.labels.severity).toBe(s.severity);
    }
  });
});

describe("rules that need a scrape source we do not serve are marked", () => {
  test("at least one rule carries requires, and every such rule labels it", () => {
    const optional = rules().filter((r) => r.requires);
    expect(optional.length).toBeGreaterThan(0);
    for (const r of optional) expect(r.labels.requires).toBe(r.requires ?? "");
  });

  test("rules over Supabase-served families carry no requires label", () => {
    for (const r of rules().filter((x) => !x.requires)) expect(r.labels.requires).toBeUndefined();
  });
});

describe("options are options, not constants", () => {
  test("refMatcher scopes every expression", () => {
    const scoped = buildAlertRules({ refMatcher: 'supabase_project_ref="abc"' });
    expect(scoped.some((r) => r.expr.includes('supabase_project_ref="abc"'))).toBe(true);
  });

  test("window and resolution flow into the range selectors", () => {
    const wide = buildAlertRules({ window: "6h", resolution: "1m" });
    expect(wide.some((r) => r.expr.includes("[6h:1m]"))).toBe(true);
  });

  test("hold sets `for` on point-in-time rules only", () => {
    const held = buildAlertRules({ hold: "13m" });
    const withFor = held.filter((r) => r.for);
    expect(withFor.length).toBeGreaterThan(0);
    for (const r of withFor) expect(r.for).toBe("13m");
  });
});
