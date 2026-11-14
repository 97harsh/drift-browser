// Chrome extension support.
//
// Electron ships Chromium's engine but not Chrome's browser layer, so most of the
// extension platform (Web Store installs, chrome.tabs, toolbar actions, popups,
// context menus) is provided by electron-chrome-extensions + electron-chrome-web-store.
//
// Extensions are installed once into a shared folder and loaded into every
// profile session, the way Arc shares extensions across spaces.
const path = require('path');
const fs = require('fs');
const { app, dialog, session: electronSession } = require('electron');
const { ElectronChromeExtensions } = require('electron-chrome-extensions');
const { installChromeWebStore, installExtension, uninstallExtension } = require('electron-chrome-web-store');

class Extensions {
  constructor(browserRef) {
    this.getBrowser = browserRef; // () => Browser (constructed later than us)
    this.dir = path.join(app.getPath('userData'), 'Extensions');
    this.bySession = new Map(); // Session -> {crx, ready: Promise}
    this.disabled = new Set();
    ElectronChromeExtensions.handleCRXProtocol(electronSession.defaultSession); // toolbar icons in the UI view
  }

  get browser() {
    return this.getBrowser();
  }

  /** Called synchronously when a profile session is created, before any tab uses it. */
  setup(ses) {
    if (this.bySession.has(ses)) return this.bySession.get(ses).ready;
    const crx = new ElectronChromeExtensions({
      session: ses,
      createTab: async (details) => {
        const b = this.browser;
        const t = b.createTab({ url: details.url || 'about:blank', activate: details.active !== false });
        return [b.wcOf(t.id), b.win];
      },
      selectTab: (wc) => {
        const t = this.browser.tabByWebContents(wc);
        if (t) this.browser.activate(t.id);
      },
      removeTab: (wc) => {
        const t = this.browser.tabByWebContents(wc);
        if (t) this.browser.closeTab(t.id);
      },
      createWindow: async (details) => {
        const url = (Array.isArray(details.url) ? details.url[0] : details.url) || 'about:blank';
        // Extension UI (e.g. Bitwarden's "pop out") gets a clean window; web URLs get a Little Drift.
        if (details.type === 'popup' || url.startsWith('chrome-extension://')) return this.extensionWindow(ses, url, details);
        const { openMini } = require('./mini');
        return openMini(this.browser, url, { width: details.width, height: details.height }).win;
      },
      removeWindow: (win) => !win.isDestroyed() && win.close(),
      requestPermissions: async (extension, perms) => {
        const list = [...(perms.permissions || []), ...(perms.origins || [])].join(', ');
        const { response } = await dialog.showMessageBox(this.browser.win, {
          type: 'question',
          message: `“${extension.name}” is requesting extra permissions`,
          detail: list,
          buttons: ['Allow', 'Deny'],
          defaultId: 1,
          cancelId: 1,
        });
        return response === 0;
      },
    });
    crx.on('browser-action-popup-created', () => this.browser.emitState());
    // Our own shims for chrome.* APIs nobody implements (e.g. fontSettings for Dark Reader).
    const shim = path.join(__dirname, '..', 'preload', 'crx-shims.js');
    ses.registerPreloadScript({ id: 'drift-crx-shims-sw', type: 'service-worker', filePath: shim });
    ses.registerPreloadScript({ id: 'drift-crx-shims-frame', type: 'frame', filePath: shim });

    const ready = installChromeWebStore({
      session: ses,
      extensionsPath: this.dir,
      autoUpdate: true,
      allowUnpackedExtensions: true,
      beforeInstall: (d) => this.confirmInstall(d),
    })
      .catch((e) => console.error('[extensions] web store setup failed:', e.message))
      .then(() => this.loadUnpacked(ses))
      .then(() => this.browser && this.browser.emitState());

    // When one profile installs/removes an extension, mirror it into the others.
    ses.extensions.on('extension-loaded', (_e, ext) => {
      this.mirror(ses, ext);
      this.browser && this.browser.emitState();
    });
    ses.extensions.on('extension-unloaded', () => this.browser && this.browser.emitState());

    this.bySession.set(ses, { crx, ready });
    return ready;
  }

  extensionWindow(ses, url, details = {}) {
    const { BrowserWindow } = require('electron');
    const win = new BrowserWindow({
      width: details.width || 420,
      height: details.height || 640,
      x: details.left,
      y: details.top,
      title: 'Extension',
      autoHideMenuBar: true,
      webPreferences: { session: ses, sandbox: true, contextIsolation: true },
    });
    const crx = this.bySession.get(ses)?.crx;
    if (crx) crx.addTab(win.webContents, win);
    win.on('closed', () => {});
    win.loadURL(url).catch(() => {});
    return win;
  }

  ready(ses) {
    return this.bySession.get(ses)?.ready || Promise.resolve();
  }

  async confirmInstall(d) {
    const perms = [...(d.manifest.permissions || []), ...(d.manifest.host_permissions || [])].filter((p) => typeof p === 'string');
    const { response } = await dialog.showMessageBox(this.browser.win, {
      type: 'question',
      message: `Add “${d.localizedName}” to Drift?`,
      detail: perms.length ? `It can:\n• ${perms.slice(0, 12).join('\n• ')}` : 'It requests no special permissions.',
      icon: d.icon && !d.icon.isEmpty() ? d.icon : undefined,
      buttons: ['Add extension', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) setTimeout(() => this.browser.sendUI('toast', `Added ${d.localizedName}`), 800);
    return { action: response === 0 ? 'allow' : 'deny' };
  }

  /** Unpacked extensions you dropped in via "Load unpacked" are remembered in settings. */
  async loadUnpacked(ses) {
    for (const p of this.browser?.settings.unpackedExtensions || []) {
      if (!fs.existsSync(p)) continue;
      if (ses.extensions.getAllExtensions().some((e) => e.path === p)) continue;
      await ses.extensions.loadExtension(p, { allowFileAccess: true }).catch((e) => console.warn('[extensions]', p, e.message));
    }
  }

  async mirror(fromSes, ext) {
    for (const [ses, { ready }] of this.bySession) {
      if (ses === fromSes) continue;
      await ready;
      if (!ses.extensions.getExtension(ext.id)) {
        await ses.extensions.loadExtension(ext.path, { allowFileAccess: true }).catch(() => {});
      }
    }
  }

  // ---------- tab lifecycle hooks (called by Browser) ----------
  crxFor(wc) {
    return this.bySession.get(wc.session)?.crx;
  }
  addTab(wc, win) {
    this.crxFor(wc)?.addTab(wc, win);
  }
  selectTab(wc) {
    this.crxFor(wc)?.selectTab(wc);
  }
  removeTab(wc) {
    try {
      this.crxFor(wc)?.removeTab(wc);
    } catch {}
  }
  contextMenuItems(wc, params) {
    try {
      return this.crxFor(wc)?.getContextMenuItems(wc, params) || [];
    } catch {
      return [];
    }
  }

  // ---------- management (Settings → Extensions) ----------
  primary() {
    return this.browser.getSession(this.browser.space().profile || 'default');
  }

  recommended() {
    const installed = new Set(this.primary().extensions.getAllExtensions().map((e) => e.id));
    return RECOMMENDED.map((r) => ({ ...r, installed: installed.has(r.id) }));
  }

  /** Id of the installed password manager (for ⇧⌘L), if any. */
  passwordManagerId() {
    const all = this.primary().extensions.getAllExtensions();
    return (all.find((e) => PASSWORD_MANAGERS.has(e.id)) || {}).id || null;
  }

  list() {
    const ses = this.primary();
    const unpacked = new Set(this.browser.settings.unpackedExtensions || []);
    return ses.extensions.getAllExtensions().map((e) => ({
      id: e.id,
      name: e.name,
      version: e.version,
      description: e.manifest.description && !String(e.manifest.description).startsWith('__MSG_') ? e.manifest.description : '',
      unpacked: unpacked.has(e.path),
      hasPopup: !!(e.manifest.action?.default_popup || e.manifest.browser_action?.default_popup),
      options: e.manifest.options_ui?.page || e.manifest.options_page || null,
      url: e.url,
    }));
  }

  async installById(input) {
    const id = parseExtensionId(input);
    if (!id) throw new Error('Paste a Chrome Web Store link or a 32-letter extension id');
    const ses = this.primary();
    await this.ready(ses);
    const ext = await installExtension(id, { session: ses, extensionsPath: this.dir });
    return { id: ext.id, name: ext.name };
  }

  async remove(id) {
    const unpacked = (this.browser.settings.unpackedExtensions || []).find((p) => {
      for (const ses of this.bySession.keys()) if (ses.extensions.getExtension(id)?.path === p) return true;
      return false;
    });
    if (unpacked) {
      this.browser.settings.unpackedExtensions = this.browser.settings.unpackedExtensions.filter((p) => p !== unpacked);
      this.browser.store.save();
    } else {
      await uninstallExtension(id, { session: this.primary(), extensionsPath: this.dir }).catch(() => {});
    }
    for (const ses of this.bySession.keys()) if (ses.extensions.getExtension(id)) ses.extensions.removeExtension(id);
    this.browser.emitState();
  }

  async loadUnpackedFromDialog() {
    const r = await dialog.showOpenDialog(this.browser.win, { title: 'Select an unpacked extension folder', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    const p = r.filePaths[0];
    if (!fs.existsSync(path.join(p, 'manifest.json'))) throw new Error('That folder has no manifest.json');
    const s = this.browser.settings;
    s.unpackedExtensions = [...new Set([...(s.unpackedExtensions || []), p])];
    this.browser.store.save();
    for (const [ses, { ready }] of this.bySession) {
      await ready;
      await ses.extensions.loadExtension(p, { allowFileAccess: true });
    }
    this.browser.emitState();
    return p;
  }

  openOptions(id) {
    const ext = this.primary().extensions.getExtension(id);
    const page = ext && (ext.manifest.options_ui?.page || ext.manifest.options_page);
    if (page) this.browser.createTab({ url: `chrome-extension://${id}/${page}` });
  }
}

// Well-tested picks shown in Settings → Extensions. Password managers come first so
// ⇧⌘L knows which popup to open.
const RECOMMENDED = [
  { id: 'nngceckbapebfimnlniiiahkandclblb', name: 'Bitwarden', blurb: 'Open-source password manager: autofill, passkeys, generator', passwordManager: true },
  { id: 'eimadpbcbfnmbkopoojfekhnkhdbieeh', name: 'Dark Reader', blurb: 'Dark mode for every website' },
  { id: 'bcjindcccaagfpapjjmafapmmgkkhgoa', name: 'JSON Formatter', blurb: 'Pretty-prints JSON responses' },
];
const PASSWORD_MANAGERS = new Set([
  'nngceckbapebfimnlniiiahkandclblb', // Bitwarden
  'aeblfdkhhhdcdjpifhhbdiojplfjncoa', // 1Password
  'ghmbeldphafepmbegfdlkpapadhbakde', // Proton Pass
  'hdokiejnpimakedhajhdlcegeplioahd', // LastPass
  'fdjamakpfbbddfjaooikfcpapjohcfmg', // Dashlane
]);

/** Accepts a raw id or any Chrome Web Store URL containing one. */
function parseExtensionId(input) {
  const m = String(input || '').match(/(?:^|\/)([a-p]{32})(?:[/?#]|$)/);
  return m ? m[1] : null;
}

module.exports = { Extensions, parseExtensionId, RECOMMENDED, PASSWORD_MANAGERS };
