document.documentElement.dataset.driftProbe = 'content';
// Embed an extension page as an iframe, like Bitwarden's inline autofill menu.
const f = document.createElement('iframe');
f.src = chrome.runtime.getURL('frame.html');
f.style.cssText = 'position:fixed;bottom:0;right:0;width:120px;height:40px;border:0;z-index:2147483647';
addEventListener('message', (e) => {
  if (e.data && e.data.driftProbeFrame) document.documentElement.dataset.driftFrame = JSON.stringify(e.data.driftProbeFrame);
});
(document.body || document.documentElement).appendChild(f);
chrome.runtime.sendMessage('probe').then((r) => {
  document.documentElement.dataset.driftProbe = JSON.stringify(r);
  setTimeout(() => chrome.runtime.sendMessage('events').then((ev) => (document.documentElement.dataset.driftEvents = JSON.stringify(ev))), 1500);
});
