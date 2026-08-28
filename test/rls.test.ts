import { describe, expect, test } from "bun:test";
import { isUnwrappedAuth, referencesOwnTable } from "../src/rls.ts";

describe("isUnwrappedAuth", () => {
  test("flags a bare per-row auth call", () => {
    expect(isUnwrappedAuth("(auth.uid() = user_id)", null)).toBe(true);
    expect(isUnwrappedAuth(null, "(auth.uid() = user_id)")).toBe(true);
    expect(isUnwrappedAuth("(auth.jwt() ->> 'role' = 'admin')", null)).toBe(true);
  });

  // Regression: Postgres stores wrapped policies with an uppercase SELECT, e.g.
  // "( SELECT auth.uid() AS uid)". A case-sensitive check false-flagged these.
  test("does NOT flag a policy already wrapped in a sub-select (any case)", () => {
    expect(isUnwrappedAuth("(( SELECT auth.uid() AS uid) = user_id)", null)).toBe(false);
    expect(isUnwrappedAuth("((select auth.uid()) = user_id)", null)).toBe(false);
    expect(isUnwrappedAuth(null, "(( SELECT auth.uid() AS uid) = user_id)")).toBe(false);
  });

  test("does NOT flag policies that don't call auth.*()", () => {
    expect(isUnwrappedAuth("(username = CURRENT_USER)", null)).toBe(false);
    expect(isUnwrappedAuth("(visibility = 'public')", null)).toBe(false);
    expect(isUnwrappedAuth(null, null)).toBe(false);
  });
});

describe("referencesOwnTable", () => {
  // All expressions below are verbatim deparsed pg_policies output captured
  // from a live PG17 instance (policies created, then qual read back).
  test("flags an own-table subquery (bare name + auto-alias)", () => {
    const qual =
      "(org_id IN ( SELECT org_user_1.org_id                   +\n    FROM org_user org_user_1))";
    expect(referencesOwnTable("public.org_user", qual, null)).toBe(true);
  });

  test("flags a schema-qualified own-table subquery", () => {
    expect(
      referencesOwnTable(
        "public.org_user",
        "(org_id IN (SELECT o.org_id FROM public.org_user o))",
        null,
      ),
    ).toBe(true);
    expect(referencesOwnTable("public.org_user", null, "(exists (select 1 from org_user))")).toBe(
      true,
    );
  });

  test("does NOT flag a plain own-column compare", () => {
    const qual = "(user_id = '00000000-0000-0000-0000-000000000001'::uuid)";
    expect(referencesOwnTable("public.org_user", qual, null)).toBe(false);
  });

  test("does NOT flag a cross-table subquery", () => {
    const qual = "(team IN ( SELECT teams.team                            +\n    FROM teams))";
    expect(referencesOwnTable("public.profiles", qual, null)).toBe(false);
  });

  test("does NOT flag when the own name is only a column or value", () => {
    // 'org_user' appearing as a column value / alias, not a FROM target
    expect(referencesOwnTable("public.org_user", "(role = 'org_user')", null)).toBe(false);
    expect(referencesOwnTable("public.profiles", null, null)).toBe(false);
  });

  test("matches quoted identifiers", () => {
    expect(
      referencesOwnTable("public.my table", '(id in (select id from "my table" t))', null),
    ).toBe(true);
  });

  // All expressions below are verbatim deparsed pg_policies output captured
  // from a live PG17 instance (edge-case fixtures).
  test("flags a schema-qualified own-table subquery (app1.orders)", () => {
    const qual =
      "(org_id IN ( SELECT orders_1.org_id            +\n    FROM app1.orders orders_1))";
    expect(referencesOwnTable("app1.orders", qual, null)).toBe(true);
  });

  test("does NOT flag 'from t' inside a string literal", () => {
    expect(referencesOwnTable("public.t_lit", "(note <> 'from t_lit'::text)", null)).toBe(false);
    expect(referencesOwnTable("public.t_lit", "(note = 'join t_lit')", null)).toBe(false);
    // escaped quote inside the literal still stripped
    expect(referencesOwnTable("public.t", "(note = 'it''s from t')", null)).toBe(false);
  });

  test("flags a parenthesised join-form self-reference", () => {
    const qual =
      "(EXISTS ( SELECT 1                             +\n    FROM (joint j                               +\n      JOIN other o ON ((o.org_id = j.org_id)))))";
    expect(referencesOwnTable("public.joint", qual, null)).toBe(true);
  });

  test("flags a WITH CHECK self-reference (no USING)", () => {
    const wc = "(NOT (role IN ( SELECT t_wc_1.role             +\n    FROM t_wc t_wc_1)))";
    expect(referencesOwnTable("public.t_wc", null, wc)).toBe(true);
  });
});
