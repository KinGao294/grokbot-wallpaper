#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const PORT = 19222;
const BASE = `http://127.0.0.1:${PORT}`;
const DIR = path.join(homedir(), 'Library/Application Support/grokbot-wallpaper');
const LAST = path.join(DIR, 'last-applied.json');
const REGISTRY = path.join(DIR, 'scripts.json');
const LIMIT = 4 * 1024 * 1024;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const help = `Grok Bot 本地壁纸（Node.js 22+ / macOS）
  node scripts/grokbot-wallpaper.mjs apply <image> [--opacity 0.45] [--dark|--light] [--relaunch]
  node scripts/grokbot-wallpaper.mjs restore
  node scripts/grokbot-wallpaper.mjs status
首次开启本机调试端口需要确认后传 --relaunch，会关闭当前窗口。
仅使用 127.0.0.1:19222；不要转发端口。`;
async function readJSON(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
async function writeJSON(file, value) {
  await fs.mkdir(DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(`${file}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(`${file}.tmp`, file);
}
async function osascriptRunning() {
  try {
    const { stdout } = await exec('osascript', ['-e', 'application "Grok Bot" is running']);
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}
function isMainBinary(command, app) {
  const bin = path.join(app, 'Contents/MacOS/Grok Bot');
  return command === bin || command.startsWith(`${bin} `);
}
async function mainProcesses(app) {
  if (!app) return [];
  const { stdout } = await exec('ps', ['-axww', '-o', 'pid=,command=']);
  const found = [];
  for (const line of stdout.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!match) continue;
    const command = match[2];
    if (isMainBinary(command, app)) found.push({ pid: Number(match[1]), command });
  }
  return found;
}
async function running(app) {
  if (await osascriptRunning()) return true;
  return (await mainProcesses(app ?? await appPath())).length > 0;
}
async function appPath() {
  for (const p of ['/Applications/Grok Bot.app', path.join(homedir(), 'Applications/Grok Bot.app')]) {
    try { await fs.access(p); return p; } catch {}
  }
  return null;
}
async function get(endpoint) {
  const res = await fetch(`${BASE}${endpoint}`, { signal: AbortSignal.timeout(1800), redirect: 'error' });
  if (!res.ok) throw new Error('本机调试接口未就绪。');
  return res.json();
}
async function probe() {
  try { const v = await get('/json/version'); return v.webSocketDebuggerUrl ? v : null; }
  catch { return null; }
}
async function waitWhileRunning(app, ms) {
  const end = Date.now() + ms;
  while (await running(app)) {
    if (Date.now() > end) return false;
    await pause(250);
  }
  return true;
}
async function quitApp(app) {
  try { await exec('osascript', ['-e', 'tell application "Grok Bot" to quit'], { timeout: 8000 }); }
  catch {}
  if (await waitWhileRunning(app, 10000)) return;
  const procs = await mainProcesses(app);
  for (const proc of procs) {
    try { process.kill(proc.pid, 'SIGTERM'); } catch {}
  }
  if (await waitWhileRunning(app, 5000)) return;
  for (const proc of await mainProcesses(app)) {
    try { process.kill(proc.pid, 'SIGKILL'); } catch {}
  }
  if (!await waitWhileRunning(app, 3000)) throw new Error('Grok Bot 尚未退出，已停止重启。');
}
async function relaunch(app) {
  if (!app) throw new Error('未找到 Grok Bot.app，请安装在 /Applications 或 ~/Applications。');
  // pgrep -x misses the main process on this app; never use it to decide whether to open a second instance.
  // Launching Contents/MacOS/Grok Bot directly lets Launch Services respawn the app without argv, dropping the debug port.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await running(app)) await quitApp(app);
    await pause(1500);
    if (!await running(app)) break;
  }
  if (await running(app)) throw new Error('Grok Bot 退出后又被拉起，已停止重启，以免开出没有调试端口的实例。');
  await exec('open', ['-a', app, '--args', `--remote-debugging-port=${PORT}`, '--remote-debugging-address=127.0.0.1']);
  const end = Date.now() + 40000;
  while (Date.now() < end) {
    const version = await probe();
    if (version) {
      // Direct binary launches have shown the port for ~2s, then Launch Services respawns without argv.
      await pause(3000);
      const still = await probe();
      if (still) return still;
      continue;
    }
    await pause(400);
  }
  throw new Error('等待本机调试端口超时（40 秒）。');
}
async function connect(address) {
  const u = new URL(address);
  if (u.protocol !== 'ws:' || u.hostname !== '127.0.0.1' || u.port !== String(PORT)) {
    throw new Error('拒绝非 127.0.0.1:19222 的调试连接。');
  }
  const ws = new WebSocket(u);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error('调试连接超时。')); }, 5000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('调试连接失败。')); }, { once: true });
  });
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', event => {
    let msg; try { msg = JSON.parse(event.data); } catch { return; }
    const p = pending.get(msg.id); if (!p) return;
    pending.delete(msg.id); clearTimeout(p.timer);
    if (msg.error) {
      const error = new Error(`CDP ${p.method} 失败。`);
      error.protocolMessage = String(msg.error.message ?? '');
      p.reject(error);
    } else p.resolve(msg.result);
  });
  ws.addEventListener('close', () => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('调试连接已关闭。')); }
    pending.clear();
  });
  return {
    call(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++seq;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} 超时。`)); }, 10000);
        pending.set(id, { resolve, reject, timer, method });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { ws.close(); }
  };
}

// This function is serialized and executed only in the selected renderer.
function overlay(config) {
  const key = '__grokbotWallpaperOverlay';
  window[key]?.restore();
  if (!config) return { ok: true };
  const changes = new Map();
  const layer = document.createElement('div');
  layer.id = 'grokbot-wallpaper-layer';
  const style = document.createElement('style');
  style.id = 'grokbot-wallpaper-style';
  const ink = config.appearance === 'light' ? '255,255,255' : '16,19,25';
  style.textContent = `#grokbot-wallpaper-layer { position:fixed!important; inset:0!important; pointer-events:none!important; z-index:-1!important; background-size:cover!important; background-position:center!important; }`;
  layer.style.backgroundImage = `linear-gradient(rgba(${ink},${1 - config.opacity}),rgba(${ink},${1 - config.opacity})),url("${config.data}")`;
  function set(el, prop, value) {
    if (!changes.has(el)) changes.set(el, new Map());
    const record = changes.get(el);
    if (!record.has(prop)) record.set(prop, { value: el.style.getPropertyValue(prop), priority: el.style.getPropertyPriority(prop) });
    el.style.setProperty(prop, value, 'important');
  }
  let observer, timer, stopped = false;
  function scan() {
    if (stopped || !document.body) return;
    observer?.disconnect();
    set(document.documentElement, 'background-color', 'transparent');
    set(document.documentElement, 'background-image', 'none');
    set(document.documentElement, 'color-scheme', config.appearance);
    set(document.body, 'background-color', 'transparent');
    set(document.body, 'background-image', 'none');
    set(document.body, 'isolation', 'isolate');
    const area = innerWidth * innerHeight;
    for (const el of document.body.querySelectorAll('*')) {
      if (el === layer || el === style || el.closest('button,input,textarea,select,dialog,[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[role="tooltip"],[role="button"],[contenteditable="true"]')) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < innerWidth * 0.22 || rect.height < innerHeight * 0.45 || rect.width * rect.height < area * 0.16 || rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) continue;
      const css = getComputedStyle(el);
      if (css.visibility !== 'visible' || Number(css.opacity) < 0.85 || css.backgroundImage !== 'none') continue;
      if (changes.get(el)?.has('background-color')) continue;
      const rgb = css.backgroundColor.match(/^rgba?\(([^)]+)\)$/);
      if (!rgb) continue;
      const parts = rgb[1].split(/[,\s/]+/).filter(Boolean).map(Number);
      if ((parts[3] ?? 1) < 0.85) continue;
      set(el, 'background-color', `color-mix(in srgb, ${css.backgroundColor} 28%, transparent)`);
    }
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style'] });
  }
  function schedule() { if (!timer) timer = setTimeout(() => { timer = null; scan(); }, 180); }
  function start() {
    if (stopped) return;
    document.head.append(style);
    document.body.prepend(layer);
    observer = new MutationObserver(schedule);
    scan(); window.addEventListener('resize', schedule);
  }
  window[key] = { restore() {
    stopped = true; observer?.disconnect(); clearTimeout(timer);
    document.removeEventListener('DOMContentLoaded', start);
    window.removeEventListener('resize', schedule);
    layer.remove(); style.remove();
    for (const [el, props] of changes) for (const [prop, old] of props) {
      if (old.value) el.style.setProperty(prop, old.value, old.priority); else el.style.removeProperty(prop);
    }
    changes.clear(); delete window[key];
  } };
  if (document.body && document.head) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });
  return { ok: true };
}

async function prepare(file) {
  const source = path.resolve(file);
  const ext = path.extname(source).toLowerCase();
  if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) throw new Error('仅支持 png/jpg/jpeg/webp 图片。');
  const stat = await fs.stat(source);
  if (!stat.isFile()) throw new Error('图片路径必须是文件。');
  await fs.mkdir(DIR, { recursive: true, mode: 0o700 });
  let data, suffix = ext;
  if (stat.size > LIMIT) {
    try { await fs.access('/usr/bin/sips'); } catch { throw new Error('图片超过 4MB，且 sips 不可用；请先缩小图片。'); }
    const temp = await fs.mkdtemp(path.join(DIR, 'convert-'));
    try {
      const out = path.join(temp, 'photo.jpg');
      await exec('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '75', '-Z', '2560', source, '--out', out]);
      data = await fs.readFile(out); suffix = '.jpg';
    } finally { await fs.rm(temp, { recursive: true, force: true }); }
  } else data = await fs.readFile(source);
  if (data.length > LIMIT) throw new Error('处理后图片仍超过 4MB，请提供更小的图片。');
  const valid = suffix === '.png' ? data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : suffix === '.webp' ? data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP'
    : data[0] === 255 && data[1] === 216 && data[2] === 255;
  if (!valid) throw new Error('图片内容与文件扩展名不符。');
  const dest = path.join(DIR, `current${suffix}`);
  // Atomic replacement also avoids truncating a source that is already current.*.
  await fs.writeFile(`${dest}.tmp`, data, { mode: 0o600 });
  await fs.rename(`${dest}.tmp`, dest);
  const mime = suffix === '.png' ? 'image/png' : suffix === '.webp' ? 'image/webp' : 'image/jpeg';
  return { image: dest, source, data: `data:${mime};base64,${data.toString('base64')}` };
}
async function inject(version, config) {
  const browser = version.webSocketDebuggerUrl;
  const old = await readJSON(REGISTRY, { browser: null, entries: [] });
  const registry = old.browser === browser ? old : { browser, entries: [] };
  let targets = [];
  const end = Date.now() + 10000;
  do {
    targets = (await get('/json/list')).filter(t => ['page', 'webview'].includes(t.type) && t.webSocketDebuggerUrl && !/^(devtools|chrome|chrome-extension):/.test(t.url));
    if (targets.length) break;
    await pause(300);
  } while (Date.now() < end);
  if (!targets.length) throw new Error('没有可用的 Grok Bot 页面，请打开主窗口后重试。');
  const source = `(${overlay.toString()})(${JSON.stringify(config)})`;
  for (const target of targets) {
    const cdp = await connect(target.webSocketDebuggerUrl);
    try {
      await cdp.call('Page.enable');
      for (const entry of registry.entries.filter(e => e.target === target.id)) {
        try { await cdp.call('Page.removeScriptToEvaluateOnNewDocument', { identifier: entry.identifier }); }
        catch (error) {
          // Some Electron versions discard registrations when their CDP session ends.
          if (!/script.*(not found|does not exist)|no script.*(id|identifier)/i.test(error.protocolMessage ?? '')) {
            throw new Error('无法移除旧的重载脚本；请重试 restore，或手动退出应用结束该进程。');
          }
        }
      }
      registry.entries = registry.entries.filter(e => e.target !== target.id);
      await writeJSON(REGISTRY, registry);
      if (config) {
        const { identifier } = await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source });
        registry.entries.push({ target: target.id, identifier });
        await writeJSON(REGISTRY, registry);
      }
      const result = await cdp.call('Runtime.evaluate', { expression: source, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails || result.result?.value?.ok !== true) throw new Error('壁纸脚本执行失败，可能仅部分窗口已更新；可运行 restore。');
    } finally { cdp.close(); }
  }
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || ['help', '--help', '-h'].includes(command)) { console.log(help); return; }
  if (!['apply', 'restore', 'status'].includes(command)) throw new Error('未知命令。运行 help 查看用法。');
  let file, opacity = 0.45, appearance = 'dark', confirmed = false, mode;
  if (command === 'apply') {
    file = args.shift();
    if (!file || file.startsWith('--')) throw new Error('apply 需要图片路径。');
    while (args.length) {
      const arg = args.shift();
      if (arg === '--relaunch') confirmed = true;
      else if (arg === '--opacity') {
        const value = args.shift();
        if (!value || !Number.isFinite(Number(value))) throw new Error('--opacity 需要有限数字。');
        opacity = Math.max(0.15, Math.min(0.85, Number(value)));
      } else if (arg === '--dark' || arg === '--light') {
        if (mode && mode !== arg) throw new Error('--dark 和 --light 不能同时使用。');
        mode = arg; appearance = arg.slice(2);
      } else throw new Error('未知选项。运行 help 查看用法。');
    }
  } else if (args.length) throw new Error('此命令不接受参数。');
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('需要 Node.js 22 或更新版本。');
  if (process.platform !== 'darwin') throw new Error('请在用户的 Mac 上运行此命令。');
  let version = await probe();
  if (command === 'status') {
    const installed = await appPath();
    console.log(JSON.stringify({ running: await running(installed), debug: Boolean(version), appPath: installed, port: PORT, lastApplied: await readJSON(LAST) }, null, 2)); return;
  }
  if (command === 'restore') {
    if (!version) { console.log('本机调试端口未开启，无法确认或恢复窗口；本命令不会重启应用。手动退出应用可清除本进程的覆盖层。'); return; }
    await inject(version, null);
    await writeJSON(LAST, { ...(await readJSON(LAST) ?? {}), restored: true, restoredAt: new Date().toISOString() });
    console.log('已恢复当前窗口并移除已记录的重载脚本。'); return;
  }
  if (!version && !confirmed) {
    console.error('首次换背景需要确认后重启 Grok Bot，并开启仅本机可用的调试端口；当前窗口会关闭。确认后请加 --relaunch 重试。未退出应用。');
    process.exitCode = 2; return;
  }
  const prepared = await prepare(file);
  if (!version) version = await relaunch(await appPath());
  await inject(version, { data: prepared.data, opacity, appearance });
  await writeJSON(LAST, { image: prepared.image, source: prepared.source, opacity, appearance, time: new Date().toISOString(), restored: false });
  console.log(`已应用：${prepared.image}\n这是本机覆盖层，不是官方主题；完全退出应用后失效。`);
}
main().catch(error => { console.error(`错误：${error.message}`); process.exitCode = 1; });
