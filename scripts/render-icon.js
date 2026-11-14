// Usage: npx electron scripts/render-icon.js build/icon.svg  (writes build/icon.png)
// Render SVG files to 1024px PNGs with Chromium (transparent background).
const { app, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path');
const files = process.argv.filter((a) => a.endsWith('.svg'));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  for (const f of files) {
    const svg = fs.readFileSync(f, 'utf8');
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`));
    await new Promise((r) => setTimeout(r, 300));
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
    fs.writeFileSync(f.replace(/\.svg$/, '.png'), img.resize({ width: 1024, height: 1024 }).toPNG());
    console.log('rendered', path.basename(f));
  }
  app.exit(0);
});
