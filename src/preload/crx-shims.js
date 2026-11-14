// Extra chrome.* shims for gaps that neither Electron nor electron-chrome-extensions
// fill, so popular extensions behave as they do in Chrome. Runs in extension service
// workers and extension pages only (checked via chrome.runtime.id).
//
//  - chrome.fontSettings / chrome.commands stubs (Dark Reader et al. call them at startup)
//  - chrome.runtime.onInstalled: Electron never fires it, but extensions use it to set
//    first-run defaults. Bitwarden, for example, only turns on its in-field autofill
//    suggestions in its "install" handler. Drift's main process tracks which versions
//    each profile has seen and we deliver install/update exactly once, like Chrome.
const { contextBridge, ipcRenderer, webFrame } = require('electron');

function installShims() {
  let chrome = globalThis.chrome;
  if (!chrome || !chrome.runtime || !chrome.runtime.id) return;
  // electron-chrome-extensions freezes `chrome` after adding its APIs, which makes
  // later additions silently fail. The global binding is still writable, so swap in
  // an extensible copy carrying every existing API. Descriptors are made configurable
  // so later shims (onInstalled) can redefine individual namespaces.
  if (Object.isFrozen(chrome) || !Object.isExtensible(chrome)) {
    const copy = Object.create(Object.getPrototypeOf(chrome));
    const descs = Object.getOwnPropertyDescriptors(chrome);
    for (const d of Object.values(descs)) {
      d.configurable = true;
      if ('value' in d) d.writable = true;
    }
    Object.defineProperties(copy, descs);
    globalThis.chrome = copy;
    chrome = copy;
  }
  // Callback-or-promise helper matching Chrome's dual API style.
  const value = (v) => (...args) => {
    const cb = args.find((a) => typeof a === 'function');
    if (cb) return void setTimeout(() => cb(typeof v === 'function' ? v(...args) : v), 0);
    return Promise.resolve(typeof v === 'function' ? v(...args) : v);
  };
  const event = () => ({ addListener() {}, removeListener() {}, hasListener: () => false });
  if (!chrome.fontSettings) {
    const ctl = { levelOfControl: 'not_controllable' };
    chrome.fontSettings = {
      getFontList: value([]),
      getFont: value({ fontId: '', ...ctl }),
      setFont: value(undefined),
      clearFont: value(undefined),
      getDefaultFontSize: value({ pixelSize: 16, ...ctl }),
      setDefaultFontSize: value(undefined),
      clearDefaultFontSize: value(undefined),
      getDefaultFixedFontSize: value({ pixelSize: 13, ...ctl }),
      setDefaultFixedFontSize: value(undefined),
      clearDefaultFixedFontSize: value(undefined),
      getMinimumFontSize: value({ pixelSize: 0, ...ctl }),
      setMinimumFontSize: value(undefined),
      clearMinimumFontSize: value(undefined),
      onFontChanged: event(),
      onDefaultFontSizeChanged: event(),
      onDefaultFixedFontSizeChanged: event(),
      onMinimumFontSizeChanged: event(),
    };
  }
  if (!chrome.commands) {
    chrome.commands = { getAll: value([]), onCommand: event() };
  }
}

/** Service workers only: wrap chrome.runtime.onInstalled so Drift can deliver it. */
function installLifecycleShim() {
  const chrome = globalThis.chrome;
  if (!chrome || !chrome.runtime || !chrome.runtime.id || globalThis.__driftOnInstalled) return;
  const native = chrome.runtime;
  const listeners = new Set();
  let pending = null; // details delivered before any listener registered
  let delivered = false;
  const deliver = (fn, details) => {
    try {
      fn(details);
    } catch (e) {
      console.error('[drift] onInstalled listener threw', e);
    }
  };
  // If Electron ever fires the real event, don't double-deliver.
  try {
    native.onInstalled.addListener(() => (delivered = true));
  } catch {}
  const onInstalled = {
    addListener(fn) {
      listeners.add(fn);
      try {
        native.onInstalled.addListener(fn);
      } catch {}
      if (pending) deliver(fn, pending);
    },
    removeListener(fn) {
      listeners.delete(fn);
      try {
        native.onInstalled.removeListener(fn);
      } catch {}
    },
    hasListener: (fn) => listeners.has(fn),
    hasListeners: () => listeners.size > 0,
  };
  const runtime = new Proxy(native, {
    get(target, key) {
      if (key === 'onInstalled') return onInstalled;
      const v = Reflect.get(target, key, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  try {
    Object.defineProperty(chrome, 'runtime', { value: runtime, configurable: true, enumerable: true, writable: true });
  } catch (e) {
    console.warn('[drift] could not wrap chrome.runtime', e);
    return;
  }
  globalThis.__driftOnInstalled = (details) => {
    if (delivered || !details) return;
    delivered = true;
    listeners.forEach((fn) => deliver(fn, details));
    // Late registrations (within a few seconds of startup) still get the event.
    pending = details;
    setTimeout(() => (pending = null), 5000);
  };
}

// Service-worker preloads have no `document` (nor `location`). Main identifies the
// extension from the worker's registration, so we never send an id ourselves.
const isServiceWorker = typeof document === 'undefined';

function runInMain(func, args) {
  if ('executeInMainWorld' in contextBridge) return contextBridge.executeInMainWorld(args ? { func, args } : { func });
  if (webFrame) return webFrame.executeJavaScript(`(${func})(...${JSON.stringify(args || [])});`);
}

try {
  runInMain(installShims);
  if (isServiceWorker) {
    runInMain(installLifecycleShim);
    ipcRenderer
      .invoke('drift:crx-lifecycle')
      .then((details) => details && runInMain((d) => globalThis.__driftOnInstalled && globalThis.__driftOnInstalled(d), [details]))
      .catch((e) => console.warn('[drift] lifecycle query failed', e));
  }
} catch (e) {
  console.warn('[drift] crx shims failed', e);
}
