'use strict';
// 「公开访问」工作进程的测试：像 Cindy 一样启动 node/tunnel.cjs，用一个假的 cloudflared 代替 Cloudflare 快速隧道，
// 不联网。重点是访问这道关：口令只能在登录页 POST、登录后发会话而不是口令、一次性链接只能用一次、明文 HTTP 跳到 HTTPS。
// 运行：node --test tests/*.test.cjs（假 cloudflared 是 Node 脚本，只在 macOS / Linux 上跑）
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const WORKER = path.join(__dirname, '..', 'project-board-plugin', 'node', 'tunnel.cjs');
const DIR = path.join(os.tmpdir(), 'project-board-tunnel-demo'); // 只当项目标识用，不会读写
const PUBLIC_HOST = 'demo-tunnel.trycloudflare.com';
const SESSION = '__Host-cindy_board_session';

// 假 cloudflared：把看板交给它的本机代理端口写进文件，打印快速隧道的地址和「已连上」，然后一直挂着；
// FAKE_EXIT 文件出现时立刻退出，模拟隧道断开。
const FAKE_CLOUDFLARED = `#!/usr/bin/env node
const fs = require('node:fs');
const url = process.argv[process.argv.indexOf('--url') + 1];
fs.writeFileSync(process.env.FAKE_PORT_FILE, url.split(':').pop());
console.error('INF |  https://${PUBLIC_HOST}  |');
console.error('INF Registered tunnel connection connIndex=0');
setInterval(() => {
  if (fs.existsSync(process.env.FAKE_EXIT)) process.exit(1);
}, 50);
`;

let child;
let tmp;
let nextId = 1;
const waiting = new Map();
const notifications = [];

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'project-board-tunnel-'));
  const bin = path.join(tmp, 'bin');
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'cloudflared'), FAKE_CLOUDFLARED, { mode: 0o755 });
  child = spawn(process.execPath, [WORKER], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      PROJECT_BOARD_STATE_DIR: path.join(tmp, 'state'),
      FAKE_PORT_FILE: path.join(tmp, 'port'),
      FAKE_EXIT: path.join(tmp, 'exit'),
    },
  });
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    if (msg.id === undefined) notifications.push(msg);
    else {
      waiting.get(msg.id)?.(msg);
      waiting.delete(msg.id);
    }
  });
});
after(() => child.kill());

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
async function call(method, params) {
  const res = await rpc(method, params);
  if (res.error) throw new Error(res.error.message);
  return res.result;
}

/** 项目自己的服务：原样报告收到的路径、Host 和 Cookie。 */
async function localServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/go') {
      res.writeHead(302, { Location: `http://localhost:${server.address().port}/landing` });
      return res.end();
    }
    res.end(JSON.stringify({ url: req.url, host: req.headers.host, cookie: req.headers.cookie ?? null }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

async function startTunnel() {
  const local = await localServer();
  const tunnel = await call('tunnel/start', { dir: DIR, mode: 'cloudflare-quick', port: local.address().port });
  return { local, tunnel };
}
async function stopTunnel(local) {
  await call('tunnel/stop', { dir: DIR });
  local.close();
}

/** 像访客一样经隧道访问：请求发到看板的本机代理，带上 Cloudflare 会加的 Host 和 X-Forwarded-Proto。 */
async function visit(urlPath, { cookie, method = 'GET', body, proto = 'https' } = {}) {
  const port = Number(await fs.readFile(path.join(tmp, 'port'), 'utf8'));
  const headers = { host: PUBLIC_HOST, 'x-forwarded-proto': proto, ...(cookie ? { cookie } : {}) };
  if (body) headers['content-type'] = 'application/x-www-form-urlencoded';
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const login = (code, next = '/') => visit('/__cindy_board/login', { method: 'POST', body: new URLSearchParams({ code, next }).toString() });
const sessionOf = (res) => res.headers['set-cookie'][0].split(';')[0];

test('口令只能在登录页 POST；登录后发的是会话而不是口令，会话不转给项目；停止后会话作废', async () => {
  const { local, tunnel } = await startTunnel();
  assert.equal(tunnel.state, 'online');
  assert.equal(tunnel.url, `https://${PUBLIC_HOST}`);
  assert.match(tunnel.code, /^[a-z2-9]{10}$/);
  assert.equal(tunnel.shareUrl, undefined);

  // 口令放在 URL 里不再管用
  const inUrl = await visit(`/?cindy_key=${tunnel.code}&code=${tunnel.code}`);
  assert.equal(inUrl.status, 401);
  assert.equal(inUrl.headers['set-cookie'], undefined);
  assert.match(inUrl.body, /method="post"/);

  assert.equal((await login('wrong')).status, 401);
  const entered = await login(tunnel.code, '/page?a=1');
  assert.equal(entered.status, 303);
  assert.equal(entered.headers.location, '/page?a=1');
  assert.match(entered.headers['set-cookie'][0], /; Secure; HttpOnly; SameSite=Lax;/);
  const session = sessionOf(entered);
  assert.ok(session.startsWith(`${SESSION}=`) && !session.includes(tunnel.code));
  // 登录后只认本站路径，不跳到别的网站
  assert.equal((await login(tunnel.code, '//evil.example')).headers.location, '/');

  const inside = await visit('/page?a=1', { cookie: `theme=dark; ${session}` });
  assert.equal(inside.status, 200);
  assert.deepEqual(JSON.parse(inside.body), { url: '/page?a=1', host: `localhost:${local.address().port}`, cookie: 'theme=dark' });
  assert.equal((await visit('/go', { cookie: session })).headers.location, `https://${PUBLIC_HOST}/landing`);

  await stopTunnel(local);
  const again = await startTunnel();
  assert.notEqual(again.tunnel.code, tunnel.code);
  assert.equal((await visit('/', { cookie: session })).status, 401);
  await stopTunnel(again.local);
});

test('一次性链接打开一次就作废，打开后去掉链接参数', async () => {
  const { local } = await startTunnel();
  const { url } = await call('tunnel/invite', { dir: DIR });
  const link = new URL(url);
  assert.equal(link.origin, `https://${PUBLIC_HOST}`);

  const first = await visit(`/docs${link.search}&tab=2`);
  assert.equal(first.status, 303);
  assert.equal(first.headers.location, '/docs?tab=2');
  assert.equal((await visit('/docs', { cookie: sessionOf(first) })).status, 200);

  const second = await visit(`/docs${link.search}`);
  assert.equal(second.status, 401);
  assert.equal(second.headers['set-cookie'], undefined);
  await stopTunnel(local);
});

test('明文 HTTP 跳到 HTTPS，登录页也不在明文上出现', async () => {
  const { local } = await startTunnel();
  const plain = await visit('/page?a=1', { proto: 'http' });
  assert.equal(plain.status, 308);
  assert.equal(plain.headers.location, `https://${PUBLIC_HOST}/page?a=1`);
  assert.equal((await visit('/__cindy_board/login', { method: 'POST', body: 'code=x', proto: 'http' })).status, 308);
  await stopTunnel(local);
});

test('一分钟内输错 10 次后暂停登录，口令对了也要等', async () => {
  const { local, tunnel } = await startTunnel();
  for (let i = 0; i < 10; i++) assert.equal((await login(`wrong-${i}`)).status, 401);
  const locked = await login(tunnel.code);
  assert.equal(locked.status, 429);
  assert.equal(locked.headers['set-cookie'], undefined);
  await stopTunnel(local);
});

test('WebSocket 升级请求同样要先登录', async () => {
  const { local } = await startTunnel();
  const port = Number(await fs.readFile(path.join(tmp, 'port'), 'utf8'));
  const reply = await new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`GET /ws HTTP/1.1\r\nHost: ${PUBLIC_HOST}\r\nX-Forwarded-Proto: https\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
    });
    let data = '';
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('close', () => resolve(data));
  });
  assert.match(reply, /^HTTP\/1\.1 401/);
  await stopTunnel(local);
});

test('隧道程序退出时报告断开并通知看板；停止后列表清空', async () => {
  const { local } = await startTunnel();
  notifications.length = 0;
  await fs.writeFile(path.join(tmp, 'exit'), '1');
  while (!notifications.length) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(notifications[0], { jsonrpc: '2.0', method: 'tunnel/changed', params: { dir: DIR } });
  const { tunnels } = await call('tunnel/list', {});
  assert.equal(tunnels[0].state, 'error');
  assert.equal(tunnels[0].error.code, 'EXITED');

  await stopTunnel(local);
  assert.deepEqual((await call('tunnel/list', {})).tunnels, []);
  await fs.rm(path.join(tmp, 'exit'));
});

test('本地端口上没有服务时不公开，直接报 LOCAL_DOWN', async () => {
  const local = await localServer();
  const { port } = local.address();
  await new Promise((resolve) => local.close(resolve));
  const res = await rpc('tunnel/start', { dir: DIR, mode: 'cloudflare-quick', port });
  assert.equal(res.error.message, 'LOCAL_DOWN');
  assert.deepEqual((await call('tunnel/list', {})).tunnels, []);
});
