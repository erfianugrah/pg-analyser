import { describe, expect, test } from "bun:test";
import { applyBrand, brandVars, DEFAULT_BRAND, faviconTag, loadBrand } from "../src/brand.ts";

describe("applyBrand", () => {
  test("empty override yields the Supabase default", () => {
    expect(applyBrand({})).toEqual(DEFAULT_BRAND);
  });
  test("partial override merges over the default", () => {
    const b = applyBrand({ accent: "#ff0000", name: "Acme" });
    expect(b.accent).toBe("#ff0000");
    expect(b.name).toBe("Acme");
    expect(b.ink).toBe(DEFAULT_BRAND.ink); // untouched
  });
  test("a logo with no explicit favicon becomes the favicon too", () => {
    const b = applyBrand({ logoSvg: "<svg id=x></svg>" });
    expect(b.faviconSvg).toBe("<svg id=x></svg>");
  });
  test("an explicit favicon is kept distinct from the logo", () => {
    const b = applyBrand({ logoSvg: "<svg id=logo></svg>", faviconSvg: "<svg id=fav></svg>" });
    expect(b.logoSvg).toBe("<svg id=logo></svg>");
    expect(b.faviconSvg).toBe("<svg id=fav></svg>");
  });
});

describe("loadBrand precedence", () => {
  const files: Record<string, string> = {
    "/brand.json": JSON.stringify({ accent: "#111111" }),
    "/env.json": JSON.stringify({ accent: "#222222" }),
    "./sbperf.brand.json": JSON.stringify({ accent: "#333333" }),
    "/logo.svg": "<svg id=fromfile></svg>",
    "/withpath.json": JSON.stringify({ logoPath: "/logo.svg" }),
  };
  const readText = async (p: string) => {
    if (!(p in files)) throw new Error(`no such file ${p}`);
    return files[p]!;
  };
  const exists = async (p: string) => p in files;

  test("default when nothing is configured", async () => {
    const b = await loadBrand({ env: {}, exists: async () => false, readText });
    expect(b).toEqual(DEFAULT_BRAND);
  });
  test("explicit --file wins", async () => {
    const b = await loadBrand({
      file: "/brand.json",
      env: { SBPERF_BRAND: "/env.json" },
      readText,
      exists,
    });
    expect(b.accent).toBe("#111111");
  });
  test("SBPERF_BRAND env used when no --file", async () => {
    const b = await loadBrand({ env: { SBPERF_BRAND: "/env.json" }, readText, exists });
    expect(b.accent).toBe("#222222");
  });
  test("./sbperf.brand.json auto-loaded when present and nothing else set", async () => {
    const b = await loadBrand({ env: {}, readText, exists });
    expect(b.accent).toBe("#333333");
  });
  test("logoPath is read into logoSvg (and favicon)", async () => {
    const b = await loadBrand({ file: "/withpath.json", env: {}, readText, exists });
    expect(b.logoSvg).toBe("<svg id=fromfile></svg>");
    expect(b.faviconSvg).toBe("<svg id=fromfile></svg>");
  });
  test("rejects unknown keys (strict)", async () => {
    const rt = async () => JSON.stringify({ bogus: 1 });
    await expect(loadBrand({ file: "/x.json", env: {}, readText: rt, exists })).rejects.toThrow();
  });
});

describe("render helpers", () => {
  test("faviconTag encodes the SVG into a data-uri", () => {
    const tag = faviconTag(applyBrand({ faviconSvg: "<svg id=a></svg>" }));
    expect(tag).toContain('rel="icon"');
    expect(tag).toContain("data:image/svg+xml,");
    expect(tag).toContain(encodeURIComponent("<svg id=a></svg>"));
  });
  test("brandVars emits accent + link custom properties", () => {
    expect(brandVars(applyBrand({ accent: "#abc", ink: "#def" }))).toBe(
      "--accent:#abc;--link:#def",
    );
  });
  test("default brand is Supabase green", () => {
    expect(DEFAULT_BRAND.accent).toBe("#3ECF8E");
    expect(DEFAULT_BRAND.name).toBe("Supabase");
    expect(DEFAULT_BRAND.logoSvg).toContain("#3ECF8E");
  });
});
