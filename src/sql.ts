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
]
  .map((p) => `'${p}'`)
  .join(",");

export const QUERIES = {
  dbSize: /* sql */ `
    select pg_size_pretty(pg_database_size(current_database())) as db_size`,

  // Table + index cache-hit ratio. Only meaningful relative to how long stats
  // have accumulated (see statsResetAge) - a fresh reset shows a misleading 100%.
  cacheHit: /* sql */ `
    select
      round(sum(heap_blks_hit) * 100.0
        / nullif(sum(heap_blks_hit + heap_blks_read), 0), 2) as cache_hit_pct,
      (select round(sum(idx_blks_hit) * 100.0
        / nullif(sum(idx_blks_hit + idx_blks_read), 0), 2)
       from pg_statio_user_indexes) as index_hit_pct
    from pg_statio_user_tables`,

  // How long pg_stat_statements has been accumulating. Cache-hit % and the
  // outliers/calls views are only interpretable against this window.
  statsResetAge: /* sql */ `
    select (now() - stats_reset)::text as stats_age
    from extensions.pg_stat_statements_info`,

  // Perf-relevant server settings - the API config endpoint returns {} on many
  // projects, so read them from pg_settings directly.
  pgSettings: /* sql */ `
    select name, setting, unit
    from pg_settings
    where name in (
      'max_connections', 'shared_buffers', 'effective_cache_size', 'work_mem',
      'maintenance_work_mem', 'statement_timeout', 'lock_timeout',
      'idle_in_transaction_session_timeout', 'random_page_cost',
      'max_parallel_workers'
    )
    order by name`,

  // App workload only - platform/introspection noise filtered out.
  topStatements: /* sql */ `
    select
      round(total_exec_time::numeric, 1) as total_ms,
      calls,
      round(mean_exec_time::numeric, 2) as mean_ms,
      round((100 * total_exec_time / nullif(sum(total_exec_time) over (), 0))::numeric, 1) as pct,
      left(regexp_replace(query, '\\s+', ' ', 'g'), 160) as query
    from extensions.pg_stat_statements
    where query not ilike all (array[${PLATFORM_NOISE}])
    order by total_exec_time desc
    limit 20`,

  // Same workload, ranked by call count - surfaces chatty N+1 / hot-path
  // statements that are individually cheap but dominate round-trips.
  topByCalls: /* sql */ `
    select
      calls,
      round(total_exec_time::numeric, 1) as total_ms,
      round(mean_exec_time::numeric, 2) as mean_ms,
      round((100 * calls / nullif(sum(calls) over (), 0))::numeric, 1) as pct_calls,
      left(regexp_replace(query, '\\s+', ' ', 'g'), 160) as query
    from extensions.pg_stat_statements
    where query not ilike all (array[${PLATFORM_NOISE}])
    order by calls desc
    limit 20`,

  biggestTables: /* sql */ `
    select
      schemaname as schema,
      schemaname || '.' || relname as table,
      pg_size_pretty(pg_total_relation_size(relid)) as total_size,
      pg_size_pretty(pg_indexes_size(relid)) as index_size,
      n_live_tup as live_rows
    from pg_stat_user_tables
    order by pg_total_relation_size(relid) desc
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
    where n.nspname not in ('pg_catalog', 'information_schema')
    order by pg_relation_size(i.indexrelid) desc
    limit 30`,

  seqScanHeavy: /* sql */ `
    select
      schemaname as schema,
      schemaname || '.' || relname as table,
      seq_scan,
      idx_scan,
      n_live_tup as live_rows,
      case when seq_scan > 0
        then round((seq_scan::numeric / nullif(seq_scan + idx_scan, 0)) * 100, 1)
        else 0 end as seq_scan_pct
    from pg_stat_user_tables
    where seq_scan > coalesce(idx_scan, 0)
      and n_live_tup > 1000
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
    order by waste_bytes desc
    limit 20`,

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
  rlsPolicies: /* sql */ `
    select
      schemaname || '.' || tablename as table,
      policyname,
      cmd,
      (chk ~ 'auth\\.(uid|jwt|role)\\(\\)' and chk !~ '\\(\\s*select\\s+auth\\.') as unwrapped_auth
    from (
      select schemaname, tablename, policyname, cmd,
        coalesce(qual, '') || ' ' || coalesce(with_check, '') as chk
      from pg_policies
      where schemaname not in ('pg_catalog', 'information_schema')
    ) p
    order by 4 desc, 1`,

  storageUsage: /* sql */ `
    select
      bucket_id,
      count(*) as objects,
      pg_size_pretty(coalesce(sum((metadata->>'size')::bigint), 0)) as size
    from storage.objects
    group by bucket_id
    order by coalesce(sum((metadata->>'size')::bigint), 0) desc`,

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

  connections: /* sql */ `
    select
      coalesce(state, '(none)') as state,
      count(*) as connections,
      max(extract(epoch from (now() - state_change))::int) as max_state_age_s
    from pg_stat_activity
    where pid <> pg_backend_pid()
    group by state
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
      and age(now(), query_start) > interval '5 minutes'
    order by age(now(), query_start) desc
    limit 20`,

  // Sessions currently holding an exclusive lock (self excluded).
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
    where l.mode = 'ExclusiveLock'
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
} as const;

export type QueryKey = keyof typeof QUERIES;
