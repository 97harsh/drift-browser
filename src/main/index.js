const { app, ipcMain, Menu, shell } = require('electron');
const path = require('path');
const { Store } = require('./store');
const { AdBlock } = require('./adblock');
const { Browser } = require('./browser');
const { makeTools } = require('./tools');
const { ClaudeAgent } = require('./claude');
const { ControlServer } = require('./control-server');
const { openMini, miniFor } = require('./mini');
const { Extensions } = require('./extensions');
const { score, summarizeUsage } = require('./util');
const pkg = require('../../package.json');

app.setName('Drift');
if (process.env.DRIFT_USER_DATA) app.setPath('userData', process.env.DRIFT_USER_DATA);

const store = new Store(app.getPath('userData'));
// Chrome DevTools Protocol for external debuggers / Playwright (localhost only, needs restart).
if (store.s.settings.cdp.enabled) {
  app.commandLine.appendSwitch('remote-debugging-port', String(store.s.settings.cdp.port));
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// Pages (and adblock scriptlets) can make injected scripts throw; log, don't crash.
process.on('unhandledRejection', (e) => console.warn('[drift] unhandled rejection:', e && e.message ? e.message : e));

let browser, agent, control, tools;
const pendingUrls = [];

app.on('open-url', (e, url) => {
  e.preventDefault();
  if (browser) openMini(browser, url);
  else pendingUrls.push(url);
});
// Opening .html files from Finder (Drift registers as a viewer for them when packaged).
app.on('open-file', (e, file) => {
  e.preventDefault();
  const url = 'file://' + file;
  if (browser) browser.createTab({ url });
  else pendingUrls.push(url);
});
app.on('second-instance', (_e, argv) => {
  const url = argv.find((a) => /^https?:\/\//.test(a));
  if (browser) url ? openMini(browser, url) : browser.win.focus();
});

app.whenReady().then(async () => {
  const adblock = new AdBlock(app.getPath('userData'));
  const extensions = new Extensions(() => browser);
  browser = new Browser({ store, adblock, extensions });
  tools = makeTools(browser, { status: () => ({ control: control?.info() && { local: control.info().local, tunnel: control.info().tunnel } }) });
  agent = new ClaudeAgent({ browser, store, tools, send: (ev) => browser.sendUI('claude:event', ev) });
  control = new ControlServer({ browser, store, tools, version: pkg.version });
  control.start();
  buildMenu();

  adblock.onBlocked = () => browser.emitState();
  if (store.s.settings.adblock) {
    adblock
      .setEnabled(true, store.s.settings.adblockLevel)
      .then(() => browser.emitState())
      .catch((e) => console.error('[adblock] failed to load filter lists:', e.message));
  }

  pendingUrls.splice(0).forEach((u) => openMini(browser, u));
  const argUrl = process.argv.find((a) => /^https?:\/\//.test(a));
  if (argUrl) browser.createTab({ url: argUrl });
  if (!store.s.tabs.length) {
    browser.createTab({ url: 'https://github.com', zone: 'favorite', activate: false });
    browser.createTab({ url: 'https://claude.ai', zone: 'favorite', activate: false });
    browser.createTab({ url: 'https://www.youtube.com', zone: 'favorite', activate: false });
    browser.createTab({ url: 'https://news.ycombinator.com' });
  }
});

app.on('window-all-closed', () => {
  // On macOS, closing the main window quits Drift (single-window browser).
  store.flush();
  app.quit();
});
app.on('before-quit', () => {
  store.flush();
  control?.stop();
});

// ---------------- IPC: one dispatcher for every UI action ----------------
ipcMain.handle('act', async (_e, action, p = {}) => {
  const b = browser;
  const s = store.s;
  switch (action) {
    // tabs
    case 'tab.activate': return b.activate(p.id);
    case 'tab.close': return b.closeTab(p.id);
    case 'tab.create': return b.createTab(p).id;
    case 'tab.navigate': return b.navigate(p.id || b.activeTabId(), p.url);
    case 'tab.move': return b.moveTab(p.id, p.zone, p.beforeId);
    case 'tab.toSpace': return b.moveTabToSpace(p.id, p.spaceId);
    case 'tab.rename': {
      const t = b.tab(p.id);
      if (t) (t.customTitle = p.title || null), store.save(), b.emitState();
      return;
    }
    case 'tab.mute': {
      const wc = b.wcOf(p.id);
      if (wc) wc.setAudioMuted(!wc.isAudioMuted()), b.emitState();
      return;
    }
    case 'tab.unload': return b.destroyView(p.id), b.emitState();
    case 'tab.resetPinned': {
      const t = b.tab(p.id);
      if (t && t.pinnedUrl) b.navigate(t.id, t.pinnedUrl);
      return;
    }
    case 'tab.duplicate': {
      const t = b.tab(p.id);
      return t && b.createTab({ url: b.wcOf(t.id)?.getURL() || t.url, after: t.id }).id;
    }
    case 'tab.back': return b.wcOf(p.id || b.activeTabId())?.navigationHistory.goBack();
    case 'tab.forward': return b.wcOf(p.id || b.activeTabId())?.navigationHistory.goForward();
    case 'tab.reload': return b.wcOf(p.id || b.activeTabId())?.reload();
    case 'tab.stop': return b.wcOf(p.id || b.activeTabId())?.stop();
    case 'tabs.clearToday': {
      b.tabsIn(s.activeSpaceId, 'today').forEach((t) => b.closeTab(t.id));
      return;
    }
    case 'reopenClosed': return b.reopenClosed();
    case 'copyUrl': return b.copyUrl();
    // spaces
    case 'space.switch': return b.switchSpace(p.id);
    case 'space.add': return b.addSpace(p).id;
    case 'space.update': return b.updateSpace(p.id, p.patch);
    case 'space.delete': return b.deleteSpace(p.id);
    // split / peek
    case 'split.with': return b.splitWith(p.id);
    case 'split.url': return b.splitWithUrl(p.url);
    case 'split.ratio': return b.setSplitRatio(p.ratio);
    case 'split.swap': return b.swapSplit();
    case 'split.close': return b.closeSplit();
    case 'peek.open': return b.openPeek(p.url, b.activeTabId());
    case 'peek.close': return b.closePeek();
    case 'peek.promote': return b.peekToTab(p.mode);
    // layout
    case 'overlay': return b.setOverlay(p.on);
    case 'sidebar.toggle': return b.toggleSidebar();
    case 'sidebar.width':
      s.settings.sidebarWidth = Math.max(200, Math.min(420, p.width | 0));
      store.save();
      return b.layout();
    case 'claude.toggle': return b.setClaudeOpen(p.open ?? !b.claudeOpen);
    case 'claude.width':
      s.settings.claude.panelWidth = Math.max(300, Math.min(720, p.width | 0));
      store.save();
      return b.layout();
    // claude
    case 'claude.ask': return void agent.ask(p.text);
    case 'claude.stop': return agent.stop();
    case 'claude.reset': return agent.reset();
    case 'claude.approve': return agent.approve(p.id, p.decision);
    case 'claude.setKey':
      agent.setApiKey((p.key || '').trim());
      return b.emitState();
    // page tools
    case 'find': return b.find(p.text, p);
    case 'find.stop': return b.stopFind();
    case 'pip': return b.pip(p.id);
    case 'media.toggle': return b.mediaToggle(p.id);
    case 'zoom': return b.zoom(p.delta);
    case 'devtools': return b.wcOf(p.id || b.activeTabId())?.openDevTools({ mode: 'detach' });
    // library
    case 'history.query': {
      const q = (p.q || '').trim();
      const list = q
        ? s.history.map((h) => ({ h, sc: score(q, h.title, h.url) })).filter((x) => x.sc > 0).sort((a, z) => z.sc - a.sc || z.h.ts - a.h.ts).map((x) => x.h)
        : s.history;
      const seen = new Set();
      return list.filter((h) => !seen.has(h.url) && seen.add(h.url)).slice(0, p.limit || 50);
    }
    case 'history.clear':
      s.history = [];
      store.save();
      return;
    case 'suggestions': return b.suggestions(p.q);
    case 'archive.list': return s.archived.slice(0, 200);
    case 'archive.restore': {
      const [t] = s.archived.splice(p.index, 1);
      if (t) b.createTab({ url: t.url, title: t.title });
      return;
    }
    case 'usage.get': return { summary: summarizeUsage(s.usage), recent: s.usage.slice(-100).reverse() };
    case 'usage.clear':
      s.usage = [];
      store.save();
      return;
    // settings
    case 'settings.update': {
      const before = JSON.stringify(s.settings.control);
      mergeInto(s.settings, p.patch || {});
      store.save();
      if (JSON.stringify(s.settings.control) !== before) control.restart();
      b.layout();
      b.emitState();
      return;
    }
    case 'adblock.set':
      s.settings.adblock = !!p.enabled;
      if (p.level) s.settings.adblockLevel = p.level;
      store.save();
      await b.adblock.setEnabled(s.settings.adblock, s.settings.adblockLevel);
      return b.emitState();
    case 'boost.set': return b.setBoost(p.host, p.boost);
    case 'routes.set':
      s.settings.routes = p.routes || [];
      store.save();
      return b.emitState();
    // control plane
    case 'control.info': return { ...control.info(), cdp: s.settings.cdp, tools: tools.map((t) => t.name) };
    case 'control.rotate':
      control.rotateToken();
      return control.info();
    case 'control.tunnel':
      if (p.on) {
        const t = control.startTunnel(() => b.sendUI('command', { name: 'control-changed' }));
        return t && t.error ? { ...control.info(), error: t.error } : control.info();
      }
      control.stopTunnel();
      return control.info();
    // Chrome extensions
    case 'ext.list': return b.extensions.list();
    case 'ext.install': return b.extensions.installById(p.input);
    case 'ext.remove': return b.extensions.remove(p.id);
    case 'ext.loadUnpacked': return b.extensions.loadUnpackedFromDialog();
    case 'ext.options': return b.extensions.openOptions(p.id);
    case 'ext.store': return b.createTab({ url: 'https://chromewebstore.google.com/' }).id;
    // Default browser. macOS shows its own confirmation dialog; nothing changes until the user accepts.
    case 'defaultBrowser.get':
      return { http: app.isDefaultProtocolClient('http'), https: app.isDefaultProtocolClient('https'), packaged: app.isPackaged };
    case 'defaultBrowser.set':
      if (!app.isPackaged) return { error: 'Install the packaged Drift.app (from the DMG) first — in dev mode this would register Electron instead of Drift.' };
      app.setAsDefaultProtocolClient('http');
      app.setAsDefaultProtocolClient('https');
      return { requested: true };
    case 'mini.open': return void openMini(b, p.url);
    case 'openExternal': return shell.openExternal(p.url);
    case 'relaunch':
      store.flush();
      app.relaunch();
      return app.exit(0);
    default:
      throw new Error('unknown action ' + action);
  }
});

ipcMain.handle('mini', (e, action, arg) => {
  const m = miniFor(e.sender);
  if (!m) return;
  if (action === 'navigate') m.navigate(arg);
  if (action === 'promote') m.promote();
});

function mergeInto(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') mergeInto(target[k], v);
    else target[k] = v;
  }
}

// ---------------- Menu & keyboard shortcuts ----------------
function buildMenu() {
  const b = browser;
  const cmd = (name, extra) => () => b.sendUI('command', { name, ...extra });
  const nth = (n) => () => {
    const list = b.visibleOrder();
    const t = n === 9 ? list[list.length - 1] : list[n - 1];
    if (t) b.activate(t.id);
  };
  const space = (n) => () => b.s.spaces[n - 1] && b.switchSpace(b.s.spaces[n - 1].id);
  const template = [
    {
      label: 'Drift',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: cmd('settings') },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Tab…', accelerator: 'CmdOrCtrl+T', click: cmd('newtab') },
        { label: 'New Little Drift Window', accelerator: 'CmdOrCtrl+Alt+N', click: () => openMini(b) },
        { label: 'New Space', accelerator: 'CmdOrCtrl+Shift+N', click: cmd('newspace') },
        { type: 'separator' },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => (b.peek ? b.closePeek() : b.closeTab()) },
        { label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+T', click: () => b.reopenClosed() },
        { label: 'Pin / Unpin Tab', accelerator: 'CmdOrCtrl+D', click: () => {
          const t = b.activeTab();
          if (t) b.moveTab(t.id, t.zone === 'today' ? 'pinned' : 'today');
        } },
        { type: 'separator' },
        { label: 'Library (History & Archive)', accelerator: 'CmdOrCtrl+Y', click: cmd('library') },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: cmd('find') },
        { label: 'Copy URL', accelerator: 'CmdOrCtrl+Shift+C', click: () => b.copyUrl() },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Open Location / Command Bar', accelerator: 'CmdOrCtrl+L', click: cmd('location') },
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+S', click: () => b.toggleSidebar() },
        { label: 'Toggle Claude', accelerator: 'CmdOrCtrl+J', click: () => {
          b.setClaudeOpen(!b.claudeOpen);
          if (b.claudeOpen) b.sendUI('command', { name: 'claude-focus' });
        } },
        { type: 'separator' },
        { label: 'Split View with…', accelerator: 'Ctrl+Shift+=', click: cmd('split') },
        { label: 'Close Split View', accelerator: 'Ctrl+Shift+-', click: () => b.closeSplit() },
        { label: 'Picture in Picture', accelerator: 'CmdOrCtrl+Shift+P', click: () => b.pip() },
        { label: 'Boost this Site…', accelerator: 'CmdOrCtrl+Shift+B', click: cmd('boost') },
        { label: 'Extensions…', click: cmd('extensions') },
        { type: 'separator' },
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => b.wcOf(b.activeTabId())?.reload() },
        { label: 'Hard Reload', accelerator: 'CmdOrCtrl+Shift+R', click: () => b.wcOf(b.activeTabId())?.reloadIgnoringCache() },
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: () => b.wcOf(b.activeTabId())?.navigationHistory.goBack() },
        { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: () => b.wcOf(b.activeTabId())?.navigationHistory.goForward() },
        { type: 'separator' },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => b.zoom(0.5) },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => b.zoom(-0.5) },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => b.zoom(0) },
        { type: 'separator' },
        { label: 'Developer Tools', accelerator: 'CmdOrCtrl+Alt+I', click: () => b.wcOf(b.activeTabId())?.openDevTools({ mode: 'detach' }) },
        { label: 'Drift UI DevTools', click: () => b.ui.webContents.openDevTools({ mode: 'detach' }) },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Tabs',
      submenu: [
        { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: () => b.cycleTab(1) },
        { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: () => b.cycleTab(-1) },
        { label: 'Next Tab ', accelerator: 'CmdOrCtrl+Alt+Down', click: () => b.cycleTab(1) },
        { label: 'Previous Tab ', accelerator: 'CmdOrCtrl+Alt+Up', click: () => b.cycleTab(-1) },
        { type: 'separator' },
        ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ label: `Tab ${n === 9 ? '(last)' : n}`, accelerator: `CmdOrCtrl+${n}`, click: nth(n) })),
        { type: 'separator' },
        { label: 'Next Space', accelerator: 'CmdOrCtrl+Alt+Right', click: () => b.cycleSpace(1) },
        { label: 'Previous Space', accelerator: 'CmdOrCtrl+Alt+Left', click: () => b.cycleSpace(-1) },
        ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ label: `Space ${n}`, accelerator: `Ctrl+${n}`, click: space(n) })),
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
