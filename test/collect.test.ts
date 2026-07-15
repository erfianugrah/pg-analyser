import { describe, expect, test } from "bun:test";
import { collect } from "../src/collect.ts";
import { makeLogger } from "../src/log.ts";
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
    if (clean.endsWith("/config/disk/autoscale"))
      return jsonResponse({ growth_percent: 50, min_increment_gb: 4, max_size_gb: 200 });
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
    if (clean === "/v1/organizations")
      return jsonResponse([
        { id: "exampleorgbbbbbbbbbb", name: "Example Org", slug: "example-org" },
      ]);
    if (clean.endsWith("/entitlements"))
      return jsonResponse({
        entitlements: [{ feature: { key: "instances.disk_modifications" }, hasAccess: true }],
      });
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

  test("an INACTIVE project short-circuits DB-dependent planes with one note", async () => {
    const inactive = { ...project, status: "INACTIVE" };
    const t = fakeTransport({
      onMgmt: fullRoutes({ "/v1/projects/ref": () => jsonResponse(inactive) }),
      onMetrics: okMetrics,
    });
    const a = await collect("ref", t, "0.0.0-test", { syncCheck: false });

    // ONE summary note, not a per-plane warn for each of the ~19 SQL queries.
    const dbNotes = a.errors.filter((e) => e.source === "database");
    expect(dbNotes).toHaveLength(1);
    expect(dbNotes[0]?.message).toContain("INACTIVE");
    // No SQL plane failures were recorded (the queries were never attempted).
    expect(a.errors.some((e) => e.source.startsWith("sql:"))).toBe(false);

    // The read-only SQL endpoint and the metrics scrape were never hit.
    expect(t.calls.mgmt.some((p) => p.includes("query/read-only"))).toBe(false);
    expect(t.calls.metrics).toHaveLength(0);
    expect(a.metrics.available).toBe(false);

    // DB/service-dependent Management planes were skipped too...
    for (const seg of [
      "/health",
      "/config/disk/util",
      "/upgrade/eligibility",
      "/ssl-enforcement",
      "/storage/buckets",
    ]) {
      expect(t.calls.mgmt.some((p) => p.split("?")[0]!.endsWith(seg))).toBe(false);
    }
    // ...but static platform-metadata planes still ran (project meta + advisors).
    expect(a.meta.name).toBe("example-project");
    expect(a.meta.status).toBe("INACTIVE");
    expect(a.advisors.performance).toHaveLength(2);
    expect(t.calls.mgmt.some((p) => p.endsWith("/config/database/pooler"))).toBe(true);
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

  test("a recovering backend (EAUTHQUERY) short-circuits to ONE note, not a warn per plane", async () => {
    const seen: string[] = [];
    const runner = {
      source: "superuser" as const,
      // Every connection - including the `select 1` preflight - fails the way
      // Supavisor reports an offline tenant backend mid-recovery.
      run: async (q: string) => {
        seen.push(q);
        throw new Error(
          "(EAUTHQUERY) authentication query failed: connection to database not available",
        );
      },
    };
    const t = fakeTransport({ onMgmt: fullRoutes(), onMetrics: okMetrics });
    const a = await collect("ref", t, "0.0.0-test", { syncCheck: false, sqlRunner: runner });
    // Only the preflight probe ran; the ~40 diagnostic planes were skipped.
    expect(seen).toEqual(["select 1"]);
    // Exactly ONE database note, and no per-plane sql:* failure notes.
    const dbNotes = a.errors.filter((e) => e.source === "database");
    expect(dbNotes.length).toBe(1);
    expect(dbNotes[0]?.message).toMatch(/not accepting connections/i);
    expect(a.errors.some((e) => e.source.startsWith("sql:"))).toBe(false);
    // splinter advisors were skipped too (no runMulti call fan-out on a dead DB).
    expect(a.errors.some((e) => e.source === "advisors:splinter")).toBe(false);
  });

  test("a non-recovery SQL error is NOT masked - planes still surface it individually", async () => {
    const runner = {
      source: "superuser" as const,
      run: async () => {
        // e.g. bad password - a real misconfiguration the user must see per-plane.
        throw new Error('password authentication failed for user "supabase_admin"');
      },
    };
    const t = fakeTransport({ onMgmt: fullRoutes(), onMetrics: okMetrics });
    const a = await collect("ref", t, "0.0.0-test", { syncCheck: false, sqlRunner: runner });
    // The preflight did NOT short-circuit; the planes ran and failed loudly.
    expect(a.errors.some((e) => e.source.startsWith("sql:"))).toBe(true);
    // No spurious "not accepting connections" database note.
    expect(a.errors.some((e) => e.source === "database")).toBe(false);
  });

  test("a missing optional relation is NOT a collection note (debug 'plane absent', not warn)", async () => {
    const lines: string[] = [];
    const logger = makeLogger({ level: "debug", json: true, sink: (l) => lines.push(l) });
    const runner = {
      source: "superuser" as const,
      run: async (q: string) => {
        if (q.includes("storage.buckets"))
          throw new Error('relation "storage.buckets" does not exist');
        return [];
      },
    };
    const t = fakeTransport({ onMgmt: fullRoutes(), onMetrics: okMetrics });
    const a = await collect("ref", t, "0.0.0-test", {
      syncCheck: false,
      sqlRunner: runner,
      logger,
    });
    // An absent OPTIONAL relation is not a failure, so it does NOT become a
    // collection note (which would read like something went wrong)...
    expect(a.errors.some((e) => e.source === "sql:bucketList")).toBe(false);
    // ...it is only a debug "plane absent", never a warn "plane failed".
    const notes = lines.map((l) => JSON.parse(l)).filter((o) => o.source === "sql:bucketList");
    expect(notes.find((o) => o.msg === "plane failed")).toBeUndefined();
    expect(notes.find((o) => o.msg === "plane absent")?.level).toBe("debug");
  });

  test("an expired/missing Grafana session is a soft 'trends skipped', NOT a warn 'plane failed'", async () => {
    const realFetch = globalThis.fetch;
    // A datasource behind SSO 302-redirects an unauthenticated range query to
    // the IdP; fetchTrends surfaces it as "session cookie/token is missing or
    // expired". This must degrade like the region-has-no-Grafana skip.
    globalThis.fetch = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://accounts.google.com/o/oauth2/v2/auth" },
      })) as unknown as typeof fetch;
    try {
      const lines: string[] = [];
      const logger = makeLogger({ level: "debug", json: true, sink: (l) => lines.push(l) });
      const t = fakeTransport({ onMgmt: fullRoutes(), onMetrics: okMetrics });
      const a = await collect("ref", t, "0.0.0-test", {
        syncCheck: false,
        logger,
        prometheusUrl: "https://grafana.example/api/datasources/proxy/uid/x",
        prometheusCookie: "grafana_session=stale",
      });
      // The run still completes with empty trends, not a thrown error.
      expect(a.trends).toEqual([]);
      // Recorded as a collection note worded as a skip (so the report shows it)...
      const note = a.errors.find((e) => e.source === "trends");
      expect(note?.message).toContain("trends skipped");
      // ...but logged at INFO "trends skipped", never WARN "plane failed".
      const events = lines.map((l) => JSON.parse(l)).filter((o) => o.source === "trends");
      expect(events.find((o) => o.msg === "plane failed")).toBeUndefined();
      expect(events.find((o) => o.msg === "trends skipped")?.level).toBe("info");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("cronJobs is gated on the pg_cron extension - never fired (nor noted) when absent", async () => {
    let cronQueried = false;
    const runner = {
      source: "superuser" as const,
      run: async (q: string) => {
        if (q.includes("cron.job")) {
          cronQueried = true;
          throw new Error('relation "cron.job" does not exist');
        }
        return []; // extensions query returns [] -> pg_cron not installed
      },
    };
    const t = fakeTransport({ onMgmt: fullRoutes(), onMetrics: okMetrics });
    const a = await collect("ref", t, "0.0.0-test", { syncCheck: false, sqlRunner: runner });
    expect(cronQueried).toBe(false); // detected via the inventory, not fire-and-catch
    expect(a.errors.some((e) => e.source === "sql:cronJobs")).toBe(false);
    expect(a.sql.cronJobs).toEqual([]);
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

describe("amcheck integrity gating (opt-in, superuser + extension only)", () => {
  // A superuser runner that: reports amcheck installed/absent via the extensions
  // query, lists one btree target, and THROWS on bt_index_check for a corrupt
  // index (amcheck raises rather than returning rows).
  function amcheckRunner(opts: { installed: boolean; corruptOids?: string[] }) {
    return {
      source: "superuser" as const,
      run: async (q: string) => {
        if (/from pg_extension\b/.test(q))
          return opts.installed ? [{ name: "amcheck", installed: "1.3", latest: "1.3" }] : [];
        if (q.includes("amname = 'btree'")) return [{ oid: "16385", index: "public.idx_a" }];
        if (q.includes("bt_index_check")) {
          const oid = q.match(/bt_index_check\((\d+)/)?.[1];
          if (opts.corruptOids?.includes(oid ?? "")) throw new Error("index tuple out of order");
          return [];
        }
        if (q.includes("verify_heapam")) return [{ table: "public.t", blkno: 3, msg: "bad tuple" }];
        return [];
      },
    };
  }
  const t = () => fakeTransport({ onMgmt: fullRoutes(), onMetrics: okMetrics });

  test("not requested -> amcheck never runs (no note, empty results)", async () => {
    const a = await collect("ref", t(), "0.0.0-test", {
      syncCheck: false,
      sqlRunner: amcheckRunner({ installed: true }),
    });
    expect(a.errors.some((e) => e.source === "amcheck")).toBe(false);
    expect(a.sql.amcheckIndex).toHaveLength(0);
  });

  test("requested but extension not installed -> clean note, no crash", async () => {
    const a = await collect("ref", t(), "0.0.0-test", {
      syncCheck: false,
      amcheck: true,
      sqlRunner: amcheckRunner({ installed: false }),
    });
    const note = a.errors.find((e) => e.source === "amcheck");
    expect(note?.message).toContain("supabase_admin");
    expect(a.sql.amcheckIndex).toHaveLength(0);
  });

  test("requested + installed + clean index -> runs, no corruption findings", async () => {
    const a = await collect("ref", t(), "0.0.0-test", {
      syncCheck: false,
      amcheck: true,
      sqlRunner: amcheckRunner({ installed: true }),
    });
    expect(a.errors.some((e) => e.source === "amcheck")).toBe(false);
    expect(a.sql.amcheckIndex).toHaveLength(0);
  });

  test("requested + installed + corrupt index -> corruption hit captured", async () => {
    const a = await collect("ref", t(), "0.0.0-test", {
      syncCheck: false,
      amcheck: true,
      sqlRunner: amcheckRunner({ installed: true, corruptOids: ["16385"] }),
    });
    expect(a.sql.amcheckIndex).toHaveLength(1);
    expect(String(a.sql.amcheckIndex[0]?.index)).toBe("public.idx_a");
    expect(String(a.sql.amcheckIndex[0]?.message)).toContain("out of order");
  });

  test("heap check only runs under --amcheck=heap", async () => {
    const idxOnly = await collect("ref", t(), "0.0.0-test", {
      syncCheck: false,
      amcheck: true,
      sqlRunner: amcheckRunner({ installed: true }),
    });
    expect(idxOnly.sql.amcheckHeap).toHaveLength(0);
    const withHeap = await collect("ref", t(), "0.0.0-test", {
      syncCheck: false,
      amcheck: "heap",
      sqlRunner: amcheckRunner({ installed: true }),
    });
    expect(withHeap.sql.amcheckHeap.length).toBeGreaterThan(0);
  });

  test("read-only tier ignores --amcheck entirely (superuser-only)", async () => {
    const readonly = {
      source: "read-only" as const,
      run: async (q: string) =>
        /from pg_extension\b/.test(q) ? [{ name: "amcheck", installed: "1.3" }] : [],
    };
    const a = await collect("ref", t(), "0.0.0-test", {
      syncCheck: false,
      amcheck: true,
      sqlRunner: readonly,
    });
    expect(a.errors.some((e) => e.source === "amcheck")).toBe(false);
    expect(a.sql.amcheckIndex).toHaveLength(0);
  });
});
