/**
 * Wikipedia intro wikitext to a Markdown note body (bench/hotpot.mjs). Pure:
 * no network, no file access, so `test/benchHarness.test.mjs` checks it.
 *
 * Templates, tables, references, comments, files and categories are removed
 * (nesting is tracked, not regex-matched). `[[Target|anchor]]` becomes
 * `[[Name|anchor]]` when `resolve(target)` returns a note name and plain
 * `anchor` otherwise, so a link never points outside the slice.
 */

const DROP_NAMESPACES = /^(file|image|category|media)\s*:/i;
const OTHER_NAMESPACE = /^:|^[a-z][a-z-]*\s*:/i;

/** Remove every `open ... close` span, counting nesting; an unclosed one runs to the end. */
function stripNested(text, open, close, keep = () => false) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const at = text.indexOf(open, i);
    if (at === -1) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, at);
    let depth = 0;
    let j = at;
    while (j < text.length) {
      if (text.startsWith(open, j)) {
        depth += 1;
        j += open.length;
      } else if (text.startsWith(close, j)) {
        depth -= 1;
        j += close.length;
        if (depth === 0) break;
      } else j += 1;
    }
    const span = text.slice(at, j);
    out += keep(span) ? span : "";
    i = j;
  }
  return out;
}

/** A wikitext link target as a page title: no fragment, spaces, first letter upper. */
export function normalizeTitle(target) {
  const title = target.split("#")[0].replace(/_/g, " ").replace(/&nbsp;|\s+/g, " ").trim();
  return title ? title[0].toUpperCase() + title.slice(1) : "";
}

/** Bare wikilink link targets (article namespace) in intro wikitext, in order. */
export function linkTargets(wikitext) {
  const targets = [];
  for (const [, inner] of clean(wikitext).matchAll(/\[\[([^[\]]+)\]\]/g)) {
    const target = inner.split("|")[0];
    if (!OTHER_NAMESPACE.test(target.trim()) && normalizeTitle(target)) targets.push(normalizeTitle(target));
  }
  return targets;
}

function clean(wikitext) {
  let text = wikitext.replace(/<!--[\s\S]*?(-->|$)/g, "");
  text = text.replace(/<ref[^>/]*\/>/gi, "").replace(/<ref[^>]*>[\s\S]*?(<\/ref\s*>|$)/gi, "");
  text = stripNested(text, "{{", "}}");
  text = stripNested(text, "{|", "|}");
  // Files and categories nest links in their captions; other [[...]] spans are kept.
  text = stripNested(text, "[[", "]]", (span) => !DROP_NAMESPACES.test(span.slice(2).trim()));
  return text;
}

/**
 * @param {string} wikitext section 0 of a page
 * @param {(title: string) => string | null} resolve note name for an in-slice title
 * @returns {{ body: string, total: number, kept: number }}
 */
export function wikitextToMarkdown(wikitext, resolve) {
  let total = 0;
  let kept = 0;
  let text = clean(wikitext);
  text = text.replace(/\[\[([^[\]]+)\]\]([a-z]*)/g, (_, inner, trail) => {
    const bar = inner.indexOf("|");
    const target = bar === -1 ? inner : inner.slice(0, bar);
    let anchor = bar === -1 ? inner : inner.slice(bar + 1);
    if (anchor === "") anchor = target.replace(/\s*\([^)]*\)\s*$/, "").replace(/,.*$/, ""); // pipe trick
    anchor = (anchor + trail).replace(/\s+/g, " ").trim();
    if (OTHER_NAMESPACE.test(target.trim())) return anchor;
    total += 1;
    const name = resolve(normalizeTitle(target));
    if (!name) return anchor;
    kept += 1;
    return `[[${name}|${anchor.replace(/\|/g, " ")}]]`;
  });
  text = text
    .replace(/\[(https?:)?\/\/[^\s\]]+\s+([^\]]+)\]/g, "$2")
    .replace(/\[(https?:)?\/\/[^\s\]]+\]/g, "")
    .replace(/'{2,}/g, "")
    .replace(/__[A-Z]+__/g, "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&ndash;/g, "-")
    .replace(/&mdash;/g, ", ")
    .replace(/&amp;/g, "&");
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line && !/^[|}!]/.test(line));
  return { body: lines.join("\n\n").replace(/ {2,}/g, " ").replace(/\(\s*[;,]?\s*\)/g, ""), total, kept };
}
