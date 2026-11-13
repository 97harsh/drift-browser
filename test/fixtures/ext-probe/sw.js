chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg !== 'probe') return;
  chrome.tabs.query({}).then((tabs) => {
    chrome.storage.local.set({ last: Date.now() }).then(() =>
      reply({ ok: true, tabCount: tabs.length, senderTab: sender.tab ? sender.tab.id : null, url: sender.tab ? sender.tab.url : null }));
  });
  return true;
});
