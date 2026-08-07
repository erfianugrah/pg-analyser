// Acceptance - alert pack Task 3/6: the emitted YAML, parsed by a real YAML
// parser (yq), not by a regex over the string we just produced.
// Contract only. Do not edit to make the implementation pass.
import { describe, expect, test } from "bun:test";
import { buildAlertRules, renderAlertsYaml } from "../src/alerts.ts";

type Rule = {
  alert: string;
  expr: string;
  for?: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
};
type Pack = { groups: Array<{ name: string; rules?: Rule[] }> };

/** Parse with yq so a syntactically valid string is not confused for valid YAML. */
function parse(yaml: string): Pack {
  const p = Bun.spawnSync(["yq", "-o=json", "-p=yaml", "."], {
    stdin: Buffer.from(yaml),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (p.exitCode !== 0) throw new Error(`yq rejected the pack: ${p.stderr.toString()}`);
  return JSON.parse(p.stdout.toString());
}

const pack = () => parse(renderAlertsYaml(buildAlertRules()));

describe("the pack is valid YAML with the two-group split", () => {
  test("yq parses it", () => {
    expect(pack().groups.length).toBe(2);
  });

  test("the second group is the -optional one", () => {
    const g = pack().groups;
    expect(g[1]?.name).toBe(`${g[0]?.name}-optional`);
  });

  test("the group name is overridable", () => {
    expect(parse(renderAlertsYaml(buildAlertRules(), "custom")).groups[0]?.name).toBe("custom");
  });

  test("every rule in the optional group carries a requires label", () => {
    for (const r of pack().groups[1]?.rules ?? []) expect(r.labels.requires).toBeTruthy();
  });

  test("no rule in the main group carries one - an inert rule never reads as coverage", () => {
    for (const r of pack().groups[0]?.rules ?? []) expect(r.labels.requires).toBeUndefined();
  });

  test("both groups together hold every built rule", () => {
    const g = pack().groups;
    expect((g[0]?.rules?.length ?? 0) + (g[1]?.rules?.length ?? 0)).toBe(buildAlertRules().length);
  });
});

describe("each rule is shaped the way Prometheus expects", () => {
  test("alert, expr, labels.severity and the runbook annotation are present", () => {
    const all = pack().groups.flatMap((g) => g.rules ?? []);
    expect(all.length).toBeGreaterThanOrEqual(10);
    for (const r of all) {
      expect(r.alert).toMatch(/^Supabase[A-Za-z]+$/);
      expect(r.expr.length).toBeGreaterThan(5);
      // balanced parens: a truncated expression is a silent never-firing rule
      expect(r.expr.split("(").length).toBe(r.expr.split(")").length);
      expect(["high", "med"]).toContain(r.labels.severity);
      expect(r.annotations.summary?.length ?? 0).toBeGreaterThan(10);
      expect(r.annotations.runbook_url ?? "").toMatch(/^https:\/\//);
    }
  });

  test("prose with a colon or quote survives the round trip", () => {
    const all = pack().groups.flatMap((g) => g.rules ?? []);
    const risky = all.filter((r) => /[:'"]/.test(r.annotations.remediation ?? ""));
    expect(risky.length).toBeGreaterThan(0); // the catalogue does contain such prose
    for (const r of risky) expect(r.annotations.remediation).not.toContain("\n");
  });

  test("the header says it is generated and must not be hand-edited", () => {
    const head = renderAlertsYaml(buildAlertRules()).split("\n").slice(0, 4).join(" ");
    expect(head.toLowerCase()).toContain("generated");
    expect(head.toLowerCase()).toMatch(/do not hand-edit|regenerate/);
  });
});
