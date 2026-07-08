import { describe, expect, test } from "bun:test";
import type { Overlay } from "../src/overlay.ts";
import { render, renderIndex, renderOrgIndex, renderSummary } from "../src/report/render.ts";
import type { Analysis } from "../src/schemas.ts";

function fixture(overrides: Partial<Analysis> = {}): Analysis {
  const base: Analysis = {
    meta: {
      ref: "testref",
      name: "test-project",
      region: "eu-central-1",
      status: "ACTIVE_HEALTHY",
      pgVersion: "17.6.1.104",
      createdAt: "2026-01-01T00:00:00Z",
      collectedAt: "2026-07-02T00:00:00Z",
      sbperfVersion: "0.1.0",
      sqlSource: "read-only",
    },
    health: [
      { name: "db", healthy: true, status: "ACTIVE_HEALTHY" },
      { name: "realtime", healthy: false, status: "UNHEALTHY" },
    ],
    disk: {
      sizeGb: 8,
      iops: 3000,
      type: "gp3",
      throughputMibps: 125,
      usedBytes: 972496896,
      availBytes: 7444385792,
    },
    pgConfig: { max_connections: 60, shared_buffers: "256MB" },
    pooler: [{ database_type: "PRIMARY", db_port: 6543, pool_mode: "transaction" }],
    backups: { pitr_enabled: false, walg_enabled: true, backups: [] },
    upgrade: { eligible: true, current_app_version: "v1", latest_app_version: "v2" },
    functions: [],
    functionStats: [],
    buckets: [],
    security: null,
    advisors: {
      performance: [
        { name: "x", title: "Multiple Permissive Policies", level: "WARN", detail: "detail here" },
      ],
      security: [],
    },
    apiCounts: [{ timestamp: "2026-07-01T06:00:00", total_rest_requests: 2 }],
    sql: {
      dbSize: "20 MB",
      cacheHitPct: 100,
      indexHitPct: 99.9,
      cacheBlocksAccessed: null,
      statsResetAge: "8 days 01:02:03",
      pgSettings: [
        { name: "max_connections", setting: "60", unit: null },
        { name: "idle_in_transaction_session_timeout", setting: "0", unit: "ms" },
      ],
      topStatements: [{ total_ms: 50983.4, calls: 135, pct: 88.2, query: "SELECT ..." }],
      topByCalls: [],
      queryIoStats: [],
      biggestTables: [],
      indexStats: [],
      duplicateIndexes: [],
      rlsUnindexed: [],
      seqScanHeavy: [],
      bloat: [],
      trafficProfile: [],
      tableIoStats: [],
      deadTuples: [],
      txidWraparound: [],
      replicationSlots: [],
      rlsPolicies: [
        { table: "public.pastes", policyname: "view own", cmd: "SELECT", unwrapped_auth: true },
      ],
      connections: [{ state: "idle", connections: 3 }],
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
    metrics: {
      available: true,
      samples: [{ name: "node_load1", labels: { service_type: "db" }, value: 0.42 }],
    },
    trends: [],
    sync: null,
    narrative: null,
    errors: [],
  };
  return { ...base, ...overrides };
}

function tagBalance(html: string): boolean {
  const void_ = new Set(["meta", "br", "hr", "img", "input", "link"]);
  const stack: string[] = [];
  const re = /<(\/?)([a-z0-9]+)[^>]*?(\/?)>/gi;
  let m: RegExpExecArray | null;
  m = re.exec(html);
  while (m !== null) {
    const [, close, tag, selfClose] = m;
    const t = tag!.toLowerCase();
    if (t === "!doctype" || void_.has(t) || selfClose) {
      // ignore
    } else if (close) {
      const idx = stack.lastIndexOf(t);
      if (idx === -1) return false;
      stack.length = idx;
    } else {
      stack.push(t);
    }
    m = re.exec(html);
  }
  return stack.length === 0;
}

describe("render", () => {
  test("capabilities strip: shows optional features either way (absent -> explicit, not hidden)", () => {
    // Empty fixture: no pg_cron extension, no buckets, no auth rows.
    const html = render(fixture());
    expect(html).toContain("Capabilities");
    expect(html).toContain("not installed"); // pg_cron
    expect(html).toContain("none configured"); // storage buckets
    expect(html).toContain("auth schema not present"); // auth

    // Present: pg_cron installed with a job, a bucket, and auth users.
    const a = fixture();
    a.sql.extensions = [{ name: "pg_cron", version: "1.6" }];
    a.sql.cronJobs = [{ jobname: "nightly", failed_runs: 0, runs_7d: 7 }];
    a.buckets = [{ id: "b1", name: "avatars", public: false }];
    a.sql.authAudit = [{ total_users: 42, confirmed_users: 40, active_30d: 10 }];
    a.sql.authMfa = [{ mfa_users: 5 }];
    const html2 = render(a);
    expect(html2).toContain("1 job");
    expect(html2).toContain("all healthy");
    expect(html2).toContain("1 bucket");
    expect(html2).toContain("42 users");
    expect(html2).toContain("5 MFA-enrolled");
  });

  test("emits the always-on section headings", () => {
    const html = render(fixture());
    for (const h of [
      "Findings",
      "Evidence",
      "Capabilities",
      "Infrastructure",
      "Advisors - performance",
      "Query outliers",
      "Index usage",
      "Estimated bloat",
      "Read/write profile",
      "Connections",
      "Infra metrics",
    ]) {
      expect(html).toContain(h);
    }
  });

  test("no-PAT header: collapses ref (ref) and drops unknown region/status", () => {
    const html = render(
      fixture({
        meta: {
          ...fixture().meta,
          name: "testref", // no-PAT with no profile name -> name falls back to ref
          ref: "testref",
          region: "unknown",
          status: "unknown",
          managementApi: false,
        },
      }),
    );
    const metaLine = html.match(/<div class=meta>[\s\S]*?<\/div>/)?.[0] ?? "";
    expect(metaLine).toContain("<code>testref</code>");
    expect(metaLine).not.toContain("(testref)"); // no "ref (ref)" duplication
    expect(metaLine).not.toContain("unknown"); // region + status placeholders dropped
    expect(metaLine).not.toContain("status <code>");
  });

  test("no-PAT header: keeps a derived region and a real name", () => {
    const html = render(
      fixture({
        meta: {
          ...fixture().meta,
          name: "prod-api",
          ref: "testref",
          region: "ap-southeast-1", // derived from the connstring
          status: "unknown",
          managementApi: false,
        },
      }),
    );
    const metaLine = html.match(/<div class=meta>[\s\S]*?<\/div>/)?.[0] ?? "";
    expect(metaLine).toContain("<code>prod-api</code> (testref)");
    expect(metaLine).toContain("ap-southeast-1");
    expect(metaLine).not.toContain("status <code>"); // status still unknown -> dropped
  });

  test("gates point-in-time snapshot sections on data", () => {
    // section anchor ids (robust vs heading text, which can collide with
    // positives like "Transaction-ID wraparound headroom is healthy")
    const gated = [
      'id="roles"',
      'id="txid"',
      'id="slots"',
      'id="walarchiving"',
      'id="hba"',
      'id="longrunning"',
      'id="locks"',
      'id="blocking"',
    ];
    // empty fixture -> none of the snapshot sections render
    const empty = render(fixture());
    for (const h of gated) expect(empty).not.toContain(h);

    // with data / above threshold -> each renders
    const a = fixture();
    a.sql.locks = [
      {
        pid: 1,
        relation: "public.t",
        mode: "AccessExclusiveLock",
        granted: true,
        age: "00:01",
        query: "ALTER TABLE t",
      },
    ];
    a.sql.blocking = [
      {
        blocked_pid: 2,
        blocked_query: "SELECT 1",
        blocking_pid: 1,
        blocking_query: "ALTER TABLE t",
      },
    ];
    a.sql.longRunning = [{ pid: 3, age: "00:10", query: "SELECT pg_sleep(600)" }];
    a.sql.replicationSlots = [{ slot_name: "s1", active: false, retained_wal_bytes: 1073741824 }];
    a.sql.walArchiving = [
      { archive_mode: "on", archived_count: 42, last_archived_wal: "0001", failed_count: 0 },
    ];
    a.sql.hbaRules = [
      { type: "host", database: "all", user_name: "all", address: "0.0.0.0/0", auth_method: "md5" },
    ];
    a.sql.roleStats = [{ role: "authenticated", connections: 45, conn_limit: 60 }];
    a.sql.txidWraparound = [
      { schema: "public", table: "public.big", xid_age: 5e8, pct_wraparound: 25 },
    ];
    const full = render(a);
    for (const h of gated) expect(full).toContain(h);
  });

  test("pooler config renders a section when a pooler is configured", () => {
    const a = fixture();
    a.pooler = [
      { database_type: "PRIMARY", db_port: 6543, pool_mode: "transaction", default_pool_size: 15 },
    ];
    const html = render(a);
    expect(html).toContain('id="pooler"');
    expect(html).toContain("transaction");
  });

  test("pooler section omitted when no pooler is configured", () => {
    const a = fixture();
    a.pooler = null;
    expect(render(a)).not.toContain('id="pooler"');
  });

  test("query outliers render an inline-SVG bar chart", () => {
    const html = render(fixture());
    expect(html).toContain("table class=chart");
    expect(html).toContain("<svg class=bar");
  });

  test("findings summary includes a severity bar when findings exist", () => {
    const html = render(fixture());
    expect(html).toContain('class="sevbar"');
  });

  test("sync footer renders the catalog vintage + drift note when present", () => {
    const html = render(
      fixture({
        sync: {
          catalogReviewed: "2026-07",
          ageDays: 2,
          stale: false,
          upstreamChecked: true,
          advisorSqlDrifted: true,
          note: "Heuristics catalog vintage 2026-07 (current). Upstream advisor lint SQL changed since it was vendored - re-review src/splinter.sql.",
        },
      }),
    );
    expect(html).toContain("Heuristics sync:");
    expect(html).toContain("vintage 2026-07");
    expect(html).toContain("always current");
  });

  test("sync footer omitted when no sync status recorded (back-compat)", () => {
    expect(render(fixture())).not.toContain("Heuristics sync:");
  });

  test("default report carries Supabase branding (favicon + logo + green accent)", () => {
    const html = render(fixture());
    expect(html).toContain("data:image/svg+xml,");
    expect(html).toContain("class=brandhead");
    expect(html).toContain("--accent:#3ECF8E");
    expect(html).not.toContain("#3056d3"); // old hardcoded blue gone
  });

  test("a custom brand overrides accent + logo (white-label)", () => {
    const html = render(fixture(), {
      brand: {
        name: "Acme",
        accent: "#ff00aa",
        ink: "#880055",
        logoSvg: "<svg id=acmelogo></svg>",
        faviconSvg: "<svg id=acmelogo></svg>",
      },
    });
    expect(html).toContain("--accent:#ff00aa");
    expect(html).toContain("--link:#880055");
    expect(html).toContain("<svg id=acmelogo></svg>");
    expect(html).not.toContain("#3ECF8E");
  });

  test("executive summary always present; narrative embeds only with the flag", () => {
    // deterministic executive summary is always rendered
    expect(render(fixture())).toContain('id="summary"');
    expect(render(fixture())).toContain("Executive summary");
    const withNar = fixture({ narrative: "## Deep dive\nLooks fine." });
    expect(render(withNar)).not.toContain("class=narrative"); // no flag -> prose not embedded
    const html = render(withNar, { narrative: true });
    expect(html).toContain("class=narrative");
    expect(html).toContain("Deep dive");
    // flag on but no narrative -> deterministic summary only, no narrative div
    expect(render(fixture(), { narrative: true })).not.toContain("class=narrative");
  });

  test("renders advisor finding with level badge", () => {
    const html = render(fixture());
    expect(html).toContain("Multiple Permissive Policies");
    expect(html).toContain('class="lvl WARN"');
  });

  test("advisor detail renders inline markdown: code spans + docs link, not raw", () => {
    const html = render(
      fixture({
        advisors: {
          performance: [
            {
              name: "x",
              title: "Auth RLS Initialization Plan",
              level: "WARN",
              detail:
                "Table \\`public.foo\\` has a policy that re-evaluates auth. See [docs](https://supabase.com/docs/guides/database/postgres/row-level-security).",
            },
          ],
          security: [],
        },
      }),
    );
    expect(html).toContain("<code>public.foo</code>");
    expect(html).toContain(
      '<a href="https://supabase.com/docs/guides/database/postgres/row-level-security" rel="noreferrer">docs</a>',
    );
    // no raw backticks or literal markdown link syntax leaked into the cell
    expect(html).not.toContain("`public.foo`");
    expect(html).not.toContain("[docs](https://");
  });

  test("empty SQL sections show 'none found' not a broken table", () => {
    const html = render(fixture());
    expect(html).toContain("none found");
  });

  test("audit flow: TL;DR verdict -> findings -> evidence (pyramid)", () => {
    const html = render(fixture());
    const tldrIdx = html.indexOf("class=tldr");
    const findIdx = html.indexOf('id="findings"');
    const evidenceIdx = html.indexOf('id="evidence"');
    const outlierIdx = html.indexOf("Query outliers");
    expect(tldrIdx).toBeGreaterThan(-1);
    expect(tldrIdx).toBeLessThan(findIdx); // TL;DR leads
    expect(findIdx).toBeLessThan(evidenceIdx); // then findings
    expect(evidenceIdx).toBeLessThan(outlierIdx); // then substantiating evidence
    expect(html).toContain("RLS"); // the unwrapped-auth finding surfaces
    expect(html).toContain("class=priorities"); // top-priority links present
    expect(html).toContain('class="finding'); // per-finding deep-dive blocks
  });

  test("findings deep-dive shows why-it-matters + what-to-do + evidence link", () => {
    const html = render(fixture());
    expect(html).toContain("Why it matters"); // consequence rendered
    expect(html).toContain("What to do"); // remediation rendered
    expect(html).toContain("Evidence &#8595;"); // evidence jump link
  });

  test("degraded banner shows for non-healthy status", () => {
    const html = render(fixture({ meta: { ...fixture().meta, status: "INACTIVE" } }));
    expect(html).toContain("banner bad");
    expect(html).toContain('not "clean"');
  });

  test("no-PAT (healthy): no top alert banner; caveat is a header chip + footer note", () => {
    const html = render(
      fixture({ meta: { ...fixture().meta, status: "unknown", managementApi: false } }),
    );
    // methodology is NOT a top alert banner
    expect(html).not.toContain("banner bad");
    expect(html).not.toContain("banner warn");
    // compact chip up top
    const metaLine = html.match(/<div class=meta>[\s\S]*?<\/div>/)?.[0] ?? "";
    expect(metaLine).toContain("<code>no-PAT</code>");
    // detail lives in the footer
    expect(html).toContain("Management-API planes");
    expect(html).toContain('not "clean"');
  });

  test("no-PAT + unreachable DB: still a top alert banner", () => {
    const a = fixture({ meta: { ...fixture().meta, status: "unknown", managementApi: false } });
    a.errors = [{ source: "sql:dbSize", message: "connection refused" }];
    const html = render(a);
    expect(html).toContain("banner bad");
    expect(html).toContain("database was unreachable");
  });

  test("deduped collection notes collapse repeats", () => {
    const html = render(
      fixture({
        errors: [
          { source: "sql:dbSize", message: "connection timeout" },
          { source: "sql:cacheHit", message: "connection timeout" },
        ],
      }),
    );
    expect(html).toContain("2x");
  });

  test("empty advisors show 'no findings'", () => {
    const html = render(fixture({ advisors: { performance: [], security: [] } }));
    expect(html).toContain("no findings");
  });

  test("flags unhealthy service + version drift + sub-99 cache", () => {
    const html = render(fixture({ sql: { ...fixture().sql, cacheHitPct: 92 } }));
    expect(html).toContain('class="badge bad">realtime');
    expect(html).toContain("available</span>");
    expect(html).toContain("below 99%");
  });

  test("renders SVG sparklines when trends present", () => {
    const html = render(
      fixture({
        trends: [
          {
            title: "CPU load (1m)",
            unit: "",
            points: [
              { t: 1, v: 0.5 },
              { t: 2, v: 0.9 },
            ],
          },
        ],
      }),
    );
    expect(html).toContain("Resource snapshot");
    expect(html).toContain("<svg viewBox");
  });

  test("omits trends section when no trend data", () => {
    expect(render(fixture())).not.toContain("Resource snapshot");
  });

  test("storage buckets render with access + usage", () => {
    const html = render(
      fixture({
        buckets: [{ name: "avatars", public: true }],
        sql: {
          ...fixture().sql,
          storageUsage: [{ bucket_id: "avatars", objects: 12, size: "3 MB" }],
        },
      }),
    );
    expect(html).toContain("avatars");
    expect(html).toContain("public");
    expect(html).toContain("3 MB");
  });

  test("produces balanced HTML tags", () => {
    expect(tagBalance(render(fixture()))).toBe(true);
  });

  test("is self-contained (no external asset refs)", () => {
    const html = render(fixture());
    expect(html).not.toMatch(/<(script|link)[^>]+(src|href)=["']https?:/);
  });
});

describe("render overlay", () => {
  test("overlay hides a section", () => {
    const base = render(fixture());
    expect(base).toContain('id="outliers"');
    const overlay: Overlay = { hide: new Set(["outliers"]), notes: {} };
    const html = render(fixture(), { overlay });
    expect(html).not.toContain('id="outliers"');
    // sibling section unaffected
    expect(html).toContain('id="calls"');
  });

  test("overlay appends a section note as rendered markdown", () => {
    const overlay: Overlay = { hide: new Set(), notes: { outliers: "**cron only**" } };
    const html = render(fixture(), { overlay });
    const seg = html.slice(html.indexOf('id="outliers"'), html.indexOf('id="calls"'));
    expect(seg).toContain("<strong>cron only</strong>");
  });

  test("overlay top note renders after the exec summary", () => {
    const overlay: Overlay = { hide: new Set(), notes: { top: "reviewed today" } };
    const html = render(fixture(), { overlay });
    expect(html).toContain("overlay-note");
    expect(html).toContain("reviewed today");
  });

  test("no overlay leaves output identical to default", () => {
    expect(render(fixture(), { overlay: { hide: new Set(), notes: {} } })).toBe(render(fixture()));
  });
});

describe("renderSummary", () => {
  test("healthy project -> ok verdict, no issues", () => {
    const clean = fixture({
      advisors: { performance: [], security: [] },
      upgrade: null,
      sql: {
        dbSize: "20 MB",
        cacheHitPct: 100,
        indexHitPct: 100,
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
        tableIoStats: [],
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
    });
    const html = renderSummary(clean);
    expect(html).toContain("Healthy - no issues found");
    expect(html).not.toContain("needs attention");
  });

  test("high finding -> singular subject-verb agreement", () => {
    const a = fixture();
    a.functionStats = [
      {
        slug: "boom",
        requests: 5,
        success: 0,
        clientErr: 0,
        serverErr: 5,
        avgExecMs: 1,
        maxExecMs: 1,
      },
    ];
    const html = renderSummary(a);
    expect(html).toContain("1 issue needs attention now");
    expect(html).toContain("boom");
    expect(html).not.toContain("1 issue need attention");
  });

  test("is standalone: no SQL evidence tables or drill anchors", () => {
    const html = renderSummary(fixture());
    expect(html).not.toContain("pg_stat_statements");
    expect(html).not.toContain("#txid");
    expect(html).toContain("At a glance");
  });
});

describe("renderOrgIndex", () => {
  test("one row per org, linking its own index, with project counts + rollup", () => {
    const html = renderOrgIndex(
      [
        { name: "ErfiCorp", dir: "erficorp", projects: 3, high: 1, med: 2, low: 4, errors: 0 },
        { name: "Side Org", dir: "side-org", projects: 1, high: 0, med: 0, low: 1, errors: 1 },
      ],
      "2026-07-03T00:00:00Z",
    );
    expect(html).toContain('href="erficorp/index.html"');
    expect(html).toContain("ErfiCorp");
    expect(html).toContain("2 organizations");
    expect(html).toContain("4 projects");
    expect(html).toContain("1 / 2 / 4");
    expect(html).toContain('class="lvl ERROR">1</span>'); // Side Org error count
  });
});

describe("renderIndex", () => {
  test("links each project with status + findings counts", () => {
    const html = renderIndex(
      [
        {
          name: "proj-a",
          ref: "aaa",
          status: "ACTIVE_HEALTHY",
          high: 0,
          med: 2,
          low: 5,
          dir: "aaa",
        },
        {
          name: "proj-b",
          ref: "bbb",
          status: "INACTIVE",
          high: 0,
          med: 0,
          low: 0,
          dir: "bbb",
          error: "unreachable",
        },
      ],
      "2026-07-02T00:00:00Z",
    );
    expect(html).toContain('href="aaa/report.html"');
    expect(html).toContain("proj-a");
    expect(html).toContain("0 / 2 / 5");
    expect(html).toContain("unreachable"); // failed project shows its error
    expect(html).toContain("2 projects");
  });

  test("no-PAT rows render a neutral status, not a red 'unknown' badge", () => {
    const html = renderIndex(
      [{ name: "cust-db", ref: "ccc", status: "unknown", high: 1, med: 0, low: 3, dir: "ccc" }],
      "2026-07-02T00:00:00Z",
    );
    expect(html).not.toContain('class="badge bad">unknown'); // no misleading red badge
    expect(html).toContain("1 / 0 / 3");
  });

  test("rows are sorted worst-first (errors, then high/med/low, then name)", () => {
    const html = renderIndex(
      [
        { name: "clean", ref: "a", status: "ACTIVE_HEALTHY", high: 0, med: 0, low: 1, dir: "a" },
        { name: "hot", ref: "b", status: "ACTIVE_HEALTHY", high: 3, med: 0, low: 0, dir: "b" },
        { name: "broken", ref: "c", status: "?", high: 0, med: 0, low: 0, dir: "c", error: "x" },
        { name: "warm", ref: "d", status: "ACTIVE_HEALTHY", high: 0, med: 4, low: 0, dir: "d" },
      ],
      "2026-07-02T00:00:00Z",
    );
    const order = ["broken", "hot", "warm", "clean"].map((n) => html.indexOf(`>${n}</a>`));
    // every name present and in strictly increasing document position
    expect(order.every((p) => p >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((x, y) => x - y));
  });
});

describe("trend source label + EBS caveat", () => {
  function withTrends(source: Analysis["meta"]["trendSource"], titles: string[]): Analysis {
    const a = fixture();
    a.meta.trendSource = source;
    a.trends = titles.map((title) => ({
      title,
      unit: "%",
      points: [
        { t: 1, v: 10 },
        { t: 2, v: 20 },
      ],
    }));
    return a;
  }

  test("labels a Prometheus/Grafana source and omits the EBS note when EBS panels exist", () => {
    const html = render(withTrends("prometheus", ["CPU utilization (%)", "EBS IOPS balance (%)"]));
    expect(html).toContain("Source: from Prometheus/Grafana.");
    expect(html).not.toContain("CloudWatch-scraping Prometheus");
  });

  test("labels the history store and shows the EBS caveat when EBS panels are absent", () => {
    const html = render(withTrends("store", ["CPU utilization (%)", "Memory used (%)"]));
    expect(html).toContain("Source: from the metrics history store");
    expect(html).toContain("CloudWatch-scraping Prometheus");
  });

  test("imported trends are labelled but do NOT get the CloudWatch/EBS caveat", () => {
    const html = render(withTrends("import", ["Custom metric"]));
    expect(html).toContain("Source: from imported series");
    expect(html).not.toContain("CloudWatch-scraping Prometheus");
  });

  test("no trends -> no Resource snapshot section at all", () => {
    const html = render(fixture({ trends: [] }));
    expect(html).not.toContain("Resource snapshot");
  });
});
