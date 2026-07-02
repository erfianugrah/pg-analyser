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

/** Keep only PERFORMANCE-category lints, validated against the Advisor schema. */
export function parseSplinterPerfLints(rows: unknown[]): Advisor[] {
  return z
    .array(Advisor)
    .parse(rows)
    .filter((l) => (l.categories ?? []).includes("PERFORMANCE"));
}

/**
 * Run splinter over a multi-statement-capable runner (DirectSqlRunner). The
 * lint SELECT is the largest of the result sets returned (the leading
 * `set local` / `do $$..$$` setup statements return empty sets). Returns [] on
 * a runner without multi-statement support (the PAT read-only tier).
 */
export async function collectSplinterPerfLints(runner: SqlRunner): Promise<Advisor[]> {
  if (!runner.runMulti) return [];
  const sets = await runner.runMulti(SPLINTER_SQL);
  let lints: SqlRow[] = [];
  for (const s of sets) if (s.length > lints.length) lints = s;
  return parseSplinterPerfLints(lints);
}
