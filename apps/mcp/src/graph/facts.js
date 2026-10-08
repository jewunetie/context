// Pure forward-record builder (arch 7.1, 9.2). No store access: body in, node
// record and reverse membership set out. Memberships are `postingRef` strings
// `"<family>:<hash>"`, deduplicated by the Set; occurrences keep every span.
import { isEncryptedNote } from "../encryption.js";
import { extractReferences, resolveLink } from "../links.js";
import { sha256Hex } from "../ingestion/inbox.js";
import { GRAPH_FORMAT_VERSION, GRAPH_RECORD_BYTE_CAP, serializeNode } from "./records.js";
import { exceedsUtf8Bytes } from "../search/maintain.js";
import { nameHash, pathHash, urlHash } from "./keys.js";
import { URL_KEY_VERSION, urlKey } from "./urlKey.js";
import { extractFields } from "../search/indexer.js";

// 2: bare URLs and autolinks are url occurrences. 3: occurrences carry their
// display text and the record its title (anchor text, search/anchors.js).
export const PARSER_VERSION = 3;
export const RESOLVER_VERSION = 1;

// Anchor-text caps (CONTRACT-v3.md "Anchor text"). A display text is cut to
// ANCHOR_TEXT_CHARS, one posting entry keeps at most ANCHOR_TEXTS_PER_ENTRY
// distinct texts, and a title is cut to ANCHOR_TITLE_CHARS. They bound what
// one entry adds to a posting page: at most 8 x 64 + 120 characters.
export const ANCHOR_TEXT_CHARS = 64;
export const ANCHOR_TEXTS_PER_ENTRY = 8;
export const ANCHOR_TITLE_CHARS = 120;

/** Whitespace folded and cut to `max` characters, never splitting a surrogate pair. */
function clip(text, max) {
  const folded = text.replace(/\s+/g, " ").trim();
  if (folded.length <= max) return folded;
  const cut = folded.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/**
 * The text a reader sees for one link: a wikilink's alias (`[[B|alias]]`) or
 * an inline link's label (`[label](b.md)`), read from the spans
 * `extractReferences` reports. None for an embed, a definition, a URL or a
 * wikilink without an alias (its text is the target's own name).
 */
function displayText(body, o) {
  if (o.embed || o.style === null) return "";
  if (o.kind === "wiki") {
    if (body[o.end] !== "|") return "";
    const close = body.indexOf("]]", o.end + 1);
    const text = close === -1 ? "" : body.slice(o.end + 1, close);
    return text.includes("\n") ? "" : clip(text, ANCHOR_TEXT_CHARS);
  }
  if (o.kind !== "inline") return "";
  const paren = o.start - 1 - (body[o.start - 1] === "<" ? 1 : 0);
  if (body[paren] !== "(" || body[paren - 1] !== "]") return "";
  const open = body.lastIndexOf("[", paren - 2);
  const text = open === -1 ? "" : body.slice(open + 1, paren - 1);
  return text.includes("\n") ? "" : clip(text, ANCHOR_TEXT_CHARS);
}

export const baseName = (path) => path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");

/**
 * Ask `resolveLink` for both answers at once: the path it computes for a
 * relative or rooted target, and the name it would look up for a bare one.
 * Reusing it keeps the basename and decoding rules identical to Phase 1.
 */
function classify(occurrence, fromPath) {
  let name = null;
  const spy = { get(n) { name = n; return undefined; } };
  const path = resolveLink(occurrence, fromPath, spy);
  return { path, name };
}

// Exported for project.js, which recovers a stored record's old memberships
// from its occurrences (the record does not store the set itself).
// `anchors` maps each `incoming:` and `bare:` membership to the posting
// entry's `{ texts, title }`; `targets` maps it to the note it points at
// (`{ path }`) or the name a bare link resolves late (`{ name }`).
export async function membershipsFor(path, occurrences, title = "") {
  const out = new Set([`names:${await nameHash(baseName(path))}`]);
  const externalReferences = [];
  const anchors = new Map();
  const targets = new Map();
  const note = (m, target, text) => {
    out.add(m);
    if (!targets.has(m)) targets.set(m, target);
    const entry = anchors.get(m) ?? { texts: [], title: typeof title === "string" ? title : "" };
    if (typeof text === "string" && text && !entry.texts.includes(text) && entry.texts.length < ANCHOR_TEXTS_PER_ENTRY) entry.texts.push(text);
    anchors.set(m, entry);
  };
  for (const o of occurrences) {
    if (o.kind === "definition") continue; // unsupported (arch 7.1)
    if (o.style === null) {
      const k = urlKey(o.target);
      if (k) {
        out.add(`urls:${await urlHash(k.key)}`);
        externalReferences.push({ key: k.key, version: k.version, start: o.start, end: o.end });
      }
      continue;
    }
    const { path: target, name } = classify(o, path);
    if (o.style === "bare") {
      if (name) note(`bare:${await nameHash(name)}`, { name }, o.text);
    } else if (target !== null && target.endsWith(".md")) {
      note(`incoming:${await pathHash(target)}`, { path: target }, o.text); // OPEN-5: .md targets only
    }
  }
  return { memberships: out, externalReferences, anchors, targets };
}

// The display texts and the title are part of the set: an alias or title edit
// is a new version, so the posting entries carrying them are rewritten and
// `validateEntry` rejects the stale ones.
async function referenceSetVersion(memberships, anchors, title) {
  const head = `${PARSER_VERSION}\n${RESOLVER_VERSION}\n${URL_KEY_VERSION}\n`;
  const lines = [...memberships].sort().map((m) => (anchors.has(m) ? `${m}\t${JSON.stringify(anchors.get(m).texts)}` : m));
  return sha256Hex(`${head}${lines.join("\n")}\ntitle\t${JSON.stringify(title)}`);
}

/** Largest document-order prefix of occurrences whose record fits the cap (OPEN-7). */
function fitToCap(record) {
  const fits = (k) => {
    const cut = k < record.occurrences.length ? record.occurrences[k].start : Infinity;
    return !exceedsUtf8Bytes(serializeNode({
      ...record,
      occurrences: record.occurrences.slice(0, k),
      externalReferences: record.externalReferences.filter((e) => e.start < cut),
    }), GRAPH_RECORD_BYTE_CAP);
  };
  if (fits(record.occurrences.length)) return record;
  let lo = 0;
  let hi = record.occurrences.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  const cut = record.occurrences[lo].start;
  return {
    ...record,
    coverage: "partial",
    occurrences: record.occurrences.slice(0, lo),
    externalReferences: record.externalReferences.filter((e) => e.start < cut),
  };
}

/**
 * `{ record, memberships, anchors, targets }` for one note. An encrypted body
 * (OPEN-18) yields `excluded`, nothing else, and no memberships, not even
 * `names/`, no title and no display text.
 */
export async function buildNodeRecord(path, body, version, { now }) {
  const encrypted = isEncryptedNote(body);
  const occurrences = [];
  for (const o of encrypted ? [] : extractReferences(body)) {
    const text = displayText(body, o);
    occurrences.push(text ? { ...o, text } : o);
  }
  const title = encrypted ? "" : clip(extractFields(path, body).title, ANCHOR_TITLE_CHARS);
  const { memberships, externalReferences, anchors, targets } = encrypted
    ? { memberships: new Set(), externalReferences: [], anchors: new Map(), targets: new Map() }
    : await membershipsFor(path, occurrences, title);
  const record = fitToCap({
    formatVersion: GRAPH_FORMAT_VERSION,
    path,
    observedSourceVersion: version,
    observedAt: now,
    parserVersion: PARSER_VERSION,
    resolverVersion: RESOLVER_VERSION,
    urlKeyVersion: URL_KEY_VERSION,
    referenceSetVersion: await referenceSetVersion(memberships, anchors, title),
    ...(!encrypted && { title }),
    occurrences,
    externalReferences,
    coverage: encrypted ? "excluded" : "complete",
    reverseRepair: [],
  });
  return { record, memberships, anchors, targets };
}
