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
    if (clean.endsWith("/config/auth")) return jsonResponse({ jwt_exp: 3600 });
    if (clean.endsWith("/network-restrictions"))
      return jsonResponse({ config: { dbAllowedCidrs: ["10.0.0.0/8"] } });
    if (clean.endsWith("/ssl-enforcement"))
      return jsonResponse({ currentConfig: { database: true }, appliedSuccessfully: true });
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
    const a = await collect("ref", t, "0.0.0-test", { syncCheck: false });

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

  test("PAT mode: Management /storage/buckets wins over the SQL fallback", async () => {
    const t = fakeTransport({
      onMgmt: fullRoutes({
        "/v1/projects/ref/storage/buckets": () =>
          jsonResponse([{ id: "from-api", name: "from-api", public: false }]),
      }),
      onMetrics: okMetrics,
    });
    const a = await collect("ref", t, "0.0.0-test", { syncCheck: false });
    // Management value present -> SQL bucketList fallback is not consulted.
    expect(a.buckets).toEqual([{ id: "from-api", name: "from-api", public: false }]);
  });

  test("captures per-source failures without throwing", async () => {
    const t = fakeTransport({
      onMgmt: fullRoutes({ "/v1/projects/ref/config/disk": () => textResponse("boom", 500) }),
      onMetrics: okMetrics,
    });
    const a = await collect("ref", t, "0.0.0-test", { syncCheck: false });
    expect(a.disk).toBeNull();
    expect(a.errors.map((e) => e.source)).toContain("disk");
    expect(a.meta.name).toBe("example-project"); // still produced
  });

  test("marks metrics unavailable when the endpoint 404s", async () => {
    const t = fakeTransport({ onMgmt: fullRoutes() }); // no onMetrics -> 404
    const a = await collect("ref", t, "0.0.0-test", { syncCheck: false });
    expect(a.metrics.available).toBe(false);
    expect(a.metrics.samples).toHaveLength(0);
  });

  test("defaults sqlSource to read-only (PAT runner)", async () => {
    const t = fakeTransport({ onMgmt: fullRoutes(), onMetrics: okMetrics });
    const a = await collect("ref", t, "0.0.0-test", { syncCheck: false });
    expect(a.meta.sqlSource).toBe("read-only");
  });

  test("an injected SqlRunner runs the query set and sets sqlSource", async () => {
    const seen: string[] = [];
    const runner = {
      source: "superuser" as const,
      run: async (q: string) => {
        seen.push(q);
        return [];
      },
    };
    const t = fakeTransport({ onMgmt: fullRoutes(), onMetrics: okMetrics });
    const a = await collect("ref", t, "0.0.0-test", { syncCheck: false, sqlRunner: runner });
    expect(a.meta.sqlSource).toBe("superuser");
    // the diagnostic queries went through the injected runner, not the API
    expect(seen.some((q) => q.includes("pg_stat_statements"))).toBe(true);
    // and the read-only SQL endpoint was NOT hit
    expect(t.calls.mgmt.some((p) => p.includes("query/read-only"))).toBe(false);
  });

  test("threads --interval through to the analytics endpoints", async () => {
    const t = fakeTransport({ onMgmt: fullRoutes(), onMetrics: okMetrics });
    await collect("ref", t, "0.0.0-test", { syncCheck: false, interval: "3day" });
    const apiCall = t.calls.mgmt.find((p) => p.includes("usage.api-counts"));
    expect(apiCall).toContain("interval=3day");
  });

  test("defaults the analytics interval to 1day", async () => {
    const t = fakeTransport({ onMgmt: fullRoutes(), onMetrics: okMetrics });
    await collect("ref", t, "0.0.0-test", { syncCheck: false });
    const apiCall = t.calls.mgmt.find((p) => p.includes("usage.api-counts"));
    expect(apiCall).toContain("interval=1day");
  });

  test("throws when the required project endpoint fails", async () => {
    const t = fakeTransport({
      onMgmt: fullRoutes({ "/v1/projects/ref": () => textResponse("nope", 403) }),
    });
    await expect(collect("ref", t, "0.0.0-test", { syncCheck: false })).rejects.toThrow(
      /cannot read project/,
    );
  });

  describe("no-PAT mode (transport === null)", () => {
    const perfLint = {
      name: "unindexed_foreign_keys",
      title: "Unindexed FK",
      level: "INFO",
      categories: ["PERFORMANCE"],
    };
    const secLint = {
      name: "rls_disabled_in_public",
      title: "RLS disabled",
      level: "ERROR",
      categories: ["SECURITY"],
    };
    const superuserRunner = {
      source: "superuser" as const,
      run: async (q: string) => {
        if (q.includes("cache_hit_pct")) return [{ cache_hit_pct: "99.00" }];
        if (q.includes("pg_database_size")) return [{ db_size: "10 MB" }];
        if (q.includes("from storage.buckets"))
          return [{ id: "avatars", name: "avatars", public: true }];
        if (q.includes("from pg_stat_archiver"))
          return [{ archive_mode: "on", archived_count: 42, failed_count: 0 }];
        if (q.includes("from pg_settings"))
          return [
            { name: "max_connections", setting: "100", unit: null },
            { name: "work_mem", setting: "2048", unit: "kB" },
          ];
        return [];
      },
      // splinter: leading setup statements -> [], the lint SELECT is largest
      runMulti: async () => [[], [perfLint, secLint]] as never,
    };

    test("runs on a superuser runner alone: SQL + splinter advisors, no Management planes", async () => {
      const a = await collect("myref", null, "0.0.0-test", {
        syncCheck: false,
        sqlRunner: superuserRunner,
      });
      // meta derived without the Management API
      expect(a.meta.managementApi).toBe(false);
      expect(a.meta.name).toBe("myref");
      expect(a.meta.sqlSource).toBe("superuser");
      // Management-only planes absent (not errored per-plane; one summary note)
      expect(a.disk).toBeNull();
      expect(a.pooler).toBeNull();
      expect(a.metrics.available).toBe(false);
      expect(a.errors.map((e) => e.source)).toContain("management");
      expect(a.errors.some((e) => e.source === "disk")).toBe(false);
      // splinter fills BOTH advisor planes
      expect(a.advisors.performance.map((l) => l.name)).toEqual(["unindexed_foreign_keys"]);
      expect(a.advisors.security.map((l) => l.name)).toEqual(["rls_disabled_in_public"]);
      // SQL diagnostics still ran through the superuser runner
      expect(a.sql.dbSize).toBe("10 MB");
      expect(a.sql.cacheHitPct).toBe(99);
      // Tier-1 SQL fill-ins: buckets from storage.buckets, pgConfig from
      // pg_settings - planes the Management API only proxies, reachable over
      // the superuser connstring.
      expect(a.buckets).toEqual([{ id: "avatars", name: "avatars", public: true }]);
      expect(a.pgConfig).toEqual({ max_connections: "100", work_mem: "2048" });
      // WAL-archiving proxy row flows through to analysis.sql (PITR inference).
      expect(a.sql.walArchiving).toEqual([
        { archive_mode: "on", archived_count: 42, failed_count: 0 },
      ]);
    });

    test("throws when neither a PAT transport nor a SQL runner is available", async () => {
      await expect(collect("myref", null, "0.0.0-test", { syncCheck: false })).rejects.toThrow(
        /no PAT.*no superuser SQL runner|nothing to collect/,
      );
    });
  });
});
