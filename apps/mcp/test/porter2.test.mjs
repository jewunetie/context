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
 *
 * One table entry per step (fix round 1): Step 1b "ingly" changed to "ingli"
 * failed "Step 1b suffix families and exceptions" (surprisingly stemmed to
 * surprising). Step 2 anci replaced by "ence" failed "Step 2 suffix families"
 * (vacancy stemmed to vacenc). Step 3 "icate" changed to "icade" failed
 * "Step 3 suffix families" (certificate stemmed to certific). Step 4 "ous"
 * changed to "ius" failed "Step 4 suffix families" (dangerous stemmed to
 * dangerous). The first tries for Steps 2 and 3 were checked against
 * hesitancy and duplicate only, and passed under sabotage because Step 4
 * removes ance/ence and ate either way; vacancy and certificate were added
 * because their Step 4 suffix is not in R2.
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
  // shortv matches 'past', add e: paste. Step 5 e at 4: p2=6 so not R2, in
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
  // agreedly: p1=2 (a, g), p2=6 (from 2: e at 3, d at 5). y after l stays y.
  // Step 1b longest is eedly at 3, in R1, agr is not proc/exc/succ: agree.
  // Steps 1c to 4: no suffix. Step 5 e at 4: not R2, in R1, agre does not end
  // in a short syllable (last letter e is a vowel), delete: agre.
  assert.equal(porter2("agreedly"), "agre");
  // surprisingly: p1=3 (u, r), p2=7 (from 3: i at 5, s at 6). Step 1b longest
  // is ingly at 7; surpris has a vowel, delete: surpris. Not at/bl/iz, no
  // double, R1 not empty (length 7 is not p1=3), so no e. Steps 1c to 5: no
  // suffix applies: surpris.
  assert.equal(porter2("surprisingly"), "surpris");
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
  // hesitancy: p1=3 (e, s), p2=5 (from 3: i at 3, t at 4). Step 1c y after c:
  // hesitanci. Step 2 anci at 5 in R1: hesitance. Step 3 none. Step 4 ance at
  // 5 in R2: hesit. Step 5 none: hesit.
  assert.equal(porter2("hesitancy"), "hesit");
  // vacancy: p1=3 (a, c), p2=5 (from 3: a at 3, n at 4). Step 1c y after c:
  // vacanci. Step 2 anci at 3 in R1: vacance. Step 3 none. Step 4 ance at 3
  // not in R2. Step 5 e at 6 in R2, delete: vacanc.
  assert.equal(porter2("vacancy"), "vacanc");
  // reasonably: p1=4 (e, a, s), p2=6 (from 4: o at 4, n at 5). Step 1c y after
  // l: reasonabli. Step 2 longest is abli at 6, in R1: reasonable. Step 3 none.
  // Step 4 able at 6 in R2: reason. Step 5 none: reason.
  assert.equal(porter2("reasonably"), "reason");
  // organizer: p1=5 (prefix organ), p2=7 (from 5: i at 5, z at 6). Step 2
  // izer at 5 in R1: organize. Step 3 none. Step 4 ize at 5 not in R2. Step 5
  // e at 7 in R2, delete: organiz.
  assert.equal(porter2("organizer"), "organiz");
  // organization: p1=5, p2=7. Step 2 longest is ization at 5 (longer than
  // ation at 7), in R1: organize. Then as organizer: organiz.
  assert.equal(porter2("organization"), "organiz");
  // operator: p1=2 (o, p), p2=4 (from 2: e at 2, r at 3). Step 2 ator at 4 in
  // R1: operate. Step 3 none. Step 4 ate at 4 in R2: oper. Step 5 none: oper.
  assert.equal(porter2("operator"), "oper");
  // formalism: p1=3 (o, r), p2=6 (from 3: a at 4, l at 5). Step 2 alism at 4
  // in R1: formal. Step 3 none. Step 4 al at 4 not in R2. Step 5 l at 5 not
  // in R2: formal.
  assert.equal(porter2("formalism"), "formal");
  // formality: p1=3, p2=6. Step 1c y after t: formaliti. Step 2 aliti at 4 in
  // R1: formal. Then as formalism: formal.
  assert.equal(porter2("formality"), "formal");
  // formally: p1=3, p2=6. Step 1c y after l: formalli. Step 2 longest is alli
  // at 4 (not li at 6), in R1: formal. Then as formalism: formal.
  assert.equal(porter2("formally"), "formal");
  // callousness: p1=3 (a, l), p2=7 (from 3: o at 4, s at 6). Step 1a ss does
  // nothing. Step 2 ousness at 4 in R1: callous. Step 3 none. Step 4 ous at 4
  // not in R2. Step 5 none: callous.
  assert.equal(porter2("callousness"), "callous");
  // effectiveness: p1=2 (e, f), p2=5 (from 2: e at 3, c at 4). Step 1a ss.
  // Step 2 iveness at 6 in R1: effective. Step 3 none. Step 4 ive at 6 in R2:
  // effect. Step 5 none: effect.
  assert.equal(porter2("effectiveness"), "effect");
  // sensitivity: p1=3 (e, n), p2=6 (from 3: i at 4, t at 5). Step 1c y after
  // t: sensitiviti. Step 2 iviti at 6 in R1: sensitive. Step 3 none. Step 4
  // ive at 6 in R2: sensit. Step 5 none: sensit.
  assert.equal(porter2("sensitivity"), "sensit");
  // visibly: p1=3 (i, s), p2=5 (from 3: i at 3, b at 4). Step 1c y after l:
  // visibli. Step 2 longest is bli at 4 (abli does not match), in R1: visible.
  // Step 3 none. Step 4 ible at 3 not in R2. Step 5 e at 6 in R2: visibl.
  assert.equal(porter2("visibly"), "visibl");
  // hopefully: p1=3 (o, p), p2=5 (from 3: e at 3, f at 4). Step 1c y after l:
  // hopefulli. Step 2 longest is fulli at 4, in R1: hopeful. Step 3 ful at 4
  // in R1: hope. Step 4 none. Step 5 e at 3 not R2, hop ends in a short
  // syllable, keep: hope.
  assert.equal(porter2("hopefully"), "hope");
  // carelessly: p1=3 (a, r), p2=5 (from 3: e at 3, l at 4). Step 1c y after l:
  // carelessli. Step 2 longest is lessli at 4, in R1: careless. Steps 3 to 5
  // none: careless.
  assert.equal(porter2("carelessly"), "careless");
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
  // conditionally: p1=3 (o, n), p2=6 (from 3: i at 4, t at 5). Step 1c y after
  // l: conditionalli. Step 2 longest is alli at 9, in R1: conditional. Step 3
  // longest is tional at 5 (ational does not match), in R1: condition. Step 4
  // ion at 6 in R2 after t: condit. Step 5 none: condit.
  assert.equal(porter2("conditionally"), "condit");
  // relationally: p1=3 (e, l), p2=5 (from 3: a at 3, t at 4). Step 1c y after
  // l: relationalli. Step 2 alli at 8: relational. Step 3 longest is ational at
  // 3, in R1: relate. Step 4 ate at 3 not in R2. Step 5 e at 5 in R2: relat.
  assert.equal(porter2("relationally"), "relat");
  // normalize: p1=3 (o, r), p2=6 (from 3: a at 4, l at 5). Step 2 none. Step
  // 3 alize at 4 in R1: normal. Step 4 al at 4 not in R2. Step 5 l at 5 not
  // in R2: normal.
  assert.equal(porter2("normalize"), "normal");
  // duplicate: p1=3 (u, p), p2=6 (from 3: i at 4, c at 5). Step 2 none. Step 3
  // icate at 4 in R1: duplic. Step 4 ic at 4 not in R2. Step 5 none: duplic.
  assert.equal(porter2("duplicate"), "duplic");
  // certificate: p1=3 (e, r), p2=6 (from 3: i at 4, f at 5). Step 2 none.
  // Step 3 icate at 6 in R1: certific. Step 4 ic at 6 in R2: certif. Step 5
  // none: certif.
  assert.equal(porter2("certificate"), "certif");
  // electricity: p1=2 (e, l), p2=4 (from 2: e at 2, c at 3). Step 1c y after
  // t: electriciti. Step 2 none. Step 3 iciti at 6 in R1: electric. Step 4 ic
  // at 6 in R2: electr. Step 5 none: electr.
  assert.equal(porter2("electricity"), "electr");
  // kindness: p1=3 (i, n), p2=7 (from 3: e at 5, s at 6). Step 1a ss. Step 2
  // none. Step 3 ness at 4 in R1: kind. Steps 4 and 5 none: kind.
  assert.equal(porter2("kindness"), "kind");
});

test("Step 4 suffix families", () => {
  // adjustment: p1=2, p2=5. longest is ment at 6 in R2: adjust.
  assert.equal(porter2("adjustment"), "adjust");
  // adoption: p1=2, p2=4. ion at 5 in R2 after t: adopt.
  assert.equal(porter2("adoption"), "adopt");
  // opinion: p1=2, p2=4. ion at 4 in R2 but after n: opinion.
  assert.equal(porter2("opinion"), "opinion");
  // allowance: p1=2 (a, l), p2=5 (from 2: o at 3, w at 4). Steps 2 and 3 none.
  // Step 4 ance at 5 in R2: allow. Step 5 none: allow.
  assert.equal(porter2("allowance"), "allow");
  // observer: p1=2 (o, b), p2=5 (from 2: e at 3, r at 4). Step 4 er at 6 in
  // R2: observ. Step 5 none: observ.
  assert.equal(porter2("observer"), "observ");
  // adjustable: p1=2, p2=5 (from 2: u at 3, s at 4). Steps 2 and 3 none. Step
  // 4 able at 6 in R2: adjust. Step 5 none: adjust.
  assert.equal(porter2("adjustable"), "adjust");
  // defensible: p1=3 (e, f), p2=5 (from 3: e at 3, n at 4). Step 4 ible at 6
  // in R2: defens. Step 5 none: defens.
  assert.equal(porter2("defensible"), "defens");
  // irritant: p1=2 (i, r), p2=5 (from 2: i at 3, t at 4). Step 4 ant at 5 in
  // R2: irrit. Step 5 none: irrit.
  assert.equal(porter2("irritant"), "irrit");
  // replacement: p1=3 (e, p), p2=6 (from 3: a at 4, c at 5). Step 4 longest
  // is ement at 6 (not ment at 7), in R2: replac. Step 5 none: replac.
  assert.equal(porter2("replacement"), "replac");
  // criticism: p1=4 (i, t), p2=6 (from 4: i at 4, c at 5). Steps 2 and 3 none.
  // Step 4 ism at 6 in R2: critic. Step 5 none: critic.
  assert.equal(porter2("criticism"), "critic");
  // dangerous: p1=3 (a, n), p2=6 (from 3: e at 4, r at 5). Step 1a us does
  // nothing. Step 4 ous at 6 in R2: danger. Step 5 none: danger.
  assert.equal(porter2("dangerous"), "danger");
  // fertilize: p1=3 (e, r), p2=6 (from 3: i at 4, l at 5). Steps 2 and 3 none
  // (alize does not match). Step 4 ize at 6 in R2: fertil. Step 5 l at 5 not
  // in R2: fertil.
  assert.equal(porter2("fertilize"), "fertil");
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
