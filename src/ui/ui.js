/* Drift sidebar / chrome UI. Vanilla JS; state comes from the main process. */
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
};
const act = (a, p) => window.drift.act(a, p);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const fmt$ = (n) => (n < 0.01 && n > 0 ? '<$0.01' : '$' + (n || 0).toFixed(2));
const ago = (ts) => {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return new Date(ts).toLocaleDateString();
};

let S = null; // latest state
let L = null; // latest layout
const overlays = new Set();
function setOverlay(name, on) {
  const before = overlays.size > 0;
  on ? overlays.add(name) : overlays.delete(name);
  if (before !== overlays.size > 0) act('overlay', { on: overlays.size > 0 });
}

// ---------------------------------------------------------------- rendering
function tabTitle(t) {
  return t.customTitle || t.title || hostOf(t.url) || t.url;
}
function favicon(t, cls = 'fi') {
  if (t.favicon) {
    const img = h('img', { class: cls, src: t.favicon, draggable: 'false' });
    img.onerror = () => img.replaceWith(letter(t, cls));
    return img;
  }
  return letter(t, cls);
}
function letter(t, cls) {
  const ch = (hostOf(t.url) || tabTitle(t) || '?')[0].toUpperCase();
  return h('span', { class: cls + ' letter' }, ch);
}

function render() {
  if (!S) return;
  const space = S.spaces.find((s) => s.id === S.activeSpaceId) || S.spaces[0];
  document.documentElement.style.setProperty('--space', space.color);
  document.documentElement.style.setProperty('--sidebar-w', S.settings.sidebarWidth + 'px');
  document.documentElement.style.setProperty('--claude-w', S.settings.claude.panelWidth + 'px');
  document.body.classList.toggle('collapsed', !!S.settings.sidebarCollapsed);
  document.body.classList.toggle('claude-open', !!S.claudeOpen);
  $('#space-header .space-icon').textContent = space.icon || '●';
  $('#space-header .space-name').textContent = space.name + (space.profile && space.profile !== 'default' ? ` · ${space.profile}` : '');
  $('#empty .big-icon').textContent = space.icon || '✦';

  const active = S.tabs.find((t) => t.id === S.activeTabId);
  const ub = $('#urlbar .text');
  ub.textContent = active ? hostOf(active.url) || active.url : 'Search or enter URL';
  $('#urlbar .lock').textContent = active && active.url.startsWith('https:') ? '🔒' : '⌕';
  $('#urlbar .blocked').textContent = active && active.blocked ? `⛨ ${active.blocked}` : '';
  $('#btn-back').disabled = !active?.canGoBack;
  $('#btn-fwd').disabled = !active?.canGoForward;
  $('#btn-reload').textContent = active?.loading ? '✕' : '↻';

  const inSplit = new Set(S.split ? [S.split.left, S.split.right] : []);
  // favorites
  const favs = S.tabs.filter((t) => t.zone === 'favorite').sort((a, b) => a.order - b.order);
  const favEl = $('#favorites');
  favEl.replaceChildren(
    ...favs.map((t) =>
      h(
        'div',
        {
          class: `fav ${t.id === S.activeTabId ? 'active' : ''} ${t.audible ? 'audible' : ''}`,
          title: tabTitle(t),
          draggable: 'true',
          'data-id': t.id,
          onclick: () => act('tab.activate', { id: t.id }),
          oncontextmenu: (e) => tabMenu(e, t),
          ondragstart: (e) => dragStart(e, t),
        },
        favicon(t, 'fi'),
        t.loaded ? h('span', { class: 'dot' }) : null,
      ),
    ),
  );
  const tabRow = (t) =>
    h(
      'div',
      {
        class: `tab ${t.id === S.activeTabId ? 'active' : ''} ${t.loaded ? '' : 'unloaded'} ${t.loading ? 'loading' : ''} ${inSplit.has(t.id) ? 'in-split' : ''}`,
        title: `${tabTitle(t)}\n${t.url}`,
        draggable: 'true',
        'data-id': t.id,
        onclick: () => act('tab.activate', { id: t.id }),
        onauxclick: (e) => e.button === 1 && act('tab.close', { id: t.id }),
        ondblclick: (e) => startRename(e, t),
        oncontextmenu: (e) => tabMenu(e, t),
        ondragstart: (e) => dragStart(e, t),
      },
      favicon(t),
      h('span', { class: 'title' }, tabTitle(t)),
      t.audible || t.muted
        ? h('span', { class: 'audio', title: t.muted ? 'Unmute' : 'Mute', onclick: (e) => (e.stopPropagation(), act('tab.mute', { id: t.id })) }, t.muted ? '🔇' : '🔊')
        : null,
      h('button', { class: 'close', title: t.zone === 'today' ? 'Close (⌘W)' : 'Unload', onclick: (e) => (e.stopPropagation(), act('tab.close', { id: t.id })) }, t.zone === 'today' ? '✕' : '–'),
    );
  const zone = (z) => S.tabs.filter((t) => t.zone === z && t.spaceId === S.activeSpaceId).sort((a, b) => a.order - b.order);
  $('#pinned').replaceChildren(...zone('pinned').map(tabRow));
  $('#today').replaceChildren(...zone('today').map(tabRow));

  // spaces
  $('#spaces').replaceChildren(
    ...S.spaces.map((sp, i) =>
      h(
        'button',
        {
          class: `space-dot ${sp.id === S.activeSpaceId ? 'active' : ''}`,
          title: `${sp.name} (⌃${i + 1})`,
          style: sp.id === S.activeSpaceId ? `color:${sp.color}` : '',
          onclick: () => act('space.switch', { id: sp.id }),
          oncontextmenu: (e) => spaceMenu(e, sp),
        },
        sp.icon || '●',
      ),
    ),
  );

  // media: audible tabs that aren't visible
  const visible = new Set([S.activeTabId, ...inSplit]);
  const media = S.tabs.filter((t) => (t.audible || t.playing) && !visible.has(t.id));
  $('#media').replaceChildren(
    ...media.map((t) =>
      h(
        'div',
        { class: 'media-card' },
        favicon(t),
        h('div', { class: 't', onclick: () => act('tab.activate', { id: t.id }) }, tabTitle(t), h('div', { class: 'sub' }, hostOf(t.url))),
        h('button', { class: 'icon tiny', title: 'Play/Pause', onclick: () => act('media.toggle', { id: t.id }) }, t.playing ? '❚❚' : '▶'),
        h('button', { class: 'icon tiny', title: 'Picture in Picture', onclick: () => act('pip', { id: t.id }) }, '⧉'),
        h('button', { class: 'icon tiny', title: 'Mute', onclick: () => act('tab.mute', { id: t.id }) }, t.muted ? '🔇' : '🔊'),
      ),
    ),
  );
  const dls = (S.downloads || []).filter((d) => d.state === 'progressing' || Date.now() - (d.doneAt || (d.doneAt = Date.now())) < 15000).slice(0, 3);
  $('#downloads').replaceChildren(
    ...dls.map((d) =>
      h(
        'div',
        { class: 'dl', onclick: () => d.path && act('openExternal', { url: 'file://' + d.path }) },
        `${d.state === 'progressing' ? '↓' : d.state === 'completed' ? '✓' : '✕'} ${d.name}`,
        d.state === 'progressing' ? h('div', { class: 'bar' }, h('span', { style: `width:${d.total ? (100 * d.received) / d.total : 30}%` })) : null,
      ),
    ),
  );
  const shield = $('#btn-shield');
  shield.textContent = `⛨ ${S.settings.adblock ? compact(S.adblockTotal) : 'off'}`;
  shield.classList.toggle('off', !S.settings.adblock);
  shield.title = S.settings.adblock ? `${S.adblockTotal} ads & trackers blocked (click to toggle)` : 'Ad blocker off (click to enable)';
  $('#claude-model').value = S.settings.claude.model;

  $('#empty').classList.toggle('hidden', !!S.activeTabId);
  renderPeek();
  if (findOpen) updateFindCount();
}
const compact = (n) => (n >= 10000 ? Math.round(n / 1000) + 'k' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));

function applyLayout() {
  if (!L) return;
  const c = L.content;
  Object.assign($('#stage').style, { left: c.x + 'px', top: c.y + 'px', width: c.width + 'px', height: c.height + 'px' });
  document.body.classList.toggle('fullscreen', !!L.fullscreen);
  const W = innerWidth, H = innerHeight;
  $('#bg').style.clipPath = L.panes.length
    ? `path(evenodd, "M0 0H${W}V${H}H0Z M${c.x} ${c.y}h${c.width}v${c.height}h-${c.width}Z")`
    : 'none';
  const div = $('#split-divider');
  if (L.panes.length === 2) {
    const left = L.panes.find((p) => p.x === c.x) || L.panes[0];
    div.style.display = 'block';
    div.style.left = left.width + 'px';
  } else div.style.display = 'none';
  renderPeek();
}

// ---------------------------------------------------------------- drag & drop
let dragId = null;
function dragStart(e, t) {
  dragId = t.id;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/uri-list', t.url);
}
for (const zoneEl of [$('#favorites'), $('#pinned'), $('#today')]) {
  zoneEl.addEventListener('dragover', (e) => {
    if (!dragId) return;
    e.preventDefault();
    document.querySelectorAll('.drop-before').forEach((x) => x.classList.remove('drop-before'));
    const row = e.target.closest('[data-id]');
    if (row && row.dataset.id !== dragId) row.classList.add('drop-before');
    zoneEl.classList.add('drop-zone');
  });
  zoneEl.addEventListener('dragleave', () => zoneEl.classList.remove('drop-zone'));
  zoneEl.addEventListener('drop', (e) => {
    e.preventDefault();
    zoneEl.classList.remove('drop-zone');
    const row = e.target.closest('[data-id]');
    document.querySelectorAll('.drop-before').forEach((x) => x.classList.remove('drop-before'));
    if (dragId) act('tab.move', { id: dragId, zone: zoneEl.dataset.zone, beforeId: row && row.dataset.id !== dragId ? row.dataset.id : null });
    dragId = null;
  });
}
document.addEventListener('dragend', () => {
  dragId = null;
  document.querySelectorAll('.drop-zone,.drop-before').forEach((x) => x.classList.remove('drop-zone', 'drop-before'));
});

// ---------------------------------------------------------------- menus
function showMenu(e, items) {
  e.preventDefault();
  const m = $('#ctxmenu');
  m.replaceChildren(
    ...items.filter(Boolean).map((it) =>
      it === '-' ? h('hr') : it.label && !it.run ? h('div', { class: 'label' }, it.label) : h('button', { onclick: () => (hideMenu(), it.run()) }, it.text),
    ),
  );
  m.classList.remove('hidden');
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(e.clientX, innerWidth - r.width - 8) + 'px';
  m.style.top = Math.min(e.clientY, innerHeight - r.height - 8) + 'px';
  setOverlay('menu', true);
}
function hideMenu() {
  $('#ctxmenu').classList.add('hidden');
  setOverlay('menu', false);
}
document.addEventListener('mousedown', (e) => {
  if (!$('#ctxmenu').classList.contains('hidden') && !e.target.closest('#ctxmenu')) hideMenu();
});

function tabMenu(e, t) {
  const others = S.spaces.filter((s) => s.id !== t.spaceId);
  showMenu(e, [
    t.zone !== 'favorite' && { text: '★ Add to Favorites', run: () => act('tab.move', { id: t.id, zone: 'favorite' }) },
    t.zone === 'today' && { text: '📌 Pin Tab', run: () => act('tab.move', { id: t.id, zone: 'pinned' }) },
    t.zone !== 'today' && { text: 'Unpin (move to Today)', run: () => act('tab.move', { id: t.id, zone: 'today' }) },
    t.id !== S.activeTabId && S.activeTabId && { text: '◫ Open in Split View', run: () => act('split.with', { id: t.id }) },
    { text: 'Duplicate', run: () => act('tab.duplicate', { id: t.id }) },
    { text: 'Rename…', run: () => startRename(null, t) },
    { text: 'Copy URL', run: () => navigator.clipboard.writeText(t.url).then(() => toast('Copied')) },
    t.pinnedUrl && t.zone !== 'today' && { text: 'Reset to Pinned URL', run: () => act('tab.resetPinned', { id: t.id }) },
    t.loaded && { text: 'Unload (free memory)', run: () => act('tab.unload', { id: t.id }) },
    others.length && t.zone !== 'favorite' && '-',
    others.length && t.zone !== 'favorite' && { label: 'Move to Space' },
    ...(t.zone !== 'favorite' ? others.map((sp) => ({ text: `${sp.icon} ${sp.name}`, run: () => act('tab.toSpace', { id: t.id, spaceId: sp.id }) })) : []),
    '-',
    { text: t.zone === 'today' ? 'Close Tab' : 'Remove', run: () => (t.zone === 'today' ? act('tab.close', { id: t.id }) : act('tab.move', { id: t.id, zone: 'today' }).then(() => act('tab.close', { id: t.id }))) },
  ]);
}
function spaceMenu(e, sp) {
  showMenu(e, [
    { text: 'Edit Space…', run: () => openSettings('spaces') },
    { text: 'New Space', run: () => newSpace() },
    S.spaces.length > 1 && '-',
    S.spaces.length > 1 && { text: `Delete “${sp.name}”`, run: () => confirm(`Delete space “${sp.name}” and archive its tabs?`) && act('space.delete', { id: sp.id }) },
  ]);
}
function startRename(e, t) {
  const row = document.querySelector(`.tab[data-id="${t.id}"] .title`);
  if (!row) return;
  const input = h('input', { class: 'rename', value: tabTitle(t) });
  row.replaceWith(input);
  input.focus();
  input.select();
  const done = (save) => {
    if (save) act('tab.rename', { id: t.id, title: input.value.trim() === t.title ? '' : input.value.trim() });
    else render();
  };
  input.onkeydown = (ev) => {
    if (ev.key === 'Enter') done(true);
    if (ev.key === 'Escape') done(false);
    ev.stopPropagation();
  };
  input.onblur = () => done(true);
  input.onclick = (ev) => ev.stopPropagation();
}

// Electron has no window.prompt — a tiny inline one.
function askText(title, placeholder = '') {
  return new Promise((resolve) => {
    const input = h('input', { placeholder });
    const box = h('div', { class: 'palette' }, input, h('div', { class: 'mode' }, title + ' · Enter to confirm, Esc to cancel'));
    const back = h('div', { class: 'backdrop', onmousedown: (e) => e.target === back && done(null) }, box);
    const done = (v) => {
      back.remove();
      setOverlay('ask', false);
      resolve(v);
    };
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') done(input.value.trim());
      if (e.key === 'Escape') done(null);
    };
    $('#overlay-root').append(back);
    setOverlay('ask', true);
    setTimeout(() => input.focus(), 20);
  });
}

async function newSpace() {
  const name = await askText('Name your new space', 'Work, Side project, Shopping…');
  if (name === null) return;
  const icons = ['✦', '◆', '●', '▲', '■', '★', '☀', '☾', '♣', '⚑'];
  await act('space.add', { name: name || undefined, icon: icons[S.spaces.length % icons.length] });
}

// ---------------------------------------------------------------- sidebar wiring
$('#btn-sidebar').onclick = () => act('sidebar.toggle');
$('#btn-back').onclick = () => act('tab.back');
$('#btn-fwd').onclick = () => act('tab.forward');
$('#btn-reload').onclick = () => {
  const t = S && S.tabs.find((x) => x.id === S.activeTabId);
  act(t?.loading ? 'tab.stop' : 'tab.reload');
};
$('#urlbar').onclick = () => openPalette('location');
$('#btn-newtab').onclick = () => openPalette('new');
$('#btn-clear').onclick = () => act('tabs.clearToday');
$('#btn-addspace').onclick = () => newSpace();
$('#btn-space-menu').onclick = (e) => spaceMenu(e, S.spaces.find((s) => s.id === S.activeSpaceId));
$('#btn-library').onclick = () => openLibrary();
$('#btn-settings').onclick = () => openSettings();
$('#btn-claude').onclick = () => toggleClaude();
$('#btn-shield').onclick = () => act('adblock.set', { enabled: !S.settings.adblock }).then(() => toast(S.settings.adblock ? 'Ad blocker off' : 'Ad blocker on'));

// Swipe between spaces with horizontal trackpad scroll on the sidebar.
let swipeAcc = 0, swipeT = 0;
$('#sidebar').addEventListener('wheel', (e) => {
  if (Math.abs(e.deltaX) < Math.abs(e.deltaY) * 1.5) return;
  swipeAcc += e.deltaX;
  clearTimeout(swipeT);
  swipeT = setTimeout(() => (swipeAcc = 0), 220);
  if (Math.abs(swipeAcc) > 160) {
    const i = S.spaces.findIndex((s) => s.id === S.activeSpaceId);
    const n = S.spaces[(i + (swipeAcc > 0 ? 1 : -1) + S.spaces.length) % S.spaces.length];
    act('space.switch', { id: n.id });
    swipeAcc = 0;
  }
}, { passive: true });

// Resizers (sidebar, Claude panel, split divider). Overlay mode while dragging so
// the UI keeps receiving mouse events over web content.
function dragResize(el, onMove, onEnd) {
  el.addEventListener('mousedown', (e) => {
    e.preventDefault();
    setOverlay('resize', true);
    el.classList.add('dragging');
    const move = (ev) => onMove(ev);
    const up = (ev) => {
      removeEventListener('mousemove', move);
      removeEventListener('mouseup', up);
      el.classList.remove('dragging');
      setOverlay('resize', false);
      onEnd && onEnd(ev);
    };
    addEventListener('mousemove', move);
    addEventListener('mouseup', up);
  });
}
dragResize($('#sidebar-resizer'), (e) => {
  document.documentElement.style.setProperty('--sidebar-w', Math.max(200, Math.min(420, e.clientX)) + 'px');
}, (e) => act('sidebar.width', { width: e.clientX }));
dragResize($('#claude-resizer'), (e) => {
  document.documentElement.style.setProperty('--claude-w', Math.max(300, Math.min(720, innerWidth - e.clientX)) + 'px');
}, (e) => act('claude.width', { width: innerWidth - e.clientX }));
dragResize($('#split-divider'), (e) => {
  if (!L) return;
  act('split.ratio', { ratio: (e.clientX - L.content.x) / L.content.width });
});
$('#split-divider').ondblclick = () => act('split.swap');

// Collapsed sidebar: hover the left edge to peek it.
$('#edge-hover').addEventListener('mouseenter', () => {
  document.body.classList.add('peeking-sidebar');
  setOverlay('sidebar-peek', true);
});
$('#sidebar').addEventListener('mouseleave', () => {
  if (!document.body.classList.contains('peeking-sidebar') || !$('#ctxmenu').classList.contains('hidden')) return;
  document.body.classList.remove('peeking-sidebar');
  setOverlay('sidebar-peek', false);
});

// ---------------------------------------------------------------- command bar
let palette = null;
const COMMANDS = () => {
  const active = S.tabs.find((t) => t.id === S.activeTabId);
  const list = [
    { t: 'New Space', k: '⇧⌘N', run: newSpace },
    { t: 'Toggle Sidebar', k: '⌘S', run: () => act('sidebar.toggle') },
    { t: 'Toggle Claude', k: '⌘J', run: toggleClaude },
    { t: 'Copy URL', k: '⇧⌘C', run: () => act('copyUrl') },
    { t: 'Picture in Picture', k: '⇧⌘P', run: () => act('pip') },
    { t: 'Split View with…', k: '⌃⇧=', run: () => openPalette('split') },
    S.split && { t: 'Close Split View', k: '⌃⇧-', run: () => act('split.close') },
    { t: 'Find in Page', k: '⌘F', run: openFind },
    { t: 'Boost this Site', k: '⇧⌘B', run: () => openBoost() },
    { t: 'Library: History & Archive', k: '⌘Y', run: () => openLibrary() },
    { t: 'Claude API Usage', run: () => openLibrary('usage') },
    { t: 'Settings', k: '⌘,', run: () => openSettings() },
    { t: 'Remote Control & MCP Setup', run: () => openSettings('remote') },
    { t: 'Reopen Closed Tab', k: '⇧⌘T', run: () => act('reopenClosed') },
    { t: 'Clear Today Tabs', run: () => act('tabs.clearToday') },
    { t: 'New Little Drift Window', k: '⌥⌘N', run: () => act('mini.open', {}) },
    { t: S.settings.adblock ? 'Turn Ad Blocker Off' : 'Turn Ad Blocker On', run: () => act('adblock.set', { enabled: !S.settings.adblock }) },
    active && { t: active.zone === 'today' ? 'Pin Tab' : 'Unpin Tab', k: '⌘D', run: () => act('tab.move', { id: active.id, zone: active.zone === 'today' ? 'pinned' : 'today' }) },
    active && { t: 'Add Tab to Favorites', run: () => act('tab.move', { id: active.id, zone: 'favorite' }) },
    active && { t: 'Duplicate Tab', run: () => act('tab.duplicate', { id: active.id }) },
    active && { t: 'Developer Tools', k: '⌥⌘I', run: () => act('devtools') },
    active && { t: 'Shop with Claude…', run: () => (toggleClaude(true), prefill('Find me the best ')) },
    ...S.spaces.map((sp, i) => ({ t: `Go to Space: ${sp.icon} ${sp.name}`, k: `⌃${i + 1}`, run: () => act('space.switch', { id: sp.id }) })),
    ...(active && active.zone !== 'favorite' ? S.spaces.filter((sp) => sp.id !== active.spaceId).map((sp) => ({ t: `Move Tab to Space: ${sp.name}`, run: () => act('tab.toSpace', { id: active.id, spaceId: sp.id }) })) : []),
  ];
  return list.filter(Boolean);
};

function openPalette(mode = 'new') {
  closePalette();
  const active = S.tabs.find((t) => t.id === S.activeTabId);
  const input = h('input', { placeholder: mode === 'split' ? 'Pick a tab or enter a URL for the right pane…' : 'Search, enter URL, ask Claude, or type a command…', spellcheck: 'false' });
  const results = h('div', { class: 'results' });
  const box = h('div', { class: 'palette' }, input, h('div', { class: 'mode' }, { new: 'Open in a new tab', location: 'Open in this tab', split: 'Split view' }[mode]), results);
  const back = h('div', { class: 'backdrop', onmousedown: (e) => e.target === back && closePalette() }, box);
  $('#overlay-root').append(back);
  setOverlay('palette', true);
  palette = { el: back, input, results, mode, items: [], sel: 0, seq: 0 };
  if (mode === 'location' && active) input.value = active.url;
  input.focus();
  input.select();
  input.oninput = () => refreshPalette();
  input.onkeydown = (e) => {
    if (e.key === 'Escape') closePalette();
    else if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) movePal(1), e.preventDefault();
    else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) movePal(-1), e.preventDefault();
    else if (e.key === 'Enter') {
      e.preventDefault();
      const it = palette.items[palette.sel];
      if (it) runItem(it, e.metaKey);
    } else if (e.key === 'Tab' && palette.items[palette.sel]?.kind === 'url') {
      e.preventDefault();
    }
  };
  refreshPalette(true);
}
function closePalette() {
  if (!palette) return;
  palette.el.remove();
  palette = null;
  setOverlay('palette', false);
}
function movePal(d) {
  palette.sel = (palette.sel + d + palette.items.length) % Math.max(1, palette.items.length);
  paintPalette();
}
function runItem(it, alt) {
  const mode = palette.mode;
  closePalette();
  if (it.kind === 'tab') return mode === 'split' ? act('split.with', { id: it.id }) : act('tab.activate', { id: it.id });
  if (it.kind === 'cmd') return it.run();
  if (it.kind === 'claude') return toggleClaude(true), sendClaude(it.q);
  // url / search / history / suggestion
  if (mode === 'split') return act('split.url', { url: it.url });
  if (mode === 'location' && !alt) return act('tab.navigate', { url: it.url });
  return act('tab.create', { url: it.url });
}
function looksLikeUrl(q) {
  return /^(https?:|file:|about:)/i.test(q) || (!/\s/.test(q) && /^(localhost|[\w-]+(\.[\w-]+)+)(:\d+)?(\/.*)?$/i.test(q));
}
function scoreText(q, ...fields) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  let total = 0;
  for (const w of words) {
    let best = -1;
    fields.forEach((f, i) => { const k = String(f || '').toLowerCase().indexOf(w); if (k >= 0) best = Math.max(best, 100 - Math.min(k, 60) - i * 15); });
    if (best < 0) return 0;
    total += best;
  }
  return total;
}
async function refreshPalette(initial) {
  if (!palette) return;
  const q = palette.input.value.trim();
  const seq = ++palette.seq;
  const items = [];
  if (q && !(initial && palette.mode === 'location')) {
    if (looksLikeUrl(q)) items.push({ kind: 'url', icon: '↗', t: q, u: 'Open', url: q });
    else items.push({ kind: 'search', icon: '⌕', t: q, u: 'Search', url: q });
    if (palette.mode !== 'split' && q.split(/\s+/).length > 1) items.push({ kind: 'claude', icon: '✳', t: `Ask Claude: ${q}`, u: '', q });
  }
  const tabs = S.tabs
    .map((t) => ({ t, sc: q ? scoreText(q, tabTitle(t), t.url) : t.zone === 'today' ? 1 : 0 }))
    .filter((x) => x.sc > 0 && (palette.mode !== 'split' || x.t.id !== S.activeTabId))
    .sort((a, b) => b.sc - a.sc)
    .slice(0, q ? 6 : 8);
  for (const { t } of tabs) {
    const sp = S.spaces.find((s) => s.id === t.spaceId);
    items.push({ kind: 'tab', id: t.id, tab: t, t: tabTitle(t), u: (sp && sp.id !== S.activeSpaceId ? sp.name + ' · ' : '') + hostOf(t.url), k: 'Switch to Tab' });
  }
  if (palette.mode !== 'split') {
    const cmds = COMMANDS().map((c) => ({ c, sc: q ? scoreText(q, c.t) : 0 })).filter((x) => x.sc > 0).sort((a, b) => b.sc - a.sc).slice(0, q ? 5 : 0);
    for (const { c } of cmds) items.push({ kind: 'cmd', icon: '›', t: c.t, k: c.k || '', run: c.run });
  }
  palette.items = items;
  palette.sel = 0;
  paintPalette();
  if (!q) return;
  const [hist, sugg] = await Promise.all([act('history.query', { q, limit: 8 }), act('suggestions', { q })]);
  if (!palette || seq !== palette.seq) return;
  const openUrls = new Set(S.tabs.map((t) => t.url));
  for (const hItem of hist.filter((x) => !openUrls.has(x.url)).slice(0, 6)) palette.items.push({ kind: 'history', icon: '🕘', t: hItem.title || hItem.url, u: hostOf(hItem.url), url: hItem.url });
  for (const s of sugg.filter((s) => s.toLowerCase() !== q.toLowerCase()).slice(0, 4)) palette.items.push({ kind: 'search', icon: '⌕', t: s, u: 'Search', url: s });
  paintPalette();
}
function paintPalette() {
  palette.results.replaceChildren(
    ...palette.items.map((it, i) =>
      h(
        'div',
        { class: `res ${i === palette.sel ? 'sel' : ''}`, onmousemove: () => { if (palette.sel !== i) { palette.sel = i; paintPalette(); } }, onclick: (e) => runItem(it, e.metaKey) },
        it.tab ? favicon(it.tab) : h('span', { class: 'fi' }, it.icon || '•'),
        h('span', { class: 't' }, it.t),
        it.u ? h('span', { class: 'u' }, it.u) : null,
        it.k ? h('span', { class: 'k' }, it.k) : null,
      ),
    ),
  );
  const sel = palette.results.children[palette.sel];
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}

// ---------------------------------------------------------------- find in page
let findOpen = null;
function openFind() {
  if (findOpen) return findOpen.input.focus(), findOpen.input.select();
  const input = h('input', { placeholder: 'Find in page' });
  const count = h('span', { class: 'count' });
  const bar = h('div', { class: 'findbar' }, '⌕', input, count,
    h('button', { class: 'icon tiny', onclick: () => act('find', { text: input.value, forward: false, findNext: true }) }, '↑'),
    h('button', { class: 'icon tiny', onclick: () => act('find', { text: input.value, forward: true, findNext: true }) }, '↓'),
    h('button', { class: 'icon tiny', onclick: closeFind }, '✕'));
  const back = h('div', { class: 'backdrop clear', onmousedown: (e) => e.target === back && closeFind() }, bar);
  if (L) bar.style.right = innerWidth - (L.content.x + L.content.width) + 14 + 'px';
  $('#overlay-root').append(back);
  setOverlay('find', true);
  findOpen = { el: back, input, count };
  input.focus();
  input.oninput = () => act('find', { text: input.value });
  input.onkeydown = (e) => {
    if (e.key === 'Escape') closeFind();
    if (e.key === 'Enter') act('find', { text: input.value, forward: !e.shiftKey, findNext: true });
  };
}
function updateFindCount() {
  findOpen.count.textContent = S.find ? `${S.find.active}/${S.find.total}` : '';
}
function closeFind() {
  if (!findOpen) return;
  findOpen.el.remove();
  findOpen = null;
  act('find.stop');
  setOverlay('find', false);
}

// ---------------------------------------------------------------- peek
let peekEl = null;
function renderPeek() {
  const want = S && S.peek && L && L.peek;
  if (!want) {
    if (peekEl) peekEl.remove(), (peekEl = null), setOverlay('peek', false);
    return;
  }
  if (!peekEl) {
    peekEl = h('div', { class: 'backdrop', onmousedown: (e) => e.target === peekEl && act('peek.close') });
    $('#overlay-root').prepend(peekEl);
    setOverlay('peek', true);
  }
  const p = L.peek;
  peekEl.replaceChildren(
    h('div', { class: 'peekbar', style: `left:${p.x}px;top:${p.y - 44}px;width:${p.width}px` },
      h('span', { class: 't' }, S.peek.title || S.peek.url),
      h('button', { class: 'secondary', onclick: () => act('peek.promote', { mode: 'split' }) }, '◫ Split'),
      h('button', { class: 'secondary', onclick: () => act('peek.promote', { mode: 'tab' }) }, '↗ Open as Tab'),
      h('button', { class: 'icon tiny', title: 'Close (Esc)', onclick: () => act('peek.close') }, '✕')),
  );
}

// ---------------------------------------------------------------- modals
let modal = null;
function openModal(title, sections, initial) {
  closeModal();
  const body = h('div', { class: 'body' });
  const nav = h('nav', {}, h('h3', {}, title));
  const show = (key) => {
    nav.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.key === key));
    body.replaceChildren();
    sections.find((s) => s.key === key).render(body);
  };
  for (const s of sections) nav.append(h('button', { 'data-key': s.key, onclick: () => show(s.key) }, s.title));
  const box = h('div', { class: 'modal' }, nav, body, h('button', { class: 'icon close-x', onclick: closeModal }, '✕'));
  const back = h('div', { class: 'backdrop', onmousedown: (e) => e.target === back && closeModal() }, box);
  $('#overlay-root').append(back);
  setOverlay('modal', true);
  modal = { el: back, show };
  show(initial || sections[0].key);
}
function closeModal() {
  if (!modal) return;
  modal.el.remove();
  modal = null;
  setOverlay('modal', false);
}
const field = (label, control, help) => h('div', { class: 'field' }, h('label', {}, label), control, help ? h('div', { class: 'help', html: help }) : null);
const set = (patch) => act('settings.update', { patch });
const check = (label, value, onchange) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: value, onchange: (e) => onchange(e.target.checked) }), label);
const select = (value, options, onchange) => h('select', { onchange: (e) => onchange(e.target.value) }, ...options.map(([v, t]) => h('option', { value: v, selected: v === value }, t)));

function openSettings(initial) {
  const st = () => S.settings;
  openModal('Settings', [
    {
      key: 'general', title: 'General',
      render: (b) => {
        b.append(h('h2', {}, 'General'),
          field('Search engine', select(st().searchEngine, [
            ['https://www.google.com/search?q=%s', 'Google'],
            ['https://duckduckgo.com/?q=%s', 'DuckDuckGo'],
            ['https://www.bing.com/search?q=%s', 'Bing'],
            ['https://kagi.com/search?q=%s', 'Kagi'],
            ['https://search.brave.com/search?q=%s', 'Brave Search'],
            ['https://www.perplexity.ai/search?q=%s', 'Perplexity'],
          ], (v) => set({ searchEngine: v }))),
          field('Archive Today tabs after', select(String(st().autoArchiveHours), [['12', '12 hours'], ['24', '24 hours'], ['168', '7 days'], ['720', '30 days'], ['0', 'Never']], (v) => set({ autoArchiveHours: Number(v) })),
            'Like Arc, unpinned tabs you haven’t touched get archived automatically. Find them in Library → Archive.'),
          field('Media', check('Automatically open Picture-in-Picture when you leave a tab with a playing video', st().autoPip, (v) => set({ autoPip: v }))),
          field('Little Drift', h('div', { class: 'help' }, 'Press ⌥⌘N for a quick throwaway window. Links opened from other apps open there when Drift is your default browser (requires a packaged build: npm run dist).')),
        );
      },
    },
    {
      key: 'privacy', title: 'Ad Blocking',
      render: (b) => {
        b.append(h('h2', {}, 'Ad & Tracker Blocking'),
          field('Blocker', check('Block ads, trackers and annoyances on every site', st().adblock, (v) => act('adblock.set', { enabled: v }))),
          field('Filter level', select(st().adblockLevel, [['ads', 'Ads only'], ['ads-tracking', 'Ads + trackers'], ['full', 'Ads + trackers + annoyances (cookie banners, popups)']], (v) => act('adblock.set', { enabled: true, level: v })),
            'Uses EasyList, EasyPrivacy, uBlock Origin and Fanboy annoyance lists via the Ghostery engine, including cosmetic filtering and YouTube ad scriptlets.'),
          field('Blocked so far', h('div', {}, `${S.adblockTotal.toLocaleString()} requests this session`)),
        );
      },
    },
    {
      key: 'claude', title: 'Claude',
      render: (b) => {
        const key = h('input', { type: 'password', placeholder: st().claude.hasKey ? '•••••••• (saved — paste to replace)' : 'sk-ant-…' });
        b.append(h('h2', {}, 'Claude'),
          field('Anthropic API key', h('div', { class: 'row' }, key,
            h('button', { class: 'primary', onclick: () => act('claude.setKey', { key: key.value }).then(() => toast('API key saved (encrypted in Keychain)')) }, 'Save'),
            st().claude.hasKey ? h('button', { class: 'danger', onclick: () => act('claude.setKey', { key: '' }).then(() => toast('API key removed')) }, 'Remove') : null),
            'Encrypted with macOS Keychain via Electron safeStorage. Without a key, Drift falls back to <code>ANTHROPIC_API_KEY</code> or your <code>ant auth login</code> profile.'),
          field('Model', select(st().claude.model, [['claude-opus-5-5', 'Claude Opus 5.5 (default)'], ['claude-sonnet-5-5', 'Claude Sonnet 5.5'], ['claude-haiku-5-5', 'Claude Haiku 5.5'], ['claude-fable-5-2', 'Claude Fable 5.2']], (v) => set({ claude: { model: v } }))),
          field('Effort', select(st().claude.effort, [['low', 'Low (fastest, cheapest)'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high']], (v) => set({ claude: { effort: v } })), 'How hard Claude thinks per step. Browsing tasks usually do well at medium.'),
          field('Approvals', select(st().claude.approvals, [['ask', 'Ask before clicking, typing or navigating'], ['auto', 'Let Claude act on its own']], (v) => set({ claude: { approvals: v } })),
            'Either way, purchase steps (“Buy now”, “Place your order”, checkout) <b>always</b> require your click, and Claude never enters passwords or payment details.'),
        );
      },
    },
    {
      key: 'remote', title: 'Remote Control & MCP',
      render: async (b) => {
        const info = await act('control.info');
        const c = st().control;
        const base = info.tunnel?.url || info.local;
        const tokenBox = h('pre', { class: 'code' }, info.token);
        b.append(h('h2', {}, 'Remote Control, MCP & Debugging'),
          field('Control server', h('div', { class: 'row' },
            check('Enabled', c.enabled, (v) => set({ control: { enabled: v } }).then(() => modal && modal.show('remote'))),
            h('span', { class: `pill ${info.listening ? 'ok' : 'bad'}` }, info.listening ? `listening on ${info.local}` : info.error || 'stopped'),
            select(c.host, [['127.0.0.1', 'This Mac only'], ['0.0.0.0', 'Local network']], (v) => set({ control: { host: v } }).then(() => modal && modal.show('remote'))),
            h('input', { type: 'number', value: c.port, style: 'width:90px', onchange: (e) => set({ control: { port: Number(e.target.value) } }).then(() => modal && modal.show('remote')) })),
            'Every endpoint except <code>/health</code> needs the bearer token below.'),
          field('Token', h('div', {}, tokenBox, h('div', { class: 'row', style: 'margin-top:6px' },
            h('button', { class: 'secondary', onclick: () => navigator.clipboard.writeText(info.token).then(() => toast('Token copied')) }, 'Copy'),
            h('button', { class: 'danger', onclick: () => act('control.rotate').then(() => modal.show('remote')) }, 'Rotate')))),
          field('Use from Claude Code (MCP)', h('pre', { class: 'code' }, `claude mcp add --transport http drift ${base}/mcp --header "Authorization: Bearer ${info.token}"`),
            `Gives any MCP client ${info.tools.length} browser tools: ${info.tools.join(', ')}.`),
          field('Or any MCP client (JSON config)', h('pre', { class: 'code' }, JSON.stringify({ mcpServers: { drift: { type: 'http', url: `${base}/mcp`, headers: { Authorization: `Bearer ${info.token}` } } } }, null, 2))),
          field('REST', h('pre', { class: 'code' }, `curl -s ${base}/api/tools -H "Authorization: Bearer ${info.token}"\n\ncurl -s -X POST ${base}/api/tools/read_page \\\n  -H "Authorization: Bearer ${info.token}" -H 'content-type: application/json' -d '{}'`)),
          field('Cloud access (Cloudflare tunnel)', h('div', { class: 'row' },
            info.tunnel?.url ? h('span', { class: 'pill ok' }, info.tunnel.url) : info.tunnel?.starting ? h('span', { class: 'pill' }, 'starting…') : h('span', { class: 'pill' }, 'off'),
            h('button', { class: info.tunnel ? 'danger' : 'primary', onclick: async () => {
              const r = await act('control.tunnel', { on: !info.tunnel });
              if (r && r.error) toast(r.error);
              setTimeout(() => modal && modal.show('remote'), 300);
            } }, info.tunnel ? 'Stop tunnel' : 'Start tunnel')),
            'Publishes the control server at a random <code>https://*.trycloudflare.com</code> URL so cloud agents (Claude Code on the web, remote MCP clients) can drive this browser. Requires <code>brew install cloudflared</code>. The token still protects every call — rotate it if it leaks.'),
          field('Chrome DevTools Protocol', h('div', { class: 'row' },
            check(`Expose CDP on 127.0.0.1:${st().cdp.port}`, st().cdp.enabled, (v) => set({ cdp: { enabled: v } }).then(() => toast('Restart Drift to apply'))),
            h('button', { class: 'secondary', onclick: () => act('relaunch') }, 'Restart now')),
            'For Playwright / Puppeteer <code>connectOverCDP</code> or chrome://inspect. Local only and unauthenticated — leave off when not debugging.'),
        );
      },
    },
    {
      key: 'spaces', title: 'Spaces',
      render: (b) => {
        b.append(h('h2', {}, 'Spaces'), h('div', { class: 'help', style: 'margin-bottom:10px;color:var(--fg-dim)' }, 'Icon · name · profile · color. Spaces with different profiles keep separate cookies and logins (e.g. Work vs Personal).'));
        for (const sp of S.spaces) {
          const upd = (patch) => act('space.update', { id: sp.id, patch });
          b.append(h('div', { class: 'space-edit' },
            h('input', { value: sp.icon || '', maxlength: '2', onchange: (e) => upd({ icon: e.target.value }) }),
            h('input', { value: sp.name, onchange: (e) => upd({ name: e.target.value }) }),
            h('input', { value: sp.profile || 'default', title: 'Profile', onchange: (e) => upd({ profile: e.target.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '') || 'default' }) }),
            h('input', { type: 'color', value: sp.color, oninput: (e) => upd({ color: e.target.value }) }),
            S.spaces.length > 1 ? h('button', { class: 'danger', onclick: () => confirm(`Delete “${sp.name}”?`) && act('space.delete', { id: sp.id }).then(() => modal.show('spaces')) }, 'Delete') : h('span')));
        }
        b.append(h('button', { class: 'secondary', onclick: () => newSpace().then(() => modal && modal.show('spaces')) }, '＋ New Space'));
        // Air traffic control
        const routes = [...(st().routes || [])];
        const list = h('div');
        const paint = () => {
          list.replaceChildren(...routes.map((r, i) => h('div', { class: 'row', style: 'margin-bottom:6px' },
            h('input', { type: 'text', value: r.pattern, placeholder: 'github.com', oninput: (e) => (r.pattern = e.target.value.trim()) }),
            '→', select(r.spaceId, S.spaces.map((s) => [s.id, `${s.icon} ${s.name}`]), (v) => (r.spaceId = v)),
            h('button', { class: 'icon tiny', onclick: () => (routes.splice(i, 1), paint()) }, '✕'))));
        };
        paint();
        b.append(h('div', { style: 'height:20px' }), field('Air Traffic Control', h('div', {}, list, h('div', { class: 'row' },
          h('button', { class: 'secondary', onclick: () => (routes.push({ pattern: '', spaceId: S.activeSpaceId }), paint()) }, '＋ Add rule'),
          h('button', { class: 'primary', onclick: () => act('routes.set', { routes: routes.filter((r) => r.pattern) }).then(() => toast('Routes saved')) }, 'Save rules'))),
          'New tabs whose domain matches a rule open in that space automatically.'));
      },
    },
    {
      key: 'boosts', title: 'Boosts',
      render: (b) => {
        b.append(h('h2', {}, 'Boosts'), h('div', { class: 'help', style: 'margin-bottom:10px' }, 'Per-site custom CSS & JavaScript. Press ⇧⌘B on any page to boost it.'));
        const hosts = Object.keys(S.boosts || {});
        if (!hosts.length) b.append(h('div', { class: 'help' }, 'No boosts yet.'));
        for (const host of hosts) b.append(h('div', { class: 'list-row' }, h('span', { class: 't' }, host), h('span', { class: 'pill' }, S.boosts[host].enabled ? 'on' : 'off'),
          h('button', { class: 'secondary', onclick: () => openBoost(host) }, 'Edit')));
      },
    },
  ], initial);
}

function openBoost(hostArg) {
  const active = S.tabs.find((t) => t.id === S.activeTabId);
  const host = hostArg || (active && hostOf(active.url));
  if (!host) return toast('Open a site to boost it');
  const cur = (S.boosts || {})[host] || { enabled: true, css: '', js: '', zap: [] };
  openModal('Boost', [{
    key: 'b', title: host,
    render: (b) => {
      const css = h('textarea', { placeholder: 'body { font-family: Georgia; }' });
      css.value = cur.css || '';
      const js = h('textarea', { placeholder: "document.querySelector('#annoying')?.remove()" });
      js.value = cur.js || '';
      const zap = h('textarea', { placeholder: '.sidebar-ad\n#promo-banner', style: 'min-height:60px' });
      zap.value = (cur.zap || []).join('\n');
      let enabled = cur.enabled !== false;
      b.append(h('h2', {}, `Boost ${host}`),
        field('Enabled', check('Apply this boost', enabled, (v) => (enabled = v))),
        field('Hide elements (one CSS selector per line)', zap),
        field('Custom CSS', css),
        field('Custom JavaScript', js, 'Runs on every page load for this site, in the page context.'),
        h('div', { class: 'row', style: 'display:flex;gap:8px' },
          h('button', { class: 'primary', onclick: () => act('boost.set', { host, boost: { enabled, css: css.value, js: js.value, zap: zap.value.split('\n').map((s) => s.trim()).filter(Boolean) } }).then(() => (closeModal(), toast('Boost saved'))) }, 'Save & Reload'),
          (S.boosts || {})[host] ? h('button', { class: 'danger', onclick: () => act('boost.set', { host, boost: null }).then(() => (closeModal(), toast('Boost deleted'))) }, 'Delete') : null));
    },
  }]);
}

function openLibrary(initial) {
  openModal('Library', [
    {
      key: 'history', title: 'History',
      render: (b) => {
        const q = h('input', { type: 'text', placeholder: 'Search history…', style: 'width:100%;margin-bottom:10px' });
        const list = h('div');
        const load = async () => {
          const rows = await act('history.query', { q: q.value, limit: 300 });
          list.replaceChildren(...rows.map((r) => h('div', { class: 'list-row', onclick: () => (closeModal(), act('tab.create', { url: r.url })) },
            h('span', { class: 't' }, r.title || r.url), h('span', { class: 'u' }, hostOf(r.url)), h('span', { class: 'when' }, ago(r.ts)))));
        };
        q.oninput = load;
        b.append(h('h2', {}, 'History'), h('div', { class: 'field' }, q), list,
          h('button', { class: 'danger', style: 'margin-top:14px', onclick: () => confirm('Clear all history?') && act('history.clear').then(load) }, 'Clear history'));
        load();
        q.focus();
      },
    },
    {
      key: 'archive', title: 'Archive',
      render: async (b) => {
        const rows = await act('archive.list');
        b.append(h('h2', {}, 'Archived Tabs'), h('div', { class: 'help', style: 'margin-bottom:10px' }, 'Closed and auto-archived Today tabs. Click to restore.'),
          ...rows.map((r, i) => h('div', { class: 'list-row', onclick: () => act('archive.restore', { index: i }).then(() => modal && modal.show('archive')) },
            h('span', { class: 't' }, r.customTitle || r.title || r.url), h('span', { class: 'u' }, hostOf(r.url)), h('span', { class: 'when' }, `${r.reason === 'auto' ? 'auto · ' : ''}${ago(r.archivedAt)}`))));
      },
    },
    {
      key: 'downloads', title: 'Downloads',
      render: (b) => {
        b.append(h('h2', {}, 'Downloads (this session)'), ...(S.downloads || []).map((d) => h('div', { class: 'list-row', onclick: () => d.path && act('openExternal', { url: 'file://' + d.path }) },
          h('span', { class: 't' }, d.name), h('span', { class: 'when' }, d.state))));
        if (!(S.downloads || []).length) b.append(h('div', { class: 'help' }, 'Nothing downloaded yet.'));
      },
    },
    {
      key: 'usage', title: 'Claude API Usage',
      render: async (b) => {
        const { summary: u, recent } = await act('usage.get');
        const days = [];
        for (let i = 29; i >= 0; i--) days.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
        const max = Math.max(0.0001, ...days.map((d) => u.byDay[d] || 0));
        b.append(h('h2', {}, 'Claude API Usage'),
          h('div', { class: 'stats' }, ...[['Today', u.cost.today], ['7 days', u.cost.week], ['30 days', u.cost.month], ['All time', u.cost.all]].map(([l, v]) => h('div', { class: 'stat' }, h('div', { class: 'v' }, fmt$(v)), h('div', { class: 'l' }, l)))),
          h('div', { class: 'help', style: 'margin-bottom:6px' }, 'Daily spend, last 30 days'),
          h('div', { class: 'bars' }, ...days.map((d) => h('div', { title: `${d}: ${fmt$(u.byDay[d] || 0)}`, style: `height:${(100 * (u.byDay[d] || 0)) / max}%` }))),
          h('div', { class: 'help', style: 'margin:10px 0 16px' }, `${u.requests} requests · ${compact(u.tokens.input)} input · ${compact(u.tokens.output)} output · ${compact(u.tokens.cacheRead)} cache-read · ${compact(u.tokens.cacheWrite)} cache-write tokens. Costs are estimates from list prices; your Anthropic Console bill is authoritative.`),
          h('table', { class: 'data' }, h('tr', {}, h('th', {}, 'Model'), h('th', { class: 'num' }, 'Cost')),
            ...Object.entries(u.byModel).map(([m, c]) => h('tr', {}, h('td', {}, m), h('td', { class: 'num' }, fmt$(c))))),
          h('div', { style: 'height:16px' }),
          h('table', { class: 'data' }, h('tr', {}, h('th', {}, 'When'), h('th', {}, 'Model'), h('th', { class: 'num' }, 'In'), h('th', { class: 'num' }, 'Out'), h('th', { class: 'num' }, 'Cache'), h('th', { class: 'num' }, 'Cost')),
            ...recent.slice(0, 50).map((r) => h('tr', {}, h('td', {}, ago(r.ts)), h('td', {}, r.model), h('td', { class: 'num' }, r.input_tokens), h('td', { class: 'num' }, r.output_tokens), h('td', { class: 'num' }, r.cache_read_input_tokens), h('td', { class: 'num' }, fmt$(r.cost))))),
          h('button', { class: 'danger', style: 'margin-top:14px', onclick: () => confirm('Reset the usage ledger?') && act('usage.clear').then(() => modal.show('usage')) }, 'Reset ledger'));
      },
    },
  ], initial);
}

// ---------------------------------------------------------------- Claude panel
const log = $('#claude-log');
let current = null; // assistant message element being streamed
let currentText = '';
let running = false;
let chatCost = 0;
const chips = new Map();

function toggleClaude(force) {
  const open = force === undefined ? !S.claudeOpen : force;
  act('claude.toggle', { open }).then(() => open && setTimeout(() => $('#claude-input').focus(), 50));
}
function prefill(text) {
  const ta = $('#claude-input');
  ta.value = text;
  ta.focus();
  ta.setSelectionRange(text.length, text.length);
}
function starters() {
  if (log.children.length) return;
  const ex = [
    ['Summarize this page', 'Summarize this page in a few bullet points.'],
    ['Shop on Amazon', 'Find me the best-rated noise-cancelling headphones under $200 on Amazon. Compare the top options.'],
    ['Compare my open tabs', 'Look at my open tabs in this space and compare what they offer.'],
    ['Debug this page', 'Check this page’s console errors and failed network requests and explain what is broken.'],
  ];
  log.append(h('div', { class: 'starters' }, h('div', { class: 'hint' }, 'Claude can read and operate your tabs. Try:'),
    ...ex.map(([t, q]) => h('button', { onclick: () => (q.includes('Find me') ? prefill(q) : sendClaude(q)) }, t))));
}
function scrollLog() {
  log.scrollTop = log.scrollHeight;
}
function sendClaude(text) {
  text = (text ?? $('#claude-input').value).trim();
  if (!text || running) return;
  $('#claude-input').value = '';
  log.querySelector('.starters')?.remove();
  log.append(h('div', { class: 'msg user' }, text));
  scrollLog();
  act('claude.ask', { text });
}
function md(src) {
  // Small, safe markdown: escape first, then format.
  let s = esc(src);
  const blocks = [];
  s = s.replace(/```[\w-]*\n([\s\S]*?)```/g, (_, code) => (blocks.push(`<pre>${code}</pre>`), `\u0000${blocks.length - 1}\u0000`));
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a data-href="$2">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a data-href="$2">$2</a>');
  const lines = s.split('\n');
  let out = '', list = null, table = null;
  const flush = () => {
    if (list) out += `</${list}>`, (list = null);
    if (table) out += '</table>', (table = null);
  };
  for (const line of lines) {
    let m;
    if ((m = line.match(/^\s*[-*•] (.*)/))) { if (list !== 'ul') flush(), (out += '<ul>'), (list = 'ul'); out += `<li>${m[1]}</li>`; }
    else if ((m = line.match(/^\s*\d+[.)] (.*)/))) { if (list !== 'ol') flush(), (out += '<ol>'), (list = 'ol'); out += `<li>${m[1]}</li>`; }
    else if (/^\s*\|.*\|\s*$/.test(line)) {
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue;
      if (!table) flush(), (out += '<table>'), (table = true);
      out += '<tr>' + line.trim().slice(1, -1).split('|').map((c) => `<td>${c.trim()}</td>`).join('') + '</tr>';
    } else if ((m = line.match(/^#{1,4} (.*)/))) { flush(); out += `<p><b>${m[1]}</b></p>`; }
    else if (!line.trim()) flush();
    else { flush(); out += `<p>${line}</p>`; }
  }
  flush();
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[i]);
}
log.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-href]');
  if (a) act('tab.create', { url: a.dataset.href, activate: !e.metaKey });
});

function productCards(r) {
  const items = (r.products || []).slice(0, 8);
  if (!items.length) return null;
  return h('div', { class: 'products' }, ...items.map((p) => h('div', { class: 'product', onclick: () => p.url && act('tab.create', { url: p.url }) },
    h('div', { class: 'pt' }, p.title || '(untitled)', h('div', { class: 'pm' }, [p.rating ? `★ ${p.rating}` : '', p.reviews ? `(${compact(p.reviews)})` : '', p.prime ? 'Prime' : '', p.sponsored ? 'Sponsored' : ''].filter(Boolean).join(' · '))),
    h('div', { class: 'pp' }, p.price || ''))));
}

window.drift.onClaude((ev) => {
  switch (ev.type) {
    case 'start':
      running = true;
      $('#claude-send').textContent = 'Stop ■';
      $('#claude-send').classList.add('stop');
      current = null;
      break;
    case 'text':
      if (!current) {
        current = h('div', { class: 'msg assistant' });
        currentText = '';
        log.append(current);
      }
      currentText += ev.delta;
      current.innerHTML = md(currentText);
      scrollLog();
      break;
    case 'turn-break':
      current = null;
      break;
    case 'tool': {
      current = null;
      let chip = chips.get(ev.id);
      if (!chip) {
        chip = h('div', { class: 'toolchip running' }, h('span', { class: 'st' }, '●'), h('span', { class: 'n' }, ev.name), h('span', { class: 's' }, briefInput(ev.input)));
        chips.set(ev.id, chip);
        log.append(chip);
      }
      chip.className = `toolchip ${ev.status}`;
      chip.querySelector('.st').textContent = { running: '●', done: '✓', error: '✕', denied: '⊘' }[ev.status];
      if (ev.summary) chip.querySelector('.s').textContent = ev.summary;
      if (ev.image) log.append(h('img', { class: 'shot', src: 'data:image/jpeg;base64,' + ev.image }));
      if (ev.result && ev.result.products) { const pc = productCards(ev.result); if (pc) log.append(pc); }
      scrollLog();
      break;
    }
    case 'approval': {
      current = null;
      const box = h('div', { class: `approval ${ev.sensitive ? 'sensitive' : ''}` },
        h('div', {}, ev.sensitive ? h('b', {}, '⚠ ' + ev.reason) : h('span', {}, 'Claude wants to run ', h('b', {}, ev.name))),
        h('pre', {}, JSON.stringify(ev.input, null, 1)));
      const decide = (d) => {
        act('claude.approve', { id: ev.id, decision: d });
        box.querySelector('.btns').replaceWith(h('div', { class: 'help' }, d === 'deny' ? 'Denied' : 'Allowed'));
      };
      box.append(h('div', { class: 'btns' },
        h('button', { class: ev.sensitive ? 'danger' : 'primary', onclick: () => decide('allow') }, 'Allow once'),
        ev.sensitive ? null : h('button', { class: 'secondary', onclick: () => decide('always') }, 'Allow for this chat'),
        h('button', { class: 'secondary', onclick: () => decide('deny') }, 'Deny')));
      log.append(box);
      scrollLog();
      break;
    }
    case 'notice':
      log.append(h('div', { class: 'msg notice' }, ev.message));
      break;
    case 'error':
      log.append(h('div', { class: 'msg error' }, ev.message));
      scrollLog();
      break;
    case 'done':
      running = false;
      current = null;
      chatCost += ev.cost || 0;
      $('#claude-cost').textContent = chatCost ? `this chat ≈ ${fmt$(chatCost)}` : '';
      $('#claude-send').textContent = 'Send ↵';
      $('#claude-send').classList.remove('stop');
      break;
    case 'reset':
      log.replaceChildren();
      chips.clear();
      chatCost = 0;
      $('#claude-cost').textContent = '';
      starters();
      break;
  }
});
function briefInput(input) {
  if (!input) return '';
  const v = input.url || input.query || input.text || input.selector || (input.index != null ? `#${input.index}` : '') || input.key || input.direction || input.code || '';
  return String(v).slice(0, 80);
}
$('#claude-send').onclick = () => (running ? act('claude.stop') : sendClaude());
$('#claude-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendClaude();
  }
  if (e.key === 'Escape' && running) act('claude.stop');
});
$('#claude-input').addEventListener('input', (e) => {
  e.target.style.height = 'auto';
  e.target.style.height = Math.min(180, e.target.scrollHeight) + 'px';
});
$('#claude-new').onclick = () => act('claude.reset');
$('#claude-close').onclick = () => toggleClaude(false);
$('#claude-model').onchange = (e) => set({ claude: { model: e.target.value } });
window.drift.onClaudePrefill((text) => {
  toggleClaude(true);
  prefill(text);
});

// ---------------------------------------------------------------- global keys & commands
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('#ctxmenu').classList.contains('hidden')) return hideMenu();
    if (palette) return closePalette();
    if (findOpen) return closeFind();
    if (modal) return closeModal();
    if (S && S.peek) return act('peek.close');
  }
});

window.drift.onCommand(({ name }) => {
  switch (name) {
    case 'newtab': return openPalette('new');
    case 'location': return openPalette('location');
    case 'split': return openPalette('split');
    case 'find': return openFind();
    case 'library': return openLibrary();
    case 'settings': return openSettings();
    case 'boost': return openBoost();
    case 'newspace': return newSpace();
    case 'claude-focus': return setTimeout(() => $('#claude-input').focus(), 30);
    case 'control-changed': return modal && modal.show('remote');
  }
});

let toastT;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('show'), 2200);
}
window.drift.onToast(toast);
window.drift.onState((st) => {
  S = st;
  render();
});
addEventListener('resize', () => applyLayout());
window.drift.onLayout((l) => {
  L = l;
  applyLayout();
});
starters();
