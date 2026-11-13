const test = require('node:test');
const assert = require('node:assert');
const { toUrl, hostOf, score, staleTodayTabs, costOf, summarizeUsage } = require('../src/main/util');

test('toUrl: urls, domains, localhost and searches', () => {
  const S = 'https://s/?q=%s';
  assert.equal(toUrl('https://a.com/x', S), 'https://a.com/x');
  assert.equal(toUrl('github.com', S), 'https://github.com');
  assert.equal(toUrl('news.ycombinator.com/item?id=1', S), 'https://news.ycombinator.com/item?id=1');
  assert.equal(toUrl('localhost:3000', S), 'http://localhost:3000');
  assert.equal(toUrl('192.168.1.10:8080/x', S), 'http://192.168.1.10:8080/x');
  assert.equal(toUrl('best headphones', S), 'https://s/?q=best%20headphones');
  assert.equal(toUrl('node.js', S), 'https://node.js');
  assert.equal(toUrl('   ', S), null);
});

test('hostOf strips www', () => {
  assert.equal(hostOf('https://www.amazon.com/s?k=x'), 'amazon.com');
  assert.equal(hostOf('not a url'), '');
});

test('score requires every word and prefers early matches', () => {
  assert.equal(score('foo bar', 'foo only'), 0);
  assert.ok(score('git', 'GitHub', 'https://github.com') > score('git', 'My digit', 'x'));
});

test('staleTodayTabs only archives idle today tabs', () => {
  const now = 1e12;
  const tabs = [
    { id: 'a', zone: 'today', lastActive: now - 13 * 3600e3 },
    { id: 'b', zone: 'today', lastActive: now - 1 * 3600e3 },
    { id: 'c', zone: 'pinned', lastActive: 0 },
    { id: 'd', zone: 'today', lastActive: 0 },
  ];
  assert.deepEqual(staleTodayTabs(tabs, 12, now, new Set(['d'])).map((t) => t.id), ['a']);
  assert.deepEqual(staleTodayTabs(tabs, 0, now), []);
});

test('costOf prices tokens per model', () => {
  const c = costOf('claude-opus-5-5', { input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 1e6, cache_creation_input_tokens: 0 });
  assert.equal(c.toFixed(2), (4 + 20 + 0.2).toFixed(2));
  assert.equal(costOf('claude-haiku-5-5', { output_tokens: 2e6 }).toFixed(2), '1.00');
});

test('summarizeUsage buckets by day and model', () => {
  const now = Date.now();
  const s = summarizeUsage([
    { ts: now, model: 'm1', cost: 1, input_tokens: 10 },
    { ts: now - 20 * 86400e3, model: 'm2', cost: 2, output_tokens: 5 },
  ], now);
  assert.equal(s.cost.all, 3);
  assert.equal(s.cost.week, 1);
  assert.equal(s.cost.month, 3);
  assert.equal(s.byModel.m2, 2);
  assert.equal(s.requests, 2);
  assert.equal(s.tokens.input, 10);
});
