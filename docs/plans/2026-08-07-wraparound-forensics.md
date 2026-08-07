# Wraparound forensics - implementation plan

> **For agentic workers:** this plan is driven by the self-correcting loop
> (`.pi/harness.json`). The acceptance suite in `acceptance/` is the contract;
> it is OUTSIDE the write scope and cannot be edited. Work task-by-task, run
> `bun test acceptance/` to see what is still red.

**Goal:** turn sbperf's transaction-ID reporting from "this table has age N" into
the support-runbook answer: *which* xmin holder is blocking the freeze, *how much
headroom is left in transactions and in days*, and *what to run, in what order*.
Today the tool can tell a reader they have age; it cannot tell them why the age
is not falling, and its warn threshold sits above the age at which a blocked
freeze is already provable.

**Architecture:** no new bounded context. The work lands in the existing planes:
SQL query set (`src/sql.ts`), collection (`src/collect.ts`), schema
(`src/schemas.ts`), ranking (`src/findings.ts`), catalogue (`src/heuristics.ts`),
history (`src/store.ts`), report (`src/report/render.ts`), plus ONE new pure
module `src/freezelog.ts` (a sibling of `src/locklog.ts`: bounded server-log tail
-> parsed freeze/wraparound warnings).

**Tech stack:** Bun + TypeScript (strict, `noUncheckedIndexedAccess`), zod 4 at
boundaries, biome 2, `bun test`. No new dependency; nothing here crosses the
network.

**Standing constraint - sbperf is READ-ONLY.** Every remediation is emitted as
copy-pasteable SQL for a human. sbperf never drops a slot, never rolls back a
prepared transaction, never terminates a backend, never runs VACUUM. A task that
adds a write path is a failed task.

**Second standing constraint - no customer, org, or person names anywhere.**
This work was motivated by a field incident; nothing identifying it belongs in
the repo, in a test fixture, in a comment, or in a commit message.

---

## Verified against the repo and upstream on 2026-08-07

Read directly, not recalled:

- `THRESHOLDS.txidWarnPct = 20` / `txidHighPct = 40` (`src/heuristics.ts:78-79`),
  evaluated against a hardcoded 2e9 denominator in `QUERIES.txidWraparound`
  (`src/sql.ts:766`) and in `deriveFindings` (`src/findings.ts:1251-1259`). 20%
  of 2e9 is 400M, so a table at 200M age produces NO finding today.
- `QUERIES.txidWraparound` selects `age(c.relfrozenxid)` only. It does NOT join
  `pg_class t ON c.reltoastrelid = t.oid`, so a relation whose TOAST table is the
  oldest is invisible. Same in `QUERIES.multixactWraparound` (`src/sql.ts:1082`),
  which reads `mxid_age(c.relminmxid)` on the main relation only.
- Both queries exclude `pg_catalog`, `information_schema`, `pg_toast`.
- `QUERIES.replicationSlots` (`src/sql.ts:806`) selects `slot_name, slot_type,
  active, retained_wal, retained_wal_bytes`. It does NOT select `wal_status`,
  `xmin`, `catalog_xmin`, or `active_pid`.
- There is no `pg_prepared_xacts` query and no `backend_xmin` / `backend_xid`
  projection anywhere in `src/` (grepped).
- `QUERIES.longRunning` (`src/sql.ts:884`) filters `state <> 'idle'` AND
  `backend_type = 'client backend'` AND `query_start > 5 minutes`, so an
  idle-in-transaction backend or a walsender pinning an old xmin is not in it.
- `QUERIES.pgSettings` (`src/sql.ts:114`) allowlists 21 GUCs; NONE of the
  autovacuum freeze knobs (`autovacuum_freeze_max_age`,
  `autovacuum_multixact_freeze_max_age`, `vacuum_freeze_min_age`,
  `vacuum_freeze_table_age`, `autovacuum_max_workers`,
  `autovacuum_vacuum_cost_delay`, `autovacuum_vacuum_cost_limit`,
  `autovacuum_naptime`, `hot_standby_feedback`) are present.
- `SCALAR_KEYS` in `src/store.ts:113` trends exactly three keys:
  `cache_hit_pct`, `index_hit_pct`, `slot_wal_retained_max_bytes`.
- The report renders `drill("txid", ...)` at `src/report/render.ts:1064` and
  `drill("slots", ...)` at `:1067`; drill ids are the overlay-hideable ids.
- `src/locklog.ts` is the precedent for log parsing: a pure module over the text
  the bounded superuser tail (`logTailQuery`, `src/sql.ts:1213`) returns.
  `logDirProbe` is gated to `runner.source === "superuser"` in `collect.ts`.
- Findings carry `heuristicId` (`src/findings.ts:26`); `meta(id)` copies the
  catalogue entry onto the finding. `Plane` (`src/heuristics.ts:207`) already
  includes `"Vacuum"`.
- `test/sql.test.ts` asserts every entry of `QUERIES` is a read-only
  SELECT/CTE - a new query with a write keyword outside a string literal fails
  that test automatically.

Upstream (`/docs/postgres/routine-vacuuming.md`, PostgreSQL routine-vacuuming,
section "Preventing Transaction ID Wraparound Failures"):

- Postgres starts emitting `WARNING: database "x" must be vacuumed within N
  transactions` when the oldest XID reaches **forty million** from the wraparound
  point, and refuses new XIDs (`ERROR: database is not accepting commands that
  assign new XIDs to avoid wraparound data loss`) at **three million** remaining.
  These two numbers are the only non-arbitrary severity boundaries available.
- The documented recovery ORDER is: (1) resolve old prepared transactions
  (`pg_prepared_xacts`), (2) end long-running transactions (`pg_stat_activity`
  where `age(backend_xid)` / `age(backend_xmin)` is large), (3) drop old
  replication slots (`age(xmin)` / `age(catalog_xmin)` large), (4) THEN vacuum,
  (5) fix autovacuum config. Vacuum is step four, not step one.
- Upstream is explicit that in the emergency window you use plain `VACUUM`:
  `VACUUM FULL` requires an XID and fails (or consumes one), and `VACUUM FREEZE`
  "will do more than the minimum amount of work required".
- A manual `VACUUM` must be run **by a superuser**, else it cannot process system
  catalogs and therefore cannot advance the database's `datfrozenxid`. On hosted
  Supabase the `postgres` role is not that superuser, so this caveat is load
  bearing for our readers.

Operator-supplied field threshold (support practice, not upstream): a table that
has consumed **more than 200 million** transaction IDs is treated as strong
evidence the freeze is blocked rather than merely lagging, and "remaining" is
computed as `2^31 - 1000000 - age`.

---

## Empirically verified on a throwaway PostgreSQL 18.4 cluster (2026-08-07)

Every candidate query below was executed against a disposable local cluster
(`initdb` in `/tmp`, `wal_level=logical`, `max_prepared_transactions=4`) with a
real logical slot, a real physical slot, a real prepared transaction and a real
open transaction holding an xmin. Do not re-derive these from memory; they are
measurements.

1. **`greatest()` ignores NULL** - `greatest(5, NULL::int)` returns 5. So the
   `LEFT JOIN pg_class t ON c.reltoastrelid = t.oid` is safe: a table with no
   TOAST relation ranks on its own age, no `coalesce` needed.
2. **`2^31` is `double precision`, not an integer.** `select pg_typeof(2^31 -
   1000000 - 100)` returns `double precision`. The `remaining` column MUST be
   cast (`(...)::bigint`) or the JSON carries a float. Measured ceiling:
   `2^31 - 1000000 = 2146483648`.
3. **Partitioned parents are a trap.** A `relkind = 'p'` row has
   `relfrozenxid = 0`, and `age('0'::xid)` measured **2147483647** - i.e. adding
   `'p'` to the relkind filter would report every partitioned table as one
   transaction from wraparound. Keep `relkind in ('r','m')`.
4. **An unpopulated materialized view is NOT a trap** - `CREATE MATERIALIZED
   VIEW ... WITH NO DATA` still carries a normal `relfrozenxid` (measured age 2
   on a fresh cluster), so no `relispopulated` special case is needed.
5. **`age(NULL)` is NULL.** A physical slot with no reservation has NULL `xmin`
   AND NULL `catalog_xmin`; a logical slot has `catalog_xmin` set and `xmin`
   NULL. Every holder query needs `order by ... desc nulls last`, and every
   finding must treat a null age as "not a holder", never as zero.
6. **The collecting backend shows up in its own holder query** with `xmin_age`
   0. `QUERIES.xminHolders` MUST carry `pid <> pg_backend_pid()`, the same
   idiom `waitEventSample` already uses.
7. **Privileges (this changes what the PAT tier can see).** As a plain role with
   only `pg_read_all_data` (no `pg_monitor`, no superuser):
   - `pg_prepared_xacts`, `pg_replication_slots` (including `catalog_xmin` and
     `wal_status`), `pg_stat_replication` and `pg_database` are all readable.
   - `pg_stat_activity` rows for OTHER users are visible and
     **`age(backend_xmin)` / `age(backend_xid)` are populated**, but `state`,
     `backend_type` are NULL and `query` reads `<insufficient privilege>`.
     Granting `pg_monitor` unmasks them (measured both ways).
   Consequence for Task 4: the holder finding must key off the AGE, never off
   `state` / `query`, and should say the identifying columns may be masked on
   the read-only tier rather than printing `<insufficient privilege>` as if it
   were a query. None of these queries need tier-gating.
8. **`wal_status` values** (docs, `/docs/postgres/view-pg-replication-slots.md`):
   `reserved`, `extended`, `unreserved`, `lost`. `lost` means "this slot is no
   longer usable", and `safe_wal_size` is NULL for a lost slot. Do NOT use
   `invalidation_reason` (added after the Postgres versions Supabase runs).
9. **Both baseline defects reproduced in-repo**, via `deriveFindings` on a
   fixture (not by reading the code):
   - a table at `xid_age` 250,000,000 produces `[]` - zero findings;
   - a slot with `wal_status = 'lost'` produces exactly one finding, high:
     *"1 inactive replication slot retaining WAL (pins disk until dropped)"* -
     which is not merely thin, it is wrong: a lost slot has already stopped
     retaining WAL. The user is told to reclaim disk when the real problem is a
     broken consumer and a pinned horizon.

---

## Constants this plan introduces

All exported from `src/heuristics.ts` next to `THRESHOLDS`, each with the comment
that states where the number comes from. Do not invent extra ones.

| name | value | provenance |
|---|---|---|
| `XID_CEILING` | `2 ** 31 - 1_000_000` | operator runbook's "remaining" denominator |
| `freezeBlockedAge` | `200_000_000` | operator runbook: above this, treat freeze as blocked |
| `freezeWarnRemaining` | `40_000_000` | Postgres starts logging "must be vacuumed within N" |
| `freezeStopRemaining` | `3_000_000` | Postgres refuses new XIDs |
| `xminHolderAge` | `50_000_000` | CHOSEN, not derived: a quarter of `freezeBlockedAge`. An xmin holder this old cannot be a transient query. Exported so it can be tuned. |
| `freezeProjectionDays` | `90` | CHOSEN: project to the ceiling and report when the ETA is inside a quarter. |

`txidWarnPct` / `txidHighPct` stay for the percentage view but STOP being the
only rung (Task 3).

---

## Task 1 - freeze-age query correctness

**Files:** `src/sql.ts`, `src/schemas.ts`, `src/collect.ts`, `test/sql.test.ts`.

- [ ] Write the test first in `test/sql.test.ts`: `QUERIES.txidWraparound`
      contains `reltoastrelid`, `greatest(`, and a `remaining` column;
      `QUERIES.multixactWraparound` likewise; `QUERIES.databaseFreezeAge`
      contains `pg_database` and `datfrozenxid`.
- [ ] Extend `QUERIES.txidWraparound` to `LEFT JOIN pg_class t ON c.reltoastrelid
      = t.oid` and rank on `greatest(age(c.relfrozenxid), age(t.relfrozenxid))`.
      Emit columns: `schema`, `table`, `xid_age` (the greatest), `toast_age`
      (nullable), `remaining` (`XID_CEILING - xid_age`, computed in SQL as
      `(2^31 - 1000000 - greatest(...))::bigint` - the cast is REQUIRED, `2^31`
      is double precision), `pct_wraparound` (unchanged formula, so existing
      findings keep working). Keep `relkind in ('r','m')`: a partitioned parent
      has `relfrozenxid = 0`, which ages to 2147483647 (measured).
- [ ] Same TOAST treatment for `QUERIES.multixactWraparound` using
      `mxid_age(...relminmxid)` and a `remaining` column.
- [ ] Add `QUERIES.databaseFreezeAge`: one row per database from `pg_database` -
      `datname`, `age(datfrozenxid) as xid_age`, `mxid_age(datminmxid) as
      mxid_age`, `remaining`. This is the AUTHORITATIVE number (it includes
      catalogs, which the per-table query excludes and which a logical slot's
      `catalog_xmin` ages first). Both tiers - `pg_database` is world readable.
- [ ] Add the plane field `databaseFreezeAge: SqlRows.default([])` to
      `src/schemas.ts` and wire `sql("databaseFreezeAge")` into the
      `Promise.all` in `src/collect.ts` (both the destructure and the returned
      object - they are positional, keep them aligned).

**Why the per-table query keeps its schema exclusion:** the per-table list is the
ACTIONABLE list (a reader can vacuum their own table; they cannot vacuum
`pg_catalog` selectively, and a catalog-driven age is a horizon problem, not a
per-table one). The DB-level row is what closes the coverage gap.

**Verify:** `bun test test/sql.test.ts && bun run typecheck`.

---

## Task 2 - xmin-horizon blocker planes

This is the task that makes the report say *why*. Four holder classes; Postgres
documents exactly these.

**Files:** `src/sql.ts`, `src/schemas.ts`, `src/collect.ts`, `test/sql.test.ts`.

- [ ] Test first: each new query key exists, is read-only (already enforced
      globally by `test/sql.test.ts`), and names the view it reads.
- [ ] Extend `QUERIES.replicationSlots` with `wal_status`, `xmin`,
      `catalog_xmin`, `active_pid`, plus `age(xmin)` and `age(catalog_xmin)` as
      `xmin_age` / `catalog_xmin_age` (nullable - measured: a physical slot has
      both NULL, a logical slot has `catalog_xmin` set and `xmin` NULL; sort
      `nulls last`). Do not add `invalidation_reason` (too new for the Postgres
      versions Supabase runs).
      Keep every existing column: `retained_wal_bytes` is consumed by
      `store.ts`'s `slot_wal_retained_max_bytes` scalar and by two findings.
- [ ] Add `QUERIES.preparedXacts`: `gid`, `database`, `owner`, `prepared` (text),
      `age(transaction) as xid_age` from `pg_prepared_xacts`. World readable;
      normally empty.
- [ ] Add `QUERIES.xminHolders`: from `pg_stat_activity` where `backend_xmin IS
      NOT NULL OR backend_xid IS NOT NULL`, project `pid`, `datname`, `usename`,
      `state`, `backend_type`, `age(backend_xmin) as xmin_age`,
      `age(backend_xid) as xid_age`, `extract(epoch from (now() - xact_start))`
      as `xact_age_s`, and a truncated `query` (reuse the
      `left(regexp_replace(query, '\\s+', ' ', 'g'), 120)` idiom already used by
      `longRunning`). Order by `greatest(age(backend_xmin), age(backend_xid))
      desc nulls last`, limit 10, and exclude the collecting session with
      `pid <> pg_backend_pid()` (measured: it otherwise reports itself at age 0).
      Do NOT filter by `backend_type` or `state` here - a walsender or an
      idle-in-transaction backend holding an ancient xmin is exactly the thing
      `longRunning` was designed to exclude and this query exists to catch, and
      on the read-only tier those two columns are NULL anyway (measured).
- [ ] Add `QUERIES.replicationXmin`: from `pg_stat_replication` -
      `application_name`, `state`, `sync_state`, `age(backend_xmin) as
      xmin_age`. This is the `hot_standby_feedback` holder class (a read replica
      pinning the primary's horizon). May be denied on the PAT tier; that is
      what `safe()` is for, so do NOT tier-gate it.
- [ ] Add all four as `SqlRows.default([])` plane fields (`preparedXacts`,
      `xminHolders`, `replicationXmin`) in `src/schemas.ts` and wire them into
      `collect.ts`.

**Verify:** `bun test test/sql.test.ts test/schemas.test.ts test/collect.test.ts`.

---

## Task 3 - severity re-calibration

**Files:** `src/heuristics.ts` (constants), `src/findings.ts`, `test/findings.test.ts`.

- [ ] Test first: a fixture whose worst table has `xid_age` 250_000_000 and
      `remaining` 1_897_483_647 produces a finding with
      `heuristicId === "txid_wraparound"` (today it produces nothing);
      a fixture at 30_000_000 remaining is `high`; at 2_000_000 remaining the
      finding title states writes are already being refused.
- [ ] Add the constants from the table above to `THRESHOLDS` (or as sibling
      exports where a raw count reads better than a percentage).
- [ ] Rewrite the txid branch in `deriveFindings` to rank on the ABSOLUTE
      numbers, falling back to the pct only when `remaining` is absent (old
      `analysis.json` files predate the column - keep them renderable):
      - `remaining <= freezeStopRemaining` -> high, title says XID assignment is
        refused (this is an outage, not a risk).
      - `remaining <= freezeWarnRemaining` -> high, title cites the Postgres
        warning threshold.
      - `xid_age >= freezeBlockedAge` -> med by default; **high when a blocker
        from Task 2 is present** (see Task 4).
      - else keep the existing pct rungs.
- [ ] Title and evidence must carry BOTH numbers: age consumed and transactions
      remaining. A percentage of an arbitrary 2e9 denominator is not an operator
      number; "1.9B transactions remaining" is.
- [ ] Apply the same absolute treatment to the multixact branch (its ceiling and
      its `remaining` are separate; do not share a variable).
- [ ] The DB-level row from Task 1 takes precedence over the per-table max when
      it is larger (it includes catalogs). Report which one drove the number.

**Verify:** `bun test test/findings.test.ts`.

---

## Task 4 - blocker-attributed findings

**Files:** `src/findings.ts`, `src/heuristics.ts`, `test/findings.test.ts`.

- [ ] Test first, one case per holder class, each asserting the heuristic id and
      that the finding names the offending object (slot name / gid / pid).
- [ ] `xmin_horizon_blocked` (Capacity, high when freeze age is also past
      `freezeBlockedAge`, else med): fires when any of - a slot with
      `wal_status = 'lost'`, a slot with `xmin_age`/`catalog_xmin_age >=
      xminHolderAge`, a prepared xact with `xid_age >= xminHolderAge`, a
      `pg_stat_activity` row with `xmin_age`/`xid_age >= xminHolderAge`, or a
      `pg_stat_replication` row with `xmin_age >= xminHolderAge`. The title
      names the WORST holder and its class; the evidence lists the rest.
- [ ] `replication_slot_lost` (Capacity, high): a slot with `wal_status =
      'lost'` is invalidated - it is no longer usable AND it stops pinning WAL,
      but its consumer is broken. This must NOT be reported merely as "inactive
      slot retaining WAL" (the existing `wal_retained_inactive_slot` finding).
      Suppress that one for slots already reported as lost, the same way advisor
      lints suppress their SQL fallbacks.
- [ ] `prepared_xact_old` (Capacity, med; high past `xminHolderAge`): an orphaned
      two-phase commit. Supabase projects rarely use 2PC, so any row here is
      worth a card.
- [ ] `freeze_blocked_no_holder` (Capacity, high): `xid_age >= freezeBlockedAge`
      AND every holder query came back empty AND at least one of them actually
      ran (do not fire when the whole plane errored - check `a.errors`). This is
      the runbook's escalation branch: no explicable holder at this age means
      re-run with `--amcheck` and treat it as an incident. The card must say
      that plainly and must not speculate about the cause.
- [ ] Enrich the `txid_wraparound` finding's evidence with the named blocker when
      one exists, so the two cards read as one story rather than two coincidences.

**Verify:** `bun test test/findings.test.ts`.

---

## Task 5 - catalogue rewrite (the highest-value edit in this plan)

**Files:** `src/heuristics.ts`, `test/heuristics.test.ts`.

The current `txid_wraparound` entry tells the reader to VACUUM (FREEZE) first.
If an xmin holder exists, that vacuum CANNOT advance `relfrozenxid` past the
horizon: it runs, reports success, and changes nothing. The reader then concludes
the tool was wrong.

- [ ] Test first: `meta("txid_wraparound").remediation` mentions clearing the
      xmin holder BEFORE vacuum (assert ordering by index-of, not by exact
      wording); the `sql` block contains `pg_replication_slots`,
      `pg_prepared_xacts` and `pg_stat_activity`; `howToVerify` mentions
      `remaining`.
- [ ] Rewrite `txid_wraparound`: diagnose the horizon first (the three views),
      clear the holder, then vacuum. State the superuser caveat (a non-superuser
      VACUUM cannot advance `datfrozenxid` because it cannot process catalogs).
- [ ] Fix the two verified-wrong specifics: at the emergency stage use plain
      `VACUUM`, NOT `VACUUM FULL` (needs an XID) and NOT `VACUUM FREEZE` (more
      work than required). Keep `VACUUM (FREEZE)` only in the non-emergency,
      no-blocker, catch-up case and say which case is which.
- [ ] Add catalogue entries for every heuristic id introduced in Task 4, each
      with `whyItMatters`, `remediation`, `sql`, `howToVerify`, `docUrl`
      (`https://www.postgresql.org/docs/current/routine-vacuuming.html` for the
      wraparound family; the slot entries point at the replication-slots page).
      `plane: "Vacuum"` for the freeze family; the slot entries may use
      `"Storage"` where WAL retention is the consequence.
- [ ] Remediation strings are ASCII, one line, copy-pasteable - the existing
      catalogue convention.
- [ ] `bun run check:docurls` must stay green (every new `docUrl` 200s).

**Verify:** `bun test test/heuristics.test.ts && bun run check:docurls`.

---

## Task 6 - vacuum-tuning inputs

**Files:** `src/sql.ts`, `src/findings.ts`, `src/heuristics.ts`, tests.

- [ ] Test first: `QUERIES.pgSettings` contains `autovacuum_freeze_max_age`; a
      fixture with `autovacuum_freeze_max_age = 2000000000` (a value that
      disables the safety escalation in practice) produces
      `heuristicId === "autovacuum_freeze_tuning"`.
- [ ] Add to the `pgSettings` allowlist: `autovacuum`,
      `autovacuum_freeze_max_age`, `autovacuum_multixact_freeze_max_age`,
      `vacuum_freeze_min_age`, `vacuum_freeze_table_age`,
      `autovacuum_max_workers`, `autovacuum_naptime`,
      `autovacuum_vacuum_cost_delay`, `autovacuum_vacuum_cost_limit`,
      `hot_standby_feedback`.
- [ ] Add `autovacuum_freeze_tuning` to `configTuningFindings`: fires when
      `autovacuum` is off (high - nothing will ever freeze), or when
      `autovacuum_freeze_max_age` is set so high that the forced anti-wraparound
      vacuum would not trigger before `freezeBlockedAge` (med).
- [ ] Use the freeze knobs as CONTEXT on the txid finding: state whether the
      oldest table is already past `autovacuum_freeze_max_age` (i.e. Postgres
      should already be running an anti-wraparound vacuum on it - which, if the
      age is still climbing, is itself proof of a blocker).

**Verify:** `bun test test/findings.test.ts test/sql.test.ts`.

---

## Task 7 - headroom over time (the "how long do I have" answer)

**Files:** `src/store.ts`, `src/trends.ts`, `src/findings.ts`, `test/store.test.ts`,
`test/trends.test.ts`, `test/findings.test.ts`.

**Series-title contract** (the acceptance suite pins these strings, because
`trendstats.pointsOf(trends, title)` matches on the title): the store key
`txid_max_age` renders as the trend series **"Transaction-ID age (max)"** and
`mxid_max_age` as **"Multixact-ID age (max)"**, unit `""`. Add them to
`SCALAR_DEFS` in `src/trends.ts` alongside the existing three.

- [ ] Test first: snapshotting two analyses one day apart with `xid_age`
      100_000_000 then 150_000_000 stores a `txid_max_age` scalar for each, and
      a fixture carrying that series produces a `wraparound_projected` finding
      whose title contains a day count.
- [ ] Add to `SCALAR_KEYS`: `txid_max_age` (max `xid_age` across
      `txidWraparound`, or the DB-level row when larger), `mxid_max_age`,
      `xmin_holder_max_age` (max age across the Task 2 holder rows, null when
      none). Null-safe: `pick` returns `null` when the plane is empty, which the
      store already handles.
- [ ] Add `wraparound_projected` (Capacity): using `trendstats` -
      `sufficient()` gating (its defaults are 12 points over 3 days),
      `trendStat()` and `projectDaysTo()` - report days until
      `XID_CEILING` at the observed burn rate. Severity: high inside
      `freezeProjectionDays`, med inside 2x that, otherwise no finding.
      The card must state the observation window, because a projection from two
      snapshots is a straight line through two points and the reader deserves
      to know that.
- [ ] Do NOT emit a projection when `sufficient()` is false. A fabricated ETA is
      worse than no ETA - this is the same rule the existing capacity findings
      already follow.

**Verify:** `bun test test/store.test.ts test/findings.test.ts`.

---

## Task 8 - the log evidence (new module `src/freezelog.ts`)

The detection signal for this failure mode is a server-log line, and the
repo already has the machinery to read one (bounded superuser tail + a pure
parser). This closes the loop: sbperf sees from inside the database what the
platform saw from outside.

**Files:** `src/freezelog.ts` (new), `src/collect.ts`, `src/schemas.ts`,
`src/findings.ts`, `src/heuristics.ts`, `test/freezelog.test.ts` (new).

- [ ] Test first, against synthetic log text (no live server): the parser
      extracts (a) `must be vacuumed within N transactions` -> the smallest N
      seen and its timestamp, (b) `oldest xmin is far in the past`, (c)
      `to prevent wraparound` autovacuum lines with the relation named, and
      returns null/empty for unrelated log text.
- [ ] Implement `parseFreezeLog(text: string): FreezeLogSummary | null` in
      `src/freezelog.ts`. Pure, no I/O, no dependency - copy the shape of
      `src/locklog.ts` (regexes at module scope, one pass over lines, a bounded
      sample of matching lines kept for evidence). **Shape contract** (pinned by
      the acceptance suite):
      `{ mustVacuumWithin: number | null, oldestXminWarnings: number,
         antiWraparoundVacuums: number, relations: string[], samples: string[] }`,
      and `null` when the text contains none of the three patterns.
      `mustVacuumWithin` is the SMALLEST N seen (worst moment in the window).
- [ ] The two upstream-documented strings are quoted verbatim in the doc block
      above the regexes. The `oldest xmin` and `to prevent wraparound` variants
      are NOT quoted in the Postgres docs we have; mark them in a comment as
      pattern-matched from field reports and keep the parser tolerant (do not
      anchor on surrounding punctuation), so a wording difference degrades to a
      miss rather than a crash.
- [ ] Wire it where `lockWave` is wired in `collect.ts` (same superuser gate,
      same log tail - do NOT read the log twice; reuse the text already read).
- [ ] Add plane field `freezeLog` (nullable object, `.default(null)` or
      `.nullable()` per the existing `lockWave` shape) and a finding
      `wraparound_log_warning` (Capacity, high): Postgres itself is warning.
      This is the strongest possible evidence and outranks every estimate -
      when it fires, the other freeze findings cite it.

**Verify:** `bun test test/freezelog.test.ts && bun run typecheck`.

---

## Task 9 - report + fleet index

**Files:** `src/report/render.ts`, `test/render.test.ts`.

- [ ] Test first: rendering an analysis with holder rows produces a section
      whose id is `xmin`, and the freeze section shows `remaining`.
- [ ] Extend the `txid` drill to show `xid_age`, `toast_age`, `remaining`, plus
      the DB-level row.
- [ ] Add `drill("xmin", "Transaction-horizon holders", ...)` rendering the four
      holder planes (slots with xmin, prepared xacts, activity holders, standby
      feedback) as one section. Empty planes render nothing, per the existing
      point-in-time convention.
- [ ] Extend the slots drill with `wal_status` and the two xmin ages.
- [ ] Fleet index: add a headroom column (transactions remaining, or the ETA in
      days when a projection exists) so a sweep answers "which project is at
      risk" without opening N reports. Keep it a plain column - no new colour
      scheme, no badge component (see the design ethos: density over decoration).
      This bullet is reviewed by the judge, not pinned by a sensor: the column's
      shape is a presentation choice and a sensor asserting its exact markup
      would be the over-specified kind that burns iterations.

**Verify:** `bun test test/render.test.ts`.

---

## Task 10 - documentation and drift checks

**Files:** `AGENTS.md`, `README.md`, `docs/` as needed, `scripts/check-*.ts`.

- [ ] Update the `sql.ts` inventory paragraph in `AGENTS.md` to name the new
      queries, and the `findings.ts` paragraph to name the new findings, in the
      same register as the existing text (dense, factual, no marketing).
- [ ] State the read-only stance explicitly where the new remediation SQL is
      described: sbperf PRINTS `pg_drop_replication_slot(...)` /
      `ROLLBACK PREPARED ...` / `pg_terminate_backend(...)`; it never runs them.
- [ ] `scripts/check-inspect-drift.ts` needs NO new manifest entry: none of
      these queries are derived from the upstream CLI's inspect set (they come
      from the Postgres routine-vacuuming docs and the support runbook). Say so
      in a comment rather than silently omitting them.
- [ ] Re-run every advisory check; none may regress:
      `bun run check:api && bun run check:inspect && bun run check:lints &&
      bun run check:schemas && bun run check:docurls`.

**Verify:** `bun run lint && bun run typecheck && bun test`.

---

## Explicitly out of scope

- **Any write path.** No auto-drop, no auto-rollback, no auto-terminate, no
  VACUUM execution. If a future operator wants that, it is a separate tool with
  a separate consent model.
- **A Prometheus alert rule for wraparound.** That belongs to
  `docs/plans/2026-08-04-alert-rules.md`. Note the dependency: no xid-age metric
  family was found in the captured corpus fixture, so an alert has to hang off
  the `txid_max_age` STORE scalar this plan adds (Task 7) plus
  `export-prometheus`. Do not add `alerts.ts` here.
- **Guessing at corruption.** Task 4's no-holder branch signposts `--amcheck`
  and stops. sbperf does not diagnose corruption from age alone.
- **Changing the 2e9 percentage denominator.** It stays for continuity with
  existing reports; the absolute numbers are added alongside it, not instead.

## Acceptance

The contract is `acceptance/wraparound.acceptance.test.ts` (outside the write
scope). Everything above must hold with `bun run lint`, `bun run typecheck`,
`bun test test/` and `bun test acceptance/` all green, and no new dependency in
`package.json`.
