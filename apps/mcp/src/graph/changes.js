// Changed-section detection for post-write link suggestions (AGENT-LINKS 13.4).
// Pure and synchronous: the pre-write body and the committed body in, the
// sections whose prose this write changed out. Offsets are JavaScript string
// offsets into `committed`; `text` is always `committed.slice(start, end)`.
//
// The pipeline is the one 13.4 sketches, without a tree diff:
//   1. each line of both texts reduced to a comparison key: frontmatter and
//      code (`codeRanges`) blanked, link markup reduced to its visible text
//      (`extractReferences` spans), emphasis markers and whitespace dropped;
//   2. a line diff over the non-empty keys (common prefix and suffix trimmed,
//      then Myers' diff bounded by MAX_EDIT_DISTANCE);
//   3. hunks whose old and new keys join to the same words are reflows and
//      dropped; the rest are charged to the innermost heading interval of the
//      committed text, a pure deletion to the section where it happened;
//   4. at most `maxSections`, most changed prose first, ties in document order.
//
// A create (`before === ""`), an unknown old body (`null`), an input over
// `maxInputChars` or an edit distance over MAX_EDIT_DISTANCE is the limited pass of
// 13.4: status `new`, the first sections with prose of their own, in document
// order, taken from at most the first `maxInputChars` characters.
import { codeRanges, extractReferences } from "../links.js";

export const MAX_INPUT_CHARS = 256 * 1024;
// Inserted plus deleted comparison lines the Myers diff may find. A write
// changing more than this is a rewrite, seeded like a new note. It bounds the
// cost: at most (D + 1)^2 trace entries (4 MB of Int32 at 1,000) and
// O((N + M) * D) line comparisons.
export const MAX_EDIT_DISTANCE = 1000;

const ATX = /^ {0,3}(#{1,6})(?=[ \t]|\r?$)/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*\r?$/;
const NOT_PARAGRAPH = /^ {0,3}(?:[-*+](?:[ \t]|\r?$)|>|\||\d{1,9}[.)](?:[ \t]|\r?$)|#)/;
const PROSE = /[\p{L}\p{N}]/u;

export function detectChangedSections(before, committed, { maxSections = 2, maxInputChars = MAX_INPUT_CHARS } = {}) {
  before ??= null;
  committed ??= "";
  const limited = committed.length > maxInputChars || (before?.length ?? 0) > maxInputChars;
  if (limited || before === null || before === "") {
    const doc = analyze(committed.slice(0, cutAt(committed, maxInputChars)), false);
    return newPass(doc, committed, maxSections);
  }

  const old = analyze(before, true);
  const doc = analyze(committed, true);
  const a = old.keys.flatMap((key, line) => (key === "" ? [] : [line]));
  const b = doc.keys.flatMap((key, line) => (key === "" ? [] : [line]));
  const hunks = diff(a.map((line) => old.keys[line]), b.map((line) => doc.keys[line]));
  if (hunks === null) return newPass(analyze(committed.slice(0, cutAt(committed, maxInputChars)), false), committed, maxSections);

  const weight = new Map();
  const charge = (section, amount) => {
    if (section !== -1) weight.set(section, (weight.get(section) ?? 0) + amount);
  };
  for (const { del, ins, at } of hunks) {
    const oldKeys = del.map((i) => old.keys[a[i]]);
    const newKeys = ins.map((j) => doc.keys[b[j]]);
    if (oldKeys.join(" ") === newKeys.join(" ")) continue; // reflow or whitespace only
    for (const j of ins) charge(doc.lineSection[b[j]], doc.keys[b[j]].length);
    // A deletion belongs where it happened: with the new lines that replaced
    // it, else the line before it, else the line after it.
    const place = ins.length > 0 ? ins[0] : at > 0 ? at - 1 : at;
    if (place < b.length) charge(doc.lineSection[b[place]], oldKeys.join("").length);
  }

  const sections = [...weight.keys()]
    .sort((x, y) => weight.get(y) - weight.get(x) || x - y)
    .slice(0, maxSections)
    .map((index) => toSection(doc.sections[index], committed));
  return { sections, status: sections.length > 0 ? "changed" : "skipped" };
}

function newPass(doc, committed, maxSections) {
  const eligible = new Set();
  doc.keys.forEach((key, line) => {
    if (doc.lineSection[line] !== -1 && !doc.headingLine[line] && key !== "") eligible.add(doc.lineSection[line]);
  });
  const sections = [...eligible]
    .slice(0, maxSections)
    .map((index) => toSection(doc.sections[index], committed));
  return { sections, status: sections.length > 0 ? "new" : "skipped" };
}

const toSection = ({ heading, depth, start, end }, committed) => ({
  heading,
  depth,
  start,
  end,
  text: committed.slice(start, end),
});

/** Never end a slice between the two halves of a surrogate pair. */
function cutAt(text, cap) {
  if (cap >= text.length) return text.length;
  const unit = text.charCodeAt(cap - 1);
  return unit >= 0xd800 && unit <= 0xdbff ? cap - 1 : cap;
}

/**
 * Lines, comparison keys and heading intervals of one text.
 * `keys[i]` is "" for a line with nothing comparable (blank, code, frontmatter,
 * no letter or digit).
 * `lineSection[i]` is the index into `sections` of the innermost interval
 * holding line i, or -1 for frontmatter.
 */
function analyze(text, reduceLinks) {
  const raw = text.split("\n");
  const starts = [];
  for (let i = 0, offset = 0; i < raw.length; offset += raw[i].length + 1, i += 1) starts.push(offset);

  const masked = maskCode(text);
  const reduced = (reduceLinks ? reduceLinkMarkup(text, masked) : masked).split("\n");
  const front = frontmatterLines(raw);
  const keys = reduced.map((line, i) => (i < front ? "" : normalize(line)));
  const shown = masked.split("\n");

  // Headings: ATX lines, and setext underlines under a paragraph line.
  const headings = [];
  const headingLine = new Array(raw.length).fill(false);
  for (let i = front; i < raw.length; i += 1) {
    const atx = ATX.exec(shown[i]);
    if (atx) {
      const title = stripClosingHashes(raw[i].replace(/\r$/, "").replace(/^ {0,3}#{1,6}/, ""));
      headings.push({ line: i, depth: atx[1].length, heading: title });
      headingLine[i] = true;
      continue;
    }
    const setext = SETEXT.exec(shown[i]);
    const above = i - 1;
    if (setext && above >= front && !headingLine[above] && keys[above] !== "" && !NOT_PARAGRAPH.test(shown[above])) {
      headings.push({ line: above, depth: setext[1][0] === "=" ? 1 : 2, heading: raw[above].trim() });
      headingLine[above] = headingLine[i] = true;
    }
  }

  const sections = [];
  const bodyStart = front < raw.length ? starts[front] : text.length;
  const firstHeading = headings.length > 0 ? starts[headings[0].line] : text.length;
  if (firstHeading > bodyStart) sections.push({ heading: null, depth: 0, start: bodyStart, end: firstHeading });
  // Each interval ends at the next heading of equal or shallower depth.
  const open = [];
  for (const h of headings) {
    while (open.length > 0 && open.at(-1).depth >= h.depth) open.pop().end = starts[h.line];
    const section = { heading: h.heading, depth: h.depth, start: starts[h.line], end: text.length };
    sections.push(section);
    open.push(section);
  }

  const lineSection = new Array(raw.length).fill(-1);
  let current = sections.length > 0 && sections[0].heading === null ? 0 : -1;
  let nextHeading = 0;
  for (let i = front; i < raw.length; i += 1) {
    while (nextHeading < headings.length && headings[nextHeading].line <= i) {
      nextHeading += 1;
      current = sections.length - headings.length + nextHeading - 1;
    }
    lineSection[i] = current;
  }
  return { keys, sections, lineSection, headingLine };
}

/**
 * An ATX heading's text without its closing sequence: trailing `#`s count only
 * when preceded by a space, a tab or nothing (CommonMark). A walk, not a
 * regex: `/[ \t]+#+[ \t]*$/` backtracks quadratically on a run of spaces.
 */
function stripClosingHashes(title) {
  let end = title.length;
  while (end > 0 && (title[end - 1] === " " || title[end - 1] === "\t")) end -= 1;
  let hashes = end;
  while (hashes > 0 && title[hashes - 1] === "#") hashes -= 1;
  if (hashes < end && (hashes === 0 || title[hashes - 1] === " " || title[hashes - 1] === "\t")) end = hashes;
  return title.slice(0, end).trim();
}

/** The number of leading lines that are YAML frontmatter (0 when there is none). */
function frontmatterLines(lines) {
  if (lines.length === 0 || lines[0].replace(/\r$/, "") !== "---") return 0;
  for (let i = 1; i < lines.length; i += 1) {
    if (/^(?:---|\.\.\.)[ \t]*\r?$/.test(lines[i])) return i + 1;
  }
  return 0;
}

/** `text` with every code character except newlines replaced by NUL: same length, same lines. */
function maskCode(text) {
  let out = "";
  let at = 0;
  for (const [from, to] of codeRanges(text)) {
    const start = Math.max(from, at);
    if (to <= start) continue;
    out += text.slice(at, start) + text.slice(start, to).replace(/[^\n]/g, "\0");
    at = to;
  }
  return out + text.slice(at);
}

/**
 * `masked` with each link reduced to the words a reader sees: a wikilink to its
 * alias or target, an inline link to its label, an embed and a whole
 * definition line (`[id]: target "title"`) to nothing. Newlines inside a link are kept so lines stay aligned.
 */
function reduceLinkMarkup(text, masked) {
  let out = "";
  let at = 0;
  for (const ref of extractReferences(text)) {
    const span = linkSpan(text, masked, ref);
    if (span === null || span.from < at) continue;
    const newlines = text.slice(span.from, span.to).split("\n").length - 1;
    out += masked.slice(at, span.from) + span.visible + "\n".repeat(newlines);
    at = span.to;
  }
  return out + masked.slice(at);
}

const INLINE_TAIL = />?\s*(?:"[^"\n]*"|'[^'\n]*')?\)/y;

function linkSpan(text, masked, ref) {
  if (ref.kind === "url") return null; // a bare URL is already its visible text
  if (ref.kind === "definition") {
    const from = text.indexOf("[", text.lastIndexOf("\n", ref.start - 1) + 1);
    const lineEnd = text.indexOf("\n", ref.end);
    return { from, to: lineEnd === -1 ? text.length : lineEnd, visible: "" };
  }
  if (ref.kind === "wiki") {
    const close = text.indexOf("]]", ref.end);
    if (close === -1) return null;
    const words = text[ref.end] === "|" ? masked.slice(ref.end + 1, close) : masked.slice(ref.start, ref.end);
    return { from: ref.start - 2 - (ref.embed ? 1 : 0), to: close + 2, visible: ref.embed ? "" : words };
  }
  // Inline: `[label](target "title")`, the target optionally in `<…>`.
  const bracketed = text[ref.start - 1] === "<" && text[ref.start - 2] === "(";
  const bracket = ref.start - (bracketed ? 3 : 2);
  if (text[bracket] !== "]" || text[bracket + 1] !== "(") return null;
  let back = bracket - 1;
  while (back >= 0 && text[back] !== "]" && text[back] !== "\n") back -= 1;
  const open = text.indexOf("[", back + 1);
  if (open === -1 || open >= bracket) return null;
  INLINE_TAIL.lastIndex = ref.end;
  if (INLINE_TAIL.exec(text) === null) return null;
  const from = ref.embed && text[open - 1] === "!" ? open - 1 : open;
  return { from, to: INLINE_TAIL.lastIndex, visible: ref.embed ? "" : masked.slice(open + 1, bracket) };
}

/** Code masks, emphasis markers and whitespace runs removed; "" when no letter or digit is left. */
function normalize(line) {
  const key = line.replace(/\0/g, "").replace(/\*|_|~~|==/g, "").replace(/\s+/g, " ").trim();
  return PROSE.test(key) ? key : ""; // no letter or digit: a rule, an alignment row
}

/**
 * Hunks turning `a` into `b`: `del` indices into `a`, `ins` indices into `b`,
 * `at` the index in `b` where the hunk sits. Common prefix and suffix trimmed,
 * then Myers' diff on the rest; `null` when the edit distance is over
 * MAX_EDIT_DISTANCE.
 */
function diff(a, b) {
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > lo && endB > lo && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const ops = myers(a.slice(lo, endA), b.slice(lo, endB));
  if (ops === null) return null;

  const hunks = [];
  let hunk = null;
  let i = lo;
  let j = lo;
  for (const op of ops) {
    if (op === EQUAL) {
      hunk = null;
      i += 1;
      j += 1;
      continue;
    }
    if (hunk === null) {
      hunk = { del: [], ins: [], at: j };
      hunks.push(hunk);
    }
    if (op === DELETE) hunk.del.push(i++);
    else hunk.ins.push(j++);
  }
  return hunks;
}

const EQUAL = 0;
const DELETE = 1;
const INSERT = 2;

/**
 * The edit script from `a` to `b` in order (Myers 1986: greedy forward pass,
 * backtracked through a copy of each step's diagonals), or `null` past
 * MAX_EDIT_DISTANCE.
 */
function myers(a, b) {
  const n = a.length;
  const m = b.length;
  const cap = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = cap + 1;
  const v = new Int32Array(2 * cap + 3); // furthest x on diagonal k = x - y, at v[offset + k]
  const trace = [];
  for (let d = 0; d <= cap; d += 1) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        trace.push(v.slice(offset - d, offset + d + 1));
        return backtrack(trace, n, m);
      }
    }
    trace.push(v.slice(offset - d, offset + d + 1));
  }
  return null;
}

function backtrack(trace, n, m) {
  const ops = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d -= 1) {
    const step = trace[d - 1]; // diagonal k of step d - 1 is at step[k + d - 1]
    const k = x - y;
    const down = k === -d || (k !== d && step[k - 1 + d - 1] < step[k + 1 + d - 1]);
    const previousK = down ? k + 1 : k - 1;
    const previousX = step[previousK + d - 1];
    const snakeStart = down ? previousX : previousX + 1;
    while (x > snakeStart) {
      ops.push(EQUAL);
      x -= 1;
      y -= 1;
    }
    ops.push(down ? INSERT : DELETE);
    x = previousX;
    y = previousX - previousK;
  }
  while (x > 0) {
    ops.push(EQUAL);
    x -= 1;
  }
  return ops.reverse();
}
