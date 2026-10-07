import test from 'node:test';
import assert from 'node:assert/strict';
import { segmentsChinese, CATCHING_UP } from './staging-search-check.mjs';

const path = '0-inbox/cli-live-segmenter-1.md';
const hit = `1 matching note\n\n${path}\n    snippet`;
const miss = '(no matches)';
const sleep = async () => {};
const replies = (list) => { let i = 0; return async () => list[Math.min(i++, list.length - 1)]; };

test('a hit on the written note passes and reports built with the attempt count', async () => {
  const result = await segmentsChinese({ search: replies([miss, `${miss}\n\n${CATCHING_UP}`, hit]), path, sleep, attempts: 5 });
  assert.deepEqual(result, { ok: true, built: true, attempts: 3, pending: false });
});

test('no hit while the index is still catching up fails as pending, not as a segmenter failure', async () => {
  const result = await segmentsChinese({ search: replies([`${miss}\n\n${CATCHING_UP}`]), path, sleep, attempts: 3 });
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 3);
  assert.equal(result.pending, true);
  assert.match(result.reason, /still catching up/);
  assert.match(result.reason, /oversized/);
});

test('no hit with a complete index means v3 is not being served', async () => {
  const result = await segmentsChinese({ search: replies([miss]), path, sleep, attempts: 2 });
  assert.equal(result.ok, false);
  assert.equal(result.pending, false);
  assert.match(result.reason, /v2|segmenter/);
});

test('a hit on some other note does not pass', async () => {
  const result = await segmentsChinese({ search: replies(['1 matching note\n\n1-projects/other.md\n    x']), path, sleep, attempts: 2 });
  assert.equal(result.ok, false);
});

test('the result never carries note text', async () => {
  const result = await segmentsChinese({ search: replies([hit.replace('snippet', '数据库迁移计划已经确认')]), path, sleep, attempts: 1 });
  assert.equal(JSON.stringify(result).includes('数据库'), false);
});
