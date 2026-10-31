'use strict';
// 项目看板 Node 工作进程：读项目资料与 Git 状态，按用户操作改写 .cindy/project.md 与 .cindy/todos.md。
// 项目目录由 main.js 校验（必须是 Cindy 已登记的项目）后传入。
const fs = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');
const { execFile } = require('node:child_process');

const DOCS = {
  intro: '.cindy/project.md',
  todos: '.cindy/todos.md',
  readme: 'README.md',
  agents: 'AGENTS.md',
  claude: 'CLAUDE.md',
  knowledge: '.cindy/project-knowledge/TOC.md',
};
const MAX_BYTES = 100 * 1024;
const TODO_LINE = /^(\s*[-*+]\s+\[)([ xX])(\]\s+)(.*\S)\s*$/;
const HEADING = /^#{1,6}\s+(.*\S)\s*$/;

function reply(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

async function readDoc(dir, rel) {
  const file = path.join(dir, rel);
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return null;
    const handle = await fs.open(file, 'r');
    try {
      const size = Math.min(stat.size, MAX_BYTES);
      const buffer = Buffer.alloc(size);
      await handle.read(buffer, 0, size, 0);
      return { content: buffer.toString('utf8'), truncated: stat.size > MAX_BYTES, mtimeMs: stat.mtimeMs };
    } finally {
      await handle.close();
    }
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
}

/** 勾选清单条目带行号；行号用于勾选时定位，改写前会重新核对。 */
function parseTodos(markdown) {
  const items = [];
  let group = '';
  markdown.split(/\r?\n/).forEach((line, index) => {
    const heading = HEADING.exec(line);
    if (heading) {
      group = heading[1];
      return;
    }
    const todo = TODO_LINE.exec(line);
    if (todo) items.push({ line: index, text: todo[4], done: todo[2] !== ' ', group });
  });
  return items;
}

function git(dir, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: dir, timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true },
      (err, stdout) => resolve(err ? null : stdout.trim()));
  });
}

async function gitStatus(dir) {
  if ((await git(dir, ['rev-parse', '--is-inside-work-tree'])) !== 'true') return null;
  const [branch, porcelain, log, worktrees] = await Promise.all([
    git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(dir, ['status', '--porcelain=v1']),
    git(dir, ['log', '-5', '--format=%h%x09%cs%x09%s']),
    git(dir, ['worktree', 'list', '--porcelain']),
  ]);
  const commits = (log ?? '').split('\n').filter(Boolean).map((row) => {
    const [hash, date, ...subject] = row.split('\t');
    return { hash, date, subject: subject.join('\t') };
  });
  const worktreeList = (worktrees ?? '').split('\n\n').filter(Boolean).map((block) => {
    const lines = block.split('\n');
    const branchLine = lines.find((l) => l.startsWith('branch '));
    return {
      path: lines[0].replace(/^worktree /, ''),
      branch: branchLine ? branchLine.replace(/^branch refs\/heads\//, '') : '(detached)',
    };
  });
  let cindyWorktreesUnignored = false;
  try {
    await fs.stat(path.join(dir, '.cindy-worktrees'));
    cindyWorktreesUnignored = (await git(dir, ['check-ignore', '-q', '.cindy-worktrees'])) === null;
  } catch {
    // 没有 .cindy-worktrees 目录
  }
  return {
    branch,
    changedFiles: porcelain ? porcelain.split('\n').length : 0,
    commits,
    worktrees: worktreeList,
    cindyWorktreesUnignored,
  };
}

async function snapshot({ dir }) {
  const entries = await Promise.all(Object.entries(DOCS).map(async ([id, rel]) => [id, await readDoc(dir, rel)]));
  const docs = Object.fromEntries(entries);
  return {
    docs,
    paths: DOCS,
    todos: docs.todos ? parseTodos(docs.todos.content) : [],
    git: await gitStatus(dir),
  };
}

// 先写临时文件再改名：AI 同时读这个文件时不会读到写了一半的内容。
async function writeAtomic(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, file);
}

async function readOrEmpty(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }
}

function todoText(value) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (!text || text.length > 500) throw new Error('to-do text must be 1-500 characters');
  return text;
}

/**
 * 修改一条待办：change 为 {done} 勾选、{text} 改文字或 {remove:true} 删除。
 * AI 可能同时改写这个文件，所以重新读取并核对：
 * 原行号上仍是同一条待办才改；否则在全文里找唯一一条同文本待办；找不到或不唯一就报 CHANGED。
 */
async function updateTodo({ dir, line, text, change }) {
  const file = path.join(dir, DOCS.todos);
  // 保留每行原有的换行符，避免改一行就让整份文件在 git 里出现 diff。
  const parts = (await fs.readFile(file, 'utf8')).split(/(\r?\n)/);
  const lines = parts.filter((_, i) => i % 2 === 0);
  const sameTodo = (index) => {
    const match = TODO_LINE.exec(lines[index] ?? '');
    return match && match[4] === text;
  };
  let target = sameTodo(line) ? line : -1;
  if (target < 0) {
    const candidates = lines.map((_, i) => i).filter(sameTodo);
    if (candidates.length !== 1) return { ok: false, code: 'CHANGED' };
    target = candidates[0];
  }
  if (change?.remove === true) {
    // 连同这一行的换行符一起删；最后一行没有换行符时删掉前一个换行符。
    if (target * 2 + 1 < parts.length) parts.splice(target * 2, 2);
    else parts.splice(Math.max(target * 2 - 1, 0), 2);
  } else {
    const nextText = change?.text === undefined ? null : todoText(change.text);
    parts[target * 2] = lines[target].replace(TODO_LINE, (_, a, mark, b, rest) =>
      `${a}${typeof change?.done === 'boolean' ? (change.done ? 'x' : ' ') : mark}${b}${nextText ?? rest}`);
  }
  const content = parts.join('');
  await writeAtomic(file, content);
  return { ok: true, todos: parseTodos(content) };
}

/** 在待办文件末尾追加一条未完成待办；文件不存在时创建。 */
async function addTodo({ dir, text }) {
  const file = path.join(dir, DOCS.todos);
  const content = await readOrEmpty(file);
  const eol = /\r\n/.test(content) ? '\r\n' : '\n';
  const prefix = content === '' || content.endsWith('\n') ? content : content + eol;
  const next = `${prefix}- [ ] ${todoText(text)}${eol}`;
  await writeAtomic(file, next);
  return { ok: true, todos: parseTodos(next) };
}

/** 保存项目介绍。expected 是页面打开编辑时读到的内容；文件已被别处改过就报 CHANGED，不覆盖。 */
async function writeIntro({ dir, content, expected }) {
  if (typeof content !== 'string' || typeof expected !== 'string') throw new Error('content and expected must be strings');
  const file = path.join(dir, DOCS.intro);
  if ((await readOrEmpty(file)) !== expected) return { ok: false, code: 'CHANGED' };
  await writeAtomic(file, content);
  return { ok: true };
}

// AGENTS.md 里的「项目资料」入口：Codex 读 AGENTS.md，Claude Code 读 CLAUDE.md（经 @AGENTS.md 导入）。
const ENTRY = {
  'zh-CN': ['## 项目资料', '', `- 项目介绍：\`${DOCS.intro}\``, `- 待办清单：\`${DOCS.todos}\`（完成一条就把该行的 \`- [ ]\` 改成 \`- [x]\`）`],
  en: ['## Project Notes', '', `- Project introduction: \`${DOCS.intro}\``, `- To-do list: \`${DOCS.todos}\` (change an item's \`- [ ]\` to \`- [x]\` when it is done)`],
};
const hasEntry = (content) => content.includes(DOCS.intro) && content.includes(DOCS.todos);
const importsAgents = (content) => /^\s*@AGENTS\.md\s*$/m.test(content);

// 在文件末尾追加几行，沿用文件原有的换行符，并与前文空一行。
function appendLines(content, lines) {
  const eol = /\r\n/.test(content) ? '\r\n' : '\n';
  const body = lines.join(eol) + eol;
  if (content === '') return body;
  const prefix = content.endsWith('\n') ? content : content + eol;
  return prefix + eol + body;
}

// CLAUDE.md / AGENTS.md 常是互相指向的软链接：写到链接指向的真实文件，不把链接替换成普通文件。
const realFile = (file) => fs.realpath(file).catch(() => file);

/** 在 AGENTS.md 加入项目资料入口，并确保 CLAUDE.md 导入 AGENTS.md；已有的不重复加。 */
async function addEntry({ dir, lang }) {
  const agentsFile = await realFile(path.join(dir, DOCS.agents));
  const agents = await readOrEmpty(agentsFile);
  let agentsResult = 'exists';
  if (!hasEntry(agents)) {
    await writeAtomic(agentsFile, appendLines(agents, ENTRY[lang] ?? ENTRY.en));
    agentsResult = agents === '' ? 'created' : 'added';
  }
  // 先写 AGENTS.md 再读 CLAUDE.md：两者是同一个文件（软链接）时，这里已能读到入口，不会重复写。
  const claudeFile = await realFile(path.join(dir, DOCS.claude));
  const claude = await readOrEmpty(claudeFile);
  let claudeResult = 'exists';
  if (!importsAgents(claude) && !hasEntry(claude)) {
    await writeAtomic(claudeFile, appendLines(claude, ['@AGENTS.md']));
    claudeResult = claude === '' ? 'created' : 'added';
  }
  return { agents: agentsResult, claude: claudeResult };
}

// 写操作串行执行：两次勾选几乎同时到达时，后一次必须读到前一次写入的结果。
let writeQueue = Promise.resolve();
function serialized(fn) {
  return (params) => {
    const run = writeQueue.then(() => fn(params));
    writeQueue = run.catch(() => {});
    return run;
  };
}

const METHODS = {
  'project/snapshot': snapshot,
  'project/update-todo': serialized(updateTodo),
  'project/add-todo': serialized(addTodo),
  'project/write-intro': serialized(writeIntro),
  'project/add-entry': serialized(addEntry),
};

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
  const dir = request.params?.dir;
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) {
    reply({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'dir must be an absolute path' } });
    return;
  }
  try {
    reply({ jsonrpc: '2.0', id: request.id, result: await method(request.params) });
  } catch (err) {
    reply({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: err.message } });
  }
});
