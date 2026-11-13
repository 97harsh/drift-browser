// One registry of browser-automation tools, shared by the in-app Claude agent,
// the MCP server and the REST API. Each tool: zod schema + kind + run().
//   kind 'read' — observes only; 'act' — changes pages/tabs (Claude asks first in 'ask' mode).
const { z } = require('zod');
const scripts = require('./pagescripts');
const { score, summarizeUsage } = require('./util');

// Clicks whose target matches this always need a human (money moves).
const PURCHASE_RE = /\b(buy now|place (your )?order|proceed to (checkout|buy)|complete (purchase|order)|pay now|confirm (purchase|payment|order)|submit order|subscribe( now)?|start (your )?(free )?trial|1-click)\b/i;

const tabId = z.string().optional().describe('Tab id from list_tabs. Defaults to the active tab.');
const target = {
  index: z.number().int().optional().describe('Element index from read_page'),
  selector: z.string().optional().describe('CSS selector (alternative to index)'),
};

function makeTools(browser, extras = {}) {
  const resolve = async (id) => {
    const tid = id || browser.activeTabId();
    const tab = browser.tab(tid);
    if (!tab) throw new Error(id ? `No tab with id ${id}` : 'No active tab. Use open_tab first.');
    browser.ensureView(tab);
    const wc = browser.wcOf(tid);
    if (wc.isLoading()) await waitLoad(wc, 15000);
    return { tab, wc };
  };
  const isVisible = (tid) => {
    const v = browser.views.get(tid);
    return v && browser.win.contentView.children.includes(v);
  };
  const tabInfo = (t) => {
    const wc = browser.wcOf(t.id);
    return {
      id: t.id,
      title: wc ? wc.getTitle() : t.title,
      url: wc ? wc.getURL() : t.url,
      zone: t.zone,
      space: t.spaceId ? browser.space(t.spaceId)?.name : null,
      active: t.id === browser.activeTabId(),
      loaded: !!wc,
      audible: !!browser.rt.get(t.id)?.audible,
    };
  };
  const target2 = (a) => {
    if (a.index == null && !a.selector) throw new Error('Pass index (from read_page) or selector');
    return a.index != null ? { index: a.index } : { selector: a.selector };
  };

  const tools = [
    {
      name: 'list_tabs',
      kind: 'read',
      description: 'List open tabs across all spaces (favorites, pinned, today) with ids, titles and URLs.',
      schema: z.object({ spaceOnly: z.boolean().optional().describe('Only tabs in the active space') }),
      run: async ({ spaceOnly }) => {
        const tabs = spaceOnly ? browser.visibleOrder() : browser.s.tabs;
        return { activeSpace: browser.space().name, spaces: browser.s.spaces.map((s) => ({ id: s.id, name: s.name })), tabs: tabs.map(tabInfo) };
      },
    },
    {
      name: 'open_tab',
      kind: 'act',
      description: 'Open a new tab with a URL or search query. Returns the new tab id.',
      schema: z.object({ url: z.string().describe('URL or search terms'), background: z.boolean().optional() }),
      run: async ({ url, background }) => {
        const t = browser.createTab({ url, activate: !background });
        await waitLoad(browser.wcOf(t.id), 15000);
        return tabInfo(t);
      },
    },
    {
      name: 'navigate',
      kind: 'act',
      description: 'Load a URL (or search query) in a tab.',
      schema: z.object({ url: z.string(), tabId }),
      run: async ({ url, tabId: id }) => {
        const { tab, wc } = await resolve(id);
        browser.navigate(tab.id, url);
        await waitLoad(wc, 20000);
        return tabInfo(tab);
      },
    },
    {
      name: 'switch_tab',
      kind: 'act',
      description: 'Make a tab the active, visible tab.',
      schema: z.object({ tabId: z.string() }),
      run: async ({ tabId: id }) => {
        if (!browser.tab(id)) throw new Error('no such tab');
        browser.activate(id);
        return tabInfo(browser.tab(id));
      },
    },
    {
      name: 'close_tab',
      kind: 'act',
      description: 'Close a tab (pinned tabs are unloaded, not removed).',
      schema: z.object({ tabId }),
      run: async ({ tabId: id }) => {
        browser.closeTab(id || browser.activeTabId());
        return { ok: true };
      },
    },
    {
      name: 'history_nav',
      kind: 'act',
      description: 'Go back, forward, or reload in a tab.',
      schema: z.object({ action: z.enum(['back', 'forward', 'reload']), tabId }),
      run: async ({ action, tabId: id }) => {
        const { tab, wc } = await resolve(id);
        if (action === 'back') wc.navigationHistory.goBack();
        else if (action === 'forward') wc.navigationHistory.goForward();
        else wc.reload();
        await sleep(300);
        await waitLoad(wc, 15000);
        return tabInfo(tab);
      },
    },
    {
      name: 'read_page',
      kind: 'read',
      description:
        'Read the page: title, URL, visible text and a numbered list of interactive elements (links, buttons, inputs). Use the element indexes with click / type_text. Call again after the page changes.',
      schema: z.object({ tabId, maxChars: z.number().int().optional().describe('Max text characters (default 15000)') }),
      run: async ({ tabId: id, maxChars }) => {
        const { wc } = await resolve(id);
        const r = await wc.executeJavaScript(scripts.readPage(maxChars || 15000));
        r.elements = r.elements.map((e) => `[${e.i}] <${e.tag}${e.type ? ' ' + e.type : ''}> ${e.text}${e.href ? ' → ' + e.href : ''}${e.offscreen ? ' (offscreen)' : ''}`).join('\n');
        return r;
      },
    },
    {
      name: 'click',
      kind: 'act',
      description: 'Click an element by its read_page index or a CSS selector. Uses a real (trusted) mouse click when the tab is visible.',
      schema: z.object({ ...target, tabId }),
      // Returns a reason string when this click could spend money.
      sensitive: async (a) => {
        const { wc } = await resolve(a.tabId);
        const info = await wc.executeJavaScript(scripts.describe(target2(a)));
        return info && PURCHASE_RE.test(info) ? `This click looks like a purchase step: “${info.slice(0, 80)}”` : null;
      },
      run: async (a) => {
        const { tab, wc } = await resolve(a.tabId);
        const t = target2(a);
        const pos = await wc.executeJavaScript(scripts.locate(t));
        if (pos.error) throw new Error(pos.error);
        if (isVisible(tab.id)) {
          await sleep(60);
          const zf = wc.getZoomFactor();
          const x = Math.round(pos.x * zf);
          const y = Math.round(pos.y * zf);
          wc.sendInputEvent({ type: 'mouseMove', x, y });
          wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
          wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
        } else {
          await wc.executeJavaScript(scripts.jsClick(t), true);
        }
        await sleep(400);
        if (wc.isLoading()) await waitLoad(wc, 15000);
        return { clicked: `${pos.tag} "${pos.text}"`, url: wc.getURL() };
      },
    },
    {
      name: 'type_text',
      kind: 'act',
      description: 'Focus an input (by read_page index or selector) and type text. Optionally clear it first and press Enter.',
      schema: z.object({ ...target, text: z.string(), clear: z.boolean().optional(), submit: z.boolean().optional().describe('Press Enter after typing'), tabId }),
      run: async (a) => {
        const { wc } = await resolve(a.tabId);
        const r = await wc.executeJavaScript(scripts.focusForTyping(target2(a), a.clear !== false));
        if (r.error) throw new Error(r.error);
        await wc.insertText(a.text);
        if (a.submit) {
          await sleep(50);
          pressKey(wc, 'Enter');
          await sleep(400);
          if (wc.isLoading()) await waitLoad(wc, 15000);
        }
        return { ok: true, url: wc.getURL() };
      },
    },
    {
      name: 'press_key',
      kind: 'act',
      description: 'Send a key press to the page (e.g. Enter, Escape, Tab, ArrowDown, PageDown).',
      schema: z.object({ key: z.string(), tabId }),
      sensitive: async ({ key, tabId: id }) => {
        if (!/^(enter|return| |space)$/i.test(key)) return null;
        const { wc } = await resolve(id);
        const info = await wc.executeJavaScript(scripts.describe({ active: true }));
        return info && PURCHASE_RE.test(info) ? `Pressing ${key} would activate “${info.slice(0, 80)}”` : null;
      },
      run: async ({ key, tabId: id }) => {
        const { wc } = await resolve(id);
        pressKey(wc, key);
        await sleep(150);
        return { ok: true };
      },
    },
    {
      name: 'scroll',
      kind: 'read',
      description: 'Scroll the page up/down (by pixels or ~one screen) or to top/bottom.',
      schema: z.object({ direction: z.enum(['up', 'down', 'top', 'bottom']), amount: z.number().optional(), tabId }),
      run: async ({ direction, amount, tabId: id }) => {
        const { wc } = await resolve(id);
        return wc.executeJavaScript(scripts.scroll(direction, amount));
      },
    },
    {
      name: 'screenshot',
      kind: 'read',
      description: 'Capture the visible part of a tab as an image.',
      schema: z.object({ tabId }),
      image: true,
      run: async ({ tabId: id }) => {
        const { wc } = await resolve(id);
        let img = await wc.capturePage();
        const { width } = img.getSize();
        if (width > 1280) img = img.resize({ width: 1280 });
        return { image: img.toJPEG(75).toString('base64'), mediaType: 'image/jpeg', url: wc.getURL() };
      },
    },
    {
      name: 'wait_for',
      kind: 'read',
      description: 'Wait until a CSS selector appears (or just wait ms if no selector).',
      schema: z.object({ selector: z.string().optional(), timeoutMs: z.number().int().optional(), tabId }),
      run: async ({ selector, timeoutMs, tabId: id }) => {
        if (!selector) {
          await sleep(Math.min(timeoutMs || 1000, 30000));
          return { ok: true };
        }
        const { wc } = await resolve(id);
        return { found: await wc.executeJavaScript(scripts.waitFor(selector, Math.min(timeoutMs || 5000, 30000))) };
      },
    },
    {
      name: 'evaluate_js',
      kind: 'act',
      description: 'Run JavaScript in the page and return the (JSON-serializable) result. Powerful — prefer read_page/click when possible.',
      schema: z.object({ code: z.string().describe('An expression or IIFE; promises are awaited'), tabId }),
      sensitive: async ({ tabId: id }) => {
        const { wc } = await resolve(id);
        return /checkout|\/buy|payment|place-?order|\/gp\/cart|billing/i.test(wc.getURL()) ? 'Running scripts on a checkout/payment page' : null;
      },
      run: async ({ code, tabId: id }) => {
        const { wc } = await resolve(id);
        const v = await wc.executeJavaScript(code, true);
        return { result: v === undefined ? null : v };
      },
    },
    {
      name: 'extract_products',
      kind: 'read',
      description:
        'Extract structured product listings (title, price, rating, review count, Prime, ASIN, link) from a shopping page — Amazon search results and product pages are parsed precisely, other stores best-effort. Use this to compare products instead of reading raw text.',
      schema: z.object({ tabId, limit: z.number().int().optional().describe('Max products (default 30)') }),
      run: async ({ tabId: id, limit }) => {
        const { wc } = await resolve(id);
        return wc.executeJavaScript(scripts.extractProducts(limit || 30));
      },
    },
    {
      name: 'search_history',
      kind: 'read',
      description: 'Search browsing history by words in the title or URL.',
      schema: z.object({ query: z.string(), limit: z.number().int().optional() }),
      run: async ({ query, limit }) => {
        const hits = browser.s.history
          .map((h) => ({ h, sc: score(query, h.title, h.url) }))
          .filter((x) => x.sc > 0)
          .sort((a, b) => b.sc - a.sc || b.h.ts - a.h.ts)
          .slice(0, limit || 20)
          .map(({ h }) => ({ title: h.title, url: h.url, visited: new Date(h.ts).toISOString() }));
        return { results: hits };
      },
    },
    {
      name: 'get_console_logs',
      kind: 'read',
      description: 'Recent console messages from a tab (debugging).',
      schema: z.object({ tabId, level: z.enum(['debug', 'info', 'warning', 'error']).optional(), limit: z.number().int().optional() }),
      run: async ({ tabId: id, level, limit }) => {
        const { wc } = await resolve(id);
        let logs = browser.consoleLogs.get(wc.id) || [];
        if (level) logs = logs.filter((l) => String(l.level) === level);
        return { logs: logs.slice(-(limit || 50)) };
      },
    },
    {
      name: 'get_network_log',
      kind: 'read',
      description: 'Recent network requests from a tab with status codes and errors (debugging).',
      schema: z.object({ tabId, failedOnly: z.boolean().optional(), limit: z.number().int().optional() }),
      run: async ({ tabId: id, failedOnly, limit }) => {
        const { wc } = await resolve(id);
        let log = browser.networkLogs.get(wc.id) || [];
        if (failedOnly) log = log.filter((r) => r.error || r.status >= 400);
        return { requests: log.slice(-(limit || 50)) };
      },
    },
    {
      name: 'picture_in_picture',
      kind: 'act',
      description: 'Toggle picture-in-picture for the main video in a tab.',
      schema: z.object({ tabId }),
      run: async ({ tabId: id }) => ({ result: await browser.pip(id || browser.activeTabId()) }),
    },
    {
      name: 'split_view',
      kind: 'act',
      description: 'Show two tabs side by side. Pass otherTabId to split with the active tab, or close: true to exit split view.',
      schema: z.object({ otherTabId: z.string().optional(), url: z.string().optional().describe('Open this URL in the right pane'), close: z.boolean().optional() }),
      run: async ({ otherTabId, url, close }) => {
        if (close) browser.closeSplit();
        else if (url) browser.splitWithUrl(url);
        else browser.splitWith(otherTabId);
        return { split: browser.split };
      },
    },
    {
      name: 'browser_status',
      kind: 'read',
      description: 'Drift status: spaces, active tab, ad-block counts, Claude API usage summary.',
      schema: z.object({}),
      run: async () => ({
        activeSpace: browser.space().name,
        activeTab: browser.activeTab() ? tabInfo(browser.activeTab()) : null,
        adblock: { enabled: browser.settings.adblock, level: browser.settings.adblockLevel, blockedTotal: browser.adblock.stats.total },
        claudeUsage: summarizeUsage(browser.s.usage),
        ...(extras.status ? extras.status() : {}),
      }),
    },
  ];
  return tools;
}

function pressKey(wc, key) {
  const keyCode = { Enter: 'Return', Esc: 'Escape' }[key] || key;
  wc.sendInputEvent({ type: 'keyDown', keyCode });
  if (keyCode === 'Return') wc.sendInputEvent({ type: 'char', keyCode: '\r' });
  wc.sendInputEvent({ type: 'keyUp', keyCode });
}

function waitLoad(wc, timeout) {
  if (!wc || !wc.isLoading()) return Promise.resolve();
  return new Promise((res) => {
    const done = () => {
      clearTimeout(t);
      wc.removeListener('did-stop-loading', done);
      res();
    };
    const t = setTimeout(done, timeout);
    wc.once('did-stop-loading', done);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run a tool by name with validation; returns {ok, result | error}. */
async function runTool(tools, name, input) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return { ok: false, error: `Unknown tool ${name}` };
  const parsed = tool.schema.safeParse(input || {});
  if (!parsed.success) return { ok: false, error: 'Invalid input: ' + parsed.error.message };
  try {
    return { ok: true, result: await tool.run(parsed.data), tool };
  } catch (e) {
    return { ok: false, error: e.message || String(e), tool };
  }
}

/** JSON schema for the Claude API `input_schema` field. */
function jsonSchemaOf(tool) {
  const js = z.toJSONSchema(tool.schema);
  delete js.$schema;
  return js;
}

module.exports = { makeTools, runTool, jsonSchemaOf, PURCHASE_RE };
