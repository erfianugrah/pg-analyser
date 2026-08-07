/**
 * Empirical gate: validate the generated alert pack with Prometheus's own
 * `promtool`, which parses every PromQL expression - not just the YAML.
 *
 * yq (acceptance/b4) proves the document is well-formed; only promtool proves
 * the expressions are valid PromQL. A rule whose expression does not parse is
 * rejected by Prometheus at load time, i.e. the whole pack silently fails to
 * load, which is the worst outcome for an alerting artifact.
 *
 * Skips (exit 0) when promtool is absent, so it is safe in a bare environment;
 * set SBPERF_PROMTOOL to point at the binary.
 *   PATH lookup order: $SBPERF_PROMTOOL, promtool on PATH.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAlertRules, renderAlertsYaml } from "../src/alerts.ts";

function findPromtool(): string | null {
  const explicit = process.env.SBPERF_PROMTOOL;
  if (explicit) return explicit;
  const which = Bun.spawnSync(["sh", "-c", "command -v promtool"], { stdout: "pipe" });
  const p = which.stdout.toString().trim();
  return p || null;
}

const bin = findPromtool();
if (!bin) {
  console.log("live-promtool: promtool not found - skipping (set SBPERF_PROMTOOL to enable)");
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), "sbperf-promtool-"));
let failures = 0;

// Both the unscoped pack and a ref-scoped one: injecting a label matcher into
// every expression is exactly the step that can produce unparseable PromQL.
for (const [label, rules] of [
  ["unscoped", buildAlertRules()],
  ["ref-scoped", buildAlertRules({ refMatcher: 'supabase_project_ref="examplerefaaaaaaaaaa"' })],
] as const) {
  const file = join(dir, `${label}.yml`);
  writeFileSync(file, renderAlertsYaml(rules));
  const p = Bun.spawnSync([bin, "check", "rules", file], { stdout: "pipe", stderr: "pipe" });
  const out = `${p.stdout.toString()}${p.stderr.toString()}`.trim();
  if (p.exitCode !== 0) {
    failures++;
    console.error(`  ${label}: promtool REJECTED the pack\n${out}`);
    continue;
  }
  const found = /SUCCESS:\s+(\d+)\s+rules found/.exec(out);
  if (!found || Number(found[1]) !== rules.length) {
    failures++;
    console.error(
      `  ${label}: promtool loaded ${found?.[1] ?? "?"} rules, expected ${rules.length}`,
    );
    continue;
  }
  console.log(`  ${label}: promtool loaded all ${rules.length} rules`);
}

if (failures) {
  console.error("\nlive-promtool: the alert pack would not load into Prometheus");
  process.exit(1);
}
console.log("live-promtool: the pack parses as PromQL and loads clean");
