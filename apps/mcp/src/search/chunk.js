/**
 * Pure note chunker for search (Phase 5, P8). Nothing imports it yet.
 *
 * `chunkNote(path, text, { target, max, cap })` cuts the input at `cap`, then
 * packs whole units (heading line, paragraph, fenced block, frontmatter) up to
 * about `target` characters. A unit longer than `max` is split at sentences,
 * and a sentence longer than `max` at the last whitespace before `max`. The
 * chunks tile the capped input exactly: every character is in exactly one.
 *
 * A heading always starts a new chunk (except directly after frontmatter), so
 * a chunk never straddles two sections. `max` defaults to 1.5 * target
 * (OPEN-54), which gives 3,000 at the standard 2,000.
 *
 * Sentences use `Intl.Segmenter` when present, else a punctuation split. The
 * check runs per call so tests can remove the Segmenter.
 */

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const BLANK = /^[ \t\r]*$/;
const SENTENCE_END = /[.!?。！？]+(?:\s+|$)/g;

/** Offsets just past each sentence (trailing whitespace included) in `s`. */
function sentenceEnds(s) {
  const ends = [];
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    for (const { index, segment } of new Intl.Segmenter(undefined, { granularity: "sentence" }).segment(s)) {
      ends.push(index + segment.length);
    }
  } else {
    for (const m of s.matchAll(SENTENCE_END)) ends.push(m.index + m[0].length);
    if (ends[ends.length - 1] !== s.length) ends.push(s.length);
  }
  return ends;
}

/** Split [from, to) at the last whitespace before `max`, else hard at `max`. */
function splitLong(text, from, to, max, out) {
  while (to - from > max) {
    let cut = from + max;
    let i = cut;
    while (i > from && !/\s/.test(text[i - 1])) i -= 1;
    if (i > from) cut = i;
    else if (/[\uD800-\uDBFF]/.test(text[cut - 1])) cut -= 1; // lean: never split a surrogate pair
    out.push([from, cut]);
    from = cut;
  }
  out.push([from, to]);
}

/** Units as [start, end, isHeading, headingOnlyFrontmatter] tiling `text`. */
function toUnits(text) {
  const units = [];
  let unitStart = 0;
  let pendingBlank = false; // current unit already has content followed by a blank line
  let hasContent = false;
  let fence = null;
  let pos = 0;

  const cut = (at, heading = false) => {
    if (at > unitStart) units.push([unitStart, at, heading]);
    unitStart = at;
    pendingBlank = false;
    hasContent = false;
  };

  const front = /^---[ \t]*\r?\n/.exec(text);
  if (front) {
    for (let p = front[0].length; p < text.length; ) {
      const nl = text.indexOf("\n", p);
      const end = nl === -1 ? text.length : nl + 1;
      if (/^(---|\.\.\.)[ \t]*\r?$/.test(text.slice(p, nl === -1 ? end : nl))) {
        cut(end);
        units[0].push(true); // frontmatter marker
        pos = end;
        break;
      }
      p = end;
    }
  }

  while (pos < text.length) {
    const nl = text.indexOf("\n", pos);
    const end = nl === -1 ? text.length : nl + 1;
    const line = text.slice(pos, nl === -1 ? end : nl).replace(/\r$/, "");
    if (fence) {
      const close = FENCE.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length && /^\s*$/.test(line.slice(close[0].length))) {
        fence = null;
        cut(end);
      }
    } else if (BLANK.test(line)) {
      if (hasContent) pendingBlank = true;
    } else {
      const open = FENCE.exec(line);
      const head = HEADING.exec(line);
      if (open) {
        cut(pos);
        fence = open[1];
        hasContent = true;
      } else if (head) {
        cut(pos);
        cut(end, true);
      } else {
        if (pendingBlank) cut(pos);
        hasContent = true;
      }
    }
    pos = end;
  }
  cut(text.length);
  return units;
}

export function chunkNote(_path, text, { target = 2000, max = Math.floor(target * 1.5), cap = 64000 } = {}) {
  const partial = text.length > cap;
  const body = partial ? text.slice(0, cap) : text;

  // Expand any unit over max into sentences, and sentences over max into whitespace pieces.
  const units = [];
  for (const [start, end, heading, front] of toUnits(body)) {
    if (end - start <= max) {
      units.push({ start, end, heading, front });
      continue;
    }
    const pieces = [];
    let from = start;
    for (const e of sentenceEnds(body.slice(start, end))) {
      splitLong(body, from, start + e, max, pieces);
      from = start + e;
    }
    pieces.forEach(([s, e], i) => units.push({ start: s, end: e, heading: heading && i === 0, front: front && i === 0 }));
  }

  const spans = [];
  let cur = null;
  for (const u of units) {
    const size = cur ? u.end - cur.start : 0;
    const joins =
      cur &&
      !(u.heading && !cur.front) &&
      (size <= target || (cur.headingOnly && size <= max));
    if (joins) {
      cur.end = u.end;
      cur.headingOnly = false;
      cur.front = false;
    } else {
      if (cur) spans.push(cur);
      cur = { start: u.start, end: u.end, headingOnly: u.heading, front: u.front };
    }
  }
  if (cur) spans.push(cur);

  // Heading path at each chunk start: headings at or before it, outermost first.
  const headings = [];
  let inFence = null;
  for (const m of body.matchAll(/^.*$/gm)) {
    const f = FENCE.exec(m[0]);
    if (inFence) {
      if (f && f[1][0] === inFence[0] && f[1].length >= inFence.length) inFence = null;
    } else if (f) inFence = f[1];
    else {
      const h = HEADING.exec(m[0]);
      if (h) headings.push({ at: m.index, level: h[1].length, text: h[2] });
    }
  }
  const pathAt = (at) => {
    const stack = [];
    for (const h of headings) {
      if (h.at > at) break;
      while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
      stack.push(h);
    }
    return stack.map((h) => h.text);
  };

  const chunks = spans.map((s, index) => ({
    index,
    start: s.start,
    end: s.end,
    text: body.slice(s.start, s.end),
    headingPath: pathAt(s.start),
  }));
  return { chunks, partial };
}
