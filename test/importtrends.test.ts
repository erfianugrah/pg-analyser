import { describe, expect, test } from "bun:test";
import {
  mergeTrends,
  parseTrendsCsv,
  parseTrendsFile,
  parseTrendsJson,
  toEpochSeconds,
} from "../src/importtrends.ts";

describe("toEpochSeconds", () => {
  test("ISO-8601 -> seconds", () => {
    expect(toEpochSeconds("2026-07-03T00:00:00Z")).toBe(1783036800);
  });
  test("epoch ms -> seconds, epoch s unchanged", () => {
    expect(toEpochSeconds(1783036800000)).toBe(1783036800);
    expect(toEpochSeconds(1783036800)).toBe(1783036800);
    expect(toEpochSeconds("1783036800000")).toBe(1783036800);
  });
  test("garbage -> null", () => {
    expect(toEpochSeconds("not a time")).toBeNull();
    expect(toEpochSeconds("")).toBeNull();
  });
});

describe("parseTrendsCsv", () => {
  test("wide CSV: first col time, rest are series", () => {
    const csv =
      "Time,CPU busy,Mem used\n2026-07-01T00:00:00Z,42.1,3200000000\n2026-07-02T00:00:00Z,55,3300000000\n";
    const s = parseTrendsCsv(csv);
    expect(s).toHaveLength(2);
    expect(s[0]).toMatchObject({ title: "CPU busy", unit: "" });
    expect(s[0]?.points).toHaveLength(2);
    expect(s[0]?.points[0]).toEqual({ t: 1782864000, v: 42.1 });
    expect(s[1]?.title).toBe("Mem used");
  });

  test("unit is parsed from a 'Title [unit]' or 'Title (unit)' header", () => {
    const csv = "Time,Disk free [bytes],Load (1m)\n1783036800,1000,0.5\n";
    const s = parseTrendsCsv(csv);
    expect(s[0]).toMatchObject({ title: "Disk free", unit: "bytes" });
    expect(s[1]).toMatchObject({ title: "Load", unit: "1m" });
  });

  test("blank cells are skipped per-series; quoted fields with commas survive", () => {
    const csv = 'Time,"a, b",c\n1783036800,1,\n1783036900,,9\n';
    const s = parseTrendsCsv(csv);
    const ab = s.find((x) => x.title === "a, b");
    const c = s.find((x) => x.title === "c");
    expect(ab?.points).toHaveLength(1);
    expect(c?.points).toHaveLength(1);
    expect(c?.points[0]?.v).toBe(9);
  });

  test("thousands separators stripped; empty input -> []", () => {
    expect(parseTrendsCsv('Time,x\n1783036800,"1,234"\n')[0]?.points[0]?.v).toBe(1234);
    expect(parseTrendsCsv("")).toEqual([]);
    expect(parseTrendsCsv("Time\n1783036800\n")).toEqual([]); // no series column
  });
});

describe("parseTrendsJson", () => {
  test("accepts a TrendSeries[] and {t,v} points", () => {
    const j = JSON.stringify([{ title: "CPU", unit: "%", points: [{ t: 1783036800, v: 40 }] }]);
    const s = parseTrendsJson(j);
    expect(s[0]).toMatchObject({ title: "CPU", unit: "%" });
    expect(s[0]?.points[0]).toEqual({ t: 1783036800, v: 40 });
  });
  test("accepts {trends:[...]} wrapper and [t,v] tuples + ms timestamps", () => {
    const j = JSON.stringify({ trends: [{ title: "Mem", points: [[1783036800000, 3.2]] }] });
    const s = parseTrendsJson(j);
    expect(s[0]?.unit).toBe("");
    expect(s[0]?.points[0]).toEqual({ t: 1783036800, v: 3.2 });
  });
  test("drops entries without a title or points", () => {
    const j = JSON.stringify([
      { unit: "x", points: [{ t: 1, v: 2 }] },
      { title: "ok", points: [] },
    ]);
    expect(parseTrendsJson(j)).toEqual([]);
  });
});

describe("parseTrendsFile", () => {
  test("dispatches by extension and sniffs otherwise", () => {
    expect(parseTrendsFile("x.json", '[{"title":"a","points":[{"t":1,"v":2}]}]')).toHaveLength(1);
    expect(parseTrendsFile("x.csv", "Time,a\n1,2\n")).toHaveLength(1);
    expect(parseTrendsFile("noext", '[{"title":"a","points":[{"t":1,"v":2}]}]')).toHaveLength(1);
    expect(parseTrendsFile("noext", "Time,a\n1,2\n")).toHaveLength(1);
  });
});

describe("mergeTrends", () => {
  test("same title replaces (idempotent re-import); new titles append", () => {
    const existing = [
      { title: "CPU", unit: "%", points: [{ t: 1, v: 1 }] },
      { title: "Mem", unit: "bytes", points: [{ t: 1, v: 2 }] },
    ];
    const incoming = [
      { title: "CPU", unit: "%", points: [{ t: 1, v: 9 }] },
      { title: "Disk", unit: "bytes", points: [{ t: 1, v: 3 }] },
    ];
    const merged = mergeTrends(existing, incoming);
    expect(merged).toHaveLength(3);
    expect(merged.find((s) => s.title === "CPU")?.points[0]?.v).toBe(9);
    expect(merged.find((s) => s.title === "Disk")).toBeTruthy();
  });
});
