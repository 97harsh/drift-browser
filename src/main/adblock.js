// Ad, tracker and annoyance (cookie banner) blocking via Ghostery's engine,
// which speaks EasyList/uBlock filter syntax and does cosmetic filtering too.
const { ipcMain } = require('electron');
const { ElectronBlocker } = require('@ghostery/adblocker-electron');

// The Ghostery helper registers *global* ipcMain handlers per session it is
// enabled in, which throws on the second session (Drift uses one session per
// profile). The handlers only call into the shared blocker, so we clear them
// before each enable and restore them after a disable.
const CHANNELS = ['@ghostery/adblocker/inject-cosmetic-filters', '@ghostery/adblocker/is-mutation-observer-enabled'];
function clearHandlers() {
  CHANNELS.forEach((c) => ipcMain.removeHandler(c));
}
const fetch = require('cross-fetch');
const fs = require('fs/promises');
const path = require('path');

class AdBlock {
  constructor(cacheDir) {
    this.cacheDir = cacheDir;
    this.blocker = null;
    this.level = null;
    this.sessions = new Set();
    this.enabledSessions = new Set();
    this.stats = { total: 0, byTab: new Map() }; // webContentsId -> count
    this.onBlocked = () => {};
  }

  async load(level = 'full') {
    if (this.blocker && this.level === level) return this.blocker;
    const caching = {
      path: path.join(this.cacheDir, `adblock-${level}.bin`),
      read: fs.readFile,
      write: fs.writeFile,
    };
    const factory = {
      ads: 'fromPrebuiltAdsOnly',
      'ads-tracking': 'fromPrebuiltAdsAndTracking',
      full: 'fromPrebuiltFull',
    }[level] || 'fromPrebuiltFull';
    const old = [...this.enabledSessions];
    old.forEach((s) => this.disable(s));
    this.blocker = await ElectronBlocker[factory](fetch, caching);
    this.level = level;
    this.blocker.on('request-blocked', (req) => {
      this.stats.total++;
      const id = req.tabId;
      if (id != null) this.stats.byTab.set(id, (this.stats.byTab.get(id) || 0) + 1);
      this.onBlocked(id);
    });
    old.forEach((s) => this.enable(s));
    return this.blocker;
  }

  enable(ses) {
    this.sessions.add(ses);
    if (!this.blocker || this.enabledSessions.has(ses)) return;
    clearHandlers();
    this.blocker.enableBlockingInSession(ses);
    this.enabledSessions.add(ses);
  }

  disable(ses) {
    if (!this.blocker || !this.enabledSessions.has(ses)) return;
    this.blocker.disableBlockingInSession(ses);
    this.enabledSessions.delete(ses);
    // Re-arm the shared cosmetic-filter handlers for the sessions still on.
    const still = [...this.enabledSessions];
    if (still.length) {
      this.blocker.disableBlockingInSession(still[0]);
      clearHandlers();
      this.blocker.enableBlockingInSession(still[0]);
    }
  }

  async setEnabled(on, level) {
    if (on) {
      await this.load(level);
      this.sessions.forEach((s) => this.enable(s));
    } else {
      [...this.enabledSessions].forEach((s) => this.disable(s));
    }
  }

  countFor(webContentsId) {
    return this.stats.byTab.get(webContentsId) || 0;
  }

  resetTab(webContentsId) {
    this.stats.byTab.delete(webContentsId);
  }
}

module.exports = { AdBlock };
