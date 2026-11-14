// Headless-ish smoke test for Chrome extension support.
// Usage: npx electron scripts/ext-smoke.js
// 1) Loads a probe fixture and checks what password managers rely on: content script <-> service
//    worker messaging, chrome.tabs, scripting.executeScript into a frame, extension iframes in pages
//    talking over ports, navigation events, and chrome.runtime.onInstalled (fired once, as 'install').
// 2) Installs Dark Reader from the Chrome Web Store, checks it darkens a light page, then removes it.
const { app } = require('electron');
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
    await sleep(2500);
    const extra = await pwc.executeJavaScript(`({ injected: document.documentElement.dataset.driftInjected || null, frame: document.documentElement.dataset.driftFrame || null, events: document.documentElement.dataset.driftEvents || null })`);
    results.probeInjected = extra.injected;
    try { results.probeFrame = JSON.parse(extra.frame); } catch { results.probeFrame = extra.frame; }
    try { results.probeEvents = JSON.parse(extra.events); } catch { results.probeEvents = extra.events; }

    // 2) Real Chrome Web Store install.
    const r = await extensions.installById(`https://chromewebstore.google.com/detail/dark-reader/${DARK_READER}`);
    results.installed = r.name;
    results.listed = extensions.list().map((x) => x.name);

    // Use a page with no native dark mode (Dark Reader skips sites that already have one).
    await sleep(1500);
    const t = browser.createTab({ url: 'https://news.ycombinator.com' });
    const wc = browser.wcOf(t.id);
    for (let i = 0; i < 40 && (wc.isLoading() || wc.getURL() === ''); i++) await sleep(250);
    for (let i = 0; i < 20 && !results.contentScriptRan; i++) {
      await sleep(500);
      results.darkreaderNodes = await wc.executeJavaScript(`document.querySelectorAll('style.darkreader').length`);
      results.pageBackground = await wc.executeJavaScript(`getComputedStyle(document.body).backgroundColor`);
      results.contentScriptRan = results.darkreaderNodes > 0;
    }
    results.extensionCountInState = browser.serialize().extensionCount;

    await extensions.remove(DARK_READER);
    results.removed = !extensions.list().some((x) => x.name === 'Dark Reader');
  } catch (e) {
    results.error = e.stack || String(e);
  }
  console.log(JSON.stringify(results, null, 1));
  const ok = results.probe && results.probe.ok && results.probe.tabCount >= 1 && results.probe.url && results.probe.fontSettings === 'object' &&
    results.probe.injected === 'ok' && results.probeInjected === 'yes' && results.probeFrame && results.probeFrame.echo === 'hello-from-frame' &&
    results.probeEvents && Array.isArray(results.probeEvents.onInstalled) && results.probeEvents.onInstalled.join() === 'install' &&
    results.installed && results.contentScriptRan && results.extensionCountInState === 2 && results.removed;
  fs.rmSync(tmp, { recursive: true, force: true });
  app.exit(ok ? 0 : 1);
});
