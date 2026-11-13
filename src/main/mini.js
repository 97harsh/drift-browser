// "Little Drift": a small throwaway window for quick lookups and links opened
// from other apps. One click promotes it to a real tab in the main window.
const { BaseWindow, WebContentsView } = require('electron');
const path = require('path');
const { toUrl } = require('./util');

const BAR = 38;
const minis = new Set();

function openMini(browser, url, size = {}) {
  const win = new BaseWindow({
    width: size.width || 980,
    height: size.height ? size.height + BAR : 720,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 12 },
    vibrancy: 'sidebar',
    title: 'Little Drift',
  });
  const bar = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, '..', 'preload', 'mini.js'), contextIsolation: true, sandbox: false },
  });
  bar.setBackgroundColor('#00000000');
  const page = new WebContentsView({
    webPreferences: { session: browser.getSession(browser.space().profile || 'default'), sandbox: true, contextIsolation: true },
  });
  if (page.setBorderRadius) page.setBorderRadius(8);
  win.contentView.addChildView(bar);
  win.contentView.addChildView(page);
  const layout = () => {
    const { width, height } = win.getContentBounds();
    bar.setBounds({ x: 0, y: 0, width, height: BAR });
    page.setBounds({ x: 6, y: BAR, width: width - 12, height: height - BAR - 6 });
  };
  layout();
  win.on('resize', layout);

  const wc = page.webContents;
  const push = () => !bar.webContents.isDestroyed() && bar.webContents.send('mini:state', { url: wc.getURL(), title: wc.getTitle(), loading: wc.isLoading() });
  ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading'].forEach((e) => wc.on(e, push));
  wc.setWindowOpenHandler(({ url: u }) => {
    wc.loadURL(u);
    return { action: 'deny' };
  });

  bar.webContents.loadFile(path.join(__dirname, '..', 'ui', 'mini.html'));
  const target = toUrl(url, browser.settings.searchEngine);
  if (target) wc.loadURL(target).catch(() => {});
  else bar.webContents.once('did-finish-load', () => bar.webContents.send('mini:focus'));

  const mini = {
    win,
    bar,
    page,
    navigate: (input) => {
      const u = toUrl(input, browser.settings.searchEngine);
      if (u) wc.loadURL(u).catch(() => {});
    },
    promote: () => {
      const u = wc.getURL();
      win.close();
      if (u) {
        browser.createTab({ url: u });
        browser.win.focus();
      }
    },
  };
  minis.add(mini);
  if (browser.extensions) browser.extensions.addTab(wc, win);
  win.on('closed', () => {
    if (browser.extensions && !wc.isDestroyed()) browser.extensions.removeTab(wc);
    minis.delete(mini);
    if (!wc.isDestroyed()) wc.close();
    if (!bar.webContents.isDestroyed()) bar.webContents.close();
  });
  win.focus();
  return mini;
}

function miniFor(sender) {
  for (const m of minis) if (m.bar.webContents === sender) return m;
  return null;
}

module.exports = { openMini, miniFor };
