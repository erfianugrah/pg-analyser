import { z } from "zod";
import { Advisor, type SqlRow } from "./schemas.ts";
// Bun embeds this at build time, so the compiled binary stays self-contained.
import SPLINTER_SQL from "./splinter.sql" with { type: "text" };
import type { SqlRunner } from "./sqlrunner.ts";

/**
 * Self-hosted Performance Advisor. Supabase's hosted `advisors/performance`
 * endpoint runs the `splinter` lint SQL server-side and currently 400s on the
 * multi-statement storage-buckets lint (SQLSTATE 42601, prepared-statement
 * path). When a superuser `--db-url` is available we run the same splinter SQL
 * ourselves over the simple-query protocol, which tolerates multiple statements
 * in one command - giving PERFORMANCE lints regardless of the hosted bug.
 */

export { SPLINTER_SQL };

/** Validate all splinter lint rows against the Advisor schema. */
export function parseSplinterLints(rows: unknown[]): Advisor[] {
  return z.array(Advisor).parse(rows);
}

const inCategory = (l: Advisor, cat: string) => (l.categories ?? []).includes(cat);

/** Keep only PERFORMANCE-category lints. */
export function parseSplinterPerfLints(rows: unknown[]): Advisor[] {
  return parseSplinterLints(rows).filter((l) => inCategory(l, "PERFORMANCE"));
}

/** Keep only SECURITY-category lints. */
export function parseSplinterSecurityLints(rows: unknown[]): Advisor[] {
  return parseSplinterLints(rows).filter((l) => inCategory(l, "SECURITY"));
}

/**
 * Run splinter over a multi-statement-capable runner (DirectSqlRunner) and
 * return ALL validated lints (both PERFORMANCE and SECURITY). The lint SELECT
 * is the largest of the result sets returned (the leading `set local` /
 * `do $$..$$` setup statements return empty sets). Returns [] on a runner
 * without multi-statement support (the PAT read-only tier). Caller filters by
 * category - running once populates both advisor planes in no-PAT mode.
 */
export async function collectSplinterLints(runner: SqlRunner): Promise<Advisor[]> {
  if (!runner.runMulti) return [];
  const sets = await runner.runMulti(SPLINTER_SQL);
  let lints: SqlRow[] = [];
  for (const s of sets) if (s.length > lints.length) lints = s;
  return parseSplinterLints(lints);
}

/** Back-compat: perf-only splinter collection. */
export async function collectSplinterPerfLints(runner: SqlRunner): Promise<Advisor[]> {
  return (await collectSplinterLints(runner)).filter((l) => inCategory(l, "PERFORMANCE"));
}
