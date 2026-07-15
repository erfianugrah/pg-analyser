import { describe, expect, test } from "bun:test";
import type { MetricSample } from "../src/schemas.ts";
import { computeTrends, type SnapshotForTrends } from "../src/trends.ts";

const s = (name: string, value: number, labels: Record<string, string> = {}): MetricSample => ({
  name,
  labels,
  value,
});

function snap(
  ts: number,
  samples: MetricSample[],
  scalars: Record<string, number | null> = {},
): SnapshotForTrends {
  return { ts, samples, scalars };
}

const find = (out: ReturnType<typeof computeTrends>, title: string) =>
  out.find((x) => x.title === title);

describe("computeTrends", () => {
  test("gauge series: one point per snapshot with matching samples", () => {
    const out = computeTrends([
      snap(1000, [s("pg_database_size_bytes", 500)]),
      snap(1300, [s("pg_database_size_bytes", 700)]),
    ]);
    const size = find(out, "Database size");
    expect(size?.points).toEqual([
      { t: 1000, v: 500 },
      { t: 1300, v: 700 },
    ]);
  });

  test("Disk size (bytes): raw provisioned size per snapshot (not the ratio)", () => {
    const out = computeTrends([
      snap(1000, [
        s("node_filesystem_size_bytes", 50e9, { mountpoint: "/data" }),
        s("node_filesystem_avail_bytes", 20e9, { mountpoint: "/data" }),
      ]),
      snap(2000, [
        s("node_filesystem_size_bytes", 150e9, { mountpoint: "/data" }),
        s("node_filesystem_avail_bytes", 120e9, { mountpoint: "/data" }),
      ]),
    ]);
    expect(find(out, "Disk size (bytes)")?.points).toEqual([
      { t: 1000, v: 50e9 },
      { t: 2000, v: 150e9 },
    ]);
    // and the % series still tracks the ratio across the resize
    const pct = find(out, "Disk used (%)")?.points;
    expect(pct?.[0]?.v).toBeCloseTo(60, 5); // (1-20/50)*100
    expect(pct?.[1]?.v).toBeCloseTo(20, 5); // (1-120/150)*100
  });

  test("Disk size (bytes) omitted when the sample is absent", () => {
    const out = computeTrends([snap(1000, [s("pg_database_size_bytes", 1)])]);
    expect(find(out, "Disk size (bytes)")).toBeUndefined();
  });

  test("Slot WAL retained (max, bytes): scalar series from the store", () => {
    const out = computeTrends([
      snap(1000, [], { slot_wal_retained_max_bytes: 100e6 }),
      snap(2000, [], { slot_wal_retained_max_bytes: 400e6 }),
    ]);
    expect(find(out, "Slot WAL retained (max, bytes)")?.points).toEqual([
      { t: 1000, v: 100e6 },
      { t: 2000, v: 400e6 },
    ]);
  });

  test("gauge series sums across label sets (DB connections)", () => {
    const out = computeTrends([
      snap(1000, [
        s("pg_stat_database_num_backends", 3, { datname: "postgres" }),
        s("pg_stat_database_num_backends", 2, { datname: "other" }),
      ]),
    ]);
    expect(find(out, "DB connections")?.points).toEqual([{ t: 1000, v: 5 }]);
  });

  test("disk used % computed from /data avail vs size only", () => {
    const out = computeTrends([
      snap(1000, [
        s("node_filesystem_size_bytes", 1000, { mountpoint: "/data" }),
        s("node_filesystem_avail_bytes", 250, { mountpoint: "/data" }),
        s("node_filesystem_size_bytes", 5000, { mountpoint: "/" }),
        s("node_filesystem_avail_bytes", 4000, { mountpoint: "/" }),
      ]),
    ]);
    // /data: (1 - 250/1000)*100 = 75; the root mount is ignored
    expect(find(out, "Disk used (%)")?.points).toEqual([{ t: 1000, v: 75 }]);
  });

  test("memory used % from MemAvailable vs MemTotal", () => {
    const out = computeTrends([
      snap(1000, [s("node_memory_MemTotal_bytes", 1000), s("node_memory_MemAvailable_bytes", 400)]),
    ]);
    expect(find(out, "Memory used (%)")?.points).toEqual([{ t: 1000, v: 60 }]);
  });

  test("transaction rate from xact_commit delta / dt", () => {
    const out = computeTrends([
      snap(0, [s("pg_stat_database_xact_commit_total", 100, { datname: "postgres" })]),
      snap(100, [s("pg_stat_database_xact_commit_total", 600, { datname: "postgres" })]),
    ]);
    expect(find(out, "Transaction rate (/s)")?.points).toEqual([{ t: 100, v: 5 }]);
  });

  test("counter rate: reads_completed delta / dt -> IOPS", () => {
    const out = computeTrends([
      snap(1000, [s("node_disk_reads_completed_total", 1000, { device: "nvme0n1" })]),
      snap(1300, [s("node_disk_reads_completed_total", 1600, { device: "nvme0n1" })]),
    ]);
    // (1600-1000)/(1300-1000) = 600/300 = 2 IOPS, point at the later ts
    expect(find(out, "Disk read IOPS")?.points).toEqual([{ t: 1300, v: 2 }]);
  });

  test("counter rate sums across devices before differencing", () => {
    const out = computeTrends([
      snap(0, [
        s("node_network_receive_bytes_total", 100, { device: "eth0" }),
        s("node_network_receive_bytes_total", 100, { device: "eth1" }),
      ]),
      snap(100, [
        s("node_network_receive_bytes_total", 300, { device: "eth0" }),
        s("node_network_receive_bytes_total", 300, { device: "eth1" }),
      ]),
    ]);
    // sum: 200 -> 600, delta 400 over 100s = 4 bytes/s
    expect(find(out, "Network RX (bytes/s)")?.points).toEqual([{ t: 100, v: 4 }]);
  });

  test("CPU utilization from idle vs total mode deltas", () => {
    const cpu = (idle: number, user: number) => [
      s("node_cpu_seconds_total", idle, { cpu: "0", mode: "idle" }),
      s("node_cpu_seconds_total", user, { cpu: "0", mode: "user" }),
    ];
    const out = computeTrends([snap(0, cpu(100, 10)), snap(100, cpu(250, 60))]);
    // idle delta 150, user delta 50, total delta 200 -> util = (1 - 150/200)*100 = 25
    expect(find(out, "CPU utilization (%)")?.points).toEqual([{ t: 100, v: 25 }]);
  });

  test("skips a counter interval on reset (later < earlier)", () => {
    const out = computeTrends([
      snap(0, [s("node_disk_reads_completed_total", 1000, { device: "d" })]),
      snap(100, [s("node_disk_reads_completed_total", 1200, { device: "d" })]),
      snap(200, [s("node_disk_reads_completed_total", 50, { device: "d" })]), // reset
      snap(300, [s("node_disk_reads_completed_total", 150, { device: "d" })]),
    ]);
    // intervals: [0->100]=2, [100->200]=reset(skip), [200->300]=1
    expect(find(out, "Disk read IOPS")?.points).toEqual([
      { t: 100, v: 2 },
      { t: 300, v: 1 },
    ]);
  });

  test("scalar series from stored scalars, skipping null points", () => {
    const out = computeTrends([
      snap(1000, [], { cache_hit_pct: 99.5 }),
      snap(2000, [], { cache_hit_pct: null }),
      snap(3000, [], { cache_hit_pct: 98.1 }),
    ]);
    expect(find(out, "Cache hit (%)")?.points).toEqual([
      { t: 1000, v: 99.5 },
      { t: 3000, v: 98.1 },
    ]);
  });

  test("omits series that have no data at all", () => {
    const out = computeTrends([snap(1000, [s("pg_database_size_bytes", 400)])]);
    expect(find(out, "Disk read IOPS")).toBeUndefined();
    expect(find(out, "Cache hit (%)")).toBeUndefined();
  });

  test("single snapshot: gauges emit, counter rates do not", () => {
    const out = computeTrends([
      snap(1000, [
        s("pg_database_size_bytes", 400),
        s("node_disk_reads_completed_total", 1000, { device: "d" }),
      ]),
    ]);
    expect(find(out, "Database size")?.points).toHaveLength(1);
    expect(find(out, "Disk read IOPS")).toBeUndefined();
  });

  test("read-time downsampling caps points to maxPoints (Grafana-style)", () => {
    const snaps = [];
    for (let i = 0; i < 1000; i++)
      snaps.push(snap(1000 + i * 60, [s("pg_database_size_bytes", i)]));
    const out = computeTrends(snaps, { maxPoints: 100 });
    const size = find(out, "Database size");
    expect(size?.points.length).toBeLessThanOrEqual(100);
    expect(size?.points.length).toBeGreaterThan(1);
  });

  test("no downsampling when points are under the cap", () => {
    const out = computeTrends(
      [
        snap(1000, [s("pg_database_size_bytes", 500)]),
        snap(2000, [s("pg_database_size_bytes", 700)]),
      ],
      { maxPoints: 100 },
    );
    expect(find(out, "Database size")?.points).toEqual([
      { t: 1000, v: 500 },
      { t: 2000, v: 700 },
    ]);
  });

  test("downsampling averages value and time within each bucket", () => {
    const snaps = [
      snap(0, [s("pg_database_size_bytes", 0)]),
      snap(10, [s("pg_database_size_bytes", 2)]),
      snap(20, [s("pg_database_size_bytes", 10)]),
      snap(30, [s("pg_database_size_bytes", 20)]),
    ];
    const pts = find(computeTrends(snaps, { maxPoints: 2 }), "Database size")?.points;
    // span 30, bucket width 15: [t0,t10]->avg (t5,v1); [t20,t30]->avg (t25,v15)
    expect(pts).toEqual([
      { t: 5, v: 1 },
      { t: 25, v: 15 },
    ]);
  });

  test("sorts snapshots by ts defensively", () => {
    const out = computeTrends([
      snap(3000, [s("pg_database_size_bytes", 900)]),
      snap(1000, [s("pg_database_size_bytes", 100)]),
    ]);
    expect(find(out, "Database size")?.points).toEqual([
      { t: 1000, v: 100 },
      { t: 3000, v: 900 },
    ]);
  });
});
