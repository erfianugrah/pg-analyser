import { describe, expect, test } from "bun:test";
import { collect } from "../src/collect.ts";
import advisorsPerf from "./fixtures/api/advisors-performance.json";
import apiCounts from "./fixtures/api/api-counts.json";
import backupsUnused from "./fixtures/api/disk.json"; // reused only for shape presence
import disk from "./fixtures/api/disk.json";
import diskUtil from "./fixtures/api/disk-util.json";
import health from "./fixtures/api/health.json";
import pooler from "./fixtures/api/pooler.json";
import project from "./fixtures/api/project.json";
import upgrade from "./fixtures/api/upgrade.json";
import { fakeTransport, jsonResponse, textResponse } from "./helpers.ts";

const METRICS = `node_load1{service_type="db"} 0.5
pg_stat_database_num_backends{server="localhost:5432"} 4
go_goroutines 42
node_memory_Dirty_bytes 1024
`;

function fullRoutes(overrides: Record<string, () => Response> = {}) {
  return (path: string, init?: RequestInit): Response => {
    const clean = path.split("?")[0]!;
    if (overrides[clean]) return overrides[clean]!();
    if (clean.endsWith("/health")) return jsonResponse(health);
    if (clean.endsWith("/config/disk")) return jsonResponse(disk);
    if (clean.endsWith("/config/disk/util")) return jsonResponse(diskUtil);
    if (clean.endsWith("/config/database/postgres")) return jsonResponse({});
    if (clean.endsWith("/config/database/pooler")) return jsonResponse(pooler);
    if (clean.endsWith("/database/backups"))
      return jsonResponse({ pitr_enabled: false, walg_enabled: true, backups: [] });
    if (clean.endsWith("/upgrade/eligibility")) return jsonResponse(upgrade);
    if (clean.endsWith("/functions")) return jsonResponse([]);
    if (clean.endsWith("/storage/buckets")) return jsonResponse([]);
    if (clean.endsWith("/advisors/performance")) return jsonResponse(advisorsPerf);
    if (clean.endsWith("/advisors/security")) return jsonResponse({ lints: [] });
    if (clean.includes("usage.api-counts")) return jsonResponse(apiCounts);
    if (clean.endsWith("/database/query/read-only")) {
      const q = String(JSON.parse((init?.body as string) ?? "{}").query ?? "");
      if (q.includes("cache_hit_pct")) return jsonResponse([{ cache_hit_pct: "99.50" }]);
      if (q.includes("pg_database_size")) return jsonResponse([{ db_size: "20 MB" }]);
      return jsonResponse([]);
    }
    if (clean === "/v1/projects/ref") return jsonResponse(project);
    return textResponse("not found", 404);
  };
}

const okMetrics = () => textResponse(METRICS);

describe("collect", () => {
  test("composes a full validated Analysis", async () => {
    const t = fakeTransport({ onMgmt: fullRoutes(), onMetrics: okMetrics });
    const a = await collect("ref", t, "0.0.0-test");

    expect(a.meta.name).toBe("example-project");
    expect(a.advisors.performance).toHaveLength(2);
    expect(a.advisors.security).toHaveLength(0);
    expect(a.sql.cacheHitPct).toBe(99.5);
    expect(a.sql.dbSize).toBe("20 MB");
    expect(a.disk?.iops).toBe(3000);
    expect(a.metrics.available).toBe(true);
    // Full corpus captured - even non-allowlisted families (go runtime, the
    // long-tail node_memory_* fields) are stored, not just the display slice.
    const names = new Set(a.metrics.samples.map((s) => s.name));
    expect(names.has("go_goroutines")).toBe(true);
    expect(names.has("node_memory_Dirty_bytes")).toBe(true);
    expect(a.metrics.samples).toHaveLength(4);
    expect(a.errors).toHaveLength(0);
    expect(backupsUnused).toBeDefined();
  });

  test("captures per-source failures without throwing", async () => {
    const t = fakeTransport({
      onMgmt: fullRoutes({ "/v1/projects/ref/config/disk": () => textResponse("boom", 500) }),
      onMetrics: okMetrics,
    });
    const a = await collect("ref", t, "0.0.0-test");
    expect(a.disk).toBeNull();
    expect(a.errors.map((e) => e.source)).toContain("disk");
    expect(a.meta.name).toBe("example-project"); // still produced
  });

  test("marks metrics unavailable when the endpoint 404s", async () => {
    const t = fakeTransport({ onMgmt: fullRoutes() }); // no onMetrics -> 404
    const a = await collect("ref", t, "0.0.0-test");
    expect(a.metrics.available).toBe(false);
    expect(a.metrics.samples).toHaveLength(0);
  });

  test("throws when the required project endpoint fails", async () => {
    const t = fakeTransport({
      onMgmt: fullRoutes({ "/v1/projects/ref": () => textResponse("nope", 403) }),
    });
    await expect(collect("ref", t, "0.0.0-test")).rejects.toThrow(/cannot read project/);
  });
});
