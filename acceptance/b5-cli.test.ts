// Acceptance - alert pack Tasks 5/6: the pack is reachable from the CLI with no
// credential, and the generated Prometheus stack actually loads it.
// Contract only. Do not edit to make the implementation pass.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "index.ts");

function run(args: string[], env: Record<string, string> = {}) {
  const p = Bun.spawnSync(["bun", "run", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  return {
    code: p.exitCode,
    out: p.stdout.toString(),
    err: p.stderr.toString(),
  };
}

describe("alerts-init needs no credential", () => {
  test("it writes alerts.yml with an empty environment", () => {
    const dir = mkdtempSync(join(tmpdir(), "sbperf-alerts-"));
    const r = run(["alerts-init", "--dir", dir], {
      SUPABASE_ACCESS_TOKEN: "",
      SBPERF_LOG_LEVEL: "error",
    });
    expect(r.code, `${r.out}\n${r.err}`).toBe(0);
    const yaml = readFileSync(join(dir, "alerts.yml"), "utf8");
    expect(yaml).toContain("groups:");
    expect(yaml).toContain("- alert: Supabase");
  });

  test("--ref scopes the expressions to one project", () => {
    const dir = mkdtempSync(join(tmpdir(), "sbperf-alerts-"));
    const r = run(["alerts-init", "--ref", "examplerefaaaaaaaaaa", "--dir", dir], {
      SUPABASE_ACCESS_TOKEN: "",
      SBPERF_LOG_LEVEL: "error",
    });
    expect(r.code, `${r.out}\n${r.err}`).toBe(0);
    expect(readFileSync(join(dir, "alerts.yml"), "utf8")).toContain("examplerefaaaaaaaaaa");
  });

  test("the usage text lists the subcommand", () => {
    const r = run([]);
    expect(`${r.out}${r.err}`).toContain("alerts-init");
  });
});

describe("the generated Prometheus stack loads the pack", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("prometheus.yml declares rule_files and compose mounts alerts.yml", async () => {
    const { writeScraper } = await import("../src/scraper.ts");
    // writeScraper resolves the project's service_role key over the Management
    // API; stub it so the pack assertions need no credential and no network.
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify([{ name: "service_role", api_key: "srk_test" }]), {
          headers: { "content-type": "application/json" },
        }),
      )) as unknown as typeof fetch;
    const dir = mkdtempSync(join(tmpdir(), "sbperf-scraper-"));
    await writeScraper("examplerefaaaaaaaaaa", { accessToken: "sbp_x", tokenSource: "env" }, dir);
    const prom = readFileSync(join(dir, "prometheus.yml"), "utf8");
    expect(prom).toContain("rule_files:");
    expect(prom).toContain("alerts.yml");
    const compose = readFileSync(join(dir, "compose.yml"), "utf8");
    expect(compose).toContain("alerts.yml");
    expect(readFileSync(join(dir, "alerts.yml"), "utf8")).toContain("- alert: Supabase");
  });
});
