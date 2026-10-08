/**
 * The search baseline (docs/design/link-graph/PLAN.md, Phase 0): today's
 * bucket search (B0) and the Fast Search projection (B5) over the same
 * synthetic corpus and judged queries.
 *
 * **Not part of `pnpm test`.** It builds a 10,000-note index and waits on
 * injected store latency, which is minutes rather than a suite check. The
 * arithmetic it rests on is checked in `test/benchHarness.test.mjs`.
 *
 *   pnpm --filter @context/mcp bench:search                    # 100 and 1,000 notes
 *   pnpm --filter @context/mcp bench:search -- --sizes 10000
 *   pnpm --filter @context/mcp bench:search -- --latency 20 --d1-latency 60
 *   pnpm --filter @context/mcp bench:search -- --census ~/notes
 *   pnpm --filter @context/mcp bench:search -- --set heldout --engines B0,B1:c1000,B1,B1:c4000,B1:tok2,B2,B3,B4,B5
 *
 * Arms (`--engines`, default `B0,B5`; Task 37, ruling OPEN-75): B0 and B5 as
 * below; B1 is the v3 format at `--format tok1|tok2` (default tok1) and
 * `--chunk 0|1000|2000|4000` (default 2000), with `--graph off|b2|b3|b4`
 * (default off) as its graph variant; B2, B3 and B4 are B1's lexical format
 * with that graph variant. B6 is B1 at tok2 c1000 with anchor text
 * (SEARCH_ANCHOR_TEXT): the graph is built first, then the v3 index reads it,
 * and queries are lexical. B7 is B6 plus the "ppr" graph variant (personalized
 * PageRank, src/graph/ppr.js). The costs table counts graph-only notes (no
 * lexical match) in the top 10 of the graph arms: all, judged relevant, and
 * the number of queries with any. An arm may override the lexical flags for itself,
 * `B1:c1000` or `B2:tok2:c4000`, so one run can hold the whole matrix. Chunk 0
 * with tok1 is the default format, built in the v3 namespace (`format.js`'s
 * bench hook) so B1 is always a v3 index. `--set judged|heldout|links|hotpot`
 * picks seed 1 (BASELINE.md), the held-out set (`generateHeldOut`, ruling
 * OPEN-64), the synthetic link-heavy set (`generateLinks`) or the HotpotQA
 * slice `bench/hotpot.mjs --build` wrote to its cache (`--sizes` is ignored
 * for it). Recall and nDCG are printed per query class.
 * Engines are built in `engines.mjs`.
 *
 * Per arm the run also prints the index costs: build passes (and graph
 * passes), shard count, index bytes (manifest, docmap and the shards it
 * names), notes shed, oversized shards, notes reported partial, the
 * chunk-size distribution of what the writer indexed, and subrequests per
 * query (mean, max, and queries over the free tier's 50 and the hosted 600,
 * DELIVERY 16.3). Subrequests are measured at `--budget` (600) only: a run at
 * 50 would change the answers, not only the count. A v3 build logs one
 * `search-index-format` JSON line per pass (`revisions.js`); `grep -v
 * '^{"event"'` leaves the tables.
 *
 * B0 runs the real `syncShardedIndex` and `searchIndexedNotes` against an
 * in-memory bucket that sleeps `--latency` ms per operation. B5 runs the real
 * projection SQL (`project.js`, `query.js`, `serve.js`) against `node:sqlite`,
 * which ships the FTS5 D1 runs, with a client that sleeps `--d1-latency` ms per
 * request. Both latencies are assumptions until replaced by staging numbers.
 *
 * Neither engine caches anything between queries in one isolate, so "cold" is
 * each query's first run and "warm" its second: the difference is the
 * JavaScript engine warming up, not a cache.
 *
 * `--census <dir>` counts the Markdown files under a local folder by the
 * scripts they use. It reads files and prints counts; nothing leaves the
 * machine.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { indexFormatFor } from "../src/search/format.js";
import { buildB5, buildBucketEngine } from "./engines.mjs";
import { generateCorpus, generateHeldOut, generateLinks } from "./fixtures.js";
import { loadHotpot } from "./hotpot.mjs";
import { mean, ndcgAt, percentile, recallAt, reciprocalRank } from "./metrics.js";

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 || at === process.argv.length - 1 ? fallback : process.argv[at + 1];
}

/* -- arms ---------------------------------------------------------------- */

const GRAPH_ARMS = { B2: "b2", B3: "b3", B4: "b4", B7: "ppr" };

/** `B1:tok2:c1000` and the flag defaults to `{ name, label, format, graph }`. */
function parseArm(spec, defaults) {
  const [name, ...overrides] = spec.split(":");
  if (name === "B0") return { name, label: "B0 bucket search" };
  if (name === "B5") return { name, label: "B5 Fast Search" };
  if (name !== "B1" && name !== "B6" && !GRAPH_ARMS[name]) throw new Error(`unknown engine ${spec}`);
  // B6: B1 tok2 c1000 with anchor text (SEARCH_ANCHOR_TEXT, src/search/anchors.js), lexical query.
  // B7: B6 plus the personalized PageRank graph variant (graph built as for B2).
  const anchored = name === "B6" || name === "B7";
  let { tok, chunk } = anchored ? { tok: "tok2", chunk: "1000" } : defaults;
  for (const part of overrides) {
    if (/^tok[12]$/.test(part)) tok = part;
    else if (/^c(0|1000|2000|4000)$/.test(part)) chunk = part.slice(1);
    else throw new Error(`unknown override ${part} in ${spec}`);
  }
  const graph = GRAPH_ARMS[name] ?? (defaults.graph === "off" || name === "B6" ? null : defaults.graph);
  if (graph !== null && !["b2", "b3", "b4", "ppr"].includes(graph)) throw new Error(`unknown graph variant ${graph}`);
  const anchors = anchored ? { SEARCH_ANCHOR_TEXT: "1" } : {};
  const format = { ...indexFormatFor({ SEARCH_TOKENIZER: tok.slice(3), SEARCH_CHUNK_CHARS: chunk, ...anchors }), namespace: "v3" };
  return { name, label: `${name} ${tok} c${chunk}${graph ? ` ${graph}` : ""}${anchored ? " anchors" : ""}`, format, graph };
}

/* -- scoring ------------------------------------------------------------- */

const K = 10;

async function score(engine, queries) {
  const rows = [];
  for (const run of ["cold", "warm"]) {
    for (const [i, query] of queries.entries()) {
      const started = performance.now();
      const answer = await engine.search(query.query);
      const ms = performance.now() - started;
      // A message hit names its sub-document (`path#anchor`); the note is the unit judged.
      const ranked = [...new Set(answer.paths.map((path) => path.split("#")[0]))];
      if (run === "cold") {
        rows[i] = {
          kind: query.kind,
          recall: recallAt(ranked, query.relevant, K),
          ndcg: ndcgAt(ranked, query.relevant, K),
          rr: reciprocalRank(ranked, query.relevant),
          subrequests: answer.subrequests,
          linked: (answer.linked ?? []).length,
          linkedRelevant: (answer.linked ?? []).filter((path) => new Set(query.relevant).has(path.split("#")[0])).length,
          cold: ms,
        };
      } else {
        rows[i].warm = ms;
      }
    }
  }
  return rows;
}

function summarize(rows) {
  const pick = (field) => rows.map((row) => row[field]);
  return {
    recall: mean(pick("recall")),
    ndcg: mean(pick("ndcg")),
    mrr: mean(pick("rr")),
    cold: [50, 95, 99].map((p) => percentile(pick("cold"), p)),
    warm: [50, 95, 99].map((p) => percentile(pick("warm"), p)),
    subrequests: mean(pick("subrequests")),
  };
}

const f2 = (value) => value.toFixed(2);
const sum = (values) => values.reduce((total, value) => total + value, 0);
const ms = (values) => values.map((value) => Math.round(value)).join(" / ");

function printTable(size, results) {
  console.log(`\n### ${size.toLocaleString("en-US")} notes\n`);
  console.log("| Engine | Recall@10 | nDCG@10 | MRR | Cold p50 / p95 / p99 ms | Warm p50 / p95 / p99 ms | Subrequests per query |");
  console.log("|---|---|---|---|---|---|---|");
  for (const [name, rows] of results) {
    const s = summarize(rows);
    console.log(`| ${name} | ${f2(s.recall)} | ${f2(s.ndcg)} | ${f2(s.mrr)} | ${ms(s.cold)} | ${ms(s.warm)} | ${f2(s.subrequests)} |`);
  }
  const kinds = [...new Set(results[0][1].map((row) => row.kind))];
  for (const [field, title] of [["recall", "Recall@10"], ["ndcg", "nDCG@10"], ["rr", "MRR"]]) {
    console.log(`\n${title} by query class:\n`);
    console.log(`| Class | ${results.map(([name]) => name).join(" | ")} |`);
    console.log(`|---|${results.map(() => "---").join("|")}|`);
    for (const kind of kinds) {
      const cells = results.map(([, rows]) => f2(mean(rows.filter((row) => row.kind === kind).map((row) => row[field]))));
      console.log(`| ${kind} | ${cells.join(" | ")} |`);
    }
  }
}

function printCosts(built, results) {
  console.log(`\nIndex costs per arm:\n`);
  console.log("| Arm | Build passes | Graph passes | Shards | Index bytes | Shed notes | Oversized shards | Partial notes | Docs | Doc chars p50 / p95 / max | Subrequests mean / max | Over 50 | Over 600 | Graph withheld | Graph-only in top 10 (total / relevant / queries) |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  built.forEach(([arm, engine], i) => {
    const subrequests = results[i][1].map((row) => row.subrequests);
    const over = (ceiling) => subrequests.filter((n) => n > ceiling).length;
    const sub = `${f2(mean(subrequests))} / ${Math.max(...subrequests)}`;
    const rows = results[i][1];
    const linked = arm.graph ? `${sum(rows.map((row) => row.linked))} / ${sum(rows.map((row) => row.linkedRelevant))} / ${rows.filter((row) => row.linked > 0).length}` : "-";
    if (!engine.costs) {
      console.log(`| ${arm.label} | - | - | - | - | - | - | - | - | - | ${sub} | ${over(50)} | ${over(600)} | - | - |`);
      return;
    }
    const { shards, bytes, shed, partial, oversizedShards } = engine.costs;
    const { docs, p50, p95, max } = engine.chunks;
    const graph = engine.graphPasses ?? "-";
    const withheld = engine.graphPasses ? engine.graphIncomplete : "-";
    console.log(`| ${arm.label} | ${engine.passes} | ${graph} | ${shards} | ${bytes.toLocaleString("en-US")} | ${shed} | ${oversizedShards} | ${partial} | ${docs} | ${p50} / ${p95} / ${max} | ${sub} | ${over(50)} | ${over(600)} | ${withheld} | ${linked} |`);
  });
}

/* -- census -------------------------------------------------------------- */

const SCRIPTS = ["Latin", "Han", "Hiragana", "Katakana", "Hangul", "Thai", "Cyrillic", "Arabic", "Hebrew", "Devanagari", "Greek"];
const SCRIPT_RES = SCRIPTS.map((script) => [script, new RegExp(`\\p{Script=${script}}`, "u")]);

function* markdownFiles(dir) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* markdownFiles(path);
    else if (name.endsWith(".md")) yield path;
  }
}

/** Files that use each script at least once. A file can count under several. */
export function census(texts) {
  const counts = Object.fromEntries(SCRIPTS.map((script) => [script, 0]));
  let files = 0;
  for (const text of texts) {
    files += 1;
    for (const [script, re] of SCRIPT_RES) if (re.test(text)) counts[script] += 1;
  }
  return { files, counts };
}

function printCensus(label, result) {
  const used = Object.entries(result.counts).filter(([, count]) => count > 0);
  console.log(`\nScript census, ${label}: ${result.files} files; ${used.map(([s, c]) => `${s} ${c}`).join(", ")}`);
}

/* -- main ---------------------------------------------------------------- */

const latency = Number(arg("latency", 20));
const d1Latency = Number(arg("d1-latency", 20));
const budget = Number(arg("budget", 600));
const sizes = String(arg("sizes", "100,1000")).split(",").map(Number);
const censusDir = arg("census", null);
const set = arg("set", "judged");
const defaults = { tok: arg("format", "tok1"), chunk: String(arg("chunk", "2000")), graph: arg("graph", "off") };
const arms = String(arg("engines", "B0,B5")).split(",").map((spec) => parseArm(spec, defaults));
if (!["judged", "heldout", "links", "hotpot"].includes(set)) throw new Error(`unknown set ${set}`);
if (!/^tok[12]$/.test(defaults.tok)) throw new Error(`unknown format ${defaults.tok}`);

if (censusDir) {
  printCensus(censusDir, census((function* () {
    for (const path of markdownFiles(censusDir)) yield readFileSync(path, "utf8");
  })()));
} else {
  console.log(`Store latency ${latency} ms per operation (B0), ${d1Latency} ms per request (B5), budget ${budget}. Set: ${set}.`);
  const generate = { judged: generateCorpus, heldout: generateHeldOut, links: generateLinks, hotpot: loadHotpot }[set];
  // The HotpotQA slice has one size, set when it was built (bench/hotpot.mjs).
  for (const size of set === "hotpot" ? [loadHotpot().notes.length] : sizes) {
    const { notes, queries } = generate({ size });
    const results = [];
    const built = [];
    for (const arm of arms) {
      const engine = arm.name === "B5"
        ? buildB5(notes, d1Latency, budget)
        : await buildBucketEngine(notes, { latency, budget, format: arm.format ?? null, graph: arm.graph ?? null });
      results.push([arm.label, await score(engine, queries)]);
      built.push([arm, engine]);
    }
    printTable(size, results);
    printCosts(built, results);
    const b0 = built.find(([arm]) => arm.name === "B0");
    if (b0) console.log(`\nB0 index built in ${b0[1].passes} passes. ${queries.length} judged queries.`);
    else console.log(`\n${queries.length} judged queries.`);
    printCensus(`${size} fixture notes`, census(notes.map((note) => note.text)));
  }
}
