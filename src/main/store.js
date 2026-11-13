// Tiny JSON-file persistence with debounced writes. Everything Drift remembers
// (spaces, tabs, history, boosts, settings, usage) lives in one state object.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SPACE_COLORS = ['#7c6cf2', '#f2766c', '#3fb68b', '#e0a43a', '#4c9be8', '#d16ac9'];

function defaultState() {
  const spaceId = uid();
  return {
    version: 1,
    settings: {
      searchEngine: 'https://www.google.com/search?q=%s',
      sidebarWidth: 260,
      sidebarCollapsed: false,
      autoArchiveHours: 12,
      adblock: true,
      adblockLevel: 'full', // 'ads' | 'ads-tracking' | 'full' (adds annoyances/cookie banners)
      autoPip: true,
      claude: {
        apiKey: '', // stored encrypted with safeStorage (see secrets.js); empty -> env / ant profile
        model: 'claude-opus-5-5',
        effort: 'medium',
        approvals: 'ask', // 'ask' (confirm page-changing actions) | 'auto'
        panelWidth: 380,
      },
      control: {
        enabled: true,
        port: 9555,
        host: '127.0.0.1',
        token: crypto.randomBytes(24).toString('hex'),
      },
      cdp: { enabled: false, port: 9222 },
    },
    spaces: [{ id: spaceId, name: 'Personal', color: SPACE_COLORS[0], icon: '✦' }],
    activeSpaceId: spaceId,
    activeTabBySpace: {},
    tabs: [], // {id, zone: 'favorite'|'pinned'|'today', spaceId, url, title, favicon, pinnedUrl, lastActive, order}
    archived: [], // closed/auto-archived today tabs, newest first
    history: [], // {url, title, ts}
    boosts: {}, // host -> {css, js, enabled}
    usage: [], // Claude API usage ledger
  };
}

function uid() {
  return crypto.randomBytes(6).toString('base64url');
}

function deepMerge(base, over) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over ?? base;
  const out = { ...base };
  for (const k of Object.keys(over || {})) {
    out[k] = k in base ? deepMerge(base[k], over[k]) : over[k];
  }
  return out;
}

class Store {
  constructor(dir) {
    this.file = path.join(dir, 'drift-state.json');
    this.state = defaultState();
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.state = deepMerge(defaultState(), raw);
      // Arrays from disk win wholesale.
      for (const k of ['spaces', 'tabs', 'archived', 'history', 'usage']) {
        if (Array.isArray(raw[k])) this.state[k] = raw[k];
      }
      if (!this.state.spaces.length) this.state.spaces = defaultState().spaces;
    } catch {
      /* first run */
    }
    this._timer = null;
  }

  get s() {
    return this.state;
  }

  save() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 400);
  }

  flush() {
    clearTimeout(this._timer);
    const tmp = this.file + '.tmp';
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Store, uid, SPACE_COLORS, defaultState };
