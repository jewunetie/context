/**
 * Changed-section detection for post-write link suggestions
 * (`src/graph/changes.js`, AGENT-LINKS 13.4, TASKS-PHASE-3-4 Task 21).
 *
 * Every result is checked against the one invariant callers rely on: a
 * section's `text` is exactly `committed.slice(start, end)`, in JavaScript
 * string offsets.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing tests in this
 * file.
 *
 *   intervals end at the next heading of any depth      1 (nested)
 *   link markup not reduced to its visible text         2 (link-wrap, link-only)
 *   reflow hunks not dropped                            1 (whitespace)
 *   code not masked                                     2 (new, code)
 *   frontmatter lines given comparison keys             1 (frontmatter)
 *   closing-hash regex /[ \t]+#+[ \t]*$/ restored        1 (heading of spaces, 189 s; bound 2 s)
 *   closing hashes stripped without a space before      1 (heading of spaces)
 *   links.js definitions checked with skip.some         1 (definitions, 5.2 s; bound 2 s)
 *   edit-distance cap removed                           1 (edit-distance cap, 8.2 s; bound 2 s)
 *   edit-distance cap set to 100                        1 (edit-distance cap)
 *   old 1M-cell window bound restored                   1 (edits far apart)
 *   definition span is the target only                  1 (reference definition)
 *   undefined committed not defaulted                   1 (undefined inputs)
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_EDIT_DISTANCE, MAX_INPUT_CHARS, detectChangedSections } from "../src/graph/changes.js";

function detect(before, committed, options) {
  const result = detectChangedSections(before, committed, options);
  for (const section of result.sections) {
    assert.equal(section.text, committed.slice(section.start, section.end));
    assert.ok(section.start >= 0 && section.start < section.end && section.end <= committed.length);
  }
  return result;
}

const at = (text, needle) => {
  const index = text.indexOf(needle);
  assert.notEqual(index, -1, `fixture lacks ${JSON.stringify(needle)}`);
  return index;
};

test("empty and identical texts", () => {
  assert.deepEqual(detect("", ""), { sections: [], status: "skipped" });
  assert.deepEqual(detect(null, ""), { sections: [], status: "skipped" });
  const body = "# Title\n\n## A\n\nSome prose.\n";
  assert.deepEqual(detect(body, body), { sections: [], status: "skipped" });
  // Everything removed: nothing left to seed from.
  assert.deepEqual(detect(body, ""), { sections: [], status: "skipped" });
});

test("a create or an unknown old body is new, sections in document order", () => {
  const body = "# Title\n\nIntro words.\n\n## A\n\nalpha\n\n## B\n\nbeta\n\n## C\n\ngamma\n";
  for (const before of ["", null]) {
    const result = detect(before, body);
    assert.equal(result.status, "new");
    assert.deepEqual(result.sections.map((s) => s.heading), ["Title", "A"]);
  }
  const three = detect(null, body, { maxSections: 3 });
  assert.deepEqual(three.sections.map((s) => s.heading), ["Title", "A", "B"]);
  // A heading with no prose of its own is not a seed.
  const bare = detect(null, "# Title\n\n## A\n\nalpha\n");
  assert.deepEqual(bare.sections.map((s) => s.heading), ["A"]);
  // Only code: nothing eligible.
  assert.deepEqual(detect("", "```\ncode\n```\n"), { sections: [], status: "skipped" });
});

test("no headings: the whole note is one heading-less section", () => {
  const result = detect("first line\nsecond line\n", "first line\nsecond line changed\n");
  assert.equal(result.status, "changed");
  assert.equal(result.sections.length, 1);
  assert.deepEqual(
    { ...result.sections[0], text: undefined },
    { heading: null, depth: 0, start: 0, end: 31, text: undefined },
  );
});

test("text before the first heading is its own section", () => {
  const before = "Preamble here.\n\n## A\n\nalpha\n";
  const committed = "Preamble rewritten.\n\n## A\n\nalpha\n";
  const result = detect(before, committed);
  assert.equal(result.status, "changed");
  assert.equal(result.sections.length, 1);
  const [section] = result.sections;
  assert.equal(section.heading, null);
  assert.equal(section.depth, 0);
  assert.equal(section.start, 0);
  assert.equal(section.end, at(committed, "## A"));
});

test("duplicate headings are told apart by position", () => {
  const before = "## Notes\n\nfirst body\n\n## Notes\n\nsecond body\n";
  const committed = "## Notes\n\nfirst body\n\n## Notes\n\nsecond body, edited\n";
  const result = detect(before, committed);
  assert.equal(result.status, "changed");
  assert.equal(result.sections.length, 1);
  assert.equal(result.sections[0].heading, "Notes");
  assert.equal(result.sections[0].start, committed.lastIndexOf("## Notes"));
  assert.equal(result.sections[0].end, committed.length);
});

test("an edit under a nested heading maps to that heading's interval", () => {
  const before =
    "## Parent\n\nintro\n\n### Child\n\nold words\n\n#### Grand\n\ngrand words\n\n## Next\n\nnext words\n";
  const committed = before.replace("old words", "new words");
  const result = detect(before, committed);
  assert.equal(result.status, "changed");
  assert.equal(result.sections.length, 1);
  const [section] = result.sections;
  assert.equal(section.heading, "Child");
  assert.equal(section.depth, 3);
  assert.equal(section.start, at(committed, "### Child"));
  // Ends at the next heading of equal or shallower depth, so it spans the
  // deeper `#### Grand` and stops before `## Next`; never the parent's range.
  assert.equal(section.end, at(committed, "## Next"));
  assert.ok(section.text.includes("grand words"));
  assert.ok(!section.text.includes("intro"));
});

test("a new heading with prose is the changed section", () => {
  const before = "## A\n\nalpha\n";
  const committed = "## A\n\nalpha\n\n## B\n\nbrand new prose\n";
  const result = detect(before, committed);
  assert.equal(result.status, "changed");
  assert.deepEqual(result.sections.map((s) => [s.heading, s.start]), [["B", at(committed, "## B")]]);
});

test("a deleted heading folds its prose into the section before it", () => {
  const before = "## A\n\nalpha\n\n## B\n\nbeta\n\n## C\n\ngamma\n";
  const committed = "## A\n\nalpha\n\nbeta\n\n## C\n\ngamma\n";
  const result = detect(before, committed);
  assert.equal(result.status, "changed");
  assert.equal(result.sections.length, 1);
  assert.equal(result.sections[0].heading, "A");
  assert.equal(result.sections[0].end, at(committed, "## C"));
});

test("a pure link-wrap edit is skipped (AGENT-LINKS 13.3 step 6)", () => {
  const before =
    "# Search\n\n## Privacy\n\nGraph ranking extends the existing visibility rule: private notes must not influence results returned to a team reader.\n";
  const committed =
    "# Search\n\n## Privacy\n\nGraph ranking extends the [[policies/visibility|existing visibility rule]]: private notes must not influence results returned to a team reader.\n";
  assert.deepEqual(detect(before, committed), { sections: [], status: "skipped" });
});

test("other link-only edits are skipped; a visible change is not", () => {
  const base = "## A\n\nRead the visibility rule today.\n";
  const skipped = [
    "## A\n\nRead the [visibility rule](policies/visibility.md) today.\n",
    "## A\n\nRead the [[visibility rule]] today.\n",
  ];
  for (const committed of skipped) {
    assert.equal(detect(base, committed).status, "skipped", committed);
  }
  // Retargeting an aliased or inline link leaves the visible text alone.
  assert.equal(
    detect("## A\n\nSee [[a/x|the plan]].\n", "## A\n\nSee [[b/y|the plan]].\n").status,
    "skipped",
  );
  assert.equal(
    detect("## A\n\nSee [the plan](a/x.md).\n", "## A\n\nSee [the plan](<b/y z.md> \"t\").\n").status,
    "skipped",
  );
  // A link that wraps words and also changes them is a real edit.
  const mixed = detect(base, "## A\n\nRead the [[visibility policy]] today.\n");
  assert.equal(mixed.status, "changed");
  assert.equal(mixed.sections[0].heading, "A");
});

test("a one-word negation or a number change is changed", () => {
  const before = "## Rule\n\nPrivate notes must influence team results.\n";
  const committed = "## Rule\n\nPrivate notes must not influence team results.\n";
  const result = detect(before, committed);
  assert.equal(result.status, "changed");
  assert.equal(result.sections[0].heading, "Rule");
  assert.equal(detect("## A\n\nLimit is 10.\n", "## A\n\nLimit is 11.\n").status, "changed");
});

test("whitespace, emphasis, blank-line and line-ending changes are skipped", () => {
  const before = "## A\n\nThe quick brown fox jumps over the lazy dog.\n";
  const variants = [
    "## A\n\nThe  quick brown fox jumps over the lazy dog.   \n",
    "## A\n\nThe **quick** brown _fox_ jumps over the ~~lazy~~ dog.\n",
    "## A\n\n\n\nThe quick brown fox jumps over the lazy dog.\n\n",
    "## A\n\nThe quick brown fox\njumps over the lazy dog.\n",
    "## A\r\n\r\nThe quick brown fox jumps over the lazy dog.\r\n",
  ];
  for (const committed of variants) {
    assert.deepEqual(detect(before, committed), { sections: [], status: "skipped" }, committed);
  }
  // Lines with no letters or digits are formatting: a thematic break, a
  // table's alignment row.
  assert.equal(detect(before, `${before}\n***\n`).status, "skipped");
  const table = "## T\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n";
  assert.equal(detect(table, table.replace("| --- | --- |", "| :--- | ---: |")).status, "skipped");
});

test("a table cell and a nested list item map to their sections", () => {
  const before =
    "## Table\n\n| name | value |\n| --- | --- |\n| a | 1 |\n| b | 2 |\n\n## List\n\n- top\n  - nested one\n    - deeper two\n- last\n";
  const table = before.replace("| b | 2 |", "| b | 3 |");
  const tableResult = detect(before, table);
  assert.equal(tableResult.status, "changed");
  assert.deepEqual(tableResult.sections.map((s) => s.heading), ["Table"]);

  const list = before.replace("deeper two", "deeper three");
  const listResult = detect(before, list);
  assert.equal(listResult.status, "changed");
  assert.deepEqual(listResult.sections.map((s) => s.heading), ["List"]);
});

test("code is not a seed: fenced, inline, and headings inside fences", () => {
  const before = "## A\n\nprose\n\n```md\n## Fake\nlet x = 1;\n```\n\nUse `old()` here.\n";
  const fenced = before.replace("let x = 1;", "let x = 2;");
  assert.deepEqual(detect(before, fenced), { sections: [], status: "skipped" });
  const inline = before.replace("`old()`", "`renamed()`");
  assert.deepEqual(detect(before, inline), { sections: [], status: "skipped" });

  // The `## Fake` inside the fence is not a heading: an edit after the fence
  // still belongs to `## A`, whose interval runs to the end.
  const after = before.replace("here.", "there.");
  const result = detect(before, after);
  assert.equal(result.status, "changed");
  assert.deepEqual(result.sections.map((s) => [s.heading, s.start, s.end]), [["A", 0, after.length]]);

  // Tilde fences and an unterminated fence mask to the end.
  const tilde = "## A\n\nprose\n\n~~~\nalpha\n~~~\n";
  assert.equal(detect(tilde, tilde.replace("alpha", "beta")).status, "skipped");
  const open = "## A\n\nprose\n\n```\nalpha\n";
  assert.equal(detect(open, open.replace("alpha", "beta")).status, "skipped");
});

test("frontmatter is not a seed and its fence is not a setext heading", () => {
  const before = "---\ntitle: One\nvisibility: team\n---\n\n## A\n\nalpha\n";
  const committed = before.replace("title: One", "title: Two");
  assert.deepEqual(detect(before, committed), { sections: [], status: "skipped" });
  // Adding or removing the whole block is not a prose change either.
  const plain = "## A\n\nalpha\n";
  assert.deepEqual(detect(before, plain), { sections: [], status: "skipped" });
  assert.deepEqual(detect(plain, before), { sections: [], status: "skipped" });
  const edited = before.replace("alpha", "alpha beta");
  const result = detect(before, edited);
  assert.deepEqual(result.sections.map((s) => [s.heading, s.depth]), [["A", 2]]);
  // A new note's frontmatter is not prose either.
  assert.deepEqual(detect("", "---\ntitle: x\n---\n").sections, []);
});

test("setext headings, and a thematic break that is not one", () => {
  const before = "Title\n=====\n\nintro\n\nSub\n---\n\nsub words\n\n---\n\ntail words\n";
  const committed = before.replace("sub words", "sub words changed").replace("tail words", "tail more");
  const result = detect(before, committed);
  assert.equal(result.status, "changed");
  assert.equal(result.sections.length, 1);
  const [section] = result.sections;
  assert.deepEqual([section.heading, section.depth, section.start], ["Sub", 2, at(committed, "Sub\n")]);
  // `---` after a blank line is a thematic break, so the tail stays in `Sub`.
  assert.equal(section.end, committed.length);

  const top = detect(before, before.replace("intro", "intro two"));
  assert.deepEqual(top.sections.map((s) => [s.heading, s.depth, s.start]), [["Title", 1, 0]]);
});

test("ATX headings: closing hashes, CRLF, and no space is not a heading", () => {
  const before = "## Plan ##\r\n\r\nalpha\r\n\r\n#hashtag line\r\n";
  const committed = before.replace("alpha", "alpha beta");
  const result = detect(before, committed);
  assert.equal(result.status, "changed");
  assert.deepEqual(result.sections.map((s) => [s.heading, s.depth, s.start, s.end]), [
    ["Plan", 2, 0, committed.length],
  ]);
  const tag = detect(before, before.replace("#hashtag line", "#hashtag lines"));
  assert.equal(tag.sections[0].heading, "Plan");
});

test("a collaborative merge: only the sections diffed against before count", () => {
  // `before` is the merged document as it stood before this write, already
  // carrying another person's edit to `## A`; this write changes only `## C`.
  const base = "## A\n\nalpha\n\n## B\n\nbeta\n\n## C\n\ngamma\n";
  const before = base.replace("alpha", "alpha from a colleague");
  const committed = before.replace("gamma", "gamma from this write");
  const result = detect(before, committed);
  assert.equal(result.status, "changed");
  assert.deepEqual(result.sections.map((s) => s.heading), ["C"]);
  // Two separate edits are two sections, not the range between them.
  const both = detect(base, base.replace("alpha", "alpha one").replace("gamma", "gamma two"));
  assert.deepEqual(both.sections.map((s) => s.heading), ["A", "C"]);
});

test("at most maxSections, preferring the most changed prose", () => {
  const before = "## A\n\na\n\n## B\n\nb\n\n## C\n\nc\n";
  const committed = before
    .replace("\na\n", "\na plus a few words\n")
    .replace("\nb\n", "\nb plus a much longer run of added prose words\n")
    .replace("\nc\n", "\nc plus some more added words here\n");
  assert.deepEqual(detect(before, committed).sections.map((s) => s.heading), ["B", "C"]);
  assert.deepEqual(detect(before, committed, { maxSections: 1 }).sections.map((s) => s.heading), ["B"]);
  assert.equal(detect(before, committed, { maxSections: 3 }).sections.length, 3);
});

test("unicode: offsets are JavaScript string offsets across surrogate pairs", () => {
  const before = "## 😀 Emoji\n\n😀😀 text\n\n## Ünïcode\n\nwörds 𝔘\n";
  const committed = before.replace("wörds 𝔘", "wörds 𝔘 und mehr");
  const result = detect(before, committed);
  assert.deepEqual(result.sections.map((s) => [s.heading, s.start]), [["Ünïcode", at(committed, "## Ünïcode")]]);
  const texts = before.replace("😀😀 text", "😀😀 texts");
  const emoji = detect(before, texts);
  assert.deepEqual(emoji.sections.map((s) => [s.heading, s.start, s.end]), [["😀 Emoji", 0, at(texts, "## Ünïcode")]]);
});

test("an input over the cap is a limited new pass within the cap", () => {
  const block = (i) => `## Section ${i}\n\n${"word ".repeat(200)}\n\n`;
  let big = "";
  for (let i = 0; big.length < 1_048_576; i += 1) big += block(i);
  assert.ok(big.length > MAX_INPUT_CHARS);
  const edited = `${big}tail edit\n`;
  const started = Date.now();
  const result = detect(big, edited);
  const elapsed = Date.now() - started;
  assert.equal(result.status, "new");
  assert.deepEqual(result.sections.map((s) => s.heading), ["Section 0", "Section 1"]);
  for (const section of result.sections) assert.ok(section.end <= MAX_INPUT_CHARS);
  assert.ok(elapsed < 2_000, `took ${elapsed} ms`);

  // A small explicit cap: the last section is cut at the cap, never inside a
  // surrogate pair.
  const note = "## A\n\nx😀😀😀\n";
  const cut = detect("x", note, { maxInputChars: 10 });
  assert.equal(cut.status, "new");
  assert.equal(cut.sections.length, 1);
  assert.equal(cut.sections[0].end, 9);
  assert.equal(cut.sections[0].text, "## A\n\nx😀");
});

test("edits far apart in a long note are diffed, not a limited pass", () => {
  // The review's case: a 1,100-line note edited near the top and the bottom.
  const lines = Array.from({ length: 1_100 }, (_, i) => `Sentence number ${i} about a topic.`);
  const note = ["## Intro", "", "Intro words.", "", "## Body", "", ...lines.slice(0, 1_090), "", "## End", "", ...lines.slice(1_090)].join("\n") + "\n";
  const edited = note
    .replace("Sentence number 2 about", "Sentence number 2 not about")
    .replace("Sentence number 1095 about", "Sentence number 1095 never about");
  const result = detect(note, edited);
  assert.equal(result.status, "changed");
  assert.deepEqual(result.sections.map((s) => s.heading).sort(), ["Body", "End"]);

  const wide = `## A\n\n${Array.from({ length: 1_200 }, (_, i) => `line ${i}`).join("\n")}\n\n## B\n\nbeta\n`;
  const both = detect(wide, wide.replace("line 0\n", "line zero\n").replace("beta", "beta two"));
  assert.equal(both.status, "changed");
  assert.deepEqual(both.sections.map((s) => s.heading), ["A", "B"]);
});

test("the edit-distance cap: exact under it, a limited pass over it, fast either way", () => {
  // Every line differs, so the edit distance is the sum of both line counts.
  const distinct = (tag, count) => `## A\n\n${Array.from({ length: count }, (_, i) => `${tag} ${i}`).join("\n")}\n`;
  const half = MAX_EDIT_DISTANCE / 2;
  let started = performance.now();
  const under = detect(distinct("old", half - 1), distinct("new", half - 1));
  const underMs = performance.now() - started;
  assert.equal(under.status, "changed");
  assert.deepEqual(under.sections.map((s) => s.heading), ["A"]);
  assert.ok(underMs < 2_000, `under the cap took ${underMs} ms`);

  started = performance.now();
  const over = detect(distinct("old", 20_000), distinct("new", 20_000));
  const overMs = performance.now() - started;
  assert.equal(over.status, "new");
  assert.ok(overMs < 2_000, `over the cap took ${overMs} ms`);

  // Long repeated snakes: alternating equal lines shifted by one.
  const alt = (shift) => Array.from({ length: 1_000 }, (_, i) => `${"p".repeat(240)}c${(i + shift) % 2}`).join("\n");
  started = performance.now();
  detect(`z\n${alt(0)}\nz`, `y\n${alt(1)}\ny`);
  const altMs = performance.now() - started;
  assert.ok(altMs < 2_000, `alternating lines took ${altMs} ms`);
});

test("a heading of spaces is linear, and closing hashes follow CommonMark", () => {
  const spaces = `# a${" ".repeat(250_000)}b\n`;
  assert.ok(spaces.length < MAX_INPUT_CHARS);
  const started = performance.now();
  detect("x", spaces);
  detect(null, spaces);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 2_000, `took ${elapsed} ms`);

  const title = (line) => detect(null, `${line}\nbody\n`).sections[0].heading;
  assert.equal(title("## Plan ##"), "Plan");
  assert.equal(title("## Plan#"), "Plan#");
  assert.equal(title("# #"), "");
  assert.equal(title("## a # #  "), "a #");
  assert.equal(title("##\tPlan\t#\t"), "Plan");
});

test("many reference definitions beside many code spans stay fast", () => {
  const fill = (unit, n) => unit.repeat(Math.floor(n / unit.length));
  const body = `${fill("`x` ", MAX_INPUT_CHARS / 2 - 10)}\n\n${fill("[a]: u\n", MAX_INPUT_CHARS / 2)}`;
  const started = performance.now();
  detect(body.slice(0, -1), body);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 2_000, `took ${elapsed} ms`);
});

test("adding only a reference definition is skipped", () => {
  const base = "## A\n\nRead the visibility rule today.\n";
  assert.deepEqual(detect(base, `${base}\n[vis]: policies/visibility.md\n`), { sections: [], status: "skipped" });
  assert.deepEqual(detect(base, `${base}\n  [vis]: <policies/v.md> "Visibility policy"\n`), { sections: [], status: "skipped" });
});

test("undefined inputs are treated as missing, never thrown on", () => {
  assert.deepEqual(detect(undefined, "## A\n\nalpha\n"), detect(null, "## A\n\nalpha\n"));
  assert.deepEqual(detectChangedSections("## A\n\nalpha\n", undefined), { sections: [], status: "skipped" });
  assert.deepEqual(detectChangedSections("## A\n\nalpha\n", null), { sections: [], status: "skipped" });
  assert.deepEqual(detectChangedSections(undefined, undefined), { sections: [], status: "skipped" });
});

test("a note of tiny sections at the cap stays linear", () => {
  const unit = "# h\nx\n";
  const dense = unit.repeat(Math.floor(MAX_INPUT_CHARS / unit.length) - 1);
  const started = Date.now();
  assert.equal(detect(null, dense).sections.length, 2);
  const edited = detect(dense, `${dense}# h\ny\n`);
  assert.equal(edited.status, "changed");
  assert.equal(edited.sections[0].start, dense.length);
  assert.ok(Date.now() - started < 2_000, `took ${Date.now() - started} ms`);
});
