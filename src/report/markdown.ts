/**
 * Minimal, safe Markdown -> HTML for the narrate output only. narrate emits a
 * known GFM subset (## / ### headings, -/* and 1. lists, **bold**, `code`,
 * ```fenced```, [text](url), --- rules, paragraphs). This renders exactly that
 * subset with everything HTML-escaped first, so model output can't inject
 * markup. It is deliberately NOT a general Markdown parser.
 */

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Inline spans on an ALREADY-escaped text run: links, bold, italic, code. */
function inline(text: string): string {
  let s = escapeHtml(text);
  // [label](http(s)://url) - only http(s) to avoid javascript: etc.
  s = s.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    (_m, label, url) => `<a href="${url}" rel="noreferrer">${label}</a>`,
  );
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  return s;
}

export function mdToHtml(md: string): string {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  let para: string[] = [];
  let list: { type: "ul" | "ol"; items: string[] } | null = null;

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inline(para.join(" "))}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      const items = list.items.map((it) => `<li>${inline(it)}</li>`).join("");
      out.push(`<${list.type}>${items}</${list.type}>`);
      list = null;
    }
  };
  const flush = () => {
    flushPara();
    flushList();
  };

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    // HTML comment (e.g. narrate's provenance header) - drop it.
    if (/^<!--.*-->$/.test(trimmed) || trimmed === "") {
      flush();
      i++;
      continue;
    }

    // Fenced code block.
    if (trimmed.startsWith("```")) {
      flush();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").trim().startsWith("```")) {
        buf.push(lines[i] ?? "");
        i++;
      }
      i++; // skip closing fence
      out.push(`<pre><code>${escapeHtml(buf.join("\n"))}</code></pre>`);
      continue;
    }

    // Horizontal rule.
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flush();
      out.push("<hr>");
      i++;
      continue;
    }

    // ATX heading (#..######); narrate uses ## / ###.
    const h = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flush();
      const level = h[1]!.length;
      out.push(`<h${level}>${inline(h[2]!.trim())}</h${level}>`);
      i++;
      continue;
    }

    // Ordered list item.
    const ol = trimmed.match(/^\d+[.)]\s+(.*)$/);
    if (ol) {
      flushPara();
      if (list?.type !== "ol") {
        flushList();
        list = { type: "ol", items: [] };
      }
      list.items.push(ol[1]!);
      i++;
      continue;
    }

    // Unordered list item.
    const ul = trimmed.match(/^[-*]\s+(.*)$/);
    if (ul) {
      flushPara();
      if (list?.type !== "ul") {
        flushList();
        list = { type: "ul", items: [] };
      }
      list.items.push(ul[1]!);
      i++;
      continue;
    }

    // Plain paragraph text (accumulate until blank line / block).
    flushList();
    para.push(trimmed);
    i++;
  }

  flush();
  return out.join("\n");
}
