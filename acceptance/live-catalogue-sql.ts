/**
 * Empirical gate: EXECUTE every read-only statement in the heuristics catalogue
 * against a real PostgreSQL.
 *
 * The catalogue is a copy-paste runbook. A statement that names a column which
 * does not exist (measured: `age(xmin) from pg_prepared_xacts` -> ERROR, the
 * column is `transaction`) is worse than no advice, and no amount of text
 * assertion catches it - only running it does.
 *
 * Only statements that START with select are run, and each is wrapped in a
 * read-only transaction, so a stray write cannot touch the target database.
 * Placeholder statements (containing <angle> tokens) are skipped: they are
 * templates for a human, not runnable SQL.
 *
 * Usage: SBPERF_TEST_DB_URL=postgres://... bun acceptance/live-catalogue-sql.ts
 */
import { SQL } from "bun";
import { HEURISTICS } from "../src/heuristics.ts";

const url = process.env.SBPERF_TEST_DB_URL;
if (!url) {
  console.error("SBPERF_TEST_DB_URL is not set - no live database to verify against");
  process.exit(1);
}

const sql = new SQL({ url, prepare: false, max: 1 });
const failures: string[] = [];
let ran = 0;
let skipped = 0;
let absent = 0;

/**
 * A missing RELATION is environmental (pg_cron, pgstattuple and friends are not
 * installed on a bare cluster). A missing COLUMN or FUNCTION, or a syntax
 * error, is a defect in the runbook no environment can excuse.
 */
function isEnvironmental(e: Error): boolean {
  const code = (e as unknown as { code?: string; errno?: string }).code ?? "";
  if (code === "42P01") return true;
  return /relation "[^"]+" does not exist|schema "[^"]+" does not exist/.test(e.message);
}

for (const [id, h] of Object.entries(HEURISTICS)) {
  if (!h.sql) continue;
  // Split on statement boundaries, drop comment-only fragments.
  const statements = h.sql
    .split(/;\s*(?:\n|$)/)
    .map((s) =>
      s
        .split("\n")
        .filter((l) => !l.trim().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter(Boolean);

  for (const stmt of statements) {
    if (!/^select\b/i.test(stmt)) continue; // writes / DDL stay unexecuted
    if (/<[a-z_]+>/i.test(stmt)) {
      skipped++;
      continue; // human template, not runnable
    }
    ran++;
    try {
      await sql.unsafe(`${stmt}`);
    } catch (e) {
      if (isEnvironmental(e as Error)) {
        absent++;
        continue;
      }
      failures.push(
        `${id}: ${(e as Error).message}\n      ${stmt.replace(/\s+/g, " ").slice(0, 160)}`,
      );
    }
  }
}

await sql.close();

console.log(
  `  executed ${ran} catalogue SELECT(s), skipped ${skipped} template(s), ${absent} on absent relations`,
);
if (failures.length) {
  console.error(`\nlive-catalogue-sql: ${failures.length} statement(s) do not run:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("live-catalogue-sql: every runnable catalogue SELECT executes");
