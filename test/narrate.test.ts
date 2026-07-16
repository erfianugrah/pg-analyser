import { describe, expect, test } from "bun:test";
import {
  buildMessages,
  buildNarrativeInput,
  clientFromEnv,
  type LlmClient,
  type LlmMessage,
  narrate,
  OpenAiCompatClient,
} from "../src/narrate.ts";
import type { Analysis } from "../src/schemas.ts";

function base(): Analysis {
  return {
    meta: {
      ref: "r",
      name: "demo",
      region: "eu",
      status: "ACTIVE_HEALTHY",
      pgVersion: "17",
      createdAt: "x",
      collectedAt: "x",
      sbperfVersion: "t",
      sqlSource: "read-only",
      logProbe: null,
    },
    health: [],
    disk: null,
    pgConfig: null,
    pooler: null,
    backups: null,
    upgrade: null,
    functions: [],
    functionStats: [],
    buckets: [],
    security: null,
    advisors: { performance: [], security: [] },
    apiCounts: [],
    sql: {
      dbSize: "1 GB",
      cacheHitPct: 92,
      indexHitPct: null,
      cacheBlocksAccessed: null,
      statementsDealloc: null,
      tableStatsResetAge: null,
      statsResetAge: null,
      pgSettings: [],
      topStatements: Array.from({ length: 20 }, (_, i) => ({
        query: `select * from t${i} where a=$1`,
        pct: 30 - i,
        calls: 100,
        mean_ms: 5,
      })),
      topByCalls: [],
      queryIoStats: [],
      biggestTables: [{ schema: "public", table: "public.big", total_size: "500 MB" }],
      indexStats: [{ schema: "public", table: "public.x", index: "public.i", unused: true }],
      duplicateIndexes: [{ schema: "public", table: "public.x", indexes: "i1, i2", copies: 2 }],
      rlsUnindexed: [{ schema: "public", table: "public.docs", column: "owner_id" }],
      seqScanHeavy: [],
      bloat: [],
      trafficProfile: [],
      tableIoStats: [],
      deadTuples: [],
      txidWraparound: [],
      multixactWraparound: [],
      neverVacuumed: [],
      fkUnindexed: [],
      invalidIndexes: [],
      topByWal: [],
      visibilityMap: [],
      publicSchemaCreate: [],
      replicationSlots: [],
      rlsPolicies: [],
      connections: [{ state: "active", connections: 3 }],
      roleStats: [],
      roleConfig: [],
      longRunning: [],
      locks: [],
      blocking: [],
      storageUsage: [],
      extensions: [],
      unindexedVectors: [],
      sequenceExhaustion: [],
      walArchiving: [],
      hbaRules: [],
      authAudit: [],
      authMfa: [],
      cronJobs: [],
      waitSamples: [],
      lockWave: null,
      dbSizeBytes: null,
      bloatExact: [],
      indexAdvisor: [],
      unloggedTables: [],
      checksumFailures: [],
      walDirSize: [],
      amcheckIndex: [],
      amcheckHeap: [],
    },
    metrics: { available: false, samples: [] },
    trends: [{ title: "CPU utilization (%)", unit: "%", points: [{ t: 1, v: 42 }] }],
    contentionEpisodes: [],
    sync: null,
    narrative: null,
    errors: [],
  };
}

describe("buildNarrativeInput", () => {
  test("includes findings with remediation + doc, and bounds the evidence", () => {
    const input = buildNarrativeInput(base());
    expect(Array.isArray(input.findings)).toBe(true);
    const cache = input.findings.find((f) => f.title.includes("Cache hit ratio 92%"));
    expect(cache?.remediation).toBeTruthy();
    expect(cache?.doc).toContain("http");
    // outliers capped at 8 even though 20 were provided
    expect(input.evidence.queryOutliers).toHaveLength(8);
    expect(input.evidence.duplicateIndexes).toBe(1);
    expect(input.evidence.rlsUnindexedColumns).toEqual(["public.docs.owner_id"]);
    // enriched trend shape so the model reasons over the trajectory, not just latest
    expect(input.trends[0]).toMatchObject({
      title: "CPU utilization (%)",
      latest: 42,
      mean: 42,
      sufficient: false, // single point -> not trustworthy for trend claims
    });
    expect(input.trends[0]).toHaveProperty("direction");
    expect(input.trends[0]).toHaveProperty("perDay");
  });

  test("digest surfaces the new per-query I/O, auth, and cron signals", () => {
    const a = base();
    a.sql.queryIoStats = [
      {
        query: "select big()",
        calls: 200,
        mean_ms: 40,
        cv: 3,
        temp_written: "120 MB",
        miss_pct: 40,
      },
      { query: "noise", calls: 5, mean_ms: 1, cv: 0, temp_blks_written: 0, shared_blks_read: 0 },
    ];
    a.sql.authAudit = [{ total_users: 100, confirmed_users: 90, active_30d: 40 }];
    a.sql.authMfa = [{ mfa_users: 12 }];
    a.sql.cronJobs = [{ jobname: "etl", failed_runs: 2, runs_7d: 7 }];
    const input = buildNarrativeInput(a);
    // only the signal-carrying io row is passed (the noise row is filtered)
    expect(input.evidence.queryIoOutliers).toHaveLength(1);
    expect(input.evidence.queryIoOutliers[0]?.temp_written).toBe("120 MB");
    // auth adoption merges the separate MFA query
    expect(input.evidence.authAdoption).toMatchObject({ total_users: 100, mfa_users: 12 });
    expect(input.evidence.scheduledJobs).toHaveLength(1);
  });

  test("digest names unused indexes (app-scoped) and surfaces dead-tuple + write-profile signals", () => {
    const a = base();
    a.sql.indexStats = [
      { schema: "auth", table: "auth.users", index: "auth.i1", unused: true }, // managed -> dropped
      {
        schema: "app1",
        table: "app1.matches",
        index: "app1.pg_x_idx",
        index_size: "192 kB",
        scans: 0,
        unused: true,
      },
      { schema: "public", table: "public.y", index: "public.y_pkey", scans: 500, unused: false },
    ];
    a.sql.deadTuples = [
      // managed schema with the MOST dead rows - must not sort to the top (excluded)
      {
        schema: "auth",
        table: "auth.refresh_tokens",
        dead_rows: 99999,
        live_rows: 1,
        overdue: "yes",
      },
      { schema: "app1", table: "app1.small", dead_rows: 10, live_rows: 100, overdue: "no" },
      { schema: "app1", table: "app1.hot", dead_rows: 9000, live_rows: 1000, overdue: "yes" },
    ];
    a.sql.trafficProfile = [
      { table: "app1.hot", profile: "567.4:1 write-heavy", write_tuples: 8298, blocks_read: 2 },
      {
        table: "storage.objects",
        profile: "900:1 write-heavy",
        write_tuples: 99999,
        blocks_read: 1,
      },
    ];
    a.sql.extensions = [
      { name: "pg_stat_statements", installed: "1.11", latest: "1.11", outdated: false },
      { name: "pgcrypto", installed: "1.2", latest: "1.3", outdated: true },
    ];
    a.sql.tableIoStats = [
      {
        schema: "app1",
        table: "app1.embeddings",
        heap_blks_read: 200,
        heap_hit_pct: 99.1,
        toast_blks_read: 500000,
        toast_hit_pct: 12.3,
      },
    ];
    const input = buildNarrativeInput(a);
    // named unused index, auth-managed one excluded
    expect(input.evidence.unusedIndexes).toBe(1);
    expect(input.evidence.unusedIndexesTop).toHaveLength(1);
    expect(input.evidence.unusedIndexesTop[0]?.index).toBe("app1.pg_x_idx");
    // dead tuples: managed auth row excluded; overdue app1 row sorted first
    expect(input.evidence.deadTuples.map((r) => r.table)).not.toContain("auth.refresh_tokens");
    expect(input.evidence.deadTuples[0]?.table).toBe("app1.hot");
    expect(input.evidence.deadTuples[0]?.overdue).toBe("yes");
    // write-profile: managed storage row excluded, app row surfaced
    expect(input.evidence.writeHeavyTables.map((r) => r.table)).not.toContain("storage.objects");
    expect(input.evidence.writeHeavyTables[0]?.table).toBe("app1.hot");
    expect(input.evidence.extensionsOutdated).toEqual([
      { name: "pgcrypto", installed: "1.2", latest: "1.3" },
    ]);
    // per-table I/O surfaces the de-toasting signal (low toast hit% + high reads)
    expect(input.evidence.tableIo[0]?.table).toBe("app1.embeddings");
    expect(input.evidence.tableIo[0]?.toast_hit_pct).toBe(12.3);
    expect(input.evidence.tableIo[0]?.toast_blks_read).toBe(500000);
  });

  test("flags degraded collection so the model can caveat", () => {
    const a = base();
    a.meta.status = "INACTIVE";
    expect(buildNarrativeInput(a).degraded).toBe(true);
  });

  test("no-PAT mode: unknown status is NOT degraded; managementApi flagged", () => {
    const a = base();
    a.meta.managementApi = false;
    a.meta.status = "unknown";
    const input = buildNarrativeInput(a);
    expect(input.degraded).toBe(false); // unknown status in no-PAT != degraded
    expect(input.project.managementApi).toBe(false);
  });
});

describe("buildMessages", () => {
  test("system rule + user payload with the JSON embedded", () => {
    const msgs = buildMessages(base());
    expect(msgs[0]?.role).toBe("system");
    expect(msgs[0]?.content).toContain("Do NOT invent");
    expect(msgs[1]?.role).toBe("user");
    expect(msgs[1]?.content).toContain("```json");
    expect(msgs[1]?.content).toContain("demo");
  });
});

describe("narrate", () => {
  test("prepends a provenance header and returns the model text", async () => {
    const fake: LlmClient = {
      model: "fake-1",
      complete: async (_m: LlmMessage[]) => "## Executive summary\nAll good.",
    };
    const out = await narrate(base(), fake);
    expect(out).toContain("generated by sbperf narrate (fake-1)");
    expect(out).toContain("## Executive summary");
  });

  test("throws on an empty completion", async () => {
    const fake: LlmClient = { model: "x", complete: async () => "   " };
    await expect(narrate(base(), fake)).rejects.toThrow(/empty/);
  });
});

describe("OpenAiCompatClient", () => {
  test("posts chat/completions with auth + model and parses the content", async () => {
    let seenUrl = "";
    let seenBodyRaw = "";
    let seenAuth = "";
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seenUrl = url;
      seenBodyRaw = init.body as string;
      seenAuth = (init.headers as Record<string, string>).authorization ?? "";
      return new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const c = new OpenAiCompatClient("https://api.example.com/v1/", "m1", "sk-x", fetchImpl);
    const out = await c.complete([{ role: "user", content: "q" }]);
    expect(out).toBe("hi");
    expect(seenUrl).toBe("https://api.example.com/v1/chat/completions");
    expect(JSON.parse(seenBodyRaw).model).toBe("m1");
    expect(seenAuth).toBe("Bearer sk-x");
  });

  test("throws on non-2xx", async () => {
    const fetchImpl = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const c = new OpenAiCompatClient("http://x/v1", "m", undefined, fetchImpl);
    await expect(c.complete([])).rejects.toThrow(/500/);
  });
});

describe("clientFromEnv", () => {
  test("errors clearly when unconfigured", () => {
    const r = clientFromEnv({});
    expect("error" in r && r.error).toContain("SBPERF_LLM_BASE_URL");
  });
  test("builds a client when base url + model are set", () => {
    const r = clientFromEnv({ SBPERF_LLM_BASE_URL: "http://x/v1", SBPERF_LLM_MODEL: "m" });
    expect("client" in r && r.client.model).toBe("m");
  });
});
