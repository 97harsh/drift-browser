const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mini', {
  navigate: (url) => ipcRenderer.invoke('mini', 'navigate', url),
  promote: () => ipcRenderer.invoke('mini', 'promote'),
  onState: (fn) => ipcRenderer.on('mini:state', (_e, s) => fn(s)),
  onFocus: (fn) => ipcRenderer.on('mini:focus', () => fn()),
});
