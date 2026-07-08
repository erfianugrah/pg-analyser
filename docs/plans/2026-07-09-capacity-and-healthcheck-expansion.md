# Capacity + health-check expansion

Status: proposed
Date: 2026-07-09

Three workstreams that extend sbperf's diagnostic coverage, each grounded in a
verified capability gap between what sbperf collects today and what its data
sources (Management API + superuser SQL + metrics) can actually reach:

1. **Disk / EBS reclamation + over-provisioning** - quantify how much of a
   provisioned volume is live data vs reclaimable waste, and surface the
   grow-only autoscale policy that explains why an over-provisioned volume does
   not shrink on its own.
2. **Data integrity + deeper analysis** - add the `amcheck` corruption checks
   and data-checksum verification sbperf currently lacks, benchmarked against
   pgEdge `pg-healthcheck`'s coverage.
3. **GUC static-tuning + WAL + vacuum + index depth** - derive findings from
   configuration and catalog data sbperf already collects (or can reach with one
   column/query add), mapped against pgEdge's 180-check reference.

Everything below is verified against the LIVE Supabase OpenAPI spec
(`api.supabase.com/api/v1-json`), the sbperf source, a real no-PAT run, the
pgEdge v1.1.0 check reference
(`docs.pgedge.com/pg-healthcheck/v1-1-0/check_reference/`), and the PostgreSQL
`amcheck` docs. Citations inline.

Mode legend: **[both]** works in PAT and no-PAT (pure SQL / metrics);
**[PAT]** needs the Management API; **[super]** needs a superuser `--db-url`.

---

## Workstream 1 - Disk / EBS reclamation + over-provisioning

### Verified facts

- `GET /v1/projects/{ref}/config/disk/autoscale` EXISTS on the live spec and
  returns `DiskAutoscaleConfig { growth_percent, min_increment_gb, max_size_gb }`
  (all nullable ints, all required). `max_size_gb` description: *"Maximum limit
  the disk size will grow to in GB"* - i.e. autoscale is **grow-only**: a volume
  that autoscaled up never comes back down on its own, so reclaiming provisioned
  space always requires an explicit resize. sbperf does NOT pull this endpoint
  today.
- `GET /v1/projects/{ref}/config/disk` returns `DiskResponse` which includes an
  optional `last_modified_at` (when the volume was last resized). Our
  `DiskConfig` schema (`src/schemas.ts:37`) parses only `attributes` and drops
  it.
- Per-database disk fields (`disk_volume_size_gb`, `disk_type`,
  `disk_throughput_mbps`, `disk_last_modified_at`, `infra_compute_size`,
  `type: PRIMARY | READ_REPLICA`) live on `OrganizationProjectsResponse`
  (`GET /v1/organizations/{slug}/projects`), NOT the plain `GET /v1/projects`
  list sbperf's `--all` uses (`management.ts:67`, returns
  `V1ProjectWithDatabaseResponse` whose `database` object has only
  host/version/engine/channel). Read-replica disk attribution therefore requires
  the ORG endpoint, not the project list.
- Org entitlement `instances.disk_modifications` is exposed on
  `GET /v1/organizations/{slug}/entitlements` - whether the org is permitted to
  modify disk without a compute upgrade at all.
- sbperf already fetches `/v1/projects` (`m.projects()`) and `/v1/organizations`
  (`m.organizations()`); `Project.organization_id` + `Organization.slug` exist in
  schemas, so project->org->slug mapping is already possible - no new auth work
  to reach the org endpoints.
- Only capacity/disk finding today is `disk_full` (>80%, `findings.ts:444`).
  There is NO disk over-provisioning / downsize finding. The CPU analogue
  `cpu_oversized` (`findings.ts:856`, `heuristics.ts:109`) is the template.
- Supabase **Storage** buckets (`storage.objects`, `storageUsage`) are
  S3-backed, NOT on the PG EBS data volume - they must stay OUT of any disk
  footprint math or it overstates reclaimable space.

### Additions

**1.1 [PAT] Disk autoscale plane** - new `management.ts` method + `schemas.ts`
`DiskAutoscaleConfig`, register in `check-api-drift.ts` manifest, surface in the
report infra section. Report the policy verbatim and, when the current size is
well above `min_increment_gb`/logical footprint, note "autoscaling grows but
never shrinks - reclaiming this space needs a resize, not autoscale."

**1.2 [PAT] Capture `last_modified_at`** on `/config/disk` (schema add) ->
"volume last resized N days ago" in the infra table.

**1.3 [both] Disk over-provisioning / downsize finding** - the headline. Mirror
`cpu_oversized`. Contrast:
- provisioned `disk.sizeGb` **[PAT]** (or "Disk used (%)" trend in no-PAT)
- filesystem used `fs_used_bytes` **[PAT diskUtil]**
- logical `dbSizeBytes` **[both]**
- reclaimable = bloat + dead-tuple estimate + droppable unused indexes +
  retained WAL from inactive slots (all **[both]** except exact bloat **[super]**)
- **true minimum footprint = used - reclaimable**

Emit: *"Volume X GB, Y% used, ~Z GB reclaimable, true footprint ~W GB -
over-provisioned; downsize requires the volume-modify path (maintenance window)."*
This gives an operator the target size for any volume-resize decision before a
maintenance window is scheduled.

**1.4 [super] Reclaim-sum SQL** feeding 1.3:
- droppable unused indexes: aggregate `indexStats` where `scans=0`
  (`~N MB across M unused indexes`) - data already collected, just summed.
- `pg_wal` directory size via `pg_ls_waldir()` (WAL lives on the data volume;
  we only track retained-WAL-per-slot today).
- per-database sizes across the instance (`pg_database_size` over all DBs) - the
  volume holds every DB, not just the queried one.

**1.5 [PAT] Read-replica disk attribution in `--all`** - call
`/v1/organizations/{slug}/entitlements` + `/v1/organizations/{slug}/projects` so
the fleet index attributes TOTAL provisioned disk across primary + replicas and
shows whether `instances.disk_modifications` is available. Lower priority; only
matters for the org/fleet view.

---

## Workstream 2 - Data integrity + amcheck (pgEdge G07)

### Verified facts

- sbperf has NO data-integrity checks: no `amcheck`, `verify_heapam`,
  `bt_index_check`, checksum, or corruption logic anywhere (`rg` clean).
- sbperf already queries `pg_available_extensions` (`sql.ts:20`), so it can
  DETECT amcheck at runtime and gate exactly like `bloatExact`/`pgstattuple`
  (which run only when the extension is already installed + superuser SQL,
  `collect.ts:356`). sbperf never `CREATE`s an extension (a write) - same rule.
- PostgreSQL amcheck safety profile (PG docs, verified):
  - `bt_index_check(index, heapallindexed, checkunique)` - takes only
    AccessShareLock; raises an error on corruption. Light with `heapallindexed=false`.
  - `bt_index_parent_check` - takes ShareLock (BLOCKS writes). Do NOT use on live.
  - `verify_heapam(relation, ...)` - reads every heap page, returns one row per
    corruption. Expensive (whole-relation scan + I/O). MUST be opt-in.
- amcheck availability on Supabase specifically is not confirmed by docs; the
  runtime `pg_available_extensions` gate makes the feature degrade gracefully
  (safe() -> skip + collection note) if absent, so it is not dead-on-arrival.

### Additions

**2.1 [super, opt-in] amcheck integrity checks** - gated on (a) superuser SQL,
(b) amcheck present in `pg_available_extensions`, (c) an explicit `--amcheck`
flag (default OFF - never auto-run on a live prod DB). Behaviour:
- `bt_index_check(idx, heapallindexed => false)` across app-schema B-tree
  indexes -> `index_corruption` finding (CRITICAL) on any error. Light lock.
- `verify_heapam` only under `--amcheck=heap` (heavier), size-capped to the
  biggest N app tables, `check_toast => true`. -> `heap_corruption` finding.
- Never `bt_index_parent_check` (write-blocking).
Maps to pgEdge G07-004 / G07-008; closes sbperf's only complete gap versus that
tool's data-integrity group.

**2.2 [both] Data checksum failures** - `pg_stat_database.checksums_failures`
(and `checksums_last_failure`). Cheap, no extension, both modes. Nonzero =
CRITICAL. Also report `data_checksums` GUC (on/off). pgEdge G07-001/002.

**2.3 [super] TOAST orphans / oversized TOAST** - partially covered
(`toast_cache_cold`, `toast_bytes`); could add an oversized-value note. Low
priority.

---

## Workstream 3 - GUC tuning + WAL + vacuum + index depth

This is the "takes the analysis further" gap. sbperf collects the data (or a
close cousin) but derives no finding. Mapped against pgEdge's 15 groups; the
Supabase-applicable, high-signal subset:

### 3A - Static GUC-tuning findings (pgEdge G03/G04) [both]

sbperf captures only 11 GUCs via a fixed allowlist (`sql.ts:102`) and turns NONE
of them into findings (the only work_mem finding is runtime-spill-based). Expand
the allowlist and add deterministic findings:

- **work_mem x max_connections blast radius** (G03-004) - classic OOM risk;
  `work_mem * max_connections * avg_parallelism` vs available RAM. HIGH value.
- **maintenance_work_mem too low** (G03-005) - slows autovacuum + index builds.
- **effective_cache_size sanity** (G03-006) - should approximate RAM; a default
  low value mis-costs plans.
- **checkpoint_completion_target** (G03-007) + **requested-vs-timed checkpoint
  ratio** (G03-008) - we already trend "Requested/Timed checkpoints/s"; add the
  finding.
- **track_io_timing off** (G03-017) - if off, pg_stat_statements I/O timing is
  null (silently degrades our own IO analysis). Worth flagging.
- **default_statistics_target**, **effective_io_concurrency**, **wal_compression**
  (G03-009/011/014) - INFO-level advisories.
- **timeouts** (G04): `statement_timeout=0`, `lock_timeout=0`,
  `idle_in_transaction_session_timeout=0` - cheap findings straight from
  pgSettings (a real run showed `idle_in_transaction_session_timeout=0`).

Effort: mostly additive to `heuristics.ts` + `findings.ts` + widen the
`pgSettings` allowlist. No new collection plumbing.

### 3B - WAL generation + growth (pgEdge G14) [both/super]

- **pg_wal directory size** (`pg_ls_waldir()`, G14-001) - also feeds 1.4.
- **Top WAL-generating tables / statements** (G14-006) via
  `pg_stat_statements.wal_bytes` - we already collect pg_stat_statements but do
  NOT select `wal_bytes`. One column add -> a genuinely new capacity read
  (write-amplification attribution) that also feeds the disk-footprint math in W1.
- **WAL generation rate** from the store trend (G14-002/003) - we have LSN /
  Database-size trends; add a derived WAL-bytes/s rate.
- **wal_level=logical with no consumers** (G14-008) - Supabase runs
  `wal_level=logical`; an orphaned setting retains WAL. We see `wal_level` in
  `walArchiving`.

### 3C - Vacuum depth (pgEdge G05) [both]

- **Multixact wraparound** (G05-010) - separate 2B ceiling from txid; we have the
  txid check but NOT multixact. Real gap.
- **Tables never autovacuumed** (G05-009) + **last-autovacuum-age** (G05-004) -
  `pg_stat_user_tables.last_autovacuum IS NULL`. We have dead-tuple-overdue but
  not never-vacuumed.
- **autovacuum_vacuum_scale_factor advisory** (G05-006) - per-table storage-param
  awareness for large tables.

### 3D - Index depth (pgEdge G06) [both]

- **FK columns without a supporting index** (G06-008) - HIGH value; unindexed FKs
  cause slow cascade deletes + lock escalation. Not covered.
- **Index bloat** (G06-004) - we only do TABLE bloat; index bloat is distinct.
  Extend the pgstattuple path **[super]** or a btree-bloat estimate.
- **Invalid indexes** finding - we FILTER on `indisvalid` (`sql.ts:271`) but do
  not surface a finding when an index is invalid (failed CONCURRENTLY build).
  Cheap add.
- Low-cardinality / missing-PK (G06-005/006) - INFO, lower priority.

### 3E - Visibility map + cache (pgEdge G08/G13) [both] - lower priority

- All-visible page ratio + index-only-scan efficiency (`pg_visibility`, G08).
- bgwriter buffer eviction rate + `pg_stat_io` read latency (G03-002/003,
  G13-002/003) - needs `pg_stat_io` (PG16+) / `pg_stat_bgwriter`, neither queried
  today. Moderate value; the metrics corpus may already carry the exporter
  counters in a full PAT run (verify per-project).

### 3F - Security posture gaps (pgEdge G11) [both/super]

- **public schema CREATE privilege** (G11-003) - common Supabase footgun.
- Privileged non-superuser roles, stale login accounts (G11-004/007) - complement
  the existing GoTrue/network/SSL security plane.

---

## Explicitly OUT of scope for Supabase

~40% of pgEdge's checks target self-managed / clustered Postgres and do NOT apply
to Supabase's managed platform. Excluding deliberately:

- **G02 pgBackRest** (14) - Supabase backups are managed; no pgbackrest surface.
  (Our `backups` plane + `walArchiving` already cover "last backup age" +
  archiver health.)
- **G12 Spock cluster** (20) - pgEdge-specific multi-master.
- **G15 Replication health** (3) + standby-perspective G09 checks - single
  primary (revisit only for the read-replica case in 1.5).
- **G13 OS-host checks** - THP, CPU governor, huge pages, data-dir disk space,
  postmaster uptime - require running ON the host; Supabase gives no shell.
- **G01 TCP reachability / RTT** - sbperf is a report tool, not a liveness prober.
- **G10 deep pg_upgrade blockers** (15) - Supabase manages major upgrades; our
  `pg_update_available` + extension-outdated advisories suffice. Revisit only for
  self-hosted no-PAT use cases.

---

## Prioritization

**Tier A - do first (highest signal, mostly additive):**
1. W1: disk autoscale plane + over-provisioning/downsize finding (1.1-1.4) -
   quantifies provisioned-vs-reclaimable and the target resize size.
2. W2: amcheck integrity + checksum-failure findings (2.1, 2.2) - the only
   complete data-integrity gap; extension-gated + opt-in for safety.
3. W3A: static GUC-tuning findings + timeouts - config data already collected,
   no new plumbing.

**Tier B - high value, more plumbing:**
4. W3D: FK-without-index + invalid-index findings.
5. W3B: WAL generation (wal_bytes attribution + pg_wal size).
6. W3C: multixact wraparound + never-autovacuumed.

**Tier C - opportunistic:**
7. W1.5 read-replica disk attribution (org endpoints).
8. W3E/3F: visibility map, bgwriter/pg_stat_io, public-schema-CREATE, role audit.

## Conventions to honour

- Every new Management endpoint -> register in `scripts/check-api-drift.ts`.
- Every new SQL diagnostic -> port from `supabase/cli` inspect or `splinter.sql`
  where an upstream exists; register in `check:inspect` / `check:lints`; original
  checks only where upstream has a real gap AND the PG docs justify it.
- amcheck + index-bloat pgstattuple + pg_wal size are all **superuser-gated**
  (`runner.source === "superuser"`) and extension-gated; NEVER `CREATE EXTENSION`.
- `verify_heapam` is opt-in (`--amcheck`) and size-capped; never run whole-DB by
  default on a live project.
- New findings carry full `heuristics.ts` metadata (whatToDo / whyItMatters /
  howToVerify / remediation / docUrl) and, for advisor-overlapping ones, stay
  mutually exclusive with the splinter lint.
- App-schema scoping via `appRows`/`isAppSchema` for all per-object findings.
