import { describe, expect, test } from "bun:test";
import { curate, parsePrometheus } from "../src/metrics.ts";

const SAMPLE = `# HELP node_load1 1m load average.
# TYPE node_load1 gauge
node_load1{supabase_project_ref="abc",service_type="db"} 0.42
node_vmstat_pgmajfault{supabase_project_ref="abc"} 1.98199931e+08
pg_stat_database_num_backends{supabase_project_ref="abc",server="localhost:5432"} 6
go_gc_duration_seconds{quantile="0"} NaN
node_filesystem_avail_bytes{device="/dev/nvme0n1",mountpoint="/data"} 7.444385792e+09
bare_metric_no_labels 123
`;

describe("parsePrometheus", () => {
  test("parses labelled + bare metrics", () => {
    const s = parsePrometheus(SAMPLE);
    const load = s.find((x) => x.name === "node_load1");
    expect(load?.value).toBe(0.42);
    expect(load?.labels.service_type).toBe("db");
  });

  test("parses scientific notation", () => {
    const s = parsePrometheus(SAMPLE);
    expect(s.find((x) => x.name === "node_vmstat_pgmajfault")?.value).toBe(198199931);
  });

  test("drops non-finite (NaN) samples", () => {
    const s = parsePrometheus(SAMPLE);
    expect(s.find((x) => x.name === "go_gc_duration_seconds")).toBeUndefined();
  });

  test("handles bare metric with no labels", () => {
    const s = parsePrometheus(SAMPLE);
    const bare = s.find((x) => x.name === "bare_metric_no_labels");
    expect(bare?.value).toBe(123);
    expect(bare?.labels).toEqual({});
  });

  test("skips comment lines", () => {
    const s = parsePrometheus(SAMPLE);
    expect(s.every((x) => !x.name.startsWith("#"))).toBe(true);
  });
});

describe("curate", () => {
  test("keeps only allowlisted families", () => {
    const c = curate(parsePrometheus(SAMPLE));
    const names = new Set(c.map((x) => x.name));
    expect(names.has("node_load1")).toBe(true);
    expect(names.has("pg_stat_database_num_backends")).toBe(true);
    expect(names.has("node_vmstat_pgmajfault")).toBe(false); // long tail dropped
  });

  // Counter families are kept for the SQLite trend path (rate-able across >=2
  // snapshots). A single scrape value is meaningless, but curate must not drop
  // them or CPU%/IOPS/throughput trends become uncomputable.
  test("keeps rate-able counter families", () => {
    const counters = `node_cpu_seconds_total{cpu="0",mode="idle"} 7.2e+06
node_disk_reads_completed_total{device="nvme0n1"} 3.8e+06
node_disk_writes_completed_total{device="nvme0n1"} 1.2e+06
node_disk_read_bytes_total{device="nvme0n1"} 9.9e+09
node_disk_written_bytes_total{device="nvme0n1"} 8.8e+09
node_disk_io_time_seconds_total{device="nvme0n1"} 12345
node_network_receive_bytes_total{device="ens5"} 4.8e+09
node_network_transmit_bytes_total{device="ens5"} 3.2e+09`;
    const names = new Set(curate(parsePrometheus(counters)).map((x) => x.name));
    for (const n of [
      "node_cpu_seconds_total",
      "node_disk_reads_completed_total",
      "node_disk_writes_completed_total",
      "node_disk_read_bytes_total",
      "node_disk_written_bytes_total",
      "node_disk_io_time_seconds_total",
      "node_network_receive_bytes_total",
      "node_network_transmit_bytes_total",
    ]) {
      expect(names.has(n)).toBe(true);
    }
  });

  // Guard against allowlist rot: these are the CURRENT (2026-07) exporter names
  // after Supabase renames. If Supabase renames again, this fails loudly rather
  // than silently dropping the metric (as pgbouncer_pools_cl_* did before).
  test("keeps current renamed families (anti-rot guard)", () => {
    const current = `pgbouncer_pools_client_waiting_connections{a="b"} 3
pg_stat_database_xact_commit_total{a="b"} 100
pg_stat_database_deadlocks_total{a="b"} 0
pg_database_size_bytes{a="b"} 12345
realtime_postgres_changes_total_subscriptions{a="b"} 2`;
    const names = new Set(curate(parsePrometheus(current)).map((x) => x.name));
    for (const n of [
      "pgbouncer_pools_client_waiting_connections",
      "pg_stat_database_xact_commit_total",
      "pg_stat_database_deadlocks_total",
      "pg_database_size_bytes",
      "realtime_postgres_changes_total_subscriptions",
    ]) {
      expect(names.has(n)).toBe(true);
    }
  });
});

describe("real fixture", () => {
  test("parses a captured 40KB metrics sample without throwing", async () => {
    const text = await Bun.file(`${import.meta.dir}/fixtures/metrics-sample.txt`).text();
    const s = parsePrometheus(text);
    expect(s.length).toBeGreaterThan(50);
    // every sample has a finite value + a name
    expect(s.every((x) => Number.isFinite(x.value) && x.name.length > 0)).toBe(true);
  });
});
