// Probe service worker: records what Drift exposes to extensions, mirroring how
// password managers (Bitwarden) attach autofill UI to pages.
const events = { tabsUpdatedComplete: 0, navCommitted: 0, navCompleted: 0 };
chrome.runtime.onInstalled.addListener((d) => chrome.storage.local.get('installed').then(({ installed = [] }) => chrome.storage.local.set({ installed: [...installed, d.reason + (d.previousVersion ? ':' + d.previousVersion : '')] })));
// Counts are persisted so they survive the worker being stopped and restarted.
const bump = (k) => chrome.storage.local.get('ev').then(({ ev = {} }) => chrome.storage.local.set({ ev: { ...ev, [k]: (ev[k] || 0) + 1 } }));
chrome.tabs.onUpdated.addListener((_id, info) => { if (info.status === 'complete') { events.tabsUpdatedComplete++; bump('tabsUpdatedComplete'); } });
chrome.webNavigation.onCommitted.addListener((d) => { events.navCommitted++; if (d.frameId === 0) bump('commit:' + new URL(d.url).hostname); });
chrome.webNavigation.onCompleted.addListener(() => { events.navCompleted++; });

let portMessages = 0;
chrome.runtime.onConnect.addListener((port) => {
  port.onMessage.addListener((m) => { portMessages++; port.postMessage({ echo: m, n: portMessages }); });
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg === 'probe') {
    (async () => {
      const tabs = await chrome.tabs.query({});
      await chrome.storage.local.set({ last: Date.now() });
      // Inject a file into exactly the sender's frame, like Bitwarden's bootstrap scripts.
      let injected = null;
      try {
        const target = typeof sender.frameId === 'number' ? { tabId: sender.tab.id, frameIds: [sender.frameId] } : { tabId: sender.tab.id };
        await chrome.scripting.executeScript({ target, files: ['injected.js'], injectImmediately: true, world: 'ISOLATED' });
        injected = 'ok';
      } catch (e) { injected = 'ERR ' + e.message; }
      let frames = null;
      try { frames = (await chrome.webNavigation.getAllFrames({ tabId: sender.tab.id })).map((f) => f.frameId); } catch (e) { frames = 'ERR ' + e.message; }
      reply({
        ok: true, fontSettings: typeof chrome.fontSettings, tabCount: tabs.length,
        senderTab: sender.tab ? sender.tab.id : null, senderFrameId: sender.frameId, url: sender.tab ? sender.tab.url : null,
        injected, frames,
      });
    })();
    return true;
  }
  if (msg === 'events') { chrome.storage.local.get(['ev', 'installed']).then(({ ev = {}, installed = [] }) => reply({ ...events, portMessages, persisted: ev, onInstalled: installed })); return true; }
});
