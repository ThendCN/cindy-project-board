'use strict';
// 项目看板「公开访问」工作进程：用本机已装的 cloudflared / tailscale，把项目的本地端口映射到公网（只走 HTTPS）。
// 和 worker.cjs 分开：那个进程空闲 120 秒就被宿主回收，隧道要一直开着；有隧道时 main.js 定时来 tunnel/list 保活。
// 每条隧道前面挂一个本机反向代理：把 Host 改回 localhost（开发服务器只认它），按需要求访问口令。
// 不下载、不安装任何程序；找不到工具就报告未安装，由看板引导用户自己装。
const fs = require('node:fs/promises');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { execFile, execFileSync, spawn } = require('node:child_process');
const { createHash, randomBytes, randomInt, timingSafeEqual } = require('node:crypto');

// 设置和在跑的进程号存在本机配置目录，不进项目、不随 git 提交，文件只许本人读写。
function stateDir() {
  if (process.env.PROJECT_BOARD_STATE_DIR) return process.env.PROJECT_BOARD_STATE_DIR; // 测试用
  const home = os.homedir();
  if (process.platform === 'win32') return path.join(process.env.APPDATA || home, 'cindy-project-board');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'cindy-project-board');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'cindy-project-board');
}
const STATE = stateDir();
const SETTINGS_FILE = path.join(STATE, 'tunnels.json');
const RUNNING_FILE = path.join(STATE, 'running.json');

const MODES = {
  'cloudflare-quick': 'cloudflared',
  cloudflare: 'cloudflared',
  tailscale: 'tailscale',
};
const READY_TIMEOUT_MS = 40000;
const TAILSCALE_PORTS = [443, 8443, 10000]; // Funnel 只开放这三个端口
const KEY_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

function reply(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}
const notify = (dir) => reply({ jsonrpc: '2.0', method: 'tunnel/changed', params: { dir } });

function codeError(code, message, extra) {
  return Object.assign(new Error(message || code), { code, ...extra });
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}
async function writePrivate(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, content, { mode: 0o600 });
  await fs.rename(tmp, file);
}
const readSettings = () => readJson(SETTINGS_FILE, {});
const writeSettings = (settings) => writePrivate(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n');
const shortHash = (value) => createHash('sha256').update(value).digest('hex').slice(0, 10);

// ---------- 找本机已装的工具 ----------
// PATH 之外再找几处常见安装位置：应用自带的命令行（Tailscale.app）、Windows 安装器默认目录。
function extraDirs(tool) {
  if (process.platform === 'darwin') {
    return tool === 'tailscale' ? ['/Applications/Tailscale.app/Contents/MacOS', '/opt/homebrew/bin', '/usr/local/bin'] : ['/opt/homebrew/bin', '/usr/local/bin'];
  }
  if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const windir = process.env.SystemRoot || 'C:\\Windows';
    return {
      cloudflared: [path.join(pf86, 'cloudflared'), path.join(pf, 'cloudflared')],
      tailscale: [path.join(pf, 'Tailscale')],
    }[tool];
  }
  return ['/usr/local/bin', '/usr/bin', path.join(os.homedir(), '.local', 'bin')];
}

async function findTool(tool) {
  const names = process.platform === 'win32' ? [`${tool}.exe`] : tool === 'tailscale' ? ['tailscale', 'Tailscale'] : [tool];
  const dirs = [...(process.env.PATH || '').split(path.delimiter).filter(Boolean), ...extraDirs(tool)];
  for (const dir of dirs) {
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        await fs.access(file, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
        if ((await fs.stat(file)).isFile()) return file;
      } catch {
        // 这里没有，继续找
      }
    }
  }
  return null;
}

function run(file, args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout, out: `${stdout}\n${stderr}`.trim() }));
  });
}

// 本地服务在哪个回环地址上：开发服务器常只监听 localhost，有的机器上是 ::1，有的是 127.0.0.1；
// Cindy 内置的 Node 解析 localhost 时不会两个都试，所以这里逐个试，之后代理固定连能通的那个。
// 都连不上就不公开，免得访客只看到错误页、用户也看不出是端口填错了。
async function localAddress(port) {
  for (const host of ['127.0.0.1', '::1']) {
    const ok = await new Promise((resolve) => {
      const socket = net.connect({ host, port, timeout: 2000 });
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
      socket.once('timeout', () => { socket.destroy(); resolve(false); });
    });
    if (ok) return host;
  }
  return null;
}

// 本地服务是不是 HTTPS（vite --https、mkcert 之类）：是的话代理也用 HTTPS 去连，否则它会一直把访客跳到 https://localhost。
// 连的是本机自己的服务，证书多半是自签的，不校验。
const LOCAL_TLS = { rejectUnauthorized: false, servername: 'localhost' };
function speaksTls(host, port) {
  return new Promise((resolve) => {
    const socket = tls.connect({ host, port, timeout: 2000, ...LOCAL_TLS });
    socket.once('secureConnect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
  });
}

const cloudflaredCert = () => process.env.TUNNEL_ORIGIN_CERT || path.join(os.homedir(), '.cloudflared', 'cert.pem');
const exists = (file) => fs.access(file).then(() => true, () => false);

async function detectTools() {
  const [cloudflared, tailscale] = await Promise.all(['cloudflared', 'tailscale'].map(findTool));
  const tools = { platform: process.platform };
  tools.cloudflared = { installed: Boolean(cloudflared) };
  if (cloudflared) {
    tools.cloudflared.version = /version (\S+)/.exec((await run(cloudflared, ['--version'])).out)?.[1] ?? null;
    tools.cloudflared.loggedIn = await exists(cloudflaredCert());
    tools.cloudflared.loggingIn = Boolean(login);
  }
  tools.tailscale = { installed: Boolean(tailscale) };
  if (tailscale) {
    const status = await run(tailscale, ['status', '--json']);
    let parsed = null;
    try { parsed = JSON.parse(status.out); } catch { /* 后台服务没开时输出的是错误文字 */ }
    tools.tailscale.running = parsed?.BackendState === 'Running';
    tools.tailscale.host = parsed?.Self?.DNSName?.replace(/\.$/, '') || null;
  }
  return tools;
}

// ---------- 本机反向代理：只走 HTTPS、访问口令换会话、改 Host ----------
// 口令只在登录页里用 POST 提交，不进 URL；登录后发一个随机会话 ID（不是口令本身）放进 Cookie。
// 分享用一次性链接：1 小时内有效、打开一次就作废。停止公开时口令、会话、链接全部作废。
const LOGIN_PATH = '/__cindy_board/login';
const INVITE_PARAM = 'cindy_invite';
const SESSION_COOKIE = '__Host-cindy_board_session'; // __Host- 前缀：浏览器只接受 Secure、Path=/、不带 Domain 的写法
const SESSION_MS = 12 * 60 * 60 * 1000;
const INVITE_MS = 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 60 * 1000;
const LOGIN_MAX_FAILURES = 10; // 一分钟内输错这么多次就暂停登录，防止猜口令
const HSTS = { 'Strict-Transport-Security': 'max-age=86400' };

function makeCode() {
  return Array.from({ length: 10 }, () => KEY_CHARS[randomInt(KEY_CHARS.length)]).join('');
}
const randomToken = () => randomBytes(32).toString('base64url');

function cookieValue(header, name) {
  for (const part of String(header || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}
function withoutCookie(header, name) {
  return String(header).split(';').map((p) => p.trim()).filter((p) => p && !p.startsWith(`${name}=`)).join('; ');
}
function sameSecret(given, secret) {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}
const escAttr = (value) => String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
// 登录后跳回的地址只认本站路径，不能借它跳到别的网站。
const safeNext = (value) => (typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') ? value : '/');

// 访客实际用的协议。Cloudflare 会如实标明 http / https，明文的跳到 HTTPS；
// Tailscale Funnel 只开放 HTTPS 端口，不看转发头（转发方可能把它改写成 http，照着跳会死循环）。
function visitorProto(tunnel, req) {
  if (tunnel.mode === 'tailscale') return 'https';
  return req.headers['x-forwarded-proto'] === 'http' ? 'http' : 'https';
}

function hasSession(tunnel, req) {
  const id = cookieValue(req.headers.cookie, SESSION_COOKIE);
  const expires = id ? tunnel.sessions.get(id) : undefined;
  if (!expires) return false;
  if (expires > Date.now()) return true;
  tunnel.sessions.delete(id);
  return false;
}

function startSession(tunnel, res, next) {
  const id = randomToken();
  tunnel.sessions.set(id, Date.now() + SESSION_MS);
  res.writeHead(303, {
    ...HSTS,
    Location: next,
    'Set-Cookie': `${SESSION_COOKIE}=${id}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}`,
    'Cache-Control': 'no-store',
  });
  res.end();
}

function lockedOut(tunnel) {
  const since = Date.now() - LOGIN_WINDOW_MS;
  tunnel.failures = tunnel.failures.filter((t) => t > since);
  return tunnel.failures.length >= LOGIN_MAX_FAILURES;
}

// 访客看到的页面：不知道对方语言，中英文都写。
function page(res, status, title, body) {
  res.writeHead(status, { ...HSTS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font:15px/1.6 system-ui,sans-serif;max-width:360px;margin:18vh auto;padding:0 20px;color:#222;background:#fafafa}
@media(prefers-color-scheme:dark){body{color:#eee;background:#1b1b1b}input{background:#2a2a2a;color:#eee;border-color:#555}}
h1{font-size:18px}input{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #bbb;border-radius:6px;font:inherit}
button{margin-top:10px;padding:8px 16px;border:0;border-radius:6px;background:#2f6fde;color:#fff;font:inherit}.err{color:#c33}</style>${body}`);
}

const LOGIN_NOTES = {
  ask: '<p>向分享给你的人要访问口令。<br>Ask the person who shared this page for the access code.</p>',
  wrong: '<p class="err">口令不对。<br>Wrong access code.</p>',
  invite: '<p class="err">这个一次性链接已用过或已过期，请输入访问口令。<br>This one-time link was already used or has expired. Enter the access code.</p>',
  locked: '<p class="err">尝试次数太多，请一分钟后再试。<br>Too many attempts. Try again in a minute.</p>',
};
function loginPage(res, next, note, status = 401) {
  page(res, status, 'Access code', `<h1>需要访问口令 · Access code required</h1>${LOGIN_NOTES[note]}
<form method="post" action="${LOGIN_PATH}"><input type="hidden" name="next" value="${escAttr(next)}"><input name="code" type="password" autocomplete="off" required autofocus><button>进入 · Enter</button></form>`);
}

function handleLogin(tunnel, req, res) {
  if (req.method !== 'POST') {
    res.writeHead(303, { ...HSTS, Location: '/' });
    return res.end();
  }
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 4096) req.destroy();
  });
  req.on('end', () => {
    const form = new URLSearchParams(body);
    const next = safeNext(form.get('next'));
    if (lockedOut(tunnel)) return loginPage(res, next, 'locked', 429);
    if (!sameSecret(form.get('code'), tunnel.code)) {
      tunnel.failures.push(Date.now());
      return loginPage(res, next, 'wrong');
    }
    startSession(tunnel, res, next);
  });
}

function forwardHeaders(tunnel, req) {
  const headers = { ...req.headers };
  const local = `localhost:${tunnel.port}`;
  const publicHost = req.headers.host || '';
  headers.host = local;
  headers['x-forwarded-host'] = publicHost;
  headers['x-forwarded-proto'] = 'https';
  // 浏览器发来的 Origin 是公网地址；改成本地地址，开发服务器的同源检查和 Host 才对得上。
  try {
    if (headers.origin && new URL(headers.origin).host === publicHost) headers.origin = `${tunnel.localTls ? 'https' : 'http'}://${local}`;
  } catch {
    // Origin 不是 URL（如 "null"），原样转发
  }
  // 会话 Cookie 只给看板自己用，不转给项目。
  if (headers.cookie) {
    headers.cookie = withoutCookie(headers.cookie, SESSION_COOKIE);
    if (!headers.cookie) delete headers.cookie;
  }
  return headers;
}

function handle(tunnel, req, res) {
  if (visitorProto(tunnel, req) === 'http') {
    res.writeHead(308, { Location: `https://${req.headers.host}${req.url}` });
    return res.end();
  }
  const url = new URL(req.url, 'https://local');
  if (url.pathname === LOGIN_PATH) return handleLogin(tunnel, req, res);
  if (url.searchParams.has(INVITE_PARAM)) {
    // 一次性链接：不论成败都作废，打开后跳到去掉链接参数的地址。
    const token = url.searchParams.get(INVITE_PARAM);
    const expires = tunnel.invites.get(token);
    tunnel.invites.delete(token);
    url.searchParams.delete(INVITE_PARAM);
    const next = url.pathname + url.search;
    if (expires > Date.now()) return startSession(tunnel, res, next);
    tunnel.failures.push(Date.now());
    return loginPage(res, next, 'invite');
  }
  if (!hasSession(tunnel, req)) return loginPage(res, req.url, 'ask');
  const options = { host: tunnel.localHost, port: tunnel.port, method: req.method, path: req.url, headers: forwardHeaders(tunnel, req) };
  const upstream = (tunnel.localTls ? https : http).request(tunnel.localTls ? { ...options, ...LOCAL_TLS } : options, (up) => {
    const headers = { ...up.headers, ...HSTS };
    // 应用跳转到 http://localhost:端口/... 时改回公网地址，访客才跳得过去。
    const location = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d+)(.*)$/i.exec(headers.location || '');
    if (location && Number(location[1]) === tunnel.port) headers.location = `https://${req.headers.host}${location[2]}`;
    res.writeHead(up.statusCode, up.statusMessage, headers);
    up.pipe(res);
  });
  upstream.on('error', () => {
    if (res.headersSent) return res.destroy();
    // 用 503：Cloudflare 会把源站的 502 换成它自己的错误页，访客就看不到这里的说明。
    page(res, 503, 'Not running', `<h1>本地服务没有响应 · Not running</h1><p>这台电脑上的 localhost:${tunnel.port} 没有在运行。<br>Nothing is answering on localhost:${tunnel.port} on the shared computer.</p>`);
  });
  req.pipe(upstream);
}

// WebSocket（开发服务器的热更新等）：鉴权后原样双向转发。
function upgrade(tunnel, req, socket, head) {
  if (visitorProto(tunnel, req) !== 'https' || !hasSession(tunnel, req)) {
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  const send = () => {
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (const [name, value] of Object.entries(forwardHeaders(tunnel, req))) {
      for (const item of [].concat(value)) raw += `${name}: ${item}\r\n`;
    }
    upstream.write(`${raw}\r\n`);
    if (head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  };
  const target = { host: tunnel.localHost, port: tunnel.port };
  const upstream = tunnel.localTls ? tls.connect({ ...target, ...LOCAL_TLS }, send) : net.connect(target, send);
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
}

async function startProxy(tunnel) {
  const server = http.createServer((req, res) => handle(tunnel, req, res));
  server.on('upgrade', (req, socket, head) => upgrade(tunnel, req, socket, head));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server;
}

// ---------- 各种方式 ----------
// 每种方式给出：要运行的命令、从输出里认出公网地址和「已连上」、认出常见失败；停止后需要的收尾。
const lastLines = (tunnel) => tunnel.log.slice(-6).join('\n');

async function cloudflareNamed(bin, tunnel, hostname) {
  if (!HOSTNAME.test(hostname || '')) throw codeError('BAD_HOSTNAME');
  if (!(await exists(cloudflaredCert()))) throw codeError('CF_LOGIN');
  const name = `cindy-board-${shortHash(hostname.toLowerCase())}`;
  const listed = await run(bin, ['tunnel', 'list', '-o', 'json', '-n', name]);
  let found = [];
  try { found = JSON.parse(listed.stdout); } catch { /* 输出不是 JSON 时当作没有，下面 create 会报真实原因 */ }
  if (!found.length) {
    const created = await run(bin, ['tunnel', 'create', name], 30000);
    if (!created.ok) throw codeError('TOOL_FAILED', created.out.split('\n').slice(-3).join('\n'));
  }
  const routed = await run(bin, ['tunnel', 'route', 'dns', name, hostname], 30000);
  if (!routed.ok) {
    if (/already exists/i.test(routed.out)) throw codeError('CF_DNS_EXISTS');
    throw codeError('TOOL_FAILED', routed.out.split('\n').slice(-3).join('\n'));
  }
  // 证书所在的域名和填的不一致时，cloudflared 会把记录建在证书的域名下面，以它报出的为准。
  const actual = /CNAME (\S+)/.exec(routed.out)?.[1] || /(\S+) is already configured/.exec(routed.out)?.[1] || hostname;
  return {
    args: ['tunnel', '--no-autoupdate', '--metrics', '127.0.0.1:0', 'run', '--url', `http://127.0.0.1:${tunnel.proxyPort}`, name],
    url: `https://${actual}`,
    ready: /Registered tunnel connection/,
  };
}

const PLANS = {
  'cloudflare-quick': (bin, tunnel) => ({
    args: ['tunnel', '--no-autoupdate', '--metrics', '127.0.0.1:0', '--url', `http://127.0.0.1:${tunnel.proxyPort}`],
    urlFrom: /https:\/\/[a-z0-9-]+\.trycloudflare\.com/,
    ready: /Registered tunnel connection/,
    fail: /failed to (?:request|unmarshal) quick Tunnel[^\n]*/i,
  }),
  cloudflare: (bin, tunnel, options) => cloudflareNamed(bin, tunnel, options.hostname),
  tailscale: async (bin, tunnel) => {
    const used = new Set([...tunnels.values()].filter((t) => t.mode === 'tailscale' && t !== tunnel).map((t) => t.publicPort));
    const port = TAILSCALE_PORTS.find((p) => !used.has(p));
    if (!port) throw codeError('TS_PORTS_FULL');
    tunnel.publicPort = port;
    return {
      args: ['funnel', `--https=${port}`, `http://127.0.0.1:${tunnel.proxyPort}`],
      urlFrom: /https:\/\/[a-z0-9.-]+\.ts\.net(?::\d+)?/i,
      ready: /Available on the internet|\.ts\.net/i,
      fail: (line) => {
        // HTTPS 证书没开时报的是 Serve，同样给出开启链接。
        if (/(?:Funnel|Serve) is not enabled/i.test(line)) return { code: 'TS_FUNNEL_OFF', actionPattern: /https:\/\/login\.tailscale\.com\/\S+/ };
        if (/access denied|permission denied|serve config denied/i.test(line)) return { code: 'TS_DENIED' };
        if (/not running|NeedsLogin|logged out|failed to connect to local tailscaled/i.test(line)) return { code: 'TS_DOWN' };
        return null;
      },
      // 前台模式退出时自己会撤掉 Funnel；被强杀（Windows）时撤不掉，统一再关一次。
      // 用 serve off：funnel off 在 tailnet 没开 Funnel 时会一直等开通。
      cleanup: () => run(bin, ['serve', `--https=${port}`, 'off'], 8000),
    };
  },
};

// ---------- 隧道生命周期 ----------
const tunnels = new Map(); // 项目目录 → 隧道
let login = null; // 正在进行的 cloudflared tunnel login

function publicTunnel(t) {
  return {
    dir: t.dir, mode: t.mode, port: t.port, state: t.state, url: t.url, code: t.code,
    error: t.error, startedAt: t.startedAt,
  };
}

async function saveRunning() {
  const list = [...tunnels.values()].filter((t) => t.child?.pid && t.child.exitCode === null && t.child.signalCode === null).map((t) => ({ pid: t.child.pid, bin: path.basename(t.bin), mode: t.mode, publicPort: t.publicPort }));
  await writePrivate(RUNNING_FILE, JSON.stringify(list) + '\n').catch(() => {});
}

// 上次进程被强杀（Windows 上宿主停进程不给收尾机会）时留下的隧道程序，启动时收掉。进程名对得上才杀，防止误杀复用了进程号的程序。
async function reapStale() {
  const list = await readJson(RUNNING_FILE, []).catch(() => []);
  for (const { pid, bin, mode, publicPort } of list) {
    const probe = process.platform === 'win32'
      ? await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], 5000)
      : await run('ps', ['-p', String(pid), '-o', 'comm='], 5000);
    if (probe.ok && probe.out.toLowerCase().includes(String(bin).toLowerCase().replace(/\.exe$/, '').slice(0, 15))) {
      try { process.kill(pid); } catch { /* 已经退出 */ }
    }
    if (mode === 'tailscale' && publicPort) {
      const tailscale = await findTool('tailscale');
      if (tailscale) await run(tailscale, ['serve', `--https=${publicPort}`, 'off'], 8000);
    }
  }
  if (list.length) await writePrivate(RUNNING_FILE, '[]\n').catch(() => {});
}
const reaped = reapStale();

function settle(tunnel, state, error) {
  tunnel.state = state;
  tunnel.error = error || null;
  tunnel.waiter?.();
  tunnel.waiter = null;
  notify(tunnel.dir);
}

function watchOutput(tunnel, plan, stream) {
  readline.createInterface({ input: stream }).on('line', (raw) => {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '').trim(); // 去掉颜色码
    if (!line) return;
    tunnel.log.push(line);
    if (tunnel.log.length > 40) tunnel.log.shift();
    if (!tunnel.url && plan.urlFrom) {
      const found = plan.urlFrom.exec(line);
      if (found) tunnel.url = (found[1] || found[0]).replace(/\/$/, '');
    }
    if (tunnel.state !== 'starting') return;
    const failed = typeof plan.fail === 'function' ? plan.fail(line) : plan.fail?.exec(line) && { code: 'TOOL_FAILED', message: line };
    if (failed) {
      tunnel.pendingFailure = failed;
      if (failed.actionPattern) tunnel.actionWatch = failed.actionPattern;
    }
    // 失败提示后面紧跟着的链接（如开启 Funnel 的地址）一并带给看板。
    if (tunnel.actionWatch) {
      const action = tunnel.actionWatch.exec(line)?.[0];
      if (action) {
        tunnel.actionWatch = null;
        settle(tunnel, 'error', { code: tunnel.pendingFailure.code, actionUrl: action });
        stopProcess(tunnel);
      }
      return;
    }
    if (failed) {
      settle(tunnel, 'error', { code: failed.code, message: failed.message });
      stopProcess(tunnel);
      return;
    }
    if (tunnel.url && plan.ready.test(line)) settle(tunnel, 'online');
  });
}

function stopProcess(tunnel) {
  const child = tunnel.child;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  // tailscale 前台模式收到 Ctrl+C（SIGINT）才会撤掉 Funnel 配置。
  child.kill(tunnel.mode === 'tailscale' && process.platform !== 'win32' ? 'SIGINT' : 'SIGTERM');
  setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 3000).unref();
}

async function start({ dir, mode, port, hostname }) {
  if (!MODES[mode]) throw codeError('BAD_MODE');
  port = Number(port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw codeError('BAD_PORT');
  await reaped;
  if (tunnels.has(dir)) await stop({ dir });
  const bin = await findTool(MODES[mode]);
  if (!bin) throw codeError('NOT_INSTALLED');
  const localHost = await localAddress(port);
  if (!localHost) throw codeError('LOCAL_DOWN');
  const localTls = await speaksTls(localHost, port);

  // 先记下这个项目的选择，下次打开直接填好。
  const settings = await readSettings();
  settings.projects = { ...settings.projects, [dir]: { mode, port, hostname } };
  await writeSettings(settings);

  const tunnel = {
    dir, mode, port, localHost, localTls, bin, code: makeCode(), sessions: new Map(), invites: new Map(), failures: [],
    state: 'starting', url: null, error: null, log: [], startedAt: Date.now(),
  };
  tunnels.set(dir, tunnel);
  notify(dir); // 看板先显示「正在连接」，可以随时停止
  try {
    tunnel.proxy = await startProxy(tunnel);
    tunnel.proxyPort = tunnel.proxy.address().port;
    const plan = await PLANS[mode](bin, tunnel, { hostname });
    if (plan.url) tunnel.url = plan.url;
    tunnel.cleanup = plan.cleanup;
    if (tunnels.get(dir) !== tunnel) throw codeError('CANCELLED');
    const child = spawn(bin, plan.args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    tunnel.child = child;
    watchOutput(tunnel, plan, child.stdout);
    watchOutput(tunnel, plan, child.stderr);
    child.once('error', (err) => {
      if (tunnel.state === 'starting') settle(tunnel, 'error', { code: 'TOOL_FAILED', message: err.message });
    });
    child.once('exit', () => {
      if (tunnel.state !== 'error') settle(tunnel, 'error', { code: tunnel.state === 'online' ? 'EXITED' : 'TOOL_FAILED', message: lastLines(tunnel) });
      tunnel.proxy?.closeAllConnections?.();
      tunnel.proxy?.close();
      Promise.resolve(tunnel.cleanup?.()).catch(() => {});
      tunnel.cleanup = null;
      saveRunning();
    });
    saveRunning();
    await new Promise((resolve) => {
      tunnel.waiter = resolve;
      setTimeout(() => {
        if (tunnel.state !== 'starting') return;
        const failed = tunnel.pendingFailure;
        settle(tunnel, 'error', failed ? { code: failed.code, message: failed.message } : { code: 'START_TIMEOUT', message: lastLines(tunnel) });
        stopProcess(tunnel);
      }, READY_TIMEOUT_MS).unref();
    });
  } catch (err) {
    tunnel.proxy?.close();
    // 准备期间被停止时也要收尾
    await Promise.resolve(tunnel.cleanup?.()).catch(() => {});
    tunnel.cleanup = null;
    if (tunnels.get(dir) === tunnel) settle(tunnel, 'error', { code: err.code || 'TOOL_FAILED', message: err.message });
  }
  return publicTunnel(tunnel);
}

async function stop({ dir }) {
  const tunnel = tunnels.get(dir);
  if (!tunnel) return { ok: true };
  tunnels.delete(dir);
  if (tunnel.child && tunnel.child.exitCode === null && tunnel.child.signalCode === null) {
    const exited = new Promise((resolve) => tunnel.child.once('exit', resolve));
    stopProcess(tunnel);
    await exited;
  } else {
    tunnel.proxy?.closeAllConnections?.();
    tunnel.proxy?.close();
    await Promise.resolve(tunnel.cleanup?.()).catch(() => {});
  }
  await saveRunning();
  notify(dir);
  return { ok: true };
}

// 一次性分享链接：1 小时内有效，打开一次就作废；访客打开后在那台设备上保持登录（同口令登录）。
function invite({ dir }) {
  const tunnel = tunnels.get(dir);
  if (tunnel?.state !== 'online') throw codeError('NOT_ONLINE');
  const now = Date.now();
  for (const [token, expires] of tunnel.invites) if (expires < now) tunnel.invites.delete(token);
  const token = randomToken();
  tunnel.invites.set(token, now + INVITE_MS);
  return { url: `${tunnel.url}/?${INVITE_PARAM}=${token}`, expiresAt: now + INVITE_MS };
}

async function list() {
  const settings = await readSettings();
  return {
    tunnels: [...tunnels.values()].map(publicTunnel),
    loggingIn: Boolean(login),
    projects: settings.projects || {},
  };
}

// cloudflared 会自己打开默认浏览器（用的是用户平时的浏览器和登录状态）；链接也交给看板显示，打不开时可以手动点。
async function cloudflareLogin() {
  const bin = await findTool('cloudflared');
  if (!bin) throw codeError('NOT_INSTALLED');
  if (await exists(cloudflaredCert())) return { loggedIn: true };
  if (login?.url) return { url: login.url };
  if (!login) {
    const child = spawn(bin, ['tunnel', 'login'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    login = { child, url: null, waiters: [] };
    const current = login;
    const onLine = (line) => {
      const url = /https:\/\/dash\.cloudflare\.com\/argotunnel\S+/.exec(line)?.[0];
      if (url && !current.url) {
        current.url = url;
        current.waiters.splice(0).forEach((fn) => fn());
      }
    };
    readline.createInterface({ input: child.stdout }).on('line', onLine);
    readline.createInterface({ input: child.stderr }).on('line', onLine);
    child.once('exit', () => {
      if (login === current) login = null;
      current.waiters.splice(0).forEach((fn) => fn());
      notify(null);
    });
    child.once('error', () => child.emit('exit'));
  }
  const current = login;
  await new Promise((resolve) => {
    current.waiters.push(resolve);
    setTimeout(resolve, 15000).unref();
  });
  if (await exists(cloudflaredCert())) return { loggedIn: true };
  if (!current.url) throw codeError('TOOL_FAILED', 'cloudflared did not print a login link');
  return { url: current.url };
}

function openUrl({ url }) {
  if (!/^https?:\/\/[^\s]+$/i.test(String(url))) throw codeError('BAD_URL');
  const [command, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['explorer.exe', [url]]
      : ['xdg-open', [url]];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve({ ok: true });
    });
  });
}

const METHODS = {
  'tunnel/tools': detectTools,
  'tunnel/list': list,
  'tunnel/start': start,
  'tunnel/stop': stop,
  'tunnel/invite': invite,
  'tunnel/cloudflare-login': cloudflareLogin,
  'tunnel/open-url': openUrl,
};
const NEEDS_DIR = new Set(['tunnel/start', 'tunnel/stop', 'tunnel/invite']);

// 宿主停进程时先发 SIGTERM（关 stdin），给 2 秒收尾：把隧道程序一起关掉，不留在后台继续对外开放。
function shutdown() {
  for (const tunnel of tunnels.values()) {
    try {
      tunnel.child?.kill(tunnel.mode === 'tailscale' && process.platform !== 'win32' ? 'SIGINT' : 'SIGTERM');
    } catch {
      // 已经退出
    }
    if (tunnel.mode === 'tailscale' && tunnel.publicPort) {
      try {
        execFileSync(tunnel.bin, ['serve', `--https=${tunnel.publicPort}`, 'off'], { timeout: 1500, stdio: 'ignore', windowsHide: true });
      } catch {
        // 下次启动时 reapStale 再关
      }
    }
  }
  login?.child.kill();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.stdin.on('end', shutdown);

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    reply({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const method = METHODS[request.method];
  if (!method) {
    reply({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } });
    return;
  }
  const params = request.params || {};
  if (NEEDS_DIR.has(request.method) && (typeof params.dir !== 'string' || !path.isAbsolute(params.dir))) {
    reply({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'dir must be an absolute path' } });
    return;
  }
  try {
    reply({ jsonrpc: '2.0', id: request.id, result: await method(params) });
  } catch (err) {
    // 错误码放在 message 开头（「CODE」或「CODE: 详情」），main.js 从这里取。
    const message = err.code ? (err.message && err.message !== err.code ? `${err.code}: ${err.message}` : err.code) : err.message;
    reply({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message } });
  }
});
