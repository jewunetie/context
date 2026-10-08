/**
 * A link-heavy evaluation slice from BEIR HotpotQA (test qrels and queries)
 * and Wikipedia page intros fetched from the MediaWiki Action API.
 *
 *   node bench/hotpot.mjs --build            # fetch what the cache lacks, then build
 *   node bench/hotpot.mjs --build --offline  # build from the cache only
 *   node bench/run.mjs --set hotpot --engines B0,B1:tok2,B2
 *
 * Everything lives under `~/.cache/context-bench/hotpot` (or
 * `$CONTEXT_BENCH_CACHE/hotpot`), never in the repository: Wikipedia text is
 * CC BY-SA 4.0. Expected there before a build: `test.tsv` (BeIR/hotpotqa-qrels)
 * and `queries.parquet` (BeIR/hotpotqa), which is converted once to
 * `queries.jsonl` with `uv run --with pyarrow`. Every API response is cached by
 * its parameters, so a second build is offline and gives the same slice.
 *
 * Steps: take CANDIDATES test queries in sha256(id) order; fetch their gold
 * pages by page id (qrels name 2017 page ids; ids survive renames); add the
 * top NEGATIVES CirrusSearch hits for each question that are not gold (hard
 * negatives: lexical matches from all of Wikipedia); add gold outlinks (from
 * the intro) and inlinks (`list=backlinks`), round-robin by rank up to 5 each,
 * until CAP titles; fetch every intro (redirects resolved), resolve link
 * targets through redirects, and write `wiki/<Title>.md` notes whose links
 * leave out anything outside the slice. A query is dropped when a gold page is
 * missing, or when no gold page holds a query term and none is one link away
 * from a page that does. The rest are run through B0 and bucketed: `easy`
 * (both gold pages in B0's top 3), `partial` (a gold page in the top 10) and
 * `hard` (none); TARGET queries are kept, harder buckets first.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { buildBucketEngine } from "./engines.mjs";
import { linkTargets, wikitextToMarkdown } from "./wikitext.js";

export const CACHE = join(process.env.CONTEXT_BENCH_CACHE ?? join(homedir(), ".cache", "context-bench"), "hotpot");
export const SLICE = join(CACHE, "slice.json");

const CANDIDATES = 400;
const TARGET = 300;
const NEGATIVES = 3;
const NEIGHBOURS = 5;
const CAP = 5_000;
const API = "https://en.wikipedia.org/w/api.php";
const USER_AGENT = "context-bench/0.1 (https://github.com/Supa-Media/context; search benchmark, polite batch fetch)";
const GAP_MS = 350;

const sha = (text) => createHash("sha256").update(text).digest("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const chunks = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));
export const noteName = (title) => title.replace(/\//g, "-");

/* -- the API, cached by parameters ---------------------------------------- */

let offline = false;
let last = 0;

async function api(params) {
  const query = { action: "query", format: "json", formatversion: "2", ...params };
  const key = Object.keys(query).sort().map((k) => `${k}=${query[k]}`).join("&");
  const file = join(CACHE, "api", `${sha(key)}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  if (offline) throw new Error(`not cached (offline): ${key.slice(0, 200)}`);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await sleep(Math.max(0, last + GAP_MS - Date.now()));
    last = Date.now();
    const response = await fetch(API, {
      method: "POST",
      headers: { "user-agent": USER_AGENT, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...query, maxlag: "5" }),
    });
    const text = await response.text();
    const lagged = response.status === 429 || response.status >= 500 || text.includes('"code":"maxlag"');
    if (lagged) {
      await sleep(1000 * Number(response.headers.get("retry-after") ?? 5) * (attempt + 1));
      continue;
    }
    if (!response.ok) throw new Error(`${response.status} for ${key.slice(0, 200)}`);
    const body = JSON.parse(text);
    if (body.error) throw new Error(`${body.error.code}: ${body.error.info}`);
    mkdirSync(join(CACHE, "api"), { recursive: true });
    writeFileSync(file, text);
    return body;
  }
  throw new Error(`gave up on ${key.slice(0, 200)}`);
}

/** A `prop` query over many pages, following `continue` and merging pages, redirects and normalizations. */
async function pagesQuery(params) {
  const pages = new Map();
  const renamed = [];
  let next = {};
  do {
    const body = await api({ ...params, ...next });
    for (const page of body.query?.pages ?? []) {
      const seen = pages.get(page.title ?? page.pageid);
      pages.set(page.title ?? page.pageid, seen ? { ...seen, ...page, revisions: seen.revisions ?? page.revisions } : page);
    }
    renamed.push(...(body.query?.normalized ?? []), ...(body.query?.redirects ?? []));
    next = body.continue ?? null;
  } while (next);
  return { pages: [...pages.values()], renamed };
}

const content = (page) => page.revisions?.[0]?.slots?.main?.content ?? null;

/* -- inputs --------------------------------------------------------------- */

function loadQueries() {
  const qrels = new Map();
  for (const line of readFileSync(join(CACHE, "test.tsv"), "utf8").split("\n").slice(1)) {
    const [qid, pageid] = line.split("\t");
    if (qid) qrels.set(qid, [...(qrels.get(qid) ?? []), Number(pageid)]);
  }
  const jsonl = join(CACHE, "queries.jsonl");
  if (!existsSync(jsonl)) {
    const script = [
      "import json, pyarrow.parquet as pq",
      `ids = set(l.split('\\t')[0] for l in open(${JSON.stringify(join(CACHE, "test.tsv"))}).read().splitlines()[1:])`,
      `rows = pq.read_table(${JSON.stringify(join(CACHE, "queries.parquet"))}).to_pylist()`,
      `out = open(${JSON.stringify(jsonl)}, 'w')`,
      "[out.write(json.dumps({'id': r['_id'], 'text': r['text']}) + '\\n') for r in rows if r['_id'] in ids]",
    ].join("\n");
    execFileSync("uv", ["run", "--with", "pyarrow", "python", "-c", script], { stdio: "inherit" });
  }
  const text = new Map(readFileSync(jsonl, "utf8").trim().split("\n").map((line) => JSON.parse(line)).map((q) => [q.id, q.text]));
  return [...qrels.keys()]
    .map((id) => ({ id, question: text.get(id), gold: qrels.get(id) }))
    .filter((q) => q.question)
    .sort((a, b) => sha(a.id).localeCompare(sha(b.id)));
}

/* -- terms and reachability ----------------------------------------------- */

const STOP = new Set("the and was were are for what which who whom whose that this with from has have had did does when where how many much than then its his her their they them there into also both same other more most than been being not but nor any all one two".split(" "));
export const terms = (text) => new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= 3 && !STOP.has(w)));

/* -- build ---------------------------------------------------------------- */

async function build() {
  const all = loadQueries();
  const candidates = all.slice(0, CANDIDATES);

  // Gold pages by page id.
  const goldIds = [...new Set(candidates.flatMap((q) => q.gold))];
  const byId = new Map();
  for (const batch of chunks(goldIds, 50)) {
    const { pages } = await pagesQuery({ pageids: batch.join("|"), prop: "revisions", rvprop: "content", rvslots: "main", rvsection: "0" });
    for (const page of pages) if (!page.missing && page.ns === 0 && content(page) !== null) byId.set(page.pageid, page);
  }
  const live = candidates.filter((q) => q.gold.every((id) => byId.has(id)));
  const goldTitles = [...new Set(live.flatMap((q) => q.gold.map((id) => byId.get(id).title)))];
  const goldText = new Map([...byId.values()].map((page) => [page.title, content(page)]));

  // Hard negatives and neighbours, as ranked lists to take round-robin.
  const lists = [];
  for (const q of live) {
    const body = await api({ list: "search", srsearch: q.question, srnamespace: "0", srlimit: "10", srprop: "" }).catch(() => null);
    const gold = new Set(q.gold.map((id) => byId.get(id).title));
    lists.push({ kind: "negative", titles: (body?.query?.search ?? []).map((hit) => hit.title).filter((t) => !gold.has(t)).slice(0, NEGATIVES) });
  }
  for (const title of goldTitles) {
    lists.push({ kind: "out", titles: [...new Set(linkTargets(goldText.get(title)))].slice(0, NEIGHBOURS) });
    const body = await api({ list: "backlinks", bltitle: title, blnamespace: "0", blfilterredir: "nonredirects", bllimit: String(NEIGHBOURS) });
    lists.push({ kind: "in", titles: body.query.backlinks.map((b) => b.title) });
  }
  const wanted = new Set(goldTitles);
  for (const list of lists.filter((l) => l.kind === "negative")) for (const t of list.titles) if (wanted.size < CAP) wanted.add(t);
  for (let rank = 0; rank < NEIGHBOURS; rank += 1) {
    for (const list of lists.filter((l) => l.kind !== "negative")) if (list.titles[rank] && wanted.size < CAP) wanted.add(list.titles[rank]);
  }

  // Every intro, redirects resolved; then link targets resolved through redirects.
  const pages = new Map(goldTitles.map((t) => [t, goldText.get(t)]));
  const alias = new Map();
  for (const batch of chunks([...wanted].filter((t) => !pages.has(t)).sort(), 50)) {
    const { pages: got, renamed } = await pagesQuery({ titles: batch.join("|"), redirects: "1", prop: "revisions", rvprop: "content", rvslots: "main", rvsection: "0" });
    for (const { from, to } of renamed) alias.set(from, to);
    for (const page of got) if (!page.missing && page.ns === 0 && content(page) !== null && pages.size < CAP) pages.set(page.title, content(page));
  }
  const final = (t) => {
    for (let i = 0; i < 3 && alias.has(t); i += 1) t = alias.get(t);
    return t;
  };
  const unknown = new Set();
  for (const text of pages.values()) for (const t of linkTargets(text)) if (!pages.has(final(t))) unknown.add(t);
  for (const batch of chunks([...unknown].sort(), 50)) {
    const { renamed } = await pagesQuery({ titles: batch.join("|"), redirects: "1" });
    for (const { from, to } of renamed) alias.set(from, to);
  }

  // Notes. A sanitized name that collides is dropped (a bare link must name one note).
  const names = new Map();
  const taken = new Set();
  for (const title of [...pages.keys()].sort()) {
    if (taken.has(noteName(title))) continue;
    taken.add(noteName(title));
    names.set(title, noteName(title));
  }
  let total = 0;
  let kept = 0;
  const notes = [];
  const outgoing = new Map();
  for (const [title, name] of names) {
    const targets = new Set();
    const md = wikitextToMarkdown(pages.get(title), (t) => {
      const to = final(t);
      if (to === title || !names.has(to)) return null;
      targets.add(to);
      return names.get(to);
    });
    total += md.total;
    kept += md.kept;
    outgoing.set(title, targets);
    notes.push({ path: `wiki/${name}.md`, title, text: `# ${title}\n\n${md.body}\n` });
  }
  notes.forEach((note, i) => (note.visibility = i % 3 === 0 ? "private" : "team"));

  // Answerable: a gold page holds a query term, or links to or from a page that does.
  const noteTerms = new Map(notes.map((n) => [n.title, terms(n.text)]));
  const neighbours = new Map([...names.keys()].map((t) => [t, new Set(outgoing.get(t))]));
  for (const [from, targets] of outgoing) for (const to of targets) neighbours.get(to).add(from);
  const hits = (title, words) => [...words].some((w) => noteTerms.get(title)?.has(w));
  const reachable = (title, words) => hits(title, words) || [...(neighbours.get(title) ?? [])].some((n) => hits(n, words));
  const answerable = [];
  let unreachable = 0;
  let collided = 0;
  for (const q of live) {
    const gold = q.gold.map((id) => byId.get(id).title);
    if (!gold.every((t) => names.has(t))) {
      collided += 1;
      continue;
    }
    const words = terms(q.question);
    if (gold.some((t) => reachable(t, words))) answerable.push({ ...q, relevant: gold.map((t) => `wiki/${names.get(t)}.md`) });
    else unreachable += 1;
  }

  // Difficulty by B0, then keep the hardest TARGET.
  const engine = await buildBucketEngine(notes, { latency: 0, budget: 600 });
  const order = { hard: 0, partial: 1, easy: 2 };
  for (const q of answerable) {
    const ranked = [...new Set((await engine.search(q.question)).paths)];
    const top3 = q.relevant.every((p) => ranked.slice(0, 3).includes(p));
    q.kind = top3 ? "easy" : q.relevant.some((p) => ranked.slice(0, 10).includes(p)) ? "partial" : "hard";
  }
  const selected = [...answerable].sort((a, b) => order[a.kind] - order[b.kind]).slice(0, TARGET).sort((a, b) => sha(a.id).localeCompare(sha(b.id)));
  const count = (list) => Object.fromEntries(Object.keys(order).map((k) => [k, list.filter((q) => q.kind === k).length]));

  const apiDir = join(CACHE, "api");
  const stats = {
    candidates: candidates.length,
    droppedMissingGold: candidates.length - live.length,
    droppedNameCollision: collided,
    droppedUnreachable: unreachable,
    answerable: answerable.length,
    selected: selected.length,
    difficultyAnswerable: count(answerable),
    difficultySelected: count(selected),
    notes: notes.length,
    goldPages: goldTitles.length,
    links: total,
    linksKept: kept,
    linkKeptShare: Number((kept / total).toFixed(3)),
    meanKeptLinksPerNote: Number((kept / notes.length).toFixed(2)),
    apiResponses: readdirSync(apiDir).length,
    apiBytes: readdirSync(apiDir).reduce((sum, f) => sum + statSync(join(apiDir, f)).size, 0),
    corpusChars: notes.reduce((sum, n) => sum + n.text.length, 0),
  };
  const queries = selected.map((q) => ({ query: q.question, relevant: q.relevant, kind: q.kind, id: q.id }));
  writeFileSync(SLICE, JSON.stringify({ stats, notes: notes.map(({ path, text, visibility }) => ({ path, text, visibility })), queries }));
  console.log(JSON.stringify(stats, null, 2));
}

/** The built slice, for run.mjs. */
export function loadHotpot() {
  if (!existsSync(SLICE)) throw new Error(`no HotpotQA slice at ${SLICE}: run node bench/hotpot.mjs --build`);
  return JSON.parse(readFileSync(SLICE, "utf8"));
}

if (process.argv[1]?.endsWith("hotpot.mjs") && process.argv.includes("--build")) {
  offline = process.argv.includes("--offline");
  await build();
}
