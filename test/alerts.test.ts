import { describe, expect, test } from "bun:test";
import {
  ALERT_HOLD,
  ALERT_RESOLUTION,
  ALERT_SPECS,
  ALERT_WINDOW,
  buildAlertRules,
  CORPUS_GAPS,
  EXCLUSIONS,
  PLANE_EXCLUSIONS,
  renderAlertsYaml,
  renderExclusions,
  renderExpr,
  unclassifiedHeuristics,
} from "../src/alerts.ts";
import { HEURISTICS, THRESHOLDS } from "../src/heuristics.ts";
import { buildPanels } from "../src/prometheus.ts";

const stub = [
  { title: "A", query: 'metric_a{x="1"}' },
  { title: "B", query: 'metric_b{x="1"}' },
];

describe("renderExpr", () => {
  test("threshold is a bare comparison", () => {
    expect(
      renderExpr({ kind: "threshold", panel: "A", op: "<=", value: 20 }, stub, "1h", "5m"),
    ).toBe('(metric_a{x="1"}) <= 20');
  });

  test("mean is the avgTrend() equivalent", () => {
    expect(renderExpr({ kind: "mean", panel: "A", op: ">=", value: 20 }, stub, "1h", "5m")).toBe(
      'avg_over_time((metric_a{x="1"})[1h:5m]) >= 20',
    );
  });

  test("sustained is the sustainedFrac() equivalent", () => {
    expect(
      renderExpr({ kind: "sustained", panel: "A", value: 80, frac: 0.5 }, stub, "1h", "5m"),
    ).toBe(
      '(count_over_time(((metric_a{x="1"}) >= 80)[1h:5m]) / count_over_time((metric_a{x="1"})[1h:5m])) >= 0.5',
    );
  });

  test("ratio divides by the sum of the denominators", () => {
    expect(
      renderExpr(
        { kind: "ratio", num: "A", den: ["A", "B"], op: ">=", value: 0.3 },
        stub,
        "1h",
        "5m",
      ),
    ).toBe('((metric_a{x="1"}) / ((metric_a{x="1"}) + (metric_b{x="1"}))) >= 0.3');
  });

  test("an unknown panel throws rather than emitting an empty expression", () => {
    expect(() =>
      renderExpr({ kind: "mean", panel: "Nope", op: ">=", value: 1 }, buildPanels(""), "1h", "5m"),
    ).toThrow(/no buildPanels\(\) panel titled/);
  });
});

describe("expressions are panel queries, not hand-written PromQL", () => {
  test("every rule embeds its panel's query verbatim", () => {
    const byTitle = new Map(buildPanels("").map((p) => [p.title, p.query]));
    for (const r of buildAlertRules()) {
      const spec = ALERT_SPECS.find((s) => s.name === r.alert);
      expect(spec, `no spec for ${r.alert}`).toBeDefined();
      if (!spec) continue;
      const refs =
        spec.expr.kind === "ratio"
          ? [spec.expr.num, ...spec.expr.den]
          : [(spec.expr as { panel: string }).panel];
      for (const t of refs) {
        const q = byTitle.get(t);
        expect(q, `no panel titled ${t}`).toBeDefined();
        expect(r.expr).toContain(q ?? "\u0000");
      }
    }
  });

  test("the defaults are the documented window/resolution/hold", () => {
    expect([ALERT_WINDOW, ALERT_RESOLUTION, ALERT_HOLD]).toEqual(["1h", "5m", "10m"]);
  });
});

describe("rules carry the catalogue, not a copy of it", () => {
  test("annotations and plane are lifted from the heuristic", () => {
    for (const s of ALERT_SPECS) {
      const h = HEURISTICS[s.heuristicId];
      const r = buildAlertRules().find((x) => x.alert === s.name);
      expect(r?.annotations.remediation).toBe(h?.remediation ?? "");
      expect(r?.annotations.verify).toBe(h?.howToVerify ?? "");
      expect(r?.annotations.runbook_url).toBe(h?.docUrl ?? "");
      expect(r?.labels.plane).toBe(h?.plane ?? "");
    }
  });

  test("the scrape-down and connection-ceiling rules join the core group", () => {
    const rules = buildAlertRules({ refMatcher: 'supabase_project_ref=~".+"' });
    const down = rules.find((r) => r.alert === "SupabaseScrapeDown");
    expect(down?.expr).toBe('(up{supabase_project_ref=~".+"}) < 1');
    expect(down?.for).toBe(ALERT_HOLD);
    expect(down?.requires).toBeUndefined();
    const ceil = rules.find((r) => r.alert === "SupabaseConnectionCeiling");
    expect(ceil?.expr).toContain("max_connections_connection_count");
    expect(ceil?.expr).toContain(`>= ${THRESHOLDS.connectionsCeilingFrac * 100}`);
    expect(ceil?.for).toBe(ALERT_HOLD);
    expect(ceil?.requires).toBeUndefined();
  });

  test("the CPU and disk thresholds trace to THRESHOLDS", () => {
    const rules = buildAlertRules();
    const cpu = rules.find((r) => r.alert === "SupabaseCpuSaturated");
    expect(cpu?.expr).toContain(`>= ${THRESHOLDS.cpuSustainedHighPct}`);
    expect(cpu?.expr).toContain(`>= ${THRESHOLDS.cpuSustainedFrac}`);
    expect(rules.find((r) => r.alert === "SupabaseDiskFull")?.expr).toContain(
      `>= ${THRESHOLDS.diskFullFrac * 100}`,
    );
  });

  test("options override the defaults", () => {
    const r = buildAlertRules({
      refMatcher: 'supabase_project_ref="abc"',
      window: "6h",
      resolution: "1m",
      hold: "13m",
    });
    expect(r.some((x) => x.expr.includes('supabase_project_ref="abc"'))).toBe(true);
    expect(r.some((x) => x.expr.includes("[6h:1m]"))).toBe(true);
    expect(r.filter((x) => x.for).every((x) => x.for === "13m")).toBe(true);
  });
});

describe("the coverage invariant", () => {
  test("every heuristic is alerted or excluded, never both, never neither", () => {
    const alerted = new Set(ALERT_SPECS.map((s) => s.heuristicId));
    expect(unclassifiedHeuristics()).toEqual([]);
    for (const id of Object.keys(EXCLUSIONS)) {
      expect(alerted.has(id), `${id} is both alerted and excluded`).toBe(false);
      expect(HEURISTICS[id], `EXCLUSIONS names unknown heuristic ${id}`).toBeDefined();
    }
  });

  test("each exclusion states a clause and a reason", () => {
    for (const [id, e] of Object.entries(EXCLUSIONS)) {
      expect(["no-metric", "no-panel", "semantics", "not-an-alert"]).toContain(e.clause);
      expect(e.why.length, `${id} has no reason`).toBeGreaterThan(15);
    }
    for (const why of Object.values(PLANE_EXCLUSIONS)) expect(why.length).toBeGreaterThan(15);
  });

  test("renderExclusions emits a row per excluded finding", () => {
    const md = renderExclusions();
    expect(md).toContain("| Finding | Plane | Clause | Why |");
    for (const id of Object.keys(EXCLUSIONS)) expect(md).toContain(`\`${id}\``);
  });

  test("families the corpus cannot confirm are declared, with the reason", () => {
    expect(Object.keys(CORPUS_GAPS).length).toBeGreaterThan(0);
    for (const why of Object.values(CORPUS_GAPS)) expect(why.length).toBeGreaterThan(20);
  });
});

describe("renderAlertsYaml", () => {
  const yaml = () => renderAlertsYaml(buildAlertRules());

  test("splits the rules that need an extra scrape source into -optional", () => {
    const y = yaml();
    expect(y).toContain("  - name: pg-analyser\n");
    expect(y).toContain("  - name: pg-analyser-optional\n");
    const optionalBlock = y.slice(y.indexOf("- name: pg-analyser-optional"));
    for (const r of buildAlertRules().filter((x) => x.requires))
      expect(optionalBlock).toContain(`- alert: ${r.alert}`);
  });

  test("the group name is overridable", () => {
    expect(renderAlertsYaml(buildAlertRules(), "custom")).toContain("  - name: custom\n");
  });

  test("prose containing a colon or a quote is quoted and stays on one line", () => {
    const y = yaml();
    for (const line of y.split("\n")) {
      if (!line.trimStart().startsWith("remediation:")) continue;
      expect(line.trimStart().slice("remediation:".length).trim().startsWith("'")).toBe(true);
    }
  });

  test("the header marks the file generated", () => {
    expect(yaml().split("\n")[0]).toContain("Generated by pg-analyser");
  });
});
