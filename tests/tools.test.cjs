'use strict';
// 插件工具的测试：把 main.js 放进假的 cindy 宿主里运行，node 请求转给真实的 node/worker.cjs，
// 走一遍「Agent 调工具 → main.js 校验项目 → 工作进程写文件 → 交卷」，在临时目录里检查结果。
// 运行：node --test tests/*.test.cjs
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const PLUGIN = path.join(__dirname, '..', 'project-board-plugin');
const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'ghost.json'), 'utf8'));

let child;
let nextId = 1;
let registered = []; // 假宿主里已登记的项目
const waiting = new Map();
const results = new Map(); // callId → 交卷回调
const events = []; // main.js 发给主视图的事件
let hostMessage;

class FakeChannel {
  postMessage(message) {
    events.push(message);
  }
}

const cindy = {
  onHostMessage: (fn) => { hostMessage = fn; },
  send: (message) => {
    results.get(message.callId)(message);
    results.delete(message.callId);
  },
  targets: {
    list: async () => ({ targets: registered.map(({ id, label }) => ({ kind: 'project', id, label, detail: id })) }),
  },
  // 和宿主一样，把 main.js 的请求转给工作进程，并把回复包成 {ok,result} / {ok,message}。
  node: {
    request: ({ method, params }) => new Promise((resolve) => {
      const id = nextId++;
      waiting.set(id, (msg) => resolve(msg.error ? { ok: false, message: msg.error.message } : { ok: true, result: msg.result }));
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    }),
  },
};

before(() => {
  child = spawn(process.execPath, [path.join(PLUGIN, manifest.node.entry)], { stdio: ['pipe', 'pipe', 'inherit'] });
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    waiting.get(msg.id)?.(msg);
    waiting.delete(msg.id);
  });
  new Function('cindy', 'BroadcastChannel', fs.readFileSync(path.join(PLUGIN, 'main.js'), 'utf8'))(cindy, FakeChannel);
});
after(() => child.kill());

/** 模拟一次 Agent 工具调用，返回 main.js 交的卷。 */
function tool(name, args) {
  const callId = `call-${nextId++}`;
  return new Promise((resolve) => {
    results.set(callId, resolve);
    hostMessage({ type: 'tool-call', callId, tool: name, args });
  });
}

async function project(label, files = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'project-board-tools-'));
  for (const [rel, content] of Object.entries(files)) {
    await fsp.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fsp.writeFile(path.join(dir, rel), content);
  }
  registered.push({ id: dir, label });
  return dir;
}
const read = (dir, rel) => fsp.readFile(path.join(dir, rel), 'utf8');

test('list_projects 返回项目 id、名称和介绍开头，没有介绍时为 null', async () => {
  registered = [];
  const a = await project('看板', { '.cindy/project.md': '# 项目看板\n\n总览项目' });
  const b = await project('收集箱');
  const res = await tool('list_projects', {});
  assert.equal(res.ok, true);
  assert.deepEqual(res.result, {
    projects: [
      { id: a, name: '看板', intro: '# 项目看板 总览项目' },
      { id: b, name: '收集箱', intro: null },
    ],
  });
});

test('add_todo 写入待办并交回 item；remove_item 用它撤销后文件恢复原样', async () => {
  const dir = await project('看板', { '.cindy/todos.md': '# 待办\n- [ ] 已有\n' });
  const before = await read(dir, '.cindy/todos.md');
  const added = await tool('add_todo', { project: dir, text: '支持  搜索' });
  assert.equal(added.ok, true);
  assert.deepEqual(added.result.item, { kind: 'todo', line: 2, text: '支持 搜索' });
  assert.equal(await read(dir, '.cindy/todos.md'), `${before}- [ ] 支持 搜索\n`);

  const removed = await tool('remove_item', { project: dir, item: added.result.item });
  assert.equal(removed.ok, true);
  assert.equal(await read(dir, '.cindy/todos.md'), before);
});

test('待办文件有分组时，add_todo 交回新条目本身，remove_item 用它撤销后文件恢复原样', async () => {
  const before = '# 待办\n\n## 工程\n- [ ] 已有\n';
  const dir = await project('看板', { '.cindy/todos.md': before });
  const added = await tool('add_todo', { project: dir, text: '新的' });
  assert.deepEqual(added.result.item, { kind: 'todo', line: 2, text: '新的' });

  assert.equal((await tool('remove_item', { project: dir, item: added.result.item })).ok, true);
  assert.equal(await read(dir, '.cindy/todos.md'), before);
});

test('add_note 写入资料并交回 item；remove_item 用它撤销', async () => {
  const dir = await project('收集箱');
  const added = await tool('add_note', { project: dir, text: '灵感：\n做个搜索' });
  assert.equal(added.ok, true);
  assert.equal(added.result.item.kind, 'note');
  assert.match(await read(dir, '.cindy/project-knowledge/notes.md'), /灵感：\n做个搜索\n$/);

  assert.equal((await tool('remove_item', { project: dir, item: added.result.item })).ok, true);
  assert.equal(await read(dir, '.cindy/project-knowledge/notes.md'), '');
});

test('未登记的目录一律拒绝，不写文件', async () => {
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'project-board-outside-'));
  for (const [name, args] of [
    ['add_todo', { project: outside, text: '不该写入' }],
    ['add_note', { project: outside, text: '不该写入' }],
    ['remove_item', { project: outside, item: { kind: 'note', id: 'x' } }],
    ['add_todo', { text: '没传项目' }],
  ]) {
    const res = await tool(name, args);
    assert.equal(res.ok, false);
    assert.equal(res.errorCode, 'UNKNOWN_PROJECT');
    assert.match(res.message, /list_projects/);
  }
  assert.deepEqual(await fsp.readdir(outside), []);
});

test('项目从 Cindy 移除后立即不能再写，不依赖之前的缓存', async () => {
  const dir = await project('临时');
  assert.equal((await tool('add_todo', { project: dir, text: '第一条' })).ok, true);
  registered = registered.filter((p) => p.id !== dir);
  const res = await tool('add_todo', { project: dir, text: '第二条' });
  assert.equal(res.errorCode, 'UNKNOWN_PROJECT');
  assert.equal(await read(dir, '.cindy/todos.md'), '- [ ] 第一条\n');
});

test('内容不合法时交失败卷并说明原因，不写文件', async () => {
  const dir = await project('看板');
  const res = await tool('add_todo', { project: dir, text: '   ' });
  assert.equal(res.ok, false);
  assert.equal(res.errorCode, 'TOOL_FAILED');
  assert.match(res.message, /1-500/);
  await assert.rejects(read(dir, '.cindy/todos.md'), { code: 'ENOENT' });
});

test('要撤销的条目已不存在或 item 不合法时报错，不改文件', async () => {
  const content = '- [ ] 重复\n- [ ] 重复\n';
  const dir = await project('看板', { '.cindy/todos.md': content });
  const gone = await tool('remove_item', { project: dir, item: { kind: 'todo', text: '没有这条' } });
  assert.equal(gone.errorCode, 'ITEM_NOT_FOUND');
  // 没有行号又有两条同样文字时不猜
  assert.equal((await tool('remove_item', { project: dir, item: { kind: 'todo', text: '重复' } })).errorCode, 'ITEM_NOT_FOUND');
  assert.equal((await tool('remove_item', { project: dir, item: { kind: 'other' } })).errorCode, 'INVALID_ITEM');
  assert.equal((await tool('remove_item', { project: dir })).errorCode, 'INVALID_ITEM');
  assert.equal(await read(dir, '.cindy/todos.md'), content);
});

test('写入成功后通知主视图刷新；只读和失败的调用不通知', async () => {
  const dir = await project('看板');
  events.length = 0;
  await tool('list_projects', {});
  await tool('add_todo', { project: dir, text: '  ' });
  assert.deepEqual(events, []);
  const added = await tool('add_todo', { project: dir, text: '新的' });
  assert.deepEqual(events, [{ type: 'event', name: 'board-changed', dropped: 0 }]);
  await tool('remove_item', { project: dir, item: added.result.item });
  assert.equal(events.length, 2);
});

test('propose_knowledge 只把知识放进候选区，并通知主视图刷新', async () => {
  const dir = await project('看板');
  events.length = 0;
  const res = await tool('propose_knowledge', { project: dir, kind: 'term', file: 'terms.md', text: '伙伴：常驻的 Agent', evidence: 'docs/product-rules' });
  assert.equal(res.ok, true);
  assert.equal(res.result.project, dir);
  assert.ok(res.result.id);
  assert.deepEqual(events, [{ type: 'event', name: 'board-changed', dropped: 0 }]);
  await assert.rejects(read(dir, '.cindy/project-knowledge/terms.md'), { code: 'ENOENT' });
});

test('propose_knowledge 不合规时把原因交给 Agent；未登记的目录拒绝', async () => {
  const dir = await project('看板');
  const bad = await tool('propose_knowledge', { project: dir, kind: 'term', file: 'TOC.md', text: '内容', evidence: '依据' });
  assert.equal(bad.errorCode, 'TOOL_FAILED');
  assert.match(bad.message, /file/);
  const outside = await tool('propose_knowledge', { project: '/not-registered', kind: 'term', file: 'a.md', text: '内容', evidence: '依据' });
  assert.equal(outside.errorCode, 'UNKNOWN_PROJECT');
});

test('ghost.json 声明的工具都有实现，手册目录存在', async () => {
  assert.deepEqual(manifest.tools.map((t) => t.name).sort(), ['add_note', 'add_todo', 'list_projects', 'propose_knowledge', 'remove_item']);
  for (const t of manifest.tools) {
    const res = await tool(t.name, { project: '/not-registered', item: { kind: 'note', id: 'x' } });
    assert.ok(res.ok || res.errorCode === 'UNKNOWN_PROJECT', `${t.name}: ${res.message}`);
  }
  for (const item of manifest.manual.items) {
    assert.ok(fs.statSync(path.join(PLUGIN, item.dir, 'MANUAL.md')).isFile());
  }
});
