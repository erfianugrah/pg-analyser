import { describe, expect, test } from "bun:test";
import { chromePrintArgs } from "../src/report/pdf";

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
