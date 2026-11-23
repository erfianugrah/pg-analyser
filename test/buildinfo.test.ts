import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoHead, staleBuildWarning, versionString } from "../src/buildinfo.ts";

// A binary built before later merged features gave no sign it was stale.
// The compiled binary now knows its commit.
describe("build info", () => {
  test("versionString appends the build sha only when there is one", () => {
    expect(versionString("0.12.0", "abc1234")).toBe("0.12.0+abc1234");
    expect(versionString("0.12.0", null)).toBe("0.12.0");
  });

  test("warns when the binary's commit differs from the repo HEAD", () => {
    const w = staleBuildWarning("4172dec", "142f4bd0123");
    expect(w).toContain("4172dec");
    expect(w).toContain("142f4bd");
    expect(w).toContain("bun run build");
  });

  test("silent when they match (short vs long sha), or either side is unknown", () => {
    expect(staleBuildWarning("4172dec", "4172dec9999")).toBeNull();
    expect(staleBuildWarning("4172dec-dirty", "4172dec9999")).toBeNull();
    expect(staleBuildWarning(null, "4172dec")).toBeNull();
    expect(staleBuildWarning("4172dec", null)).toBeNull();
  });

  test("repoHead is null outside a pg-analyser checkout", () => {
    const dir = mkdtempSync(join(tmpdir(), "pga-"));
    expect(repoHead(dir)).toBeNull();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "something-else" }));
    expect(repoHead(dir)).toBeNull();
  });

  test("repoHead returns this checkout's HEAD", () => {
    const head = repoHead(process.cwd());
    expect(head).toMatch(/^[0-9a-f]{7,40}$/);
  });
});
