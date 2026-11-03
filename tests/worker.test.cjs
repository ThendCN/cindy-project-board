'use strict';
// 项目看板 Node 工作进程的测试：像 Cindy 一样启动 node/worker.cjs，经 stdio 发 JSON-RPC 请求，
// 在临时目录里检查它对 .cindy/*.md、AGENTS.md、CLAUDE.md 的读写结果。
// 运行：node --test tests/*.test.cjs
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

test('新增待办放在第一个分组之前，不落进任何分组，并交回它的行号', async () => {
  const dir = await project({ '.cindy/todos.md': TODOS });
  const first = await call('project/add-todo', { dir, text: '新的一条' });
  assert.deepEqual(first.item, { line: 2, text: '新的一条' });
  assert.deepEqual(first.todos[0], { line: 2, text: '新的一条', done: false, group: '' });
  assert.equal(await read(dir, '.cindy/todos.md'), TODOS.replace('## 登录页', '- [ ] 新的一条\n\n## 登录页'));

  const second = await call('project/add-todo', { dir, text: '再来一条' });
  assert.deepEqual(second.item, { line: 3, text: '再来一条' });
  assert.equal(await read(dir, '.cindy/todos.md'), TODOS.replace('## 登录页', '- [ ] 新的一条\n- [ ] 再来一条\n\n## 登录页'));
  assert.equal(second.todos.find((t) => t.text === '补截图').group, '工程');
});

test('新增待办：文件以分组开头、标题后没有空行、CRLF 换行时位置都正确', async () => {
  const noTitle = await project({ '.cindy/todos.md': '## 工程\n- [ ] 已有\n' });
  assert.equal((await call('project/add-todo', { dir: noTitle, text: '新的' })).item.line, 0);
  assert.equal(await read(noTitle, '.cindy/todos.md'), '- [ ] 新的\n\n## 工程\n- [ ] 已有\n');

  const tight = await project({ '.cindy/todos.md': '# 待办\n## 工程\n' });
  assert.equal((await call('project/add-todo', { dir: tight, text: '新的' })).item.line, 2);
  assert.equal(await read(tight, '.cindy/todos.md'), '# 待办\n\n- [ ] 新的\n\n## 工程\n');

  const crlf = TODOS.replace(/\n/g, '\r\n');
  const windows = await project({ '.cindy/todos.md': crlf });
  await call('project/add-todo', { dir: windows, text: '新的' });
  assert.equal(await read(windows, '.cindy/todos.md'), crlf.replace('## 登录页', '- [ ] 新的\r\n\r\n## 登录页'));
});

test('文件开头的一级标题是文档标题，不算分组；后面的一级标题仍算', async () => {
  const dir = await project({ '.cindy/todos.md': '\n# 待办\n- [ ] 甲\n# 工程\n- [ ] 乙\n' });
  const { todos } = await call('project/snapshot', { dir });
  assert.deepEqual(todos.map((t) => t.group), ['', '工程']);
});

test('删除待办后两边都是空行时只留一个空行', async () => {
  const dir = await project({ '.cindy/todos.md': TODOS });
  const { item } = await call('project/add-todo', { dir, text: '新的' });
  await call('project/update-todo', { dir, ...item, change: { remove: true } });
  assert.equal(await read(dir, '.cindy/todos.md'), TODOS);
});

test('保存项目介绍前核对文件是否被别处改过，改过就不覆盖', async () => {
  const dir = await project({ '.cindy/project.md': '旧介绍' });
  assert.deepEqual(await call('project/write-doc', { dir, id: 'intro', content: '我的版本', expected: '我打开时看到的' }), { ok: false, code: 'CHANGED' });
  assert.equal(await read(dir, '.cindy/project.md'), '旧介绍');
  assert.deepEqual(await call('project/write-doc', { dir, id: 'intro', content: '新介绍', expected: '旧介绍' }), { ok: true });
  assert.equal(await read(dir, '.cindy/project.md'), '新介绍');
});

test('保存配置文件：README / AGENTS.md / CLAUDE.md 可改，软链接写到真实文件，其他文档不能经这里改', async () => {
  const dir = await project({ 'AGENTS.md': '# 旧\n', 'README.md': '' });
  await fs.symlink('AGENTS.md', path.join(dir, 'CLAUDE.md'));
  assert.deepEqual(await call('project/write-doc', { dir, id: 'claude', content: '# 新\n', expected: '# 旧\n' }), { ok: true });
  assert.equal(await read(dir, 'AGENTS.md'), '# 新\n');
  assert.ok((await fs.lstat(path.join(dir, 'CLAUDE.md'))).isSymbolicLink());
  assert.deepEqual(await call('project/write-doc', { dir, id: 'readme', content: '说明', expected: '' }), { ok: true });
  assert.equal(await read(dir, 'README.md'), '说明');
  for (const id of ['todos', 'notes', 'paths', undefined]) {
    assert.match((await rpc('project/write-doc', { dir, id, content: 'x', expected: '' })).error.message, /cannot be edited/);
  }
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
  assert.deepEqual(await call('project/summary', { dir }), { openTodos: 2, doneTodos: 1, candidates: 0, git: null });
});

test('项目简介：只取 project.md 开头一段并合并空白，没有文件时为 null', async () => {
  const dir = await project({ '.cindy/project.md': `# 标题\n\n**定位**：${'长'.repeat(500)}` });
  const { intro } = await call('project/brief', { dir });
  assert.ok(intro.startsWith('# 标题 **定位**：长'), intro);
  assert.equal(intro.length, 240);
  assert.deepEqual(await call('project/brief', { dir: await project() }), { intro: null });
});

const NOTES = '.cindy/project-knowledge/notes.md';

test('新增资料：文件不存在时创建，多行内容原样保留，后续条目与前文空一行', async () => {
  const dir = await project();
  const first = await call('project/add-note', { dir, text: '  第一行\r\n\r\n第三行  ' });
  assert.match(first.id, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} #[0-9a-f]{6}$/);
  assert.equal(await read(dir, NOTES), `## ${first.id}\n\n第一行\n\n第三行\n`);
  const second = await call('project/add-note', { dir, text: '第二条' });
  assert.notEqual(second.id, first.id);
  assert.equal(await read(dir, NOTES), `## ${first.id}\n\n第一行\n\n第三行\n\n## ${second.id}\n\n第二条\n`);
});

test('新增资料时沿用文件的 CRLF 换行；空内容和超长内容被拒绝且不写文件', async () => {
  const dir = await project({ [NOTES]: '# 资料\r\n' });
  const { id } = await call('project/add-note', { dir, text: '甲\n乙' });
  assert.equal(await read(dir, NOTES), `# 资料\r\n\r\n## ${id}\r\n\r\n甲\r\n乙\r\n`);

  const empty = await project();
  assert.match((await rpc('project/add-note', { dir: empty, text: '  \n ' })).error.message, /1-10000/);
  assert.match((await rpc('project/add-note', { dir: empty, text: '长'.repeat(10001) })).error.message, /1-10000/);
  await assert.rejects(read(empty, NOTES), { code: 'ENOENT' });
});

test('删除资料：只删对应条目，删掉最后一条后文件回到之前的内容', async () => {
  const dir = await project();
  const a = await call('project/add-note', { dir, text: '甲' });
  const afterA = await read(dir, NOTES);
  const b = await call('project/add-note', { dir, text: '乙' });
  const c = await call('project/add-note', { dir, text: '丙' });

  assert.deepEqual(await call('project/remove-note', { dir, id: b.id }), { ok: true });
  assert.equal(await read(dir, NOTES), `## ${a.id}\n\n甲\n\n## ${c.id}\n\n丙\n`);
  await call('project/remove-note', { dir, id: c.id });
  assert.equal(await read(dir, NOTES), afterA);
});

test('删除不存在的资料返回 CHANGED，不改文件', async () => {
  const dir = await project({ [NOTES]: '# 资料\n' });
  assert.deepEqual(await call('project/remove-note', { dir, id: '2000-01-01 00:00 #000000' }), { ok: false, code: 'CHANGED' });
  assert.equal(await read(dir, NOTES), '# 资料\n');
  assert.deepEqual(await call('project/remove-note', { dir: await project(), id: 'x' }), { ok: false, code: 'CHANGED' });
});

test('snapshot 带上收集的资料：原文可查看，条目按最新在前拆开，多行与 CRLF 都能解析', async () => {
  const dir = await project({ [NOTES]: '# 资料\r\n' });
  const a = await call('project/add-note', { dir, text: '灵感' });
  const b = await call('project/add-note', { dir, text: '第一行\n\n第三行' });
  const snap = await call('project/snapshot', { dir });
  assert.equal(snap.paths.notes, NOTES);
  assert.match(snap.docs.notes.content, /灵感/);
  assert.deepEqual(snap.notes, [
    { id: b.id, at: b.id.slice(0, 16), text: '第一行\n\n第三行' },
    { id: a.id, at: a.id.slice(0, 16), text: '灵感' },
  ]);
  assert.deepEqual((await call('project/snapshot', { dir: await project() })).notes, []);
});

const KNOWLEDGE = '.cindy/project-knowledge';

test('snapshot 列出资料库文件：TOC.md 排最前，Markdown 标题取一级标题，带类型和大小，不含 notes.md、子目录和隐藏文件', async () => {
  const files = {
    [`${KNOWLEDGE}/modules.md`]: '## 二级标题\n\n# 模块边界\n',
    [`${KNOWLEDGE}/TOC.md`]: '# 项目知识索引\r\n- modules.md\r\n',
    [`${KNOWLEDGE}/caveats.md`]: '没有标题的正文\n',
    [`${KNOWLEDGE}/notes.md`]: '## 2026-01-01 00:00 #abcdef\n\n灵感\n',
    [`${KNOWLEDGE}/.draft.md`]: '# 草稿\n',
    [`${KNOWLEDGE}/readme.txt`]: 'x',
    [`${KNOWLEDGE}/sub/deep.md`]: '# 深层\n',
  };
  const dir = await project(files);
  const size = (name) => Buffer.byteLength(files[`${KNOWLEDGE}/${name}`]);
  const snap = await call('project/snapshot', { dir });
  assert.equal(snap.paths.knowledge, KNOWLEDGE);
  assert.deepEqual(snap.knowledge.map(({ name, kind, title, size }) => ({ name, kind, title, size })), [
    { name: 'TOC.md', kind: 'md', title: '项目知识索引', size: size('TOC.md') },
    { name: 'caveats.md', kind: 'md', title: null, size: size('caveats.md') },
    { name: 'modules.md', kind: 'md', title: '模块边界', size: size('modules.md') },
    { name: 'readme.txt', kind: 'text', title: null, size: size('readme.txt') },
  ]);
  assert.ok(snap.knowledge.every((doc) => typeof doc.mtimeMs === 'number'));
  assert.deepEqual((await call('project/snapshot', { dir: await project() })).knowledge, []);
});

test('read-knowledge 读取知识文档；路径穿越、子目录、隐藏文件和不存在的文件都被拒绝', async () => {
  const dir = await project({ [`${KNOWLEDGE}/TOC.md`]: '# 索引\n', [`${KNOWLEDGE}/sub/deep.md`]: 'x', '.cindy/project.md': '# 介绍\n' });
  assert.equal((await call('project/read-knowledge', { dir, name: 'TOC.md' })).content, '# 索引\n');
  for (const name of ['../project.md', 'sub/deep.md', '.draft.md', 'missing.md', 'TOC.txt', '', 42]) {
    assert.ok((await rpc('project/read-knowledge', { dir, name })).error, `should reject ${JSON.stringify(name)}`);
  }
});

test('拒绝相对路径和未知方法', async () => {
  assert.equal((await rpc('project/snapshot', { dir: 'relative/path' })).error.code, -32602);
  assert.equal((await rpc('project/unknown', { dir: '/tmp' })).error.code, -32601);
});

// ---------- 资料库文件：上传、删除、预览 ----------

/** 像看板一样分块上传，返回保存后的文件名。 */
async function upload(dir, name, content, chunk = 4) {
  const bytes = Buffer.from(content);
  const { uploadId } = await call('project/upload-begin', { dir, name, size: bytes.length });
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    await call('project/upload-chunk', { dir, uploadId, offset, data: bytes.subarray(offset, offset + chunk).toString('base64') });
  }
  return (await call('project/upload-finish', { dir, uploadId })).name;
}

test('上传文件：分块写入、重发同一块不写重、同名加序号、不留临时文件', async () => {
  const dir = await project({ [`${KNOWLEDGE}/报告.pdf`]: 'old' });
  assert.equal(await upload(dir, '报告.pdf', '%PDF-新内容'), '报告 (2).pdf');
  assert.equal(await read(dir, `${KNOWLEDGE}/报告 (2).pdf`), '%PDF-新内容');
  assert.equal(await read(dir, `${KNOWLEDGE}/报告.pdf`), 'old');

  const { uploadId } = await call('project/upload-begin', { dir, name: 'a.txt', size: 6 });
  const chunk = { dir, uploadId, offset: 0, data: Buffer.from('abc').toString('base64') };
  await call('project/upload-chunk', chunk);
  await call('project/upload-chunk', chunk);
  assert.match((await rpc('project/upload-finish', { dir, uploadId })).error.message, /incomplete/);
  await call('project/upload-chunk', { ...chunk, offset: 3, data: Buffer.from('def').toString('base64') });
  assert.deepEqual(await call('project/upload-finish', { dir, uploadId }), { ok: true, name: 'a.txt' });
  assert.equal(await read(dir, `${KNOWLEDGE}/a.txt`), 'abcdef');
  assert.deepEqual((await fs.readdir(path.join(dir, KNOWLEDGE))).filter((n) => n.startsWith('.')), []);
});

test('上传文件名去掉路径和开头的点，notes.md 留给收集的资料；超大、越界和别的项目的上传都被拒绝', async () => {
  const dir = await project();
  assert.equal(await upload(dir, '../../etc/passwd', 'x'), 'passwd');
  assert.equal(await upload(dir, 'C:\\Users\\.secret.txt', 'x'), 'secret.txt');
  assert.equal(await upload(dir, 'notes.md', '# 上传的'), 'notes (2).md');
  await assert.rejects(read(dir, `${KNOWLEDGE}/notes.md`), { code: 'ENOENT' });

  assert.match((await rpc('project/upload-begin', { dir, name: 'big.bin', size: 50 * 1024 * 1024 + 1 })).error.message, /at most/);
  assert.match((await rpc('project/upload-begin', { dir, name: '...', size: 1 })).error.message, /1-200/);
  const { uploadId } = await call('project/upload-begin', { dir, name: 'b.txt', size: 2 });
  assert.match((await rpc('project/upload-chunk', { dir, uploadId, offset: 1, data: Buffer.from('xy').toString('base64') })).error.message, /outside/);
  assert.match((await rpc('project/upload-chunk', { dir: await project(), uploadId, offset: 0, data: '' })).error.message, /not found/);
  assert.deepEqual(await call('project/upload-abort', { dir, uploadId }), { ok: true });
  assert.deepEqual((await fs.readdir(path.join(dir, KNOWLEDGE))).filter((n) => n.startsWith('.')), []);
});

test('删除资料库文件；notes.md、子目录、软链接和路径穿越都不能经这里删', async () => {
  const dir = await project({ [`${KNOWLEDGE}/a.png`]: 'png', [`${KNOWLEDGE}/notes.md`]: 'n', [`${KNOWLEDGE}/sub/x.md`]: 'x', '.cindy/project.md': 'p' });
  await fs.symlink('../project.md', path.join(dir, KNOWLEDGE, 'link.md'));
  assert.deepEqual(await call('project/remove-file', { dir, name: 'a.png' }), { ok: true });
  await assert.rejects(read(dir, `${KNOWLEDGE}/a.png`), { code: 'ENOENT' });
  for (const name of ['notes.md', 'sub', 'sub/x.md', 'link.md', '../project.md', 'missing.png']) {
    assert.ok((await rpc('project/remove-file', { dir, name })).error, `should reject ${name}`);
  }
  assert.equal(await read(dir, '.cindy/project.md'), 'p');
  assert.equal(await read(dir, `${KNOWLEDGE}/notes.md`), 'n');
});

/** 按 127.0.0.1 访问预览地址；host 用来模拟别的域名指向本机。 */
function fetchLocal(url, host) {
  const { port, pathname } = new URL(url);
  return new Promise((resolve, reject) => {
    require('node:http').get({ host: '127.0.0.1', port, path: pathname, headers: host ? { host } : {} }, (res) => {
      const parts = [];
      res.on('data', (d) => parts.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts).toString() }));
    }).on('error', reject);
  });
}

test('预览地址：只在 127.0.0.1 提供本次授权的文件，非 PDF 放进沙箱，docx 等不能预览', async () => {
  const dir = await project({ [`${KNOWLEDGE}/图.svg`]: '<svg xmlns="http://www.w3.org/2000/svg"/>', [`${KNOWLEDGE}/a.pdf`]: '%PDF', [`${KNOWLEDGE}/b.docx`]: 'zip' });
  const svg = await call('project/file-url', { dir, name: '图.svg' });
  assert.equal(svg.kind, 'image');
  assert.match(svg.url, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/view$/);
  const page = await fetchLocal(svg.url);
  assert.equal(page.status, 200);
  assert.match(page.headers['content-security-policy'], /sandbox/);
  const raw = await fetchLocal(page.body.match(/src="([^"]+)"/)[1].replace(/^/, svg.url.replace(/\/[0-9a-f]{32}\/view$/, '')));
  assert.equal(raw.headers['content-type'], 'image/svg+xml');
  assert.match(raw.headers['content-security-policy'], /sandbox/);
  assert.match(raw.body, /<svg/);

  const pdf = await fetchLocal((await call('project/file-url', { dir, name: 'a.pdf' })).url);
  assert.equal(pdf.headers['content-type'], 'application/pdf');
  assert.equal(pdf.headers['content-security-policy'], undefined);

  assert.equal((await fetchLocal(svg.url, 'evil.example:80')).status, 404);
  assert.equal((await fetchLocal(svg.url.replace(/\/[0-9a-f]{32}\//, `/${'0'.repeat(32)}/`))).status, 404);
  assert.match((await rpc('project/file-url', { dir, name: 'b.docx' })).error.message, /cannot be previewed/);
  assert.ok((await rpc('project/file-url', { dir, name: '../project.md' })).error);
});

test('用系统应用打开：文件名不合法或不存在时报错，不启动任何程序', async () => {
  const dir = await project();
  for (const name of ['../x.docx', 'missing.docx', 'notes.md', '']) {
    assert.ok((await rpc('project/open-file', { dir, name })).error, `should reject ${name}`);
  }
});

// ---------- 知识候选 ----------
const CANDIDATES = '.cindy/.knowledge-candidates/candidates.json';
const ARCH = { kind: 'architecture', file: 'arch.md', text: '写操作在 Node 进程里串行执行。', evidence: 'node/worker.cjs 的 serialized' };
const propose = (dir, fields) => call('project/propose-knowledge', { dir, ...ARCH, ...fields });
const pending = async (dir) => (await call('project/snapshot', { dir })).candidates;

test('提交候选：只进候选区、不碰知识库，目录自带 .gitignore，重复提交不多出一条', async () => {
  const dir = await project();
  const { id } = await propose(dir);
  assert.equal((await propose(dir)).id, id);
  const list = await pending(dir);
  assert.equal(list.length, 1);
  assert.deepEqual({ ...list[0], id: undefined, at: undefined }, { ...ARCH, replaces: null, id: undefined, at: undefined });
  assert.equal((await read(dir, '.cindy/.knowledge-candidates/.gitignore')).trim(), '*');
  await assert.rejects(fs.stat(path.join(dir, '.cindy/project-knowledge')), { code: 'ENOENT' });
  assert.equal((await call('project/summary', { dir })).candidates, 1);
});

test('不合规的候选被拒绝且不留记录', async () => {
  const dir = await project({ '.cindy/project-knowledge/arch.md': '旧说法\n旧说法\n' });
  for (const fields of [
    { kind: 'other' },
    { text: '   ' },
    { evidence: '  ' },
    { file: '../x.md' },
    { file: 'a/b.md' },
    { file: 'a b.md' },
    { file: 'x.txt' },
    { file: 'notes.md' },
    { file: 'TOC.md' },
    { file: '.hidden.md' },
    { replaces: '旧说法' }, // 只有修正才能替换原文
    { kind: 'correction' }, // 修正必须给出原文
    { kind: 'correction', replaces: '没有这段' },
    { kind: 'correction', replaces: '旧说法' }, // 出现两次，不猜
    { kind: 'correction', file: 'missing.md', replaces: '旧说法' },
  ]) {
    assert.ok((await rpc('project/propose-knowledge', { dir, ...ARCH, ...fields })).error, JSON.stringify(fields));
  }
  assert.deepEqual(await pending(dir), []);
});

test('候选文件是软链接时拒绝，不写到项目外', async () => {
  const outside = await project({ 'secret.md': '外面的文件\n' });
  const dir = await project({ '.cindy/project-knowledge/keep.md': '' });
  await fs.symlink(path.join(outside, 'secret.md'), path.join(dir, '.cindy/project-knowledge/link.md'));
  assert.ok((await rpc('project/propose-knowledge', { dir, ...ARCH, file: 'link.md' })).error);
  assert.equal(await read(outside, 'secret.md'), '外面的文件\n');
});

test('确认写入新文件：建好 TOC.md 让新任务能找到，候选随之消失', async () => {
  const dir = await project();
  const { id } = await propose(dir, { text: '# 架构\n\n写操作串行。' });
  assert.deepEqual(await call('project/accept-candidate', { dir, id }), { ok: true, file: 'arch.md' });
  assert.equal(await read(dir, '.cindy/project-knowledge/arch.md'), '# 架构\n\n写操作串行。\n');
  assert.equal(await read(dir, '.cindy/project-knowledge/TOC.md'), '# TOC\n\n- [arch.md](arch.md) - 架构\n');
  assert.deepEqual(await pending(dir), []);
});

test('确认写入已有文件：追加到末尾，沿用 CRLF，TOC 已列出时不重复；用户改过的文字优先', async () => {
  const toc = '| 文件 |\n| .cindy/project-knowledge/arch.md |\n| my-arch.md |\n';
  const dir = await project({ '.cindy/project-knowledge/arch.md': '# 架构\r\n', '.cindy/project-knowledge/TOC.md': toc });
  const { id } = await propose(dir, { text: 'AI 写的\n第二行' });
  await call('project/accept-candidate', { dir, id, text: '我改过的\n第二行' });
  assert.equal(await read(dir, '.cindy/project-knowledge/arch.md'), '# 架构\r\n\r\n我改过的\r\n第二行\r\n');
  assert.equal(await read(dir, '.cindy/project-knowledge/TOC.md'), toc);
});

test('文件名只是 TOC 里别的文件名的一部分时，仍然补上索引', async () => {
  const dir = await project({ '.cindy/project-knowledge/TOC.md': '# TOC\n\n- [my-arch.md](my-arch.md)\n' });
  const { id } = await propose(dir);
  await call('project/accept-candidate', { dir, id });
  assert.equal(await read(dir, '.cindy/project-knowledge/TOC.md'), '# TOC\n\n- [my-arch.md](my-arch.md)\n- [arch.md](arch.md)\n');
});

test('确认修正：只替换那段原文；原文写法含特殊字符也不走样', async () => {
  const dir = await project({ '.cindy/project-knowledge/arch.md': '# 架构\r\n旧\r\n说法\r\n末尾\r\n' });
  const { id } = await propose(dir, { kind: 'correction', replaces: '旧\n说法', text: '新$&说法' });
  await call('project/accept-candidate', { dir, id });
  assert.equal(await read(dir, '.cindy/project-knowledge/arch.md'), '# 架构\r\n新$&说法\r\n末尾\r\n');
});

test('提交后原文被改掉时，确认返回 STALE，文件和候选都不动', async () => {
  const dir = await project({ '.cindy/project-knowledge/arch.md': '旧说法\n' });
  const { id } = await propose(dir, { kind: 'correction', replaces: '旧说法', text: '新说法' });
  await fs.writeFile(path.join(dir, '.cindy/project-knowledge/arch.md'), '别人改过了\n');
  assert.deepEqual(await call('project/accept-candidate', { dir, id }), { ok: false, code: 'STALE' });
  assert.equal(await read(dir, '.cindy/project-knowledge/arch.md'), '别人改过了\n');
  assert.equal((await pending(dir)).length, 1);
});

test('忽略候选不碰知识库；已不存在的候选返回 CHANGED', async () => {
  const dir = await project();
  const { id } = await propose(dir);
  assert.deepEqual(await call('project/reject-candidate', { dir, id }), { ok: true });
  assert.deepEqual(await pending(dir), []);
  await assert.rejects(fs.stat(path.join(dir, '.cindy/project-knowledge')), { code: 'ENOENT' });
  assert.deepEqual(await call('project/reject-candidate', { dir, id }), { ok: false, code: 'CHANGED' });
  assert.deepEqual(await call('project/accept-candidate', { dir, id }), { ok: false, code: 'CHANGED' });
});

test('候选文件损坏时看板照常显示，下一次提交重新开始', async () => {
  const dir = await project({ [CANDIDATES]: '{坏了', '.cindy/todos.md': TODOS });
  const snap = await call('project/snapshot', { dir });
  assert.deepEqual(snap.candidates, []);
  assert.equal(snap.todos.length, 3);
  await propose(dir);
  assert.equal((await pending(dir)).length, 1);
});
