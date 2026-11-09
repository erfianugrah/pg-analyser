import { describe, expect, test } from "bun:test";
import {
  grafanaProfileProblems,
  parseProfile,
  profileEntries,
  resolveGrafana,
} from "../src/profile.ts";

const REF = "abcdefghijklmnopqrst";

const full = {
  noPat: true,
  grafana: {
    hostTemplate: "https://grafana-{region}.example.com",
    datasourceUid: "DS_DEFAULT",
    matcher: 'label="db-{ref}"',
    regions: {
      "ap-southeast-1": { cookie: "cookie-sg" },
      "eu-central-1": { cookie: "cookie-eu", uid: "DS_EU", host: "https://gf-eu.example.com" },
    },
  },
  databases: [
    {
      name: "cust-a",
      dbUrl: `postgresql://supabase_admin.${REF}:pw@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres`,
    },
    {
      name: "cust-b",
      dbUrl: `postgresql://supabase_admin.${REF}:pw@aws-0-eu-central-1.pooler.supabase.com:6543/postgres`,
    },
  ],
};

describe("parseProfile", () => {
  test("validates a full profile and defaults noPat=true", () => {
    const p = parseProfile(JSON.stringify({ databases: [{ dbUrl: "postgresql://a" }] }));
    expect(p.noPat).toBe(true);
    expect(p.grafana).toBeUndefined();
    expect(p.databases).toHaveLength(1);
  });

  test("rejects a profile with no databases", () => {
    expect(() => parseProfile(JSON.stringify({ databases: [] }))).toThrow();
  });

  test("trendDays is optional and validated (positive int)", () => {
    expect(
      parseProfile(JSON.stringify({ trendDays: 90, databases: [{ dbUrl: "x" }] })).trendDays,
    ).toBe(90);
    expect(parseProfile(JSON.stringify({ databases: [{ dbUrl: "x" }] })).trendDays).toBeUndefined();
    expect(() =>
      parseProfile(JSON.stringify({ trendDays: 0, databases: [{ dbUrl: "x" }] })),
    ).toThrow();
    expect(() =>
      parseProfile(JSON.stringify({ trendDays: -5, databases: [{ dbUrl: "x" }] })),
    ).toThrow();
  });

  test("defaults the matcher when grafana omits it", () => {
    const p = parseProfile(
      JSON.stringify({ databases: [{ dbUrl: "postgresql://a" }], grafana: { regions: {} } }),
    );
    expect(p.grafana?.matcher).toBe('supabase_project_ref="{ref}"');
  });
});

describe("shipped example stays schema-valid", () => {
  test("pg-analyser.profile.example.json parses against the Profile schema", async () => {
    const p = parseProfile(await Bun.file("pg-analyser.profile.example.json").text());
    expect(p.databases.length).toBeGreaterThan(0);
    expect(p.trendDays).toBe(30);
    // the region-override demo entry
    expect(p.databases.some((d) => d.region === "eu-central-1")).toBe(true);
  });
});

describe("profileEntries", () => {
  test("maps databases to raw db-target entries", () => {
    const p = parseProfile(JSON.stringify(full));
    const e = profileEntries(p);
    expect(e).toHaveLength(2);
    expect(e[0]?.name).toBe("cust-a");
    expect(e[0]?.dbUrl).toContain("ap-southeast-1");
  });
});

describe("resolveGrafana", () => {
  const p = parseProfile(JSON.stringify(full));

  test("builds host from template + shared uid + region cookie", () => {
    const g = resolveGrafana(p, "ap-southeast-1");
    expect(g).toEqual({
      url: "https://grafana-ap-southeast-1.example.com/api/datasources/proxy/uid/DS_DEFAULT",
      cookie: "cookie-sg",
      matcher: 'label="db-{ref}"',
    });
  });

  test("per-region host + uid override win over the template/default", () => {
    const g = resolveGrafana(p, "eu-central-1");
    expect(g?.url).toBe("https://gf-eu.example.com/api/datasources/proxy/uid/DS_EU");
    expect(g?.cookie).toBe("cookie-eu");
  });

  test("null when the region isn't in the map (trends skipped for that db)", () => {
    expect(resolveGrafana(p, "us-west-2")).toBeNull();
  });

  test("null for no region / no grafana block", () => {
    expect(resolveGrafana(p, null)).toBeNull();
    const noGraf = parseProfile(JSON.stringify({ databases: [{ dbUrl: "postgresql://a" }] }));
    expect(resolveGrafana(noGraf, "ap-southeast-1")).toBeNull();
  });
});

describe("grafanaProfileProblems", () => {
  const sg = { name: "cust-a", ref: REF, region: "ap-southeast-1" };
  const eu = { name: "cust-b", ref: REF, region: "eu-central-1" };
  const withRegions = (regions: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    parseProfile(
      JSON.stringify({
        ...full,
        grafana: { ...full.grafana, ...extra, regions },
      }),
    );

  test("a fully mapped profile has no problems", () => {
    expect(grafanaProfileProblems(parseProfile(JSON.stringify(full)), [sg, eu])).toEqual([]);
  });

  test("no grafana block = SQL-only profile, nothing to check", () => {
    const p = parseProfile(JSON.stringify({ databases: [{ dbUrl: "postgresql://a" }] }));
    expect(grafanaProfileProblems(p, [{ ref: REF, region: "us-west-2" }])).toEqual([]);
  });

  test("a misspelt region key is rejected with the target region as the suggestion", () => {
    const problems = grafanaProfileProblems(withRegions({ "ap-southheast-1": { cookie: "c" } }), [
      sg,
    ]);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain(
      'grafana.regions key "ap-southheast-1" is not an AWS region name',
    );
    expect(problems[0]).toContain('did you mean "ap-southeast-1"?');
    expect(problems[1]).toContain('database "cust-a"');
    expect(problems[1]).toContain("is in ap-southeast-1");
    expect(problems[1]).toContain("grafana.regions maps: ap-southheast-1");
  });

  test("a valid but different region key (one-digit slip) names the target and the keys", () => {
    const problems = grafanaProfileProblems(withRegions({ "ap-northeast-2": { cookie: "c" } }), [
      { name: "cust-c", ref: REF, region: "ap-northeast-1" },
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("is in ap-northeast-1");
    expect(problems[0]).toContain("grafana.regions maps: ap-northeast-2");
    expect(problems[0]).toContain("profile without a grafana block");
  });

  test("an underivable region asks for databases[].region", () => {
    const problems = grafanaProfileProblems(parseProfile(JSON.stringify(full)), [
      { name: "cust-d", ref: REF },
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('set "region" on its databases[] entry');
  });

  test("a region entry with no resolvable host or datasource uid is reported", () => {
    const problems = grafanaProfileProblems(
      withRegions(
        { "ap-southeast-1": { cookie: "c" } },
        { hostTemplate: undefined, datasourceUid: undefined },
      ),
      [sg],
    );
    expect(problems.some((m) => m.includes('grafana.regions["ap-southeast-1"] has no host'))).toBe(
      true,
    );
    expect(
      problems.some((m) => m.includes('grafana.regions["ap-southeast-1"] has no datasource uid')),
    ).toBe(true);
  });
});
