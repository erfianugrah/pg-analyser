import { NON_APP_SCHEMAS_SQL } from "./appschema.ts";

/**
 * The perf diagnostic query set. Sourced from the Supabase Postgres
 * best-practices `monitor-` rules and the Supabase RLS performance guide.
 *
 * All read-only, run via the Management API read-only SQL runner (as
 * supabase_read_only_user). pg_stat_statements lives in the `extensions`
 * schema on Supabase.
 */

// Platform / Studio / introspection queries that swamp pg_stat_statements but
// are not the user's workload. Excluded from the outliers view (footnoted).
// Two layers: substring matches (catalog/introspection/dashboard reads) here,
// and a statement-type prefix filter (DDL / transaction-control / migrations)
// in NOT_APP_STATEMENT below - together they keep the outliers view to actual
// application SELECT/INSERT/UPDATE/DELETE workload.
const PLATFORM_NOISE = [
  "%pg_timezone_names%",
  "%pg_available_extensions%",
  "%pgbouncer%",
  "%pg_backup_%",
  "%pg_stat_statements%",
  "%information_schema%",
  "%pg_class%",
  "%pg_namespace%",
  "%pg_attribute%",
  "%pg_proc%",
  "%pg_catalog%",
  "%pg_get_%",
  // Migrations (Supabase's own tracking schema + generic migration tables).
  "%supabase_migrations%",
  "%schema_migrations%",
  // Dashboard / Studio / ORM introspection reads of the system catalogs.
  "%pg_stat_%",
  "%pg_roles%",
  "%pg_database%",
  "%pg_settings%",
  "%pg_indexes%",
  "%pg_tables%",
  "%pg_type%",
  "%pg_index%",
  "%pg_constraint%",
  "%pg_description%",
  "%pg_depend%",
  "%pg_enum%",
  "%current_setting%",
  "%set_config%",
  // Supabase-internal service schemas (not the user's app tables).
  "%realtime.%",
  "%_realtime.%",
  "%graphql.%",
  "%pgrst%",
  // Realtime's own publication poll (pg_publication_tables / pg_publication) -
  // a platform service query, not app workload; without this it can slip into
  // the outliers / latency-variance views once Realtime is enabled.
  "%pg_publication%",
  // Replication-slot management (create/drop logical slot) - platform / Realtime
  // plumbing, not app workload; keeps the slot-ensure call out of the outliers.
  "%replication_slot%",
]
  .map((p) => `'${p}'`)
  .join(",");

// Statement types that are not ongoing application workload: transaction
// control, DDL, migrations, session/admin commands. A POSIX regex anchored at
// the statement start, so it matches the verb without false-flagging a table
// whose name merely contains one of these words. Kept as a single string so it
// reads as one exclusion; the words appear only inside this quoted literal, not
// as operations (the read-only-query test strips literals before scanning).
const NOT_APP_STATEMENT =
  "^\\s*(begin|commit|rollback|savepoint|release|set|show|reset|discard|" +
  "create|alter|drop|comment|grant|revoke|truncate|vacuum|analyze|reindex|" +
  "cluster|copy|explain|deallocate|listen|notify|prepare|checkpoint|lock)\\M";

export const QUERIES = {
  dbSize: /* sql */ `
    select
      pg_size_pretty(pg_database_size(current_database())) as db_size,
      pg_database_size(current_database()) as db_size_bytes`,

  // Table + index cache-hit ratio. Only meaningful relative to how long stats
  // have accumulated (see statsResetAge) - a fresh reset shows a misleading 100%.
  cacheHit: /* sql */ `
    select
      round(sum(heap_blks_hit) * 100.0
        / nullif(sum(heap_blks_hit + heap_blks_read), 0), 2) as cache_hit_pct,
      -- total heap blocks touched since stats reset. The cache-hit RATIO is
      -- meaningless on a tiny/idle DB (cold-start reads dominate), so findings
      -- gate on this volume before flagging a low ratio.
      sum(heap_blks_hit + heap_blks_read) as heap_blks_accessed,
      (select round(sum(idx_blks_hit) * 100.0
        / nullif(sum(idx_blks_hit + idx_blks_read), 0), 2)
       from pg_statio_user_indexes) as index_hit_pct
    from pg_statio_user_tables`,

  // How long pg_stat_statements has been accumulating. Cache-hit % and the
  // outliers/calls views are only interpretable against this window.
  statsResetAge: /* sql */ `
    select (now() - stats_reset)::text as stats_age, dealloc
    from extensions.pg_stat_statements_info`,

  // How long the PER-TABLE / per-index counters (pg_stat_database) have been
  // accumulating. This is a DIFFERENT reset from pg_stat_statements_info above:
  // unused-index, dead-tuple, and cache-hit signals are all relative to THIS
  // window, so a recent reset makes them low-confidence.
  tableStatsResetAge: /* sql */ `
    select (now() - stats_reset)::text as stats_age
    from pg_stat_database
    where datname = current_database()`,

  // Perf-relevant server settings - the API config endpoint returns {} on many
  // projects, so read them from pg_settings directly.
  pgSettings: /* sql */ `
    select name, setting, unit
    from pg_settings
    where name in (
      'max_connections', 'shared_buffers', 'effective_cache_size', 'work_mem',
      'maintenance_work_mem', 'statement_timeout', 'lock_timeout',
      'idle_in_transaction_session_timeout', 'random_page_cost',
      'max_parallel_workers', 'max_parallel_workers_per_gather', 'server_version',
      -- tuning-finding inputs (see findings.ts config section): checkpoint
      -- pacing, planner stats depth, I/O timing capture, prefetch concurrency,
      -- WAL compression, and whether page checksums are on.
      'checkpoint_completion_target', 'default_statistics_target',
      'track_io_timing', 'effective_io_concurrency', 'wal_compression',
      'data_checksums'
    )
    order by name`,

  // Page-checksum failure counters (pg_stat_database, cluster-wide row). A
  // NON-ZERO checksums_failures is on-disk corruption caught by the checksum
  // layer - a CRITICAL, actionable integrity signal available in BOTH modes
  // with no extension. checksums_last_failure dates the most recent hit.
  // Columns exist from PG12+; datname IS NULL is the shared/cluster aggregate.
  checksumFailures: /* sql */ `
    select
      coalesce(sum(checksum_failures), 0) as checksum_failures,
      max(checksum_last_failure)::text as checksum_last_failure
    from pg_stat_database`,

  // pg_wal directory size (superuser). WAL lives on the data volume, so a large
  // pg_wal is provisioned disk NOT reflected in pg_database_size - it feeds the
  // disk over-provisioning / true-footprint math. pg_ls_waldir() needs a
  // superuser or a role granted pg_monitor; safe() degrades to [] otherwise.
  walDirSize: /* sql */ `
    select
      sum(size)::bigint as wal_bytes,
      pg_size_pretty(sum(size)) as wal_size,
      count(*) as wal_segments
    from pg_ls_waldir()`,

  // amcheck targets: valid app-schema B-tree indexes, biggest first (capped).
  // collect.ts calls bt_index_check(oid, false) per row - a thrown error is a
  // corruption hit. Superuser + amcheck-installed + opt-in only (see collect).
  btreeIndexTargets: /* sql */ `
    select
      i.indexrelid::text as oid,
      n.nspname || '.' || c.relname as index
    from pg_index i
    join pg_class c on c.oid = i.indexrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_am am on am.oid = c.relam
    where i.indisvalid and am.amname = 'btree'
      and n.nspname not in (${NON_APP_SCHEMAS_SQL})
    order by pg_relation_size(i.indexrelid) desc
    limit 100`,

  // amcheck heap verification (verify_heapam) over the biggest N app tables.
  // Row-returning (one row per corruption), so it runs as a normal query -
  // unlike bt_index_check which raises. HEAVY (reads every page of each target
  // table); gated to opt-in --amcheck=heap + superuser + amcheck installed.
  amcheckHeap: /* sql */ `
    with targets as (
      select c.oid, n.nspname || '.' || c.relname as "table"
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'm')
        and n.nspname not in (${NON_APP_SCHEMAS_SQL})
      order by pg_total_relation_size(c.oid) desc
      limit 5
    )
    select t."table", v.blkno, v.offnum, v.attnum, v.msg as message
    from targets t
    cross join lateral verify_heapam(t.oid, on_error_stop => false, check_toast => true) v`,

  // App workload only - platform/introspection noise filtered out. queryid is
  // pg_stat_statements' stable per-normalized-query identity (survives literal
  // changes; resets on pg_stat_statements_reset()) - it keys `sbperf diff`'s
  // query-level regression detection, so the same statement is matched across
  // snapshots even when its truncated text collides with another's.
  topStatements: /* sql */ `
    select
      queryid::text as queryid,
      round(total_exec_time::numeric, 1) as total_ms,
      calls,
      round(mean_exec_time::numeric, 2) as mean_ms,
      round((100 * total_exec_time / nullif(sum(total_exec_time) over (), 0))::numeric, 1) as pct,
      left(regexp_replace(query, '\\s+', ' ', 'g'), 160) as query
    from extensions.pg_stat_statements
    where query not ilike all (array[${PLATFORM_NOISE}])
      and query !~* '${NOT_APP_STATEMENT}'
    order by total_exec_time desc
    limit 20`,

  // Same workload, ranked by call count - surfaces chatty N+1 / hot-path
  // statements that are individually cheap but dominate round-trips.
  topByCalls: /* sql */ `
    select
      queryid::text as queryid,
      calls,
      round(total_exec_time::numeric, 1) as total_ms,
      round(mean_exec_time::numeric, 2) as mean_ms,
      round((100 * calls / nullif(sum(calls) over (), 0))::numeric, 1) as pct_calls,
      left(regexp_replace(query, '\\s+', ' ', 'g'), 160) as query
    from extensions.pg_stat_statements
    where query not ilike all (array[${PLATFORM_NOISE}])
      and query !~* '${NOT_APP_STATEMENT}'
    order by calls desc
    limit 20`,

  // Per-query I/O + latency-stability depth from pg_stat_statements - the signal
  // top-by-time/calls misses: work_mem SPILL (temp_blks_written), disk-heavy
  // reads (shared_blks miss %), and latency INSTABILITY (stddev/mean = coeff of
  // variation). Ranks by the worst axis so one query can surface for any of them;
  // findings read the per-row values. calls>=20 keeps one-off maintenance out.
  queryIoStats: /* sql */ `
    select
      queryid::text as queryid,
      calls,
      round(mean_exec_time::numeric, 2) as mean_ms,
      round(stddev_exec_time::numeric, 2) as stddev_ms,
      round((stddev_exec_time / nullif(mean_exec_time, 0))::numeric, 2) as cv,
      temp_blks_written,
      pg_size_pretty(temp_blks_written * 8192::bigint) as temp_written,
      shared_blks_read,
      round((shared_blks_read * 100.0
        / nullif(shared_blks_hit + shared_blks_read, 0))::numeric, 1) as miss_pct,
      left(regexp_replace(query, '\\s+', ' ', 'g'), 160) as query
    from extensions.pg_stat_statements
    where query not ilike all (array[${PLATFORM_NOISE}])
      and query !~* '${NOT_APP_STATEMENT}'
      and calls >= 20
    order by temp_blks_written desc, shared_blks_read desc, stddev_exec_time desc
    limit 20`,

  biggestTables: /* sql */ `
    select
      s.schemaname as schema,
      s.schemaname || '.' || s.relname as table,
      pg_size_pretty(pg_total_relation_size(s.relid)) as total_size,
      pg_size_pretty(pg_indexes_size(s.relid)) as index_size,
      pg_total_relation_size(s.relid) as total_bytes,
      pg_indexes_size(s.relid) as index_bytes,
      -- TOAST relation (out-of-line storage for oversized values) isolated, so a
      -- table dominated by large blobs / JSON / vectors is visible as such
      -- rather than hidden in the total. Includes the TOAST index.
      case when c.reltoastrelid <> 0 then pg_total_relation_size(c.reltoastrelid) else 0 end as toast_bytes,
      -- pretty size only when the TOAST relation actually holds data. Postgres
      -- always creates a TOAST relation for a TOAST-able column, so an empty one
      -- is ~1-2 pages (<= 16KB); showing "8192 bytes" on every table is noise.
      case when c.reltoastrelid <> 0 and pg_total_relation_size(c.reltoastrelid) > 16384
        then pg_size_pretty(pg_total_relation_size(c.reltoastrelid)) end as toast_size,
      s.n_live_tup as live_rows
    from pg_stat_user_tables s
    join pg_class c on c.oid = s.relid
    order by pg_total_relation_size(s.relid) desc
    limit 20`,

  // All indexes ranked by size, with scan counts and an unused flag. A large,
  // rarely-scanned index is as interesting as a never-scanned one - so this
  // supersedes a bare unused-only list. unused excludes PK/unique constraints.
  indexStats: /* sql */ `
    select
      n.nspname as schema,
      n.nspname || '.' || c.relname as index,
      tn.nspname || '.' || tc.relname as table,
      pg_size_pretty(pg_relation_size(i.indexrelid)) as index_size,
      pg_relation_size(i.indexrelid) as index_bytes,
      ui.idx_scan as scans,
      case when ui.idx_scan = 0
        and i.indexrelid not in (select conindid from pg_constraint where contype in ('p', 'u'))
        then true else false end as unused
    from pg_stat_user_indexes ui
    join pg_index i on ui.indexrelid = i.indexrelid
    join pg_class c on ui.indexrelid = c.oid
    join pg_namespace n on c.relnamespace = n.oid
    join pg_class tc on tc.oid = i.indrelid
    join pg_namespace tn on tn.oid = tc.relnamespace
    -- Exclude Postgres-internal + Supabase-managed schemas (single source of
    -- truth: NON_APP_SCHEMAS in appschema.ts, drift-synced to splinter.sql) so
    -- managed indexes never crowd the user's own out of the row cap.
    where n.nspname not in (${NON_APP_SCHEMAS_SQL})
    order by pg_relation_size(i.indexrelid) desc
    limit 100`,

  // Duplicate indexes: two or more indexes with an identical definition on the
  // same table (normalized by stripping the index name from indexdef). Each
  // copy is maintained on every write for zero read benefit. Derived from the
  // Supabase splinter `duplicate_index` lint - runs over the read-only endpoint
  // so it fires even when the hosted advisor 400s and there is no --db-url.
  duplicateIndexes: /* sql */ `
    select
      n.nspname as schema,
      n.nspname || '.' || c.relname as table,
      array_to_string(array_agg(pi.indexname order by pi.indexname), ', ') as indexes,
      count(*) as copies
    from pg_indexes pi
    join pg_namespace n on n.nspname = pi.schemaname
    join pg_class c on pi.tablename = c.relname and n.oid = c.relnamespace
    where n.nspname not in (${NON_APP_SCHEMAS_SQL})
      and c.relkind in ('r', 'm')
    group by n.nspname, c.relname, replace(pi.indexdef, pi.indexname, '')
    having count(*) > 1
    order by 1, 2
    limit 30`,

  // RLS policy columns without a covering index. An RLS policy filters every row
  // by the columns in its USING/WITH CHECK expression; if such a column is not
  // the leading column of some index, each policy check does a seq scan.
  // Supabase's official 100K-row test: 171ms -> <0.1ms once the policy column is
  // indexed. Referenced columns are matched by word-boundary against the table's
  // real attributes (so auth.uid()/functions don't false-match); indexed = the
  // column leads at least one valid index.
  rlsUnindexed: /* sql */ `
    with pol as (
      select
        c.oid as table_oid,
        n.nspname as schema,
        c.relname as tbl,
        coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
          coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') as expr
      from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname not in ('pg_catalog', 'information_schema')
    ),
    refs as (
      select distinct pol.schema, pol.table_oid, pol.tbl, a.attname as col
      from pol
      join pg_attribute a
        on a.attrelid = pol.table_oid and a.attnum > 0 and not a.attisdropped
      where pol.expr ~ ('\\y' || a.attname || '\\y')
    ),
    indexed as (
      select distinct i.indrelid as table_oid,
        (select attname from pg_attribute
         where attrelid = i.indrelid and attnum = i.indkey[0]) as col
      from pg_index i
      where i.indisvalid and i.indkey[0] <> 0
    )
    select
      refs.schema as schema,
      refs.schema || '.' || refs.tbl as table,
      refs.col as column
    from refs
    left join indexed ix on ix.table_oid = refs.table_oid and ix.col = refs.col
    where ix.col is null
    order by 1, 2, 3
    limit 50`,

  seqScanHeavy: /* sql */ `
    select
      schemaname as schema,
      schemaname || '.' || relname as table,
      seq_scan,
      coalesce(idx_scan, 0) as idx_scan,
      n_live_tup as live_rows,
      case when seq_scan > 0
        then round((seq_scan::numeric / nullif(seq_scan + coalesce(idx_scan, 0), 0)) * 100, 1)
        else 0 end as seq_scan_pct
    from pg_stat_user_tables
    where seq_scan > coalesce(idx_scan, 0)
      and n_live_tup > 1000
      -- app-object scope (see indexStats); managed tables aren't user-actionable
      and schemaname not in (${NON_APP_SCHEMAS_SQL})
    order by seq_scan desc
    limit 20`,

  // Estimated table bloat (wasted bytes) via the classic pg_stats-based
  // estimation. Rough (statistics-driven) but the standard first-pass signal
  // for reclaimable space. Adapted from the Supabase CLI's bloat inspect query.
  bloat: /* sql */ `
    with constants as (select current_setting('block_size')::numeric as bs, 23 as hdr, 4 as ma),
    bloat_info as (
      select ma, bs, schemaname, tablename,
        (datawidth + (hdr + ma - (case when hdr % ma = 0 then ma else hdr % ma end)))::numeric as datahdr,
        (maxfracsum * (nullhdr + ma - (case when nullhdr % ma = 0 then ma else nullhdr % ma end))) as nullhdr2
      from (
        select schemaname, tablename, hdr, ma, bs,
          sum((1 - null_frac) * avg_width) as datawidth,
          max(null_frac) as maxfracsum,
          hdr + (select 1 + count(*) / 8 from pg_stats s2
                 where null_frac <> 0 and s2.schemaname = s.schemaname and s2.tablename = s.tablename) as nullhdr
        from pg_stats s, constants
        where schemaname not in ('pg_catalog', 'information_schema')
        group by 1, 2, 3, 4, 5
      ) as foo
    ),
    table_bloat as (
      select schemaname, tablename, cc.relpages, bs,
        ceil((cc.reltuples * ((datahdr + ma - (case when datahdr % ma = 0 then ma else datahdr % ma end)) + nullhdr2 + 4)) / (bs - 20::float)) as otta
      from bloat_info
      join pg_class cc on cc.relname = bloat_info.tablename
      join pg_namespace nn on cc.relnamespace = nn.oid and nn.nspname = bloat_info.schemaname
    )
    select
      schemaname || '.' || tablename as name,
      round(case when otta = 0 then 0.0 else relpages / otta::numeric end, 1) as bloat_x,
      pg_size_pretty(case when relpages < otta then 0 else (bs * (relpages - otta)::bigint)::bigint end) as waste,
      (case when relpages < otta then 0 else (bs * (relpages - otta)::bigint)::bigint end) as waste_bytes
    from table_bloat
    where relpages > otta
      -- Ignore tiny tables: the pg_stats estimator divides by an estimated
      -- optimal page count, so on a small table a rounding artifact reads as a
      -- huge bloat_x (e.g. 500x on a 300KB table) - pure noise, and there is
      -- nothing worth reclaiming anyway. 10MB floor kills the false positives.
      and relpages * bs >= 10 * 1024 * 1024
    order by waste_bytes desc
    limit 20`,

  // EXACT reclaimable space via pgstattuple_approx - run ONLY when the
  // pgstattuple extension is already installed and we have superuser SQL (see
  // collect.ts; the read-only user can't exec it, and sbperf never CREATEs an
  // extension - that would be a write). This replaces the noisy pg_stats
  // ESTIMATE with measured dead-tuple + free-space bytes on the biggest heap
  // tables. `_approx` uses the visibility map to skip all-visible pages, so it
  // is cheap on a well-vacuumed table; the top-N-then-scan shape (limit BEFORE
  // the lateral) ensures pgstattuple runs on just those N tables, not all.
  bloatExact: /* sql */ `
    with big as (
      select c.oid, n.nspname, c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'r'
        and n.nspname not in ('pg_catalog', 'information_schema')
        and pg_relation_size(c.oid) >= 100 * 1024 * 1024
      order by pg_relation_size(c.oid) desc
      limit 5
    )
    select
      nspname || '.' || relname as name,
      s.table_len as total_bytes,
      round(s.dead_tuple_percent::numeric, 1) as dead_pct,
      s.dead_tuple_len as dead_bytes,
      round(s.approx_free_percent::numeric, 1) as free_pct,
      s.approx_free_space as free_bytes,
      (s.dead_tuple_len + s.approx_free_space)::bigint as reclaimable_bytes,
      pg_size_pretty((s.dead_tuple_len + s.approx_free_space)::bigint) as reclaimable
    from big, lateral pgstattuple_approx(big.oid) s
    order by reclaimable_bytes desc`,

  // Read-heavy vs write-heavy profile per table (blocks read vs write tuples).
  // Informs index/partitioning strategy. Adapted from the CLI's traffic-profile
  // (itself from Crunchy Data's read-vs-write analysis).
  trafficProfile: /* sql */ `
    with tl as (
      select s.schemaname, s.relname,
        si.heap_blks_read + si.idx_blks_read as blocks_read,
        s.n_tup_ins + s.n_tup_upd + s.n_tup_del as write_tuples,
        c.relpages * (s.n_tup_ins + s.n_tup_upd + s.n_tup_del)
          / (case when c.reltuples = 0 then 1 else c.reltuples end) as blocks_write
      from pg_stat_user_tables s
      join pg_statio_user_tables si on s.relid = si.relid
      join pg_class c on c.oid = s.relid
      where (s.n_tup_ins + s.n_tup_upd + s.n_tup_del) > 0
        and (si.heap_blks_read + si.idx_blks_read) > 0
    )
    select
      schemaname || '.' || relname as table,
      blocks_read,
      write_tuples,
      round(blocks_write::numeric) as blocks_write,
      case when blocks_write * 5 > blocks_read
        then (case when blocks_read = 0 then 'write-only'
          else round(blocks_write::numeric / nullif(blocks_read, 0)::numeric, 1)::text || ':1 write-heavy' end)
      when blocks_read > blocks_write * 5
        then (case when blocks_write = 0 then 'read-only'
          else '1:' || round(blocks_read::numeric / nullif(blocks_write::numeric, 0), 1)::text || ' read-heavy' end)
      else '1:1 balanced' end as profile
    from tl
    order by (blocks_read + blocks_write) desc
    limit 20`,

  // Per-table I/O attribution from pg_statio_user_tables: heap / index / TOAST
  // blocks read-from-disk vs served-from-cache, with computed cache-hit ratios.
  // sbperf-ORIGINAL (no upstream inspect equivalent) - the layer the global
  // cache-hit ratio lacks: WHICH relation is disk-bound, and specifically
  // whether the cost is de-toasting an out-of-line column that can't stay
  // cached (low toast_hit_pct + high toast_blks_read - the classic large-
  // blob / large-vector IO trap). Ratios are NULL when that tier had no access
  // (0/0 is "not exercised", not "0% cached"). App-scoped + ordered by total
  // disk reads so the IO-bound tables surface first. Counters are cumulative
  // since the last stats reset (findings gate on statsResetAge, like cache-hit).
  tableIoStats: /* sql */ `
    select
      schemaname as schema,
      schemaname || '.' || relname as table,
      heap_blks_read,
      heap_blks_hit,
      idx_blks_read,
      idx_blks_hit,
      coalesce(toast_blks_read, 0) as toast_blks_read,
      coalesce(toast_blks_hit, 0) as toast_blks_hit,
      case when heap_blks_read + heap_blks_hit > 0
        then round(100.0 * heap_blks_hit / (heap_blks_read + heap_blks_hit), 1)
        end as heap_hit_pct,
      case when coalesce(idx_blks_read, 0) + coalesce(idx_blks_hit, 0) > 0
        then round(100.0 * idx_blks_hit / (idx_blks_read + idx_blks_hit), 1)
        end as idx_hit_pct,
      case when coalesce(toast_blks_read, 0) + coalesce(toast_blks_hit, 0) > 0
        then round(100.0 * toast_blks_hit / (toast_blks_read + toast_blks_hit), 1)
        end as toast_hit_pct
    from pg_statio_user_tables
    where schemaname not in (${NON_APP_SCHEMAS_SQL})
      and (heap_blks_read + heap_blks_hit
           + coalesce(idx_blks_read, 0) + coalesce(idx_blks_hit, 0)
           + coalesce(toast_blks_read, 0) + coalesce(toast_blks_hit, 0)) > 0
    order by (heap_blks_read + coalesce(idx_blks_read, 0)
              + coalesce(toast_blks_read, 0)) desc
    limit 20`,

  // Autovacuum-behind, threshold-aware. Rather than a fixed dead-tuple cutoff,
  // compute each table's actual autovacuum trigger (per-table reloptions, else
  // the cluster default) and flag tables whose dead tuples already exceed it
  // (`overdue` = autovacuum is due but hasn't caught up). Adapted from the
  // Supabase CLI's vacuum-stats inspect query.
  deadTuples: /* sql */ `
    with opts as (
      select c.oid, c.relname, n.nspname,
        array_to_string(c.reloptions, '') as relopts,
        c.reltuples, s.n_live_tup, s.n_dead_tup, s.last_autovacuum
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_stat_user_tables s on s.relid = c.oid
      where n.nspname not in ('pg_catalog', 'information_schema')
    ), settings as (
      select nspname, relname, reltuples, n_live_tup, n_dead_tup, last_autovacuum,
        case when relopts like '%autovacuum_vacuum_threshold%'
          then substring(relopts, '.*autovacuum_vacuum_threshold=([0-9.]+).*')::int
          else current_setting('autovacuum_vacuum_threshold')::int end as av_t,
        case when relopts like '%autovacuum_vacuum_scale_factor%'
          then substring(relopts, '.*autovacuum_vacuum_scale_factor=([0-9.]+).*')::real
          else current_setting('autovacuum_vacuum_scale_factor')::real end as av_s
      from opts
    )
    select
      nspname as schema,
      nspname || '.' || relname as table,
      n_live_tup as live_rows,
      n_dead_tup as dead_rows,
      round(av_t + av_s * reltuples) as autovacuum_at,
      case when (av_t + av_s * reltuples) < n_dead_tup then 'yes' else 'no' end as overdue,
      to_char(last_autovacuum, 'YYYY-MM-DD HH24:MI') as last_autovacuum
    from settings
    where n_dead_tup > 0
    order by (case when (av_t + av_s * reltuples) < n_dead_tup then 0 else 1 end), n_dead_tup desc
    limit 20`,

  // Per-role connection usage vs each role's limit (rolconnlimit, else the
  // cluster max). Surfaces a single role exhausting its own connection budget.
  roleStats: /* sql */ `
    select
      rolname as role,
      (select count(*) from pg_stat_activity a where a.usename = r.rolname) as connections,
      case when rolconnlimit = -1
        then current_setting('max_connections')::int
        else rolconnlimit end as conn_limit
    from pg_roles r
    where rolcanlogin
    order by connections desc
    limit 20`,

  // RLS policies re-evaluating auth.* per row (should be wrapped: (select auth.uid())).
  // Supabase benchmarks: 94-99% latency improvement when wrapped.
  // Raw policy expressions; the unwrapped-auth classification is done in JS
  // (see rls.ts / collect.ts) so it is unit-tested and case-correct. Capturing
  // qual/with_check/roles also lets the report emit exact ALTER POLICY fixes.
  rlsPolicies: /* sql */ `
    select
      schemaname || '.' || tablename as table,
      policyname,
      cmd,
      array_to_string(roles, ',') as roles,
      qual,
      with_check
    from pg_policies
    where schemaname not in ('pg_catalog', 'information_schema')
    order by 1, 2`,

  storageUsage: /* sql */ `
    select
      bucket_id,
      count(*) as objects,
      pg_size_pretty(coalesce(sum((metadata->>'size')::bigint), 0)) as size
    from storage.objects
    group by bucket_id
    order by coalesce(sum((metadata->>'size')::bigint), 0) desc`,

  // Auth footprint from the auth schema (GoTrue's tables). PAT mode gets auth
  // POLICY from /config/auth; this gives auth ADOPTION - readable via SQL in
  // both modes, so no-PAT gets an auth picture too. Counts only, no PII. Errors
  // harmlessly to [] on a non-Supabase Postgres (no auth schema).
  authAudit: /* sql */ `
    select
      count(*) as total_users,
      count(*) filter (where confirmed_at is not null) as confirmed_users,
      count(*) filter (where last_sign_in_at > now() - interval '30 days') as active_30d
    from auth.users`,

  // MFA enrolment is a SEPARATE query on purpose: auth.mfa_factors is created by
  // a GoTrue migration and can be absent (verified against the supabase/postgres
  // image, which ships auth.users but not mfa_factors). Postgres resolves every
  // referenced relation at parse time - even inside a CASE guarded by
  // to_regclass - so folding it into authAudit would let one missing table nuke
  // the whole auth summary. Split -> a missing mfa_factors only loses this count.
  authMfa: /* sql */ `
    select count(distinct user_id) as mfa_users
    from auth.mfa_factors
    where status = 'verified'`,

  // Scheduled-job (pg_cron) health - the ETL/automation plane. cron.job is the
  // schedule; cron.job_run_details is the run log. Surfaces jobs whose recent
  // runs FAILED (a real automation outage the pg_cron nudge can't see). Guarded
  // by the cron schema existing (safe() -> [] when pg_cron isn't installed).
  cronJobs: /* sql */ `
    select
      j.jobname,
      j.schedule,
      j.active,
      count(r.*) filter (where r.status = 'failed') as failed_runs,
      count(r.*) as runs_7d,
      max(r.end_time)::text as last_run,
      -- Run duration (7d): a job whose runtime approaches/exceeds its own
      -- schedule cadence overlaps itself - invisible to failed_runs.
      round(avg(extract(epoch from (r.end_time - r.start_time)))
        filter (where r.end_time is not null))::int as avg_duration_s,
      round(max(extract(epoch from (r.end_time - r.start_time)))
        filter (where r.end_time is not null))::int as max_duration_s
    from cron.job j
    left join cron.job_run_details r
      on r.jobid = j.jobid and r.start_time > now() - interval '7 days'
    group by j.jobid, j.jobname, j.schedule, j.active
    order by failed_runs desc, j.jobname`,

  // Storage bucket inventory. The Supabase Storage API reads this same table;
  // over a superuser --db-url it is the no-PAT source for the bucket list that
  // PAT mode gets from /storage/buckets. Errors harmlessly (safe() -> []) on a
  // non-Supabase Postgres with no storage schema.
  bucketList: /* sql */ `
    select id, name, public
    from storage.buckets
    order by name`,

  // Transaction-ID wraparound headroom. age(relfrozenxid) climbing toward 2.1B
  // means autovacuum is falling behind on freezing; at the ceiling the DB force-
  // stops writes. Scoped to non-system schemas (user-actionable); pct is against
  // a 2B practical ceiling (autovacuum_freeze_max_age escalates well before).
  txidWraparound: /* sql */ `
    select
      n.nspname as schema,
      n.nspname || '.' || c.relname as table,
      age(c.relfrozenxid) as xid_age,
      round(100 * age(c.relfrozenxid)::numeric / 2000000000, 1) as pct_wraparound
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'm')
      and n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
      and age(c.relfrozenxid) > 0
    order by age(c.relfrozenxid) desc
    limit 20`,

  // Sequence exhaustion: sequences approaching their max value. int4/serial
  // sequences cap at 2^31-1 (~2.1B) - a live risk class on high-insert tables
  // (bulk imports, hot append). A bigint/bigserial sequence caps at ~9.2e18 so
  // its pct is ~0 and it never surfaces here. Scoped to app schemas. Companion
  // to the txid/multixact wraparound checks (the other 'a counter hits a
  // ceiling' failure class). pg_sequences is PG10+, readable without superuser.
  sequenceExhaustion: /* sql */ `
    select
      schemaname as schema,
      schemaname || '.' || sequencename as sequence,
      last_value,
      max_value,
      round((last_value::numeric / nullif(max_value, 0)) * 100, 1) as pct_used
    from pg_sequences
    where last_value is not null
      and max_value > 0
      and (last_value::numeric / max_value) >= 0.70
      and schemaname not in (${NON_APP_SCHEMAS_SQL})
    order by (last_value::numeric / nullif(max_value, 0)) desc
    limit 20`,

  // Replication slots + retained WAL. An INACTIVE slot pins WAL forever and can
  // fill the disk; a lagging active slot signals a slow downstream consumer.
  // Empty on projects with no logical replication / read replicas / CDC.
  replicationSlots: /* sql */ `
    select
      slot_name,
      slot_type,
      active,
      coalesce(pg_size_pretty(
        pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)
      ), '-') as retained_wal,
      pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) as retained_wal_bytes
    from pg_replication_slots
    order by pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) desc nulls last`,

  // WAL archiving state - the PROXY for PITR when the Management API's backups
  // plane is absent (no-PAT). PITR = physical backups + continuous WAL shipping
  // (WAL-G -> S3); archive_mode on + a non-zero archived_count means WAL is
  // actually being archived, the mechanism PITR relies on. This is an INFERENCE
  // about the DB, NOT the platform add-on flag (last_archived_time can be stale
  // on an idle project even with PITR on, since Supabase skips WAL backups when
  // there is no activity - so we key on archive_mode + archived_count, not age).
  // pg_stat_archiver is a single-row view readable without superuser.
  walArchiving: /* sql */ `
    select
      current_setting('archive_mode') as archive_mode,
      current_setting('wal_level') as wal_level,
      archived_count,
      last_archived_wal,
      last_archived_time::text as last_archived_time,
      case when last_archived_time is null then null
        else extract(epoch from (now() - last_archived_time))::int end as last_archived_age_s,
      failed_count,
      last_failed_time::text as last_failed_time,
      -- Currently failing: at least one failure AND the most recent attempt
      -- failed (last failure newer than the last success, or nothing archived).
      -- A failure that already recovered (last success newer) is NOT flagged.
      case when failed_count > 0
        and (last_archived_time is null or last_failed_time > last_archived_time)
        then true else false end as archiver_failing
    from pg_stat_archiver`,

  // Host-based auth rules (pg_hba_file_rules). The no-PAT proxy for the
  // ssl-enforcement plane: a `host`/`hostnossl` TCP rule with a non-reject auth
  // method means the DB layer admits UNENCRYPTED connections.
  // Needs a TRUE superuser: verified against the Supabase postgres image, the
  // `postgres` role is NOT superuser (no pg_read_all_settings) and is DENIED;
  // only `supabase_admin` (rolsuper) can read it. So this populates only when
  // --db-url is the supabase_admin connstring; other roles degrade to [] via
  // safe() - which is exactly why the finding is gated to no-PAT.
  // PARTIAL signal only - Supabase terminates TLS at the pooler/proxy, so this
  // reflects DB-layer pg_hba, not the platform SSL toggle. Evidence + a hedged
  // low finding, used only when the authoritative plane is absent. database and
  // user_name are text[]; flatten for display.
  hbaRules: /* sql */ `
    select
      type,
      array_to_string(database, ',') as database,
      array_to_string(user_name, ',') as user_name,
      address,
      netmask,
      auth_method
    from pg_hba_file_rules
    where type in ('host', 'hostssl', 'hostnossl')
    order by line_number`,

  connections: /* sql */ `
    select
      coalesce(state, '(none)') as state,
      backend_type,
      count(*) as connections,
      max(extract(epoch from (now() - state_change))::int) as max_state_age_s
    from pg_stat_activity
    where pid <> pg_backend_pid()
    -- split by backend_type so a walsender (Realtime) that sits in state='active'
    -- for the life of its slot is a labelled 'walsender' row, not conflated with
    -- a client backend running an 11-day query (a false hair-on-fire signal).
    group by state, backend_type
    order by connections desc`,

  // POINT-IN-TIME snapshots (state at collection, not a trend). Usually empty;
  // findings only fire when they catch something real.
  // Queries running > 5 minutes right now.
  longRunning: /* sql */ `
    select
      pid,
      age(now(), query_start)::text as duration,
      state,
      left(regexp_replace(query, '\\s+', ' ', 'g'), 120) as query
    from pg_stat_activity
    where query <> '' and state <> 'idle'
      and pid <> pg_backend_pid()
      -- Only real application backends. A walsender (Realtime's
      -- START_REPLICATION worker), autovacuum worker, or the logical
      -- replication launcher sits in state='active' for its whole lifetime by
      -- design - counting those as "a query running > 5 min" is a false
      -- positive on every Realtime-enabled project.
      and backend_type = 'client backend'
      and age(now(), query_start) > interval '5 minutes'
    order by age(now(), query_start) desc
    limit 20`,

  // Sessions currently holding an exclusive lock (self excluded).
  // Point-in-time strong table locks that can block others. We deliberately
  // filter locktype = 'relation': the upstream/Heroku-derived form used only
  // mode = 'ExclusiveLock', which also matches the virtualxid/transactionid
  // ExclusiveLock EVERY active backend holds on its own transaction - including
  // this tool's sibling diagnostic connections - so the section was never empty
  // and mostly showed sbperf auditing itself. Real relation-level locks (the
  // AccessExclusive DDL takes, or explicit LOCK TABLE) are what block queries.
  locks: /* sql */ `
    select
      a.pid,
      coalesce(c.relname, '-') as relation,
      l.mode,
      l.granted,
      age(now(), a.query_start)::text as age,
      left(regexp_replace(a.query, '\\s+', ' ', 'g'), 100) as query
    from pg_stat_activity a
    join pg_locks l on l.pid = a.pid
    left join pg_class c on l.relation = c.oid
    where l.locktype = 'relation'
      and l.mode in ('AccessExclusiveLock', 'ExclusiveLock', 'ShareRowExclusiveLock')
      and a.pid <> pg_backend_pid()
      and a.query <> '<insufficient privilege>'
    order by a.query_start
    limit 20`,

  // Blocking chains: which session is blocked by which (both statements shown).
  blocking: /* sql */ `
    select
      bl.pid as blocked_pid,
      left(regexp_replace(a.query, '\\s+', ' ', 'g'), 80) as blocked_query,
      kl.pid as blocking_pid,
      left(regexp_replace(ka.query, '\\s+', ' ', 'g'), 80) as blocking_query,
      age(now(), ka.query_start)::text as blocking_age
    from pg_locks bl
    join pg_stat_activity a on bl.pid = a.pid
    join pg_locks kl on bl.transactionid = kl.transactionid and bl.pid <> kl.pid
    join pg_stat_activity ka on kl.pid = ka.pid
    where not bl.granted
    limit 20`,

  // Installed extensions vs the latest version the platform makes available.
  // Always safe (pg_extension + pg_available_extension_versions are core
  // catalogs). Powers a report inventory + an "extension behind latest" nudge
  // that works in the PAT read-only tier too, where the vendored splinter
  // extension_versions_outdated lint can't run. Also surfaces pg_cron/pg_net
  // presence so the report can nudge on scheduled-job / async-queue health.
  extensions: /* sql */ `
    select
      e.extname as name,
      e.extversion as installed,
      av.default_version as latest,
      (e.extversion <> av.default_version) as outdated
    from pg_extension e
    left join pg_available_extensions av on av.name = e.extname
    where e.extname not in ('plpgsql')
    order by e.extname`,

  // pgvector columns with no approximate-nearest-neighbour index (ivfflat or
  // hnsw). Always safe: if pgvector isn't installed the 'vector' type doesn't
  // exist so t.typname='vector' matches nothing (zero rows), and the ANN index
  // AMs simply aren't present. A vector column queried by distance without an
  // ANN index does an exact scan of every row - the classic pgvector slow path.
  // Enriched with dimension (atttypmod = raw dims for vector), column storage
  // strategy (attstorage), and an out_of_line flag: the vector type defaults to
  // EXTENDED storage, so any vector wider than the ~2KB TOAST threshold (>~500
  // float32 dims) is stored out-of-line and de-toasted from disk on every exact
  // scan - compounding the no-ANN-index slow path (the large-vector IO trap).
  unindexedVectors: /* sql */ `
    select
      n.nspname as schema,
      c.relname as table,
      a.attname as column,
      nullif(a.atttypmod, -1) as dimensions,
      case a.attstorage
        when 'p' then 'plain'
        when 'e' then 'extended'
        when 'm' then 'main'
        when 'x' then 'external'
        else a.attstorage::text end as storage,
      case when a.attstorage <> 'p'
        and nullif(a.atttypmod, -1) is not null
        and (4 * a.atttypmod + 8) > 2000
        then true else false end as out_of_line
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_type t on t.oid = a.atttypid
    where t.typname = 'vector'
      and c.relkind = 'r'
      and a.attnum > 0
      and not a.attisdropped
      and n.nspname not in ('pg_catalog', 'information_schema')
      and not exists (
        select 1
        from pg_index i
        join pg_class ic on ic.oid = i.indexrelid
        join pg_am am on am.oid = ic.relam
        where i.indrelid = c.oid
          and am.amname in ('ivfflat', 'hnsw')
          and a.attnum = any (i.indkey)
      )
    order by n.nspname, c.relname, a.attname`,

  // Foreign keys whose referencing columns have NO covering index. An unindexed
  // FK forces a sequential scan of the child table on every parent UPDATE/DELETE
  // (to find referencing rows) and escalates locks - slow cascades + contention.
  // A covering index = the FK columns are a leading prefix of some valid index.
  // App-scoped. Standard check (Postgres wiki "unindexed foreign keys").
  fkUnindexed: /* sql */ `
    select
      n.nspname as schema,
      n.nspname || '.' || c.relname as "table",
      con.conname as constraint,
      pg_get_constraintdef(con.oid) as definition
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where con.contype = 'f'
      and n.nspname not in (${NON_APP_SCHEMAS_SQL})
      and not exists (
        select 1 from pg_index i
        where i.indrelid = con.conrelid
          and i.indisvalid
          and (i.indkey::smallint[])[1:cardinality(con.conkey)] @> con.conkey
      )
    order by 1, 2
    limit 30`,

  // Invalid / not-ready indexes: a CREATE INDEX CONCURRENTLY that failed leaves
  // an index that is not used by the planner but still costs writes + disk. It
  // must be dropped and rebuilt. App-scoped.
  invalidIndexes: /* sql */ `
    select
      n.nspname as schema,
      n.nspname || '.' || c.relname as index,
      tn.nspname || '.' || tc.relname as "table",
      not i.indisvalid as invalid,
      not i.indisready as not_ready
    from pg_index i
    join pg_class c on c.oid = i.indexrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_class tc on tc.oid = i.indrelid
    join pg_namespace tn on tn.oid = tc.relnamespace
    where (not i.indisvalid or not i.indisready)
      and n.nspname not in (${NON_APP_SCHEMAS_SQL})
    order by 1
    limit 30`,

  // Multixact-ID wraparound: a SEPARATE 2B ceiling from txid (relminmxid), hit
  // by heavy row-locking (SELECT FOR SHARE/UPDATE, FK checks). The companion to
  // txidWraparound; a table can be safe on xid age yet aging on mxid.
  multixactWraparound: /* sql */ `
    select
      n.nspname as schema,
      n.nspname || '.' || c.relname as "table",
      mxid_age(c.relminmxid) as mxid_age,
      round(100 * mxid_age(c.relminmxid)::numeric / 2000000000, 1) as pct_wraparound
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'm')
      and n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
      and c.relminmxid <> '0'::xid
      and mxid_age(c.relminmxid) > 0
    order by mxid_age(c.relminmxid) desc
    limit 20`,

  // Tables never autovacuumed AND never manually vacuumed, with meaningful row
  // counts. A table autovacuum has never touched has never had its visibility
  // map / statistics maintained - index-only scans can't kick in and the planner
  // works off stale estimates. App-scoped; 10k-row floor keeps noise out.
  neverVacuumed: /* sql */ `
    select
      schemaname as schema,
      schemaname || '.' || relname as "table",
      n_live_tup as live_rows,
      n_dead_tup as dead_rows,
      n_mod_since_analyze as mods_since_analyze
    from pg_stat_user_tables
    where last_autovacuum is null
      and last_vacuum is null
      and n_live_tup >= 10000
      and schemaname not in (${NON_APP_SCHEMAS_SQL})
    order by n_live_tup desc
    limit 20`,

  // Top WAL-generating statements (pg_stat_statements.wal_bytes) - write-
  // amplification attribution the by-time/by-calls views miss. A single
  // statement dominating WAL drives replication lag, backup size, and pg_wal
  // growth on the data volume. App workload only (same noise filters).
  topByWal: /* sql */ `
    select
      queryid::text as queryid,
      round(wal_bytes) as wal_bytes,
      pg_size_pretty(wal_bytes::bigint) as wal,
      calls,
      round((100 * wal_bytes / nullif(sum(wal_bytes) over (), 0))::numeric, 1) as pct_wal,
      left(regexp_replace(query, '\\s+', ' ', 'g'), 160) as query
    from extensions.pg_stat_statements
    where query not ilike all (array[${PLATFORM_NOISE}])
      and query !~* '${NOT_APP_STATEMENT}'
      and wal_bytes > 0
    order by wal_bytes desc
    limit 20`,

  // Visibility-map readiness: large app tables whose all-visible page fraction
  // (pg_class.relallvisible / relpages) is low. The VM gates index-only scans
  // and is maintained by vacuum, so a low ratio on a big table means index-only
  // scans can't skip heap fetches (slower reads) and vacuum is behind on it. No
  // extension needed. 10MB floor (relpages > 1280 8KB pages) keeps noise out.
  visibilityMap: /* sql */ `
    select
      n.nspname as schema,
      n.nspname || '.' || c.relname as "table",
      c.relpages,
      c.relallvisible,
      round(100.0 * c.relallvisible / nullif(c.relpages, 0), 1) as visible_pct
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where c.relkind = 'r'
      and c.relpages > 1280
      and n.nspname not in (${NON_APP_SCHEMAS_SQL})
      and (c.relallvisible::numeric / nullif(c.relpages, 0)) < 0.8
    order by c.relpages desc
    limit 20`,

  // Whether the PUBLIC pseudo-role can CREATE objects in schema public. grantee
  // 0 = PUBLIC in aclexplode. Modern Postgres (15+) revokes this by default, but
  // older / migrated / manually-granted databases still allow any role to create
  // objects in public - a privilege-escalation surface worth flagging. No
  // special privilege needed to read.
  publicSchemaCreate: /* sql */ `
    select
      nspname as schema,
      exists (
        select 1 from aclexplode(nspacl) a
        where a.grantee = 0 and a.privilege_type = 'CREATE'
      ) as public_create
    from pg_namespace
    where nspname = 'public'`,
} as const;

export type QueryKey = keyof typeof QUERIES;
