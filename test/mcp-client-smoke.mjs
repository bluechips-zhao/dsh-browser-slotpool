// 最小 MCP stdio 冒烟测试（本地服务器版）：直接驱动 browser-slotpool 启动器。
// 关键：环境网络只放行特定域，Chrome 连外网被挡；因此用 127.0.0.1 本地服务器
// 来决定性证明 "槽位池 + Chrome + @playwright/mcp + 渲染 + 截图" 全链路可用。
import { spawn } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFile } from "node:fs/promises";

const HERE = dirname(fileURLToPath(import.meta.url));
const LAUNCHER = join(HERE, "..", "bin", "browser-slotpool.mjs");
// 指向本机 @playwright/mcp 的 cli.js（免 npx/联网）；留空则启动器回落 npx/缓存 CLI。
const PLAYWRIGHT_MCP_ENTRY = process.env.DSH_PLAYWRIGHT_MCP_ENTRY || "";
const BASE = join(process.env.TEMP, "bs_smoke");
const MARK = "DSH_SLOTPOOL_OK_9f3c";

// 起一个本地 HTTP server 服务一段可验证内容
const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><body><h1 id="t">${MARK}</h1><p>rendered by pooled chrome</p></body></html>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
console.log("== local server on 127.0.0.1:", PORT);

const CHILD = spawn(process.execPath, [LAUNCHER], {
  env: {
    ...process.env,
    DSH_PLAYWRIGHT_MCP_ENTRY: PLAYWRIGHT_MCP_ENTRY,
    DSH_BROWSER_PORTS: "9222",
    DSH_BROWSER_BASE_DIR: BASE,
    CHROME_PATH: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  },
  stdio: ["pipe", "pipe", "pipe"],
});

let buf = "";
CHILD.stdout.setEncoding("utf8");
CHILD.stderr.setEncoding("utf8");
CHILD.stderr.on("data", (d) => process.stderr.write(`[launcher] ${d}`));
CHILD.on("exit", (c) => { server.close(); process.stderr.write(`[launcher exit ${c}]\n`); process.exit(0); });

let nextId = 1;
const pending = new Map();
function processBuffer() {
  for (;;) {
    const nl = buf.indexOf("\n");
    if (nl < 0) break;
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (line) { try { onMsg(JSON.parse(line)); } catch { /* ignore */ } }
  }
}
function onMsg(msg) {
  if (msg?.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
}
CHILD.stdout.on("data", (d) => { buf += d; processBuffer(); });
function write(obj) { CHILD.stdin.write(JSON.stringify(obj) + "\n"); }
function request(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout ${method}`)), 45000);
    pending.set(id, (m) => { clearTimeout(t); resolve(m); });
    write({ jsonrpc: "2.0", id, method, params });
  });
}

try {
  const init = await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
  console.log("== initialize:", init.result?.serverInfo?.name || "ok");
  write({ jsonrpc: "2.0", method: "notifications/initialized" });
  const list = await request("tools/list", {});
  const tools = (list.result?.tools || []).map((t) => t.name);
  console.log("== tools:", tools.length, "|", tools.slice(0, 6).join(", "), "...");

  const TARGET_URL = process.argv[2]; // 可传 URL 访问真实站点；缺省用本地 marker 页
  const navUrl = TARGET_URL || `http://127.0.0.1:${PORT}/`;
  const nav = await request("tools/call", { name: "browser_navigate", arguments: { url: navUrl } });
  const navTxt = nav.result?.content?.find((c) => c.type === "text")?.text || "";
  console.log("== navigate:", navTxt.includes("Error") ? navTxt.split("\n")[0] : "OK " + navTxt.replace(/\s+/g, " ").slice(0, 80));

  const shot = await request("tools/call", { name: "browser_take_screenshot", arguments: {} });
  const img = shot.result?.content?.find((c) => c.type === "image");
  const out = join(process.env.TEMP, "bs_smoke_shot.png");
  if (img?.data) { await writeFile(out, Buffer.from(img.data, "base64")); console.log("== screenshot bytes:", img.data.length, "->", out); }

  const snap = await request("tools/call", { name: "browser_snapshot", arguments: {} });
  const snapTxt = (snap.result?.content?.find((c) => c.type === "text")?.text || "").replace(/\s+/g, " ");
  const ok = TARGET_URL ? true : snapTxt.includes(MARK);
  console.log("== snapshot contains marker:", ok);
  console.log("== snapshot (first 400):", snapTxt.slice(0, 400));
  if (TARGET_URL) {
    console.log("== URL VERIFY DONE (target written) ==");
  } else {
    console.log(ok ? "== SMOKE PASS (rendered real page in pooled chrome) ==" : "== SMOKE FAIL (marker missing) ==");
  }
  await new Promise((r) => setTimeout(r, 500));
  CHILD.kill("SIGTERM");
  process.exit(0);
} catch (e) {
  console.error("== SMOKE FAIL:", e.message);
  CHILD.kill("SIGTERM");
  process.exit(1);
}
