// Headless-ish smoke test for Chrome extension support.
// Usage: npx electron scripts/ext-smoke.js
// Installs Dark Reader from the Chrome Web Store into a temp profile, loads a page,
// checks its content script ran and that it's visible to the toolbar, then removes it.
const { app, nativeTheme } = require('electron');
const os = require('os');
const fs = require('fs');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-ext-'));
app.setPath('userData', tmp);

const { Store } = require('../src/main/store');
const { AdBlock } = require('../src/main/adblock');
const { Browser } = require('../src/main/browser');
const { Extensions } = require('../src/main/extensions');

const DARK_READER = 'eimadpbcbfnmbkopoojfekhnkhdbieeh';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const results = {};
  let browser;
  try {
    const store = new Store(tmp);
    store.s.settings.adblock = false;
    const extensions = new Extensions(() => browser);
    browser = new Browser({ store, adblock: new AdBlock(tmp), extensions });
    browser.win.hide();

    // 1) Deterministic fixture: content script -> service worker -> chrome.tabs round trip.
    const fixture = path.join(__dirname, '..', 'test', 'fixtures', 'ext-probe');
    store.s.settings.unpackedExtensions = [fixture];
    const ses = browser.getSession('default');
    await extensions.ready(ses);
    const probeTab = browser.createTab({ url: 'https://example.com/?probe' });
    const pwc = browser.wcOf(probeTab.id);
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      results.probe = await pwc.executeJavaScript('document.documentElement.dataset.driftProbe || null').catch(() => null);
      if (results.probe && results.probe.startsWith('{')) break;
    }
    try { results.probe = JSON.parse(results.probe); } catch {}

    // Collect extension service-worker logs for diagnostics.
    results.swLogs = [];
    ses.serviceWorkers.on('console-message', (_e, d) => results.swLogs.push(String(d.message || d).slice(0, 200)));
    // 2) Real Chrome Web Store install.
    const r = await extensions.installById(`https://chromewebstore.google.com/detail/dark-reader/${DARK_READER}`);
    results.installed = r.name;
    results.listed = extensions.list().map((x) => x.name);

    // Dark Reader follows the system appearance by default; force dark so the effect is observable.
    nativeTheme.themeSource = 'dark';
    await sleep(1500);
    const t = browser.createTab({ url: 'https://example.com' });
    const wc = browser.wcOf(t.id);
    for (let i = 0; i < 40 && (wc.isLoading() || wc.getURL() === ''); i++) await sleep(250);
    for (let i = 0; i < 20 && !results.contentScriptRan; i++) {
      await sleep(500);
      results.darkreaderNodes = await wc.executeJavaScript(`[...document.querySelectorAll('[class*="darkreader"], meta[name="darkreader"]')].map(e => e.tagName + '.' + e.className).slice(0, 5)`);
      results.contentScriptRan = results.darkreaderNodes.length > 0;
    }
    results.pageLogs = (browser.consoleLogs.get(wc.id) || []).map((l) => l.message.slice(0, 200)).slice(0, 8);
    results.swRunning = extensions.primary().serviceWorkers ? Object.values(extensions.primary().serviceWorkers.getAllRunning()).map((w) => w.scope) : null;
    results.extensionCountInState = browser.serialize().extensionCount;

    await extensions.remove(DARK_READER);
    results.removed = !extensions.list().some((x) => x.name === 'Dark Reader');
  } catch (e) {
    results.error = e.stack || String(e);
  }
  console.log(JSON.stringify(results, null, 1));
  // Dark Reader's page effect is informational: it needs chrome.fontSettings, which Electron lacks.
  const ok = results.probe && results.probe.ok && results.probe.tabCount >= 1 && results.probe.url && results.installed && results.extensionCountInState === 2 && results.removed;
  fs.rmSync(tmp, { recursive: true, force: true });
  app.exit(ok ? 0 : 1);
});
