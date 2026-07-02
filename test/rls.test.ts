import { describe, expect, test } from "bun:test";
import { isUnwrappedAuth } from "../src/rls.ts";

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
