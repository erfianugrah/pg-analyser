# Plan: slot-lag growth finding + disk-resize-aware capacity inference

Date: 2026-07-15
Motivation: third validation run (Fable) caught two trend-pipeline gaps -
replication-slot WAL retention climbing under threshold, and the "Disk stable"
positive narrating over a fresh 3x volume expansion. Both need a *growth /
step-change* signal, so both belong on the trend pipeline rather than a
single-scrape threshold.

## Architectural constraint (read first)

Trend series have TWO providers, and a feature that reasons over trends must
consider both:

1. **Store path** (`src/trends.ts` + `src/store.ts`): the PAT/`snapshot` path.
   `store.ts` denormalizes metric samples + a fixed `SCALAR_KEYS` set per
   snapshot; `trends.ts::computeTrends` turns accumulated snapshots into
   `TrendSeries[]`.
2. **Grafana path** (`src/prometheus.ts`): the no-PAT path. `buildPanels()` is a
   parallel list of `{title, unit, query}` PromQL panels. Fable's run used THIS
   (no metrics scrape in no-PAT mode).

Series titles are the join key between providers and `findings.ts`
(`pointsOf(title)` / `tpoints(title)`). A new series must use the SAME title in
both providers or findings only see it on one path.

Single-snapshot safety: every growth finding gates on
`trendstats.sufficient()` (>=12 points, >=3 days), so a 1-2 point store never
fires them - the exact false-positive guard we want. Fable's 19 Grafana points
clear it.

---

## Phase 0 - shared groundwork: two new trend series

### 0a. "Disk size (bytes)" series (mountpoint /data)

`fsUsedPctSeries` already reads `node_filesystem_size_bytes` but discards the
absolute size, keeping only the ratio. Resize detection + absolute projection
need the raw size.

- `src/trends.ts`: add `fsSizeSeries(snaps, "/data", "Disk size (bytes)")`
  (mirror `fsUsedPctSeries`, emit `sumOf(node_filesystem_size_bytes, {mountpoint})`
  per snapshot). `push()` it in `computeTrends` right after the two
  `fsUsedPctSeries` calls.
- `src/prometheus.ts`: add panel
  `{ title: "Disk size (bytes)", unit: "bytes",
     query: sum(sel("node_filesystem_size_bytes", 'mountpoint="/data"')) }`.
- TDD:
  - `test/trends.test.ts`: two snapshots with different
    `node_filesystem_size_bytes{mountpoint=/data}` -> a "Disk size (bytes)"
    series with the raw byte values (not a ratio).
  - assert it is omitted when the sample is absent.

### 0b. "Slot WAL retained (max, bytes)" scalar series

Slot retention is SQL point-in-time (`a.sql.replicationSlots`), not a metric.
Trend it via the store's scalar mechanism.

- `src/store.ts`: add to `SCALAR_KEYS`
  `{ key: "slot_wal_retained_max_bytes",
     pick: a => max(retained_wal_bytes) over ACTIVE slots, or null if none }`.
  (Aggregate, not per-slot: a single "is retention climbing" signal is enough
  and fits the flat `scalars: Record<string, number|null>` shape.)
- `src/trends.ts`: add to `SCALARS`
  `{ title: "Slot WAL retained (max, bytes)", unit: "bytes",
     key: "slot_wal_retained_max_bytes" }`.
- Grafana: postgres_exporter on the Supabase metrics endpoint does NOT reliably
  expose per-slot restart-LSN lag, so there is no `prometheus.ts` panel. Slot
  growth is therefore **store-path-first**; in no-PAT+Grafana it degrades to the
  existing point-in-time threshold findings. Document this in the finding's
  `whyItMatters` / a code comment - do NOT fake a panel.
- TDD:
  - `test/store.test.ts`: record a snapshot whose `replicationSlots` has an
    active slot with `retained_wal_bytes` set; `loadForTrends` returns the
    scalar. Inactive-only / empty -> scalar absent (null not stored).

---

## Phase 1 - slot-lag growth finding

Keep the two existing point-in-time findings unchanged
(`wal_retained_inactive_slot` HIGH, `wal_slot_lag` MED at `slotLagBytes` = 1 GiB).
ADD a growth finding for the "active, under 1 GiB, but climbing" case.

- `src/heuristics.ts`:
  - `THRESHOLDS.slotWalGrowthMinBytesPerDay` (e.g. 256 MiB/day) - floor so a
    trivially rising series does not fire.
  - `meta()` entry `wal_slot_growing` (whyItMatters: an active slot whose
    retention keeps rising means the consumer cannot keep up; retained WAL lives
    on the data volume and grows pg_wal unbounded - the exact question-1 risk.
    remediation: check the Realtime/consumer health; if it never catches up the
    slot must be dropped or the consumer scaled. howToVerify: retained WAL for
    the slot should plateau/fall after the write burst settles).
- `src/findings.ts` (trend section, near the EBS/PSI block):
  - `const slotPts = pointsOf("Slot WAL retained (max, bytes)");`
  - `if (sufficient(slotPts))` -> `trendStat`; when `direction === "rising"` AND
    `slopePerDay >= THRESHOLDS.slotWalGrowthMinBytesPerDay`, push a finding.
  - Severity: HIGH if it is ALSO an inactive slot (already HIGH via the other
    finding - so keep this MED to avoid double-high) or if projected to exceed a
    disk fraction soon; else MED.
  - Title: `Replication slot WAL retention climbing (~<X> MB/day, now <Y> MB)`.
    Use `s.slopePerDay` for the rate and `s.fittedLast` for "now".
  - Mutual-exclusion: suppress when `wal_slot_lag` (>1 GiB point-in-time) already
    fired for the same run - the absolute finding wins, same pattern as the
    advisor-vs-SQL dedup.
- TDD (`test/findings.test.ts`):
  - rising slot-WAL series (12+ pts, +300 MB/day) -> `wal_slot_growing` finding
    present, title carries MB/day + now.
  - flat-but-high series (stable at 800 MB) -> NO growth finding.
  - series already >1 GiB point-in-time -> only the existing `wal_slot_lag`, the
    growth finding suppressed.
  - <12 points -> nothing (sufficient() gate).

---

## Phase 2 - disk-resize-aware capacity inference

Three sub-problems, all rooted in "% used" being the wrong variable across a
volume resize (denominator changes).

### 2a. Resize detection helper

- `src/trendstats.ts` (or findings.ts helper): `detectResizes(sizePoints, minStepFrac)`
  returning the step-change points where `node_filesystem_size_bytes` jumps by
  >= `minStepFrac` (e.g. 0.2) between consecutive points. Return `{ at, fromBytes,
  toBytes }[]` (usually length 0 or 1).
- `THRESHOLDS.diskResizeStepFrac = 0.2`.
- Unit-test: a size series with a 50 GB -> 150 GB step -> one resize at the
  right index; a flat series -> none; gradual growth (autoscale small steps
  under the floor) -> none.

### 2b. Fix the false "Disk stable" positive

`derivePositives` currently trends "Disk used (%)" and claims stability. When a
resize is in the window the % series straddles a cliff and the projection is
meaningless.

- Reconstruct used-bytes per point: `used = sizeBytes(t) * usedPct(t)/100`, using
  the "Disk size (bytes)" (0a) and "Disk used (%)" series aligned by timestamp.
- If `detectResizes` finds a resize in the window, restrict the trend/projection
  to the POST-resize segment (points after the last resize). If that segment is
  too short for `sufficient()`, emit no fill-risk claim at all (neither the
  scary nor the false-calm one).
- Positive text: prefer absolute bytes -
  `Disk <U> GB used of <S> GB (<p>%), no fill risk over <d>d`.

### 2c. Resize-aware fill projection + expansion note (deriveFindings)

- Disk-fill capacity finding: project reconstructed used-bytes -> size-bytes on
  the post-resize segment (resize-aware `projectDaysTo` against the absolute
  cliff), and print absolute GB, not just %.
- New low/info finding when a resize occurred:
  `Disk auto-expanded <fromGb>->@<toGb> GB in the window (last <date>)` -
  contextualizes the % drop so it does not read as a rendering glitch or a leak.
  `meta("disk_expanded")` (info-ish; whyItMatters: provisioned disk is billed
  per GB - after cleanup/repack, right-size to ~1.2x DB size via a project
  upgrade; the road down is manual).
- `src/report/render.ts`: the Resource-snapshot disk line should show absolute
  provisioned GB alongside the %, and the disk over-provisioning finding already
  prints GB (reuse `bytesGb`).

### 2d. Provider coverage

`node_filesystem_size_bytes` IS in both the scrape and Grafana (0a adds the
panel), so disk-resize inference works on BOTH paths - unlike slot growth. Good:
Fable's no-PAT run would get it.

- TDD (`test/findings.test.ts`):
  - "Disk used (%)" series with a resize cliff + matching "Disk size (bytes)"
    step -> `Disk stable` positive is NOT emitted from the pre-resize slope;
    a `disk_expanded` finding IS emitted.
  - post-resize segment long enough + rising -> fill projection uses post-resize
    bytes (assert against the reconstructed-bytes math).
  - no resize, steady series -> unchanged behaviour (regression guard).

---

## Sequencing / commits

1. `feat(trends): add Disk size (bytes) + slot WAL retained series` (Phase 0,
   both providers, store + trends + prometheus tests).
2. `feat(findings): replication-slot WAL-growth finding` (Phase 1).
3. `feat(findings): disk-resize-aware fill projection + expansion note` (Phase 2).

Each commit ships with its tests green (typecheck + biome + bun test). No commit
depends on network; the Grafana panel additions are covered by prometheus.ts
panel-shape tests, not live queries.

## Risks / open decisions

- **Downsampling smears sharp steps.** `computeTrends` downsamples to ~300
  buckets; a resize step or a WAL spike could average across a bucket boundary.
  A 3x disk step and a multi-hundred-MB WAL climb are large enough to survive
  bucket-averaging, but detection should run on the series as findings receive
  it (already downsampled) and use fractional thresholds, not exact equality.
- **Slot growth is store-only.** Acceptable and documented; the point-in-time
  findings still cover no-PAT. If we later want it in Grafana, check whether the
  metrics endpoint exposes a slot-lag family and add a panel then.
- **Aggregate vs per-slot slot WAL.** Starting with max-over-active-slots. If a
  project has many slots with divergent behaviour, revisit with a per-slot key
  convention (`slot_wal_<name>`) - deferred until a real case needs it.
- **"used bytes" reconstruction** depends on both the size and % series existing
  and aligning by timestamp; when only one is present, fall back to the current
  %-only behaviour (no regression, just no absolute figures).
