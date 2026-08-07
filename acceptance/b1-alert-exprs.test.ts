// Acceptance - alert pack, plan docs/plans/2026-08-04-alert-rules.md Task 1.
// The expression renderer and the panel-provenance rule.
// Contract only. Do not edit to make the implementation pass.
import { describe, expect, test } from "bun:test";
import { ALERT_SPECS, renderExpr } from "../src/alerts.ts";
import { buildPanels } from "../src/prometheus.ts";

const stub = [
  { title: "A", query: 'metric_a{x="1"}' },
  { title: "B", query: 'metric_b{x="1"}' },
];

describe("renderExpr - the four expression forms", () => {
  test("threshold is a bare comparison against the panel query", () => {
    expect(
      renderExpr({ kind: "threshold", panel: "A", op: "<=", value: 20 }, stub, "1h", "5m"),
    ).toBe('(metric_a{x="1"}) <= 20');
  });

  test("mean is avg_over_time over the window - the avgTrend() equivalent", () => {
    expect(renderExpr({ kind: "mean", panel: "A", op: ">=", value: 20 }, stub, "1h", "5m")).toBe(
      'avg_over_time((metric_a{x="1"})[1h:5m]) >= 20',
    );
  });

  test("sustained is passing samples over all samples - the sustainedFrac() equivalent", () => {
    expect(
      renderExpr({ kind: "sustained", panel: "A", value: 80, frac: 0.5 }, stub, "1h", "5m"),
    ).toBe(
      '(count_over_time(((metric_a{x="1"}) >= 80)[1h:5m]) / count_over_time((metric_a{x="1"})[1h:5m])) >= 0.5',
    );
  });

  test("ratio divides by the SUM of the denominators", () => {
    expect(
      renderExpr(
        { kind: "ratio", num: "A", den: ["A", "B"], op: ">=", value: 0.3 },
        stub,
        "1h",
        "5m",
      ),
    ).toBe('((metric_a{x="1"}) / ((metric_a{x="1"}) + (metric_b{x="1"}))) >= 0.3');
  });

  test("the window and resolution are honoured, not hardcoded", () => {
    expect(
      renderExpr({ kind: "mean", panel: "A", op: ">=", value: 1 }, stub, "6h", "1m"),
    ).toContain("[6h:1m]");
  });

  test("an unknown panel title throws instead of emitting a silently-empty rule", () => {
    expect(() =>
      renderExpr({ kind: "mean", panel: "Nope", op: ">=", value: 1 }, buildPanels(""), "1h", "5m"),
    ).toThrow(/no buildPanels\(\) panel titled/);
  });
});

describe("every alert expression traces to a report panel", () => {
  test("each referenced panel title exists in buildPanels()", () => {
    const titles = new Set(buildPanels("").map((p) => p.title));
    for (const s of ALERT_SPECS) {
      const refs =
        s.expr.kind === "ratio"
          ? [s.expr.num, ...s.expr.den]
          : [(s.expr as { panel: string }).panel];
      for (const t of refs) expect(titles.has(t), `no panel titled ${t}`).toBe(true);
    }
  });

  test("the catalogue is not empty and every spec names a heuristic", () => {
    expect(ALERT_SPECS.length).toBeGreaterThanOrEqual(10);
    for (const s of ALERT_SPECS) {
      expect(s.name).toMatch(/^Supabase[A-Z]/);
      expect(s.heuristicId.length).toBeGreaterThan(0);
      expect(["high", "med"]).toContain(s.severity);
      expect(s.summary.length).toBeGreaterThan(10);
    }
  });
});
