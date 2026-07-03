import { describe, expect, test } from "bun:test";
import { HIDEABLE_SECTIONS, loadOverlay, OverlayFile } from "../src/overlay.ts";

// In-memory IO harness mirroring the loadBrand test style.
function harness(files: Record<string, string>) {
  return {
    readText: async (p: string) => {
      const v = files[p];
      if (v === undefined) throw new Error(`no such file ${p}`);
      return v;
    },
    exists: async (p: string) => p in files,
  };
}

describe("OverlayFile schema", () => {
  test("accepts hide + notes", () => {
    const o = OverlayFile.parse({ hide: ["outliers"], notes: { top: "hi" } });
    expect(o.hide).toEqual(["outliers"]);
    expect(o.notes?.top).toBe("hi");
  });
  test("rejects unknown top-level keys", () => {
    expect(() => OverlayFile.parse({ bogus: 1 })).toThrow();
  });
});

describe("loadOverlay", () => {
  const warns: string[] = [];
  const warn = (m: string) => warns.push(m);

  test("no ref and no file -> empty overlay", async () => {
    const o = await loadOverlay({ ...harness({}), warn });
    expect(o.hide.size).toBe(0);
    expect(o.notes).toEqual({});
  });

  test("explicit --overlay file wins over ref conventions", async () => {
    const io = harness({
      "/x/custom.json": JSON.stringify({ hide: ["calls"] }),
      "sbperf.overlays/abc.json": JSON.stringify({ hide: ["outliers"] }),
    });
    const o = await loadOverlay({ ref: "abc", file: "/x/custom.json", cwd: ".", ...io, warn });
    expect([...o.hide]).toEqual(["calls"]);
  });

  test("local ref convention beats global home path", async () => {
    const io = harness({
      "sbperf.overlays/abc.json": JSON.stringify({ hide: ["outliers"] }),
      "/home/u/.sbperf/overlays/abc.json": JSON.stringify({ hide: ["calls"] }),
    });
    const o = await loadOverlay({ ref: "abc", cwd: ".", home: "/home/u", ...io, warn });
    expect([...o.hide]).toEqual(["outliers"]);
  });

  test("unknown hide id is dropped with a warning", async () => {
    const local: string[] = [];
    const io = harness({
      "sbperf.overlays/abc.json": JSON.stringify({ hide: ["nope", "outliers"] }),
    });
    const o = await loadOverlay({ ref: "abc", cwd: ".", ...io, warn: (m) => local.push(m) });
    expect([...o.hide]).toEqual(["outliers"]);
    expect(local.some((m) => m.includes("nope"))).toBe(true);
  });

  test("SBPERF_OVERLAY env wins over ref conventions but loses to --overlay", async () => {
    const io = harness({
      "/x/flag.json": JSON.stringify({ hide: ["calls"] }),
      "/env/over.json": JSON.stringify({ hide: ["outliers"] }),
      "sbperf.overlays/abc.json": JSON.stringify({ hide: ["tables"] }),
    });
    // env beats the ref convention
    const viaEnv = await loadOverlay({
      ref: "abc",
      cwd: ".",
      env: { SBPERF_OVERLAY: "/env/over.json" },
      ...io,
      warn,
    });
    expect([...viaEnv.hide]).toEqual(["outliers"]);
    // explicit --overlay still beats env
    const viaFlag = await loadOverlay({
      ref: "abc",
      file: "/x/flag.json",
      cwd: ".",
      env: { SBPERF_OVERLAY: "/env/over.json" },
      ...io,
      warn,
    });
    expect([...viaFlag.hide]).toEqual(["calls"]);
  });

  test("falls through to the global home path when no local file exists", async () => {
    const io = harness({
      "/home/u/.sbperf/overlays/abc.json": JSON.stringify({ hide: ["calls"] }),
    });
    const o = await loadOverlay({ ref: "abc", cwd: ".", home: "/home/u", ...io, warn });
    expect([...o.hide]).toEqual(["calls"]);
  });

  test("unknown notes key is dropped with a warning; valid notes pass through", async () => {
    const local: string[] = [];
    const io = harness({
      "sbperf.overlays/abc.json": JSON.stringify({
        notes: { top: "hi", outliers: "cron", bogus: "x" },
      }),
    });
    const o = await loadOverlay({ ref: "abc", cwd: ".", ...io, warn: (m) => local.push(m) });
    expect(o.notes).toEqual({ top: "hi", outliers: "cron" });
    expect(local.some((m) => m.includes("bogus"))).toBe(true);
  });

  test("malformed JSON throws", async () => {
    const io = harness({ "sbperf.overlays/abc.json": "{ not json" });
    expect(loadOverlay({ ref: "abc", cwd: ".", ...io, warn })).rejects.toThrow();
  });

  test("HIDEABLE_SECTIONS contains the query sections", () => {
    expect(HIDEABLE_SECTIONS).toContain("outliers");
    expect(HIDEABLE_SECTIONS).toContain("calls");
  });
});
