/**
 * Empirical gate: run the freeze / xmin-horizon queries against a REAL
 * PostgreSQL and check the arithmetic, not just the query text.
 *
 * Text assertions (acceptance/a1, a2) cannot catch a query that parses but
 * computes the wrong number - e.g. `(2::bigint << 31)` instead of
 * `(1::bigint << 31)`, which overshoots "remaining" by a whole ceiling. This
 * script executes each query and checks the invariant that the acceptance
 * suite can only assume:  xid_age + remaining == 2^31 - 1000000.
 *
 * Usage: SBPERF_TEST_DB_URL=postgres://... bun acceptance/live-sql.ts
 *
 * Any Postgres will do - a throwaway cluster is enough:
 *   initdb -D /tmp/pg -U postgres --auth=trust
 *   pg_ctl -D /tmp/pg -o "-h 127.0.0.1 -p 55433 -c wal_level=logical \
 *     -c max_prepared_transactions=4" -l /tmp/pg.log start
 * Exits 0 on success, 1 with a diagnosis on failure.
 */
import { SQL } from "bun";
import { QUERIES } from "../src/sql.ts";

const url = process.env.SBPERF_TEST_DB_URL;
if (!url) {
  console.error("SBPERF_TEST_DB_URL is not set - no live database to verify against");
  process.exit(1);
}

const CEILING = 2 ** 31 - 1_000_000;
const failures: string[] = [];
const note = (m: string) => console.log(`  ${m}`);

const sql = new SQL({ url, prepare: false, max: 1 });

type Row = Record<string, unknown>;
const num = (v: unknown): number | null => {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

async function run(key: string): Promise<Row[]> {
  const q = (QUERIES as unknown as Record<string, string | undefined>)[key];
  if (!q) {
    failures.push(`QUERIES.${key} does not exist`);
    return [];
  }
  try {
    return (await sql.unsafe(q)) as unknown as Row[];
  } catch (e) {
    failures.push(`QUERIES.${key} failed to execute: ${(e as Error).message}`);
    return [];
  }
}

/** xid_age + remaining must land on the ceiling the whole plan is written against. */
function checkCeiling(key: string, rows: Row[], ageCol: string) {
  for (const r of rows.slice(0, 5)) {
    const age = num(r[ageCol]);
    const remaining = num(r.remaining);
    if (age == null) {
      failures.push(`QUERIES.${key}: row has no numeric ${ageCol} (got ${String(r[ageCol])})`);
      return;
    }
    if (remaining == null) {
      failures.push(`QUERIES.${key}: row has no numeric remaining (got ${String(r.remaining)})`);
      return;
    }
    if (Math.abs(age + remaining - CEILING) > 1) {
      failures.push(
        `QUERIES.${key}: ${ageCol} + remaining = ${age + remaining}, expected ${CEILING} ` +
          `(off by ${age + remaining - CEILING}) - check the ceiling expression in the SQL`,
      );
      return;
    }
  }
  note(`${key}: ${rows.length} row(s), ceiling arithmetic ok`);
}

const txid = await run("txidWraparound");
checkCeiling("txidWraparound", txid, "xid_age");

const mxid = await run("multixactWraparound");
if (mxid.length) {
  const ageCol = "mxid_age" in (mxid[0] ?? {}) ? "mxid_age" : "xid_age";
  checkCeiling("multixactWraparound", mxid, ageCol);
}

const dbf = await run("databaseFreezeAge");
checkCeiling("databaseFreezeAge", dbf, "xid_age");
if (dbf.length === 0) failures.push("QUERIES.databaseFreezeAge returned no rows on a live cluster");

// The holder planes: they must EXECUTE and expose the columns the findings read.
const slots = await run("replicationSlots");
for (const col of ["slot_name", "wal_status", "xmin_age", "catalog_xmin_age"]) {
  if (slots.length && !(col in (slots[0] ?? {})))
    failures.push(`QUERIES.replicationSlots: no ${col} column in the live result`);
}
if (slots.length) note(`replicationSlots: ${slots.length} row(s), columns ok`);

const prepared = await run("preparedXacts");
note(`preparedXacts: ${prepared.length} row(s)`);
for (const col of ["gid", "xid_age"]) {
  if (prepared.length && !(col in (prepared[0] ?? {})))
    failures.push(`QUERIES.preparedXacts: no ${col} column in the live result`);
}

const holders = await run("xminHolders");
note(`xminHolders: ${holders.length} row(s)`);
if (holders.some((r) => num(r.xmin_age) === 0 && num(r.pid) === null))
  failures.push("QUERIES.xminHolders: no pid column, so a holder cannot be named");

await run("replicationXmin");
note("replicationXmin: executed");

// The tuning knobs must actually come back from pg_settings.
const settings = await run("pgSettings");
const names = new Set(settings.map((r) => String(r.name)));
for (const k of ["autovacuum", "autovacuum_freeze_max_age", "vacuum_freeze_min_age"]) {
  if (!names.has(k)) failures.push(`QUERIES.pgSettings: ${k} did not come back from pg_settings`);
}
note(`pgSettings: ${settings.length} setting(s)`);

await sql.close();

if (failures.length) {
  console.error(`\nlive-sql: ${failures.length} failure(s)`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nlive-sql: all freeze / holder queries execute and agree with the ceiling");
