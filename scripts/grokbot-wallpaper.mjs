#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const PORT = 19222;
const PANEL = 19223;
const BASE = `http://127.0.0.1:${PORT}`;
const PANEL_BASE = `http://127.0.0.1:${PANEL}`;
const DIR = path.join(homedir(), 'Library/Application Support/grokbot-wallpaper');
const LAST = path.join(DIR, 'last-applied.json');
const REGISTRY = path.join(DIR, 'scripts.json');
const LIMIT = 4 * 1024 * 1024;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const help = `Grok Bot 本地壁纸（Node.js 22+ / macOS）
  node scripts/grokbot-wallpaper.mjs apply <image> [--opacity 0.9] [--dark|--light] [--relaunch]
  node scripts/grokbot-wallpaper.mjs restore
  node scripts/grokbot-wallpaper.mjs status
  node scripts/grokbot-wallpaper.mjs panel
  node scripts/grokbot-wallpaper.mjs watch
首次开启本机调试端口需要确认后传 --relaunch，会关闭当前窗口。
应用后窗口右下角有悬浮面板，可上传壁纸和调透明度；登录后会自动启动助手，并在应用带调试口启动时自动换上上次壁纸。
默认透明度 0.9，范围 0.15–1。仅使用 127.0.0.1:19222 与 127.0.0.1:19223；不要转发端口。`;
async function readJSON(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
async function writeJSON(file, value) {
  await fs.mkdir(DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(`${file}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(`${file}.tmp`, file);
}
function clampOpacity(value) {
  return Math.max(0.15, Math.min(1, Number(value)));
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
async function panelHealth() {
  try {
    const res = await fetch(`${PANEL_BASE}/health`, { signal: AbortSignal.timeout(800), redirect: 'error' });
    const json = await res.json();
    return res.ok && json.ok === true;
  } catch {
    return false;
  }
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
    call(method, params = {}, timeout = 30000) {
      return new Promise((resolve, reject) => {
        const id = ++seq;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} 超时。`)); }, timeout);
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
  const state = {
    data: config.data,
    opacity: Math.max(0.15, Math.min(1, Number(config.opacity) || 0.9)),
    appearance: config.appearance === 'light' ? 'light' : 'dark',
    panel: config.panel || 'http://127.0.0.1:19223',
  };
  const changes = new Map();
  const layer = document.createElement('div');
  layer.id = 'grokbot-wallpaper-layer';
  const panel = document.createElement('div');
  panel.id = 'grokbot-wallpaper-panel';
  const style = document.createElement('style');
  style.id = 'grokbot-wallpaper-style';
  style.textContent = '#grokbot-wallpaper-layer{position:fixed!important;inset:0!important;pointer-events:none!important;z-index:-1!important;background-size:cover!important;background-position:center!important}#grokbot-wallpaper-panel{position:fixed!important;right:16px!important;bottom:120px!important;left:auto!important;top:auto!important;z-index:2147483000!important;pointer-events:auto!important;width:240px!important;padding:10px 12px!important;border-radius:14px!important;background:rgba(20,22,28,.84)!important;color:#f3f4f6!important;font:12px/1.35 -apple-system,BlinkMacSystemFont,system-ui,sans-serif!important;box-shadow:0 10px 28px rgba(0,0,0,.32)!important;backdrop-filter:blur(16px)!important;-webkit-backdrop-filter:blur(16px)!important;user-select:none!important}#grokbot-wallpaper-panel.collapsed{width:auto!important;padding:0!important;background:transparent!important;box-shadow:none!important;backdrop-filter:none!important}#grokbot-wallpaper-panel button,#grokbot-wallpaper-panel label.pick{appearance:none!important;border:0!important;border-radius:8px!important;background:rgba(255,255,255,.12)!important;color:inherit!important;font:inherit!important;cursor:pointer!important;padding:8px 10px!important}#grokbot-wallpaper-panel label.pick{display:block!important;width:100%!important;text-align:center!important;box-sizing:border-box!important;margin:8px 0 0!important}#grokbot-wallpaper-panel .opacity{margin-top:20px!important}#grokbot-wallpaper-panel input[type=range]{width:100%!important;margin:8px 0 0!important;accent-color:#8ab4ff!important}#grokbot-wallpaper-panel .row{display:flex!important;align-items:center!important;justify-content:space-between!important;gap:8px!important}#grokbot-wallpaper-panel .row.drag{cursor:move!important;padding-bottom:6px!important}#grokbot-wallpaper-panel .status{min-height:16px!important;margin-top:6px!important;opacity:.8!important}#grokbot-wallpaper-panel .fab{cursor:move!important;width:40px!important;height:40px!important;border-radius:20px!important;display:none!important;align-items:center!important;justify-content:center!important;background:rgba(20,22,28,.84)!important;box-shadow:0 8px 20px rgba(0,0,0,.28)!important}#grokbot-wallpaper-panel.collapsed .fab{display:flex!important}#grokbot-wallpaper-panel.collapsed .body{display:none!important}';
  function ink() { return state.appearance === 'light' ? '255,255,255' : '16,19,25'; }
  function paint() {
    layer.style.backgroundImage = `linear-gradient(rgba(${ink()},${1 - state.opacity}),rgba(${ink()},${1 - state.opacity})),url("${state.data}")`;
  }
  paint();
  const body = document.createElement('div');
  body.className = 'body';
  const row = document.createElement('div');
  row.className = 'row';
  const title = document.createElement('strong');
  title.textContent = '壁纸';
  const hide = document.createElement('button');
  hide.type = 'button';
  hide.textContent = '收起';
  hide.addEventListener('click', () => panel.classList.add('collapsed'));
  row.classList.add('drag');
  row.append(title, hide);
  function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }
  function bindDrag(handle) {
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      if (event.target.closest('button,input,label,a')) return;
      const rect = panel.getBoundingClientRect();
      const ox = event.clientX - rect.left;
      const oy = event.clientY - rect.top;
      handle.setPointerCapture(event.pointerId);
      const move = ev => {
        const w = panel.offsetWidth, h = panel.offsetHeight;
        const x = clamp(ev.clientX - ox, 8, innerWidth - w - 8);
        const y = clamp(ev.clientY - oy, 8, innerHeight - h - 8);
        panel.style.setProperty('left', x + 'px', 'important');
        panel.style.setProperty('top', y + 'px', 'important');
        panel.style.setProperty('right', 'auto', 'important');
        panel.style.setProperty('bottom', 'auto', 'important');
      };
      const up = ev => {
        handle.releasePointerCapture(ev.pointerId);
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
  }
  bindDrag(row);
  const file = document.createElement('input');
  file.type = 'file';
  file.accept = 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp';
  file.hidden = true;
  const pick = document.createElement('label');
  pick.className = 'pick';
  pick.textContent = '上传壁纸';
  pick.append(file);
  const sliderLabel = document.createElement('div');
  sliderLabel.className = 'row';
  const sliderText = document.createElement('span');
  sliderText.textContent = '透明度';
  const sliderVal = document.createElement('span');
  function setSliderLabel() { sliderVal.textContent = state.opacity.toFixed(2); }
  setSliderLabel();
  sliderLabel.append(sliderText, sliderVal);
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0.15';
  slider.max = '1';
  slider.step = '0.01';
  slider.value = String(state.opacity);
  const status = document.createElement('div');
  status.className = 'status';
  const fab = document.createElement('button');
  fab.type = 'button';
  fab.className = 'fab';
  fab.textContent = '壁纸';
  fab.addEventListener('click', () => panel.classList.remove('collapsed'));
  bindDrag(fab);
  const opacityBox = document.createElement('div');
  opacityBox.className = 'opacity';
  opacityBox.append(sliderLabel, slider, status);
  body.append(row, pick, opacityBox);
  panel.append(fab, body);
  let pending = null;
  function note(text) { status.textContent = text || ''; }
  function queueSave() {
    pending = { data: state.data, opacity: state.opacity, appearance: state.appearance };
    note('已更新');
  }
  slider.addEventListener('input', () => {
    state.opacity = Math.max(0.15, Math.min(1, Number(slider.value)));
    setSliderLabel();
    paint();
    queueSave();
  });
  file.addEventListener('change', () => {
    const chosen = file.files && file.files[0];
    file.value = '';
    if (!chosen) return;
    if (chosen.size > 4 * 1024 * 1024) { note('图片超过 4MB，请先缩小'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const data = String(reader.result || '');
      if (!/^data:image\/(png|jpeg|webp);base64,/.test(data)) { note('仅支持 png/jpg/webp'); return; }
      state.data = data;
      paint();
      queueSave();
      note('已更新');
    };
    reader.onerror = () => note('读取图片失败');
    reader.readAsDataURL(chosen);
  });
  function set(el, prop, value) {
    if (!changes.has(el)) changes.set(el, new Map());
    const record = changes.get(el);
    if (!record.has(prop)) record.set(prop, { value: el.style.getPropertyValue(prop), priority: el.style.getPropertyPriority(prop) });
    el.style.setProperty(prop, value, 'important');
  }
  let observer, timer, stopped = false;
  function skip(el) {
    return el === layer || el === style || el === panel || panel.contains(el)
      || el.closest('button,input,textarea,select,dialog,[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[role="tooltip"],[role="button"],[contenteditable="true"]');
  }
  function scan() {
    if (stopped || !document.body) return;
    observer?.disconnect();
    set(document.documentElement, 'background-color', 'transparent');
    set(document.documentElement, 'background-image', 'none');
    set(document.documentElement, 'color-scheme', state.appearance);
    set(document.body, 'background-color', 'transparent');
    set(document.body, 'background-image', 'none');
    set(document.body, 'isolation', 'isolate');
    const area = innerWidth * innerHeight;
    for (const el of document.body.querySelectorAll('*')) {
      if (skip(el)) continue;
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
    document.body.append(panel);
    observer = new MutationObserver(schedule);
    scan(); window.addEventListener('resize', schedule);
  }
  window[key] = {
    restore() {
      stopped = true; observer?.disconnect(); clearTimeout(timer); clearTimeout(saveTimer);
      document.removeEventListener('DOMContentLoaded', start);
      window.removeEventListener('resize', schedule);
      layer.remove(); style.remove(); panel.remove();
      for (const [el, props] of changes) for (const [prop, old] of props) {
        if (old.value) el.style.setProperty(prop, old.value, old.priority); else el.style.removeProperty(prop);
      }
      changes.clear(); delete window[key];
    },
    update(next = {}) {
      if (next.data) state.data = next.data;
      if (Number.isFinite(Number(next.opacity))) {
        state.opacity = Math.max(0.15, Math.min(1, Number(next.opacity)));
        slider.value = String(state.opacity);
        setSliderLabel();
      }
      if (next.appearance === 'dark' || next.appearance === 'light') state.appearance = next.appearance;
      paint();
      return { ok: true };
    },
    takePending() {
      if (!pending) return null;
      const value = pending;
      pending = null;
      return value;
    }
  };
  if (document.body && document.head) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });
  return { ok: true };
}

function mimeOf(suffix) {
  return suffix === '.png' ? 'image/png' : suffix === '.webp' ? 'image/webp' : 'image/jpeg';
}
function validImage(data, suffix) {
  return suffix === '.png' ? data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : suffix === '.webp' ? data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP'
    : data[0] === 255 && data[1] === 216 && data[2] === 255;
}
async function writeCurrent(data, suffix, source) {
  if (data.length > LIMIT) throw new Error('处理后图片仍超过 4MB，请提供更小的图片。');
  if (!validImage(data, suffix)) throw new Error('图片内容与文件扩展名不符。');
  await fs.mkdir(DIR, { recursive: true, mode: 0o700 });
  const dest = path.join(DIR, `current${suffix}`);
  await fs.writeFile(`${dest}.tmp`, data, { mode: 0o600 });
  await fs.rename(`${dest}.tmp`, dest);
  return { image: dest, source, data: `data:${mimeOf(suffix)};base64,${data.toString('base64')}` };
}
async function prepare(file) {
  const source = path.resolve(file);
  const ext = path.extname(source).toLowerCase();
  if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) throw new Error('仅支持 png/jpg/jpeg/webp 图片。');
  const stat = await fs.stat(source);
  if (!stat.isFile()) throw new Error('图片路径必须是文件。');
  let data, suffix = ext === '.jpeg' ? '.jpg' : ext;
  if (stat.size > LIMIT) {
    try { await fs.access('/usr/bin/sips'); } catch { throw new Error('图片超过 4MB，且 sips 不可用；请先缩小图片。'); }
    const temp = await fs.mkdtemp(path.join(DIR, 'convert-'));
    try {
      const out = path.join(temp, 'photo.jpg');
      await exec('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '75', '-Z', '2560', source, '--out', out]);
      data = await fs.readFile(out); suffix = '.jpg';
    } finally { await fs.rm(temp, { recursive: true, force: true }); }
  } else data = await fs.readFile(source);
  return writeCurrent(data, suffix, source);
}
async function prepareDataUrl(dataUrl) {
  const match = String(dataUrl).match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match) throw new Error('仅支持 png/jpg/webp 图片。');
  const data = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  const suffix = match[1] === 'png' ? '.png' : match[1] === 'webp' ? '.webp' : '.jpg';
  if (data.length > LIMIT) throw new Error('图片超过 4MB，请先缩小。');
  return writeCurrent(data, suffix, path.join(DIR, `current${suffix}`));
}
async function listTargets() {
  let targets = [];
  const end = Date.now() + 10000;
  do {
    targets = (await get('/json/list')).filter(t => ['page', 'webview'].includes(t.type) && t.webSocketDebuggerUrl && !/^(devtools|chrome|chrome-extension):/.test(t.url));
    if (targets.length) break;
    await pause(300);
  } while (Date.now() < end);
  if (!targets.length) throw new Error('没有可用的 Grok Bot 页面，请打开主窗口后重试。');
  return targets;
}
let injectLock = Promise.resolve();
function withInjectLock(fn) {
  const run = injectLock.then(fn, fn);
  injectLock = run.then(() => {}, () => {});
  return run;
}
async function inject(version, config, live = false) {
  return withInjectLock(async () => {
    const browser = version.webSocketDebuggerUrl;
    const old = await readJSON(REGISTRY, { browser: null, entries: [] });
    const registry = old.browser === browser ? old : { browser, entries: [] };
    const targets = await listTargets();
    const source = `(${overlay.toString()})(${JSON.stringify(config)})`;
    const liveExpr = live && config
      ? `window.__grokbotWallpaperOverlay ? window.__grokbotWallpaperOverlay.update(${JSON.stringify({ data: config.data, opacity: config.opacity, appearance: config.appearance })}) : (${overlay.toString()})(${JSON.stringify(config)})`
      : source;
    for (const target of targets) {
      const cdp = await connect(target.webSocketDebuggerUrl);
      try {
        await cdp.call('Page.enable');
        for (const entry of registry.entries.filter(e => e.target === target.id)) {
          try { await cdp.call('Page.removeScriptToEvaluateOnNewDocument', { identifier: entry.identifier }); }
          catch (error) {
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
        const result = await cdp.call('Runtime.evaluate', { expression: liveExpr, returnByValue: true, awaitPromise: true });
        if (result.exceptionDetails || result.result?.value?.ok !== true) throw new Error('壁纸脚本执行失败，可能仅部分窗口已更新；可运行 restore。');
      } finally { cdp.close(); }
    }
  });
}
async function ensurePanelDaemon() {
  if (await panelHealth()) return true;
  await fs.mkdir(DIR, { recursive: true, mode: 0o700 });
  const log = await fs.open(path.join(DIR, 'panel.log'), 'a');
  const child = spawn(process.execPath, [process.argv[1], 'watch'], {
    detached: true,
    stdio: ['ignore', log.fd, log.fd],
    env: process.env,
  });
  child.unref();
  await log.close();
  const end = Date.now() + 4000;
  while (Date.now() < end) {
    if (await panelHealth()) return true;
    await pause(150);
  }
  return false;
}
function isLoopback(req) {
  const addr = req.socket.remoteAddress;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}
async function readBody(req, limit = 8 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('请求过大。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function handlePanel(req, res) {
  const headers = {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'Content-Type',
  };
  const send = (code, obj) => { res.writeHead(code, headers); res.end(obj ? JSON.stringify(obj) : ''); };
  if (!isLoopback(req)) { send(403, { ok: false, error: '仅本机可用。' }); return; }
  if (req.method === 'OPTIONS') { send(204); return; }
  const url = new URL(req.url, PANEL_BASE);
  if (req.method === 'GET' && url.pathname === '/health') { send(200, { ok: true, pid: process.pid }); return; }
  if (req.method === 'POST' && url.pathname === '/apply') {
    try {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const last = await readJSON(LAST, {}) ?? {};
      let opacity = last.opacity ?? 0.9;
      let appearance = last.appearance === 'light' ? 'light' : 'dark';
      if (body.opacity != null) {
        if (!Number.isFinite(Number(body.opacity))) throw new Error('--opacity 需要有限数字。');
        opacity = clampOpacity(body.opacity);
      }
      if (body.appearance === 'dark' || body.appearance === 'light') appearance = body.appearance;
      const prepared = body.data ? await prepareDataUrl(body.data) : (last.image ? await prepare(last.image) : null);
      if (!prepared) throw new Error('还没有壁纸。');
      const version = await probe();
      if (!version) throw new Error('本机调试端口未开启。');
      const config = { data: prepared.data, opacity, appearance, panel: PANEL_BASE };
      await inject(version, config, true);
      await writeJSON(LAST, { image: prepared.image, source: body.data ? prepared.image : (last.source ?? prepared.source), opacity, appearance, time: new Date().toISOString(), restored: false });
      send(200, { ok: true, opacity, image: prepared.image });
    } catch (error) {
      send(400, { ok: false, error: error.message });
    }
    return;
  }
  send(404, { ok: false, error: '未知接口。' });
}
function escapeXml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
const AGENT_LABEL = 'com.kingao.grokbot-wallpaper';
function agentPlistPath() {
  return path.join(homedir(), 'Library/LaunchAgents', `${AGENT_LABEL}.plist`);
}
async function autostartRunning() {
  try {
    const { stdout } = await exec('launchctl', ['print', `gui/${process.getuid()}/${AGENT_LABEL}`]);
    return /pid\s*=\s*\d/.test(stdout) || /state\s*=\s*running/i.test(stdout);
  } catch {
    return false;
  }
}
async function installAutostart() {
  const agents = path.join(homedir(), 'Library/LaunchAgents');
  await fs.mkdir(agents, { recursive: true, mode: 0o755 });
  await fs.mkdir(DIR, { recursive: true, mode: 0o700 });
  const node = process.execPath;
  const script = path.resolve(process.argv[1]);
  const log = path.join(DIR, 'watch.log');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${AGENT_LABEL}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(node)}</string>
    <string>${escapeXml(script)}</string>
    <string>watch</string>
  </array>
  <key>WorkingDirectory</key><string>${escapeXml(DIR)}</string>
  <key>StandardOutPath</key><string>${escapeXml(log)}</string>
  <key>StandardErrorPath</key><string>${escapeXml(log)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin:${escapeXml(path.dirname(node))}</string>
  </dict>
</dict>
</plist>
`;
  const dest = agentPlistPath();
  await fs.writeFile(`${dest}.tmp`, plist, { mode: 0o644 });
  await fs.rename(`${dest}.tmp`, dest);
  const uid = String(process.getuid());
  const target = `gui/${uid}/${AGENT_LABEL}`;
  try { await exec('launchctl', ['bootout', target]); } catch {}
  await exec('launchctl', ['bootstrap', `gui/${uid}`, dest]);
  try { await exec('launchctl', ['enable', target]); } catch {}
  try { await exec('launchctl', ['kickstart', '-k', target]); } catch {}
}
async function startPanelServer({ block = true } = {}) {
  if (await panelHealth()) {
    console.log(`壁纸面板助手已在 ${PANEL_BASE} 运行。`);
    if (block) await new Promise(() => {});
    return false;
  }
  const server = http.createServer((req, res) => { void handlePanel(req, res); });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PANEL, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  await writeJSON(path.join(DIR, 'panel.json'), { pid: process.pid, port: PANEL, time: new Date().toISOString() });
  console.log(`壁纸面板助手已在 ${PANEL_BASE} 启动。`);
  if (block) await new Promise(() => {});
  return true;
}
async function applyLast(version) {
  const last = await readJSON(LAST, {}) ?? {};
  if (!last.image || last.restored) return false;
  const prepared = await prepare(last.image);
  const opacity = clampOpacity(last.opacity ?? 0.9);
  const appearance = last.appearance === 'light' ? 'light' : 'dark';
  await inject(version, { data: prepared.data, opacity, appearance, panel: PANEL_BASE }, true);
  return true;
}
async function collectPending() {
  const version = await probe();
  if (!version) return null;
  const targets = await listTargets();
  for (const target of targets) {
    const cdp = await connect(target.webSocketDebuggerUrl);
    try {
      const result = await cdp.call('Runtime.evaluate', {
        expression: 'window.__grokbotWallpaperOverlay ? window.__grokbotWallpaperOverlay.takePending() : null',
        returnByValue: true,
      });
      const value = result.result?.value;
      if (value && (value.data || Number.isFinite(Number(value.opacity)))) return { version, value };
    } finally { cdp.close(); }
  }
  return null;
}
async function persistPending(entry) {
  const last = await readJSON(LAST, {}) ?? {};
  const opacity = entry.value.opacity != null ? clampOpacity(entry.value.opacity) : clampOpacity(last.opacity ?? 0.9);
  const appearance = entry.value.appearance === 'light' || entry.value.appearance === 'dark' ? entry.value.appearance : (last.appearance === 'light' ? 'light' : 'dark');
  const prepared = entry.value.data ? await prepareDataUrl(entry.value.data) : (last.image ? await prepare(last.image) : null);
  if (!prepared) return;
  await inject(entry.version, { data: prepared.data, opacity, appearance, panel: PANEL_BASE }, true);
  await writeJSON(LAST, { image: prepared.image, source: entry.value.data ? prepared.image : (last.source ?? prepared.source), opacity, appearance, time: new Date().toISOString(), restored: false });
}
async function watch() {
  await startPanelServer({ block: false });
  const app = await appPath();
  if (app && !await running(app) && await readJSON(LAST)) {
    try {
      await exec('open', ['-a', app, '--args', `--remote-debugging-port=${PORT}`, '--remote-debugging-address=127.0.0.1']);
      const end = Date.now() + 40000;
      while (Date.now() < end && !await probe()) await pause(400);
    } catch (error) {
      console.error(`自动打开 Grok Bot 失败：${error.message}`);
    }
  }
  let lastBrowser = null;
  for (;;) {
    try {
      const pending = await collectPending();
      if (pending) await persistPending(pending);
      const version = await probe();
      const browser = version?.webSocketDebuggerUrl ?? null;
      if (browser && browser !== lastBrowser) {
        await applyLast(version);
        lastBrowser = browser;
      }
      if (!browser) lastBrowser = null;
    } catch (error) {
      console.error(`watch：${error.message}`);
    }
    await pause(800);
  }
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || ['help', '--help', '-h'].includes(command)) { console.log(help); return; }
  if (!['apply', 'restore', 'status', 'panel', 'watch'].includes(command)) throw new Error('未知命令。运行 help 查看用法。');
  let file, opacity = 0.9, appearance = 'dark', confirmed = false, mode;
  if (command === 'apply') {
    file = args.shift();
    if (!file || file.startsWith('--')) throw new Error('apply 需要图片路径。');
    while (args.length) {
      const arg = args.shift();
      if (arg === '--relaunch') confirmed = true;
      else if (arg === '--opacity') {
        const value = args.shift();
        if (!value || !Number.isFinite(Number(value))) throw new Error('--opacity 需要有限数字。');
        opacity = clampOpacity(value);
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
    console.log(JSON.stringify({ running: await running(installed), debug: Boolean(version), panel: await panelHealth(), autostart: await autostartRunning(), appPath: installed, port: PORT, panelPort: PANEL, lastApplied: await readJSON(LAST) }, null, 2)); return;
  }
  if (command === 'panel') { await startPanelServer(); return; }
  if (command === 'watch') { await watch(); return; }
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
  try { await installAutostart(); } catch (error) { console.error(`登录自启未装上：${error.message}`); }
  const panelReady = await ensurePanelDaemon();
  await inject(version, { data: prepared.data, opacity, appearance, panel: PANEL_BASE });
  await writeJSON(LAST, { image: prepared.image, source: prepared.source, opacity, appearance, time: new Date().toISOString(), restored: false });
  console.log(`已应用：${prepared.image}\n这是本机覆盖层，不是官方主题；完全退出应用后失效。${panelReady ? '\n窗口右下角可上传壁纸和调整透明度。已设置为登录自启。' : '\n悬浮面板助手未启动，可运行 watch 后再试。'}`);
}
main().catch(error => { console.error(`错误：${error.message}`); process.exitCode = 1; });
