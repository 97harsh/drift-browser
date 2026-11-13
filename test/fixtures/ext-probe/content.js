document.documentElement.dataset.driftProbe = 'content';
chrome.runtime.sendMessage('probe').then((r) => {
  document.documentElement.dataset.driftProbe = JSON.stringify(r);
});
