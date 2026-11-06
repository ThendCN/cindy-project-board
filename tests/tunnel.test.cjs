'use strict';
// 「公开访问」工作进程的测试：像 Cindy 一样启动 node/tunnel.cjs，用一个假的 ssh 代替 localhost.run，
// 不联网。重点是访问口令这道关：没口令进不去，口令不会转给项目自己的服务。
// 运行：node --test tests/*.test.cjs（假 ssh 是 Node 脚本，只在 macOS / Linux 上跑）
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
const PUBLIC_HOST = 'demo.lhr.life';

// 假 ssh：把看板交给它的本机代理端口写进文件，打印 localhost.run 的那行地址，然后一直挂着；
// FAKE_EXIT 存在时（文件里有内容）立刻退出，模拟隧道断开。
const FAKE_SSH = `#!/usr/bin/env node
const fs = require('node:fs');
const forward = process.argv[process.argv.indexOf('-R') + 1];
fs.writeFileSync(process.env.FAKE_PORT_FILE, forward.split(':').pop());
console.log('${PUBLIC_HOST} tunneled with tls termination, https://${PUBLIC_HOST}');
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
  await fs.writeFile(path.join(bin, 'ssh'), FAKE_SSH, { mode: 0o755 });
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

async function call(method, params) {
  const id = nextId++;
  const res = await new Promise((resolve) => {
    waiting.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  if (res.error) throw new Error(res.error.message);
  return res.result;
}

/** 项目自己的服务：原样报告收到的 Host 和 Cookie。 */
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

/** 像访客一样经隧道访问：请求发到看板的本机代理，Host 是公网域名。 */
async function visit(urlPath, cookie) {
  const port = Number(await fs.readFile(path.join(tmp, 'port'), 'utf8'));
  return new Promise((resolve, reject) => {
    const headers = { host: PUBLIC_HOST, 'x-forwarded-proto': 'https', ...(cookie ? { cookie } : {}) };
    http.get({ host: '127.0.0.1', port, path: urlPath, headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

test('开了口令：没口令或口令不对进不去，带口令的链接换成 Cookie 后才转给项目，口令不转给项目', async () => {
  const local = await localServer();
  const t = await call('tunnel/start', { dir: DIR, mode: 'ssh', port: local.address().port, auth: true });
  assert.equal(t.state, 'online');
  assert.equal(t.url, `https://${PUBLIC_HOST}`);
  assert.match(t.key, /^[a-z2-9]{10}$/);
  assert.equal(t.shareUrl, `https://${PUBLIC_HOST}/?cindy_key=${t.key}`);

  assert.equal((await visit('/')).status, 401);
  assert.equal((await visit('/?cindy_key=wrong')).status, 401);
  assert.equal((await visit('/', 'cindy_board_access=wrong')).status, 401);

  const entered = await visit(`/page?a=1&cindy_key=${t.key}`);
  assert.equal(entered.status, 302);
  assert.equal(entered.headers.location, '/page?a=1');
  const cookie = entered.headers['set-cookie'][0].split(';')[0];

  const inside = await visit('/page?a=1', `theme=dark; ${cookie}`);
  assert.equal(inside.status, 200);
  assert.deepEqual(JSON.parse(inside.body), { url: '/page?a=1', host: `localhost:${local.address().port}`, cookie: 'theme=dark' });
  // 项目跳到 localhost 时改回公网地址
  assert.equal((await visit('/go', cookie)).headers.location, `https://${PUBLIC_HOST}/landing`);

  await call('tunnel/stop', { dir: DIR });
  local.close();
});

test('WebSocket 升级请求同样要过口令', async () => {
  const local = await localServer();
  await call('tunnel/start', { dir: DIR, mode: 'ssh', port: local.address().port, auth: true });
  const port = Number(await fs.readFile(path.join(tmp, 'port'), 'utf8'));
  const reply = await new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`GET /ws HTTP/1.1\r\nHost: ${PUBLIC_HOST}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
    });
    let data = '';
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('close', () => resolve(data));
  });
  assert.match(reply, /^HTTP\/1\.1 401/);
  await call('tunnel/stop', { dir: DIR });
  local.close();
});

test('隧道程序退出时报告断开并通知看板；停止后列表清空', async () => {
  const local = await localServer();
  await call('tunnel/start', { dir: DIR, mode: 'ssh', port: local.address().port, auth: false });
  notifications.length = 0;
  await fs.writeFile(path.join(tmp, 'exit'), '1');
  while (!notifications.length) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(notifications[0], { jsonrpc: '2.0', method: 'tunnel/changed', params: { dir: DIR } });
  const { tunnels } = await call('tunnel/list', {});
  assert.equal(tunnels[0].state, 'error');
  assert.equal(tunnels[0].error.code, 'EXITED');

  await call('tunnel/stop', { dir: DIR });
  assert.deepEqual((await call('tunnel/list', {})).tunnels, []);
  await fs.rm(path.join(tmp, 'exit'));
  local.close();
});

test('本地端口上没有服务时不公开，直接报 LOCAL_DOWN', async () => {
  const local = await localServer();
  const { port } = local.address();
  await new Promise((resolve) => local.close(resolve));
  const res = await new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tunnel/start', params: { dir: DIR, mode: 'ssh', port, auth: true } }) + '\n');
  });
  assert.equal(res.error.message, 'LOCAL_DOWN');
  assert.deepEqual((await call('tunnel/list', {})).tunnels, []);
});
