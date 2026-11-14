# Drift

A sidebar-first, Claude-native browser in the spirit of Arc. Built on Chromium (via Electron 45 / Chromium 142).

## Install (macOS)

1. Download the DMG for your Mac from [Releases](https://github.com/97harsh/drift-browser/releases/latest):
   - **Apple Silicon** (M1 and later): `Drift-<version>-arm64.dmg`
   - **Intel**: `Drift-<version>-x64.dmg`
2. Open it and drag **Drift** into **Applications**.
3. The first time, **right-click Drift → Open → Open**. Drift isn't notarized by Apple yet, so macOS asks once. If macOS says the app "is damaged", run `xattr -dr com.apple.quarantine /Applications/Drift.app` and open it again.
4. Optional: Settings (⌘,) → General → **Make Drift default**, then confirm in the macOS dialog.

## Run from source

```bash
npm install
npm start
```

Use a throwaway profile with `DRIFT_USER_DATA=/tmp/drift-dev npm start`. Run the tests with `npm test` (plus `npm run test:extensions` for the Chrome-extension smoke test).

To build the DMGs yourself, run `npm run dist`, which writes `dist/Drift-<version>-{arm64,x64}.dmg`. Builds are ad-hoc signed. For a notarized build, set `mac.identity` to your Developer ID and add `notarize` options in `package.json`.

## What's in it

### The Arc stuff
| Feature | How |
|---|---|
| **Vertical sidebar** with Favorites grid, Pinned and Today tabs | Drag tabs between zones; ⌘D pins/unpins |
| **Spaces** with their own colors and icons | ⌃1–9, ⌥⌘←/→, two-finger swipe on the sidebar, ⇧⌘N for a new one |
| **Profiles per space** (separate cookies and logins) | Settings → Spaces → profile |
| **Command bar**: tabs, history, commands, live suggestions, "Ask Claude" | ⌘T (new tab), ⌘L (current tab) |
| **Split view** with a draggable divider; double-click it to swap panes | ⌃⇧= or right-click a tab → Split; ⌃⇧- closes |
| **Peek**: links from pinned tabs open in a floating preview | Esc closes; promote it to a tab or a split |
| **Little Drift**: a throwaway quick window (external links open here once Drift is your default browser) | ⌥⌘N |
| **Auto-archive** of idle Today tabs (12h / 24h / 7d / 30d / never) | Library → Archive restores them |
| **Boosts**: per-site CSS, JS and "hide this element" selectors | ⇧⌘B |
| **Air Traffic Control**: route domains to spaces | Settings → Spaces |
| **Media controls** for background tabs that are playing audio | Shown in the sidebar automatically |
| Collapsible sidebar that pops out on hover at the left edge | ⌘S |
| Rename tabs, reset a pinned tab to its URL, unload tabs, reopen a closed tab | Double-click / right-click; ⇧⌘T |
| Copy URL, find in page, zoom, DevTools | ⇧⌘C, ⌘F, ⌘=/⌘-/⌘0, ⌥⌘I |

### Ad blocking
The Ghostery engine runs the EasyList, EasyPrivacy, uBlock Origin and Fanboy annoyance lists, with cosmetic filtering and YouTube scriptlets. There are three levels: ads; ads + trackers; ads + trackers + annoyances (cookie banners). Shield counts show per page in the URL pill and per session in the footer.

### Chrome extensions
Open the **Chrome Web Store** inside Drift and click **Add to Chrome**, just like in Chrome. You can also go to Settings → Extensions to paste a store link or ID, or to load an unpacked folder.
- Extension buttons and popups appear under the address bar.
- Extensions are shared across all spaces and profiles, auto-update every 5 hours, and add their items to the right-click menu.
- Each install asks you to confirm and shows the requested permissions.

Why this needed work even though Drift is Chromium: Electron includes Chromium's engine but not Chrome's browser layer. That layer is what provides Web Store installs, `chrome.tabs`, toolbar actions, popups and context menus. Drift adds them with [`electron-chrome-extensions`](https://github.com/samuelmaddock/electron-browser-shell) and `electron-chrome-web-store` (both MIT), plus its own shims for gaps such as `chrome.fontSettings` and `chrome.commands`.

**Compatibility** (`npm run test:extensions` checks the core path):
- ✅ Content scripts, service-worker messaging, `chrome.tabs`, `chrome.storage`, action icons and badges, popups, context menus.
- ✅ **Dark Reader** and **JSON Formatter**, installed from the Web Store, both work. Dark Reader intentionally skips sites that already have their own dark mode.
- ⚠️ Extensions that depend on `declarativeNetRequest` or other APIs Electron lacks may only partly work. Drift's built-in ad blocker covers the uBlock use case.

### Picture-in-picture
Use ⇧⌘P, right-click a video, or the media card in the sidebar. **Auto-PiP** pops a playing video out when you switch tabs.

### Claude, built in (⌘J)
- A panel that can **see and drive your tabs**: read pages, click, type, scroll, take screenshots, open and switch tabs, split view, PiP, and read console and network logs.
- **Shopping agent**: "find me the best noise-cancelling headphones under $200 on Amazon". The `extract_products` tool parses Amazon search and product pages into structured data (price, list price, rating, review count, Prime, sponsored flag, ASIN, link). For other stores it falls back to JSON-LD and heuristics. Results show as clickable product cards.
- **Safety rails**:
  - "Ask" approval mode (the default): Claude asks before clicking, typing or navigating.
  - Purchase steps ("Buy Now", "Place your order", checkout, subscribe) **always** need your click, and are refused outright over remote APIs.
  - Claude never enters passwords or payment details.
  - Page content is treated as untrusted.
- Models: Opus 5.5 (default), Sonnet 5.5, Haiku 5.5 or Fable 5.2, with adaptive thinking, an adjustable effort level, prompt caching and server-side refusal fallbacks.
- **API key** is encrypted with Keychain (Electron `safeStorage`). Without one, Drift uses `ANTHROPIC_API_KEY` or an `ant auth login` profile.
- Right-click selected text → "Ask Claude about Selection".

### API usage tracking
Every Claude call is logged with its tokens (input, output, cache read, cache write) and an estimated cost. **Library → Claude API Usage** shows today, 7-day, 30-day and all-time spend, a 30-day chart, a breakdown per model, and recent requests. The same data is at `GET /api/usage`.

### Remote control, MCP and debugging
Drift runs a token-protected control server (default `127.0.0.1:9555`). It exposes the same 21 tools Claude uses, over two protocols:

```bash
# Claude Code (or any MCP client) → drive Drift
claude mcp add --transport http drift http://127.0.0.1:9555/mcp --header "Authorization: Bearer <token>"

# REST
curl -s http://127.0.0.1:9555/api/tools -H "Authorization: Bearer <token>"
curl -s -X POST http://127.0.0.1:9555/api/tools/read_page -H "Authorization: Bearer <token>" -H 'content-type: application/json' -d '{}'
```

| Endpoint | |
|---|---|
| `GET /health` | Liveness check (no auth) |
| `GET /api/tools` | Tool catalog with JSON schemas |
| `POST /api/tools/:name` | Run a tool |
| `GET /api/state` | Spaces, tabs, split, downloads and ad-block stats |
| `GET /api/usage` | Claude API usage summary and ledger |
| `POST /mcp` | MCP over streamable HTTP (stateless) |

- **Cloud access**: Settings → Remote Control → *Start tunnel* opens a Cloudflare quick tunnel (`https://*.trycloudflare.com`) so cloud agents can reach your browser. It needs `brew install cloudflared`, and the token still guards every call. Rotate the token if it leaks.
- **CDP**: you can optionally expose the Chrome DevTools Protocol on `127.0.0.1:9222` for Playwright/Puppeteer `connectOverCDP`. This needs a restart, and CDP has no authentication.
- The token is in Settings → Remote Control & MCP, which also has copy-paste setup snippets.

Tools: `list_tabs open_tab navigate switch_tab close_tab history_nav read_page click type_text press_key scroll screenshot wait_for evaluate_js extract_products search_history get_console_logs get_network_log picture_in_picture split_view browser_status`

## Architecture

```
src/main/
  index.js           app bootstrap, menu/shortcuts, IPC action dispatcher
  browser.js         window, tabs, spaces, profiles, split, peek, layout, boosts, downloads
  tools.js           browser-automation tool registry (zod schemas) shared by Claude, MCP and REST
  pagescripts.js     scripts injected into pages (read_page, PiP, product extraction, …)
  claude.js          streaming tool-use agent loop (Anthropic SDK), approvals, usage ledger
  control-server.js  REST + MCP server, purchase guard, Cloudflare tunnel
  adblock.js         Ghostery engine across multiple profile sessions
  mini.js            Little Drift windows
  extensions.js      Chrome Web Store installs + chrome.* APIs per profile session
  store.js / util.js persistence, URL parsing, pricing
src/ui/              sidebar, command bar, Claude panel, settings and library (vanilla JS)
src/preload/         context-isolated bridges
```

Each tab is a `WebContentsView` inside a `BaseWindow`. The chrome UI is one transparent view that sits under the tabs, and moves above them only while an overlay (command bar, modal, peek) is open.

## Roadmap
- Folders in pinned tabs; Notes/Easels; AI tab tidy and auto-rename
- Broader Chrome extension API coverage (`declarativeNetRequest`, `chrome.commands` shortcuts); password-manager integration
- Developer ID signing and notarization, so the DMG opens with no Gatekeeper prompt; auto-update
- Persist split view across restarts; tab groups in split (3–4 panes)
- Sync across devices
