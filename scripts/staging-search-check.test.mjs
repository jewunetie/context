import test from 'node:test';
import assert from 'node:assert/strict';
import { segmentsChinese } from './staging-search-check.mjs';

const path = '0-inbox/cli-live-segmenter-1.md';
const hit = `1 matching note\n\n${path}\n    snippet`;
const miss = '(no matches)';
const sleep = async () => {};
const replies = (list) => { let i = 0; return async () => list[Math.min(i++, list.length - 1)]; };
const run = (options) => segmentsChinese({ path, sleep, attempts: 3, control: replies([miss]), ...options });

test('a hit on the written note with a clean control passes', async () => {
  const result = await run({ search: replies([miss, miss, hit]), attempts: 5 });
  assert.deepEqual(result, { ok: true, attempts: 3 });
});

test('no hit fails with one fixed reason', async () => {
  const result = await run({ search: replies([`${miss}\n\n[note: the search index is still catching up]`]) });
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 3);
  assert.equal(result.inconclusive, undefined);
  assert.equal(result.reason, 'no hit in 3 attempts; the index may still be building, or the Worker segmenter failed its self-test');
  const other = await run({ search: replies([miss]) });
  assert.equal(other.reason, result.reason);
});

test('a hit on some other note does not pass', async () => {
  const result = await run({ search: replies(['1 matching note\n\n1-projects/other.md\n    x']), attempts: 2 });
  assert.equal(result.ok, false);
});

test('a control search that also hits means the literal scan answered: inconclusive', async () => {
  const result = await run({ search: replies([hit]), control: replies([hit]) });
  assert.equal(result.ok, false);
  assert.equal(result.inconclusive, true);
  assert.match(result.reason, /literal scan/);
});

test('the control is only searched after a hit', async () => {
  let controls = 0;
  await run({ search: replies([miss]), control: async () => { controls += 1; return miss; } });
  assert.equal(controls, 0);
});

test('the result never carries note text', async () => {
  const result = await run({ search: replies([hit.replace('snippet', '数据库迁移计划已经确认')]), control: replies([`x ${path} 数据库`]) });
  assert.equal(JSON.stringify(result).includes('数据库'), false);
});
