import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseFlags } from "../src/index.ts";

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

describe("--profile chaining", () => {
  test("space-separated files after one flag all chain (the reported bug)", () => {
    // `--profile a.json b.json` must load BOTH - the second file used to fall
    // through to positionals and get silently dropped.
    const f = parseFlags(["full", "--profile", "a.json", "b.json", "--amcheck"]);
    expect(f.profiles).toEqual(["a.json", "b.json"]);
    expect(f.amcheck).toBe(true);
    expect(f._).toEqual(["full"]);
  });

  test("greedy consumption stops at the next --flag", () => {
    const f = parseFlags(["full", "--profile", "a.json", "--interval", "7day"]);
    expect(f.profiles).toEqual(["a.json"]);
    expect(f.interval).toBe("7day");
  });

  test("repeating the flag still chains", () => {
    const f = parseFlags(["full", "--profile", "a.json", "--profile", "b.json"]);
    expect(f.profiles).toEqual(["a.json", "b.json"]);
  });

  test("comma/space-delimited within one quoted value splits", () => {
    expect(parseFlags(["full", "--profile", "a.json,b.json"]).profiles).toEqual([
      "a.json",
      "b.json",
    ]);
    expect(parseFlags(["full", "--profile", "a.json b.json"]).profiles).toEqual([
      "a.json",
      "b.json",
    ]);
  });

  test("--profile with no value still errors", () => {
    const { code, stderr } = run(["full", "--profile"]);
    expect(code).toBe(1);
    expect(stderr).toContain("--profile expects a value, got nothing");
  });
});
