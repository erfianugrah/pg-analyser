/**
 * Minimal, dependency-free PDF reader for one job: map the named destinations
 * of a Chromium-written PDF to 1-based page numbers, so the printed contents
 * can show real page numbers (Chromium has no CSS target-counter()).
 *
 * Relies on Chromium's plain-text object dictionaries (no /ObjStm object
 * streams; only content streams are compressed). It supports the catalog
 * /Dests as a direct dictionary or an indirect reference, and a /Names ->
 * /Dests name tree (with /Kids and /Names arrays). Anything else throws and
 * the caller falls back to a contents page without numbers.
 */

type PdfValue = string | number | boolean | null | PdfRef | PdfName | PdfValue[] | PdfDict;
class PdfRef {
  constructor(readonly num: number) {}
}
class PdfName {
  constructor(readonly name: string) {}
}
type PdfDict = { [key: string]: PdfValue };

const WS = new Set([" ", "\t", "\r", "\n", "\f", "\0"]);
const DELIM = new Set(["(", ")", "<", ">", "[", "]", "{", "}", "/", "%"]);

/** Parse one PDF object starting at `pos`; returns the value and the next position. */
function parseValue(s: string, start: number): [PdfValue, number] {
  let i = start;
  while (i < s.length && WS.has(s[i] as string)) i++;
  const c = s[i];
  if (c === undefined) throw new Error("pdf: unexpected end of object");
  if (c === "<" && s[i + 1] === "<") {
    const dict: PdfDict = {};
    i += 2;
    for (;;) {
      while (i < s.length && WS.has(s[i] as string)) i++;
      if (s[i] === ">" && s[i + 1] === ">") return [dict, i + 2];
      const [k, afterKey] = parseValue(s, i);
      if (!(k instanceof PdfName)) throw new Error("pdf: dictionary key is not a name");
      const [v, afterVal] = parseValue(s, afterKey);
      dict[k.name] = v;
      i = afterVal;
    }
  }
  if (c === "<") {
    const end = s.indexOf(">", i);
    if (end < 0) throw new Error("pdf: unterminated hex string");
    const hex = s.slice(i + 1, end).replace(/\s+/g, "");
    const bytes: number[] = [];
    for (let h = 0; h < hex.length; h += 2)
      bytes.push(Number.parseInt(hex.slice(h, h + 2).padEnd(2, "0"), 16));
    return [decodeText(bytes), end + 1];
  }
  if (c === "[") {
    const arr: PdfValue[] = [];
    i++;
    for (;;) {
      while (i < s.length && WS.has(s[i] as string)) i++;
      if (s[i] === "]") return [arr, i + 1];
      const [v, next] = parseValue(s, i);
      arr.push(v);
      i = next;
    }
  }
  if (c === "(") {
    const bytes: number[] = [];
    let depth = 1;
    i++;
    while (i < s.length && depth > 0) {
      const ch = s[i] as string;
      if (ch === "\\") {
        const n = s[i + 1] ?? "";
        const oct = /^[0-7]{1,3}/.exec(s.slice(i + 1, i + 4));
        if (oct) {
          bytes.push(Number.parseInt(oct[0], 8) & 0xff);
          i += 1 + oct[0].length;
          continue;
        }
        const map: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12 };
        if (n === "\r" || n === "\n") {
          i += n === "\r" && s[i + 2] === "\n" ? 3 : 2;
          continue;
        }
        bytes.push(map[n] ?? n.charCodeAt(0));
        i += 2;
        continue;
      }
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) break;
      }
      bytes.push(ch.charCodeAt(0) & 0xff);
      i++;
    }
    return [decodeText(bytes), i + 1];
  }
  if (c === "/") {
    let j = i + 1;
    while (j < s.length && !WS.has(s[j] as string) && !DELIM.has(s[j] as string)) j++;
    const raw = s
      .slice(i + 1, j)
      .replace(/#([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(Number.parseInt(h, 16)));
    return [new PdfName(decodeText([...raw].map((ch) => ch.charCodeAt(0) & 0xff))), j];
  }
  // number / reference / keyword
  let j = i;
  while (j < s.length && !WS.has(s[j] as string) && !DELIM.has(s[j] as string)) j++;
  if (j === i) throw new Error(`pdf: unexpected character ${JSON.stringify(c)}`);
  const tok = s.slice(i, j);
  if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) {
    if (/^\d+$/.test(tok)) {
      const m = /^\s+(\d+)\s+R(?![^\s/<>[\](){}%])/.exec(s.slice(j, j + 24));
      if (m) return [new PdfRef(Number(tok)), j + m[0].length];
    }
    return [Number(tok), j];
  }
  if (tok === "true") return [true, j];
  if (tok === "false") return [false, j];
  if (tok === "null") return [null, j];
  return [tok, j];
}

/** Names and strings are UTF-16BE (BOM) or single-byte; anchors here are ASCII ids. */
function decodeText(bytes: number[]): string {
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    let out = "";
    for (let i = 2; i + 1 < bytes.length; i += 2)
      out += String.fromCharCode(((bytes[i] as number) << 8) | (bytes[i + 1] as number));
    return out;
  }
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(Uint8Array.from(bytes));
  return utf8;
}

/** Index every `N G obj ... endobj` body (up to its stream, which is skipped unread). */
function indexObjects(s: string): Map<number, string> {
  const objs = new Map<number, string>();
  const re = /(?:^|[\r\n])(\d+) \d+ obj\b/g;
  for (;;) {
    const m = re.exec(s);
    if (!m) break;
    const bodyStart = m.index + m[0].length;
    const endObj = s.indexOf("endobj", bodyStart);
    const stream = s.indexOf("stream", bodyStart);
    if (stream >= 0 && (endObj < 0 || stream < endObj)) {
      objs.set(Number(m[1]), s.slice(bodyStart, stream));
      const endStream = s.indexOf("endstream", stream);
      re.lastIndex = endStream >= 0 ? endStream : stream;
    } else {
      objs.set(Number(m[1]), s.slice(bodyStart, endObj < 0 ? s.length : endObj));
      re.lastIndex = endObj < 0 ? s.length : endObj;
    }
  }
  return objs;
}

/**
 * Named destinations -> 1-based page numbers, for every destination whose page
 * object is in the page tree. Throws on a structure it does not understand.
 */
export function pdfDestPages(pdf: Uint8Array | Buffer): Map<string, number> {
  const s = Buffer.from(pdf).toString("latin1");
  const objs = indexObjects(s);
  const cache = new Map<number, PdfValue>();
  const get = (v: PdfValue | undefined): PdfValue | undefined => {
    let cur = v;
    for (let hops = 0; cur instanceof PdfRef && hops < 20; hops++) {
      const ref: PdfRef = cur;
      let val = cache.get(ref.num);
      if (val === undefined) {
        const body = objs.get(ref.num);
        if (body === undefined) return undefined;
        val = parseValue(body, 0)[0];
        cache.set(ref.num, val);
      }
      cur = val;
    }
    return cur;
  };
  const asDict = (v: PdfValue | undefined): PdfDict | undefined => {
    const r = get(v);
    return r &&
      typeof r === "object" &&
      !Array.isArray(r) &&
      !(r instanceof PdfRef) &&
      !(r instanceof PdfName)
      ? (r as PdfDict)
      : undefined;
  };
  const asArray = (v: PdfValue | undefined): PdfValue[] | undefined => {
    const r = get(v);
    return Array.isArray(r) ? r : undefined;
  };
  const isName = (v: PdfValue | undefined, n: string): boolean =>
    get(v) instanceof PdfName && (get(v) as PdfName).name === n;

  let catalog: PdfDict | undefined;
  for (const num of objs.keys()) {
    const d = asDict(new PdfRef(num));
    if (d && isName(d.Type, "Catalog")) catalog = d;
  }
  if (!catalog) throw new Error("pdf: no catalog");

  // Page order from the /Pages tree.
  const pageNum = new Map<number, number>();
  const walk = (ref: PdfValue, seen: Set<number>): void => {
    if (!(ref instanceof PdfRef) || seen.has(ref.num)) return;
    seen.add(ref.num);
    const d = asDict(ref);
    if (!d) return;
    const kids = asArray(d.Kids);
    if (kids && !isName(d.Type, "Page")) for (const k of kids) walk(k, seen);
    else if (isName(d.Type, "Page")) pageNum.set(ref.num, pageNum.size + 1);
  };
  walk(catalog.Pages as PdfValue, new Set());
  if (pageNum.size === 0) throw new Error("pdf: empty page tree");

  const destPage = (v: PdfValue | undefined): number | undefined => {
    let r = get(v);
    const dict = asDict(r);
    if (dict && "D" in dict) r = get(dict.D);
    if (!Array.isArray(r)) return undefined;
    const first = r[0];
    return first instanceof PdfRef ? pageNum.get(first.num) : undefined;
  };

  const out = new Map<string, number>();
  const add = (name: PdfValue | undefined, dest: PdfValue | undefined): void => {
    const key = name instanceof PdfName ? name.name : typeof name === "string" ? name : undefined;
    const page = destPage(dest);
    if (key !== undefined && page !== undefined) out.set(key, page);
  };

  const dests = asDict(catalog.Dests);
  if (dests) for (const [k, v] of Object.entries(dests)) add(new PdfName(k), v);

  const walkTree = (node: PdfValue | undefined, seen: Set<number>): void => {
    if (node instanceof PdfRef) {
      if (seen.has(node.num)) return;
      seen.add(node.num);
    }
    const d = asDict(node);
    if (!d) return;
    const names = asArray(d.Names);
    if (names) for (let i = 0; i + 1 < names.length; i += 2) add(get(names[i]), names[i + 1]);
    const kids = asArray(d.Kids);
    if (kids) for (const k of kids) walkTree(k, seen);
  };
  const nameTree = asDict(catalog.Names);
  if (nameTree) walkTree(nameTree.Dests, new Set());

  if (!dests && !nameTree) throw new Error("pdf: no named destinations");
  return out;
}

/**
 * Fill the page slot of each print-contents entry. Entries look like
 * `<a href="#id" ...>...<span class=pg></span></a>` inside `<nav class=ptoc>`;
 * ids missing from `pages` (or a null map) keep an empty slot.
 */
export function fillContentsPages(html: string, pages: Map<string, number> | null): string {
  return html.replace(/<nav class=ptoc[\s\S]*?<\/nav>/, (nav) =>
    nav.replace(/<a href="#([^"]+)"[^>]*>[\s\S]*?<\/a>/g, (a, id: string) => {
      const p = pages?.get(id);
      return p == null ? a : a.replace("<span class=pg></span>", `<span class=pg>${p}</span>`);
    }),
  );
}

/** The page each contents entry currently shows (ids with a filled slot only). */
export function contentsPages(html: string): Map<string, number> {
  const out = new Map<string, number>();
  const nav = html.match(/<nav class=ptoc[\s\S]*?<\/nav>/)?.[0] ?? "";
  for (const m of nav.matchAll(/<a href="#([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const n = /<span class=pg>(\d+)<\/span>/.exec(m[2] ?? "")?.[1];
    if (n) out.set(m[1] as string, Number(n));
  }
  return out;
}
