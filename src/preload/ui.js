// Bridge between the sidebar UI (renderer) and the main process.
const { contextBridge, ipcRenderer } = require('electron');

const listen = (channel) => (fn) => {
  const h = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('drift', {
  act: (action, payload) => ipcRenderer.invoke('act', action, payload),
  onState: listen('state'),
  onLayout: listen('layout'),
  onCommand: listen('command'),
  onToast: listen('toast'),
  onClaude: listen('claude:event'),
  onClaudePrefill: listen('claude:prefill'),
});
