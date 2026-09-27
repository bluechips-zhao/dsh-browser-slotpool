<p align="center"><a href="./README.md">中文</a> · English</p>

# dsh-browser-slotpool — Concurrent Browser Slot Pool Plugin

> DSH bundle: 并发浏览器会话槽位池包装（slot-pool wrapper for concurrent browser sessions）

Gives DSH's `mcp-client` a **concurrent, idempotent, non-destructive, self-healing** browser MCP. It is just a **patch-layer bundle**: it adds one `@deepseek-ai/dsh-mcp-client` instance to the profile whose `command`/`args` point at this package's own `bin/browser-slotpool.mjs` (the launcher that manages the slot pool). Browser tools surface as `mcp__browser__<rawName>`.

End-to-end local verification (local server + pooled Chrome real render, not a mock):

<img width="824" height="798" alt="dsh-browser-slotpool demo" src="./docs/browser-slotpool-demo.png" />

```
[browser-slotpool] Claimed slot port 9222 (pid 35196)
[browser-slotpool] Rule: each slot is an independent session — never proxy or steal another slot.
[browser-slotpool] Starting Chrome for slot 9222: C:/Program Files/Google/Chrome/Application/chrome.exe
[browser-slotpool] Chrome ready on 9222
[browser-slotpool] Launching Playwright MCP -> http://127.0.0.1:9222
== initialize: Playwright
== tools: 31 | browser_close, browser_resize, browser_console_messages, browser_handle_dialog, browser_evaluate, browser_file_upload ...
== navigate: OK
== screenshot bytes: 14140
== snapshot contains marker: true
== SMOKE PASS (rendered real page in pooled chrome) ==
```

## What it solves

When multiple sessions/profiles share a browser, each launching its own instance causes port conflicts, memory blow-ups and cross-interference; sharing one causes contention. This bundle makes the instance cap explicit with a **slot pool**:

- **Slot pool**: a fixed set of CDP ports (default `9222,9223`), first-come first-served, rejects when full.
- **Atomic locking**: `fs.openSync(lock, "wx")` (O_EXCL exclusive create) for race-free locking.
- **PID liveness + stale-lock self-heal**: reclaims a slot when its owner dies — never stuck "all slots busy".
- **Idempotent readiness probe**: leaves an already-up CDP port alone, only spawns Chrome when not up; **never kills another slot's browser**.
- **Slot ownership isolation**: each mcp-client session owns exactly one port; never proxies or steals another session's slot.
- stdio is fully delegated to `@playwright/mcp`; diagnostics go only to stderr (keeps the MCP protocol channel clean).

## Install

Recommended: install from GitHub (no local build needed):

```sh
# Run from your DeepSeek Harness checkout (the same profile that hosts the GUI)
pnpm dsh plugin --profile web add github:bluechips-zhao/dsh-browser-slotpool
```

> If you're not comfortable with the CLI, just send this repository link
> `https://github.com/bluechips-zhao/dsh-browser-slotpool` to your AI assistant
> (DeepSeek Harness or another), and have it run the `dsh plugin` install command
> for you following this README.

`dsh plugin add` only installs the bundle into the profile's deps and writes `profile.bundles`; it does not auto-start a browser. **Restart the target profile** after installing.

### Configuration (one required step)

`!!js` is evaluated by DSH with `new Function`, so it has **no `import.meta`/module scope**. The launcher path therefore comes from the `DSH_BROWSER_LAUNCHER` env var (read by the bundle's `cordis.patch.yml` `args`). After install the launcher lives at:

```
<DSH_HOME>/profiles/<name>/node_modules/@deepseek-ai/dsh-browser-slotpool/bin/browser-slotpool.mjs
```

Set that absolute path (via `setx` or the profile startup script):

```powershell
# Temporary (current shell)
$env:DSH_BROWSER_LAUNCHER = "<DSH_HOME>/profiles/<name>/node_modules/@deepseek-ai/dsh-browser-slotpool/bin/browser-slotpool.mjs"
# Or edit the profile's cordis.patch.yml to pass an absolute path in args
```

Other optional env vars (forwarded to the launcher via `mcp-client`'s `env`):

| Variable | Default | Description |
|---|---|---|
| `DSH_BROWSER_PORTS` | `9222,9223` | Slot (CDP port) list, comma-separated |
| `DSH_BROWSER_BASE_DIR` | `mcp-shared-browsers` under LOCALAPPDATA / tmpdir | Shared browser data / lock root dir |
| `DSH_PLAYWRIGHT_MCP_ENTRY` | (empty → falls back to npx) | Absolute path to `@playwright/mcp`'s `cli.js`; if set, runs node directly, **no npx/network needed**; verify that CLI's version yourself |
| `DSH_PLAYWRIGHT_MCP_CMD` | `npx` | The command used to invoke `@playwright/mcp` (only when entry is unset) |
| `CHROME_PATH` | common install paths probed | Browser executable |

### Discover more plugins

This plugin is public under GitHub's [`dsh-plugin`](https://github.com/topics/dsh-plugin) tag; browse official and community plugin repos on that page. For a visual, app-store-like experience you can also visit the community-run [DSH-Plugin Hub](https://dsh-plugin.org) (third-party, not operated by DeepSeek).

> This plugin is a **patch-layer bundle + pure `.mjs` launcher**, with **no TypeScript source and no build step**. `exports` point directly at the committed `bin/browser-slotpool.mjs` and `cordis.patch.yml`, so users install a ready-to-use artifact. If you rename or move this repo to another namespace, update the `github:bluechips-zhao/dsh-browser-slotpool` segment above.

## Dependencies / Runtime requirements

- **DSH provides** `@deepseek-ai/dsh-mcp-client` (this bundle only adds one line, no extra package).
- **`@playwright/mcp`**: the launcher pins `npx @playwright/mcp@0.0.82` (npm version checked 2026-09-27; first run needs network). A custom `DSH_PLAYWRIGHT_MCP_ENTRY` overrides this pin.
- **Chrome/Chromium**: must be at `CHROME_PATH` or a common install path; otherwise the launcher reports "Chrome not found".

## Slot semantics cheat-sheet

- Each mcp-client instance (one bundle line / one profile) owns one slot; adding another mcp-client line (different `serverName`, e.g. `browser2`) uses another slot.
- Both slots busy → launcher `exit(2)` and prints each slot's holder; `mcp-client` reconnects/errors.
- Crashes/kills leave no stale lock (PID liveness reclaim).

## Verification

```sh
# Minimal MCP stdio smoke test (local-server version): definitively proves the
# "slot pool + Chrome + @playwright/mcp + render + screenshot" chain
node test/mcp-client-smoke.mjs
```

> ⚠️ **External access is environment-restricted**: Chrome on this machine gets
> `ERR_CONNECTION_RESET` for external sites (`example.com`, `registry.npmjs.org`
> time out, while PowerShell can reach some domains). That's a **deployment
> network policy**, not a bug in the wrapper — the wrapper stack is fully
> functional. On a machine with normal internet, `dsh --profile <name>
> "open https://example.com and screenshot"` shows a real external page.

> The smoke test `test/mcp-client-smoke.mjs` needs `DSH_PLAYWRIGHT_MCP_ENTRY` set to
> the local `@playwright/mcp` `cli.js` (e.g. `%APPDATA%\npm\node_modules\@playwright\mcp\cli.js`).
