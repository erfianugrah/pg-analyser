import { describe, expect, test } from "bun:test";
import { deriveFindings } from "../src/findings.ts";
import { HEURISTICS, HEURISTICS_REVIEWED, meta, THRESHOLDS } from "../src/heuristics.ts";
import { LINT_FIXES } from "../src/lints.ts";
import type { Analysis } from "../src/schemas.ts";

describe("changelog URLs are curated + well-formed", () => {
  // changelogUrl is deliberately hardcoded (not LLM-picked) so it must never be
  // a fabricated/malformed link. Every one must be a real Supabase changelog
  // entry (numeric-id slug) or a GitHub release tag (the auto-derived PG one).
  const CHANGELOG = /^https:\/\/supabase\.com\/changelog\/\d+-[a-z0-9-]+$/;
  const GH_RELEASE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/releases\/tag\/.+$/;
  const urls = [
    ...Object.values(HEURISTICS).map((h) => h.changelogUrl),
    ...Object.values(LINT_FIXES).map((l) => l.changelogUrl),
  ].filter((u): u is string => typeof u === "string");

  test("at least the known curated set is present", () => {
    expect(urls.length).toBeGreaterThanOrEqual(5);
  });

  test("every changelogUrl matches the changelog or release shape", () => {
    for (const u of urls) {
      expect(CHANGELOG.test(u) || GH_RELEASE.test(u), `bad changelog URL: ${u}`).toBe(true);
    }
  });
});

function base(): Analysis {
  return {
    meta: {
      ref: "r",
      name: "n",
      region: "eu",
      status: "ACTIVE_HEALTHY",
      pgVersion: "17",
      createdAt: "x",
      collectedAt: "x",
      sbperfVersion: "t",
      sqlSource: "read-only",
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
      dbSize: null,
      cacheHitPct: null,
      indexHitPct: null,
      cacheBlocksAccessed: null,
      statsResetAge: null,
      pgSettings: [],
      topStatements: [],
      topByCalls: [],
      queryIoStats: [],
      biggestTables: [],
      indexStats: [],
      duplicateIndexes: [],
      rlsUnindexed: [],
      seqScanHeavy: [],
      bloat: [],
      trafficProfile: [],
      deadTuples: [],
      txidWraparound: [],
      replicationSlots: [],
      rlsPolicies: [],
      connections: [],
      roleStats: [],
      longRunning: [],
      locks: [],
      blocking: [],
      storageUsage: [],
      extensions: [],
      unindexedVectors: [],
      walArchiving: [],
      hbaRules: [],
      authAudit: [],
      authMfa: [],
      cronJobs: [],
      dbSizeBytes: null,
      bloatExact: [],
    },
    metrics: { available: false, samples: [] },
    trends: [],
    sync: null,
    narrative: null,
    errors: [],
  };
}

describe("meta()", () => {
  test("returns metadata for a known heuristic id", () => {
    const m = meta("rls_initplan");
    expect(m.heuristicId).toBe("rls_initplan");
    expect(m.remediation).toContain("subselect");
    expect(m.docUrl).toStartWith("https://");
  });

  test("returns an empty object for an unknown id (safe spread)", () => {
    expect(meta("does_not_exist")).toEqual({});
  });
});

describe("HEURISTICS registry integrity", () => {
  test("every entry has id/plane/remediation/docUrl and a review vintage", () => {
    for (const [key, h] of Object.entries(HEURISTICS)) {
      expect(h.id).toBe(key); // key matches its own id
      expect(h.plane.length).toBeGreaterThan(0);
      expect(h.remediation.length).toBeGreaterThan(10);
      expect(h.docUrl).toStartWith("https://");
      expect(h.reviewed).toBe(HEURISTICS_REVIEWED);
    }
  });

  test("remediation strings are ASCII (commit-safe, no smart punctuation)", () => {
    for (const h of Object.values(HEURISTICS)) {
      // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ASCII range check
      expect(h.remediation).toMatch(/^[\x00-\x7F]*$/);
    }
  });
});

describe("threshold boundaries drive findings", () => {
  test("cache hit exactly at target -> no finding; below -> finding with metadata", () => {
    const at = base();
    at.sql.cacheHitPct = THRESHOLDS.cacheHitPct; // 99
    expect(deriveFindings(at).some((f) => f.heuristicId === "cache_hit_low")).toBe(false);

    const below = base();
    below.sql.cacheHitPct = THRESHOLDS.cacheHitPct - 1; // 98
    const f = deriveFindings(below).find((x) => x.heuristicId === "cache_hit_low");
    expect(f).toBeDefined();
    expect(f?.remediation).toBeDefined();
    expect(f?.docUrl).toStartWith("https://");
  });

  test("txid crosses warn then high threshold", () => {
    const warn = base();
    warn.sql.txidWraparound = [{ pct_wraparound: THRESHOLDS.txidWarnPct }];
    expect(deriveFindings(warn).find((f) => f.heuristicId === "txid_wraparound")?.severity).toBe(
      "med",
    );

    const high = base();
    high.sql.txidWraparound = [{ pct_wraparound: THRESHOLDS.txidHighPct }];
    expect(deriveFindings(high).find((f) => f.heuristicId === "txid_wraparound")?.severity).toBe(
      "high",
    );

    const clear = base();
    clear.sql.txidWraparound = [{ pct_wraparound: THRESHOLDS.txidWarnPct - 1 }];
    expect(deriveFindings(clear).some((f) => f.heuristicId === "txid_wraparound")).toBe(false);
  });

  test("bloat below the minimum is not reported; med bump above bloatMedBytes", () => {
    const small = base();
    small.sql.bloat = [
      { name: "public.t", waste: "40 MB", waste_bytes: THRESHOLDS.bloatMinBytes - 1 },
    ];
    expect(small.sql.bloat.length).toBe(1);
    expect(deriveFindings(small).some((f) => f.heuristicId === "table_bloat")).toBe(false);

    const big = base();
    big.sql.bloat = [{ name: "public.t", waste: "600 MB", waste_bytes: THRESHOLDS.bloatMedBytes }];
    const f = deriveFindings(big).find((x) => x.heuristicId === "table_bloat");
    expect(f?.severity).toBe("med");
  });
});

describe("advisor findings carry advisor metadata", () => {
  test("perf + security advisors attach the right heuristic id", () => {
    const a = base();
    a.advisors.performance = [
      {
        name: "x",
        title: "Unindexed foreign keys",
        level: "WARN",
        categories: [],
        description: "d",
      },
    ];
    a.advisors.security = [
      { name: "y", title: "RLS disabled", level: "ERROR", categories: [], description: "d" },
    ];
    const found = deriveFindings(a);
    expect(found.find((f) => f.category === "Performance")?.heuristicId).toBe(
      "advisor_performance",
    );
    expect(found.find((f) => f.category === "Security")?.heuristicId).toBe("advisor_security");
  });
});
