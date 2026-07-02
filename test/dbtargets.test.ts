import { describe, expect, test } from "bun:test";
import {
  parseDbConfig,
  redactConnstring,
  refFromConnstring,
  resolveTargets,
} from "../src/dbtargets.ts";

const REF = "abcdefghijklmnopqrst"; // 20 lowercase letters

describe("refFromConnstring", () => {
  test("pooler: role.ref in username", () => {
    expect(
      refFromConnstring(
        `postgresql://supabase_admin.${REF}:pw@aws-0-x.pooler.supabase.com:5432/postgres`,
      ),
    ).toBe(REF);
    expect(
      refFromConnstring(
        `postgresql://postgres.${REF}:pw@aws-0-x.pooler.supabase.com:6543/postgres`,
      ),
    ).toBe(REF);
  });

  test("direct: db.<ref>.supabase.co in host", () => {
    expect(refFromConnstring(`postgresql://postgres:pw@db.${REF}.supabase.co:5432/postgres`)).toBe(
      REF,
    );
  });

  test("non-Supabase connstring -> null", () => {
    expect(refFromConnstring("postgresql://user:pw@localhost:5432/mydb")).toBeNull();
    expect(refFromConnstring("postgresql://postgres:pw@10.0.0.5:5432/postgres")).toBeNull();
  });

  test("garbage -> null", () => {
    expect(refFromConnstring("not a url")).toBeNull();
    expect(refFromConnstring("")).toBeNull();
  });
});

describe("redactConnstring", () => {
  test("strips the password", () => {
    const r = redactConnstring(
      `postgresql://supabase_admin.${REF}:supersecret@host.pooler.supabase.com:5432/postgres`,
    );
    expect(r).not.toContain("supersecret");
    expect(r).toContain("host.pooler.supabase.com");
  });
});

describe("parseDbConfig", () => {
  test("accepts a bare array", () => {
    const out = parseDbConfig(JSON.stringify([{ dbUrl: "postgresql://a", ref: "r1" }]));
    expect(out).toEqual([{ dbUrl: "postgresql://a", ref: "r1" }]);
  });

  test("accepts { databases: [...] }", () => {
    const out = parseDbConfig(
      JSON.stringify({ databases: [{ name: "prod", dbUrl: "postgresql://b" }] }),
    );
    expect(out).toEqual([{ name: "prod", dbUrl: "postgresql://b" }]);
  });

  test("rejects an entry with no dbUrl", () => {
    expect(() => parseDbConfig(JSON.stringify([{ ref: "r1" }]))).toThrow();
  });
});

describe("resolveTargets", () => {
  test("derives ref per connstring for a bare flag list", () => {
    const a = `postgresql://supabase_admin.${REF}:pw@x.pooler.supabase.com:5432/postgres`;
    const targets = resolveTargets([{ dbUrl: a }]);
    expect(targets).toEqual([{ ref: REF, dbUrl: a, name: undefined }]);
  });

  test("explicit ref in the entry wins over derivation", () => {
    const targets = resolveTargets([
      {
        dbUrl: `postgresql://postgres:pw@db.${REF}.supabase.co:5432/postgres`,
        ref: "override_ref_abcdef",
      },
    ]);
    expect(targets[0]?.ref).toBe("override_ref_abcdef");
  });

  test("fallbackRef rescues a single underivable target", () => {
    const targets = resolveTargets([{ dbUrl: "postgresql://u:p@localhost:5432/db" }], "myref");
    expect(targets[0]?.ref).toBe("myref");
  });

  test("throws (redacted) when a ref cannot be determined", () => {
    expect(() => resolveTargets([{ dbUrl: "postgresql://u:sekret@localhost:5432/db" }])).toThrow(
      /cannot determine the Supabase project ref/,
    );
    try {
      resolveTargets([{ dbUrl: "postgresql://u:sekret@localhost:5432/db" }]);
    } catch (e) {
      expect(String(e)).not.toContain("sekret");
    }
  });
});
