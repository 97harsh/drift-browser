# Drift on real Chromium: plan

## Why
Drift 0.x is built on Electron. Google classifies Electron (and CEF) as an *embedded* browser and blocks Google sign-in in it. It also means Drift reimplements browser features (extensions, split view, sidebars) on top of a framework that was never meant to be a browser.

Arc, Brave, Vivaldi and Helium are **Chromium forks**: they build the browser from Chromium's source with their own patches. Google treats them as real browsers. That is the long-term home for Drift.

## What Chromium already gives us (2026)
| Drift feature | Stock Chromium |
|---|---|
| Vertical tabs | ✅ native (stable since Apr 2026) |
| Split view | ✅ native since Chrome 145. Extensions can create and undo splits (`tabs.createSplit` / `unsplit`, Chrome 155) |
| Picture-in-picture, including auto-PiP | ✅ native |
| Chrome Web Store, every extension API | ✅ native (Bitwarden etc. "just work") |
| Google sign-in | ✅ |
| Profiles (per-space logins) | ✅ native profiles |
| Tab groups (building block for Spaces) | ✅ |

## Architecture
```
Drift.app (Chromium fork, patch series)
├── branding patches: name, icon, bundle id, user-data dir, default settings
├── built-in "Drift" component extension (MV3, preinstalled, can't be removed)
│   ├── side panel: Arc-style sidebar (favorites, pinned/today, spaces, auto-archive)
│   ├── side panel: Claude agent (tool loop over chrome.tabs/scripting/debugger)
│   ├── new-tab override: command bar
│   ├── Peek, Little Drift windows, Boosts, Air Traffic Control
│   └── usage ledger, settings
├── built-in ad blocker (uBlock Origin Lite or a native filter engine)
└── drift-helper (native messaging host, small Node/Go binary)
    └── localhost REST + MCP server → extension → browser
        (no --remote-debugging-port, so Google never sees an automation flag)
```

Phase 3 adds C++ patches for things extensions can't do: an Arc-style window chrome (hide the top tab strip, per-space colors, a sidebar in the native frame), a quick-switch space gesture, and a Peek overlay that works without the side panel.

## Phases
**Phase 1: Drift extension. Runs on this Mac today, no Chromium build.**
Port Drift's features into an MV3 extension, reusing the existing UI and Claude code. Develop and test it in stock Chrome, Chromium or Helium. Google sign-in works immediately because the browser is real Chrome or Chromium. This is the same code Phase 2 bundles.

**Phase 2: fork and branding. Needs a build machine.**
Start from Helium's or ungoogled-chromium's patch-series build setup. Add Drift branding and bundle the Phase 1 extension plus the native-messaging helper as built-in components. Produce signed DMGs. Rebase onto every Chromium stable release, about every 4 weeks.

**Phase 3: native Arc-style UI (C++ patches).**

## Build machine (the hard prerequisite)
Chromium on macOS needs a Mac with **16 GB RAM minimum (32 GB+ recommended), 100 GB+ free disk, 8+ cores, and full Xcode**.

The current dev Mac (M1, 8 GB RAM, 39 GB free) can't do it. Options:
| Option | Rough cost | Notes |
|---|---|---|
| AWS EC2 Mac (mac2-m2pro.metal, 32 GB) | ~$1.5/hr, 24 h minimum per allocation | First build ~2–3 h, then incremental. Can be a self-hosted GitHub Actions runner. |
| MacStadium / Scaleway Mac mini M-series | ~$100–200/month | Always-on build box |
| Own hardware: Mac mini or Studio with 32 GB+, 512 GB+ | one-time | Fastest iteration |
| External SSD (≥250 GB) on the current Mac | ~$60 | Fixes disk only; 8 GB RAM stays the bottleneck (builds may fail at link time) |

## Sources
- Chrome split view and the extensions API: https://developer.chrome.com/blog/split-view-api-extensions
- Chrome native vertical tabs: https://techcrunch.com/2026/04/07/chrome-is-finally-getting-vertical-tabs/
- Chromium macOS build requirements (Helium docs): https://www.mintlify.com/imputnet/helium/development/requirements
- Chromium mac build instructions: https://chromium.googlesource.com/chromium/src/+/HEAD/docs/mac_build_instructions.md
