# Prometheus + Grafana scrape stack

`sbperf scrape-init` generates a ready-to-run Prometheus + Grafana stack that
scrapes a project's privileged metrics endpoint on an interval, giving you real
going-forward time-series history. The metrics endpoint itself is point-in-time
(a scrape target, not a TSDB), so history only exists once something is
scraping it - this stack is that something.

Two independent things consume the scraped data:

1. **Grafana** renders a dashboard from it directly (open a browser).
2. **The sbperf report** reads it via `--prometheus` and renders the same trend
   panels inline in `report.html` (`fetchTrends`, see [below](#the-report-route-fetchtrends)).

Both work against the same scrape with no relabelling, because they key on the
`supabase_project_ref` label the endpoint emits itself.

---

## Generate and run

```bash
bun run src/index.ts scrape-init --ref <ref>        # writes ./scraper-live/
#                                --dir <path>       # override the output dir
cd scraper-live
docker compose up -d
```

- **Grafana**: <http://localhost:3000> (anonymous viewer; `admin`/`admin` to edit)
- **Prometheus**: <http://localhost:9090>

History accrues from the moment you start scraping; it is **not** retroactive.
For retroactive history from the SQLite store, see
[Backfilling past history](#backfilling-past-history-retroactive).

> The generated `prometheus.yml` contains a live credential (see below) and is
> gitignored inside the stack dir. If you run this from inside the sbperf repo,
> the whole `scraper-live/` (or `--dir`) tree is gitignored.

---

## What gets generated

```
scraper-live/
  compose.yml                                   Prometheus + Grafana services
  prometheus.yml                                scrape config (embeds a credential)
  .gitignore                                    ignores prometheus.yml
  README.md                                     quick start
  grafana/
    provisioning/
      datasources/prometheus.yml                the Prometheus datasource (uid: prometheus)
      dashboards/dashboards.yml                 dashboard provider
    dashboards/
      supabase.json                             the generated dashboard
```

### `compose.yml`

- `prom/prometheus` with `--storage.tsdb.retention.time=90d` (90-day retention so
  a 30-day dashboard view always has headroom), TSDB in a named volume.
- `grafana/grafana` with anonymous viewer access enabled and `admin`/`admin` for
  editing, data in a named volume.
- Named volumes (not host bind mounts) on purpose - bind-mounting a host dir into
  the `nobody(65534)` / `grafana(472)` containers hits a uid-mismatch crash.

Ports are `9090:9090` and `3000:3000`. If `3000` is already taken locally, remap
Grafana's published port in `compose.yml` (e.g. `"3001:3000"`) before `up`.

### `prometheus.yml`

```yaml
global:
  scrape_interval: 60s
  scrape_timeout: 30s

scrape_configs:
  - job_name: supabase
    scheme: https
    metrics_path: /customer/v1/privileged/metrics
    basic_auth:
      username: service_role
      password: <service_role key, fetched at generation time>
    static_configs:
      - targets: ['<ref>.supabase.co']
```

- The metrics endpoint is HTTP basic-auth with `service_role` as the password.
  `scrape-init` fetches that key once via the Management API at generation time
  and embeds it - that is the credential the file carries, hence gitignored.
- No `relabel_configs` and no injected target labels: the endpoint already tags
  every series with `supabase_project_ref="<ref>"` (and `supabase_identifier`,
  `service_type`), which is all the queries need.

### The datasource

Provisioned with a **pinned UID** (`prometheus`) so the dashboard's panel and
template-variable references resolve deterministically:

```yaml
apiVersion: 1
datasources:
  - name: Prometheus
    type: prometheus
    uid: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true
```

### The dashboard (`grafana/dashboards/supabase.json`)

A **clean-room** dashboard generated from sbperf's own trend panel definitions
(`buildPanels()` in `src/prometheus.ts`) - the exact same list the report's
trend panels use, so Grafana and the report render the same set and stay in
lockstep. It is regenerated from that one source; there is no hand-maintained
JSON to drift.

- One `timeseries` panel per trend metric (~22 panels): CPU utilization %, memory
  used %, disk / root FS used %, database size, DB connections, transaction rate,
  cache hit %, disk read/write IOPS, deadlocks, checkpoints (requested vs timed),
  WAL files pending archival, major page faults, swap-in, OOM kills, plus the
  optional PSI and EBS panels (see [What is and isn't
  present](#what-is-and-isnt-present)).
- Scoped to a `project` template variable over the **native**
  `supabase_project_ref` label:
  `label_values(node_load1, supabase_project_ref)`. So every panel filters to one
  project via `...{supabase_project_ref="$project"}`, and a multi-project scrape
  (one Prometheus, many targets) gets a per-project dropdown for free.
- Units mapped to Grafana field units (`%` -> `percent`, `bytes` -> `bytes`,
  else `short`), 30-day default time range, 5-minute auto-refresh.

Because it keys only on the label the endpoint emits, this dashboard renders
against **any** Prometheus scraping the endpoint - no relabelling, no custom
label scheme, no import-time datasource picking (the UID is pinned).

---

## The report route (`fetchTrends`)

Instead of (or in addition to) looking at Grafana, point the sbperf report at the
Prometheus and it renders the same panels inline in `report.html`:

```bash
bun run src/index.ts full --ref <ref> --prometheus http://localhost:9090
```

- `--prometheus` trends take precedence over the SQLite history store when both
  exist.
- Panels are scoped with the default matcher `supabase_project_ref="{ref}"`
  (`{ref}` is substituted per project). Override with `--prometheus-matcher
  '<label>="{ref}"'` if your scraper relabels series under a different
  project-identifying label.
- For a datasource fronted by **Grafana** (the datasource-proxy path
  `https://<grafana>/api/datasources/proxy/uid/<uid>`), add auth:
  - `--prometheus-token <bearer>` - a Grafana service-account token, or any
    auth'd Prometheus bearer (the documented path), **or**
  - `--prometheus-cookie '<session cookie>'` - the browser session cookie, for a
    Grafana behind an SSO proxy a token can't traverse. Token wins if both are
    set.
- Env equivalents: `SBPERF_PROMETHEUS_{URL,TOKEN,COOKIE,MATCHER}`.

### Auto-scoped query window

`fetchTrends` requests `--trend-days` (default 30). A brand-new scraper has only
a few minutes/hours of data, so a fixed 30-day step would smear a handful of
points across mostly-empty time (worst case: a single flat point).

To avoid that, it determines the **real earliest sample** with an instant
`min(min_over_time(timestamp(node_load1{...})[<days>d:<res>]))` probe and, when
the data span is well under the requested window, re-queries `[dataStart, now]`
so the step gives full resolution over the span that actually exists. A young
project (or a fresh scrape) is charted over its true age, not a mostly-empty 30
days. The store and a mature Prometheus (history already spread across the
window) are unaffected - their span fills the window, so no re-scope fires.

---

## What is and isn't present

The scraped families are a mix of **node_exporter** (host) and
**postgres_exporter** (DB) - about 300 metric families on a real project. A few
trend panels depend on collectors the Supabase endpoint does not expose, so they
render "No data" against a pure self-scrape:

- **PSI stall %** (`node_pressure_*`) - the pressure-stall collector is not
  enabled on the endpoint.
- **EBS IOPS / throughput balance %** (`aws_ec2_ebs*balance_percent_*`) - AWS
  CloudWatch metrics. Present only if your Prometheus **also** scrapes CloudWatch
  (a separate `cloudwatch_exporter` job); the metrics endpoint carries none.

The report labels which source fed the Resource snapshot and, when EBS is absent
from an infra source, says so - a missing panel is not a health signal.

---

## Multi-project scrapes

One Prometheus can scrape many projects: add a `static_configs` target per
project (each carries its own `supabase_project_ref` from the endpoint). Then:

- **Grafana**: the dashboard's `project` template variable becomes a dropdown of
  every scraped ref.
- **Report**: run per project with the ref-scoped matcher; the default
  `supabase_project_ref="{ref}"` isolates each one, so aggregates never blend
  projects together.

---

## Backfilling past history (retroactive)

Prometheus cannot scrape the past, but it can ingest backfilled TSDB blocks. If
you have been accumulating the SQLite store (`sbperf snapshot`), export it as
OpenMetrics and backfill it into the stack's data volume:

```bash
bun run src/index.ts export-prometheus /tmp/out --ref <ref>   # omit --ref for all
```

The command prints the exact `promtool tsdb create-blocks-from openmetrics`
invocation (`promtool` ships inside the `prom/prometheus` image - no host
install). Backfill into the `scraper-live` data volume, restart Prometheus, and
Grafana queries the full history retroactively. Verified end-to-end against
`prom/prometheus:v3.1.0`.

---

## Verifying the stack

```bash
REF=<ref>
PROM=http://localhost:9090
PROXY=http://localhost:3000/api/datasources/proxy/uid/prometheus   # Grafana proxy

# scrape target healthy?
curl -s "$PROM/api/v1/targets" | jq -r '.data.activeTargets[] | "\(.health) \(.lastError)"'

# how many families are being ingested? (expect ~300)
curl -s "$PROM/api/v1/label/__name__/values" | jq '.data | length'

# the project label resolves (drives the dashboard template var)?
curl -s -G "$PROXY/api/v1/label/supabase_project_ref/values" | jq -c '.data'

# a panel query returns data through Grafana?
curl -s -G "$PROXY/api/v1/query" \
  --data-urlencode "query=sum(pg_stat_database_num_backends{supabase_project_ref=\"$REF\"})" \
  | jq -r '.data.result[0].value[1]'

# the report route resolves the same series?
bun run src/index.ts full --ref "$REF" --prometheus "$PROM"
```

A freshly-started stack shows gauge panels immediately; rate-derived panels
(CPU %, IOPS, transaction rate) need several scrapes inside the `rate[5m]`
window before they populate - a few minutes.

---

## Teardown

```bash
cd scraper-live
docker compose down        # keep the TSDB + Grafana volumes
docker compose down -v     # also drop the volumes (discard accumulated history)
```
