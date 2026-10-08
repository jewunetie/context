/**
 * Synthetic, deterministic benchmark corpora with judged queries
 * (docs/design/link-graph/PLAN.md, Phase 0).
 *
 * `generateCorpus({ size, seed })` returns `{ notes, queries }`:
 *
 * - `notes`: `{ path, text, visibility }`, `visibility` being "private" or
 *   "team". Exactly `size` notes.
 * - `queries`: `{ query, relevant, kind }`, `relevant` being the paths a
 *   correct search returns. `kind` is the query class the per-class table in
 *   BASELINE.md groups by.
 *
 * The judged notes are a fixed set planted into every size, so the same
 * questions are asked of 100, 1,000 and 10,000 notes and only the haystack
 * grows. Filler is drawn from made-up words (`fz` plus a number) that no query
 * uses, so a filler note is never accidentally relevant.
 *
 * `generateHeldOut({ size, seed })` is the held-out set (Task 37, ruling
 * OPEN-64): the same classes with different planted words, frozen before any
 * tuning, plus two classes seed 1 lacks (OPEN-65): `linked` (note A holds the
 * term and links note B, which does not; both are relevant) and `crosschunk`
 * (two words in one long note more than the largest chunk apart, with one-word
 * decoys as `multi` has, so ranking shows a per-chunk coverage penalty and not
 * just recall). Its code class includes an acronym-led identifier
 * (`HTTPServer` queried as `server`, OPEN-50). Constants may be compared on
 * seed 1; a switch decision is made on this set only.
 *
 * Every value is fake, as everywhere else in this repository.
 */

import { renderChannelDayNote } from "../../../packages/communications/src/note.js";

/** xorshift32: the same seed gives the same corpus, with no dependency. */
function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x;
  };
}

const FILLER_VOCABULARY = 5_000;

function filler(next, words) {
  const out = [];
  for (let i = 0; i < words; i += 1) out.push(`fz${next() % FILLER_VOCABULARY}`);
  return out.join(" ");
}

/** A body of `chars` characters at least, split into paragraphs. */
function longFiller(next, chars) {
  const paragraphs = [];
  let length = 0;
  while (length < chars) {
    const paragraph = filler(next, 60);
    paragraphs.push(paragraph);
    length += paragraph.length + 2;
  }
  return paragraphs.join("\n\n");
}

/**
 * Word families for the morphology class: the note uses some forms, the query
 * another, so only a stemmer (or a lucky prefix) connects them. Each family's
 * words appear nowhere else in the corpus.
 */
const FAMILIES = [
  { note: ["deployed the gateway", "deployment window"], query: "deploying" },
  { note: ["connected accounts", "a connection pool"], query: "connecting" },
  { note: ["argued for retention", "the argument stands"], query: "arguing" },
  { note: ["generous quota", "their generosity"], query: "generously" },
  { note: ["migrated buckets", "migrations ran"], query: "migrating" },
  { note: ["happily accepted", "happiness metric"], query: "happy" },
  { note: ["relational schema", "relations table"], query: "relationship" },
  { note: ["archived folders", "archives grow"], query: "archiving" },
];

const CJK = [
  { text: "数据库迁移计划已经确认，下周开始执行。", query: "迁移", lang: "zh" },
  { text: "我们明天开会讨论搜索质量。", query: "搜索", lang: "zh" },
  { text: "東京の会議メモを共有します。", query: "会議", lang: "ja" },
  { text: "来週のリリース計画を確認してください。", query: "リリース", lang: "ja" },
];

const CODE = [
  { text: "Call `fetchUserProfile(userId)` before rendering.", query: "user profile" },
  { text: "The column `invoice_total_cents` is an integer.", query: "invoice total" },
  { text: "Set `MAX_RETRY_COUNT` to three in the worker.", query: "retry count" },
  { text: "`parseHttpHeader` rejects folded lines.", query: "http header" },
];

/** The held-out set's words: no query word is shared with the tables above. */
const FAMILIES_HELDOUT = [
  { note: ["calibrated the sensor", "a calibration run"], query: "calibrating" },
  { note: ["negotiated terms", "negotiations stalled"], query: "negotiating" },
  { note: ["optimized the loop", "an optimization pass"], query: "optimizing" },
  { note: ["compressed images", "the compression ratio"], query: "compressing" },
  { note: ["validated inputs", "validation errors"], query: "validating" },
  { note: ["scheduled jobs", "schedules slip"], query: "scheduling" },
  { note: ["cheerfully agreed", "a cheerfulness score"], query: "cheerful" },
  { note: ["predicted demand", "predictions held"], query: "predicting" },
];

const CJK_HELDOUT = [
  { text: "服务器备份每天凌晨运行。", query: "备份", lang: "zh" },
  { text: "请把预算报告发给财务部。", query: "预算", lang: "zh" },
  { text: "大阪の出張報告を書きました。", query: "出張", lang: "ja" },
  { text: "新しいデザインを検討しています。", query: "デザイン", lang: "ja" },
];

const CODE_HELDOUT = [
  { text: "Call `loadInventoryItems(storeId)` on start.", query: "inventory items" },
  { text: "The column `shipping_address_line` is text.", query: "shipping address" },
  { text: "Set `CACHE_TTL_SECONDS` in the worker config.", query: "cache ttl" },
  { text: "`HTTPServer` closes idle sockets.", query: "server" },
];

const SEED_ONE = { tag: "qz", families: FAMILIES, cjk: CJK, code: CODE };
const HELD_OUT = { tag: "qx", families: FAMILIES_HELDOUT, cjk: CJK_HELDOUT, code: CODE_HELDOUT };

const pad = (n, width = 5) => String(n).padStart(width, "0");

/**
 * The judged notes. Each entry is `{ note, query }`, where `note` is either one
 * note or several and `query.relevant` names the paths that answer it.
 */
function judged(next, { tag, families, cjk, code }) {
  const Tag = tag[0].toUpperCase() + tag.slice(1);
  const planted = [];
  const plant = (notes, query, relevant, kind) => planted.push({ notes, query: { query, relevant, kind } });

  // exact: a rare term near the top of an ordinary note.
  for (let i = 0; i < 8; i += 1) {
    const path = `1-projects/exact-${i}.md`;
    plant([{ path, text: `# Exact ${i}\n\nThe codename is ${tag}exact${i}. ${filler(next, 120)}\n` }], `${tag}exact${i}`, [path], "exact");
  }

  // title: the term is in the title only.
  for (let i = 0; i < 4; i += 1) {
    const path = `2-areas/title-${i}.md`;
    plant([{ path, text: `# ${Tag}title${i} review\n\n${filler(next, 150)}\n` }], `${tag}title${i}`, [path], "title");
  }

  // deep: the term sits past the R2 index's 2,048-character cap; two of them
  // past 64,000 characters, the new projection cap.
  for (let i = 0; i < 6; i += 1) {
    const path = `3-resources/deep-${i}.md`;
    const before = longFiller(next, i < 4 ? 3_000 + i * 2_000 : 66_000);
    plant([{ path, text: `# Deep ${i}\n\n${before}\n\nThe answer is ${tag}deep${i}.\n` }], `${tag}deep${i}`, [path], "deep");
  }

  // multi: two words that occur together in one note and alone in decoys.
  for (let i = 0; i < 4; i += 1) {
    const both = `1-projects/multi-${i}.md`;
    plant(
      [
        { path: both, text: `# Multi ${i}\n\n${tag}alpha${i} and ${tag}beta${i} meet here. ${filler(next, 100)}\n` },
        { path: `1-projects/multi-${i}-a.md`, text: `# Decoy A ${i}\n\nonly ${tag}alpha${i}. ${filler(next, 100)}\n` },
        { path: `1-projects/multi-${i}-b.md`, text: `# Decoy B ${i}\n\nonly ${tag}beta${i}. ${filler(next, 100)}\n` },
      ],
      `${tag}alpha${i} ${tag}beta${i}`,
      [both],
      "multi"
    );
  }

  // morph: the query is a form of the word the note never uses.
  families.forEach((family, i) => {
    const paths = family.note.map((_, j) => `2-areas/morph-${i}-${j}.md`);
    plant(
      family.note.map((phrase, j) => ({ path: paths[j], text: `# Morph ${i}.${j}\n\nWe ${phrase}. ${filler(next, 120)}\n` })),
      family.query,
      paths,
      "morph"
    );
  });

  // cjk: the query is a word inside an unspaced run.
  cjk.forEach((entry, i) => {
    const path = `0-inbox/cjk-${entry.lang}-${i}.md`;
    plant([{ path, text: `# CJK ${i}\n\n${entry.text}\n\n${filler(next, 40)}\n` }], entry.query, [path], "cjk");
  });

  // code: the query names the parts of an identifier.
  code.forEach((entry, i) => {
    const path = `1-projects/code-${i}.md`;
    plant([{ path, text: `# Code ${i}\n\n${entry.text}\n\n${filler(next, 100)}\n` }], entry.query, [path], "code");
  });

  // message: a term in the last message of a long channel-day note.
  for (let i = 0; i < 3; i += 1) {
    const date = `2026-03-${String(i + 1).padStart(2, "0")}`;
    const path = `0-inbox/email/name-at-example-com/${date}.md`;
    const events = [];
    for (let m = 0; m < 40; m += 1) {
      events.push({
        channel: "email",
        account: "name-at-example-com",
        messageId: `<b${i}m${m}@mail.example.net>`,
        threadId: `t${i}-${m % 5}`,
        sentAt: `${date}T08:${String(m).padStart(2, "0")}:00.000Z`,
        subject: `Update ${m}`,
        from: { name: "Ada Example", address: "ada@example.net" },
        to: [{ address: "name@example.com" }],
        body: `${filler(next, 80)}${m === 39 ? ` ${tag}message${i}` : ""}`,
        attachments: [],
      });
    }
    const text = renderChannelDayNote({
      channel: "email",
      account: "name-at-example-com",
      address: "name@example.com",
      date,
      nonce: "0123456789abcdef",
      now: `${date}T18:00:00.000Z`,
      events,
    });
    plant([{ path, text }], `${tag}message${i}`, [path], "message");
  }

  return planted;
}

/**
 * Filler that still has the shapes later phases care about: duplicate
 * basenames across folders, and hub notes many others link to.
 */
function fillerNote(next, i) {
  const folder = ["1-projects", "2-areas", "3-resources", "0-inbox"][i % 4];
  const base = i % 10 === 0 ? `meeting-${i % 50}` : `note-${pad(i)}`;
  const link = i % 7 === 0 ? `\n\nSee [[hub-${i % 5}]].` : "";
  return { path: `${folder}/${i % 10 === 0 ? `sub-${i % 3}/` : ""}${base}.md`, text: `# Note ${i}\n\n${filler(next, 120)}${link}\n` };
}

/** The held-out set's two link-shaped classes (ruling OPEN-65). */
function linkShaped(next, tag) {
  const planted = [];
  // linked: A holds the term and links B by a basename nothing else has.
  for (let i = 0; i < 4; i += 1) {
    const a = `1-projects/linked-${i}.md`;
    const b = `2-areas/${tag}target-${i}.md`;
    planted.push({
      notes: [
        { path: a, text: `# Linked ${i}\n\nThe ${tag}linked${i} plan. See [[${tag}target-${i}]]. ${filler(next, 100)}\n` },
        { path: b, text: `# Target ${i}\n\n${filler(next, 120)}\n` },
      ],
      query: { query: `${tag}linked${i}`, relevant: [a, b], kind: "linked" },
    });
  }
  // crosschunk: two words more than 6,000 characters (the largest chunk max) apart.
  for (let i = 0; i < 3; i += 1) {
    const both = `3-resources/cross-${i}.md`;
    planted.push({
      notes: [
        { path: both, text: `# Cross ${i}\n\nFirst ${tag}crossa${i}.\n\n${longFiller(next, 7_000)}\n\nThen ${tag}crossb${i}.\n` },
        { path: `3-resources/cross-${i}-a.md`, text: `# Cross decoy A ${i}\n\nonly ${tag}crossa${i}. ${filler(next, 100)}\n` },
        { path: `3-resources/cross-${i}-b.md`, text: `# Cross decoy B ${i}\n\nonly ${tag}crossb${i}. ${filler(next, 100)}\n` },
      ],
      query: { query: `${tag}crossa${i} ${tag}crossb${i}`, relevant: [both], kind: "crosschunk" },
    });
  }
  return planted;
}

/**
 * The link-heavy set (`--set links`): classes where links decide the answer,
 * or must not. Every basename is `ql-...`, unique, so a bare link names one
 * note; the tag `ql` is shared with neither seed 1 (`qz`) nor the held-out set.
 */
function linkHeavy(next) {
  const planted = [];
  const plant = (notes, query, relevant, kind) => planted.push({ notes, query: { query, relevant, kind } });
  const note = (path, title, body) => ({ path, text: `# ${title}\n\n${body} ${filler(next, 80)}\n` });

  // cluster: an index note and 9 members linking each other; 3 of 10 hold the term, all are relevant.
  for (let i = 0; i < 4; i += 1) {
    const names = Array.from({ length: 10 }, (_, j) => `ql-cluster-${i}-${j}`);
    const notes = names.map((name, j) => {
      const links = j === 0 ? names.slice(1) : [names[0], names[j === 9 ? 1 : j + 1]];
      const term = j < 3 ? `The qlcluster${i} effort. ` : "";
      return note(`1-projects/${name}.md`, `Cluster ${i}.${j}`, `${term}${links.map((n) => `[[${n}]]`).join(" ")}.`);
    });
    plant(notes, `qlcluster${i}`, notes.map((n) => n.path), "cluster");
  }

  // partial: one note holds both words, 30 decoys hold one of them.
  for (let i = 0; i < 4; i += 1) {
    const both = `2-areas/ql-partial-${i}.md`;
    const decoys = Array.from({ length: 30 }, (_, j) =>
      note(`2-areas/ql-partial-${i}-d${j}.md`, `Partial decoy ${i}.${j}`, `only qlpart${j % 2 ? "b" : "a"}${i}.`));
    plant([note(both, `Partial ${i}`, `qlparta${i} meets qlpartb${i}.`), ...decoys], `qlparta${i} qlpartb${i}`, [both], "partial");
  }

  // harm: ten notes hold the term (lexical top 10 is exactly right); each links three that do not.
  for (let i = 0; i < 4; i += 1) {
    const notes = [];
    const relevant = [];
    for (let j = 0; j < 10; j += 1) {
      const away = [0, 1, 2].map((k) => `ql-harm-${i}-${j}-n${k}`);
      relevant.push(`3-resources/ql-harm-${i}-${j}.md`);
      notes.push(note(relevant[j], `Harm ${i}.${j}`, `About qlharm${i}. ${away.map((n) => `[[${n}]]`).join(" ")}.`));
      for (const name of away) notes.push(note(`3-resources/${name}.md`, `Unrelated ${name}`, "Unrelated."));
    }
    plant(notes, `qlharm${i}`, relevant, "harm");
  }

  // alias: A links B under a codename only A's link text carries; the query is the codename.
  for (let i = 0; i < 4; i += 1) {
    const b = `2-areas/ql-alias-target-${i}.md`;
    plant(
      [note(`1-projects/ql-alias-${i}.md`, `Alias ${i}`, `Kickoff for [[ql-alias-target-${i}|qlcodename${i}]].`), note(b, `Alias target ${i}`, "The plan itself.")],
      `qlcodename${i}`,
      [b],
      "alias"
    );
  }

  // url: two notes cite one URL; only the first holds the term.
  for (let i = 0; i < 4; i += 1) {
    const url = `https://spec.example.com/ql-${i}`;
    const a = `3-resources/ql-url-${i}-a.md`;
    const b = `3-resources/ql-url-${i}-b.md`;
    plant([note(a, `URL ${i} A`, `qlurl${i} spec: ${url}`), note(b, `URL ${i} B`, `Read ${url} first.`)], `qlurl${i}`, [a, b], "url");
  }

  // hub: three notes hold the term and link a fourth and a hub with 120 other links in.
  const hubs = ["ql-bighub-0", "ql-bighub-1"];
  const spokes = Array.from({ length: 120 }, (_, j) => note(`0-inbox/ql-spoke-${j}.md`, `Spoke ${j}`, `See [[${hubs[j % 2]}]].`));
  const hubNotes = hubs.map((name) => note(`3-resources/${name}.md`, `Big hub ${name}`, "Everything."));
  for (let i = 0; i < 4; i += 1) {
    const fourth = `2-areas/ql-hub-${i}-shared.md`;
    const holders = [0, 1, 2].map((j) => `2-areas/ql-hub-${i}-${j}.md`);
    const notes = holders.map((path, j) =>
      note(path, `Hub ${i}.${j}`, `qlhub${i} work. [[ql-hub-${i}-shared]] [[${hubs[i % 2]}]].`));
    notes.push(note(fourth, `Hub ${i} shared`, "Shared design."));
    if (i === 0) notes.push(...hubNotes, ...spokes);
    plant(notes, `qlhub${i}`, [...holders, fourth], "hub");
  }
  return planted;
}

/** The link-heavy set (`--set links`); needs 500 notes or more. @param {{ size: number, seed?: number }} options */
export function generateLinks({ size, seed = 3 }) {
  const next = rng(seed);
  return assemble(next, linkHeavy(next), size);
}

/** @param {{ size: number, seed?: number }} options */
export function generateCorpus({ size, seed = 1 }) {
  const next = rng(seed);
  return assemble(next, judged(next, SEED_ONE), size);
}

/** @param {{ size: number, seed?: number }} options */
export function generateHeldOut({ size, seed = 2 }) {
  const next = rng(seed);
  return assemble(next, [...judged(next, HELD_OUT), ...linkShaped(next, HELD_OUT.tag)], size);
}

function assemble(next, planted, size) {
  const notes = planted.flatMap((entry) => entry.notes);
  if (notes.length > size) throw new Error(`size ${size} is smaller than the ${notes.length} judged notes`);

  for (let h = 0; h < 5 && notes.length < size; h += 1) {
    notes.push({ path: `3-resources/hub-${h}.md`, text: `# Hub ${h}\n\n${filler(next, 80)}\n` });
  }
  const taken = new Set(notes.map((note) => note.path));
  for (let i = 0; notes.length < size; i += 1) {
    const note = fillerNote(next, i);
    if (!taken.has(note.path)) {
      taken.add(note.path);
      notes.push(note);
    }
  }

  // Mixed visibility, decided by position so it is deterministic: one note in
  // three is private.
  notes.forEach((note, i) => {
    note.visibility = i % 3 === 0 ? "private" : "team";
  });
  return { notes, queries: planted.map((entry) => entry.query) };
}
