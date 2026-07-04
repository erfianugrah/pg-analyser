import { describe, expect, test } from "bun:test";
import { parseProfile, profileEntries, resolveGrafana } from "../src/profile.ts";

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
