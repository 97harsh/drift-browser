// Pure helpers (no Electron imports) so they can be unit-tested with `node --test`.

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const HOSTLIKE_RE = /^(localhost|\[[0-9a-f:]+\]|(\d{1,3}\.){3}\d{1,3}|([a-z0-9-]+\.)+[a-z]{2,})(:\d+)?(\/.*)?$/i;

/** Turn whatever the user typed into a URL: a real URL, a bare domain, or a search. */
function toUrl(input, searchTemplate = 'https://www.google.com/search?q=%s') {
  const q = String(input || '').trim();
  if (!q) return null;
  if (/^(https?|file|about|chrome|data|view-source):/i.test(q)) return q;
  if (SCHEME_RE.test(q) && !q.includes(' ') && !/^[a-z0-9-]+:\d+/i.test(q)) {
    // mailto:, etc. Let them through; "localhost:3000" falls to the host check below.
    return q;
  }
  if (!q.includes(' ') && HOSTLIKE_RE.test(q)) {
    const local = /^(localhost|127\.|\[|0\.0\.0\.0|192\.168\.|10\.)/i.test(q);
    return (local ? 'http://' : 'https://') + q;
  }
  return searchTemplate.replace('%s', encodeURIComponent(q));
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Fuzzy-ish score: all query words must appear; earlier and title matches rank higher. */
function score(query, ...fields) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return 0;
  let total = 0;
  for (const w of words) {
    let best = -1;
    fields.forEach((f, i) => {
      const idx = String(f || '').toLowerCase().indexOf(w);
      if (idx >= 0) best = Math.max(best, 100 - Math.min(idx, 60) - i * 15);
    });
    if (best < 0) return 0;
    total += best;
  }
  return total;
}

/** Tabs in the "today" zone idle for longer than `hours` should be archived. */
function staleTodayTabs(tabs, hours, now = Date.now(), keepIds = new Set()) {
  if (!hours || hours <= 0) return [];
  const cutoff = now - hours * 3600 * 1000;
  return tabs.filter((t) => t.zone === 'today' && !keepIds.has(t.id) && (t.lastActive || 0) < cutoff);
}

// Prices in USD per million tokens (Anthropic first-party list prices, Nov 2026).
const PRICING = {
  'claude-opus-5-5': { in: 4, out: 20, cacheRead: 0.2 },
  'claude-sonnet-5-5': { in: 2, out: 10, cacheRead: 0.1 },
  'claude-haiku-5-5': { in: 0.1, out: 0.5, cacheRead: 0.01 },
  'claude-fable-5-2': { in: 8, out: 40, cacheRead: 0.2 },
  'claude-opus-5': { in: 5, out: 25, cacheRead: 0.5 },
  'claude-sonnet-5': { in: 2, out: 10, cacheRead: 0.2 },
  'claude-opus-4-8': { in: 5, out: 25, cacheRead: 0.5 },
};

function priceFor(model) {
  if (PRICING[model]) return PRICING[model];
  const key = Object.keys(PRICING).find((k) => model && model.startsWith(k));
  return key ? PRICING[key] : PRICING['claude-opus-5-5'];
}

/** Estimated cost in USD for one API response's `usage` object. */
function costOf(model, u = {}) {
  const p = priceFor(model);
  const M = 1e6;
  return (
    ((u.input_tokens || 0) * p.in +
      (u.cache_creation_input_tokens || 0) * p.in * 1.25 +
      (u.cache_read_input_tokens || 0) * p.cacheRead +
      (u.output_tokens || 0) * p.out) /
    M
  );
}

function summarizeUsage(entries, now = Date.now()) {
  const day = 86400000;
  const buckets = { today: 0, week: 0, month: 0, all: 0 };
  const byModel = {};
  const byDay = {};
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  for (const e of entries) {
    const c = e.cost || 0;
    buckets.all += c;
    if (e.ts >= startOfToday.getTime()) buckets.today += c;
    if (e.ts >= now - 7 * day) buckets.week += c;
    if (e.ts >= now - 30 * day) buckets.month += c;
    byModel[e.model] = (byModel[e.model] || 0) + c;
    const d = new Date(e.ts).toISOString().slice(0, 10);
    byDay[d] = (byDay[d] || 0) + c;
    tokens.input += e.input_tokens || 0;
    tokens.output += e.output_tokens || 0;
    tokens.cacheRead += e.cache_read_input_tokens || 0;
    tokens.cacheWrite += e.cache_creation_input_tokens || 0;
  }
  return { cost: buckets, byModel, byDay, tokens, requests: entries.length };
}

module.exports = { toUrl, hostOf, score, staleTodayTabs, costOf, priceFor, summarizeUsage, PRICING };
