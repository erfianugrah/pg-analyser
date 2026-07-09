import { describe, expect, test } from "bun:test";
import { join } from "node:path";

// The flag parser must fail loud when a value-taking flag swallows the next
// FLAG as its value (e.g. `--db-config --amcheck` -> a file named "--amcheck"),
// instead of the confusing downstream ENOENT. These run the CLI for real; the
// guard fires during arg-parse, before any transport/DB work, so they are
// hermetic (no PAT, no network).
const ENTRY = join(import.meta.dir, "..", "src", "index.ts");

function run(args: string[]): { code: number; stderr: string } {
  const p = Bun.spawnSync(["bun", "run", ENTRY, ...args], {
    stderr: "pipe",
    stdout: "pipe",
    env: { ...process.env, SUPABASE_ACCESS_TOKEN: "" },
  });
  return { code: p.exitCode ?? -1, stderr: p.stderr.toString() };
}

describe("flag value guard", () => {
  test("--db-config followed by another flag errors clearly (the reported bug)", () => {
    const { code, stderr } = run(["full", "--all", "--db-config", "--amcheck"]);
    expect(code).toBe(1);
    expect(stderr).toContain("--db-config expects a value, got '--amcheck'");
    // NOT the old confusing filesystem error.
    expect(stderr).not.toContain("ENOENT");
  });

  test("a value flag at the end of args errors with 'nothing'", () => {
    const { code, stderr } = run(["full", "--out"]);
    expect(code).toBe(1);
    expect(stderr).toContain("--out expects a value, got nothing");
  });

  test("--ref with no value errors instead of consuming the next flag", () => {
    const { code, stderr } = run(["analyze", "--ref", "--db-url"]);
    expect(code).toBe(1);
    expect(stderr).toContain("--ref expects a value, got '--db-url'");
  });

  test("--import still accepts '-' (stdin sentinel) as a value", () => {
    // '-' must NOT trip the guard; parsing proceeds (then narrate fails later
    // for unrelated reasons, but not with the flag-guard message).
    const { stderr } = run(["narrate", "somedir", "--import", "-"]);
    expect(stderr).not.toContain("--import expects a value");
  });
});
