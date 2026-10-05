/**
 * The Porter2 (Snowball English) stemmer, apps/mcp/src/search/porter2.js.
 *
 * Every expected stem comes from https://snowballstem.org/algorithms/english/stemmer.html
 * (fetched 2026-10-04, Last-Modified 20 Aug 2026, revision notes through
 * "Snowball 3.1.0"), either copied from the page (its sample vocabulary table,
 * its worked examples, its exceptional-forms table) or derived step by step from
 * the page's rules, with the derivation written next to the case. p1 and p2 are
 * the start indices of R1 and R2 in the word after the prelude.
 *
 * Idempotence is not a property of Porter2, so it is not asserted.
 *
 * TODO: add Snowball's full published vocabulary (voc.txt / output.txt from
 * snowballstem/snowball-data) as a fixture once the owner approves downloading it.
 *
 * ## Sabotage record
 *
 * Emptying the R1 special-prefix list failed "special R1 prefixes keep gener,
 * univers, past and inter words apart" (generate stemmed to gener). Changing
 * the Step 1a ied/ies rule to always replace by "i" failed "Step 1a suffix
 * families" (ties stemmed to ti). Emptying the exceptional-forms list failed
 * "exceptional forms from the page" (skis stemmed to skis).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { porter2 } from "../src/search/porter2.js";

function check(pairs) {
  for (const [word, stem] of pairs) assert.equal(porter2(word), stem, word);
}

test("the page's sample vocabulary table", () => {
  // Copied from the two-column sample at the top of the page.
  check([
    ["consign", "consign"], ["consigned", "consign"], ["consigning", "consign"],
    ["consignment", "consign"], ["consist", "consist"], ["consisted", "consist"],
    ["consistency", "consist"], ["consistent", "consist"], ["consistently", "consist"],
    ["consisteth", "consisteth"], ["consisting", "consist"], ["consistory", "consistori"],
    ["consists", "consist"], ["consolate", "consol"], ["consolation", "consol"],
    ["consolations", "consol"], ["consolatory", "consolatori"], ["console", "consol"],
    ["consoled", "consol"], ["consoler", "consol"], ["consoles", "consol"],
    ["consolidate", "consolid"], ["consolidated", "consolid"], ["consolidating", "consolid"],
    ["consolidation", "consolid"], ["consoling", "consol"], ["consolingly", "consol"],
    ["consols", "consol"], ["consonancy", "conson"], ["consonant", "conson"],
    ["consort", "consort"], ["consorted", "consort"], ["consortest", "consortest"],
    ["consorting", "consort"], ["conspectuities", "conspectu"], ["conspicuous", "conspicu"],
    ["conspicuously", "conspicu"], ["conspir", "conspir"], ["conspiracy", "conspiraci"],
    ["conspirant", "conspir"],
    ["knack", "knack"], ["knackeries", "knackeri"], ["knacks", "knack"],
    ["knag", "knag"], ["knapp", "knapp"], ["knapsack", "knapsack"],
    ["knav", "knav"], ["knave", "knave"], ["knaveries", "knaveri"],
    ["knavery", "knaveri"], ["knaves", "knave"], ["knavish", "knavish"],
    ["knead", "knead"], ["kneaded", "knead"], ["kneading", "knead"],
    ["knee", "knee"], ["kneel", "kneel"], ["kneeled", "kneel"],
    ["kneeling", "kneel"], ["kneels", "kneel"], ["knees", "knee"],
    ["knell", "knell"], ["knelled", "knell"], ["knelt", "knelt"],
    ["knew", "knew"], ["knewest", "knewest"], ["knick", "knick"],
    ["knicknacks", "knicknack"], ["knif", "knif"], ["knife", "knife"],
    ["knight", "knight"], ["knighted", "knight"], ["knighthood", "knighthood"],
    ["knighthoods", "knighthood"], ["knightly", "knight"], ["knights", "knight"],
    ["knightsbridge", "knightsbridg"], ["knit", "knit"], ["knits", "knit"],
    ["knitted", "knit"],
  ]);
});

test("exceptional forms from the page", () => {
  // The page's "Exceptional forms in the English stemmer" table.
  check([
    ["skis", "ski"], ["skies", "sky"],
    ["idly", "idl"], ["gently", "gentl"], ["ugly", "ugli"],
    ["early", "earli"], ["only", "onli"], ["singly", "singl"],
    ["sky", "sky"], ["news", "news"], ["howe", "howe"],
    ["atlas", "atlas"], ["cosmos", "cosmos"], ["bias", "bias"], ["andes", "andes"],
  ]);
});

test("special R1 prefixes keep gener, univers, past and inter words apart", () => {
  // From the page's worked example after adding 'gener' to the R1 prefixes.
  check([
    ["generate", "generat"], ["generates", "generat"], ["generated", "generat"],
    ["generating", "generat"], ["general", "general"], ["generally", "general"],
    ["generic", "generic"], ["generically", "generic"], ["generous", "generous"],
    ["generously", "generous"],
  ]);
  // universe: p1=7 (prefix univers), p2=8 (end). Step 5 e at 7: not R2, in R1,
  // "univers" does not end in a short syllable, delete: univers.
  assert.equal(porter2("universe"), "univers");
  // universal: p1=7, p2=9. Step 4 al at 7 is not in R2; Step 5 l not in R2.
  assert.equal(porter2("universal"), "universal");
  // university: Step 1c y after t becomes i, universiti. Step 4 iti at 7 is not
  // in R2 (p2=9). Unchanged after that: universiti.
  assert.equal(porter2("university"), "universiti");
  // pasted: p1=4 (prefix past). Step 1b deletes ed, past; R1 is empty and
  // shortv matches 'past', add e: paste. Step 5 e at 4: p2=5 so not R2, in
  // R1 but preceded by a short syllable ('past'), keep: paste.
  assert.equal(porter2("pasted"), "paste");
  // internal: p1=5 (prefix inter), p2=8. Step 4 al at 6 not in R2; Step 5 l
  // at 7 not in R2: internal. (Without the prefix p2=5 and al would go.)
  assert.equal(porter2("internal"), "internal");
});

test("y handling", () => {
  // yes: initial y becomes Y, Yes. p1=3. Step 1a s: skip e, no vowel before
  // it (Y is not a vowel), keep s. Postlude: yes.
  assert.equal(porter2("yes"), "yes");
  // sayings: y after a becomes Y, saYings; p1=3, p2=5. Step 1a s: skip g,
  // vowel i found, delete: saYing. Step 1b ing: 'Y' is not 'y' and saY is
  // not inn/out/..., so delete since saY has a vowel: saY. Not at/bl/iz, no
  // double; R1 is empty (p1=3 is the end) but saY does not end in a short
  // syllable (Y is excluded as the final consonant, and a is not at the
  // start), so no e.
  // Step 1c: Y preceded by vowel a, unchanged. Postlude: say.
  assert.equal(porter2("sayings"), "say");
  // Page Step 1c examples: cry to cri; by and say unchanged.
  // cry: y after r stays y. Step 1c y after non-vowel r, r not first: cri.
  assert.equal(porter2("cry"), "cri");
  assert.equal(porter2("by"), "by");
  // say: y after a becomes Y; Step 1c Y after a vowel unchanged; say.
  assert.equal(porter2("say"), "say");
  // happy: p1=3. Step 1c y after p: happi. Nothing else applies.
  assert.equal(porter2("happy"), "happi");
});

test("short words are returned unchanged", () => {
  // Page: "If the word has two letters or less, stop processing".
  check([["", ""], ["a", "a"], ["as", "as"], ["is", "is"], ["'s", "'s"]]);
});

test("apostrophes", () => {
  // dog's: p1=3. Step 0 removes 's: dog. Nothing else: dog.
  assert.equal(porter2("dog's"), "dog");
  // dogs': Step 0 removes ': dogs. Step 1a s: skip g, vowel o found: dog.
  assert.equal(porter2("dogs'"), "dog");
  // 'dogs: the initial apostrophe is removed, then as above: dog.
  assert.equal(porter2("'dogs"), "dog");
});

test("Step 1a suffix families", () => {
  // Page examples: ties to tie, cries to cri (ies), gas and this keep s, gaps
  // and kiwis lose it. Later steps do not change these (no suffix in R1/R2).
  check([["ties", "tie"], ["cries", "cri"], ["gas", "gas"], ["this", "this"],
    ["gaps", "gap"], ["kiwis", "kiwi"]]);
  // tied: one letter before ied, replace by ie: tie. cried: cri.
  assert.equal(porter2("tied"), "tie");
  assert.equal(porter2("cried"), "cri");
  // caresses: p1=3, p2=5. sses to ss: caress. No later suffix: caress.
  assert.equal(porter2("caresses"), "caress");
  // bonus: us does nothing; no later suffix: bonus.
  assert.equal(porter2("bonus"), "bonus");
});

test("Step 1b suffix families and exceptions", () => {
  // agreed: p1=2, p2=6. eed at 3 is in R1, agr is not proc/exc/succ: agree.
  // Step 5 e at 4: not R2, in R1, "agre" does not end in a short syllable,
  // delete: agre.
  assert.equal(porter2("agreed"), "agre");
  // feed: p1=4, eed at 1 not in R1, nothing: feed.
  assert.equal(porter2("feed"), "feed");
  // succeed/proceed/exceed: eed in R1 but preceded by exactly succ/proc/exc.
  check([["succeed", "succeed"], ["proceed", "proceed"], ["exceed", "exceed"]]);
  // Page: dying to die; tying to tie and vying to vie per the page's comment;
  // dyings to die and herrings to herring (Step 1a removes s first).
  check([["dying", "die"], ["tying", "tie"], ["vying", "vie"], ["dyings", "die"],
    ["herrings", "herring"]]);
  // Page: inning, outing, canning, herring, earring, evening are left alone.
  // Step 1b stops on the exception; none has a Step 2 to 5 suffix.
  check([["inning", "inning"], ["outing", "outing"], ["canning", "canning"],
    ["herring", "herring"], ["earring", "earring"], ["evening", "evening"]]);
  // hopping: delete ing, hopp ends in a double not preceded by exactly a/e/o
  // at the start, remove last letter: hop (page: hopp to hop).
  assert.equal(porter2("hopping"), "hop");
  // hoped: p1=3. delete ed: hop. R1 empty and hop ends in a short syllable,
  // add e: hope. Step 5 e: not R2 (p2=5), preceded by a short syllable: hope.
  assert.equal(porter2("hoped"), "hope");
  // added: delete ed: add. dd preceded by exactly a: unchanged (page: add).
  assert.equal(porter2("added"), "add");
  // markedly: edly, vowel in mark, delete: mark. R1 (p1=3) not empty: mark.
  assert.equal(porter2("markedly"), "mark");
  // sized: delete ed: siz, ends iz, add e: size. Step 5 e at 3: not R2 (p2=5),
  // siz ends in a short syllable, keep: size.
  assert.equal(porter2("sized"), "size");
  // troubled: p1=5, p2=8. delete ed, troubl ends bl, add e: trouble. Step 5
  // e at 6: not R2, in R1, troubl not a short syllable, delete: troubl.
  assert.equal(porter2("troubled"), "troubl");
});

test("Step 2 suffix families", () => {
  // relational: p1=3, p2=5. ational at 3 in R1: relate. Step 4 ate at 3 not
  // in R2. Step 5 e at 5 in R2: relat.
  assert.equal(porter2("relational"), "relat");
  // conditional: p1=3, p2=6. tional at 5 in R1: condition. Step 4 ion at 6 in
  // R2 after t: condit.
  assert.equal(porter2("conditional"), "condit");
  // ability: p1=2, p2=4. Step 1c: abiliti. Step 2 longest is biliti at 1, not
  // in R1, so Step 2 does nothing (no shorter retry). Step 4 iti at 4 in R2:
  // abil. Step 5 l at 3 not in R2: abil.
  assert.equal(porter2("ability"), "abil");
  // lovely: p1=3, p2=5. Step 1c: loveli. li at 4 after valid e: love. Step 5 e
  // at 3 not R2, lov ends in a short syllable: love.
  assert.equal(porter2("lovely"), "love");
  // geologist: p1=4, p2=6. ogist at 4 in R1: geolog. geology: Step 1c
  // geologi, ogi at 4 after l: geolog (page: conflate geologist with geology).
  assert.equal(porter2("geologist"), "geolog");
  assert.equal(porter2("geology"), "geolog");
});

test("Step 3 suffix families", () => {
  // hopefulness: p1=3, p2=5. Step 2 fulness at 4: hopeful. Step 3 ful at 4:
  // hope. Step 5 e at 3 not R2, hop ends in a short syllable: hope.
  assert.equal(porter2("hopefulness"), "hope");
  // electrical: p1=2, p2=4. Step 3 ical at 6: electric. Step 4 ic at 6 in R2:
  // electr.
  assert.equal(porter2("electrical"), "electr");
  // formative: p1=3, p2=6. Step 3 ative at 4 is not in R2, kept. Step 4 ive at
  // 6 in R2: format.
  assert.equal(porter2("formative"), "format");
});

test("Step 4 suffix families", () => {
  // adjustment: p1=2, p2=5. longest is ment at 6 in R2: adjust.
  assert.equal(porter2("adjustment"), "adjust");
  // adoption: p1=2, p2=4. ion at 5 in R2 after t: adopt.
  assert.equal(porter2("adoption"), "adopt");
  // opinion: p1=2, p2=4. ion at 4 in R2 but after n: opinion.
  assert.equal(porter2("opinion"), "opinion");
});

test("Step 5", () => {
  // controlling: p1=3, p2=7. Step 1b deletes ing: controll (ll is not a
  // listed double). Step 5 l at 7 in R2 after l: control.
  assert.equal(porter2("controlling"), "control");
  // relational covers e in R2; hope and size cover e kept after a short
  // syllable; universe covers e deleted in R1.
});

test("words outside a-z and apostrophe are returned unchanged", () => {
  check([["café", "café"], ["Running", "Running"], ["co-op", "co-op"], ["abc123", "abc123"]]);
});
