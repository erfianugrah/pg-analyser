// Which commit a compiled binary was built from, and whether the checkout it is
// run in has moved on since. `bun run build` (scripts/build.ts) defines
// PG_ANALYSER_BUILD_SHA; `bun run src/index.ts` leaves it undefined, which is
// fine because running from source is always current.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

declare const PG_ANALYSER_BUILD_SHA: string | undefined;

export const BUILD_SHA: string | null =
  typeof PG_ANALYSER_BUILD_SHA === "string" && PG_ANALYSER_BUILD_SHA.length > 0
    ? PG_ANALYSER_BUILD_SHA
    : null;

export function versionString(version: string, sha: string | null): string {
  return sha ? `${version}+${sha}` : version;
}

/** HEAD of the pg-analyser checkout at `dir`, or null when `dir` is not one. */
export function repoHead(dir: string): string | null {
  try {
    const pkgPath = join(dir, "package.json");
    if (!existsSync(pkgPath)) return null;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string };
    if (pkg.name !== "pg-analyser") return null;
    const res = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: dir, stderr: "ignore" });
    if (res.exitCode !== 0) return null;
    const sha = res.stdout.toString().trim();
    return /^[0-9a-f]{7,40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/** A one-line stderr warning when the binary predates the checkout, else null. */
export function staleBuildWarning(buildSha: string | null, head: string | null): string | null {
  if (!buildSha || !head) return null;
  const base = buildSha.replace(/-dirty$/, "");
  if (head.startsWith(base) || base.startsWith(head)) return null;
  return `warning: this pg-analyser binary was built from ${base}, but the checkout here is at ${head.slice(0, 7)}; rebuild with \`bun run build && mv pg-analyser ~/.local/bin/\``;
}
