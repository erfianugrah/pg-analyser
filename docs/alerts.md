# Prometheus alerting-rule pack

Supabase serves a Prometheus-format metrics endpoint and log drains, but no
in-product alerting. You get the signal and no notification path. Prometheus
itself is commodity; the part that is not is knowing which number means trouble
on a tier-scaled managed Postgres - and pg-analyser already encodes that, with
justification, in `src/heuristics.ts`.

`alerts-init` emits those thresholds as Prometheus alerting rules:

```bash
bun run src/index.ts alerts-init --ref <ref>            # writes alerts-pack/, rules pinned to one project
bun run src/index.ts alerts-init --ref '~.+'            # label-present matcher: multi-project, supabase jobs only
bun run src/index.ts alerts-init                        # unscoped (single-project scraper)
bun run src/index.ts alerts-init --ref <ref> --dir /tmp/pack
```

`--ref '~<regex>'` emits `supabase_project_ref=~"<regex>"` instead of equality.
`'~.+'` (label present) is the right shape for a multi-project scraper whose
Prometheus also scrapes other node/postgres exporters: the fully unscoped form
fires the node_* rules on every scraped host, not just Supabase projects.

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
| `SupabaseCheckpointPressure` | `checkpoint_pressure` | `checkpointReqFrac` | requested / (requested + timed), window-smoothed |
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

### Ratio rules smooth each leg before dividing

The ratio form (only `SupabaseCheckpointPressure` today) applies the
`avg_over_time` window to the numerator and each denominator BEFORE dividing.
That matches `findings.ts`, which takes the mean of each rate over the trend
window and then divides. It is not cosmetic: the checkpoint counters increment
in impulses (one timed checkpoint per `checkpoint_timeout`), so a bare
`rate(...[5m])` ratio is 0 or 1 at almost every evaluation - a single forced
checkpoint flips an unsmoothed share to 1 for one evaluation, and with no
`for:` hold that is one firing/resolved flap. Smoothed, the share is the
window's requested proportion and only sustained WAL pressure keeps it past
`checkpointReqFrac`.

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
