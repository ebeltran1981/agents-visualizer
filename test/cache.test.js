import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState, ingest, cacheSummary, hitRate } from '../aggregate.js';

const OPUS = 'claude-opus-5-5';  // $4 in, $0.20 cache read, $5 5-minute write, $8 1-hour write per 1M
const T0 = Date.parse('2026-11-03T10:00:00Z');
const at = min => new Date(T0 + min * 60_000).toISOString();
const u = (o = {}) => ({ in: 0, out: 0, cr: 0, cw: 0, cw1h: 0, ...o });
const msg = (id, min, usage, model = OPUS) => ({ t: 'a', ts: at(min), id, model, u: u(usage), adv: [], tools: [], text: 'ok' });

function run(records, agent = 'main') {
  const s = createState(), rows = [];
  for (const r of records) rows.push(...ingest(s, agent, r));
  return { s, rows, cache: rows.filter(r => r.action === 'cache') };
}

test('a prefix rewritten after an idle gap past the 1-hour cache is a break', () => {
  const { s, cache } = run([
    msg('m1', 0, { cw1h: 50_000 }),
    msg('m2', 1, { cr: 50_000, cw1h: 2_000 }),
    msg('m3', 121, { cw1h: 55_000 }),
  ]);
  assert.equal(cache.length, 1);
  assert.equal(cache[0].detail, 'rewrote 55k · idle 120 min > 1h cache · $0.44');
  const b = s.agents.get('main').breaks;
  assert.deepEqual(b.map(x => [x.id, x.cause, x.tokens]), [['m3', 'idle 120 min > 1h cache', 55_000]]);
});

test('a model switch that rewrites the prefix is a break with that cause', () => {
  const { cache } = run([
    msg('m1', 0, { cw: 40_000 }),
    msg('m2', 1, { cr: 40_000, cw: 1_000 }),
    msg('m3', 2, { cw: 42_000 }, 'claude-sonnet-5-5'),
  ]);
  assert.equal(cache.length, 1);
  assert.match(cache[0].detail, /model changed/);
});

test('on a provider that caches automatically, a miss shows as fresh input and is a break', () => {
  const { s, cache } = run([
    msg('m1', 0, { in: 20_000 }, 'deepseek-v4-pro'),
    msg('m2', 1, { in: 2_000, cr: 20_000 }, 'deepseek-v4-pro'),
    msg('m3', 30, { in: 23_000 }, 'deepseek-v4-pro'),
  ]);
  assert.deepEqual(cache.map(r => r.detail), ['rewrote 23k · idle 29 min']);  // no lifetime or price known
  assert.equal(cacheSummary(s).main.ttl, null);
});

test('a large new input on top of a kept prefix is not a break', () => {
  const { cache } = run([
    msg('m1', 0, { cw: 40_000 }),
    msg('m2', 1, { cr: 40_000, cw: 30_000 }),
  ]);
  assert.equal(cache.length, 0);
});

test('lines repeating one message are one request', () => {
  const { s, cache } = run([
    msg('m1', 0, { cw: 40_000 }),
    msg('m2', 90, { cw: 41_000 }),
    msg('m2', 90, { cw: 41_000, out: 500 }),
  ]);
  assert.equal(cache.length, 1);
  assert.equal(s.agents.get('main').breaks.length, 1);
});

test('usage summed over several steps (opencode) is not checked for breaks', () => {
  const { cache } = run([
    { ...msg('m1', 0, { in: 30_000, cr: 90_000 }), summed: true },
    { ...msg('m2', 1, { in: 5_000, cr: 10_000 }), summed: true },
  ]);
  assert.equal(cache.length, 0);
});

test('a summed message (a Claude Code advisor call) is no baseline, but keeps the cache warm', () => {
  const { s, cache } = run([
    msg('m1', 0, { cr: 170_000, cw1h: 2_000 }),
    { ...msg('m2', 30, { cr: 340_000, cw: 2_000, cw1h: 3_000 }), summed: true },  // two model runs added up
    msg('m3', 31, { cr: 171_000, cw1h: 2_500 }),
  ]);
  assert.equal(cache.length, 0);
  const { s: s2 } = run([msg('m1', 0, { cr: 170_000, cw1h: 2_000 }), { ...msg('m2', 30, { cr: 340_000, cw1h: 3_000 }), summed: true }]);
  assert.equal(cacheSummary(s2).main.expiresAt, T0 + 90 * 60_000);  // 30 min + the 1-hour cache
  assert.equal(s.agents.get('main').breaks.length, 0);
});

test('savings: the read discount minus the write premium, at list price', () => {
  const { s } = run([msg('m1', 0, { cr: 1_000_000, cw: 100_000, cw1h: 100_000 })]);
  // 1M × (4 − 0.20) − 100k × (5 − 4) − 100k × (8 − 4) = 3.80 − 0.10 − 0.40
  assert.equal(cacheSummary(s).saved.toFixed(2), '3.30');
});

test('without prices or single requests, savings and breaks are unknown, not zero', () => {
  const { s } = run([{ ...msg('m1', 0, { in: 5_000, cr: 20_000 }, 'deepseek-v4-pro'), summed: true }]);
  const c = cacheSummary(s);
  assert.equal(c.saved, null);
  assert.equal(c.tracked, false);
  assert.equal(c.hit, 0.8);
});

test('hit rate is cache reads over all input', () => {
  assert.equal(hitRate(u({ in: 10, cr: 60, cw: 20, cw1h: 10 })), 0.6);
  assert.equal(hitRate(u()), null);
});

test('main cache lifetime: warm until the last request plus its TTL, then a rewrite estimate', () => {
  const { s } = run([msg('m1', 0, { cw: 10_000 }), msg('m2', 2, { cr: 10_000, cw: 2_000 })]);
  const warm = cacheSummary(s).main;
  assert.equal(warm.ttl, 300_000);
  assert.equal(warm.expiresAt, T0 + 7 * 60_000);
  const cold = cacheSummary(s).main;
  assert.equal(cold.prefix, 12_000);
  assert.equal(cold.rewriteCost.toFixed(3), '0.060');  // 12k at the $5 5-minute write rate
});

test('subagent warm-up is the cost of each subagent first, uncached request', () => {
  const s = createState();
  ingest(s, 'main', msg('m1', 0, { cw: 10_000 }));
  ingest(s, 'a1', msg('s1', 1, { in: 100, cw: 20_000 }));
  ingest(s, 'a1', msg('s2', 2, { cr: 20_000, cw: 500 }));
  // 100 × $4 + 20k × $5 per 1M
  assert.equal(cacheSummary(s).warmup.toFixed(4), '0.1004');
});
