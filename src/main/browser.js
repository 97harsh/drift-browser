// The Drift main window: a sidebar UI view plus one WebContentsView per loaded tab.
// Tabs belong to spaces (pinned / today zones) or are global favorites, like Arc.
const { BaseWindow, WebContentsView, session, Menu, clipboard, shell, app, net, nativeTheme, dialog } = require('electron');
const path = require('path');
const { uid, SPACE_COLORS } = require('./store');
const { toUrl, hostOf, staleTodayTabs } = require('./util');
const scripts = require('./pagescripts');

const PAD = 8; // inset around web content, Arc-style
const GAP = 6; // gap between split panes
const MAX_LOG = 300;

class Browser {
  constructor({ store, adblock, extensions }) {
    this.store = store;
    this.adblock = adblock;
    this.extensions = extensions;
    if (extensions) extensions.getBrowser = () => this;
    this.views = new Map(); // tabId -> WebContentsView
    this.rt = new Map(); // tabId -> runtime state {loading, audible, playing, canGoBack, canGoForward, crashed}
    this.consoleLogs = new Map(); // webContentsId -> [{level, message, source, line, ts}]
    this.networkLogs = new Map(); // webContentsId -> [{url, method, status, type, ts, error, fromCache}]
    this.sessions = new Map(); // profile -> Session
    this.split = null; // {left, right, ratio}
    this.peek = null; // {view, opener}
    this.overlay = false;
    this.claudeOpen = false;
    this.fullscreenTab = null;
    this.findResult = null;
    this.downloads = [];
    this.listeners = new Set();
    this._emitTimer = null;

    this.win = new BaseWindow({
      width: 1440,
      height: 920,
      minWidth: 640,
      minHeight: 420,
      title: 'Drift',
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 18 },
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#1d1b22' : '#ece9f3',
      vibrancy: 'sidebar',
      visualEffectState: 'followWindow',
    });

    this.ui = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'ui.js'),
        contextIsolation: true,
        sandbox: false,
      },
    });
    this.ui.setBackgroundColor('#00000000');
    this.win.contentView.addChildView(this.ui);
    this.ui.webContents.loadFile(path.join(__dirname, '..', 'ui', 'index.html'));
    this.ui.webContents.on('did-finish-load', () => this.emitState(true));

    this.win.on('resize', () => this.layout());
    this.win.on('enter-full-screen', () => this.layout());
    this.win.on('leave-full-screen', () => this.layout());
    this.win.on('focus', () => this.focusActive());
    this.win.on('close', () => this.store.flush());

    this.archiveTimer = setInterval(() => this.autoArchive(), 10 * 60 * 1000);
    this.autoArchive();

    const t = this.activeTab();
    if (t) this.activate(t.id);
    this.layout();
  }

  // ---------- state helpers ----------
  get s() {
    return this.store.s;
  }
  get settings() {
    return this.s.settings;
  }
  space(id = this.s.activeSpaceId) {
    return this.s.spaces.find((sp) => sp.id === id) || this.s.spaces[0];
  }
  tab(id) {
    return this.s.tabs.find((t) => t.id === id);
  }
  activeTabId() {
    return this.s.activeTabBySpace[this.s.activeSpaceId] || null;
  }
  activeTab() {
    return this.tab(this.activeTabId());
  }
  tabsIn(spaceId, zone) {
    return this.s.tabs.filter((t) => t.zone === zone && (zone === 'favorite' || t.spaceId === spaceId)).sort((a, b) => a.order - b.order);
  }
  wcOf(tabId) {
    const v = this.views.get(tabId);
    return v && !v.webContents.isDestroyed() ? v.webContents : null;
  }
  tabByWebContents(wc) {
    for (const [id, v] of this.views) if (v.webContents === wc) return this.tab(id);
    return null;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ---------- sessions / profiles ----------
  getSession(profile = 'default') {
    if (this.sessions.has(profile)) return this.sessions.get(profile);
    const ses = session.fromPartition(`persist:drift-${profile}`);
    // Look like plain Chrome — some sites refuse "Electron" user agents.
    ses.setUserAgent(ses.getUserAgent().replace(/\s(Electron|drift-browser|Drift)\/\S+/g, ''));
    if (this.settings.adblock) this.adblock.enable(ses);
    else this.adblock.sessions.add(ses);
    if (this.extensions) this.extensions.setup(ses);

    const logNet = (d, extra) => {
      if (d.webContentsId == null) return;
      const arr = this.networkLogs.get(d.webContentsId) || [];
      arr.push({ url: d.url.slice(0, 500), method: d.method, type: d.resourceType, ts: Date.now(), ...extra });
      if (arr.length > MAX_LOG) arr.splice(0, arr.length - MAX_LOG);
      this.networkLogs.set(d.webContentsId, arr);
    };
    ses.webRequest.onCompleted((d) => logNet(d, { status: d.statusCode, fromCache: d.fromCache }));
    ses.webRequest.onErrorOccurred((d) => logNet(d, { error: d.error }));

    ses.setPermissionRequestHandler((wc, permission, cb, details) => this.askPermission(wc, permission, cb, details));

    ses.on('will-download', (_e, item) => {
      const dl = { id: uid(), name: item.getFilename(), total: item.getTotalBytes(), received: 0, state: 'progressing' };
      item.setSavePath(path.join(app.getPath('downloads'), item.getFilename()));
      this.downloads.unshift(dl);
      this.downloads = this.downloads.slice(0, 20);
      item.on('updated', (_ev, state) => {
        dl.received = item.getReceivedBytes();
        dl.state = state;
        this.emitState();
      });
      item.once('done', (_ev, state) => {
        dl.state = state;
        dl.path = item.getSavePath();
        this.emitState();
      });
      this.emitState();
    });
    this.sessions.set(profile, ses);
    return ses;
  }

  /** Harmless permissions are granted; camera/mic/location/notifications ask once per site per session. */
  askPermission(wc, permission, cb, details) {
    const auto = ['fullscreen', 'clipboard-sanitized-write', 'pointerLock'];
    const ask = { media: 'use your camera / microphone', geolocation: 'know your location', notifications: 'show notifications' };
    if (auto.includes(permission)) return cb(true);
    if (!ask[permission]) return cb(false);
    let origin = 'This site';
    try {
      origin = new URL(details.requestingUrl || wc.getURL()).origin;
    } catch {}
    this.permCache = this.permCache || new Map();
    const key = `${origin}|${permission}`;
    if (this.permCache.has(key)) return cb(this.permCache.get(key));
    dialog
      .showMessageBox(this.win, { type: 'question', message: `${origin} wants to ${ask[permission]}`, buttons: ['Allow', 'Block'], defaultId: 1, cancelId: 1 })
      .then(({ response }) => {
        this.permCache.set(key, response === 0);
        cb(response === 0);
      });
  }

  profileFor(tab) {
    if (!tab || tab.zone === 'favorite') return this.space().profile || 'default';
    return this.space(tab.spaceId).profile || 'default';
  }

  // ---------- tabs ----------
  createTab({ url, zone = 'today', spaceId, activate = true, after, title, routed } = {}) {
    const target = toUrl(url, this.settings.searchEngine) || 'about:blank';
    if (!spaceId && !routed) spaceId = this.routeSpace(target) || this.s.activeSpaceId;
    spaceId = spaceId || this.s.activeSpaceId;
    const siblings = this.tabsIn(spaceId, zone);
    let order = zone === 'today' ? Math.min(0, ...siblings.map((t) => t.order)) - 1 : Math.max(0, ...siblings.map((t) => t.order)) + 1;
    if (after) {
      const a = this.tab(after);
      if (a && a.zone === zone) order = a.order + 0.5;
    }
    const tab = {
      id: uid(),
      zone,
      spaceId: zone === 'favorite' ? null : spaceId,
      url: target,
      title: title || target,
      favicon: '',
      pinnedUrl: zone === 'today' ? null : target,
      lastActive: Date.now(),
      order,
    };
    this.s.tabs.push(tab);
    this.normalizeOrder(spaceId, zone);
    if (activate) this.activate(tab.id);
    else this.ensureView(tab);
    this.store.save();
    this.emitState();
    return tab;
  }

  normalizeOrder(spaceId, zone) {
    this.tabsIn(spaceId, zone).forEach((t, i) => (t.order = i));
  }

  ensureView(tab) {
    if (this.views.has(tab.id)) return this.views.get(tab.id);
    const view = new WebContentsView({
      webPreferences: {
        session: this.getSession(this.profileFor(tab)),
        contextIsolation: true,
        sandbox: true,
        spellcheck: true,
      },
    });
    view.setBackgroundColor('#ffffff');
    if (view.setBorderRadius) view.setBorderRadius(10);
    this.views.set(tab.id, view);
    this.rt.set(tab.id, { loading: true });
    this.wireWebContents(tab.id, view.webContents);
    const wc = view.webContents;
    if (this.extensions) {
      this.extensions.addTab(wc, this.win);
      // Load the page only after the profile's extensions are loaded, so their content scripts run.
      this.extensions.ready(wc.session).then(() => !wc.isDestroyed() && wc.loadURL(tab.url).catch(() => {}));
    } else wc.loadURL(tab.url).catch(() => {});
    return view;
  }

  wireWebContents(tabId, wc) {
    wc.setMaxListeners(40);
    const rt = () => this.rt.get(tabId) || {};
    const tab = () => this.tab(tabId);
    const upd = () => {
      const r = rt();
      r.canGoBack = wc.navigationHistory.canGoBack();
      r.canGoForward = wc.navigationHistory.canGoForward();
      this.emitState();
    };
    wc.on('page-title-updated', (_e, title) => {
      const t = tab();
      if (!t) return;
      t.title = title;
      const h = this.s.history[0];
      if (h && h.url === t.url) h.title = title;
      this.store.save();
      this.emitState();
    });
    wc.on('page-favicon-updated', (_e, icons) => {
      const t = tab();
      if (t && icons[0]) {
        t.favicon = icons[0];
        this.store.save();
        this.emitState();
      }
    });
    wc.on('did-navigate', (_e, url) => {
      const t = tab();
      if (!t) return;
      t.url = url;
      this.adblock.resetTab(wc.id);
      this.pushHistory(url, wc.getTitle());
      this.applyBoost(wc, url);
      this.store.save();
      upd();
    });
    wc.on('did-navigate-in-page', (_e, url, isMain) => {
      const t = tab();
      if (t && isMain) {
        t.url = url;
        this.store.save();
        upd();
      }
    });
    wc.on('did-start-loading', () => {
      rt().loading = true;
      this.emitState();
    });
    wc.on('did-stop-loading', () => {
      rt().loading = false;
      upd();
    });
    wc.on('dom-ready', () => this.applyBoost(wc, wc.getURL()));
    wc.on('audio-state-changed', (e) => {
      rt().audible = e.audible;
      this.emitState();
    });
    wc.on('media-started-playing', () => {
      rt().playing = true;
      this.emitState();
    });
    wc.on('media-paused', () => {
      rt().playing = false;
      this.emitState();
    });
    wc.on('enter-html-full-screen', () => {
      this.fullscreenTab = tabId;
      this.layout();
    });
    wc.on('leave-html-full-screen', () => {
      this.fullscreenTab = null;
      this.layout();
    });
    wc.on('found-in-page', (_e, result) => {
      this.findResult = { active: result.activeMatchOrdinal, total: result.matches };
      this.emitState();
    });
    wc.on('render-process-gone', (_e, details) => {
      rt().crashed = details.reason;
      this.emitState();
    });
    wc.on('console-message', (...args) => {
      // Electron >= 35 passes a single details object; older passes positional args.
      const d = args[0] && args[0].message !== undefined ? args[0] : { level: args[1], message: args[2], lineNumber: args[3], sourceId: args[4] };
      const arr = this.consoleLogs.get(wc.id) || [];
      arr.push({ level: d.level, message: String(d.message).slice(0, 2000), source: d.sourceId, line: d.lineNumber, ts: Date.now() });
      if (arr.length > MAX_LOG) arr.splice(0, arr.length - MAX_LOG);
      this.consoleLogs.set(wc.id, arr);
    });
    wc.on('context-menu', (_e, params) => this.contextMenu(tabId, wc, params));
    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (disposition === 'new-window') {
        // Real popups (OAuth, payment flows) need window.opener — let them open.
        return { action: 'allow', overrideBrowserWindowOptions: { width: 520, height: 720, autoHideMenuBar: true } };
      }
      const t = tab();
      const fromPinned = t && t.zone !== 'today';
      if (fromPinned && hostOf(url) !== hostOf(t.url) && disposition === 'foreground-tab') {
        this.openPeek(url, tabId);
      } else {
        this.createTab({ url, after: tabId, spaceId: t?.spaceId || undefined, activate: disposition !== 'background-tab', routed: true });
      }
      return { action: 'deny' };
    });
  }

  contextMenu(tabId, wc, p) {
    const items = [];
    if (p.linkURL) {
      items.push(
        { label: 'Open Link in New Tab', click: () => this.createTab({ url: p.linkURL, after: tabId, activate: false }) },
        { label: 'Open Link in Peek', click: () => this.openPeek(p.linkURL, tabId) },
        { label: 'Open Link in Split View', click: () => this.splitWithUrl(p.linkURL) },
        { label: 'Copy Link', click: () => clipboard.writeText(p.linkURL) },
        { type: 'separator' },
      );
    }
    if (p.mediaType === 'video') {
      items.push({ label: 'Picture in Picture', click: () => this.pip(tabId) }, { type: 'separator' });
    }
    if (p.mediaType === 'image' && p.srcURL) {
      items.push(
        { label: 'Open Image in New Tab', click: () => this.createTab({ url: p.srcURL, after: tabId }) },
        { label: 'Copy Image', click: () => wc.copyImageAt(p.x, p.y) },
        { type: 'separator' },
      );
    }
    if (p.selectionText) {
      const sel = p.selectionText.trim();
      items.push(
        { label: 'Copy', role: 'copy' },
        { label: `Search for “${sel.slice(0, 24)}${sel.length > 24 ? '…' : ''}”`, click: () => this.createTab({ url: this.settings.searchEngine.replace('%s', encodeURIComponent(sel)), after: tabId }) },
        { label: 'Ask Claude about Selection', click: () => this.sendUI('claude:prefill', `About this selection from ${wc.getURL()}:\n\n> ${sel}\n\n`) },
        { type: 'separator' },
      );
    }
    if (p.isEditable) items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }, { type: 'separator' });
    items.push(
      { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
      { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
      { label: 'Reload', click: () => wc.reload() },
      { type: 'separator' },
      ...(() => {
        const ext = this.extensions ? this.extensions.contextMenuItems(wc, p) : [];
        return ext.length ? [{ type: 'separator' }, ...ext, { type: 'separator' }] : [];
      })(),
      { label: 'Ask Claude about this Page', click: () => this.sendUI('claude:prefill', 'Summarize this page for me.') },
      { label: 'Inspect Element', click: () => wc.inspectElement(p.x, p.y) },
    );
    Menu.buildFromTemplate(items).popup();
  }

  pushHistory(url, title) {
    if (!/^https?:/.test(url)) return;
    const h = this.s.history;
    if (h[0] && h[0].url === url) return;
    h.unshift({ url, title: title || url, ts: Date.now() });
    if (h.length > 5000) h.length = 5000;
  }

  activate(tabId, { fromSpaceSwitch } = {}) {
    const tab = this.tab(tabId);
    if (!tab) return;
    const prev = this.activeTab();
    if (tab.zone !== 'favorite' && tab.spaceId !== this.s.activeSpaceId) {
      this.s.activeSpaceId = tab.spaceId;
    }
    if (prev && prev.id !== tabId && !fromSpaceSwitch) this.maybeAutoPip(prev.id, tabId);
    this.s.activeTabBySpace[this.s.activeSpaceId] = tabId;
    tab.lastActive = Date.now();
    if (this.split && ![this.split.left, this.split.right].includes(tabId)) this.split = null;
    this.ensureView(tab);
    if (this.extensions) this.extensions.selectTab(this.wcOf(tabId));
    this.layout();
    this.focusActive();
    this.store.save();
    this.emitState();
  }

  async maybeAutoPip(fromId, toId) {
    if (!this.settings.autoPip) return;
    if (this.split && [this.split.left, this.split.right].includes(fromId) && [this.split.left, this.split.right].includes(toId)) return;
    const wc = this.wcOf(fromId);
    if (!wc) return;
    try {
      const playing = await wc.executeJavaScript(scripts.HAS_PLAYING_VIDEO);
      if (playing) await wc.executeJavaScript(scripts.PIP, true);
    } catch {
      /* page may block PiP */
    }
  }

  focusActive() {
    if (this.overlay) return;
    const wc = this.wcOf(this.activeTabId());
    if (wc) wc.focus();
    else this.ui.webContents.focus();
  }

  closeTab(tabId = this.activeTabId()) {
    const tab = this.tab(tabId);
    if (!tab) return;
    const siblings = this.visibleOrder();
    const idx = siblings.findIndex((t) => t.id === tabId);
    this.destroyView(tabId);
    if (tab.zone === 'today') {
      this.s.tabs = this.s.tabs.filter((t) => t.id !== tabId);
      this.archive(tab, 'closed');
    } else {
      // Pinned & favorites stay put; closing just unloads them (and resets to their pinned URL).
      tab.url = tab.pinnedUrl || tab.url;
    }
    if (this.split && [this.split.left, this.split.right].includes(tabId)) this.split = null;
    if (this.activeTabId() === tabId) {
      const rest = this.visibleOrder().filter((t) => t.id !== tabId && (t.zone === 'today' || this.views.has(t.id)));
      const next = rest[Math.min(idx, rest.length - 1)] || rest[idx - 1];
      if (next) this.activate(next.id);
      else {
        delete this.s.activeTabBySpace[this.s.activeSpaceId];
        this.layout();
      }
    }
    this.store.save();
    this.emitState();
  }

  destroyView(tabId) {
    const v = this.views.get(tabId);
    if (!v) return;
    try {
      this.win.contentView.removeChildView(v);
    } catch {}
    if (!v.webContents.isDestroyed()) {
      if (this.extensions) this.extensions.removeTab(v.webContents);
      this.consoleLogs.delete(v.webContents.id);
      this.networkLogs.delete(v.webContents.id);
      v.webContents.close();
    }
    this.views.delete(tabId);
    this.rt.delete(tabId);
  }

  archive(tab, reason) {
    this.s.archived.unshift({ ...tab, archivedAt: Date.now(), reason });
    if (this.s.archived.length > 500) this.s.archived.length = 500;
  }

  reopenClosed() {
    const t = this.s.archived.shift();
    if (t) this.createTab({ url: t.url, spaceId: this.space(t.spaceId) ? t.spaceId : undefined, title: t.title });
  }

  autoArchive() {
    const keep = new Set([this.activeTabId(), ...Object.values(this.s.activeTabBySpace)]);
    for (const [id, r] of this.rt) if (r.audible || r.playing) keep.add(id);
    const stale = staleTodayTabs(this.s.tabs, this.settings.autoArchiveHours, Date.now(), keep);
    if (!stale.length) return;
    for (const t of stale) {
      this.destroyView(t.id);
      this.archive(t, 'auto');
    }
    const ids = new Set(stale.map((t) => t.id));
    this.s.tabs = this.s.tabs.filter((t) => !ids.has(t.id));
    this.store.save();
    this.emitState();
  }

  /** Order tabs appear in the sidebar: favorites, pinned, today. */
  visibleOrder() {
    const sp = this.s.activeSpaceId;
    return [...this.tabsIn(sp, 'favorite'), ...this.tabsIn(sp, 'pinned'), ...this.tabsIn(sp, 'today')];
  }

  cycleTab(delta) {
    const list = this.visibleOrder();
    if (!list.length) return;
    const i = list.findIndex((t) => t.id === this.activeTabId());
    this.activate(list[(i + delta + list.length) % list.length].id);
  }

  moveTab(tabId, zone, beforeId) {
    const tab = this.tab(tabId);
    if (!tab) return;
    const spaceId = zone === 'favorite' ? null : tab.spaceId || this.s.activeSpaceId;
    if (zone !== tab.zone) {
      if (zone !== 'today') tab.pinnedUrl = tab.url;
      tab.zone = zone;
      tab.spaceId = spaceId;
      if (zone === 'favorite' && this.views.has(tabId)) {
        // Favorites use the active space's profile; recreate if it differs.
      }
    }
    const list = this.tabsIn(this.s.activeSpaceId, zone).filter((t) => t.id !== tabId);
    const at = beforeId ? list.findIndex((t) => t.id === beforeId) : -1;
    list.splice(at < 0 ? list.length : at, 0, tab);
    list.forEach((t, i) => (t.order = i));
    this.store.save();
    this.emitState();
  }

  moveTabToSpace(tabId, spaceId) {
    const tab = this.tab(tabId);
    if (!tab || tab.zone === 'favorite') return;
    const profileChanged = this.profileFor(tab) !== (this.space(spaceId).profile || 'default');
    tab.spaceId = spaceId;
    tab.order = -1;
    this.normalizeOrder(spaceId, tab.zone);
    if (profileChanged) this.destroyView(tabId);
    if (this.activeTabId() === tabId) {
      delete this.s.activeTabBySpace[this.s.activeSpaceId];
      this.activate(tabId);
    }
    this.store.save();
    this.emitState();
  }

  navigate(tabId, input) {
    const url = toUrl(input, this.settings.searchEngine);
    if (!url) return;
    const tab = this.tab(tabId);
    if (!tab) return this.createTab({ url });
    tab.url = url;
    const wc = this.wcOf(tabId);
    if (wc) wc.loadURL(url).catch(() => {});
    else this.ensureView(tab);
    this.store.save();
    this.emitState();
  }

  // ---------- spaces ----------
  switchSpace(spaceId) {
    if (!this.space(spaceId) || spaceId === this.s.activeSpaceId) return;
    this.s.activeSpaceId = spaceId;
    this.split = null;
    const id = this.s.activeTabBySpace[spaceId];
    if (id && this.tab(id)) this.activate(id, { fromSpaceSwitch: true });
    else this.layout();
    this.store.save();
    this.emitState();
  }

  cycleSpace(delta) {
    const sp = this.s.spaces;
    const i = sp.findIndex((x) => x.id === this.s.activeSpaceId);
    this.switchSpace(sp[(i + delta + sp.length) % sp.length].id);
  }

  addSpace({ name, color, icon, profile } = {}) {
    const n = this.s.spaces.length;
    const sp = { id: uid(), name: name || `Space ${n + 1}`, color: color || SPACE_COLORS[n % SPACE_COLORS.length], icon: icon || '●', profile: profile || 'default' };
    this.s.spaces.push(sp);
    this.switchSpace(sp.id);
    this.store.save();
    this.emitState();
    return sp;
  }

  updateSpace(id, patch) {
    const sp = this.space(id);
    if (!sp) return;
    const profileChanged = patch.profile && patch.profile !== (sp.profile || 'default');
    Object.assign(sp, patch);
    if (profileChanged) this.s.tabs.filter((t) => t.spaceId === id).forEach((t) => this.destroyView(t.id));
    if (profileChanged && id === this.s.activeSpaceId && this.activeTab()) this.activate(this.activeTabId());
    this.store.save();
    this.emitState();
  }

  deleteSpace(id) {
    if (this.s.spaces.length <= 1) return;
    this.s.tabs.filter((t) => t.spaceId === id).forEach((t) => {
      this.destroyView(t.id);
      this.archive(t, 'space-deleted');
    });
    this.s.tabs = this.s.tabs.filter((t) => t.spaceId !== id);
    this.s.spaces = this.s.spaces.filter((s) => s.id !== id);
    delete this.s.activeTabBySpace[id];
    if (this.s.activeSpaceId === id) this.switchSpace(this.s.spaces[0].id);
    this.store.save();
    this.emitState();
  }

  /** Air Traffic Control: route URLs to spaces by host pattern. */
  routeSpace(url) {
    const host = hostOf(url);
    for (const r of this.settings.routes || []) {
      if (!r.pattern || !this.space(r.spaceId)) continue;
      const p = r.pattern.replace(/^\*\./, '').toLowerCase();
      if (host === p || host.endsWith('.' + p) || url.includes(r.pattern)) return r.spaceId;
    }
    return null;
  }

  // ---------- split view ----------
  splitWith(otherId) {
    const a = this.activeTabId();
    if (!a || !otherId || a === otherId) return;
    this.ensureView(this.tab(otherId));
    this.split = { left: a, right: otherId, ratio: 0.5 };
    this.layout();
    this.emitState();
  }
  splitWithUrl(url) {
    const a = this.activeTabId();
    const t = this.createTab({ url, after: a, activate: false });
    if (a) this.splitWith(t.id);
    else this.activate(t.id);
  }
  setSplitRatio(r) {
    if (!this.split) return;
    this.split.ratio = Math.min(0.85, Math.max(0.15, r));
    this.layout();
  }
  swapSplit() {
    if (!this.split) return;
    [this.split.left, this.split.right] = [this.split.right, this.split.left];
    this.layout();
    this.emitState();
  }
  closeSplit() {
    this.split = null;
    this.layout();
    this.emitState();
  }

  // ---------- peek ----------
  openPeek(url, openerId) {
    this.closePeek();
    const view = new WebContentsView({
      webPreferences: { session: this.getSession(this.profileFor(this.tab(openerId))), sandbox: true, contextIsolation: true },
    });
    view.setBackgroundColor('#ffffff');
    if (view.setBorderRadius) view.setBorderRadius(12);
    view.webContents.setWindowOpenHandler(({ url: u }) => {
      this.createTab({ url: u });
      return { action: 'deny' };
    });
    view.webContents.on('page-title-updated', () => this.emitState());
    view.webContents.on('before-input-event', (e, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') {
        e.preventDefault();
        this.closePeek();
      }
    });
    view.webContents.on('did-navigate', () => this.emitState());
    view.webContents.loadURL(toUrl(url, this.settings.searchEngine)).catch(() => {});
    this.peek = { view, opener: openerId };
    this.layout();
    this.emitState();
  }
  closePeek() {
    if (!this.peek) return;
    try {
      this.win.contentView.removeChildView(this.peek.view);
    } catch {}
    this.peek.view.webContents.close();
    this.peek = null;
    this.layout();
    this.emitState();
  }
  peekToTab(mode = 'tab') {
    if (!this.peek) return;
    const url = this.peek.view.webContents.getURL();
    const opener = this.peek.opener;
    this.closePeek();
    if (mode === 'split') this.splitWithUrl(url);
    else this.createTab({ url, after: opener });
  }

  // ---------- media / PiP / find / zoom ----------
  async pip(tabId = this.activeTabId()) {
    const wc = this.wcOf(tabId);
    if (!wc) return 'no-tab';
    try {
      return await wc.executeJavaScript(scripts.PIP, true);
    } catch (e) {
      return 'error: ' + e.message;
    }
  }
  async mediaToggle(tabId) {
    const wc = this.wcOf(tabId);
    return wc ? wc.executeJavaScript(scripts.MEDIA_TOGGLE, true).catch(() => null) : null;
  }
  find(text, { forward = true, findNext = false } = {}) {
    const wc = this.wcOf(this.activeTabId());
    if (!wc) return;
    if (!text) return this.stopFind();
    wc.findInPage(text, { forward, findNext });
  }
  stopFind() {
    const wc = this.wcOf(this.activeTabId());
    if (wc) wc.stopFindInPage('clearSelection');
    this.findResult = null;
    this.emitState();
  }
  zoom(delta) {
    const wc = this.wcOf(this.activeTabId());
    if (!wc) return;
    wc.setZoomLevel(delta === 0 ? 0 : wc.getZoomLevel() + delta);
  }

  // ---------- boosts ----------
  applyBoost(wc, url) {
    const b = this.s.boosts[hostOf(url)];
    if (!b || !b.enabled) return;
    if (b.css) wc.insertCSS(b.css).catch(() => {});
    if (b.js) wc.executeJavaScript(`try{${b.js}\n}catch(e){console.error('[Drift boost]',e)}`).catch(() => {});
    if (b.zap && b.zap.length) wc.insertCSS(`${b.zap.join(',')}{display:none!important}`).catch(() => {});
  }
  setBoost(host, boost) {
    if (!host) return;
    if (!boost) delete this.s.boosts[host];
    else this.s.boosts[host] = { enabled: true, css: '', js: '', zap: [], ...this.s.boosts[host], ...boost };
    this.store.save();
    for (const [id] of this.views) {
      const wc = this.wcOf(id);
      if (wc && hostOf(wc.getURL()) === host) wc.reload();
    }
    this.emitState();
  }

  // ---------- layout ----------
  setOverlay(on) {
    this.overlay = !!on;
    this.layout();
    if (on) this.ui.webContents.focus();
    else this.focusActive();
  }
  setClaudeOpen(open) {
    this.claudeOpen = open;
    this.layout();
    this.emitState();
  }
  toggleSidebar() {
    this.settings.sidebarCollapsed = !this.settings.sidebarCollapsed;
    this.store.save();
    this.layout();
    this.emitState();
  }

  contentRect() {
    const { width: w, height: h } = this.win.getContentBounds();
    if (this.fullscreenTab) return { x: 0, y: 0, width: w, height: h };
    const left = this.settings.sidebarCollapsed ? PAD : this.settings.sidebarWidth;
    const right = this.claudeOpen ? this.settings.claude.panelWidth : PAD;
    return { x: left, y: PAD, width: Math.max(100, w - left - right), height: Math.max(100, h - PAD * 2) };
  }

  layout() {
    if (this.win.isDestroyed()) return;
    const { width: w, height: h } = this.win.getContentBounds();
    const cv = this.win.contentView;
    this.ui.setBounds({ x: 0, y: 0, width: w, height: h });
    const rect = this.contentRect();
    const active = this.activeTabId();
    const visible = new Map(); // tabId -> bounds
    if (this.fullscreenTab && this.views.has(this.fullscreenTab)) {
      visible.set(this.fullscreenTab, rect);
    } else if (this.split && [this.split.left, this.split.right].includes(active)) {
      const lw = Math.round((rect.width - GAP) * this.split.ratio);
      visible.set(this.split.left, { ...rect, width: lw });
      visible.set(this.split.right, { ...rect, x: rect.x + lw + GAP, width: rect.width - lw - GAP });
    } else if (active) {
      visible.set(active, rect);
    }
    const children = new Set(cv.children);
    for (const [id, view] of this.views) {
      if (visible.has(id)) {
        view.setBounds(visible.get(id));
        if (!children.has(view)) cv.addChildView(view);
      } else if (children.has(view)) {
        cv.removeChildView(view);
      }
    }
    // Z-order: tabs < UI (only when an overlay is open) < peek.
    // Re-adding an existing child moves it to the top, so only reorder when needed.
    if (this.overlay || this.peek) {
      if (cv.children[cv.children.length - 1] !== this.ui) cv.addChildView(this.ui);
    } else {
      const uiIdx = cv.children.indexOf(this.ui);
      for (const id of visible.keys()) {
        const v = this.views.get(id);
        if (cv.children.indexOf(v) < uiIdx) cv.addChildView(v);
      }
    }
    if (this.peek) {
      const m = { x: Math.round(rect.width * 0.08), y: 52 };
      this.peek.bounds = { x: rect.x + m.x, y: rect.y + m.y, width: rect.width - m.x * 2, height: rect.height - m.y - 24 };
      this.peek.view.setBounds(this.peek.bounds);
      cv.addChildView(this.peek.view);
    }
    this.sendUI('layout', {
      content: rect,
      panes: [...visible.entries()].map(([id, b]) => ({ id, ...b })),
      peek: this.peek ? this.peek.bounds : null,
      fullscreen: !!this.fullscreenTab,
    });
  }

  // ---------- UI sync ----------
  sendUI(channel, payload) {
    if (!this.ui.webContents.isDestroyed()) this.ui.webContents.send(channel, payload);
  }

  serialize() {
    const s = this.s;
    const wcId = (id) => this.wcOf(id)?.id;
    const tabs = s.tabs.map((t) => {
      const r = this.rt.get(t.id) || {};
      return {
        ...t,
        loaded: this.views.has(t.id),
        loading: !!r.loading,
        audible: !!r.audible,
        playing: !!r.playing,
        muted: !!this.wcOf(t.id)?.isAudioMuted(),
        crashed: r.crashed || null,
        canGoBack: !!r.canGoBack,
        canGoForward: !!r.canGoForward,
        blocked: wcId(t.id) != null ? this.adblock.countFor(wcId(t.id)) : 0,
      };
    });
    const pk = this.peek ? this.peek.view.webContents : null;
    return {
      spaces: s.spaces,
      activeSpaceId: s.activeSpaceId,
      activeTabId: this.activeTabId(),
      activeWcId: this.wcOf(this.activeTabId())?.id ?? null,
      partition: `persist:drift-${this.space().profile || 'default'}`,
      extensionCount: this.extensions ? this.getSession(this.space().profile || 'default').extensions.getAllExtensions().length : 0,
      tabs,
      split: this.split,
      peek: pk ? { url: pk.getURL(), title: pk.getTitle() } : null,
      settings: { ...s.settings, claude: { ...s.settings.claude, apiKeyEnc: undefined, hasKey: !!s.settings.claude.apiKeyEnc } },
      claudeOpen: this.claudeOpen,
      find: this.findResult,
      downloads: this.downloads,
      adblockTotal: this.adblock.stats.total,
      archivedCount: s.archived.length,
      boosts: s.boosts,
      platform: process.platform,
    };
  }

  emitState(now = false) {
    const fire = () => {
      this._emitTimer = null;
      const st = this.serialize();
      this.sendUI('state', st);
      this.listeners.forEach((fn) => fn(st));
    };
    if (now) return fire();
    if (!this._emitTimer) this._emitTimer = setTimeout(fire, 30);
  }

  async suggestions(q) {
    if (!q || q.length < 2 || !this.settings.searchEngine.includes('google.')) return [];
    try {
      const r = await net.fetch(`https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(q)}`);
      const j = await r.json();
      return (j[1] || []).slice(0, 5);
    } catch {
      return [];
    }
  }

  copyUrl() {
    const t = this.activeTab();
    if (t) clipboard.writeText(this.wcOf(t.id)?.getURL() || t.url);
    this.sendUI('toast', 'Copied URL to clipboard');
  }

  openExternal(url) {
    shell.openExternal(url);
  }

  destroy() {
    clearInterval(this.archiveTimer);
  }
}

module.exports = { Browser };
