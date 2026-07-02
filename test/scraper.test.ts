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

describe("writeScraper (gatekeeper mode - no network)", () => {
  test("emits a full stack pointed at the gatekeeper metrics path", async () => {
    const dir = await tmp();
    await writeScraper(
      "myref",
      { kind: "gatekeeper", baseUrl: "https://gate.example.com", key: "gk_x" },
      dir,
    );

    const prom = await readFile(join(dir, "prometheus.yml"), "utf8");
    expect(prom).toContain("metrics_path: /supabase/metrics/myref");
    expect(prom).toContain("credentials: gk_x");
    expect(prom).toContain("targets: ['gate.example.com']");

    expect(existsSync(join(dir, "compose.yml"))).toBe(true);
    expect(existsSync(join(dir, "grafana/provisioning/datasources/prometheus.yml"))).toBe(true);

    const dash = JSON.parse(await readFile(join(dir, "grafana/dashboards/supabase.json"), "utf8"));
    expect(Array.isArray(dash.panels)).toBe(true);
    expect(dash.panels.length).toBeGreaterThan(0);

    // credentials must not be committed
    expect(await readFile(join(dir, ".gitignore"), "utf8")).toContain("prometheus.yml");
  });
});

describe("writeScraper (direct mode - fetches service_role)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("embeds service_role as basic_auth", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        jsonResponse([
          { name: "anon", api_key: "anon_k" },
          { name: "service_role", api_key: "srk_secret" },
        ]),
      )) as unknown as typeof fetch;

    const dir = await tmp();
    await writeScraper("myref", { kind: "direct", accessToken: "sbp_x" }, dir);

    const prom = await readFile(join(dir, "prometheus.yml"), "utf8");
    expect(prom).toContain("metrics_path: /customer/v1/privileged/metrics");
    expect(prom).toContain("username: service_role");
    expect(prom).toContain("password: srk_secret");
    expect(prom).toContain("targets: ['myref.supabase.co']");
  });
});
