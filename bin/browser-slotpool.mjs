#!/usr/bin/env node
/**
 * browser-slotpool.mjs — Playwright MCP 槽位池启动器（DSH 版）
 *
 * 为 DSH 的 mcp-client 提供一个"并发浏览器 MCP"包装：
 *  - 固定 N 个 CDP 槽位（端口），先到先得，满即拒绝（槽位池）
 *  - O_EXCL 独占创建锁（无竞态加锁）+ PID 活性 + 陈旧锁自愈
 *  - 幂等就绪探测：CDP 端口已起就不动，没起才 spawn Chrome；绝不杀别人的浏览器
 *  - 槽位所有权隔离：每个 mcp-client 会话独占一个端口，绝不 proxy/偷别的槽
 *  - stdio 全委托 @playwright/mcp；诊断只走 stderr（保 MCP 协议通道干净）
 *  - 分离 + unref 子进程；exit/SIGINT/SIGTERM/子进程退出都正确清理锁与退出码
 *
 * 实现原则：不只"能跑"，而是"并发、幂等、不互相破坏、崩了能自愈"。
 * 非 DSH 专属，任何"多会话共用浏览器 MCP"的场景都可用本启动器。
 *
 * 可配置环境变量：
 *   DSH_BROWSER_PORTS        CDP 端口列表，逗号分隔（默认 "9222,9223"）
 *   DSH_BROWSER_BASE_DIR     共享浏览器数据/锁根目录（默认 LOCALAPPDATA 或 tmpdir 下 mcp-shared-browsers）
 *   DSH_PLAYWRIGHT_MCP_CMD   调 @playwright/mcp 的命令（默认 "npx"）
 *   CHROME_PATH              浏览器可执行文件路径（优先）
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

// ---------------------------------- 配置 ----------------------------------

const PORTS = (process.env.DSH_BROWSER_PORTS || "9222,9223")
  .split(",")
  .map((s) => Number(s))
  .filter((n) => Number.isInteger(n) && n > 0);

const BASE_DIR =
  process.env.DSH_BROWSER_BASE_DIR ||
  path.join(process.env.LOCALAPPDATA || os.tmpdir(), "mcp-shared-browsers");

const LOCK_DIR = path.join(BASE_DIR, "locks");
const MCP_CMD = process.env.DSH_PLAYWRIGHT_MCP_CMD || "npx";
const EXTRA_MCP_ARGS = ["--browser=chrome", "--caps=vision,pdf"];

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
  // macOS / Linux（如果有）
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

/** 诊断只走 stderr —— stdio 是 MCP 协议的生命线，绝不能污染。 */
function log(...args) {
  console.error("[browser-slotpool]", ...args);
}

function ensureDirs() {
  fs.mkdirSync(LOCK_DIR, { recursive: true });
  for (const port of PORTS) {
    fs.mkdirSync(path.join(BASE_DIR, `slot-${port}`), { recursive: true });
  }
}

function lockPath(port) {
  return path.join(LOCK_DIR, `slot-${port}.lock`);
}

// ---------------------------------- 锁 ----------------------------------

function isPidAlive(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLock(port) {
  const file = lockPath(port);
  try {
    const raw = fs.readFileSync(file, "utf8").trim();
    const data = JSON.parse(raw);
    if (isPidAlive(data.pid)) return data;
    // 陈旧锁：持有者已死，回收（自愈，避免"槽全忙"卡死）
    fs.unlinkSync(file);
    return null;
  } catch {
    try {
      fs.unlinkSync(file);
    } catch {
      /* ignore */
    }
    return null;
  }
}

function tryAcquireLock(port) {
  const file = lockPath(port);
  if (readLock(port)) return false;

  const payload = JSON.stringify(
    { pid: process.pid, port, startedAt: new Date().toISOString() },
    null,
    0
  );

  try {
    // O_EXCL（"wx"）独占创建 = 无竞态加锁；再读回核对，防"慢写 + 并发读到半截"。
    const fd = fs.openSync(file, "wx");
    fs.writeFileSync(fd, payload);
    fs.closeSync(fd);
    const again = JSON.parse(fs.readFileSync(file, "utf8"));
    if (again.pid !== process.pid) return false;
    return true;
  } catch {
    return false;
  }
}

function releaseLock(port) {
  const file = lockPath(port);
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    // 只释放自己的锁，不碰别的会话
    if (data.pid === process.pid) fs.unlinkSync(file);
  } catch {
    /* ignore */
  }
}

// ---------------------------------- 浏览器就绪 ----------------------------------

function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function cdpVersion(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: "/json/version", timeout: 1500 },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

/** 幂等：本端口 CDP 已就绪就直接用；没起才 spawn；绝不杀别的槽的浏览器。 */
async function ensureChrome(port) {
  const version = await cdpVersion(port);
  if (version) {
    log(`Chrome already up on ${port}:`, version.Browser || "ok");
    return;
  }

  const chrome = findChrome();
  if (!chrome) {
    throw new Error("Chrome/Chromium not found. Set CHROME_PATH to the browser executable.");
  }

  const userDataDir = path.join(BASE_DIR, `slot-${port}`);
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "about:blank",
  ];

  log(`Starting Chrome for slot ${port}:`, chrome);
  const child = spawn(chrome, args, { detached: true, stdio: "ignore", windowsHide: false });
  child.unref(); // 浏览器独立存活，宿主退出不连带杀，也不阻塞宿主

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const v = await cdpVersion(port);
    if (v) {
      log(`Chrome ready on ${port}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Chrome CDP did not become ready on port ${port}`);
}

// ---------------------------------- 选槽 ----------------------------------

function pickSlot() {
  for (const port of PORTS) {
    if (tryAcquireLock(port)) return port;
  }
  return null;
}

// ---------------------------------- 启动 MCP ----------------------------------

/** 优先复用已缓存的 @playwright/mcp 原始 CLI，避免二次包裹。 */
function originalCliPath() {
  const cache = path.join(
    process.env.LOCALAPPDATA || os.tmpdir(),
    "npm-cache", "_npx",
    "9833c18b2d85bc59", "node_modules", "@playwright", "mcp", "cli.original.js"
  );
  return cache;
}

function runMcp(port) {
  const endpoint = `http://127.0.0.1:${port}`;
  log(`Launching Playwright MCP -> ${endpoint}`);
  log(`Slots: ${PORTS.join(", ")} | this session: ${port}`);

  const originalCli = originalCliPath();
  const baseArgs = [`--cdp-endpoint=${endpoint}`, ...EXTRA_MCP_ARGS];
  let child;

  // 首选：DSH_PLAYWRIGHT_MCP_ENTRY 指向 @playwright/mcp 的 cli.js（直连 node，不依赖 npx/网络）。
  const entry = process.env.DSH_PLAYWRIGHT_MCP_ENTRY;
  if (entry && fs.existsSync(entry)) {
    child = spawn(process.execPath, [entry, ...baseArgs], { stdio: "inherit", env: process.env });
    log(`Using DSH_PLAYWRIGHT_MCP_ENTRY -> ${entry}`);
  } else if (fs.existsSync(originalCli)) {
    child = spawn(process.execPath, [originalCli, ...baseArgs], { stdio: "inherit", env: process.env });
  } else if (process.platform === "win32") {
    // Windows 下 npx 是命令，需经 cmd；stdio 继承交给 @playwright/mcp
    child = spawn("cmd.exe", ["/d", "/s", "/c", MCP_CMD, "-y", "@playwright/mcp@latest", ...baseArgs], {
      stdio: "inherit",
      windowsHide: true,
      env: process.env,
    });
  } else {
    child = spawn(MCP_CMD, ["-y", "@playwright/mcp@latest", ...baseArgs], {
      stdio: "inherit",
      env: process.env,
    });
  }

  const cleanup = () => releaseLock(port);

  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    try { child.kill("SIGINT"); } catch { /* ignore */ }
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    cleanup();
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
    process.exit(143);
  });

  child.on("exit", (code, signal) => {
    cleanup();
    process.exit(signal ? 1 : (code ?? 0));
  });

  child.on("error", (err) => {
    cleanup();
    log("Failed to start @playwright/mcp:", err.message);
    process.exit(1);
  });
}

async function main() {
  if (PORTS.length === 0) {
    log("No valid DSH_BROWSER_PORTS configured.");
    process.exit(1);
  }
  ensureDirs();

  const port = pickSlot();
  if (port == null) {
    log(`All ${PORTS.length} slot(s) busy (${PORTS.join(", ")}). Close one browser session and retry.`);
    for (const p of PORTS) {
      const lock = readLock(p);
      if (lock) log(`  port ${p} held by pid ${lock.pid} since ${lock.startedAt}`);
    }
    process.exit(2);
  }

  log(`Claimed slot port ${port} (pid ${process.pid})`);
  log("Rule: each slot is an independent session — never proxy or steal another slot.");

  try {
    // 只确保本端口就绪，绝不干扰其它槽
    await ensureChrome(port);
  } catch (err) {
    releaseLock(port);
    log(err && err.message ? err.message : String(err));
    process.exit(1);
  }

  runMcp(port);
}

main().catch((err) => {
  log(err?.stack || err);
  process.exit(1);
});
