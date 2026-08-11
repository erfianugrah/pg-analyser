# Prometheus alerting-rule pack - implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Emit a Prometheus alerting-rule pack generated from the same threshold
catalogue that ranks findings, so a rule and the report card behind it cannot disagree -
and publish, as a first-class artifact, the list of findings that are deliberately NOT
alerted on.

**Architecture:** A new pure module `src/alerts.ts` holds `ALERT_SPECS` (a spec references
a `buildPanels()` panel by TITLE plus a `THRESHOLDS` constant, never a literal PromQL
string), an expression renderer with four shapes, a YAML renderer, and the exclusion
catalogue. `index.ts` gains an `alerts-init` subcommand that writes `alerts.yml` +
`EXCLUSIONS.md`; `scraper.ts` emits and mounts the same pack so a fresh `scrape-init`
stack loads it with no extra step. A new advisory `check:alerts` script asserts that every
heuristic is classified and that every metric family a rule names is either confirmed by
the captured corpus or declared as a known blind spot.

**Tech stack:** Bun + TypeScript (strict, `noUncheckedIndexedAccess`), zod 4 at API
boundaries (none are crossed here - this command makes no network call), biome 2,
`bun test`. YAML is rendered by hand (the repo has no YAML dependency, and `scraper.ts`
already renders `prometheus.yml` / `compose.yml` the same way) and verified in tests with
`Bun.YAML.parse`, a builtin present in the `bun --version` on this box (1.3.13).

**Standing constraint:** the operator has asked for no commits in this session. Per-task
commit steps are therefore omitted; commit at your own cadence.

**On the numbers in this plan:** every threshold is a `THRESHOLDS` constant read from
`src/heuristics.ts`. The only invented numbers are `ALERT_WINDOW` (1h), `ALERT_RESOLUTION`
(5m) and `ALERT_HOLD` (10m), which have no catalogue equivalent - `findings.ts` evaluates
over the report's trend window (`--trend-days`, default 30), far too long to page on.
They are CHOSEN starting values, exported so they can be tuned, and the plan says so in
the code comment rather than dressing them up as derived.

**Verified against the repo on 2026-08-04:** `buildPanels(refMatcher)` in
`src/prometheus.ts` returns 23 panels and is already the single source shared by the
report trend fetch and the generated Grafana dashboard - the 23 titles were listed by
running it. `THRESHOLDS` and `HEURISTICS` (94 entries across 12 planes) live in
`src/heuristics.ts`; `meta(id)` is the existing accessor and `Plane` is exported.
Severities were read off the matching branches in `src/findings.ts` (`cpu_saturated`
high, `disk_full` med, `oom_kill` high, `wal_archival_backlog` high, `mem_saturated` med,
`checkpoint_pressure` med, `psi_saturation` med, `mem_pressure_paging` med,
`ebs_balance_low` high). `sustainedFrac()` in `src/trendstats.ts` counts the FRACTION of
points past a threshold, not consecutive time, which is why the sustained rules use a
count ratio and not `for:`. `test/fixtures/metrics-sample.txt` is a TRUNCATED real scrape
(39820 bytes, the last line cut mid-token) using the placeholder ref
`examplerefaaaaaaaaaa`. The Management API base is `https://api.supabase.com` and the
metrics path is `https://<ref>.supabase.co/customer/v1/privileged/metrics`
(`src/transport.ts`); the service_role key comes from `/v1/projects/{ref}/api-keys`
(`src/management.ts`). `docs/grafana-prometheus.md` already records that the PSI collector
is not enabled on the Supabase endpoint and that EBS balance is CloudWatch-only - this
plan mirrors that decision rather than relitigating it. Repo scripts are `bun run check`
(biome write), `bun run lint`, `bun run typecheck`, `bun test`, and the advisory
`check:api|inspect|lints|pgversions|schemas|docurls`. `tsconfig.json` sets `strict` and
`noUncheckedIndexedAccess`, which is why every record index below carries a `!` or a
guard.

**Dry-run status (2026-08-04).** Tasks 1-7 were applied to a scratch copy at
`/tmp/pg-analyser-check` (tar-pipe excluding `node_modules`, `.git`, and every gitignored
credential file; `node_modules` symlinked back), then the scratch was destroyed and the
whole plan applied AGAIN, this time by extracting the code blocks from this file so
nothing could be silently fixed in passing. Every number below is from that second,
verbatim pass.

Baseline: `bun run lint` clean over 102 files, `bun run typecheck` exit 0, `bun test` 651
pass / 0 fail across 36 files. Per task: Task 1 15 pass, Task 2 20 pass, Task 3 26 pass,
Task 4 679 pass across 37 files with `check:alerts` reporting "16 metric families, 8
confirmed by the corpus capture, 8 declared unconfirmed; every heuristic classified",
Task 5 `> /tmp/apack/alerts.yml (13 rules)` with 188 and 89 lines and groups of 8 and 5,
Task 6 1 pass / 18 expect() calls, Task 7 `bun run lint` clean over 105 files, `tsc` exit
0, `bun test` 679 pass / 0 fail across 37 files (28 new tests), and `check:lints` /
`check:schemas` unchanged.

Task 8 is the live-infrastructure step and was NOT run: it needs a PAT and a serving
project. This box has neither a reachable Docker daemon nor a host `promtool`, so the
`promtool check rules` validation in Task 7 Step 5 is also unexecuted. The YAML is instead
asserted by round-tripping it through `Bun.YAML.parse` in the test suite, which proves the
quoting and structure but not Prometheus's own rule semantics.

---

## Why not just extend scrape-init

`scraper.ts` already writes a Prometheus + Grafana stack, and adding `alerts.yml` there
alone would have been fewer moving parts. Three things stop it being the whole answer:

1. `scrape-init` needs a PAT: it fetches the project's `service_role` key to build the
   scrape config. Rule generation needs no credential at all, and forcing one on it would
   put the pack out of reach of anyone who already runs Prometheus.
2. The pack is useful against an existing Prometheus that pg-analyser did not generate. That is
   the same reason `--prometheus` exists alongside the store.
3. The interesting output is not the YAML, it is the boundary: which findings can be
   alerted on and which cannot. That belongs in a module with tests, not inside a
   file-writing function.

So the generator is pure and standalone, `alerts-init` exposes it, and `scrape-init` calls
the same function so the stack it emits is complete.

## What earns a rule

A finding earns a rule only when BOTH hold:

1. its signal is already a `buildPanels()` trend panel - a PromQL expression over families
   the scrape serves, proven by the panel path rather than remembered; and
2. its threshold survives translation to a PromQL range window unchanged.

That predicate is the whole design. It yields 13 rules over 9 heuristics; the other 85
heuristics are excluded with the failing clause named (`no-metric`, `no-panel`,
`semantics`, `not-an-alert`). Three exclusions look alertable and are not:
`cache_hit_low` (its `cacheHitMinBlocks` trustworthiness floor is cumulative-since-reset,
so a rate-form rule pages on idle projects), `disk_fill_projection`
(`projectDataDisk()` segments the series on a disk resize before fitting;
`predict_linear` cannot, so an auto-expansion reads as a cliff), and `connections_ceiling`
(the denominator is `max_connections` from `pg_settings`, which is not a metric family).

Five of the 13 rules reference families the Supabase endpoint does not serve (PSI, and the
CloudWatch EBS balance gauges). They are emitted, because `buildPanels()` already charts
those panels for a Prometheus that scrapes more than the Supabase endpoint - but in a
separate `-optional` rule group carrying a `requires` label, so an inert rule is never
read as coverage. That mirrors how the report treats the same two panel families.

## File structure

| Path | Responsibility |
| --- | --- |
| `src/alerts.ts` | CREATE. Alert specs, expression renderer, YAML renderer, exclusion catalogue, corpus-gap declarations. Pure - no filesystem, no network. |
| `test/alerts.test.ts` | CREATE. 28 unit tests over the above. |
| `scripts/check-alerts-drift.ts` | CREATE. Advisory drift check: catalogue coverage + metric-name confirmation. |
| `src/index.ts` | MODIFY. `alerts-init` subcommand + `doAlertsInit` writer + usage line. |
| `src/scraper.ts` | MODIFY. Emit `alerts.yml`, add `rule_files:`, mount it in compose. |
| `test/scraper.test.ts` | MODIFY. Assert the pack ships, is mounted, and is not gitignored. |
| `package.json` | MODIFY. Add the `check:alerts` script. |
| `.gitignore` | MODIFY. Ignore the default `alerts-pack/` output dir. |
| `docs/alerts.md` | CREATE. The pack's reference doc. |
| `docs/grafana-prometheus.md` | MODIFY. Cross-link, in the optional-panels section. |
| `README.md` | MODIFY. Command entry under the Prometheus section. |
| `AGENTS.md` | MODIFY. Commands row + module map entry. |

Deliberately out of scope, and named so nobody has to guess: Alertmanager routing and
notifier config (commodity); new CLI flags for the three window constants (they are
exported, and the emitted YAML is editable); adding pooler and temp-file panels to
`buildPanels()` so `pooler_clients_waiting` and `work_mem_spill` become alertable (that
changes the report's panel set and belongs in its own change).

---

### Task 1: the spec catalogue and the expression renderer

**Files:**
- Create: `src/alerts.ts`
- Test: `test/alerts.test.ts`

Every later task APPENDS to `src/alerts.ts` and to `test/alerts.test.ts`, and each says
which names to add to the existing import lines. Nothing in this plan reorders what an
earlier task wrote, so `bun run check` never has to move a declaration.

- [ ] **Step 1: Read the two sources this module is derived from**

Run:
```bash
bun -e 'import { buildPanels } from "./src/prometheus.ts"; for (const p of buildPanels("")) console.log(JSON.stringify(p.title))'
bun -e 'import { THRESHOLDS } from "./src/heuristics.ts"; console.log(THRESHOLDS)'
```
Expected: 23 panel titles, and the threshold record. Every panel title used below must
appear in the first list verbatim, including the parentheses and the `%`. If a title has
changed, fix the spec rather than the panel - the panel is what the report renders.

- [ ] **Step 2: Write the failing test**

Create `test/alerts.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { ALERT_SPECS, buildAlertRules, renderExpr } from "../src/alerts.ts";
import { HEURISTICS, THRESHOLDS } from "../src/heuristics.ts";
import { buildPanels } from "../src/prometheus.ts";

describe("expressions come from buildPanels", () => {
  test("every referenced panel title resolves", () => {
    const titles = new Set(buildPanels("").map((p) => p.title));
    for (const s of ALERT_SPECS) {
      const refs =
        s.expr.kind === "ratio"
          ? [s.expr.num, ...s.expr.den]
          : [(s.expr as { panel: string }).panel];
      for (const t of refs) expect(titles.has(t), `no panel titled ${t}`).toBe(true);
    }
  });

  test("an unknown panel title throws rather than silently emitting nothing", () => {
    expect(() =>
      renderExpr({ kind: "mean", panel: "Nope", op: ">=", value: 1 }, buildPanels(""), "1h", "5m"),
    ).toThrow(/no buildPanels\(\) panel titled/);
  });

  const stub = [
    { title: "A", query: 'metric_a{x="1"}' },
    { title: "B", query: 'metric_b{x="1"}' },
  ];

  test("threshold renders a bare comparison", () => {
    expect(
      renderExpr({ kind: "threshold", panel: "A", op: "<=", value: 20 }, stub, "1h", "5m"),
    ).toBe('(metric_a{x="1"}) <= 20');
  });

  test("mean wraps the panel in avg_over_time - the avgTrend() equivalent", () => {
    expect(renderExpr({ kind: "mean", panel: "A", op: ">=", value: 20 }, stub, "1h", "5m")).toBe(
      'avg_over_time((metric_a{x="1"})[1h:5m]) >= 20',
    );
  });

  test("sustained counts passing samples over all samples - the sustainedFrac() equivalent", () => {
    expect(
      renderExpr({ kind: "sustained", panel: "A", value: 80, frac: 0.5 }, stub, "1h", "5m"),
    ).toBe(
      '(count_over_time(((metric_a{x="1"}) >= 80)[1h:5m]) / count_over_time((metric_a{x="1"})[1h:5m])) >= 0.5',
    );
  });

  test("ratio divides by the sum of the denominators", () => {
    expect(
      renderExpr(
        { kind: "ratio", num: "A", den: ["A", "B"], op: ">=", value: 0.3 },
        stub,
        "1h",
        "5m",
      ),
    ).toBe('((metric_a{x="1"}) / ((metric_a{x="1"}) + (metric_b{x="1"}))) >= 0.3');
  });
});

describe("thresholds trace to the catalogue", () => {
  test("the CPU rule carries cpuSustainedHighPct and cpuSustainedFrac", () => {
    const r = buildAlertRules().find((x) => x.alert === "SupabaseCpuSaturated")!;
    expect(r.expr).toContain(`>= ${THRESHOLDS.cpuSustainedHighPct}`);
    expect(r.expr).toContain(`>= ${THRESHOLDS.cpuSustainedFrac}`);
  });

  test("the disk rule converts diskFullFrac to a percentage", () => {
    const r = buildAlertRules().find((x) => x.alert === "SupabaseDiskFull")!;
    expect(r.expr).toContain(`>= ${THRESHOLDS.diskFullFrac * 100}`);
  });

  test("annotations are lifted from the heuristic, not restated", () => {
    const r = buildAlertRules().find((x) => x.alert === "SupabaseOomKill")!;
    const h = HEURISTICS.oom_kill!;
    expect(r.annotations.remediation).toBe(h.remediation);
    expect(r.annotations.verify).toBe(h.howToVerify);
    expect(r.annotations.runbook_url).toBe(h.docUrl);
    expect(r.labels.plane).toBe(h.plane);
  });

  test("severity mirrors what findings.ts assigns on that branch", () => {
    const bySeverity = Object.fromEntries(
      buildAlertRules().map((r) => [r.alert, r.labels.severity]),
    );
    expect(bySeverity.SupabaseCpuSaturated).toBe("high");
    expect(bySeverity.SupabaseOomKill).toBe("high");
    expect(bySeverity.SupabaseWalArchivalBacklog).toBe("high");
    expect(bySeverity.SupabaseDiskFull).toBe("med");
    expect(bySeverity.SupabaseMemorySaturated).toBe("med");
  });
});

describe("buildAlertRules options", () => {
  test("a ref matcher scopes every expression", () => {
    for (const r of buildAlertRules({ refMatcher: 'supabase_project_ref="abc"' })) {
      expect(r.expr).toContain('supabase_project_ref="abc"');
    }
  });

  test("no matcher leaves the expressions unscoped", () => {
    for (const r of buildAlertRules()) expect(r.expr).not.toContain("supabase_project_ref");
  });

  test("window and resolution are honoured", () => {
    const r = buildAlertRules({ window: "6h", resolution: "1m" }).find(
      (x) => x.alert === "SupabasePsiCpuStall",
    )!;
    expect(r.expr).toContain("[6h:1m]");
  });

  test("only point-in-time gauge rules carry a `for` - the window smooths the rest", () => {
    for (const r of buildAlertRules({ hold: "7m" })) {
      const spec = ALERT_SPECS.find((s) => s.name === r.alert)!;
      if (spec.expr.kind === "threshold") expect(r.for).toBe("7m");
      else expect(r.for).toBeUndefined();
    }
  });

  test("alert names are unique and PascalCase", () => {
    const names = ALERT_SPECS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^Supabase[A-Za-z0-9]+$/);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test test/alerts.test.ts`
Expected: FAIL with
`error: Cannot find module '../src/alerts.ts' from '<repo>/test/alerts.test.ts'`.

- [ ] **Step 4: Create `src/alerts.ts`**

```ts
import { HEURISTICS, THRESHOLDS } from "./heuristics.ts";
import { buildPanels } from "./prometheus.ts";

/**
 * Prometheus alerting rules generated from the SAME threshold catalogue that
 * ranks findings (heuristics.ts THRESHOLDS + HEURISTICS), so a rule and a
 * report card can never disagree about what "too high" means.
 *
 * The inclusion predicate is deliberately narrow. A finding earns a rule only
 * when BOTH hold:
 *   1. its signal is already a `buildPanels()` trend panel - i.e. a PromQL
 *      expression over metric families the scrape actually serves, proven by
 *      the panel path rather than remembered; and
 *   2. its threshold survives translation to a PromQL range window unchanged.
 * Everything else is listed in EXCLUSIONS / PLANE_EXCLUSIONS with the failing
 * clause named. A pack that alerts on what Prometheus cannot see is worse than
 * no pack, so the exclusion list is a deliverable, not an apology.
 */

/**
 * How a threshold becomes an expression. Every variant references a panel by
 * TITLE - the query text comes from buildPanels(), never from a literal here.
 *
 * - `threshold`: the panel value now, held for `hold` (point-in-time gauges).
 * - `mean`: the panel's mean over the window - mirrors findings.ts avgTrend().
 * - `sustained`: the FRACTION of window samples past the threshold - mirrors
 *   trendstats.ts sustainedFrac(), which counts points, not consecutive time,
 *   so `for:` is the wrong operator for these.
 * - `ratio`: num / (sum of den) - the checkpoint requested-share shape.
 */
export type AlertExpr =
  | { kind: "threshold"; panel: string; op: ">=" | "<="; value: number }
  | { kind: "mean"; panel: string; op: ">=" | ">"; value: number }
  | { kind: "sustained"; panel: string; value: number; frac: number }
  | { kind: "ratio"; num: string; den: string[]; op: ">="; value: number };

export interface AlertSpec {
  /** PascalCase Prometheus alert name. */
  name: string;
  /** Key into HEURISTICS - carries the annotations. */
  heuristicId: string;
  /** Mirrors the severity findings.ts assigns on this branch. */
  severity: "high" | "med";
  expr: AlertExpr;
  /** The catalogue constant(s) behind the number, quoted in the annotation. */
  threshold: string;
  /** One line, present tense, what is true when this fires. */
  summary: string;
  /**
   * Set when the rule needs a metric family the Supabase metrics endpoint does
   * NOT serve, naming the extra scrape source that provides it. Such rules are
   * emitted in a separate `-optional` group so an operator who does not run
   * that source drops one group instead of hunting rules - and so a silent
   * never-firing rule is never mistaken for coverage. Mirrors the report's
   * treatment of the optional PSI / EBS panels (docs/grafana-prometheus.md,
   * "What is and isn't present").
   */
  requires?: string;
}

/**
 * Defaults. THRESHOLDS values are catalogue constants; these three are CHOSEN
 * starting values with no catalogue equivalent - findings.ts evaluates over the
 * report's trend window (--trend-days, default 30), which is far too long for
 * an alert. Tune them per deployment; they are options, not constants.
 */
export const ALERT_WINDOW = "1h";
export const ALERT_RESOLUTION = "5m";
export const ALERT_HOLD = "10m";

export interface AlertOptions {
  /** Project-label selector, same idiom as buildPanels(). "" = unscoped. */
  refMatcher?: string;
  /** Range/subquery window for mean + sustained rules. */
  window?: string;
  /** Subquery step for sustained rules. */
  resolution?: string;
  /** `for:` on point-in-time threshold rules. */
  hold?: string;
}

export const ALERT_SPECS: AlertSpec[] = [
  {
    name: "SupabaseCpuSaturated",
    heuristicId: "cpu_saturated",
    severity: "high",
    expr: {
      kind: "sustained",
      panel: "CPU utilization (%)",
      value: THRESHOLDS.cpuSustainedHighPct,
      frac: THRESHOLDS.cpuSustainedFrac,
    },
    threshold: "THRESHOLDS.cpuSustainedHighPct / cpuSustainedFrac",
    summary: "CPU sustained high - queries are queueing for cores",
  },
  {
    name: "SupabaseMemorySaturated",
    heuristicId: "mem_saturated",
    severity: "med",
    expr: {
      kind: "sustained",
      panel: "Memory used (%)",
      value: THRESHOLDS.memSustainedHighPct,
      frac: THRESHOLDS.memSustainedFrac,
    },
    threshold: "THRESHOLDS.memSustainedHighPct / memSustainedFrac",
    summary: "Memory sustained near the ceiling",
  },
  {
    name: "SupabaseDiskFull",
    heuristicId: "disk_full",
    severity: "med",
    expr: {
      kind: "threshold",
      panel: "Disk used (%)",
      op: ">=",
      value: THRESHOLDS.diskFullFrac * 100,
    },
    threshold: "THRESHOLDS.diskFullFrac",
    summary: "Data disk past the fill threshold",
  },
  {
    name: "SupabaseMajorPageFaults",
    heuristicId: "mem_pressure_paging",
    severity: "med",
    expr: {
      kind: "mean",
      panel: "Major page faults/s",
      op: ">=",
      value: THRESHOLDS.majorFaultsPerSec,
    },
    threshold: "THRESHOLDS.majorFaultsPerSec",
    summary: "Working set paging in from disk (major faults)",
  },
  {
    name: "SupabaseSwapIn",
    heuristicId: "mem_pressure_paging",
    severity: "med",
    expr: {
      kind: "mean",
      panel: "Swap-in pages/s",
      op: ">=",
      value: THRESHOLDS.swapInPagesPerSec,
    },
    threshold: "THRESHOLDS.swapInPagesPerSec",
    summary: "Working set paging in from swap",
  },
  {
    name: "SupabasePsiCpuStall",
    heuristicId: "psi_saturation",
    severity: "med",
    expr: { kind: "mean", panel: "CPU stall (PSI %)", op: ">=", value: THRESHOLDS.psiStallPct },
    threshold: "THRESHOLDS.psiStallPct",
    summary: "Sustained CPU stall time (PSI)",
    requires: "a node_exporter with the pressure-stall collector enabled",
  },
  {
    name: "SupabasePsiMemoryStall",
    heuristicId: "psi_saturation",
    severity: "med",
    expr: { kind: "mean", panel: "Memory stall (PSI %)", op: ">=", value: THRESHOLDS.psiStallPct },
    threshold: "THRESHOLDS.psiStallPct",
    summary: "Sustained memory stall time (PSI)",
    requires: "a node_exporter with the pressure-stall collector enabled",
  },
  {
    name: "SupabasePsiIoStall",
    heuristicId: "psi_saturation",
    severity: "med",
    expr: { kind: "mean", panel: "I/O stall (PSI %)", op: ">=", value: THRESHOLDS.psiStallPct },
    threshold: "THRESHOLDS.psiStallPct",
    summary: "Sustained I/O stall time (PSI)",
    requires: "a node_exporter with the pressure-stall collector enabled",
  },
  {
    name: "SupabaseOomKill",
    heuristicId: "oom_kill",
    severity: "high",
    expr: { kind: "mean", panel: "OOM kills/s", op: ">", value: 0 },
    threshold: "implicit > 0 (findings.ts: any nonzero rate over the window)",
    summary: "Kernel OOM killer fired",
  },
  {
    name: "SupabaseEbsIopsBalanceLow",
    heuristicId: "ebs_balance_low",
    severity: "high",
    expr: {
      kind: "threshold",
      panel: "EBS IOPS balance (%)",
      op: "<=",
      value: THRESHOLDS.ebsBalancePct,
    },
    threshold: "THRESHOLDS.ebsBalancePct",
    summary: "EBS IOPS burst balance depleted - throttling imminent",
    requires: "a cloudwatch_exporter scrape job",
  },
  {
    name: "SupabaseEbsThroughputBalanceLow",
    heuristicId: "ebs_balance_low",
    severity: "high",
    expr: {
      kind: "threshold",
      panel: "EBS throughput balance (%)",
      op: "<=",
      value: THRESHOLDS.ebsBalancePct,
    },
    threshold: "THRESHOLDS.ebsBalancePct",
    summary: "EBS throughput burst balance depleted - throttling imminent",
    requires: "a cloudwatch_exporter scrape job",
  },
  {
    name: "SupabaseCheckpointPressure",
    heuristicId: "checkpoint_pressure",
    severity: "med",
    expr: {
      kind: "ratio",
      num: "Requested checkpoints/s",
      den: ["Requested checkpoints/s", "Timed checkpoints/s"],
      op: ">=",
      value: THRESHOLDS.checkpointReqFrac,
    },
    threshold: "THRESHOLDS.checkpointReqFrac",
    summary: "Most checkpoints are forced by WAL filling, not the timer",
  },
  {
    name: "SupabaseWalArchivalBacklog",
    heuristicId: "wal_archival_backlog",
    severity: "high",
    expr: {
      kind: "mean",
      panel: "WAL files pending archival",
      op: ">=",
      value: THRESHOLDS.walPendingMax,
    },
    threshold: "THRESHOLDS.walPendingMax",
    summary: "WAL archival falling behind - PITR and disk headroom at risk",
  },
];

function panelQuery(panels: { title: string; query: string }[], title: string): string {
  const p = panels.find((x) => x.title === title);
  if (!p) throw new Error(`alerts: no buildPanels() panel titled ${JSON.stringify(title)}`);
  return p.query;
}

export function renderExpr(
  expr: AlertExpr,
  panels: { title: string; query: string }[],
  window: string,
  resolution: string,
): string {
  switch (expr.kind) {
    case "threshold":
      return `(${panelQuery(panels, expr.panel)}) ${expr.op} ${expr.value}`;
    case "mean":
      return `avg_over_time((${panelQuery(panels, expr.panel)})[${window}:${resolution}]) ${expr.op} ${expr.value}`;
    case "sustained": {
      const q = panelQuery(panels, expr.panel);
      const hits = `count_over_time(((${q}) >= ${expr.value})[${window}:${resolution}])`;
      const all = `count_over_time((${q})[${window}:${resolution}])`;
      return `(${hits} / ${all}) >= ${expr.frac}`;
    }
    case "ratio": {
      const num = panelQuery(panels, expr.num);
      const den = expr.den.map((t) => `(${panelQuery(panels, t)})`).join(" + ");
      return `((${num}) / (${den})) ${expr.op} ${expr.value}`;
    }
  }
}

export interface AlertRule {
  alert: string;
  expr: string;
  for?: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  /** Copied from AlertSpec.requires; buckets the rule into the optional group. */
  requires?: string;
}

export function buildAlertRules(opts: AlertOptions = {}): AlertRule[] {
  const window = opts.window ?? ALERT_WINDOW;
  const resolution = opts.resolution ?? ALERT_RESOLUTION;
  const hold = opts.hold ?? ALERT_HOLD;
  const panels = buildPanels(opts.refMatcher ?? "");
  return ALERT_SPECS.map((spec) => {
    const h = HEURISTICS[spec.heuristicId];
    if (!h)
      throw new Error(`alerts: ${spec.name} references unknown heuristic ${spec.heuristicId}`);
    const rule: AlertRule = {
      alert: spec.name,
      expr: renderExpr(spec.expr, panels, window, resolution),
      labels: {
        severity: spec.severity,
        heuristic_id: h.id,
        plane: h.plane,
        ...(spec.requires ? { requires: spec.requires } : {}),
      },
      annotations: {
        summary: spec.summary,
        description: h.whyItMatters,
        remediation: h.remediation,
        verify: h.howToVerify,
        threshold: spec.threshold,
        runbook_url: h.docUrl,
      },
    };
    // The window already smooths mean/sustained/ratio rules; only the
    // point-in-time gauge comparison needs a hold to survive one bad scrape.
    if (spec.expr.kind === "threshold") rule.for = hold;
    if (spec.requires) rule.requires = spec.requires;
    return rule;
  });
}
```

The YAML quoter is NOT here: biome's `lint/correctness/noUnusedVariables` warns on an
unused module-level function, so it lands in Task 3 with its only caller.

- [ ] **Step 5: Run the tests, format, typecheck**

Run: `bun test test/alerts.test.ts && bun run check && bun run typecheck`
Expected: 15 pass / 0 fail; biome reports no fixes needed on `src/alerts.ts`; `tsc` exit 0.

---

### Task 2: the exclusion catalogue and the coverage invariant

The pack's honesty rests on this task, not Task 1. Every one of the 94 heuristics must be
either alerted on or excluded with a reason, and the test enforces it - so adding a
heuristic later forces a decision instead of silently shrinking coverage.

Exclusion is two-level. Eight planes have no metric family behind ANY of their findings,
so they are excluded wholesale by plane; a new Query-plane heuristic is covered the day it
lands. Ids inside those planes that deserve a more specific reason get a per-id entry,
which wins. The four planes with metric-adjacent findings (Compute, Storage, Connections,
Realtime) are classified per id.

**Files:**
- Modify: `src/alerts.ts`
- Test: `test/alerts.test.ts`

- [ ] **Step 1: Write the failing test**

Add `EXCLUSIONS`, `PLANE_EXCLUSIONS`, `renderExclusions` and `unclassifiedHeuristics` to
the existing `../src/alerts.ts` import in `test/alerts.test.ts`, and prepend this describe
block above the `describe("expressions come from buildPanels", ...)` block:

```ts
describe("catalogue coverage", () => {
  test("every heuristic is either alerted on or explicitly excluded", () => {
    expect(unclassifiedHeuristics()).toEqual([]);
  });

  test("every alert spec names a real heuristic", () => {
    for (const s of ALERT_SPECS) {
      expect(HEURISTICS[s.heuristicId], `unknown heuristic ${s.heuristicId}`).toBeDefined();
    }
  });

  test("every per-id exclusion names a real heuristic", () => {
    for (const id of Object.keys(EXCLUSIONS)) {
      expect(HEURISTICS[id], `unknown heuristic ${id}`).toBeDefined();
    }
  });

  test("nothing is both alerted on and excluded", () => {
    for (const s of ALERT_SPECS) {
      expect(EXCLUSIONS[s.heuristicId], `${s.heuristicId} is alerted AND excluded`).toBeUndefined();
      expect(
        PLANE_EXCLUSIONS[HEURISTICS[s.heuristicId]!.plane],
        `${s.heuristicId} is alerted but its plane is class-excluded`,
      ).toBeUndefined();
    }
  });

  test("the exclusion table lists every non-alerted heuristic exactly once", () => {
    const alerted = new Set(ALERT_SPECS.map((s) => s.heuristicId));
    const rows = renderExclusions()
      .split("\n")
      .slice(2)
      .map((r) => r.split("|")[1]!.trim().replaceAll("`", ""));
    expect(rows.length).toBe(Object.keys(HEURISTICS).length - alerted.size);
    expect(new Set(rows).size).toBe(rows.length);
    for (const id of rows) expect(alerted.has(id)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/alerts.test.ts`
Expected: FAIL - `SyntaxError: Export named 'EXCLUSIONS' not found in module '<repo>/src/alerts.ts'`.

- [ ] **Step 3: Add `type Plane` to the heuristics import**

In `src/alerts.ts`, change the first line to:

```ts
import { HEURISTICS, type Plane, THRESHOLDS } from "./heuristics.ts";
```

(That is biome's sort order; writing it any other way makes `bun run check` rewrite the
line.)

- [ ] **Step 4: Append the catalogue and the two accessors**

Append to `src/alerts.ts`:

```ts
/** Why a catalogued finding is not expressible as a Prometheus alert. */
export type ExclusionClause =
  /** No metric family carries the input (SQL diagnostic, Management API plane). */
  | "no-metric"
  /** A metric family exists but buildPanels() charts no panel over it. */
  | "no-panel"
  /** Metric + panel exist, but the catalogue threshold means something a
   * PromQL range window cannot reproduce. */
  | "semantics"
  /** Expressible, but it is a report recommendation, not a page. */
  | "not-an-alert";

/**
 * Planes with no metric family behind ANY of their findings. Excluding by plane
 * rather than by id keeps the list maintainable: a new Query-plane heuristic is
 * covered the day it lands. Ids inside these planes that need a MORE specific
 * reason get a per-id EXCLUSIONS entry, which wins.
 */
export const PLANE_EXCLUSIONS: Partial<Record<Plane, string>> = {
  Query:
    "pg_stat_statements / pg_stat_user_tables diagnostics; the scrape carries no per-query family",
  RLS: "pg_policies + pg_index catalogue analysis; no metric family",
  Vacuum: "pg_stat_user_tables and relfrozenxid age; no metric family",
  Config: "pg_settings values, not a metric family",
  Auth: "GoTrue config from the Management API auth plane, not the metrics endpoint",
  Backups: "Management API backups plane; no metric family",
  Advisor: "advisor/splinter lint output; no metric family",
  Functions: "analytics endpoint functions.combined-stats; no metric family",
};

export const EXCLUSIONS: Record<string, { clause: ExclusionClause; why: string }> = {
  // --- Compute -------------------------------------------------------------
  cpu_oversized: {
    clause: "not-an-alert",
    why: "downsize recommendation - a cost finding for the report, never a page",
  },
  connections_ceiling: {
    clause: "no-metric",
    why: "the denominator is max_connections from pg_settings; pg_stat_database_num_backends has no max_connections counterpart on the scrape",
  },
  // --- Storage -------------------------------------------------------------
  disk_oversized: {
    clause: "not-an-alert",
    why: "downsize recommendation - a cost finding for the report, never a page",
  },
  disk_expanded: {
    clause: "not-an-alert",
    why: "records that a resize happened; informational context, not a page",
  },
  disk_fill_projection: {
    clause: "semantics",
    why: "projectDataDisk() segments the series on a disk RESIZE (diskResizeStepFrac) before fitting; predict_linear has no equivalent, so an auto-expansion would be extrapolated as a cliff",
  },
  disk_iops_high: {
    clause: "no-metric",
    why: "the denominator is provisioned IOPS from the Management API disk plane",
  },
  wal_slot_growing: { clause: "no-metric", why: "pg_replication_slots SQL; no metric family" },
  wal_retained_inactive_slot: {
    clause: "no-metric",
    why: "pg_replication_slots SQL; no metric family",
  },
  wal_slot_lag: { clause: "no-metric", why: "pg_replication_slots SQL; no metric family" },
  cron_history_unpruned: { clause: "no-metric", why: "cron.job_run_details SQL; no metric family" },
  bloat_estimate_suspect: {
    clause: "no-metric",
    why: "bloat estimator cross-check over catalogue stats; no metric family",
  },
  sequence_exhaustion: { clause: "no-metric", why: "pg_sequences SQL; no metric family" },
  toast_cache_cold: { clause: "no-metric", why: "pg_statio TOAST stats; no metric family" },
  storage_concentration: { clause: "no-metric", why: "table-size SQL; no metric family" },
  index_heavy_table: { clause: "no-metric", why: "index-vs-heap size SQL; no metric family" },
  checksum_failure: { clause: "no-metric", why: "pg_stat_database checksum SQL; no metric family" },
  managed_schema_no_pk: { clause: "no-metric", why: "catalogue SQL; no metric family" },
  index_corruption: { clause: "no-metric", why: "amcheck bt_index_check; no metric family" },
  heap_corruption: { clause: "no-metric", why: "amcheck verify_heapam; no metric family" },
  public_bucket: { clause: "no-metric", why: "storage buckets API plane; no metric family" },
  unlogged_table: { clause: "no-metric", why: "pg_class persistence SQL; no metric family" },
  // --- Connections ---------------------------------------------------------
  pooler_clients_waiting: {
    clause: "no-panel",
    why: "pgbouncer_pools_client_waiting_connections is on the scrape and in the metrics allowlist, but buildPanels() charts no pooler panel; add the panel first",
  },
  direct_conn_high: {
    clause: "no-metric",
    why: "compares pg_stat_activity direct connections against max_connections from pg_settings",
  },
  role_conn_high: { clause: "no-metric", why: "per-role pg_stat_activity SQL; no metric family" },
  idle_in_txn_open: { clause: "no-metric", why: "pg_stat_activity SQL; no metric family" },
  // --- Realtime ------------------------------------------------------------
  realtime_postgres_changes: {
    clause: "not-an-alert",
    why: "a scaling nudge on a working feature; any nonzero subscription count is normal",
  },
  // --- Boundary cases inside plane-excluded planes -------------------------
  cache_hit_low: {
    clause: "semantics",
    why: "the catalogue pairs cacheHitPct with cacheHitMinBlocks, a cumulative-since-reset volume floor that stops an idle database reporting a bad ratio; a rate window has no catalogued floor, so a rate-form rule would page on idle projects",
  },
  deadlocks: {
    clause: "semantics",
    why: "deadlockMin is a cumulative count since the last stats reset; increase() over a window answers a different question with the same number",
  },
  work_mem_spill: {
    clause: "no-panel",
    why: "pg_stat_database_temp_bytes_total is on the scrape and trends.ts derives 'Temp file bytes/s' from the store, but buildPanels() has no such panel, so the Prometheus path cannot see it",
  },
};

/** Markdown table of everything deliberately left out, for the pack README. */
export function renderExclusions(): string {
  const rows: string[] = ["| Finding | Plane | Clause | Why |", "| --- | --- | --- | --- |"];
  for (const [id, h] of Object.entries(HEURISTICS).sort(([a], [b]) => a.localeCompare(b))) {
    if (ALERT_SPECS.some((s) => s.heuristicId === id)) continue;
    const specific = EXCLUSIONS[id];
    if (specific) {
      rows.push(`| \`${id}\` | ${h.plane} | ${specific.clause} | ${specific.why} |`);
      continue;
    }
    const byPlane = PLANE_EXCLUSIONS[h.plane];
    if (byPlane) rows.push(`| \`${id}\` | ${h.plane} | no-metric | ${byPlane} |`);
  }
  return rows.join("\n");
}

/** Ids covered by no rule and no exclusion - the drift the test guards. */
export function unclassifiedHeuristics(): string[] {
  return Object.entries(HEURISTICS)
    .filter(
      ([id, h]) =>
        !ALERT_SPECS.some((s) => s.heuristicId === id) &&
        !EXCLUSIONS[id] &&
        !PLANE_EXCLUSIONS[h.plane],
    )
    .map(([id]) => id)
    .sort();
}
```

- [ ] **Step 5: Run the tests, format, typecheck**

Run: `bun test test/alerts.test.ts && bun run check && bun run typecheck`
Expected: 20 pass / 0 fail; `tsc` exit 0.

If "every heuristic is either alerted on or explicitly excluded" fails, the message lists
the unclassified ids - the catalogue gained a heuristic since 2026-08-04. Classify it; do
not widen `PLANE_EXCLUSIONS` to make the test go away, since that would silently exclude
its whole plane.

---

### Task 3: YAML rendering and the optional-group split

Two groups, always both emitted. The main group holds rules whose families the Supabase
endpoint serves; `<name>-optional` holds the five that need an extra scrape source and
stay silent without it. A never-firing rule sitting in the main group reads as coverage,
which is the failure mode this split exists to prevent.

Scalars are single-quoted with `''` escaping. Catalogue prose contains double quotes
(`{"addon_type":"compute_instance"}` in the `cpu_saturated` remediation) and PromQL uses
double quotes for label values, so single-quoted YAML is the style that needs the least
escaping. `quote()` also collapses whitespace, so a multi-line catalogue string cannot
break the file.

**Files:**
- Modify: `src/alerts.ts`
- Test: `test/alerts.test.ts`

- [ ] **Step 1: Write the failing test**

Add `renderAlertsYaml` and `type AlertRule` to the `../src/alerts.ts` import in
`test/alerts.test.ts`, add this type alias just below the imports:

```ts
type ParsedPack = { groups: { name: string; rules: AlertRule[] }[] };
```

and append these two describe blocks to the end of the file:

```ts
describe("renderAlertsYaml", () => {
  const rules = buildAlertRules({ refMatcher: 'supabase_project_ref="abc"' });

  test("round-trips through a YAML parser with the label matchers intact", () => {
    const parsed = Bun.YAML.parse(renderAlertsYaml(rules, "pg-analyser-abc")) as ParsedPack;
    expect(parsed.groups.map((g) => g.name)).toEqual(["pg-analyser-abc", "pg-analyser-abc-optional"]);
    // Rules are split across the two groups, so match by name, not by index.
    const flat = new Map(parsed.groups.flatMap((g) => g.rules).map((r) => [r.alert, r]));
    expect(flat.size).toBe(rules.length);
    for (const src of rules) {
      const r = flat.get(src.alert)!;
      expect(r.expr).toBe(src.expr);
      expect(r.annotations.remediation).toBe(src.annotations.remediation);
      expect(r.labels.heuristic_id).toBe(src.labels.heuristic_id!);
    }
  });

  test("a single quote in an annotation is doubled, not dropped", () => {
    const yaml = renderAlertsYaml([
      {
        alert: "SupabaseQuoteProbe",
        expr: 'up{job="x"} == 0',
        labels: { severity: "high" },
        annotations: { summary: "it's down, don't panic" },
      },
    ]);
    expect(yaml).toContain("''s down");
    const parsed = Bun.YAML.parse(yaml) as ParsedPack;
    expect(parsed.groups[0]!.rules[0]!.annotations.summary).toBe("it's down, don't panic");
  });

  test("newlines in catalogue prose are collapsed so no scalar breaks the file", () => {
    const yaml = renderAlertsYaml([
      {
        alert: "SupabaseNewlineProbe",
        expr: "up == 0",
        labels: {},
        annotations: { summary: "line one\nline two" },
      },
    ]);
    const parsed = Bun.YAML.parse(yaml) as ParsedPack;
    expect(parsed.groups[0]!.rules[0]!.annotations.summary).toBe("line one line two");
  });
});

describe("optional rules are quarantined", () => {
  const rules = buildAlertRules();

  test("the main group holds only endpoint-served rules", () => {
    const parsed = Bun.YAML.parse(renderAlertsYaml(rules, "g")) as ParsedPack;
    expect(parsed.groups.map((x) => x.name)).toEqual(["g", "g-optional"]);
    for (const r of parsed.groups[0]!.rules) expect(r.labels.requires).toBeUndefined();
  });

  test("PSI and CloudWatch EBS rules land in the optional group with their source named", () => {
    const parsed = Bun.YAML.parse(renderAlertsYaml(rules, "g")) as ParsedPack;
    expect(parsed.groups[1]!.rules.map((r) => r.alert)).toEqual([
      "SupabasePsiCpuStall",
      "SupabasePsiMemoryStall",
      "SupabasePsiIoStall",
      "SupabaseEbsIopsBalanceLow",
      "SupabaseEbsThroughputBalanceLow",
    ]);
    for (const r of parsed.groups[1]!.rules) expect(r.labels.requires!.length).toBeGreaterThan(0);
  });

  test("every rule appears in exactly one group", () => {
    const parsed = Bun.YAML.parse(renderAlertsYaml(rules, "g")) as ParsedPack;
    const all = parsed.groups.flatMap((g) => g.rules.map((r) => r.alert));
    expect(all.length).toBe(rules.length);
    expect(new Set(all).size).toBe(rules.length);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/alerts.test.ts`
Expected: FAIL - `SyntaxError: Export named 'renderAlertsYaml' not found in module '<repo>/src/alerts.ts'`.

- [ ] **Step 3: Append the renderer**

Append to `src/alerts.ts`:

```ts
function quote(s: string): string {
  return `'${s.replace(/\s+/g, " ").trim().replace(/'/g, "''")}'`;
}

/**
 * Two groups, always both emitted. `<name>` holds rules whose families the
 * Supabase metrics endpoint serves; `<name>-optional` holds the ones that need
 * an extra scrape source (PSI, CloudWatch EBS) and stay silent without it. The
 * split is the point: a never-firing rule sitting in the main group reads as
 * coverage.
 */
export function renderAlertsYaml(rules: AlertRule[], groupName = "pg-analyser"): string {
  const emit = (out: string[], r: AlertRule): void => {
    out.push(`      - alert: ${r.alert}`);
    out.push(`        expr: ${quote(r.expr)}`);
    if (r.for) out.push(`        for: ${r.for}`);
    out.push("        labels:");
    for (const k of Object.keys(r.labels)) out.push(`          ${k}: ${quote(r.labels[k]!)}`);
    out.push("        annotations:");
    for (const k of Object.keys(r.annotations))
      out.push(`          ${k}: ${quote(r.annotations[k]!)}`);
  };
  const out: string[] = [
    "# Generated by pg-analyser from the heuristics.ts threshold catalogue.",
    "# Every expression is a buildPanels() trend-panel query, so a rule and the",
    "# report card behind it read the same number. Regenerate; do not hand-edit.",
    "groups:",
    `  - name: ${groupName}`,
    "    rules:",
  ];
  for (const r of rules.filter((x) => !x.requires)) emit(out, r);
  out.push("  # These need a scrape source beyond the Supabase metrics endpoint and stay");
  out.push("  # silent without it - see the `requires` label. Delete the group if you do");
  out.push("  # not run that source, so an inert rule is never read as coverage.");
  out.push(`  - name: ${groupName}-optional`);
  out.push("    rules:");
  for (const r of rules.filter((x) => x.requires)) emit(out, r);
  return `${out.join("\n")}\n`;
}
```

- [ ] **Step 4: Run the tests, format, typecheck**

Run: `bun test test/alerts.test.ts && bun run check && bun run typecheck`
Expected: 26 pass / 0 fail; `tsc` exit 0.

---

### Task 4: `check:alerts`, and declaring what the corpus cannot confirm

Rules are pinned to metric family names, and a renamed family makes a rule silently never
fire. The repo's existing answer to that class of problem is an advisory drift script
(`check:lints` diffs the catalog against vendored splinter SQL; `check:schemas` enforces a
superset invariant). This is the same shape, with one thing ruled out up front: comparing
the emitted `alerts.yml` against `buildAlertRules()` would compare two artifacts of the
same source and pass forever. It is not in this script.

The only external artifact available offline is `test/fixtures/metrics-sample.txt`, a
captured real scrape - but a TRUNCATED one (39820 bytes, last line cut mid-token). It can
confirm a family exists and can never prove one absent. So it is used one-directionally:
what it confirms is green; everything else must be DECLARED in `CORPUS_GAPS` with a
reason. An undeclared miss is a typo or an invented name. A declared entry the corpus
DOES contain is stale, which is what makes recapturing the corpus promote entries instead
of letting them rot.

**Files:**
- Modify: `src/alerts.ts`
- Create: `scripts/check-alerts-drift.ts`
- Modify: `package.json`
- Test: `test/alerts.test.ts`

- [ ] **Step 1: Write the failing test**

Add `CORPUS_GAPS` to the `../src/alerts.ts` import in `test/alerts.test.ts` and append:

```ts
describe("corpus gaps", () => {
  test("every declared gap is actually referenced by a rule", () => {
    const rendered = buildAlertRules({ refMatcher: '__probe__="1"' })
      .map((r) => r.expr)
      .join("\n");
    for (const name of Object.keys(CORPUS_GAPS)) {
      expect(rendered.includes(`${name}{`), `${name} is declared unconfirmed but unused`).toBe(
        true,
      );
    }
  });

  test("no gap is confirmed by the committed corpus capture", async () => {
    const corpus = await Bun.file(`${import.meta.dir}/fixtures/metrics-sample.txt`).text();
    const seen = new Set<string>();
    for (const line of corpus.split("\n")) {
      if (!line || line.startsWith("#")) continue;
      const name = line.split(/[ {]/, 1)[0];
      if (name) seen.add(name);
    }
    for (const name of Object.keys(CORPUS_GAPS)) {
      expect(seen.has(name), `${name} is in the corpus - promote it out of CORPUS_GAPS`).toBe(
        false,
      );
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/alerts.test.ts`
Expected: FAIL - `SyntaxError: Export named 'CORPUS_GAPS' not found in module '<repo>/src/alerts.ts'`.

- [ ] **Step 3: Append the declarations**

Append to `src/alerts.ts`:

```ts
/**
 * Metric families a rule references that the committed corpus capture does not
 * confirm. `test/fixtures/metrics-sample.txt` is a TRUNCATED real scrape (cut
 * mid-line at 39820 bytes), so it can prove a family EXISTS and can never prove
 * one absent - an undeclared miss is a typo or an invented name, a declared one
 * is a known blind spot. check-alerts-drift.ts warns on both an undeclared miss
 * and a stale entry, so recapturing the corpus promotes entries rather than
 * letting them rot. Confirm against a live scrape (see docs/alerts.md) and
 * delete the entry.
 */
export const CORPUS_GAPS: Record<string, string> = {
  node_pressure_cpu_waiting_seconds_total:
    "the pressure-stall collector is not enabled on the Supabase metrics endpoint (docs/grafana-prometheus.md); the panel and rule exist for a Prometheus that also scrapes a node_exporter with PSI on",
  node_pressure_memory_waiting_seconds_total:
    "the pressure-stall collector is not enabled on the Supabase metrics endpoint (docs/grafana-prometheus.md); the panel and rule exist for a Prometheus that also scrapes a node_exporter with PSI on",
  node_pressure_io_waiting_seconds_total:
    "the pressure-stall collector is not enabled on the Supabase metrics endpoint (docs/grafana-prometheus.md); the panel and rule exist for a Prometheus that also scrapes a node_exporter with PSI on",
  pg_stat_bgwriter_checkpoints_req_total:
    "postgres_exporter bgwriter collector; past the truncation point of the committed corpus capture",
  pg_stat_bgwriter_checkpoints_timed_total:
    "postgres_exporter bgwriter collector; past the truncation point of the committed corpus capture",
  pg_ls_archive_statusdir_wal_pending_count:
    "postgres_exporter archive-statusdir collector; past the truncation point of the committed corpus capture",
  aws_ec2_ebsiobalance_percent_minimum:
    "CloudWatch, not the Supabase metrics endpoint - present only when the Prometheus also scrapes cloudwatch_exporter, so this rule is inert otherwise",
  aws_ec2_ebsbyte_balance_percent_minimum:
    "CloudWatch, not the Supabase metrics endpoint - present only when the Prometheus also scrapes cloudwatch_exporter, so this rule is inert otherwise",
};
```

- [ ] **Step 4: Create `scripts/check-alerts-drift.ts`**

```ts
#!/usr/bin/env bun
/**
 * Alert-pack drift-check (advisory, offline). Two layers, same shape as
 * check-api-drift.ts:
 *
 * PRIMARY - catalogue coverage. Every heuristic in HEURISTICS must be either
 * alerted on or explicitly excluded (per-id or by plane). A new heuristic that
 * nobody classified is the drift that actually happens: the pack silently stops
 * covering the catalogue it claims to be derived from.
 *
 * CROSS-CHECK - metric-name confirmation against the captured corpus in
 * test/fixtures/metrics-sample.txt. That file is a TRUNCATED real scrape
 * (39820 bytes, cut mid-line), so it can confirm a family exists and can never
 * prove one absent. Names it confirms are green; the rest must carry a
 * CORPUS_GAPS entry in src/alerts.ts saying why they are unconfirmed. A
 * CORPUS_GAPS entry the corpus now contains is stale and gets warned, so
 * recapturing the corpus promotes entries instead of rotting them.
 *
 *   bun run scripts/check-alerts-drift.ts        # warn on drift, exit 0
 *   PG_ANALYSER_ALERTS_STRICT=1 bun run ...           # exit 1 on drift (gated job)
 */

import { buildAlertRules, CORPUS_GAPS, unclassifiedHeuristics } from "../src/alerts.ts";

const IN_GHA = process.env.GITHUB_ACTIONS === "true";
const STRICT = process.env.PG_ANALYSER_ALERTS_STRICT === "1";
const warn = (m: string): void => console.error(IN_GHA ? `::warning::${m}` : `warning: ${m}`);
let drifted = false;

// --- PRIMARY: every heuristic classified ------------------------------------
const unclassified = unclassifiedHeuristics();
if (unclassified.length) {
  drifted = true;
  warn(
    `${unclassified.length} heuristic(s) are neither alerted nor excluded - add an ALERT_SPECS ` +
      `entry or an EXCLUSIONS entry in src/alerts.ts: ${unclassified.join(", ")}`,
  );
}

// --- CROSS-CHECK: metric names against the captured corpus ------------------
// Render with a sentinel matcher so EVERY selector carries braces, then read
// the family name off the left of each one. Exact, no PromQL-function denylist.
const PROBE = "__sbperf_probe__";
const rendered = buildAlertRules({ refMatcher: `${PROBE}="1"` })
  .map((r) => r.expr)
  .join("\n");
const used = new Set<string>();
for (const m of rendered.matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)\{[^}]*__sbperf_probe__/g))
  used.add(m[1]!);

if (used.size === 0) {
  warn("no metric families extracted from the rules - has buildPanels() stopped using matchers?");
  process.exit(STRICT ? 1 : 0);
}

const corpusPath = new URL("../test/fixtures/metrics-sample.txt", import.meta.url).pathname;
const corpus = await Bun.file(corpusPath).text();
const seen = new Set<string>();
for (const line of corpus.split("\n")) {
  if (!line || line.startsWith("#")) continue;
  const name = line.split(/[ {]/, 1)[0];
  if (name) seen.add(name);
}

const unconfirmed = [...used].filter((n) => !seen.has(n)).sort();
const undeclared = unconfirmed.filter((n) => !CORPUS_GAPS[n]);
const stale = Object.keys(CORPUS_GAPS)
  .filter((n) => seen.has(n))
  .sort();

if (undeclared.length) {
  drifted = true;
  warn(
    `${undeclared.length} alert metric(s) are not in the captured corpus and have no CORPUS_GAPS ` +
      `entry (confirm against a live scrape, then declare or fix): ${undeclared.join(", ")}`,
  );
}
if (stale.length) {
  drifted = true;
  warn(
    `${stale.length} CORPUS_GAPS entr(y/ies) are now present in the corpus - promote them by ` +
      `deleting the entry: ${stale.join(", ")}`,
  );
}

if (!drifted) {
  console.error(
    `alert pack in sync: ${used.size} metric families, ` +
      `${used.size - unconfirmed.length} confirmed by the corpus capture, ` +
      `${unconfirmed.length} declared unconfirmed; every heuristic classified`,
  );
  process.exit(0);
}
process.exit(STRICT ? 1 : 0);
```

The character class is `[a-zA-Z_][a-zA-Z0-9_]*`, not `[a-z_][a-z0-9_]*`. In the dry run
the lowercase-only version silently matched the tails of `node_memory_MemAvailable_bytes`
and `node_memory_MemTotal_bytes` as `vailable_bytes` and `otal_bytes`, then reported them
as undeclared metrics. Prometheus family names are case-sensitive and node_exporter uses
mixed case.

- [ ] **Step 5: Register the script**

In `package.json`, add the line above `"check:api"` so the `check:*` block stays
alphabetical:

```json
    "check:alerts": "bun run scripts/check-alerts-drift.ts",
```

- [ ] **Step 6: Run everything**

Run: `bun test && bun run check && bun run typecheck && bun run check:alerts`
Expected: 679 pass / 0 fail; `tsc` exit 0; and

```
alert pack in sync: 16 metric families, 8 confirmed by the corpus capture, 8 declared unconfirmed; every heuristic classified
```

exit 0. If the family count is not 16, a panel query changed - reconcile before moving on.

---

### Task 5: the `alerts-init` subcommand

`doAlertsInit` lives in `index.ts`, not in `alerts.ts`, so the generator module stays pure
and fully unit-testable. That mirrors `doExportPrometheus`, which does its file writing in
`index.ts` over the pure `toOpenMetrics`.

**Files:**
- Modify: `src/index.ts`

No unit test: this function is `mkdir` plus two `Bun.write` calls over already-tested pure
functions, and it is exercised end-to-end in Step 4. Step 3 of Task 6 covers the same
generator through `writeScraper`, which does have a test.

- [ ] **Step 1: Add the import**

In `src/index.ts`, directly above the `./brand.ts` import (biome's sort order):

```ts
import { buildAlertRules, renderAlertsYaml, renderExclusions } from "./alerts.ts";
```

- [ ] **Step 2: Add the usage line**

In the `usage()` heredoc, directly below the `scrape-init` line:

```
  pg-analyser alerts-init [--ref <ref>] [--dir <d>] write the Prometheus alerting-rule pack
```

- [ ] **Step 3: Add the writer, directly above `async function main()`**

```ts
/**
 * Write the Prometheus alerting-rule pack. Pure generation from the heuristics
 * catalogue - no PAT, no DB, no network. --ref scopes every expression to one
 * project via the supabase_project_ref label the metrics endpoint emits itself;
 * omit it for a single-project scraper.
 */
async function doAlertsInit(ref: string | undefined, dir: string): Promise<void> {
  const rules = buildAlertRules({ refMatcher: ref ? `supabase_project_ref="${ref}"` : "" });
  await mkdir(dir, { recursive: true });
  const yamlPath = join(dir, "alerts.yml");
  await Bun.write(yamlPath, renderAlertsYaml(rules, ref ? `pg-analyser-${ref}` : "pg-analyser"));
  await Bun.write(
    join(dir, "EXCLUSIONS.md"),
    `# Findings deliberately NOT alerted on\n\n${renderExclusions()}\n`,
  );
  console.error(`> ${yamlPath} (${rules.length} rules)`);
  console.error(`> ${join(dir, "EXCLUSIONS.md")} - what is left out, and why`);
  console.error("");
  console.error("Load it into the scrape-init stack (or any Prometheus):");
  console.error("");
  console.error(`  cp ${yamlPath} scraper-live/alerts.yml`);
  console.error("  # prometheus.yml:  rule_files: [ /etc/prometheus/alerts.yml ]");
  console.error("  # compose.yml:     ./alerts.yml:/etc/prometheus/alerts.yml:ro");
  console.error("  (cd scraper-live && docker compose restart prometheus)");
}
```

Then in `main()`'s switch, directly above `case "scrape-init":`:

```ts
      case "alerts-init": {
        await doAlertsInit(flags.ref, flags.dir ?? "alerts-pack");
        break;
      }
```

`--ref` and `--dir` already exist in `parseFlags`; no flag parsing changes. Unlike
`scrape-init` there is no `if (!flags.ref) usage()` guard - an unscoped pack is the correct
output for a single-project scraper, and `buildPanels("")` handles the empty matcher.

- [ ] **Step 4: Run it**

Run:
```bash
bun run check && bun run typecheck
rm -rf /tmp/apack && bun run src/index.ts alerts-init --ref abcdefghijklmnopqrst --dir /tmp/apack
wc -l /tmp/apack/alerts.yml /tmp/apack/EXCLUSIONS.md
bun -e 'const y = Bun.YAML.parse(await Bun.file("/tmp/apack/alerts.yml").text()) as any; for (const g of y.groups) console.log(g.name, g.rules.length)'
```
Expected: `tsc` exit 0; `> /tmp/apack/alerts.yml (13 rules)` on stderr; 188 and 89 lines;
and

```
pg-analyser-abcdefghijklmnopqrst 8
pg-analyser-abcdefghijklmnopqrst-optional 5
```

- [ ] **Step 5: Check the unscoped form too**

Run: `rm -rf /tmp/apack-noref && bun run src/index.ts alerts-init --dir /tmp/apack-noref && grep -c supabase_project_ref /tmp/apack-noref/alerts.yml`
Expected: the write succeeds and `grep -c` prints `0` with exit status 1 (no matches).
An unscoped pack must contain no project label at all.

---

### Task 6: ship the pack inside the scrape-init stack

A rule file nobody mounts is a rule file that never fires. `scrape-init` already writes the
Prometheus config and the compose file, so it writes and wires `alerts.yml` too.

**Files:**
- Modify: `src/scraper.ts`
- Test: `test/scraper.test.ts`

- [ ] **Step 1: Write the failing test**

In `test/scraper.test.ts`, inside the existing
`test("emits a full stack embedding service_role as basic_auth", ...)`, append after the
`.gitignore` assertion:

```ts
    // the alerting-rule pack ships with the stack and is actually loaded -
    // a rule file nobody mounts is a rule file that never fires
    expect(prom).toContain("rule_files:");
    expect(prom).toContain("- /etc/prometheus/alerts.yml");
    expect(await readFile(join(dir, "compose.yml"), "utf8")).toContain(
      "./alerts.yml:/etc/prometheus/alerts.yml:ro",
    );
    const alerts = await readFile(join(dir, "alerts.yml"), "utf8");
    expect(alerts).toContain("- name: pg-analyser-myref");
    expect(alerts).toContain('supabase_project_ref="myref"');
    // alerts.yml carries no credential, so it is NOT gitignored
    expect(await readFile(join(dir, ".gitignore"), "utf8")).not.toContain("alerts.yml");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/scraper.test.ts`
Expected: FAIL on `expect(prom).toContain("rule_files:")` - "Expected to contain:
'rule_files:'".

- [ ] **Step 3: Wire it up**

In `src/scraper.ts`, add the import above the `./config.ts` import:

```ts
import { buildAlertRules, renderAlertsYaml } from "./alerts.ts";
```

In the `prometheusYml` template, between the `global:` block and `scrape_configs:`:

```
# Alerting rules generated from the pg-analyser heuristics catalogue (alerts.ts).
# Regenerate with 'pg-analyser alerts-init --ref <ref>'; do not hand-edit.
rule_files:
  - /etc/prometheus/alerts.yml

```

In the `composeYml` template, directly below the `./prometheus.yml:...:ro` volume:

```
      - ./alerts.yml:/etc/prometheus/alerts.yml:ro
```

And in the `Promise.all([...])` write list, directly after the `prometheus.yml` entry:

```ts
    Bun.write(
      join(dir, "alerts.yml"),
      renderAlertsYaml(
        buildAlertRules({ refMatcher: `supabase_project_ref="${ref}"` }),
        `pg-analyser-${ref}`,
      ),
    ),
```

Do NOT add `alerts.yml` to the generated `.gitignore`. That file lists `prometheus.yml`
because it embeds the service_role key; the rule pack embeds nothing, and the test asserts
the distinction so nobody "tidies" it later.

- [ ] **Step 4: Run the tests**

Run: `bun test test/scraper.test.ts && bun run check && bun run typecheck`
Expected: 1 pass / 0 fail (18 expect() calls); `tsc` exit 0.

---

### Task 7: docs, cross-links, and the ignore rule

**Files:**
- Create: `docs/alerts.md`
- Modify: `docs/grafana-prometheus.md`, `README.md`, `AGENTS.md`, `.gitignore`

- [ ] **Step 1: Ignore the default output dir**

In `.gitignore`, directly below the `/scraper/` block:

```
# local alerts-init output (generated; no credential, just noise in the tree)
/alerts-pack/
```

- [ ] **Step 2: Create `docs/alerts.md`**

````markdown
# Prometheus alerting-rule pack

Supabase serves a Prometheus-format metrics endpoint and log drains, but no
in-product alerting. You get the signal and no notification path. Prometheus
itself is commodity; the part that is not is knowing which number means trouble
on a tier-scaled managed Postgres - and pg-analyser already encodes that, with
justification, in `src/heuristics.ts`.

`alerts-init` emits those thresholds as Prometheus alerting rules:

```bash
bun run src/index.ts alerts-init --ref <ref>            # writes alerts-pack/
bun run src/index.ts alerts-init                        # unscoped (single-project scraper)
bun run src/index.ts alerts-init --ref <ref> --dir /tmp/pack
```

No PAT, no database, no network - it is pure generation from the catalogue. The
`scrape-init` stack already ships the same pack and mounts it, so a fresh
`scrape-init` needs nothing further.

Two files land in the output dir:

| File | Contents |
| --- | --- |
| `alerts.yml` | the rule groups, ready for a Prometheus `rule_files:` entry |
| `EXCLUSIONS.md` | every catalogued finding that is NOT alerted on, and why |

---

## Why generate rather than hand-write

A hand-written rule file drifts from the report the day someone tunes a
threshold. Here every expression is a `buildPanels()` trend-panel query and
every number is a `THRESHOLDS` constant, so a rule and the report card behind it
cannot disagree - change `THRESHOLDS.cpuSustainedHighPct` and both move.

The annotations are lifted from the same `Heuristic` the report renders:
`description` is `whyItMatters`, `remediation` is `remediation`, `verify` is
`howToVerify`, `runbook_url` is `docUrl`. The alert that pages you carries the
same fix text as the report card.

---

## What is alerted on

Eight rules over families the Supabase metrics endpoint serves:

| Alert | Heuristic | Threshold | Shape |
| --- | --- | --- | --- |
| `SupabaseCpuSaturated` | `cpu_saturated` | `cpuSustainedHighPct` / `cpuSustainedFrac` | fraction of window samples past the line |
| `SupabaseMemorySaturated` | `mem_saturated` | `memSustainedHighPct` / `memSustainedFrac` | fraction of window samples past the line |
| `SupabaseDiskFull` | `disk_full` | `diskFullFrac` | gauge now, held for `for:` |
| `SupabaseMajorPageFaults` | `mem_pressure_paging` | `majorFaultsPerSec` | mean over the window |
| `SupabaseSwapIn` | `mem_pressure_paging` | `swapInPagesPerSec` | mean over the window |
| `SupabaseOomKill` | `oom_kill` | any nonzero rate | mean over the window |
| `SupabaseCheckpointPressure` | `checkpoint_pressure` | `checkpointReqFrac` | requested / (requested + timed) |
| `SupabaseWalArchivalBacklog` | `wal_archival_backlog` | `walPendingMax` | mean over the window |

Five more in a separate `-optional` group, because their families are NOT on the
Supabase endpoint - they need a scrape source you add yourself, and they stay
silent without it. Each carries a `requires` label naming that source. Delete
the group if you do not run one, so an inert rule is never read as coverage:

| Alert | Heuristic | Needs |
| --- | --- | --- |
| `SupabasePsiCpuStall` / `SupabasePsiMemoryStall` / `SupabasePsiIoStall` | `psi_saturation` | a node_exporter with the pressure-stall collector enabled |
| `SupabaseEbsIopsBalanceLow` / `SupabaseEbsThroughputBalanceLow` | `ebs_balance_low` | a `cloudwatch_exporter` scrape job |

This mirrors how the report treats the same two panel families - see
[What is and isn't present](grafana-prometheus.md#what-is-and-isnt-present).

### Sustained-fraction rules do not use `for:`

`findings.ts` decides "sustained" with `sustainedFrac()`, which counts the
FRACTION of samples past the threshold, not consecutive time. `for:` requires an
unbroken run, so it answers a different question. Those rules carry the count
ratio in the expression and no `for:`. Only the point-in-time gauge comparisons
(`SupabaseDiskFull`, the two EBS rules) use `for:`, to survive one bad scrape.

### The three tunables

`ALERT_WINDOW` (1h), `ALERT_RESOLUTION` (5m) and `ALERT_HOLD` (10m) are CHOSEN
starting values, not catalogue constants. `findings.ts` evaluates over the
report's trend window (`--trend-days`, default 30), which is far too long to
page on. Tune them in the emitted YAML, or pass `window` / `resolution` / `hold`
to `buildAlertRules()`.

---

## What is NOT alerted on, and why

A finding earns a rule only when both hold:

1. its signal is already a `buildPanels()` trend panel - a PromQL expression
   over families the scrape serves, proven by the panel path rather than
   remembered; and
2. its threshold survives translation to a PromQL range window unchanged.

Everything else is in `EXCLUSIONS.md` with the failing clause named. A pack that
alerts on what Prometheus cannot see is worse than no pack, so the exclusion
list is a deliverable.

| Clause | Meaning | Example |
| --- | --- | --- |
| `no-metric` | no metric family carries the input | `table_bloat` - a `pg_stat_user_tables` estimate |
| `no-panel` | the family exists but `buildPanels()` charts nothing over it | `pooler_clients_waiting` - `pgbouncer_pools_client_waiting_connections` is on the scrape and in the allowlist, but there is no pooler panel |
| `semantics` | metric and panel exist, but the threshold means something a range window cannot reproduce | `deadlocks` - `deadlockMin` counts cumulatively since the last stats reset |
| `not-an-alert` | expressible, but it is a report recommendation | `cpu_oversized` - a downsize saving, never a page |

Three exclusions are worth reading directly, because they look alertable:

- **`cache_hit_low`** - the catalogue pairs `cacheHitPct` with
  `cacheHitMinBlocks`, a cumulative-since-reset volume floor that stops an idle
  database reporting a bad ratio. A rate window has no catalogued floor, so a
  rate-form rule would page on idle projects.
- **`disk_fill_projection`** - `projectDataDisk()` segments the series on a disk
  RESIZE before fitting. `predict_linear` has no equivalent, so an auto-expansion
  would be extrapolated as a cliff.
- **`connections_ceiling`** - the denominator is `max_connections` from
  `pg_settings`. `pg_stat_database_num_backends` has no counterpart on the
  scrape, so the ratio cannot be formed without baking a per-project literal.

The split is enforced, not documented: `unclassifiedHeuristics()` returns every
heuristic that is neither alerted nor excluded, and both `bun test` and
`bun run check:alerts` fail on a non-empty result. Add a heuristic and you must
classify it.

---

## Metric-name confirmation (`check:alerts`)

Rules are pinned to metric families, and a renamed family makes a rule silently
never fire. `check:alerts` is the guard, advisory in the same way as
`check:lints`:

```bash
bun run check:alerts                          # warn on drift, exit 0
PG_ANALYSER_ALERTS_STRICT=1 bun run check:alerts   # exit 1 (gated job)
```

It has two layers:

- **Catalogue coverage** (the drift that actually happens): every heuristic
  classified.
- **Metric confirmation**: each family a rule references is looked up in
  `test/fixtures/metrics-sample.txt`, a captured real scrape. That file is
  TRUNCATED (cut mid-line at 39820 bytes), so it can confirm a family exists and
  can never prove one absent. Anything it does not confirm must carry a
  `CORPUS_GAPS` entry in `src/alerts.ts` saying why; an undeclared miss is a typo
  or an invented name. An entry the corpus DOES contain is stale and gets
  warned, so recapturing the corpus promotes entries instead of letting them rot.

Deliberately not checked: whether the emitted `alerts.yml` matches
`buildAlertRules()`. Both come from the same source, so that comparison is
circular and would pass forever.

### Confirming the unconfirmed families against a live scrape

Eight families are declared in `CORPUS_GAPS`. To promote them, scrape a live
project and grep - the endpoint takes the `service_role` key as a basic-auth
password:

```bash
SR=$(curl -s -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  "https://api.supabase.com/v1/projects/<ref>/api-keys" \
  | jq -r '.[] | select(.name=="service_role") | .api_key')

curl -su "service_role:$SR" \
  "https://<ref>.supabase.co/customer/v1/privileged/metrics" \
  | grep -E '^# TYPE (node_pressure_|pg_stat_bgwriter_|pg_ls_archive_)'
```

Delete each `CORPUS_GAPS` entry the scrape confirms. To promote them
permanently, recapture `test/fixtures/metrics-sample.txt` from the same output
(strip the project ref - the committed fixture uses
`examplerefaaaaaaaaaa`) and `check:alerts` will flag the stale entries for you.

---

## Loading the pack

Into a fresh `scrape-init` stack: nothing to do, it is already mounted and
referenced. Into an existing one, or any other Prometheus:

```yaml
# prometheus.yml
rule_files:
  - /etc/prometheus/alerts.yml
```

```yaml
# compose.yml, under the prometheus service
    volumes:
      - ./alerts.yml:/etc/prometheus/alerts.yml:ro
```

```bash
cp alerts-pack/alerts.yml scraper-live/alerts.yml
(cd scraper-live && docker compose restart prometheus)
```

Validate before restarting (promtool ships inside the `prom/prometheus` image,
so there is nothing to install):

```bash
docker run --rm -v "$PWD/alerts-pack":/in:ro \
  --entrypoint promtool prom/prometheus:v3.1.0 \
  check rules /in/alerts.yml
```

Then confirm Prometheus loaded them:

```bash
curl -s localhost:9090/api/v1/rules | jq '.data.groups[] | {name, rules: (.rules|length)}'
```

Routing to a notifier (Alertmanager, or Grafana's own alerting over the same
rule file) is deliberately out of scope - that part IS commodity.
````

- [ ] **Step 3: Cross-link from `docs/grafana-prometheus.md`**

In the "What is and isn't present" section, replace the closing sentence:

```markdown
The report labels which source fed the Resource snapshot and, when EBS is absent
from an infra source, says so - a missing panel is not a health signal.
```

with:

```markdown
The report labels which source fed the Resource snapshot and, when EBS is absent
from an infra source, says so - a missing panel is not a health signal. The
alerting-rule pack ([`docs/alerts.md`](alerts.md)) applies the same rule: PSI and
EBS rules go in a separate `-optional` group with a `requires` label, so an
inert rule is never read as coverage.
```

- [ ] **Step 4: README and AGENTS**

In `README.md`, directly above the line
"`--prometheus` trends take precedence over the history store when both exist.":

````markdown
### Alerting rules from the same thresholds

Supabase serves the metrics endpoint but no in-product alerting. `alerts-init`
emits the heuristics catalogue as a Prometheus alerting-rule pack - every
expression is a trend-panel query and every number a `THRESHOLDS` constant, so a
rule and the report card behind it cannot disagree:

```bash
bun run src/index.ts alerts-init --ref <ref>   # writes alerts-pack/alerts.yml + EXCLUSIONS.md
```

No PAT and no database - it is pure generation. `scrape-init` ships the same
pack already mounted. Findings with no metric behind them (bloat, unused
indexes, advisors) are NOT emitted as rules; `EXCLUSIONS.md` lists every one and
why. See [`docs/alerts.md`](docs/alerts.md).

````

In `AGENTS.md`, add a Commands row directly above the `check:api` row:

```markdown
| `bun run check:alerts` | assert every heuristic is alerted-or-excluded, and every alert metric is corpus-confirmed or declared |
```

and in the module map, replace the `scraper.ts` entry with:

```
  scraper.ts     generate a going-forward Prometheus+Grafana stack (alternate
                 trend source; `report` prefers --prometheus over the store);
                 also emits + mounts the alerts.ts rule pack
  alerts.ts      Prometheus alerting rules generated from the SAME catalogue that
                 ranks findings. A finding earns a rule only if its signal is
                 already a buildPanels() panel AND its threshold survives a
                 PromQL range window; everything else is in EXCLUSIONS /
                 PLANE_EXCLUSIONS with the failing clause named, and
                 unclassifiedHeuristics() must stay empty. Pure - the file
                 writing lives in index.ts doAlertsInit. Docs: docs/alerts.md
```

- [ ] **Step 5: Full sensor sweep**

Run:
```bash
bun run check && bun run typecheck && bun test && bun run check:alerts && bun run check:lints && bun run check:schemas
```
Expected: biome clean over 105 files; `tsc` exit 0; 679 pass / 0 fail across 37 files;
`check:alerts` in sync; `check:lints` and `check:schemas` unchanged from baseline.

The `promtool check rules` command in the doc needs Docker and was NOT executed in the
2026-08-04 dry run - this box has no Docker daemon reachable from WSL and no host
`promtool`. Run it once on a machine that has either before treating the YAML as
Prometheus-valid; `Bun.YAML.parse` proves the file parses as YAML, not that Prometheus
accepts every expression.

---

### Task 8: confirm the eight unconfirmed families against a live scrape

This is the live-infrastructure step. It needs a PAT and a serving project, so it cannot
run in CI and did not run in the dry run. Do it once, then the pack's metric names rest on
a scrape rather than on the allowlist.

**Files:**
- Modify: `src/alerts.ts` (delete confirmed `CORPUS_GAPS` entries)
- Modify: `test/fixtures/metrics-sample.txt` (optional recapture)

- [ ] **Step 1: Pull the scrape**

Run, with `SUPABASE_ACCESS_TOKEN` set and `<ref>` a project in `ACTIVE_HEALTHY`:

```bash
SR=$(curl -s -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  "https://api.supabase.com/v1/projects/<ref>/api-keys" \
  | jq -r '.[] | select(.name=="service_role") | .api_key')

curl -su "service_role:$SR" \
  "https://<ref>.supabase.co/customer/v1/privileged/metrics" > /tmp/scrape.txt

grep -c '^# TYPE' /tmp/scrape.txt
for m in node_pressure_cpu_waiting_seconds_total \
         node_pressure_memory_waiting_seconds_total \
         node_pressure_io_waiting_seconds_total \
         pg_stat_bgwriter_checkpoints_req_total \
         pg_stat_bgwriter_checkpoints_timed_total \
         pg_ls_archive_statusdir_wal_pending_count; do
  printf '%-46s %s\n' "$m" "$(grep -qE "^${m}([ {])" /tmp/scrape.txt && echo PRESENT || echo absent)"
done
```

Record the family count (AGENTS.md's figure is ~321) and the six results. The two
`aws_ec2_*` families are CloudWatch and will be absent - that is expected, and their
`CORPUS_GAPS` entries say so; leave them.

- [ ] **Step 2: Act on the answer**

For each family reported PRESENT, delete its `CORPUS_GAPS` entry in `src/alerts.ts`.
For any reported absent that is NOT `node_pressure_*` or `aws_ec2_*`, the rule that uses
it cannot fire: either the family was renamed (fix the panel in `prometheus.ts`, which
fixes the report too) or the collector is off (move the heuristic to `EXCLUSIONS` with
clause `no-metric`, or give the spec a `requires` so it lands in the optional group).

- [ ] **Step 3: Optionally recapture the corpus**

If you recapture `test/fixtures/metrics-sample.txt` from `/tmp/scrape.txt`, replace the
real project ref with `examplerefaaaaaaaaaa` everywhere first - both the
`supabase_project_ref` and `supabase_identifier` labels carry it:

```bash
sed 's/<ref>/examplerefaaaaaaaaaa/g' /tmp/scrape.txt > test/fixtures/metrics-sample.txt
bun run check:alerts
```

Expected: `check:alerts` now warns "CORPUS_GAPS entr(y/ies) are now present in the
corpus - promote them by deleting the entry" for whatever the fuller capture covers.
Delete those entries and rerun until it reports in sync.

- [ ] **Step 4: Re-run the sensors**

Run: `bun test && bun run check:alerts`
Expected: green, with a higher "confirmed by the corpus capture" count.

---

## Self-review

**Coverage.** The plan covers the generator, its 28 tests, the exclusion catalogue and the
invariant that keeps it complete, the CLI subcommand, the scrape-init integration, the
drift check, and the docs. It does not cover Alertmanager routing, per-window CLI flags,
or adding the two missing panels that would make `pooler_clients_waiting` and
`work_mem_spill` alertable - all three are named in the File structure section as
deliberate deferrals rather than left to be discovered.

**Placeholders.** None. Every task carries the literal code to write, including all 13
alert specs, all 29 per-id exclusions, the 8 plane exclusions, the 8 corpus-gap
declarations, and the full text of `docs/alerts.md`. Task 8 is the only task without code,
because its output is a fact about a live project rather than a source change; it says
exactly which command produces that fact and what to do with each possible answer.

**Type consistency.** `AlertExpr`, `AlertSpec`, `AlertOptions`, `AlertRule`,
`ExclusionClause` and `Plane` are the only types crossing task boundaries. `Plane` is
imported from `heuristics.ts` in Task 2; the other five are defined in Task 1 except
`ExclusionClause`, defined in Task 2 immediately above its only consumer. Task 3 consumes
`AlertRule.requires`, declared in Task 1. `noUncheckedIndexedAccess` is why
`HEURISTICS[id]`, `r.labels[k]`, `line.split(...)[0]` and `rules[i]` all carry a `!` or a
guard - dropping one is the most likely way to break `bun run typecheck` while editing
this.

**Known weakness to watch.** The pack's correctness rests on eight metric names that no
artifact in this repo confirms, only the display allowlist and the panel set. Task 8 is
the fix, and until it runs, `check:alerts` reports those eight as "declared unconfirmed"
rather than pretending they are verified. The second weakness is that `Bun.YAML.parse`
proves the file is YAML, not that Prometheus accepts the PromQL - the `promtool check
rules` step exists for that and could not run here. The third is soft: `AlertSpec.severity`
mirrors `findings.ts` by hand, and nothing enforces the match, because the severity in
`findings.ts` is computed inside a branch rather than stored on the heuristic. A test
pins the five that matter most; a genuine fix would mean moving severity onto the
`Heuristic` record, which is a catalogue change and out of scope here.

**What the dry run changed.** Eight defects, listed in the order they surfaced:

1. The metric-name extraction regex in `check-alerts-drift.ts` was `[a-z_][a-z0-9_]*`,
   which matched only the lowercase tails of `node_memory_MemAvailable_bytes` and
   `node_memory_MemTotal_bytes` and reported `vailable_bytes` / `otal_bytes` as undeclared
   metrics. Fixed to `[a-zA-Z_][a-zA-Z0-9_]*`.
2. The plan originally put all 13 rules in one group. `docs/grafana-prometheus.md` records
   that the PSI collector is not enabled on the Supabase endpoint and that EBS balance is
   CloudWatch-only, which means five rules would have sat in the main group never firing
   and reading as coverage. Added `AlertSpec.requires` and the `-optional` group.
3. The YAML round-trip test indexed `parsed.groups[0].rules[i]` against `rules[i]`. Once
   the pack became two groups that alignment broke; the test now matches by alert name.
4. `pooler_clients_waiting` was going to be a rule: the family is on the scrape and in the
   allowlist, but `buildPanels()` has no pooler panel, so there is no query to build the
   expression from. Same for `work_mem_spill` and `pg_stat_database_temp_bytes_total`,
   which only `trends.ts` reads. Both became `no-panel` exclusions, and that clause was
   added because `no-metric` would have been a lie.
5. An early draft of `EXCLUSIONS` carried a placeholder key deleted at module load with
   `delete EXCLUSIONS.<key>`. Removed - the "every per-id exclusion names a real
   heuristic" test would have failed on it, and mutating an exported const at load time is
   not a pattern in this repo.
6. The doc comment on `AlertSpec.requires` contained a backslash-escaped apostrophe
   (`isn\'t`) inside a block comment, where the escape is not interpreted and renders as
   two characters. biome does not flag it. Corrected to a plain apostrophe.
7. Task 1 originally defined `quote()` alongside `panelQuery()`, with a note claiming
   biome tolerates an unused module-level function. It does not:
   `lint/correctness/noUnusedVariables` fires, and Task 1's "biome clean" gate failed on
   the verbatim pass. `quote()` moved into Task 3 with its only caller. The same run also
   showed the Task 1 test file's multi-line import being collapsed by biome, so it is now
   written as the single line biome produces.
8. This document's README snippet was a ```` ```markdown ```` block wrapping a
   ```` ```bash ```` block. The inner fence closed the outer one, so the last four lines
   of the snippet rendered as body text and a block extractor cut it short. The outer
   fence is now four backticks, matching the `docs/alerts.md` block.

**Sensor numbers, before and after.**

| Sensor | Baseline | After Task 7 |
| --- | --- | --- |
| `bun run lint` | clean, 102 files | clean, 105 files |
| `bun run typecheck` | exit 0 | exit 0 |
| `bun test` | 651 pass / 0 fail, 36 files | 679 pass / 0 fail, 37 files |
| `bun run check:alerts` | (did not exist) | in sync: 16 families, 8 confirmed, 8 declared |
| `bun run check:lints` | in sync, 28 lints | unchanged |
| `bun run check:schemas` | covers 26 exclusions | unchanged |

Not run, and why: `bun run check:api`, `check:inspect`, `check:pgversions` and
`check:docurls` reach the network and are untouched by this change. `analyze`, `full` and
`pdf` need a PAT, a connstring or Chromium. `promtool check rules` needs Docker. Task 8
needs a live project.
