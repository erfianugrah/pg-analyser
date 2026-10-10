import { describe, expect, test } from "bun:test";
import { chromeAppCandidates, chromePrintArgs } from "../src/report/pdf";

describe("chromeAppCandidates", () => {
  test("macOS app bundles are searched, system then per-user", () => {
    const c = chromeAppCandidates("darwin", "/Users/x");
    // App bundles are never on PATH, so Bun.which alone misses an installed Chrome.
    expect(c[0]).toBe("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    expect(c).toContain("/Applications/Chromium.app/Contents/MacOS/Chromium");
    expect(c).toContain("/Users/x/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  });

  test("no fixed paths elsewhere (PATH lookup covers Linux)", () => {
    expect(chromeAppCandidates("linux", "/home/x")).toEqual([]);
  });
});

describe("chromePrintArgs", () => {
  test("prints to the target path with a heading-derived document outline", () => {
    const args = chromePrintArgs("/bin/chrome", "/out/report.pdf", "/tmp/x/report.html");
    expect(args[0]).toBe("/bin/chrome");
    expect(args).toContain("--print-to-pdf=/out/report.pdf");
    // PDF bookmarks come from the h1 (group) / h2 (section) headings.
    expect(args).toContain("--generate-pdf-document-outline");
    expect(args.at(-1)).toBe("file:///tmp/x/report.html");
  });
});
