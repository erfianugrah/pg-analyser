import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeScraper } from "../src/scraper.ts";
import { jsonResponse } from "./helpers.ts";

const dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "sbperf-scraper-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("writeScraper", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("emits a full stack embedding service_role as basic_auth", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        jsonResponse([
          { name: "anon", api_key: "anon_k" },
          { name: "service_role", api_key: "srk_secret" },
        ]),
      )) as unknown as typeof fetch;

    const dir = await tmp();
    await writeScraper("myref", { accessToken: "sbp_x", tokenSource: "env" }, dir);

    const prom = await readFile(join(dir, "prometheus.yml"), "utf8");
    expect(prom).toContain("metrics_path: /customer/v1/privileged/metrics");
    expect(prom).toContain("username: service_role");
    expect(prom).toContain("password: srk_secret");
    expect(prom).toContain("targets: ['myref.supabase.co']");

    expect(existsSync(join(dir, "compose.yml"))).toBe(true);
    expect(existsSync(join(dir, "grafana/provisioning/datasources/prometheus.yml"))).toBe(true);
    const dash = JSON.parse(await readFile(join(dir, "grafana/dashboards/supabase.json"), "utf8"));
    expect(dash.panels.length).toBeGreaterThan(0);
    // Clean-room dashboard: scoped to a `project` template var over the NATIVE
    // supabase_project_ref label the metrics endpoint emits itself, so it renders
    // against any Prometheus scraping the endpoint with no relabelling.
    const projectVar = dash.templating.list.find((v: { name: string }) => v.name === "project");
    expect(projectVar.definition).toBe("label_values(node_load1, supabase_project_ref)");
    expect(JSON.stringify(dash.panels)).toContain('supabase_project_ref=\\"$project\\"');
    // datasource uid pinned so provisioned panels resolve deterministically
    const dsYml = await readFile(
      join(dir, "grafana/provisioning/datasources/prometheus.yml"),
      "utf8",
    );
    expect(dsYml).toContain("uid: prometheus");

    // named volumes, not host bind mounts (the uid-mismatch crash fix)
    expect(await readFile(join(dir, "compose.yml"), "utf8")).toContain("prometheus-data:");
    // credentials must not be committed
    expect(await readFile(join(dir, ".gitignore"), "utf8")).toContain("prometheus.yml");
  });
});
