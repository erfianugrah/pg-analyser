import { describe, expect, test } from "bun:test";
import { contentsPages, fillContentsPages, pdfDestPages } from "../src/report/pdfpages";

/** Build a minimal PDF: objects keyed by number, plus a binary content stream to be skipped. */
function pdf(objs: Record<number, string>): Buffer {
  let out = "%PDF-1.4\n";
  for (const [n, body] of Object.entries(objs)) out += `${n} 0 obj\n${body}\nendobj\n`;
  return Buffer.from(`${out}trailer\n<</Root 1 0 R>>\n%%EOF\n`, "latin1");
}

const stream = "<</Length 12>>\nstream\n\x01\x02 9 0 obj endobj\nendstream";
const pageObj = (n: number): string => `<</Type /Page /Parent 2 0 R /Contents ${n + 100} 0 R>>`;

describe("pdfDestPages", () => {
  test("direct /Dests dictionary with array destinations, page order from /Kids", () => {
    const bytes = pdf({
      1: "<</Type /Catalog /Pages 2 0 R /Dests 9 0 R>>",
      2: "<</Type /Pages /Count 3 /Kids [5 0 R 3 0 R 4 0 R]>>",
      3: pageObj(3),
      4: pageObj(4),
      5: pageObj(5),
      9: "<</summary [5 0 R /XYZ 0 500 0]\n/f1 [3 0 R /XYZ 0 1 0]\n/f2 [4 0 R /Fit]>>",
      105: stream,
    });
    // 5 is first in /Kids, so page 1 - the object number does not decide order.
    expect([...pdfDestPages(bytes)]).toEqual([
      ["summary", 1],
      ["f1", 2],
      ["f2", 3],
    ]);
  });

  test("/Names name tree with nested /Kids, literal strings and /Name values", () => {
    const bytes = pdf({
      1: "<</Type /Catalog /Pages 2 0 R /Names 6 0 R>>",
      2: "<</Type /Pages /Kids [3 0 R 4 0 R]>>",
      3: pageObj(3),
      4: pageObj(4),
      6: "<</Dests 7 0 R>>",
      7: "<</Kids [8 0 R 10 0 R]>>",
      8: "<</Limits [(a) (b)] /Names [(alpha) [3 0 R /XYZ 0 0 0] (be\\164a) [4 0 R /Fit]]>>",
      10: "<</Names [<67616d6d61> [4 0 R /Fit]]>>",
    });
    expect(Object.fromEntries(pdfDestPages(bytes))).toEqual({ alpha: 1, beta: 2, gamma: 2 });
  });

  test("nested /Pages nodes are walked depth-first", () => {
    const bytes = pdf({
      1: "<</Type /Catalog /Pages 2 0 R /Dests 9 0 R>>",
      2: "<</Type /Pages /Kids [20 0 R 21 0 R]>>",
      20: "<</Type /Pages /Parent 2 0 R /Kids [3 0 R 4 0 R]>>",
      21: "<</Type /Pages /Parent 2 0 R /Kids [5 0 R]>>",
      3: pageObj(3),
      4: pageObj(4),
      5: pageObj(5),
      9: "<</a [3 0 R /Fit] /b [4 0 R /Fit] /c [5 0 R /Fit]>>",
    });
    expect(Object.fromEntries(pdfDestPages(bytes))).toEqual({ a: 1, b: 2, c: 3 });
  });

  test("dict-form destination with /D, indirect dests object and #xx name escapes", () => {
    const bytes = pdf({
      1: "<</Type /Catalog /Pages 2 0 R /Dests 9 0 R>>",
      2: "<</Type /Pages /Kids [3 0 R 4 0 R]>>",
      3: pageObj(3),
      4: pageObj(4),
      9: "<</one <</D [4 0 R /XYZ 0 0 0]>> /two#2Dx 11 0 R>>",
      11: "<</D 12 0 R>>",
      12: "[3 0 R /Fit]",
    });
    expect(Object.fromEntries(pdfDestPages(bytes))).toEqual({ one: 2, "two-x": 1 });
  });

  test("throws on a PDF with no catalog or no destinations", () => {
    expect(() => pdfDestPages(Buffer.from("not a pdf"))).toThrow();
    const noDests = pdf({
      1: "<</Type /Catalog /Pages 2 0 R>>",
      2: "<</Type /Pages /Kids [3 0 R]>>",
      3: pageObj(3),
    });
    expect(() => pdfDestPages(noDests)).toThrow();
  });
});

describe("contents page slots", () => {
  const toc =
    "<nav class=ptoc><div class=g><ol>" +
    '<li><a href="#findings"><span class=t>Findings</span><span class=c>(36)</span><span class=d></span><span class=pg></span></a></li>' +
    '<li><a href="#trends"><span class=t>Trends</span><span class=d></span><span class=pg></span></a></li>' +
    "</ol></div></nav><main><span class=pg></span></main>";

  test("page number lands in the page slot, count stays in its own span", () => {
    const out = fillContentsPages(
      toc,
      new Map([
        ["findings", 7],
        ["trends", 3],
      ]),
    );
    expect(out).toContain("<span class=c>(36)</span><span class=d></span><span class=pg>7</span>");
    expect(out).toContain("<span class=d></span><span class=pg>3</span></a>");
    // Only inside the nav: the body's own .pg span is untouched.
    expect(out.endsWith("<main><span class=pg></span></main>")).toBe(true);
    expect([...contentsPages(out)]).toEqual([
      ["findings", 7],
      ["trends", 3],
    ]);
  });

  test("null map or missing ids leave empty slots instead of throwing", () => {
    expect(fillContentsPages(toc, null)).toBe(toc);
    const out = fillContentsPages(toc, new Map([["trends", 3]]));
    expect(out).toContain("<span class=c>(36)</span><span class=d></span><span class=pg></span>");
    expect(contentsPages(out).has("findings")).toBe(false);
  });

  test("a parse failure yields a contents list without numbers, not an exception", () => {
    let pages: Map<string, number> | null = null;
    try {
      pages = pdfDestPages(Buffer.from("%PDF-1.4 garbage"));
    } catch {
      pages = null;
    }
    expect(() => fillContentsPages(toc, pages)).not.toThrow();
    expect(contentsPages(fillContentsPages(toc, pages)).size).toBe(0);
  });
});
