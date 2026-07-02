import { describe, expect, test } from "bun:test";
import { toOpenMetrics } from "../src/promexport.ts";
import type { MetricSample } from "../src/schemas.ts";
import type { SnapshotForTrends } from "../src/trends.ts";

const s = (name: string, value: number, labels: Record<string, string> = {}): MetricSample => ({
  name,
  labels,
  value,
});
const snap = (
  ts: number,
  samples: MetricSample[],
  scalars: Record<string, number | null> = {},
): SnapshotForTrends => ({ ts, samples, scalars });

describe("toOpenMetrics", () => {
  test("emits timestamped samples with one TYPE line per family and an EOF", () => {
    const om = toOpenMetrics([
      snap(1000, [s("node_load1", 0.5)]),
      snap(2000, [s("node_load1", 0.7)]),
    ]);
    expect(om).toContain("# TYPE node_load1 unknown");
    // one TYPE line only, not one per sample
    expect(om.match(/# TYPE node_load1 /g)).toHaveLength(1);
    expect(om).toContain("node_load1 0.5 1000");
    expect(om).toContain("node_load1 0.7 2000");
    expect(om.endsWith("# EOF\n")).toBe(true);
  });

  test("renders labels and preserves them across series", () => {
    const om = toOpenMetrics([
      snap(1000, [
        s("node_disk_reads_completed_total", 10, { device: "nvme0n1" }),
        s("node_disk_reads_completed_total", 20, { device: "nvme1n1" }),
      ]),
    ]);
    expect(om).toContain("# TYPE node_disk_reads_completed_total unknown");
    expect(om).toContain('node_disk_reads_completed_total{device="nvme0n1"} 10 1000');
    expect(om).toContain('node_disk_reads_completed_total{device="nvme1n1"} 20 1000');
  });

  test("escapes backslash and quote in label values", () => {
    const om = toOpenMetrics([snap(1000, [s("x_metric", 1, { path: 'a"b\\c' })])]);
    expect(om).toContain('x_metric{path="a\\"b\\\\c"} 1 1000');
  });

  test("groups a series' points in ascending time order", () => {
    const om = toOpenMetrics([
      snap(3000, [s("node_load1", 0.9)]),
      snap(1000, [s("node_load1", 0.1)]),
      snap(2000, [s("node_load1", 0.5)]),
    ]);
    const lines = om.split("\n").filter((l) => l.startsWith("node_load1 "));
    expect(lines).toEqual(["node_load1 0.1 1000", "node_load1 0.5 2000", "node_load1 0.9 3000"]);
  });

  test("emits SQL scalars as sbperf_ gauges, skipping nulls", () => {
    const om = toOpenMetrics([
      snap(1000, [], { cache_hit_pct: 99.5, index_hit_pct: null }),
      snap(2000, [], { cache_hit_pct: 98.0 }),
    ]);
    expect(om).toContain("# TYPE sbperf_cache_hit_pct unknown");
    expect(om).toContain("sbperf_cache_hit_pct 99.5 1000");
    expect(om).toContain("sbperf_cache_hit_pct 98 2000");
    expect(om).not.toContain("index_hit_pct"); // all-null scalar dropped
  });

  test("returns just the EOF sentinel for an empty history", () => {
    expect(toOpenMetrics([])).toBe("# EOF\n");
  });

  test("is valid OpenMetrics shape: TYPE precedes its samples", () => {
    const om = toOpenMetrics([snap(1000, [s("node_load1", 0.5)])]);
    const typeIdx = om.indexOf("# TYPE node_load1");
    const sampleIdx = om.indexOf("node_load1 0.5");
    expect(typeIdx).toBeGreaterThanOrEqual(0);
    expect(typeIdx).toBeLessThan(sampleIdx);
  });
});
