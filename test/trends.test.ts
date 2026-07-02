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
      snap(1000, [s("node_load1", 0.5, { cpu: "0" })]),
      snap(1300, [s("node_load1", 0.7, { cpu: "0" })]),
    ]);
    const load = find(out, "CPU load (1m)");
    expect(load?.points).toEqual([
      { t: 1000, v: 0.5 },
      { t: 1300, v: 0.7 },
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

  test("gauge series filters by label (disk free /data only)", () => {
    const out = computeTrends([
      snap(1000, [
        s("node_filesystem_avail_bytes", 1000, { mountpoint: "/data" }),
        s("node_filesystem_avail_bytes", 9999, { mountpoint: "/" }),
      ]),
    ]);
    expect(find(out, "Disk free (/data)")?.points).toEqual([{ t: 1000, v: 1000 }]);
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
    const out = computeTrends([snap(1000, [s("node_load1", 0.4)])]);
    expect(find(out, "Disk read IOPS")).toBeUndefined();
    expect(find(out, "Cache hit (%)")).toBeUndefined();
  });

  test("single snapshot: gauges emit, counter rates do not", () => {
    const out = computeTrends([
      snap(1000, [
        s("node_load1", 0.4),
        s("node_disk_reads_completed_total", 1000, { device: "d" }),
      ]),
    ]);
    expect(find(out, "CPU load (1m)")?.points).toHaveLength(1);
    expect(find(out, "Disk read IOPS")).toBeUndefined();
  });

  test("read-time downsampling caps points to maxPoints (Grafana-style)", () => {
    const snaps = [];
    for (let i = 0; i < 1000; i++) snaps.push(snap(1000 + i * 60, [s("node_load1", i)]));
    const out = computeTrends(snaps, { maxPoints: 100 });
    const load = find(out, "CPU load (1m)");
    expect(load?.points.length).toBeLessThanOrEqual(100);
    expect(load?.points.length).toBeGreaterThan(1);
  });

  test("no downsampling when points are under the cap", () => {
    const out = computeTrends(
      [snap(1000, [s("node_load1", 0.5)]), snap(2000, [s("node_load1", 0.7)])],
      { maxPoints: 100 },
    );
    expect(find(out, "CPU load (1m)")?.points).toEqual([
      { t: 1000, v: 0.5 },
      { t: 2000, v: 0.7 },
    ]);
  });

  test("downsampling averages value and time within each bucket", () => {
    const snaps = [
      snap(0, [s("node_load1", 0)]),
      snap(10, [s("node_load1", 2)]),
      snap(20, [s("node_load1", 10)]),
      snap(30, [s("node_load1", 20)]),
    ];
    const pts = find(computeTrends(snaps, { maxPoints: 2 }), "CPU load (1m)")?.points;
    // span 30, bucket width 15: [t0,t10]->avg (t5,v1); [t20,t30]->avg (t25,v15)
    expect(pts).toEqual([
      { t: 5, v: 1 },
      { t: 25, v: 15 },
    ]);
  });

  test("sorts snapshots by ts defensively", () => {
    const out = computeTrends([
      snap(3000, [s("node_load1", 0.9)]),
      snap(1000, [s("node_load1", 0.1)]),
    ]);
    expect(find(out, "CPU load (1m)")?.points).toEqual([
      { t: 1000, v: 0.1 },
      { t: 3000, v: 0.9 },
    ]);
  });
});
