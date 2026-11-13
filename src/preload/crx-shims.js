// Extra chrome.* shims for APIs that neither Electron nor electron-chrome-extensions
// provide, so popular extensions don't crash at startup. Runs in extension service
// workers and extension pages only (checked via chrome.runtime.id).
const { contextBridge, webFrame } = require('electron');

function installShims() {
  const chrome = globalThis.chrome;
  if (!chrome || !chrome.runtime || !chrome.runtime.id) return;
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

try {
  if ('executeInMainWorld' in contextBridge) contextBridge.executeInMainWorld({ func: installShims });
  else if (webFrame) webFrame.executeJavaScript(`(${installShims}());`);
} catch (e) {
  console.warn('[drift] crx shims failed', e);
}
