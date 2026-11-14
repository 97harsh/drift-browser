// Runs inside an extension iframe embedded in a web page (like Bitwarden's inline menu).
const port = chrome.runtime.connect({ name: 'probe-frame' });
port.onMessage.addListener((m) => parent.postMessage({ driftProbeFrame: m }, '*'));
port.postMessage('hello-from-frame');
