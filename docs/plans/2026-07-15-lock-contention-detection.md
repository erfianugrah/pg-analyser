# Lock-Contention Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect lock-queue cascades (a DDL statement queued behind long readers, then queueing every new reader behind it) on the tiers available in no-PAT mode - superuser `--db-url` + Grafana/Prometheus - and degrade honestly when a signal isn't reachable.

**Architecture:** Six independent checks, each gated to the tier it can actually run on. Retrospective log parsing (superuser `pg_read_file`, probe-gated), a native-resolution Prometheus incident scan (separate from the downsampled trend pass), a GUC-posture card (all tiers), a cron/DDL-collision annotation (reuses collected data), a stall-victim extension to the existing latency card, and point-in-time wait sampling. No new external dependency; every read is bounded by the session guard added in `72fe97b`.

**Tech Stack:** Bun + TypeScript (strict, `noUncheckedIndexedAccess`), zod 4, biome 2, `bun test`. Reuses `DirectSqlRunner` (superuser tier), `prometheus.ts` (`query_range`), `configTuningFindings`/`meta()` (findings + heuristics), `writeTargets()` (annotation style).

---

## Context the implementer needs

- **Tiers.** sbperf has three source tiers. This plan targets **no-PAT** (superuser `--db-url` + optional Grafana), because that is where the lock-contention signal was missing. Check 3 also runs in PAT mode (pure `pg_settings`). The Logflare analytics log endpoint is PAT-only and is deliberately **out of scope** - Check 1 reads log *files* over SQL instead.
- **Superuser gating is a hard `runner.source === "superuser"` check**, mirroring `hbaRules`/`walDirSize` in `collect.ts` (see `collect.ts:332,336`). The PAT read-only user (`supabase_read_only_user`) is denied `pg_ls_logdir`/`pg_read_file`/`pg_hba_file_rules` with 42501, so attempting them in PAT mode can only ever spam a warn. Gate, do not `safe()`-swallow.
- **Every `DirectSqlRunner.run()` carries a session guard** (`statement_timeout=120s`, `lock_timeout=15s`) since `72fe97b`. This is the "don't bring down a customer's primary" invariant. Any new query must stay inside it. For the log reads specifically: **each chunk read is its own `run()` call** (its own 120s bound) - never coalesce the 20 MB run-budget into one `pg_read_file`.
- **Privacy.** Raw log lines carry query text, DDL, and literals that the workload's parameterized queries hide. Store only the parsed summary + at most 5 sample lines, each truncated to 200 chars, in `analysis.json`. This is stricter than the evidence tables on purpose.
- **Honesty over coverage.** A quiet result over a 3-hour scanned window is a statement about 3 hours, not "clean". Every retrospective finding and evidence header must state the actual scanned/queried window. "Checked, clean" must be distinguishable from "not checked" (the same skipped-vs-clean principle the report footer already disclaims).
- **Settled design (do NOT re-litigate).** `lock_timeout = 0` cluster-wide is intentionally never flagged (`AGENTS.md:82-83`, `findings.ts:263`) - a global `lock_timeout` cancels legitimate waits. Check 3 therefore recommends only a *session/role-scoped* guardrail. This extends the settled position; it must not contradict it.
- **No customer identifiers in code, tests, or fixtures.** Use generic table names (`public.orders`, `public.events`), generic job names (`nightly-refresh`), and synthetic relids (`12345`) throughout. Real project refs / table names / job names must never appear in a tracked file.

### Corrections to the source spec (verified against the tree)

The v2 spec asserts three "reuse existing data" claims that are inaccurate; the tasks below fix them as prerequisites:

1. **`cronJobs.command` is NOT collected.** `sql.ts` `cronJobs` selects `schedule, active, avg_duration_s, max_duration_s` only. Check 4 (DDL-collision) needs the command text -> Task 8 adds `j.command` to the projection first.
2. **`rolconfig` is NOT projected.** `roleStats` selects `rolname, connections, ...` - `pg_roles` is queried but `rolconfig` isn't returned. Check 3 (Task 3) adds a dedicated `roleConfig` query; it is a new projection, not a reuse.
3. **Check 2 cannot reuse `fetchPanels`.** `prometheus.ts` forces `step = max(300, (end-start)/200)`, so a 7-day range resolves to ~3024s/step, not 300s. Task 6 adds a separate pinned-step `query_range` path.

### Risk framing (Check 1 is speculative, not the flagship)

Check 1's readability probe answers only *"can this session read a log directory?"*. Two other facts gate whether the retrospective parse is meaningful, and both are unknown until measured on a live project:

- **Retention:** Supabase ships logs via Vector/Logflare; local file rotation may be minutes, not hours. A readable logdir holding 90 seconds of lines cannot see a 10-minute-old incident.
- **Node identity:** the no-PAT `--db-url` is a *pooler* string; `pg_read_file` executes on whatever backend the transaction pooler routes to - not necessarily the node that logged the cascade.

Therefore Task 4 is a **three-fact probe** (readable + newest-file mtime span + node identity), and the parser (Task 5) is built only if the probe shows a usable retention window. If the probe fails or retention is sub-incident, Check 1 collapses to one collection note and **Check 2 (Prometheus) is the real retrospective channel.** The plan is sequenced so nothing is wasted if Check 1 proves unusable.

---

## File Structure

- **Create `src/locklog.ts`** - log-line parser (phrase regexes -> `LockWaveSummary`). Pure, no IO. One responsibility: turn a chunk of server-log text + a coverage window into a bounded, privacy-safe summary.
- **Create `test/locklog.test.ts`** - parser unit tests over synthetic log lines (csvlog + stderr shapes, all cancel/wait/deadlock variants, timestamp fallback, sample truncation).
- **Create `test/lockfindings.test.ts`** - findings + threshold tests for `lock_wave`, `contention_episode`, `lock_forensics`, `live_lock_contention`, and the Check 4 annotation.
- **Modify `src/sql.ts`** - add `logDirProbe`, `logTail`, `relationNames`, `roleConfig`, `waitEventSample` queries; add `j.command` to `cronJobs`; add `max_ms`/`stall_ratio` to `queryIoStats`.
- **Modify `src/schemas.ts`** - add `lockWave`, `roleConfig`, `waitSamples`, `contentionEpisodes` to the `sql`/`trends` analysis shapes; add `log_lock_waits`/`deadlock_timeout` to the `pgSettings` allowlist; add `logProbe` to `meta`.
- **Modify `src/collect.ts`** - gate + orchestrate the log probe/tail (superuser only), the role-config query, the wait-event sampling loop, and the contention-episode Prometheus pass.
- **Modify `src/prometheus.ts`** - add `fetchIncidentSeries()` (pinned step=300s `query_range` + family-availability probe).
- **Create `src/contention.ts`** - pure episode detection over incident series (median/absFloor/k gate, adjacent-bucket merge, multi-series correlation).
- **Create `test/contention.test.ts`** - episode-merger + severity + chatty-baseline tests.
- **Modify `src/findings.ts`** - `lockWaveFindings`, `contentionEpisodeFindings`, `lockForensicsFindings` (into `configTuningFindings` or standalone), `liveLockContentionFinding`, the Check 4 cron/table annotation, the Check 5 stall-victim extension; positives for `log_lock_waits=on` and clean windows.
- **Modify `src/heuristics.ts`** - `meta()` entries for `lock_wave`, `contention_episode`, `lock_forensics`, `live_lock_contention`.
- **Modify `src/report/render.ts`** - render the lock-wave / contention-episode evidence sections with mandatory coverage headers; provenance line on the incident scan.
- **Modify `src/index.ts`** - `--incident-scan-days` flag (default 7).
- **Modify `docs/heuristics.md`** - document the thresholds as practitioner defaults, not Postgres mandates.

---

## Priority order (task groups)

1. **Check 3 - `lock_forensics`** (Tasks 1-3): pure `pg_settings`/`pg_roles`, all tiers, zero DB risk. Ships today.
2. **Check 1 probe + `lock_wave`** (Tasks 4-5): superuser only, probe-gated. Build the parser only if the probe shows usable retention.
3. **Check 2 - `contention_episode`** (Tasks 6-7): the guaranteed retrospective channel on this tier; works even if Check 1's probe fails.
4. **Check 4 - DDL-collision annotation** (Task 8): trivial, reuses collected cron + biggest-table data (after adding `j.command`).
5. **Check 5 - stall-victim column** (Task 9): small SQL + card edit.
6. **Check 6 - wait-event sampling** (Task 10): cheap, lowest yield, point-in-time only.
7. **Backlog** (Tasks 11-13): honesty fixes carried from earlier reviews.

---
## Task 1: `pgSettings` allowlist + `roleConfig` query (Check 3 collection)

**Files:**
- Modify: `src/schemas.ts` (pgSettings allowlist)
- Modify: `src/sql.ts` (add `roleConfig` query)
- Test: `test/heuristics.test.ts` (allowlist assertion)

- [ ] **Step 1: Write the failing test**

In `test/heuristics.test.ts`:

```ts
import { PG_SETTINGS_ALLOWLIST } from "../src/schemas";

test("pgSettings allowlist includes lock-forensics GUCs", () => {
  expect(PG_SETTINGS_ALLOWLIST).toContain("log_lock_waits");
  expect(PG_SETTINGS_ALLOWLIST).toContain("deadlock_timeout");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/heuristics.test.ts -t "lock-forensics GUCs"`
Expected: FAIL - allowlist does not contain `log_lock_waits`.

- [ ] **Step 3: Add the GUCs to the allowlist**

In `src/schemas.ts`, add `"log_lock_waits"` and `"deadlock_timeout"` to the `pgSettings` allowlist array (wherever `track_io_timing` already appears - keep alphabetical if the list is sorted).

- [ ] **Step 4: Add the `roleConfig` query in `src/sql.ts`**

Inside the `QUERIES` object:

```ts
  // Role-scoped GUC overrides (pg_roles.rolconfig). Both runners can read
  // pg_roles. Used by lock_forensics to check whether a migration role sets a
  // session lock_timeout, and to verify per-role statement_timeout claims.
  roleConfig: /* sql */ `
    select rolname as role, rolconfig
    from pg_roles
    where rolconfig is not null`,
```

- [ ] **Step 5: Add `roleConfig` to the analysis schema**

In `src/schemas.ts`, in the `sql` object schema, add:

```ts
    roleConfig: z
      .array(z.object({ role: z.string(), rolconfig: z.array(z.string()).nullable() }))
      .default([]),
```

- [ ] **Step 6: Wire `roleConfig` into `collect.ts`**

In `src/collect.ts`, alongside the other SQL planes (both tiers - it is not superuser-gated), add `roleConfig: await safe("roleConfig", () => sql("roleConfig"))` to the `sql` assembly. Follow the exact `safe()` pattern used by `roleStats`.

- [ ] **Step 7: Run tests + typecheck**

Run: `bun test test/heuristics.test.ts && bun run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 8: Commit**

```bash
git add src/schemas.ts src/sql.ts src/collect.ts test/heuristics.test.ts
git commit -m "feat(collect): capture log_lock_waits/deadlock_timeout GUCs + pg_roles.rolconfig"
```

---

## Task 2: `lock_forensics` heuristic metadata

**Files:**
- Modify: `src/heuristics.ts`
- Test: `test/heuristics.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { meta } from "../src/heuristics";

test("lock_forensics carries remediation + docUrl", () => {
  const m = meta("lock_forensics");
  expect(m.remediation).toMatch(/session|role/i);
  expect(m.remediation).not.toMatch(/globally|cluster-wide set/i);
  expect(m.docUrl).toContain("postgresql.org");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/heuristics.test.ts -t "lock_forensics carries"`
Expected: FAIL - `meta("lock_forensics")` returns the fallback (no such key).

- [ ] **Step 3: Add the metadata entry**

In `src/heuristics.ts`, add to the metadata map:

```ts
  lock_forensics: {
    id: "lock_forensics",
    whyItMatters:
      "Lock incidents leave no forensic trail when log_lock_waits is off: a " +
      "blocked ALTER that queues every reader for minutes produces zero log " +
      "evidence, so the cascade is invisible after the fact. And without a " +
      "session/role-scoped lock_timeout, a migration that can't acquire its " +
      "lock waits indefinitely, holding the queue open.",
    remediation:
      "Enable lock-wait logging: ALTER SYSTEM SET log_lock_waits = on (with " +
      "deadlock_timeout at 1s, each wait past 1s logs one line - negligible " +
      "except during the incidents you want recorded). For the guardrail, set " +
      "lock_timeout on the MIGRATION SESSION OR ROLE only (e.g. ALTER ROLE " +
      "migrator SET lock_timeout = '3s'), never globally - a cluster-wide " +
      "lock_timeout cancels legitimate waits. Pair it with a retry loop so a " +
      "blocked ALTER fails fast instead of queueing readers.",
    sql:
`-- enable lock-wait logging (superuser):
ALTER SYSTEM SET log_lock_waits = on;   -- then: SELECT pg_reload_conf();
-- session-scoped migration guardrail (run inside the migration):
SET lock_timeout = '3s';`,
    howToVerify:
      "After enabling: SHOW log_lock_waits returns 'on'. After the next " +
      "migration, confirm a blocked ALTER logs a 'still waiting for' line and " +
      "fails at the lock_timeout instead of stalling readers.",
    docUrl: "https://www.postgresql.org/docs/current/runtime-config-locks.html",
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/heuristics.test.ts -t "lock_forensics carries"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/heuristics.ts test/heuristics.test.ts
git commit -m "feat(heuristics): lock_forensics metadata (session-scoped guardrail only)"
```

---

## Task 3: `lock_forensics` finding + positive

**Files:**
- Modify: `src/findings.ts` (extend `configTuningFindings` or add `lockForensicsFindings`)
- Test: `test/lockfindings.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `test/lockfindings.test.ts`:

```ts
import { expect, test } from "bun:test";
import { deriveFindings, derivePositives } from "../src/findings";
import { makeAnalysis } from "./helpers"; // existing test factory

function withSettings(over: Record<string, string>, roleConfig: string[][] = []) {
  return makeAnalysis({
    sql: {
      roleConfig: roleConfig.map((c, i) => ({ role: `r${i}`, rolconfig: c })),
    },
    pgSettings: {
      log_lock_waits: over.log_lock_waits ?? "off",
      lock_timeout: over.lock_timeout ?? "0",
      deadlock_timeout: over.deadlock_timeout ?? "1s",
    },
  });
}

test("log_lock_waits=off + no role lock_timeout -> lock_forensics finding (both parts)", () => {
  const f = deriveFindings(withSettings({})).find((x) => x.id === "lock_forensics");
  expect(f).toBeDefined();
  expect(f?.severity).toBe("low");
  expect(f?.whatsHappening).toMatch(/log_lock_waits/);
  expect(f?.whatsHappening).toMatch(/no.*lock_timeout/i);
});

test("log_lock_waits=on -> positive, no finding", () => {
  const a = withSettings({ log_lock_waits: "on" });
  expect(deriveFindings(a).find((x) => x.id === "lock_forensics")).toBeUndefined();
  expect(derivePositives(a).some((p) => /lock-wait logging/i.test(p.text))).toBe(true);
});

test("role-scoped lock_timeout present -> part 2 suppressed", () => {
  const a = withSettings({ log_lock_waits: "on" }, [["lock_timeout=3s"]]);
  expect(deriveFindings(a).find((x) => x.id === "lock_forensics")).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/lockfindings.test.ts`
Expected: FAIL - `lock_forensics` finding not produced.

- [ ] **Step 3: Implement `lockForensicsFindings`**

In `src/findings.ts`, add and call from `configTuningFindings` (or `deriveFindings`):

```ts
export function lockForensicsFindings(a: Analysis): Finding[] {
  const set = new Map(a.pgSettings?.map((s) => [s.name, s.setting]) ?? []);
  const out: Finding[] = [];
  const logOff = set.get("log_lock_waits") === "off";
  const globalLt = set.get("lock_timeout") ?? "0";
  const roleHasLt = (a.sql.roleConfig ?? []).some((r) =>
    (r.rolconfig ?? []).some((c) => c.toLowerCase().startsWith("lock_timeout=")),
  );
  // Respect settled design: only flag missing guardrail when NO scoped one exists.
  const noGuardrail = globalLt === "0" && !roleHasLt;
  if (!logOff && !noGuardrail) return out; // healthy on both axes

  const parts: string[] = [];
  if (logOff) parts.push("log_lock_waits is off, so lock waits leave no log trail");
  if (noGuardrail)
    parts.push(
      "no session/role-scoped lock_timeout is set, so a blocked migration waits indefinitely",
    );
  out.push({
    id: "lock_forensics",
    category: "Performance",
    severity: "low",
    title: "Lock observability posture (log_lock_waits / migration lock_timeout)",
    whatsHappening: parts.join("; ") + ".",
    ...meta("lock_forensics"),
  });
  return out;
}
```

Also, inside the metadata card body when `deadlock_timeout` is far from 1s (parse via `gucBytes`-style seconds parse; e.g. `> 5000ms`), append a one-line note to `whatsHappening` (NOT a separate finding): `" deadlock_timeout is <v> (>5s); with log_lock_waits on this delays every logged wait line."`.

- [ ] **Step 4: Add the positive**

In `derivePositives`, when `set.get("log_lock_waits") === "on"`:

```ts
  if (set.get("log_lock_waits") === "on")
    positives.push({ text: "Lock-wait logging is enabled (log_lock_waits=on)", category: "Performance" });
```

- [ ] **Step 5: Wire `lockForensicsFindings` into `deriveFindings`**

Add `out.push(...lockForensicsFindings(a));` next to the existing `out.push(...configTuningFindings(a));` line (findings.ts:1867).

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test test/lockfindings.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 7: Document thresholds**

In `docs/heuristics.md`, add a `lock_forensics` subsection: state that this is an observability-posture check (mirrors `track_io_timing`), that the guardrail recommendation is session/role-scoped by design, and that `deadlock_timeout > 5s` is the one-line-note threshold.

- [ ] **Step 8: Commit**

```bash
git add src/findings.ts test/lockfindings.test.ts docs/heuristics.md
git commit -m "feat(findings): lock_forensics posture check + log_lock_waits positive"
```

---
## Task 4: Log-directory three-fact probe (Check 1, gate before parser)

**Files:**
- Modify: `src/sql.ts` (add `logDirProbe`)
- Modify: `src/schemas.ts` (add `meta.logProbe`)
- Modify: `src/collect.ts` (superuser-gated probe + note)
- Test: `test/collect.test.ts` (probe gating)

- [ ] **Step 1: Add the probe query in `src/sql.ts`**

```ts
  // logDirProbe: three facts before any parse attempt -
  //  (a) is a log directory readable at all (superuser / pg_monitor gated),
  //  (b) what time span do the newest files cover (retention),
  //  (c) which node are we on (a pooler may route pg_read_file off the node
  //      that logged the incident).
  // pg_ls_logdir has EXECUTE revoked from PUBLIC on hosted Supabase, so this
  // can only ever run on the superuser tier.
  logDirProbe: /* sql */ `
    select
      (select inet_server_addr()::text) as node_addr,
      (select setting from pg_settings where name = 'log_directory') as log_directory,
      (select setting from pg_settings where name = 'log_filename') as log_filename,
      d.name, d.size, d.modification
    from pg_ls_logdir() d
    order by d.modification desc
    limit 10`,
```

- [ ] **Step 2: Add `meta.logProbe` to the schema**

In `src/schemas.ts`, in the `meta` object:

```ts
    logProbe: z
      .object({
        readable: z.boolean(),
        nodeAddr: z.string().nullable(),
        newestFile: z.string().nullable(),
        oldestFile: z.string().nullable(),
        spanHours: z.number().nullable(),
        files: z.number(),
      })
      .nullable()
      .default(null),
```

- [ ] **Step 3: Write the failing gating test**

In `test/collect.test.ts` (use the fake transport + injected `DirectSqlRunner` pattern already in the suite):

```ts
test("logDirProbe is skipped on the read-only (PAT) tier", async () => {
  const a = await collectWithFakeRunner({ source: "read-only" });
  expect(a.meta.logProbe).toBeNull();
});

test("logDirProbe records readable=false as a note, not a throw", async () => {
  const a = await collectWithFakeRunner({
    source: "superuser",
    fail: { logDirProbe: new Error("permission denied for function pg_ls_logdir") },
  });
  expect(a.meta.logProbe?.readable).toBe(false);
  expect(a.meta.collectionNotes.some((n) => /log files not readable/i.test(n))).toBe(true);
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `bun test test/collect.test.ts -t "logDirProbe"`
Expected: FAIL.

- [ ] **Step 5: Implement the gated probe in `collect.ts`**

Mirror the `hbaRules` gate exactly:

```ts
  let logProbe: Meta["logProbe"] = null;
  if (dbServing && runner.source === "superuser") {
    try {
      const rows = await sql("logDirProbe");
      if (rows.length === 0) {
        logProbe = { readable: true, nodeAddr: null, newestFile: null, oldestFile: null, spanHours: null, files: 0 };
        notes.push("server log directory is empty; retrospective lock-wave detection unavailable");
      } else {
        const mods = rows.map((r) => new Date(r.modification)).sort((a, b) => a.getTime() - b.getTime());
        const spanHours = (mods.at(-1)!.getTime() - mods[0]!.getTime()) / 3_600_000;
        logProbe = {
          readable: true,
          nodeAddr: rows[0].node_addr ?? null,
          newestFile: rows[0].name,
          oldestFile: rows.at(-1)!.name,
          spanHours: Math.round(spanHours * 10) / 10,
          files: rows.length,
        };
      }
    } catch {
      logProbe = { readable: false, nodeAddr: null, newestFile: null, oldestFile: null, spanHours: null, files: 0 };
      notes.push(
        "server log files not readable over SQL; retrospective lock-wave detection unavailable in this mode",
      );
    }
  }
```

Assign `logProbe` into the `meta` object built at the end of `collect()`.

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test test/collect.test.ts -t "logDirProbe" && bun run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/sql.ts src/schemas.ts src/collect.ts test/collect.test.ts
git commit -m "feat(collect): superuser log-dir three-fact probe (readable/retention/node)"
```

- [ ] **Step 8: MANUAL GATE - validate on a live project before Task 5**

Run `analyze` against a real superuser `--db-url` and inspect `analysis.json` `meta.logProbe`:
- `readable === true`?
- `spanHours` large enough to cover a plausible incident (rule of thumb: >= 1h)?
- `nodeAddr` stable across two runs (not routed to a different node each time)?

If any answer is no, **stop the Check 1 track** - `lock_wave` (Task 5) will not produce reliable retrospective evidence. Record the decision in the PR and rely on Check 2. Proceed to Task 5 only if all three hold.

---

## Task 5: `locklog.ts` parser + `logTail`/`relationNames` reads + `lock_wave` finding

**Files:**
- Create: `src/locklog.ts`
- Create: `test/locklog.test.ts`
- Modify: `src/sql.ts` (`logTail`, `relationNames`)
- Modify: `src/schemas.ts` (`sql.lockWave`)
- Modify: `src/collect.ts` (bounded tail reads, gated on `logProbe.readable`)
- Modify: `src/findings.ts` + `src/heuristics.ts` (`lock_wave`)
- Modify: `src/report/render.ts` (evidence section + coverage header)

- [ ] **Step 1: Write the parser test first**

Create `test/locklog.test.ts` (synthetic lines - NO real table/query text):

```ts
import { expect, test } from "bun:test";
import { parseLockLog } from "../src/locklog";

const CSVLOG = [
  `2026-07-15 18:15:46.123 UTC,,,123,,,LOG,00000,"process 123 still waiting for ShareLock on relation 12345 of database 5 after 1000.000 ms",,,,,,,,,`,
  `2026-07-15 18:18:02.500 UTC,,,124,,,LOG,00000,"process 124 acquired AccessExclusiveLock on relation 12345 of database 5 after 334061.247 ms",,,,,`,
  `2026-07-15 18:19:10.000 UTC,,,125,,,ERROR,57014,"canceling statement due to lock timeout",,,,,`,
  `2026-07-15 18:19:11.000 UTC,,,126,,,ERROR,57014,"canceling statement due to statement timeout",,,,,`,
  `2026-07-15 18:20:00.000 UTC,,,127,,,ERROR,40P01,"deadlock detected",,,,,`,
].join("\n");

test("parses waiting/acquired/cancels/deadlock into minute buckets", () => {
  const s = parseLockLog(CSVLOG, { from: "2026-07-15 18:15", to: "2026-07-15 18:20", files: 1, bytesScanned: CSVLOG.length });
  const b15 = s.buckets.find((b) => b.minute === "2026-07-15 18:15");
  expect(b15?.waiting).toBe(1);
  const b18 = s.buckets.find((b) => b.minute === "2026-07-15 18:18");
  expect(b18?.maxWaitMs).toBeCloseTo(334061.247, 1);
  const b19 = s.buckets.find((b) => b.minute === "2026-07-15 18:19");
  expect(b19?.cancelsLock).toBe(1);
  expect(b19?.cancelsStmt).toBe(1);
  const b20 = s.buckets.find((b) => b.minute === "2026-07-15 18:20");
  expect(b20?.deadlocks).toBe(1);
  expect(s.topRelations[0]?.relid).toBe(12345);
});

test("stderr prefix + unparseable timestamp falls back to 'window' bucket", () => {
  const line = `process 9 still waiting for ShareLock on relation 999 of database 5 after 50.0 ms`;
  const s = parseLockLog(line, { from: null, to: null, files: 1, bytesScanned: line.length });
  expect(s.buckets[0]?.minute).toBe("window");
  expect(s.buckets[0]?.waiting).toBe(1);
});

test("samples are capped at 5 and truncated to 200 chars", () => {
  const long = Array.from({ length: 20 }, (_, i) =>
    `2026-07-15 18:15:0${i % 10} UTC,,,${i},,,ERROR,57014,"canceling statement due to lock timeout ${"x".repeat(400)}",,,`,
  ).join("\n");
  const s = parseLockLog(long, { from: "2026-07-15 18:15", to: "2026-07-15 18:15", files: 1, bytesScanned: long.length });
  expect(s.samples.length).toBeLessThanOrEqual(5);
  expect(Math.max(...s.samples.map((x) => x.length))).toBeLessThanOrEqual(200);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/locklog.test.ts`
Expected: FAIL - `parseLockLog` not defined.

- [ ] **Step 3: Implement `src/locklog.ts`**

```ts
export type LockWaveCoverage = { from: string | null; to: string | null; files: number; bytesScanned: number };
export type LockWaveBucket = {
  minute: string; waiting: number; maxWaitMs: number; acquired: number;
  cancelsLock: number; cancelsStmt: number; cancelsUser: number; deadlocks: number;
};
export type LockWaveSummary = {
  coverage: LockWaveCoverage;
  buckets: LockWaveBucket[];
  topRelations: Array<{ relid: number; name: string | null; hits: number }>;
  samples: string[];
};

const RE_WAITING = /still waiting for (\w+) on (?:relation (\d+) of database \d+|transaction \d+|tuple [^"]*?) after ([\d.]+) ms/;
const RE_ACQUIRED = /acquired (\w+) on (?:relation (\d+) of database \d+|transaction \d+|tuple [^"]*?) after ([\d.]+) ms/;
const RE_CANCEL_LOCK = /canceling statement due to lock timeout/;
const RE_CANCEL_STMT = /canceling statement due to statement timeout/;
const RE_CANCEL_USER = /canceling statement due to user request/;
const RE_DEADLOCK = /deadlock detected/;
const RE_TS = /(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/;

function emptyBucket(minute: string): LockWaveBucket {
  return { minute, waiting: 0, maxWaitMs: 0, acquired: 0, cancelsLock: 0, cancelsStmt: 0, cancelsUser: 0, deadlocks: 0 };
}

export function parseLockLog(text: string, coverage: LockWaveCoverage): LockWaveSummary {
  const buckets = new Map<string, LockWaveBucket>();
  const relHits = new Map<number, number>();
  const samples: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const hitCancelL = RE_CANCEL_LOCK.test(line);
    const hitCancelS = RE_CANCEL_STMT.test(line);
    const hitCancelU = RE_CANCEL_USER.test(line);
    const hitDead = RE_DEADLOCK.test(line);
    const mWait = RE_WAITING.exec(line);
    const mAcq = RE_ACQUIRED.exec(line);
    if (!(hitCancelL || hitCancelS || hitCancelU || hitDead || mWait || mAcq)) continue;
    const ts = RE_TS.exec(line);
    const minute = ts ? `${ts[1]} ${ts[2]}` : "window";
    const b = buckets.get(minute) ?? emptyBucket(minute);
    if (mWait) { b.waiting++; b.maxWaitMs = Math.max(b.maxWaitMs, Number(mWait[3])); if (mWait[2]) relHits.set(+mWait[2], (relHits.get(+mWait[2]) ?? 0) + 1); }
    if (mAcq) { b.acquired++; b.maxWaitMs = Math.max(b.maxWaitMs, Number(mAcq[3])); if (mAcq[2]) relHits.set(+mAcq[2], (relHits.get(+mAcq[2]) ?? 0) + 1); }
    if (hitCancelL) b.cancelsLock++;
    if (hitCancelS) b.cancelsStmt++;
    if (hitCancelU) b.cancelsUser++;
    if (hitDead) b.deadlocks++;
    buckets.set(minute, b);
    if (samples.length < 5) samples.push(line.slice(0, 200));
  }
  return {
    coverage,
    buckets: [...buckets.values()].sort((a, b) => a.minute.localeCompare(b.minute)),
    topRelations: [...relHits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([relid, hits]) => ({ relid, name: null, hits })),
    samples,
  };
}
```

- [ ] **Step 4: Run parser tests to verify they pass**

Run: `bun test test/locklog.test.ts`
Expected: PASS.

- [ ] **Step 5: Add `logTail` + `relationNames` queries in `src/sql.ts`**

```ts
  // logTail: bounded tail of one file. Size-based offset (no negative offsets)
  // for version safety. $1=filename, $2=file size, $3=chunk (<=4 MB). One
  // run() per chunk so each inherits the 120s session guard independently.
  logTail: /* sql */ `
    select pg_read_file(
      (select setting from pg_settings where name='log_directory') || '/' || $1::text,
      greatest($2::bigint - $3::bigint, 0),
      $3::bigint
    ) as chunk`,

  // relationNames: resolve the relids the parser found, same superuser session.
  relationNames: /* sql */ `
    select oid::bigint as relid, relnamespace::regnamespace || '.' || relname as name
    from pg_class where oid = any($1::oid[])`,
```

- [ ] **Step 6: Add `sql.lockWave` to the schema**

In `src/schemas.ts` add a nullable `lockWave` matching `LockWaveSummary` (import the type is not possible in a zod file - restate the shape as a zod object, nullable, default null).

- [ ] **Step 7: Orchestrate bounded reads in `collect.ts`**

Only when `logProbe?.readable === true`. Walk the probe's files **newest-first**, read a `<=4 MB` tail chunk per file via a **separate `sql("logTail", [name, size, chunk])` call each**, accumulate until the 20 MB run-budget is hit OR coverage reaches back >= the incident-scan window. Concatenate chunks, `parseLockLog(text, coverage)`, then resolve `topRelations` via `sql("relationNames", [relids])` and merge names in. Store the summary as `sql.lockWave`. Record `coverage.from/to` from the earliest/latest parsed bucket (or the file mtimes when timestamps are unparseable). NEVER store raw chunk text.

- [ ] **Step 8: Add `lock_wave` heuristic + finding + thresholds**

`heuristics.ts` `lock_wave` metadata (whyItMatters: lock-queue cascade / queue-order grants / transient + invisible to snapshots; remediation: session lock_timeout + retry, shorten/CONCURRENTLY the long jobs, avoid ALTER COLUMN TYPE rewrites; docUrl explicit-locking). `findings.ts` `lockWaveFindings` over a 10-minute rolling window across buckets:
- HIGH when `cancelsLock + cancelsStmt >= 50` in a window OR (`maxWaitMs >= 60000` AND `waiting >= 10`).
- MED when `waiting >= 10` OR `cancelsLock + cancelsStmt >= 10`.
- `deadlocks >= 1` -> own MED line regardless.
- `cancelsUser` is context, never a trigger.
- Title carries window + top relation: `"Lock-wait cascade 18:15-18:25: 12 waits up to 334s, 14 timeout cancellations on public.orders"`.
- Every finding's evidence header states `coverage.from -> coverage.to` and, when `spanHours` is short, `"scanned window only covers Nh of logs; older incidents are not visible"`.

- [ ] **Step 9: Threshold test in `test/lockfindings.test.ts`**

Add cases: buckets summing 50 cancels in 10 min -> HIGH; 12 waits -> MED; 1 deadlock -> MED; coverage header string present; empty buckets over a real coverage window -> no finding but a "checked, clean over <window>" positive.

- [ ] **Step 10: Run full suite + typecheck**

Run: `bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add src/locklog.ts test/locklog.test.ts src/sql.ts src/schemas.ts src/collect.ts src/findings.ts src/heuristics.ts src/report/render.ts test/lockfindings.test.ts
git commit -m "feat(findings): retrospective lock_wave from server logs (superuser, probe-gated, bounded)"
```

---
## Task 6: `fetchIncidentSeries()` - native-resolution Prometheus pass (Check 2)

**Files:**
- Modify: `src/prometheus.ts`
- Modify: `src/index.ts` (`--incident-scan-days` flag, default 7)
- Test: `test/prometheus.test.ts`

- [ ] **Step 1: Write the failing test**

Use the existing injected-fetch pattern in `test/prometheus.test.ts`:

```ts
test("fetchIncidentSeries pins step=300 regardless of range and probes families", async () => {
  const calls: string[] = [];
  const fakeFetch = async (url: string) => {
    calls.push(url);
    if (url.includes("count%20by")) // availability probe
      return okJson({ data: { result: [{ metric: { __name__: "pg_stat_database_xact_rollback" } }] } });
    return okJson({ data: { result: [{ values: [[1000, "5"], [1300, "80"]] }] } });
  };
  const series = await fetchIncidentSeries({ base: "http://x", matcher: 'ref="p"', days: 7, fetch: fakeFetch });
  const rangeCall = calls.find((c) => c.includes("query_range"))!;
  expect(rangeCall).toContain("step=300");
  expect(series.available).toContain("pg_stat_database_xact_rollback");
  expect(series.rollbacks).toBeDefined();
  expect(series.activeBackends).toBeUndefined(); // not in probe -> skipped, not errored
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/prometheus.test.ts -t "fetchIncidentSeries"`
Expected: FAIL - not defined.

- [ ] **Step 3: Implement `fetchIncidentSeries`**

```ts
export type IncidentSeries = {
  available: string[];
  windowFrom: number; windowTo: number; stepSec: number;
  rollbacks?: Array<[number, number]>;
  activeBackends?: Array<[number, number]>;
  accessShare?: Array<[number, number]>;
  accessExcl?: Array<[number, number]>;
};

export async function fetchIncidentSeries(o: {
  base: string; matcher: string; days: number; fetch?: typeof fetch;
}): Promise<IncidentSeries> {
  const f = o.fetch ?? fetch;
  const to = Math.floor(Date.now() / 1000);
  const from = to - o.days * 86400;
  const step = 300; // pinned - do NOT reuse fetchPanels' range/200 downsample.
  // Availability probe (one instant query).
  const probeQ = `count by (__name__)({__name__=~"pg_stat_database_xact_rollback|pg_stat_activity_count|pg_locks_count"})`;
  const probe = await f(`${o.base}/api/v1/query?query=${encodeURIComponent(probeQ)}&time=${to}`);
  const available: string[] = (await probe.json()).data.result.map((r: any) => r.metric.__name__);
  const range = async (q: string) => {
    const r = await f(`${o.base}/api/v1/query_range?query=${encodeURIComponent(q)}&start=${from}&end=${to}&step=${step}`);
    const res = (await r.json()).data.result;
    return res[0]?.values?.map((v: [number, string]) => [v[0], Number(v[1])] as [number, number]);
  };
  const out: IncidentSeries = { available, windowFrom: from, windowTo: to, stepSec: step };
  if (available.includes("pg_stat_database_xact_rollback"))
    out.rollbacks = await range(`sum(increase(pg_stat_database_xact_rollback{${o.matcher}}[5m]))`);
  if (available.includes("pg_stat_activity_count"))
    out.activeBackends = await range(`sum(pg_stat_activity_count{${o.matcher}, state="active"})`);
  if (available.includes("pg_locks_count")) {
    out.accessShare = await range(`sum(pg_locks_count{${o.matcher}, mode="accesssharelock"})`);
    out.accessExcl = await range(`sum(pg_locks_count{${o.matcher}, mode="accessexclusivelock"})`);
  }
  return out;
}
```

NOTE: the lock-mode label values (`accesssharelock`, `accessexclusivelock`) are the postgres_exporter lowercase form but are UNVERIFIED against this deployment. If the `pg_locks_count` family is present in the probe yet both mode series come back empty, record a collection note `"pg_locks_count present but lock-mode labels did not match; verify exporter label casing"` rather than silently treating it as "no lock pileup".

- [ ] **Step 4: Add `--incident-scan-days` in `src/index.ts`** (default 7, capped by retention; thread into `collect` opts).

- [ ] **Step 5: Run test + typecheck**

Run: `bun test test/prometheus.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/prometheus.ts src/index.ts test/prometheus.test.ts
git commit -m "feat(prometheus): native-resolution incident series (pinned step=300, family probe)"
```

---

## Task 7: `contention.ts` episode detection + `contention_episode` finding

**Files:**
- Create: `src/contention.ts`
- Create: `test/contention.test.ts`
- Modify: `src/schemas.ts` (`trends.contentionEpisodes`)
- Modify: `src/collect.ts` (call `fetchIncidentSeries` -> `detectEpisodes` when Prometheus configured)
- Modify: `src/findings.ts` + `src/heuristics.ts` (`contention_episode`)

- [ ] **Step 1: Write the failing episode-detection test**

Create `test/contention.test.ts`:

```ts
import { expect, test } from "bun:test";
import { detectEpisodes } from "../src/contention";

const flat = (n: number, v: number) => Array.from({ length: n }, (_, i) => [1000 + i * 300, v] as [number, number]);
function spike(base: [number, number][], at: number, len: number, v: number) {
  const c = base.map((x) => [...x] as [number, number]);
  for (let i = at; i < at + len; i++) c[i]![1] = v;
  return c;
}

test("two correlated series over the same buckets -> one episode", () => {
  const rollbacks = spike(flat(40, 2), 10, 3, 90);
  const active = spike(flat(40, 3), 10, 3, 40);
  const eps = detectEpisodes({ rollbacks, activeBackends: active, available: [], windowFrom: 1000, windowTo: 13000, stepSec: 300 });
  expect(eps.length).toBe(1);
  expect(eps[0]?.series.sort()).toEqual(["activeBackends", "rollbacks"]);
});

test("chatty rollback baseline does not fire (k*median gate)", () => {
  const eps = detectEpisodes({ rollbacks: flat(40, 120), available: [], windowFrom: 1000, windowTo: 13000, stepSec: 300 });
  expect(eps.length).toBe(0);
});

test("single-series spike -> episode marked single (LOW downstream)", () => {
  const eps = detectEpisodes({ rollbacks: spike(flat(40, 2), 5, 2, 90), available: [], windowFrom: 1000, windowTo: 13000, stepSec: 300 });
  expect(eps[0]?.series).toEqual(["rollbacks"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/contention.test.ts`
Expected: FAIL - `detectEpisodes` not defined.

- [ ] **Step 3: Implement `src/contention.ts`**

```ts
import type { IncidentSeries } from "./prometheus";

export type Episode = {
  from: number; to: number; series: string[];
  rollbackTotal: number; peakActive: number;
};

const CFG = {
  rollbacks: { absFloor: 20, k: 6, minConsecutive: 1 },
  activeBackends: { absFloor: 10, k: 4, minConsecutive: 2 },
  accessShare: { absFloor: 0, k: 4, minConsecutive: 1 },
} as const;

function median(xs: number[]): number {
  const nz = xs.filter((v) => v > 0).sort((a, b) => a - b);
  if (nz.length === 0) return 0;
  const m = Math.floor(nz.length / 2);
  return nz.length % 2 ? nz[m]! : (nz[m - 1]! + nz[m]!) / 2;
}

function hotBuckets(pts: [number, number][] | undefined, c: { absFloor: number; k: number; minConsecutive: number }): Set<number> {
  const hot = new Set<number>();
  if (!pts) return hot;
  const med = median(pts.map((p) => p[1]));
  const thr = Math.max(c.absFloor, c.k * med);
  let run = 0;
  for (let i = 0; i < pts.length; i++) {
    if (pts[i]![1] > thr) { run++; if (run >= c.minConsecutive) for (let j = i - run + 1; j <= i; j++) hot.add(j); }
    else run = 0;
  }
  return hot;
}

export function detectEpisodes(s: IncidentSeries): Episode[] {
  const perSeries: Record<string, Set<number>> = {
    rollbacks: hotBuckets(s.rollbacks, CFG.rollbacks),
    activeBackends: hotBuckets(s.activeBackends, CFG.activeBackends),
    accessShare: hotBuckets(s.accessShare, CFG.accessShare),
  };
  // union of hot bucket indices -> merge adjacent (gap <= 1) -> attribute series
  const allHot = [...new Set(Object.values(perSeries).flatMap((set) => [...set]))].sort((a, b) => a - b);
  const merged: number[][] = [];
  for (const idx of allHot) {
    const last = merged.at(-1);
    if (last && idx - last.at(-1)! <= 1) last.push(idx);
    else merged.push([idx]);
  }
  const times = (i: number) => s.rollbacks?.[i]?.[0] ?? s.activeBackends?.[i]?.[0] ?? s.windowFrom + i * s.stepSec;
  return merged.map((idxs) => {
    const series = Object.entries(perSeries).filter(([, set]) => idxs.some((i) => set.has(i))).map(([k]) => k);
    const rollbackTotal = idxs.reduce((sum, i) => sum + (s.rollbacks?.[i]?.[1] ?? 0), 0);
    const peakActive = Math.max(0, ...idxs.map((i) => s.activeBackends?.[i]?.[1] ?? 0));
    return { from: times(idxs[0]!), to: times(idxs.at(-1)!), series, rollbackTotal, peakActive };
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/contention.test.ts`
Expected: PASS.

- [ ] **Step 5: `contention_episode` finding + severity (correlation-gated HIGH)**

In `findings.ts`, `contentionEpisodeFindings(a)` over `a.trends.contentionEpisodes`:
- **HIGH only when `series.length >= 2` AND `rollbackTotal >= 100`** (never rollback-alone -> HIGH; a chatty single-series burst cannot reach HIGH).
- MED when `series.length >= 2` (correlated) below the HIGH total.
- LOW when `series.length === 1` (single-series).
- Title: `"Contention episode 18:15-18:25: rollback burst (312) + active-backend spike (40), 2 signals correlated"`.
- Evidence provenance line (mandatory): `"native-resolution scan over the last N days (source: Prometheus/Grafana) - separate from the downsampled Resource snapshot above."`
- Cross-reference `lock_wave`: when a `lock_wave` window overlaps an episode window, annotate both (`"log evidence attributes this episode to <relation>"`).

- [ ] **Step 6: `heuristics.ts` `contention_episode` metadata** (whyItMatters: synchronized rollback + active + share-lock burst = mass-cancellation; 30d panels average it into invisibility; remediation: correlate with DDL + cron.job_run_details start/end, enable log_lock_waits, session lock_timeout + retry; docUrl monitoring-stats).

- [ ] **Step 7: Wire into `collect.ts`** - when Prometheus is configured, `const inc = await fetchIncidentSeries(...); trends.contentionEpisodes = detectEpisodes(inc);` guarded by `safe()`. Add `trends.contentionEpisodes` to the schema (array of `Episode`, default `[]`).

- [ ] **Step 8: Findings tests in `test/lockfindings.test.ts`** - 2-series + total>=100 -> HIGH; 2-series + total<100 -> MED; single-series -> LOW; provenance line present.

- [ ] **Step 9: Run full suite + typecheck**

Run: `bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/contention.ts test/contention.test.ts src/schemas.ts src/collect.ts src/findings.ts src/heuristics.ts test/lockfindings.test.ts
git commit -m "feat(findings): contention_episode from native-resolution Prometheus scan (correlation-gated HIGH)"
```

---
## Task 8: DDL-collision annotation (Check 4) + `cronJobs.command` prerequisite

**Files:**
- Modify: `src/sql.ts` (`cronJobs` gains `command`)
- Modify: `src/schemas.ts` (`cronJobs[].command`)
- Modify: `src/findings.ts` (annotation on `cron_job_overrun` + biggest-table finding)
- Test: `test/lockfindings.test.ts`

- [ ] **Step 1: Add `j.command` to the `cronJobs` query**

In `src/sql.ts` `cronJobs`, add `j.command` to the select list and to the `group by`. Truncate for privacy: `left(j.command, 200) as command`.

- [ ] **Step 2: Add `command` to the schema** - `cronJobs[]` object gains `command: z.string().nullable().default(null)`.

- [ ] **Step 3: Write the failing annotation test**

```ts
test("active long cron job touching a top-N table annotates the overrun finding", () => {
  const a = makeAnalysis({
    sql: {
      cronJobs: [{ jobname: "nightly-refresh", schedule: "*/5 * * * *", active: true, avg_duration_s: 200, max_duration_s: 400, command: "REFRESH MATERIALIZED VIEW public.orders_mv" }],
      biggestTables: [{ table: "public.orders_mv", total_bytes: 5e9, index_bytes: 1e9, live_rows: 1e6 }],
    },
  });
  const f = deriveFindings(a).find((x) => x.id === "cron_job_overrun");
  expect(f?.whatsHappening).toMatch(/AccessShareLock on `public\.orders_mv`/);
  expect(f?.whatsHappening).toMatch(/queue \*\*all\*\* new readers|queue all new readers/);
});

test("REFRESH MATERIALIZED VIEW without CONCURRENTLY on a top-N table is flagged in the annotation", () => {
  // same fixture: command lacks CONCURRENTLY -> annotation notes it
  const a = makeAnalysis({ sql: { cronJobs: [{ jobname: "nightly-refresh", schedule: "*/5 * * * *", active: true, avg_duration_s: 200, max_duration_s: 400, command: "REFRESH MATERIALIZED VIEW public.orders_mv" }], biggestTables: [{ table: "public.orders_mv", total_bytes: 5e9, index_bytes: 1e9, live_rows: 1e6 }] } });
  const f = deriveFindings(a).find((x) => x.id === "cron_job_overrun");
  expect(f?.whatsHappening).toMatch(/without CONCURRENTLY/i);
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `bun test test/lockfindings.test.ts -t "annotates the overrun"`
Expected: FAIL.

- [ ] **Step 5: Implement the annotation (writeTargets-style)**

In `findings.ts`, after the `cron_job_overrun` finding is built, for each active job with `max_duration_s > 60` whose `command` token-matches a qualified name in the top-N `biggestTables`, append:

```
holds AccessShareLock on `<table>` for up to <max_duration_s>s per run - any ALTER TABLE on it will queue all new readers behind the waiting exclusive lock for that long (Postgres grants locks in queue order).
```

If the command matches `/refresh\s+materialized\s+view/i` on a top-N table AND does NOT contain `/concurrently/i`, additionally append `" This REFRESH runs without CONCURRENTLY, taking AccessExclusiveLock on <table> for the whole refresh."`. Also append the same AccessShareLock sentence to the biggest-table attribution finding for that table. No new finding, no new card.

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test test/lockfindings.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/sql.ts src/schemas.ts src/findings.ts test/lockfindings.test.ts
git commit -m "feat(findings): DDL-collision annotation on long cron jobs touching top-N tables"
```

---

## Task 9: Stall-victim extension to the latency card (Check 5)

**Files:**
- Modify: `src/sql.ts` (`queryIoStats` gains `max_ms` + `stall_ratio`)
- Modify: `src/schemas.ts` (columns)
- Modify: `src/findings.ts` (extend the existing unstable-latency card)
- Test: `test/lockfindings.test.ts`

- [ ] **Step 1: Extend `queryIoStats`**

Add to the select list:

```sql
      round(max_exec_time::numeric, 2) as max_ms,
      round((max_exec_time / nullif(mean_exec_time, 0))::numeric, 1) as stall_ratio,
```

Add `max_ms` and `stall_ratio` (both nullable numbers) to the `queryIoStats` schema rows.

- [ ] **Step 2: Write the failing test**

```ts
test("high stall_ratio adds a stall-signature note to the latency card", () => {
  const a = makeAnalysis({ sql: { queryIoStats: [{ queryid: "1", calls: 100, mean_ms: 50, stddev_ms: 40, cv: 0.8, max_ms: 6000, stall_ratio: 120, temp_written: "0 bytes", miss_pct: 1, query: "select 1" }] } });
  const f = deriveFindings(a).find((x) => x.id === "query_latency_unstable");
  expect(f?.whatsHappening).toMatch(/stall signature/i);
  expect(f?.whatsHappening).toMatch(/pg_stat_statements records only completed executions/i);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test test/lockfindings.test.ts -t "stall-signature"`
Expected: FAIL.

- [ ] **Step 4: Implement the extension**

On the existing unstable-latency finding, when any row has `stall_ratio > 10 AND max_ms > 5000`, append:

```
the max/mean spread is a stall signature (lock queue, I/O, or cold cache) - corroborate with the lock-wave / contention-episode findings. Caveat: pg_stat_statements records only completed executions, so statements killed by statement_timeout never appear here; this under-counts cascade victims and is corroboration, never the primary detector.
```

- [ ] **Step 5: Run tests + typecheck**

Run: `bun test test/lockfindings.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/sql.ts src/schemas.ts src/findings.ts test/lockfindings.test.ts
git commit -m "feat(findings): stall-victim note on the unstable-latency card (with completed-only caveat)"
```

---

## Task 10: Wait-event sampling during collection (Check 6)

**Files:**
- Modify: `src/sql.ts` (`waitEventSample`)
- Modify: `src/schemas.ts` (`sql.waitSamples`)
- Modify: `src/collect.ts` (5-sample loop, ~500ms apart)
- Modify: `src/findings.ts` + `src/heuristics.ts` (`live_lock_contention`)
- Test: `test/lockfindings.test.ts`

- [ ] **Step 1: Add the sampling query**

```ts
  waitEventSample: /* sql */ `
    select coalesce(wait_event_type, 'Running') as wait_event_type, count(*)::int as n
    from pg_stat_activity
    where state = 'active' and pid <> pg_backend_pid()
    group by 1`,
```

- [ ] **Step 2: Add `sql.waitSamples` schema** - `z.array(z.array(z.object({ wait_event_type: z.string(), n: z.number() }))).default([])` (an array of samples, each an array of type/count rows).

- [ ] **Step 3: Sampling loop in `collect.ts`** - `dbServing` only; take 5 samples with `await Bun.sleep(500)` between (do NOT block the whole collection ordering - run it as one of the awaited planes). Guard with `safe()`. Store all 5.

- [ ] **Step 4: Write the failing finding test**

```ts
test("Lock wait_event in >=2 samples -> live_lock_contention MED", () => {
  const s = [{ wait_event_type: "Lock", n: 3 }];
  const a = makeAnalysis({ sql: { waitSamples: [s, [{ wait_event_type: "Running", n: 1 }], s, s, s] } });
  const f = deriveFindings(a).find((x) => x.id === "live_lock_contention");
  expect(f?.severity).toBe("med");
});

test("Lock in a single sample -> no finding", () => {
  const a = makeAnalysis({ sql: { waitSamples: [[{ wait_event_type: "Lock", n: 1 }], [], [], [], []] } });
  expect(deriveFindings(a).find((x) => x.id === "live_lock_contention")).toBeUndefined();
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `bun test test/lockfindings.test.ts -t "live_lock_contention"`
Expected: FAIL.

- [ ] **Step 6: Implement `liveLockContentionFinding` + metadata**

MED when `wait_event_type === "Lock"` appears in `>= 2` of the samples. `heuristics.ts` metadata must state plainly: "point-in-time - catches contention happening DURING the run, nothing retrospective; use lock_wave / contention_episode for after-the-fact."

- [ ] **Step 7: Run tests + typecheck**

Run: `bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/sql.ts src/schemas.ts src/collect.ts src/findings.ts src/heuristics.ts test/lockfindings.test.ts
git commit -m "feat(findings): live_lock_contention from wait-event sampling (point-in-time)"
```

---

## Task 11: Backlog - checksum-honesty + cron-history + space-per-row

**Files:**
- Modify: `src/findings.ts`, `src/report/render.ts`, `src/heuristics.ts`
- Test: `test/lockfindings.test.ts` or the existing findings test file

- [ ] **Step 1: Checksum honesty test + fix.** When `data_checksums = off`, the Infrastructure checksum row must render `"not enabled (corruption detection unavailable)"`, NOT `"0 failures - clean"`. Test: a fixture with `data_checksums=off` + `checksumFailures=[]` -> the render string contains "not enabled" and does NOT contain "clean". Fix in `render.ts` (gate the row on the GUC) and suppress the `checksum_failure` clean-positive in `findings.ts` when checksums are off.

- [ ] **Step 2: `cron_history_unpruned` finding.** When `cron.job_run_details` size or row count exceeds a floor (defaults: `> 50 MB` OR `> 100k rows`), emit a LOW finding: "pg_cron never purges run history; per-minute jobs generate ~2,880 detail rows/day forever - schedule a cleanup job (DELETE FROM cron.job_run_details WHERE end_time < now() - interval '7 days')." Needs `job_run_details` size/rows in the collection (add to `cronJobs` companion query or `biggestTables` lookup). Test both threshold arms.

- [ ] **Step 3: Space-per-row sanity finding.** When `total_bytes / live_rows` is wildly out of line with the pg_stats row width AND the bloat estimate reads ~1.0x, emit a LOW finding: "footprint inconsistent with row count - the bloat estimator is blind here; run ANALYZE then verify with pgstattuple." Test with a synthetic table (e.g. `200 MB / 1000 rows` at estimate 1.0x -> fires; a normal table -> silent).

- [ ] **Step 4: Run tests + typecheck, then commit**

```bash
git add -A && bun test && bun run typecheck
git commit -m "feat(findings): checksum-honesty render, cron_history_unpruned, space-per-row sanity"
```

---

## Task 12: Backlog - connections backend_type split + self-observation filter

**Files:**
- Modify: `src/sql.ts` (`connectionsByState` gains `backend_type`), `src/findings.ts`, `src/report/render.ts`

- [ ] **Step 1: Split replication backends in the connections rollup.** Add `backend_type` to the connections-by-state query and separate/exclude `walsender` rows from the `active` + `max_state_age_s` rollup - a walsender sits `state='active'` for the life of the slot and otherwise reads as a multi-day active query. Test: a fixture with a walsender at `state_age=1e6` + no real long query -> the "long active" signal does not fire; a real long query still does.

- [ ] **Step 2: Self-observation filter.** Marker-comment sbperf's own statements (prefix each query text sent by `DirectSqlRunner`/`ManagementSqlRunner` with a stable `/* sbperf */` comment) and filter `/* sbperf */` out of the WAL-by-statement and top-frequency evidence so the tool's own `cronJobs`/`queryIoStats` reads stop climbing the workload tables. Test: a `pg_stat_statements` fixture containing a `/* sbperf */`-marked row is excluded from `topByWal`.

- [ ] **Step 3: Run tests + typecheck, then commit**

```bash
git add -A && bun test && bun run typecheck
git commit -m "feat(findings): backend_type split for connections, filter sbperf's own statements"
```

---

## Task 13: Backlog - silent-when-healthy status rows + no-PAT render honesty

**Files:**
- Modify: `src/report/render.ts`, `src/findings.ts`

- [ ] **Step 1: Memory positive gated on the paging finding.** Suppress the "memory within healthy range" positive whenever the swap-in/paging MED finding is present (they contradict - "peak 95%" next to a paging finding). Test: a fixture with the paging finding present -> no memory positive.

- [ ] **Step 2: Status rows for silent-when-clean checks.** `sequenceExhaustion` and `statementsDealloc` must render a "checked, clean" status row when they ran and found nothing, distinct from "not checked". Test: a fixture where both ran clean -> both status rows render; a no-PAT fixture where a plane was skipped -> "not checked".

- [ ] **Step 3: no-PAT render honesty.** Edge functions must render `"not collected (no PAT)"` in no-PAT mode, not `"none deployed"`. Cron-overrun residuals: add a running-now arm (a job with an in-flight run whose current duration already exceeds its cadence, zero completed runs) and gate the "N jobs all healthy" capability chip on the overrun finding being absent. Test each render string.

- [ ] **Step 4: Run tests + typecheck, then commit**

```bash
git add -A && bun test && bun run typecheck
git commit -m "feat(report): silent-when-healthy status rows + no-PAT render honesty"
```

---

## Self-Review checklist (run before handing off)

- **Spec coverage:** Checks 1-6 map to Tasks 4-5, 6-7, 1-3, 8, 9, 10 respectively; the v2 appendix backlog maps to Tasks 11-13. The out-of-scope Logflare check (research report's check F) is intentionally absent.
- **Corrections baked in:** `cronJobs.command` (Task 8 Step 1), `roleConfig` new projection (Task 1), separate Prometheus path (Task 6) - all three source-spec inaccuracies are fixed as prerequisites, not assumed.
- **Safety invariant:** every new SQL read goes through `DirectSqlRunner.run()` (120s/15s guard); the log-tail reads are explicitly one `run()` per <=4 MB chunk (Task 5 Step 7). No query can run unbounded against a live primary.
- **Honesty invariant:** every retrospective finding carries a coverage/window header; "checked clean" is distinct from "not checked" (Task 13); the incident scan states its native-resolution provenance (Task 7 Step 5).
- **Settled-design deference:** Task 3 recommends session/role-scoped `lock_timeout` only, never global (AGENTS.md:82-83).
- **Privacy:** log samples <=5 and <=200 chars (Task 5 parser + test); `command`/`query` text truncated to 200 chars at the SQL boundary.
- **Type consistency:** `LockWaveSummary`, `IncidentSeries`, `Episode` are defined once (locklog.ts / prometheus.ts / contention.ts) and imported; schema mirrors restate the shapes for zod.
- **No customer identifiers:** all tables/jobs/relids in code and tests are synthetic (`public.orders`, `public.orders_mv`, `nightly-refresh`, `12345`).

## Execution Handoff

Two execution options:

1. **Subagent-Driven (recommended)** - dispatch a fresh subagent per task, review between tasks. Best fit here because the tasks are well-isolated and several (Tasks 1-3, 8, 9) are independent.
2. **Inline Execution** - execute in this session with checkpoints.

**Hard gate:** do not start Task 5 until Task 4 Step 8 (the live three-fact probe) confirms readable + usable retention + stable node. If it fails, skip Tasks 4-5 entirely and treat Check 2 (Tasks 6-7) as the sole retrospective channel.
