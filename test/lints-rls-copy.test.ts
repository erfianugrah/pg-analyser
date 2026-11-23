import { describe, expect, test } from "bun:test";
import { LINT_FIXES } from "../src/lints.ts";

// Tables read only by server code with the service role key are a legitimate
// default-deny setup. The old copy called RLS-without-policy "almost always an
// accidental lockout" and suggested disabling RLS as a fix.
describe("rls_enabled_no_policy copy", () => {
  const fix = LINT_FIXES.rls_enabled_no_policy;

  test("names the server-only (service role) case as legitimate", () => {
    expect(fix?.whyItMatters).toMatch(/service role/i);
    expect(fix?.whatToDo).toMatch(/service role/i);
  });

  test("no longer calls it almost always accidental", () => {
    expect(fix?.whyItMatters).not.toMatch(/almost always/i);
  });

  test("never suggests disabling RLS as the fix", () => {
    expect(fix?.whatToDo).not.toMatch(/disabl\w* RLS(?! to)/i);
    expect(fix?.whatToDo).toMatch(/do not disable RLS/i);
  });
});
