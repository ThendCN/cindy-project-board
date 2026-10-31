'use strict';
// 项目看板 Node 工作进程的测试：像 Cindy 一样启动 node/worker.cjs，经 stdio 发 JSON-RPC 请求，
// 在临时目录里检查它对 .cindy/*.md、AGENTS.md、CLAUDE.md 的读写结果。
// 运行：node --test tests/
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const WORKER = path.join(__dirname, '..', 'project-board-plugin', 'node', 'worker.cjs');

let child;
let nextId = 1;
const waiting = new Map();

before(() => {
  child = spawn(process.execPath, [WORKER], { stdio: ['pipe', 'pipe', 'inherit'] });
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    waiting.get(msg.id)?.(msg);
    waiting.delete(msg.id);
  });
});
after(() => child.kill());

/** 发一条请求，返回完整的 JSON-RPC 回复。 */
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

async function project(files = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'project-board-test-'));
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), content);
  }
  return dir;
}
const read = (dir, rel) => fs.readFile(path.join(dir, rel), 'utf8');

const TODOS = '# 待办\n\n## 登录页\n- [ ] 修复错位\n- [x] 重构布局\n\n## 工程\n- [ ] 补截图\n';

test('snapshot 解析待办的分组、完成状态和行号', async () => {
  const dir = await project({ '.cindy/todos.md': TODOS });
  const snap = await call('project/snapshot', { dir });
  assert.deepEqual(snap.todos, [
    { line: 3, text: '修复错位', done: false, group: '登录页' },
    { line: 4, text: '重构布局', done: true, group: '登录页' },
    { line: 7, text: '补截图', done: false, group: '工程' },
  ]);
  assert.equal(snap.docs.intro, null);
  assert.equal(snap.git, null);
});

test('勾选只改那一行，保留 CRLF 换行和其它内容', async () => {
  const crlf = TODOS.replace(/\n/g, '\r\n');
  const dir = await project({ '.cindy/todos.md': crlf });
  await call('project/update-todo', { dir, line: 3, text: '修复错位', change: { done: true } });
  assert.equal(await read(dir, '.cindy/todos.md'), crlf.replace('- [ ] 修复错位', '- [x] 修复错位'));
});

test('AI 在上面插了一行导致行号变化时，按文字找到同一条待办', async () => {
  const dir = await project({ '.cindy/todos.md': TODOS.replace('## 登录页\n', '## 登录页\n- [ ] AI 新加的一条\n') });
  const res = await call('project/update-todo', { dir, line: 3, text: '修复错位', change: { done: true } });
  assert.equal(res.ok, true);
  assert.match(await read(dir, '.cindy/todos.md'), /- \[ \] AI 新加的一条\n- \[x\] 修复错位/);
});

test('行号变了且有两条同样文字的待办时不猜，返回 CHANGED 并且不改文件', async () => {
  const content = '- [ ] 新的一行\n- [ ] 重复\n- [ ] 重复\n';
  const dir = await project({ '.cindy/todos.md': content });
  const res = await call('project/update-todo', { dir, line: 0, text: '重复', change: { done: true } });
  assert.deepEqual(res, { ok: false, code: 'CHANGED' });
  assert.equal(await read(dir, '.cindy/todos.md'), content);
});

test('改文字会合并多余空白；删除最后一行（没有结尾换行）不留空行', async () => {
  const dir = await project({ '.cindy/todos.md': '- [ ] 第一条\n- [ ] 最后一条' });
  await call('project/update-todo', { dir, line: 0, text: '第一条', change: { text: '  改过的   第一条 ' } });
  await call('project/update-todo', { dir, line: 1, text: '最后一条', change: { remove: true } });
  assert.equal(await read(dir, '.cindy/todos.md'), '- [ ] 改过的 第一条');
});

test('几次勾选同时到达时依次写入，一个都不丢', async () => {
  const lines = Array.from({ length: 8 }, (_, i) => `- [ ] 第 ${i} 条`);
  const dir = await project({ '.cindy/todos.md': lines.join('\n') + '\n' });
  const results = await Promise.all(lines.map((_, i) =>
    call('project/update-todo', { dir, line: i, text: `第 ${i} 条`, change: { done: true } })));
  assert.ok(results.every((r) => r.ok));
  assert.equal(await read(dir, '.cindy/todos.md'), lines.map((l) => l.replace('[ ]', '[x]')).join('\n') + '\n');
});

test('新增待办：文件不存在时创建；文件末尾没有换行时先补换行', async () => {
  const empty = await project();
  await call('project/add-todo', { dir: empty, text: '第一条' });
  assert.equal(await read(empty, '.cindy/todos.md'), '- [ ] 第一条\n');

  const noEol = await project({ '.cindy/todos.md': '# 待办\r\n- [ ] 已有' });
  await call('project/add-todo', { dir: noEol, text: '新的' });
  assert.equal(await read(noEol, '.cindy/todos.md'), '# 待办\r\n- [ ] 已有\r\n- [ ] 新的\r\n');

  const res = await rpc('project/add-todo', { dir: empty, text: '   ' });
  assert.match(res.error.message, /1-500/);
});

test('保存项目介绍前核对文件是否被别处改过，改过就不覆盖', async () => {
  const dir = await project({ '.cindy/project.md': '旧介绍' });
  assert.deepEqual(await call('project/write-intro', { dir, content: '我的版本', expected: '我打开时看到的' }), { ok: false, code: 'CHANGED' });
  assert.equal(await read(dir, '.cindy/project.md'), '旧介绍');
  assert.deepEqual(await call('project/write-intro', { dir, content: '新介绍', expected: '旧介绍' }), { ok: true });
  assert.equal(await read(dir, '.cindy/project.md'), '新介绍');
});

test('加入资料入口：按语言写入 AGENTS.md、让 CLAUDE.md 导入它，重复执行不重复添加', async () => {
  const dir = await project({ 'AGENTS.md': '# 规范\n' });
  assert.deepEqual(await call('project/add-entry', { dir, lang: 'ja' }), { agents: 'added', claude: 'created' });
  const agents = await read(dir, 'AGENTS.md');
  assert.ok(agents.startsWith('# 规范\n\n## プロジェクト資料\n\n- プロジェクト紹介：`.cindy/project.md`\n'), agents);
  assert.equal(await read(dir, 'CLAUDE.md'), '@AGENTS.md\n');
  assert.deepEqual(await call('project/add-entry', { dir, lang: 'ja' }), { agents: 'exists', claude: 'exists' });
  assert.equal(await read(dir, 'AGENTS.md'), agents);
});

test('CLAUDE.md 是指向 AGENTS.md 的软链接时，只写一次，并且保留软链接', async () => {
  const dir = await project({ 'AGENTS.md': '# 规范\n' });
  await fs.symlink('AGENTS.md', path.join(dir, 'CLAUDE.md'));
  assert.deepEqual(await call('project/add-entry', { dir, lang: 'zh-CN' }), { agents: 'added', claude: 'exists' });
  assert.ok((await fs.lstat(path.join(dir, 'CLAUDE.md'))).isSymbolicLink());
  assert.equal((await read(dir, 'AGENTS.md')).match(/## 项目资料/g).length, 1);
});

test('总览摘要：统计未完成 / 已完成待办，不是 Git 仓库时 git 为 null', async () => {
  const dir = await project({ '.cindy/todos.md': TODOS });
  assert.deepEqual(await call('project/summary', { dir }), { openTodos: 2, doneTodos: 1, git: null });
});

test('拒绝相对路径和未知方法', async () => {
  assert.equal((await rpc('project/snapshot', { dir: 'relative/path' })).error.code, -32602);
  assert.equal((await rpc('project/unknown', { dir: '/tmp' })).error.code, -32601);
});
