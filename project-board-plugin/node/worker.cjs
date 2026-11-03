'use strict';
// 项目看板 Node 工作进程：读项目资料与 Git 状态，按用户操作改写 .cindy/project.md、.cindy/todos.md 与收集的资料。
// 项目目录由 main.js 校验（必须是 Cindy 已登记的项目）后传入。
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const readline = require('node:readline');
const { execFile, spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');

const KNOWLEDGE_DIR = '.cindy/project-knowledge';
const DOCS = {
  intro: '.cindy/project.md',
  todos: '.cindy/todos.md',
  readme: 'README.md',
  agents: 'AGENTS.md',
  claude: 'CLAUDE.md',
  notes: `${KNOWLEDGE_DIR}/notes.md`,
};
// 资料库文件只认 project-knowledge/ 直接下面的文件名：不带路径、不以点开头（点开头的是隐藏文件和上传中的临时文件）。
// notes.md 单独按条解析，不算在文件清单里。
const FILE_NAME = /^[^./\\][^/\\\x00-\x1f]*$/;
const NOTES_NAME = 'notes.md';
const TOC_NAME = 'TOC.md';
// AI 提的知识候选先放这里，用户确认后才写进知识库。目录自带 .gitignore，没确认的内容不会随 git 提交。
const CANDIDATES_DIR = '.cindy/.knowledge-candidates';
const CANDIDATES_FILE = `${CANDIDATES_DIR}/candidates.json`;
const CANDIDATE_KINDS = new Set(['term', 'architecture', 'correction']);
// 候选的目标文件：不带空格和括号，才能直接写进 TOC.md 的链接。
const CANDIDATE_NAME = /^[^\s./\\()<>][^\s/\\()<>\x00-\x1f]*\.md$/i;
const MAX_UPLOAD = 50 * 1024 * 1024;
// 看板能在页面里预览的类型；其余（docx、xlsx 等）用系统应用打开。
const TYPES = {
  md: ['md', 'text/markdown; charset=utf-8'],
  png: ['image', 'image/png'], jpg: ['image', 'image/jpeg'], jpeg: ['image', 'image/jpeg'], gif: ['image', 'image/gif'],
  webp: ['image', 'image/webp'], svg: ['image', 'image/svg+xml'], bmp: ['image', 'image/bmp'], avif: ['image', 'image/avif'],
  pdf: ['pdf', 'application/pdf'],
  txt: ['text', 'text/plain; charset=utf-8'], csv: ['text', 'text/plain; charset=utf-8'], tsv: ['text', 'text/plain; charset=utf-8'],
  json: ['text', 'text/plain; charset=utf-8'], log: ['text', 'text/plain; charset=utf-8'], yaml: ['text', 'text/plain; charset=utf-8'],
  yml: ['text', 'text/plain; charset=utf-8'], xml: ['text', 'text/plain; charset=utf-8'],
  mp4: ['media', 'video/mp4'], webm: ['media', 'video/webm'], mp3: ['media', 'audio/mpeg'], wav: ['media', 'audio/wav'],
  ogg: ['media', 'audio/ogg'], m4a: ['media', 'audio/mp4'],
};
const typeOf = (name) => TYPES[path.extname(name).slice(1).toLowerCase()] ?? ['other', 'application/octet-stream'];
// 看板里可以编辑的文档：项目介绍和根目录的配置文件。
const EDITABLE = new Set(['intro', 'readme', 'agents', 'claude']);
const MAX_BYTES = 100 * 1024;
const BRIEF_CHARS = 240;
const TODO_LINE = /^(\s*[-*+]\s+\[)([ xX])(\]\s+)(.*\S)\s*$/;
const HEADING = /^#{1,6}\s+(.*\S)\s*$/;
// 每条资料的标题：时间加随机后缀，后缀让同一分钟内的两条也能分开撤销。
const NOTE_HEADING = /^## \d{4}-\d{2}-\d{2} \d{2}:\d{2} #[0-9a-f]{6}$/;

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

/** 总览卡片用的轻量摘要：只读待办计数与分支、未提交改动数。 */
async function summary({ dir }) {
  const todos = await readDoc(dir, DOCS.todos);
  const items = todos ? parseTodos(todos.content) : [];
  let repo = null;
  if ((await git(dir, ['rev-parse', '--is-inside-work-tree'])) === 'true') {
    const [branch, porcelain] = await Promise.all([
      git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
      git(dir, ['status', '--porcelain=v1']),
    ]);
    repo = { branch, changedFiles: porcelain ? porcelain.split('\n').length : 0 };
  }
  return { openTodos: items.filter((t) => !t.done).length, doneTodos: items.filter((t) => t.done).length, candidates: (await readCandidates(dir)).length, git: repo };
}

/** 判断消息归属用的项目简介：只读 project.md 开头一段，不跑 git，项目多时也快。 */
async function brief({ dir }) {
  const intro = await readDoc(dir, DOCS.intro);
  return { intro: intro ? intro.content.replace(/\s+/g, ' ').trim().slice(0, BRIEF_CHARS) : null };
}

/** 收集的资料按条拆开，最新的在前。每条的 id 是标题（时间 + 随机后缀），撤销和删除都用它。 */
function parseNotes(markdown) {
  const notes = [];
  for (const line of markdown.split(/\r?\n/)) {
    if (NOTE_HEADING.test(line.trimEnd())) notes.push({ id: line.trimEnd().slice(3), lines: [] });
    else notes.at(-1)?.lines.push(line);
  }
  return notes.map(({ id, lines }) => ({ id, at: id.slice(0, 16), text: lines.join('\n').trim() })).reverse();
}

/**
 * 资料库里的一个文件的绝对路径。只认 project-knowledge/ 直接下面的普通文件：
 * 文件名不合法、是 notes.md、是目录或软链接（可能指向项目外）都报错。
 */
async function knowledgeFile(dir, name) {
  if (typeof name !== 'string' || !FILE_NAME.test(name) || name === NOTES_NAME) throw new Error('name must be a file name inside project-knowledge');
  const file = path.join(dir, KNOWLEDGE_DIR, name);
  const stat = await fs.lstat(file).catch(() => null);
  if (!stat?.isFile()) throw new Error(`${name} not found`);
  return { file, stat };
}

const firstHeading = (markdown) => markdown.split(/\r?\n/).map((line) => /^#\s+(.*\S)\s*$/.exec(line)?.[1]).find(Boolean);

/** 资料库文件清单：TOC.md 排最前，其余按文件名；Markdown 的标题取第一个一级标题。 */
async function listKnowledge(dir) {
  const folder = path.join(dir, KNOWLEDGE_DIR);
  let entries;
  try {
    entries = await fs.readdir(folder, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return [];
    throw err;
  }
  const names = entries.filter((e) => e.isFile() && FILE_NAME.test(e.name) && e.name !== NOTES_NAME).map((e) => e.name);
  names.sort((a, b) => (a === 'TOC.md' ? -1 : b === 'TOC.md' ? 1 : a.localeCompare(b)));
  const files = await Promise.all(names.map(async (name) => {
    const [kind] = typeOf(name);
    const stat = await fs.stat(path.join(folder, name)).catch(() => null);
    if (!stat) return null;
    const doc = kind === 'md' ? await readDoc(dir, `${KNOWLEDGE_DIR}/${name}`) : null;
    const title = doc && firstHeading(doc.content);
    return { name, kind, title: title ?? null, size: stat.size, mtimeMs: stat.mtimeMs };
  }));
  return files.filter(Boolean);
}

/** 读一篇 Markdown 文档给看板查看。 */
async function readKnowledge({ dir, name }) {
  if (typeOf(String(name))[0] !== 'md') throw new Error('only Markdown files can be read as text');
  await knowledgeFile(dir, name);
  return readDoc(dir, `${KNOWLEDGE_DIR}/${name}`);
}

/** 删除资料库里的一个文件。 */
async function removeFile({ dir, name }) {
  const { file } = await knowledgeFile(dir, name);
  await fs.unlink(file);
  return { ok: true };
}

// ---------- 上传：看板分块发来文件内容（单次请求有大小上限），先写临时文件，收齐后改成正式文件名 ----------
const uploads = new Map(); // uploadId → { dir, tmp, name, size }

function uploadName(value) {
  const base = String(value ?? '').split(/[\\/]/).pop().replace(/[\x00-\x1f]/g, '').trim().replace(/^\.+/, '');
  if (!base || base.length > 200) throw new Error('file name must be 1-200 characters');
  return base;
}

/** 同名文件已存在时加序号：报告.pdf → 报告 (2).pdf。notes.md 留给收集的资料，上传的同名文件也加序号。 */
async function freeName(folder, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? name : `${stem} (${n})${ext}`;
    if (candidate === NOTES_NAME) continue;
    const taken = await fs.lstat(path.join(folder, candidate)).then(() => true, () => false);
    if (!taken) return candidate;
  }
}

async function uploadBegin({ dir, name, size }) {
  const finalName = uploadName(name);
  if (!Number.isInteger(size) || size < 0 || size > MAX_UPLOAD) throw new Error(`file size must be at most ${MAX_UPLOAD} bytes`);
  const folder = path.join(dir, KNOWLEDGE_DIR);
  await fs.mkdir(folder, { recursive: true });
  const uploadId = randomBytes(8).toString('hex');
  const tmp = path.join(folder, `.upload-${uploadId}.tmp`);
  await fs.writeFile(tmp, '');
  uploads.set(uploadId, { dir, tmp, name: finalName, size });
  return { uploadId };
}

function upload(dir, uploadId) {
  const entry = uploads.get(uploadId);
  if (!entry || entry.dir !== dir) throw new Error('upload not found');
  return entry;
}

/** 写入一块。按 offset 写，看板重发同一块也不会写重。 */
async function uploadChunk({ dir, uploadId, offset, data }) {
  const entry = upload(dir, uploadId);
  const bytes = Buffer.from(String(data ?? ''), 'base64');
  if (!Number.isInteger(offset) || offset < 0 || offset + bytes.length > entry.size) throw new Error('chunk is outside the file');
  const handle = await fs.open(entry.tmp, 'r+');
  try {
    await handle.write(bytes, 0, bytes.length, offset);
  } finally {
    await handle.close();
  }
  return { ok: true };
}

async function uploadFinish({ dir, uploadId }) {
  const entry = upload(dir, uploadId);
  if ((await fs.stat(entry.tmp)).size !== entry.size) throw new Error('upload is incomplete');
  const folder = path.dirname(entry.tmp);
  const name = await freeName(folder, entry.name);
  await fs.rename(entry.tmp, path.join(folder, name));
  uploads.delete(uploadId);
  return { ok: true, name };
}

async function uploadAbort({ dir, uploadId }) {
  const entry = upload(dir, uploadId);
  uploads.delete(uploadId);
  await fs.rm(entry.tmp, { force: true });
  return { ok: true };
}

// ---------- 预览：在本机回环地址上提供文件，看板页面用 iframe 显示（宿主只放行本插件页面嵌入回环地址） ----------
const LINK_TTL_MS = 30 * 60 * 1000;
const links = new Map(); // 随机令牌 → { file, type, name, expires }
let server = null;

function serve(req, res) {
  const [, token, part] = req.url.split('/');
  const link = links.get(token);
  // 只认 127.0.0.1:端口 这个 Host，挡住借别的域名指向本机的网页来读文件。
  if (req.headers.host !== `127.0.0.1:${server.address().port}` || !['GET', 'HEAD'].includes(req.method) || !link || link.expires < Date.now()) {
    res.writeHead(404).end();
    return;
  }
  const headers = {
    'Content-Type': link.type,
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(link.name)}`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  // 文件内容不可信（SVG 可以带脚本）：除 PDF 外都放进沙箱，不许运行脚本。PDF 阅读器在沙箱里打不开。
  if (link.type !== 'application/pdf') headers['Content-Security-Policy'] = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'";
  // 图片包一层页面，按弹窗大小缩放；直接打开图片在 iframe 里是原尺寸。
  if (part === 'view' && link.type.startsWith('image/')) {
    res.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Content-Disposition': 'inline' });
    res.end(`<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%}body{display:flex;align-items:center;justify-content:center}img{max-width:100%;max-height:100%;object-fit:contain}</style><img src="/${token}/raw" alt="">`);
    return;
  }
  res.writeHead(200, headers);
  if (req.method === 'HEAD') res.end();
  else createReadStream(link.file).on('error', () => res.destroy()).pipe(res);
}

async function fileUrl({ dir, name }) {
  const { file } = await knowledgeFile(dir, name);
  const [kind, type] = typeOf(name);
  if (kind === 'other') throw new Error('this file type cannot be previewed');
  if (!server) {
    server = http.createServer(serve);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  }
  const now = Date.now();
  for (const [token, link] of links) if (link.expires < now) links.delete(token);
  const token = randomBytes(16).toString('hex');
  links.set(token, { file, type, name, expires: now + LINK_TTL_MS });
  return { url: `http://127.0.0.1:${server.address().port}/${token}/${kind === 'image' ? 'view' : encodeURIComponent(name)}`, kind };
}

/** 用电脑上的默认应用打开（docx、xlsx 等页面里预览不了的文件）。 */
async function openFile({ dir, name }) {
  const { file } = await knowledgeFile(dir, name);
  const [command, args] = process.platform === 'darwin' ? ['open', [file]]
    : process.platform === 'win32' ? ['explorer.exe', [file]]
      : ['xdg-open', [file]];
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
  return { ok: true };
}

async function snapshot({ dir }) {
  const entries = await Promise.all(Object.entries(DOCS).map(async ([id, rel]) => [id, await readDoc(dir, rel)]));
  const docs = Object.fromEntries(entries);
  return {
    docs,
    paths: { ...DOCS, knowledge: KNOWLEDGE_DIR },
    todos: docs.todos ? parseTodos(docs.todos.content) : [],
    notes: docs.notes ? parseNotes(docs.notes.content) : [],
    knowledge: await listKnowledge(dir),
    candidates: await readCandidates(dir),
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

/**
 * 保存项目介绍或根目录的配置文件。expected 是页面打开编辑时读到的内容；文件已被别处改过就报 CHANGED，不覆盖。
 * AGENTS.md / CLAUDE.md 是软链接时写到它指向的真实文件。
 */
async function writeDoc({ dir, id, content, expected }) {
  if (!EDITABLE.has(id)) throw new Error('this document cannot be edited');
  if (typeof content !== 'string' || typeof expected !== 'string') throw new Error('content and expected must be strings');
  const file = await realFile(path.join(dir, DOCS[id]));
  if ((await readOrEmpty(file)) !== expected) return { ok: false, code: 'CHANGED' };
  await writeAtomic(file, content);
  return { ok: true };
}

// AGENTS.md 里的「项目资料」入口：Codex 读 AGENTS.md，Claude Code 读 CLAUDE.md（经 @AGENTS.md 导入）。
const ENTRY = {
  'zh-CN': ['## 项目资料', '', `- 项目介绍：\`${DOCS.intro}\``, `- 待办清单：\`${DOCS.todos}\`（完成一条就把该行的 \`- [ ]\` 改成 \`- [x]\`）`],
  'zh-TW': ['## 專案資料', '', `- 專案介紹：\`${DOCS.intro}\``, `- 待辦清單：\`${DOCS.todos}\`（完成一條就把該行的 \`- [ ]\` 改成 \`- [x]\`）`],
  ja: ['## プロジェクト資料', '', `- プロジェクト紹介：\`${DOCS.intro}\``, `- ToDo リスト：\`${DOCS.todos}\`（完了した項目は行頭の \`- [ ]\` を \`- [x]\` に変更）`],
  ko: ['## 프로젝트 자료', '', `- 프로젝트 소개: \`${DOCS.intro}\``, `- 할 일 목록: \`${DOCS.todos}\` (완료한 항목은 \`- [ ]\`를 \`- [x]\`로 변경)`],
  es: ['## Notas del proyecto', '', `- Presentación del proyecto: \`${DOCS.intro}\``, `- Lista de pendientes: \`${DOCS.todos}\` (al terminar un elemento, cambia su \`- [ ]\` por \`- [x]\`)`],
  fr: ['## Notes du projet', '', `- Présentation du projet : \`${DOCS.intro}\``, `- Liste des tâches à faire : \`${DOCS.todos}\` (remplacez \`- [ ]\` par \`- [x]\` quand un élément est terminé)`],
  de: ['## Projektnotizen', '', `- Projektbeschreibung: \`${DOCS.intro}\``, `- To-do-Liste: \`${DOCS.todos}\` (erledigte Einträge von \`- [ ]\` auf \`- [x]\` ändern)`],
  'pt-BR': ['## Notas do projeto', '', `- Apresentação do projeto: \`${DOCS.intro}\``, `- Lista de pendências: \`${DOCS.todos}\` (ao concluir um item, troque \`- [ ]\` por \`- [x]\`)`],
  'pt-PT': ['## Notas do projeto', '', `- Apresentação do projeto: \`${DOCS.intro}\``, `- Lista de tarefas pendentes: \`${DOCS.todos}\` (ao concluir um item, troque \`- [ ]\` por \`- [x]\`)`],
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

function noteText(value) {
  const text = typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim() : '';
  if (!text || text.length > 10000) throw new Error('note text must be 1-10000 characters');
  return text;
}

/** 在资料文件末尾追加一条，保留原文的换行；返回的 id 用于撤销。文件不存在时创建。 */
async function addNote({ dir, text }) {
  const body = noteText(text);
  const file = path.join(dir, DOCS.notes);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const id = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())} #${randomBytes(3).toString('hex')}`;
  await writeAtomic(file, appendLines(await readOrEmpty(file), [`## ${id}`, '', ...body.split('\n')]));
  return { ok: true, id };
}

/** 删除一条资料：从它的标题删到下一条的标题。找不到就报 CHANGED，不改文件。 */
async function removeNote({ dir, id }) {
  const file = path.join(dir, DOCS.notes);
  const lines = (await readOrEmpty(file)).split(/(?<=\n)/);
  const start = lines.findIndex((line) => line.trimEnd() === `## ${id}`);
  if (start < 0) return { ok: false, code: 'CHANGED' };
  const next = lines.findIndex((line, i) => i > start && NOTE_HEADING.test(line.trimEnd()));
  const end = next < 0 ? lines.length : next;
  // 删的是最后一条时，连它前面那个分隔空行一起删，文件回到追加之前的样子。
  const from = end === lines.length && start > 0 && !lines[start - 1].trim() ? start - 1 : start;
  lines.splice(from, end - from);
  await writeAtomic(file, lines.join(''));
  return { ok: true };
}

// ---------- 知识候选 ----------
async function readCandidates(dir) {
  try {
    const list = JSON.parse((await readOrEmpty(path.join(dir, CANDIDATES_FILE))) || '[]');
    return Array.isArray(list) ? list : [];
  } catch (err) {
    // 候选只是待确认的草稿，损坏了不该挡住整个看板；下一次提交会重写。
    if (err instanceof SyntaxError) return [];
    throw err;
  }
}

const writeCandidates = (dir, list) => writeAtomic(path.join(dir, CANDIDATES_FILE), JSON.stringify(list, null, 2) + '\n');

function candidateText(value, label, max) {
  const text = typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim() : '';
  if (!text || text.length > max) throw new Error(`${label} must be 1-${max} characters`);
  return text;
}

/** 候选要写入的文件：可以还不存在；已存在时必须是普通文件，软链接可能指向项目外。 */
async function candidateTarget(dir, name) {
  if (typeof name !== 'string' || !CANDIDATE_NAME.test(name) || [NOTES_NAME, TOC_NAME.toLowerCase()].includes(name.toLowerCase())) {
    throw new Error(`file must be a Markdown file name directly inside project-knowledge, without spaces or brackets, and not ${NOTES_NAME} or ${TOC_NAME}`);
  }
  const file = path.join(dir, KNOWLEDGE_DIR, name);
  const stat = await fs.lstat(file).catch(() => null);
  if (stat && !stat.isFile()) throw new Error(`file ${name} is not a regular file`);
  return file;
}

// 替换前把原文的换行符对齐文件；原文出现的次数不是一次就不猜，返回 null。
function replaceOnce(content, passage, next) {
  const align = (value) => (/\r\n/.test(content) ? value.replace(/\n/g, '\r\n') : value);
  const parts = content.split(align(passage));
  return parts.length === 2 ? parts.join(align(next)) : null;
}

/** 提交一条候选，只写进候选区。同样的内容已在等待确认时不多出一条。 */
async function proposeKnowledge({ dir, kind, file: name, text, replaces, evidence }) {
  if (!CANDIDATE_KINDS.has(kind)) throw new Error('kind must be term, architecture or correction');
  const body = candidateText(text, 'text', 10000);
  const reason = candidateText(evidence, 'evidence', 500);
  const file = await candidateTarget(dir, name);
  let passage = null;
  if (kind === 'correction') {
    passage = candidateText(replaces, 'replaces', 10000);
    if (replaceOnce(await readOrEmpty(file), passage, body) === null) throw new Error(`replaces must appear exactly once in ${name}`);
  } else if (replaces !== undefined && replaces !== null) {
    throw new Error('replaces is only for kind correction');
  }
  const list = await readCandidates(dir);
  const same = list.find((c) => c.file === name && c.text === body && c.replaces === passage);
  if (same) return { ok: true, id: same.id };
  const id = randomBytes(4).toString('hex');
  await writeAtomic(path.join(dir, CANDIDATES_DIR, '.gitignore'), '*\n');
  await writeCandidates(dir, [...list, { id, kind, file: name, text: body, replaces: passage, evidence: reason, at: Date.now() }]);
  return { ok: true, id };
}

/** Cindy 只把 TOC.md 的入口告诉新任务，不在索引里的文件基本读不到，所以写入知识时一并补上。 */
async function indexInToc(dir, name, content) {
  const file = path.join(dir, KNOWLEDGE_DIR, TOC_NAME);
  const toc = await readOrEmpty(file);
  if (toc.split(/[\s()`<>|[\]/]+/).includes(name)) return;
  const eol = /\r\n/.test(toc) ? '\r\n' : '\n';
  const prefix = toc === '' ? `# TOC${eol}${eol}` : toc.endsWith('\n') ? toc : toc + eol;
  const title = firstHeading(content);
  await writeAtomic(file, `${prefix}- [${name}](${name})${title ? ` - ${title}` : ''}${eol}`);
}

/** 用户确认一条候选：写进知识文件和索引，再从候选区移除。text 是用户改过的内容。 */
async function acceptCandidate({ dir, id, text }) {
  const list = await readCandidates(dir);
  const candidate = list.find((c) => c.id === id);
  if (!candidate) return { ok: false, code: 'CHANGED' };
  const body = text === undefined ? candidate.text : candidateText(text, 'text', 10000);
  const file = await candidateTarget(dir, candidate.file);
  const content = await readOrEmpty(file);
  const next = candidate.replaces ? replaceOnce(content, candidate.replaces, body) : appendLines(content, body.split('\n'));
  if (next === null) return { ok: false, code: 'STALE' };
  await writeAtomic(file, next);
  await indexInToc(dir, candidate.file, next);
  await writeCandidates(dir, list.filter((c) => c.id !== id));
  return { ok: true, file: candidate.file };
}

async function rejectCandidate({ dir, id }) {
  const list = await readCandidates(dir);
  if (!list.some((c) => c.id === id)) return { ok: false, code: 'CHANGED' };
  await writeCandidates(dir, list.filter((c) => c.id !== id));
  return { ok: true };
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
  'project/summary': summary,
  'project/brief': brief,
  'project/read-knowledge': readKnowledge,
  'project/update-todo': serialized(updateTodo),
  'project/add-todo': serialized(addTodo),
  'project/add-note': serialized(addNote),
  'project/remove-note': serialized(removeNote),
  'project/write-doc': serialized(writeDoc),
  'project/remove-file': serialized(removeFile),
  'project/upload-begin': uploadBegin,
  'project/upload-chunk': uploadChunk,
  'project/upload-finish': serialized(uploadFinish),
  'project/upload-abort': uploadAbort,
  'project/file-url': fileUrl,
  'project/open-file': openFile,
  'project/add-entry': serialized(addEntry),
  'project/propose-knowledge': serialized(proposeKnowledge),
  'project/accept-candidate': serialized(acceptCandidate),
  'project/reject-candidate': serialized(rejectCandidate),
};

// 预览服务器会让进程一直活着；宿主关掉 stdin（空闲回收、停用插件）时主动退出。
process.stdin.on('end', () => process.exit(0));

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
