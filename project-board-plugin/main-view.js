'use strict';
// 项目看板主视图。所有宿主能力经电子脑（main.js）代办；这里只画界面、发请求。

// 界面文案在 main-view-i18n.js（STRINGS）。
const FILES = ['readme', 'agents', 'claude']; // 折叠在资料库底部的配置文件
const ALL = '__all__'; // 项目下拉框里「全部项目」一项的值
const LINKS_KEY = 'project-board:links';
const AI_FILES = new Set(['agents', 'claude']);
const RECENT_NOTES = 3; // 资料库默认露出的资料条数，其余折叠
const UPLOAD_CHUNK = 160 * 1024; // 每次发给工作进程的字节数：base64 后要在宿主单次请求 256 KB 的上限以内
const MAX_UPLOAD = 50 * 1024 * 1024; // 资料随 git 提交，太大的文件不收

let S = STRINGS.en;
let lang = 'en';
let projects = [];
let current = null; // { id, label }：正在看的项目（总览时保留上次看的项目）
let view = 'project'; // 'project' 单个项目 / 'all' 全部项目总览
let snap = null;
let taskList = null; // null = 尚未读到；{ error } = 读取失败
const stats = new Map(); // 项目 id → { tasks, summary }：项目栏和总览用；读不到为 null（旧版 Cindy 没有任务接口）
let ask = null; // { heading, title, text }
let selected = null; // 多选模式下为选中待办的文字集合（按文字记，AI 改动文件导致行号变化时不丢），不在多选模式时为 null
let editingIntro = null; // 正在编辑时为打开编辑时读到的内容，保存时用来核对文件是否被别处改过
let introOpen = false; // 项目介绍是否展开全文；切换项目时收起

// 文言文界面用简体 / 繁体中文，其他没有翻译的语言按语种前缀找，最后回退到英文。
function pickLang(locale) {
  const value = String(locale || '');
  if (STRINGS[value]) return value;
  if (value === 'zh-Hans-x-lzh') return 'zh-CN';
  if (/^zh-(Hant|TW|HK|MO)/.test(value)) return 'zh-TW';
  const base = value.split('-')[0];
  return Object.keys(STRINGS).find((k) => k.split('-')[0] === base) || 'en';
}

const $ = (id) => document.getElementById(id);
const fmt = (s, vars) => s.replace(/\{(\w+)\}/g, (_, k) => vars[k]);
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- 与电子脑通信：按 reqId 重发直到收到回执（电子脑按 reqId 去重） ----------
const channel = new BroadcastChannel('project-board');
const pending = new Map();
channel.onmessage = ({ data }) => {
  if (data?.type === 'event' && data.name === 'tunnel-changed') {
    // 隧道连上、断开：只重读隧道状态，不重读任务和资料。
    loadShare(false).then(() => { if (view === 'all') redrawOverview(); }).catch(() => {});
    return;
  }
  if (data?.type === 'event') {
    // 一轮结束、任务新建 / 归档时 AI 可能改了文件，连资料一起重读；其余（开始、审批、提问）只重读任务。
    // board-changed 是 Agent 经插件工具记了待办或资料。
    scheduleRefresh(data.dropped > 0 || /^(did-(turn-end|session-)|board-changed$)/.test(data.name));
    return;
  }
  const p = data?.type === 'res' && pending.get(data.reqId);
  if (!p) return;
  pending.delete(data.reqId);
  clearInterval(p.timer);
  if (data.ok) p.resolve(data.data);
  else p.reject(Object.assign(new Error(data.message || data.code), { code: data.code }));
};
async function call(op, args) {
  await fetch('/wake');
  const reqId = `${op}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve, reject) => {
    const post = () => channel.postMessage({ type: 'req', reqId, op, args });
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started > 45000) {
        clearInterval(timer);
        pending.delete(reqId);
        reject(Object.assign(new Error('timeout'), { code: 'TIMEOUT' }));
      } else post();
    }, 600);
    pending.set(reqId, { resolve, reject, timer });
    post();
  });
}

// ---------- 极简 Markdown 渲染（先转义，再加有限的格式） ----------
function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const cells = (row) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

function markdown(src) {
  const out = [];
  let list = null;
  let code = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (code !== null) {
      if (/^```/.test(line)) { out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`); code = null; } else code.push(line);
      continue;
    }
    if (/^```/.test(line)) { closeList(); code = []; continue; }
    // 表格：表头行后紧跟分隔行（|---|---|）才算表格
    if (TABLE_ROW.test(line) && TABLE_SEP.test(lines[i + 1] ?? '')) {
      closeList();
      const head = cells(line).map((c) => `<th>${inline(c)}</th>`).join('');
      const body = [];
      for (i += 2; i < lines.length && TABLE_ROW.test(lines[i]); i++)
        body.push(`<tr>${cells(lines[i]).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`);
      i--;
      out.push(`<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body.join('')}</tbody></table></div>`);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (h) { closeList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); }
    else if (ul || ol) {
      const kind = ul ? 'ul' : 'ol';
      if (list !== kind) { closeList(); out.push(`<${kind}>`); list = kind; }
      out.push(`<li>${inline((ul || ol)[1])}</li>`);
    } else if (/^>\s?/.test(line)) { closeList(); out.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`); }
    else if (line.trim()) { closeList(); out.push(`<p>${inline(line)}</p>`); }
    else closeList();
  }
  closeList();
  if (code !== null) out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
  return out.join('');
}

// ---------- 刷新时保留界面状态：折叠区是否展开、各列表的滚动位置 ----------
// 需要保留的元素带 data-keep；重绘前记下、重绘后恢复。切换项目时清空。
const kept = new Map();
function withKept(draw) {
  for (const el of document.querySelectorAll('[data-keep]')) kept.set(el.dataset.keep, { open: el.open, scroll: el.scrollTop });
  const pageScroll = document.scrollingElement.scrollTop;
  draw();
  for (const el of document.querySelectorAll('[data-keep]')) {
    const state = kept.get(el.dataset.keep);
    if (!state) continue;
    if (el.tagName === 'DETAILS') el.open = state.open;
    el.scrollTop = state.scroll;
  }
  document.scrollingElement.scrollTop = pageScroll;
}

// ---------- 待办与任务的对应：只存在本机（任务 ID 对别的电脑没有意义），不写进 todos.md ----------
// 结构：{ [项目目录]: { [待办文字]: 任务 ID } }。按文字记，在看板里改文字时一并迁移。
function readLinks() {
  try { return JSON.parse(localStorage.getItem(LINKS_KEY)) || {}; } catch { return {}; }
}
function updateLinks(dir, change) {
  const all = readLinks();
  const links = { ...(all[dir] || {}) };
  change(links);
  if (Object.keys(links).length) all[dir] = links;
  else delete all[dir];
  try { localStorage.setItem(LINKS_KEY, JSON.stringify(all)); } catch { /* 存不了就不记 */ }
}
const linksFor = (dir) => readLinks()[dir] || {};

// ---------- 渲染 ----------
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, 5000);
}
function notice(text) {
  $('notice').textContent = text;
  $('notice').hidden = !text;
}

function renderIntro() {
  if (editingIntro !== null) return; // 编辑中不被自动刷新冲掉
  const intro = snap.docs.intro;
  $('intro-edit').disabled = Boolean(intro?.truncated);
  $('intro-body').innerHTML = intro ? markdown(intro.content) : `<p class="empty">${esc(S.introEmpty)}</p>`;
  document.querySelector('[data-ai="intro"]').textContent = intro ? S.update : S.generate;
  fitIntro();
}

// 收起时只露出开头；内容本来就短就不显示「展开全文」。
function fitIntro() {
  const body = $('intro-body');
  document.querySelector('.card.intro').classList.toggle('collapsed', !introOpen);
  $('intro-more').hidden = !introOpen && body.scrollHeight <= body.clientHeight + 4;
  $('intro-more').textContent = introOpen ? S.introLess : S.introMore;
}

function startIntroEdit() {
  editingIntro = snap.docs.intro?.content ?? '';
  const box = document.createElement('div');
  box.className = 'intro-edit';
  const area = document.createElement('textarea');
  area.value = editingIntro;
  const acts = document.createElement('div');
  acts.className = 'actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'ghost';
  cancel.textContent = S.cancel;
  cancel.addEventListener('click', () => { editingIntro = null; renderIntro(); });
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'primary';
  save.textContent = S.save;
  save.addEventListener('click', () => saveIntro(area.value, save));
  acts.append(cancel, save);
  box.append(area, acts);
  $('intro-body').replaceChildren(box);
  document.querySelector('.card.intro').classList.remove('collapsed');
  $('intro-more').hidden = true;
  $('intro-edit').disabled = true;
  area.focus();
  area.setSelectionRange(0, 0);
  area.scrollTop = 0;
}

async function saveIntro(content, button) {
  button.disabled = true;
  try {
    const res = await call('writeDoc', { dir: current.id, id: 'intro', content, expected: editingIntro });
    if (!res.ok) {
      // 记下最新内容：用户再点保存就是有意覆盖
      const latest = await call('snapshot', { dir: current.id });
      editingIntro = latest.docs.intro?.content ?? '';
      toast(S.introChanged);
      return;
    }
    editingIntro = null;
    toast(S.introSaved);
    await load();
  } catch (err) {
    toast(fmt(S.failed, { m: err.message }));
  } finally {
    button.disabled = false;
  }
}

function todoButton(label, onClick, className = 'ghost') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function editTodoText(todo, text) {
  const input = document.createElement('input');
  input.className = 'edit';
  input.maxLength = 500;
  input.value = todo.text;
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    if (save && value && value !== todo.text) updateTodo(todo, { text: value });
    else input.replaceWith(text);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  text.replaceWith(input);
  input.focus();
}

function renderSelectBar() {
  $('todo-select-bar').hidden = !selected;
  if (!selected) return;
  $('todo-select-task').textContent = fmt(S.selectedTask, { n: selected.size });
  $('todo-select-task').disabled = selected.size === 0;
}

function toggleSelecting() {
  selected = selected ? null : new Set();
  renderTodos();
}

function askForSelected() {
  const items = snap.todos.filter((t) => !t.done && selected.has(t.text));
  if (!items.length) return;
  const first = items[0].text.length > 40 ? `${items[0].text.slice(0, 40)}…` : items[0].text;
  openAsk({
    heading: S.todoTaskHeading,
    hint: S.todoAskHint,
    title: items.length === 1 ? first : fmt(S.manyTitle, { t: first, n: items.length }),
    text: fmt(S.todosPrompt, { list: items.map((t) => `- ${t.text}`).join('\n') }),
    todos: items.map((t) => t.text),
    onSent: () => { selected = null; },
  });
}

function renderTodos() {
  const open = snap.todos.filter((t) => !t.done);
  const done = snap.todos.filter((t) => t.done);
  $('todo-count').textContent = snap.todos.length ? String(open.length) : '';
  $('todo-select').textContent = selected ? S.cancel : S.select;
  $('todo-select').hidden = !open.length && !selected;
  const body = $('todo-body');
  body.replaceChildren();
  if (!snap.todos.length) {
    selected = null;
    renderSelectBar();
    body.innerHTML = `<p class="empty">${esc(S.todosEmpty)}</p>`;
    return;
  }
  // 待办已不在文件里（被删除或被 AI 改了文字）时，丢掉它的对应记录。
  const links = linksFor(current.id);
  const texts = new Set(snap.todos.map((t) => t.text));
  if (Object.keys(links).some((text) => !texts.has(text)))
    updateLinks(current.id, (l) => { for (const text of Object.keys(l)) if (!texts.has(text)) delete l[text]; });
  const list = (items, into) => {
    let group = null;
    for (const t of items) {
      if (t.group && t.group !== group) {
        group = t.group;
        const g = document.createElement('div');
        g.className = 'group';
        g.textContent = group;
        into.append(g);
      }
      const row = document.createElement('div');
      row.className = `todo${t.done ? ' done' : ''}`;
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      if (selected) {
        box.checked = selected.has(t.text);
        box.addEventListener('change', () => {
          if (box.checked) selected.add(t.text);
          else selected.delete(t.text);
          renderSelectBar();
        });
      } else {
        box.checked = t.done;
        box.addEventListener('change', () => updateTodo(t, { done: box.checked }, box));
      }
      const text = document.createElement('span');
      text.className = 'text';
      text.innerHTML = inline(t.text);
      label.append(box, text);
      const chip = linkChip(links[t.text]);
      const acts = document.createElement('span');
      acts.className = 'acts';
      if (selected) {
        // 多选时不显示单条操作
      } else if (!t.done) {
        acts.append(todoButton(S.newTask, () => openAsk({
          heading: S.todoTaskHeading,
          hint: S.todoAskHint,
          title: t.text.length > 60 ? `${t.text.slice(0, 60)}…` : t.text,
          text: fmt(S.todoPrompt, { t: t.text }),
          todos: [t.text],
        }), 'ai'));
      }
      if (!selected) {
        acts.append(
          todoButton(S.edit, () => editTodoText(t, text)),
          todoButton(S.remove, () => updateTodo(t, { remove: true }), 'ghost danger'),
        );
      }
      row.append(...[label, chip, acts].filter(Boolean));
      into.append(row);
    }
  };
  list(open, body);
  if (selected) {
    // 刷新后已不存在的待办不再算选中
    const keys = new Set(open.map((t) => t.text));
    for (const key of selected) if (!keys.has(key)) selected.delete(key);
  }
  renderSelectBar();
  if (done.length && !selected) {
    const details = document.createElement('details');
    details.className = 'done-list';
    details.dataset.keep = 'todos:done';
    const summary = document.createElement('summary');
    summary.textContent = fmt(S.doneCount, { n: done.length });
    details.append(summary);
    list(done, details);
    body.append(details);
  }
}

function renderCandidates() {
  const { candidates } = snap;
  $('candidates').hidden = !candidates.length;
  $('candidate-count').textContent = String(candidates.length);
  $('candidate-body').replaceChildren(...candidates.map((c) => {
    const div = document.createElement('div');
    div.className = 'note candidate';
    const head = document.createElement('div');
    head.className = 'note-head';
    head.textContent = `${S.candidateKinds[c.kind]} · ${c.file} · ${ago(c.at)}`;
    const body = document.createElement('div');
    body.className = 'md';
    body.innerHTML = markdown(c.text);
    const evidence = document.createElement('div');
    evidence.className = 'evidence';
    evidence.textContent = fmt(S.candidateEvidence, { e: c.evidence });
    const acts = document.createElement('div');
    acts.className = 'candidate-acts';
    acts.append(
      todoButton(S.candidateReject, () => rejectCandidate(c)),
      todoButton(S.edit, () => editCandidate(c)),
      todoButton(S.candidateAccept, () => acceptCandidate(c), 'primary'),
    );
    div.append(head);
    if (c.replaces) {
      const old = document.createElement('div');
      old.className = 'old';
      old.textContent = fmt(S.candidateReplaces, { t: c.replaces });
      div.append(old);
    }
    div.append(body, evidence, acts);
    return div;
  }));
}

// text 是用户改过的内容；不传就按候选原文写入。
async function acceptCandidate(candidate, text) {
  try {
    const res = await call('acceptCandidate', { dir: current.id, id: candidate.id, text });
    toast(res.ok ? fmt(S.candidateSaved, { f: `${snap.paths.knowledge}/${res.file}` }) : res.code === 'STALE' ? S.candidateStale : S.candidateChanged);
  } catch (err) {
    toast(fmt(S.failed, { m: err.message }));
  }
  await load();
}

async function rejectCandidate(candidate) {
  try {
    const res = await call('rejectCandidate', { dir: current.id, id: candidate.id });
    if (!res.ok) toast(S.candidateChanged);
  } catch (err) {
    toast(fmt(S.failed, { m: err.message }));
  }
  await load();
}

function editCandidate(candidate) {
  const area = document.createElement('textarea');
  area.className = 'doc-edit';
  area.value = candidate.text;
  const accept = todoButton(S.candidateAccept, () => {
    $('viewer').close();
    acceptCandidate(candidate, area.value);
  }, 'primary');
  showViewer(`${snap.paths.knowledge}/${candidate.file}`, area, [todoButton(S.cancel, () => $('viewer').close()), accept]);
  area.focus();
}

function renderLibrary() {
  const { knowledge, notes } = snap;
  document.querySelector('[data-ai="knowledge"]').textContent = knowledge.length ? S.update : S.create;
  $('knowledge-count').textContent = knowledge.length ? String(knowledge.length) : '';
  const list = $('knowledge-list');
  list.replaceChildren();
  if (!knowledge.length) list.innerHTML = `<li><p class="empty">${esc(S.knowledgeEmpty)}</p></li>`;
  for (const file of knowledge) {
    const li = document.createElement('li');
    li.innerHTML = `<div class="name">${esc(file.name)}<small>${esc([file.title, bytes(file.size), ago(file.mtimeMs)].filter(Boolean).join(' · '))}</small></div>`;
    const acts = document.createElement('span');
    acts.className = 'acts';
    acts.append(todoButton(S.remove, () => askConfirm(S.fileRemoveAsk, text(file.name), () => removeFile(file))));
    li.append(acts, file.kind === 'other' ? todoButton(S.openFile, () => openFile(file.name)) : todoButton(S.view, () => viewFile(file)));
    list.append(li);
  }

  $('note-count').textContent = notes.length ? String(notes.length) : '';
  const body = $('note-body');
  body.replaceChildren();
  if (!notes.length) {
    body.innerHTML = `<p class="empty">${esc(S.notesEmpty)}</p>`;
    return;
  }
  const item = (note) => {
    const div = document.createElement('div');
    div.className = 'note';
    const head = document.createElement('div');
    head.className = 'note-head';
    const at = document.createElement('span');
    at.textContent = note.at;
    const acts = document.createElement('span');
    acts.className = 'acts';
    acts.append(todoButton(S.remove, () => askConfirm(S.noteRemoveAsk, mdBody({ content: note.text }), () => removeNote(note))));
    head.append(at, acts);
    const text = document.createElement('div');
    text.className = 'md';
    text.innerHTML = markdown(note.text);
    div.append(head, text);
    return div;
  };
  body.append(...notes.slice(0, RECENT_NOTES).map(item));
  const rest = notes.slice(RECENT_NOTES);
  if (rest.length) {
    const details = document.createElement('details');
    details.className = 'done-list';
    details.dataset.keep = 'library:more';
    const summary = document.createElement('summary');
    summary.textContent = fmt(S.moreNotes, { n: rest.length });
    details.append(summary, ...rest.map(item));
    body.append(details);
  }
}

const bytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
function text(value) {
  const p = document.createElement('p');
  p.textContent = value;
  return p;
}

// Markdown 在弹窗里渲染；图片、PDF、文本、音视频由工作进程在本机回环地址提供，用 iframe 显示。
async function viewFile(file) {
  const title = `${snap.paths.knowledge}/${file.name}`;
  try {
    if (file.kind === 'md') {
      showViewer(title, mdBody(await call('readKnowledge', { dir: current.id, name: file.name })), [closeButton()]);
      return;
    }
    const { url } = await call('fileUrl', { dir: current.id, name: file.name });
    const frame = document.createElement('iframe');
    frame.className = 'viewer-frame';
    frame.title = file.name;
    frame.src = url;
    showViewer(title, frame, [todoButton(S.openFile, () => openFile(file.name)), closeButton()]);
  } catch (err) {
    toast(fmt(S.failed, { m: err.message }));
  }
}

async function openFile(name) {
  try {
    await call('openFile', { dir: current.id, name });
    toast(S.opened);
  } catch (err) {
    toast(fmt(S.failed, { m: err.message }));
  }
}

async function removeFile(file) {
  try {
    await call('removeFile', { dir: current.id, name: file.name });
  } catch (err) {
    toast(fmt(S.failed, { m: err.message }));
  }
  await load();
}

function toBase64(buffer) {
  const view = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < view.length; i += 0x8000) binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return btoa(binary);
}

// 逐个文件分块上传到 .cindy/project-knowledge/；一个失败就停下，已传完的保留。
async function uploadFiles(files) {
  const dir = current.id;
  const tooLarge = files.filter((f) => f.size > MAX_UPLOAD).map((f) => f.name);
  let done = 0;
  $('file-upload').disabled = true;
  try {
    for (const file of files.filter((f) => f.size <= MAX_UPLOAD)) {
      let uploadId = null;
      try {
        ({ uploadId } = await call('uploadBegin', { dir, name: file.name, size: file.size }));
        for (let offset = 0; offset < file.size; offset += UPLOAD_CHUNK) {
          toast(fmt(S.uploading, { f: file.name, p: Math.floor((offset * 100) / file.size) }));
          const data = toBase64(await file.slice(offset, offset + UPLOAD_CHUNK).arrayBuffer());
          await call('uploadChunk', { dir, uploadId, offset, data });
        }
        await call('uploadFinish', { dir, uploadId });
        done += 1;
      } catch (err) {
        if (uploadId) call('uploadAbort', { dir, uploadId }).catch(() => {});
        toast(fmt(S.failed, { m: `${file.name}: ${err.message}` }));
        return;
      }
    }
    toast([done ? fmt(S.uploaded, { n: done }) : '', tooLarge.length ? fmt(S.uploadTooLarge, { f: tooLarge.join(S.joiner) }) : ''].filter(Boolean).join(' '));
  } finally {
    $('file-upload').disabled = false;
    if (done && view === 'project' && current?.id === dir) await load();
  }
}

async function addNote(event) {
  event.preventDefault();
  const input = $('note-new');
  const text = input.value.trim();
  if (!text || !current) return;
  input.disabled = true;
  try {
    await call('addNote', { dir: current.id, text });
    input.value = '';
    await load();
  } catch (err) {
    toast(fmt(S.failed, { m: err.message }));
  } finally {
    input.disabled = false;
    input.focus();
  }
}

// 删除前让用户看一眼要删的内容再确认；资料可能很长，误删不像待办那样一眼能发现。
function askConfirm(title, body, onOk) {
  $('confirm-title').textContent = title;
  $('confirm-body').replaceChildren(body);
  const dialog = $('confirm');
  dialog.returnValue = '';
  dialog.addEventListener('close', () => { if (dialog.returnValue === 'ok') onOk(); }, { once: true });
  dialog.showModal();
}

async function removeNote(note) {
  try {
    const res = await call('removeNote', { dir: current.id, id: note.id });
    if (!res.ok) toast(S.noteChanged);
  } catch (err) {
    toast(fmt(S.failed, { m: err.message }));
  }
  await load();
}

function renderFiles() {
  const ul = $('file-list');
  ul.replaceChildren();
  for (const id of FILES) {
    const doc = snap.docs[id];
    const li = document.createElement('li');
    // AGENTS.md 已写有项目介绍与待办的路径，就算已加入资料入口
    const entryReady = id === 'agents' && doc && doc.content.includes(snap.paths.intro) && doc.content.includes(snap.paths.todos);
    li.innerHTML = `<div class="name">${esc(S[id])}<small>${esc(snap.paths[id])} · ${esc(doc ? S.ready : S.missing)}${entryReady ? ` · ${esc(S.entryReady)}` : ''}</small></div>`;
    if (doc) {
      const view = document.createElement('button');
      view.type = 'button';
      view.className = 'ghost';
      view.textContent = S.view;
      view.addEventListener('click', () => openViewer(id));
      li.append(view);
    }
    if (id === 'agents' && !entryReady) {
      const entry = document.createElement('button');
      entry.type = 'button';
      entry.textContent = S.addEntry;
      entry.addEventListener('click', () => addEntry(entry));
      li.append(entry);
    }
    if (AI_FILES.has(id)) {
      const ai = document.createElement('button');
      ai.type = 'button';
      ai.className = 'ai';
      ai.textContent = doc ? S.update : S.create;
      ai.addEventListener('click', () => openAiAsk(id));
      li.append(ai);
    }
    ul.append(li);
  }
}

async function addEntry(button) {
  button.disabled = true;
  try {
    const res = await call('addEntry', { dir: current.id, lang });
    toast([S.entryDone[res.agents], S.claudeDone[res.claude]].filter(Boolean).join(S.joiner) + S.period);
    await load();
  } catch (err) {
    toast(fmt(S.failed, { m: err.message }));
    button.disabled = false;
  }
}

function renderGit() {
  const g = snap.git;
  const body = $('git-body');
  if (!g) {
    body.innerHTML = `<p class="empty">${esc(S.notGit)}</p>`;
    return;
  }
  const commits = g.commits.map((c) => `<li><code>${esc(c.hash)}</code>${esc(c.date)} ${esc(c.subject)}</li>`).join('');
  const worktrees = g.worktrees.length > 1
    ? `<dt>${esc(S.worktrees)}</dt><dd>${g.worktrees.slice(1).map((w) => esc(w.branch)).join(', ')}</dd>` : '';
  body.innerHTML = `<dl>
      <dt>${esc(S.branch)}</dt><dd>${esc(g.branch || '-')}</dd>
      <dt>${esc(S.changes)}</dt><dd>${g.changedFiles ? esc(fmt(S.changesN, { n: g.changedFiles })) : esc(S.clean)}</dd>
      ${worktrees}
    </dl>
    ${commits ? `<div class="group">${esc(S.commits)}</div><ul class="commits">${commits}</ul>` : ''}
    ${g.cindyWorktreesUnignored ? `<p class="warn">${esc(S.worktreesWarn)}</p>` : ''}`;
}

const AGENT_NAMES = { cc: 'Claude Code', codex: 'Codex', pi: 'Pi' };
const COLUMN_OF = { error: 'attention', awaiting: 'attention', running: 'running', done: 'done', idle: 'idle' };

function ago(ms) {
  const min = Math.floor((Date.now() - ms) / 60000);
  if (min < 1) return S.ago.now;
  if (min < 60) return fmt(S.ago.m, { n: min });
  if (min < 1440) return fmt(S.ago.h, { n: Math.floor(min / 60) });
  return fmt(S.ago.d, { n: Math.floor(min / 1440) });
}

// 待办旁的任务状态：只在任务还能查到时显示，点一下打开任务。
function linkChip(taskId) {
  const task = taskId && Array.isArray(taskList) ? taskList.find((x) => x.id === taskId) : null;
  if (!task) return null;
  const state = task.archived ? 'archived' : task.status;
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = `link-chip s-${state}`;
  chip.textContent = S.link[state] || S.link.idle;
  chip.title = `${S.link.open}: ${task.title}`;
  chip.addEventListener('click', () => openTask(task.id));
  return chip;
}

const openTask = (taskId) => call('openTask', { taskId }).catch((err) => toast(fmt(S.failed, { m: err.message })));

function taskItem(task) {
  const li = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ghost task-item';
  button.title = task.title;
  const title = document.createElement('span');
  title.className = 't';
  title.textContent = task.title;
  const meta = document.createElement('small');
  meta.textContent = `${AGENT_NAMES[task.agentKind] || task.agentKind} · ${ago(task.lastActivityAt)}`;
  if (task.status === 'error') {
    const err = document.createElement('span');
    err.className = 'err';
    err.textContent = ` · ${S.errored}`;
    meta.append(err);
  }
  button.append(title, meta);
  button.addEventListener('click', () => openTask(task.id));
  li.append(button);
  return li;
}

function renderTasks() {
  renderAskWarn();
  const body = $('task-body');
  body.replaceChildren();
  $('task-count').textContent = '';
  if (!taskList) return;
  if (taskList.error) {
    const message = taskList.error === 'OBSERVE_UNSUPPORTED' ? S.tasksUnsupported
      : taskList.error === 'PERMISSION_DENIED' ? S.tasksDenied : fmt(S.failed, { m: taskList.error });
    body.innerHTML = `<p class="empty">${esc(message)}</p>`;
    return;
  }
  const active = taskList.filter((t) => !t.archived);
  const archived = taskList.filter((t) => t.archived);
  $('task-count').textContent = String(active.length);
  if (!taskList.length) {
    body.innerHTML = `<p class="empty">${esc(S.tasksEmpty)}</p>`;
    return;
  }
  const columns = document.createElement('div');
  columns.className = 'columns';
  for (const key of ['attention', 'running', 'done', 'idle']) {
    const items = active.filter((t) => COLUMN_OF[t.status] === key);
    const column = document.createElement('div');
    column.className = 'column';
    const head = document.createElement('h3');
    head.textContent = `${S.columns[key]} ${items.length}`;
    const ul = document.createElement('ul');
    ul.dataset.keep = `tasks:${key}`;
    if (items.length) ul.append(...items.map(taskItem));
    else ul.innerHTML = `<li class="empty">${esc(S.columnEmpty)}</li>`;
    column.append(head, ul);
    columns.append(column);
  }
  body.append(columns);
  if (archived.length) {
    const details = document.createElement('details');
    details.className = 'archived';
    details.dataset.keep = 'tasks:archived';
    const summary = document.createElement('summary');
    summary.textContent = fmt(S.archivedN, { n: archived.length });
    const ul = document.createElement('ul');
    ul.className = 'archived-list';
    ul.dataset.keep = 'tasks:archived-list';
    ul.append(...archived.map(taskItem));
    details.append(summary, ul);
    body.append(details);
  }
}

function render() {
  $('board').hidden = false;
  withKept(() => {
    renderTasks();
    renderIntro();
    renderTodos();
    renderCandidates();
    renderLibrary();
    renderFiles();
    renderShare();
    renderGit();
  });
}

// ---------- 操作 ----------
async function load() {
  if (view === 'all') return loadOverview();
  if (!current) return;
  $('overview').hidden = true;
  $('path').hidden = false;
  $('path').textContent = current.id;
  const dir = current.id;
  // 任务列表失败（旧版 Cindy、未授权）不影响项目资料的展示。
  const [snapshot, tasks] = await Promise.allSettled([call('snapshot', { dir }), call('tasks', { dir })]);
  if (current?.id !== dir) return;
  taskList = tasks.status === 'fulfilled' ? tasks.value : { error: tasks.reason.code || tasks.reason.message };
  if (snapshot.status === 'rejected') {
    notice(fmt(S.failed, { m: snapshot.reason.message }));
    return;
  }
  snap = snapshot.value;
  notice('');
  render();
  loadShare(false).catch(() => {});
  // 当前项目的待办数和改动数直接用刚读到的资料，不再跑一遍 git
  const open = snap.todos.filter((t) => !t.done).length;
  stats.set(dir, { tasks: Array.isArray(taskList) ? taskList : null, summary: { openTodos: open, candidates: snap.candidates.length, git: snap.git && { branch: snap.git.branch, changedFiles: snap.git.changedFiles } } });
  loadStats(false).catch(() => {});
}

// 只重读任务（任务事件触发时用）；资料和 Git 不动，省掉 Node 进程读文件和跑 git。
async function loadTasks() {
  if (view === 'all') return loadOverview();
  if (!current || !snap) return load();
  const dir = current.id;
  let next;
  try {
    next = await call('tasks', { dir });
  } catch (err) {
    next = { error: err.code || err.message };
  }
  loadStats(false).catch(() => {});
  if (view !== 'project' || current?.id !== dir) return;
  taskList = next;
  withKept(() => {
    renderTasks();
    renderTodos();
  });
}

// change：{done} 勾选、{text} 改文字、{remove:true} 删除。box 是触发勾选的复选框，失败时恢复原状。
async function updateTodo(todo, change, box) {
  if (box) box.disabled = true;
  try {
    const dir = current.id;
    const res = await call('updateTodo', { dir, line: todo.line, text: todo.text, change });
    if (!res.ok) toast(S.changed);
    else if (change.remove || change.text !== undefined) {
      updateLinks(dir, (links) => {
        const taskId = links[todo.text];
        delete links[todo.text];
        if (taskId && change.text !== undefined) links[change.text.replace(/\s+/g, ' ').trim()] = taskId;
      });
    }
  } catch (err) {
    if (box) box.checked = !box.checked;
    toast(fmt(S.failed, { m: err.message }));
  } finally {
    if (box) box.disabled = false;
  }
  await load();
}

async function addTodo(event) {
  event.preventDefault();
  const input = $('todo-new');
  const text = input.value.trim();
  if (!text || !current) return;
  input.disabled = true;
  try {
    await call('addTodo', { dir: current.id, text });
    input.value = '';
    await load();
  } catch (err) {
    toast(fmt(S.failed, { m: err.message }));
  } finally {
    input.disabled = false;
    input.focus();
  }
}

// 查看弹窗：body 是要显示的节点，acts 是底部按钮。
function showViewer(title, body, acts) {
  $('viewer-title').textContent = title;
  $('viewer-body').replaceChildren(body);
  $('viewer-actions').replaceChildren(...acts);
  if (!$('viewer').open) $('viewer').showModal();
}
function closeButton() {
  const b = document.createElement('button');
  b.value = 'close';
  b.className = 'ghost';
  b.textContent = S.close;
  return b;
}
function mdBody(doc) {
  const div = document.createElement('div');
  div.className = 'md scroll';
  div.innerHTML = markdown(doc.content) + (doc.truncated ? `<p class="empty">${esc(S.truncated)}</p>` : '');
  return div;
}

// README、AGENTS.md、CLAUDE.md：查看时可以切到编辑。超过 100 KB 只读到一部分，不让编辑，免得保存时截断。
function openViewer(id) {
  const doc = snap.docs[id];
  showViewer(snap.paths[id], mdBody(doc), [...(doc.truncated ? [] : [todoButton(S.edit, () => editDoc(id, doc.content))]), closeButton()]);
}

function editDoc(id, content) {
  let expected = content; // 打开编辑时读到的内容；文件被别处改过时换成最新内容，再点保存就是有意覆盖
  const area = document.createElement('textarea');
  area.className = 'doc-edit';
  area.value = content;
  const save = todoButton(S.save, async () => {
    save.disabled = true;
    try {
      const res = await call('writeDoc', { dir: current.id, id, content: area.value, expected });
      if (!res.ok) {
        expected = (await call('snapshot', { dir: current.id })).docs[id]?.content ?? '';
        toast(S.docChanged);
        return;
      }
      toast(fmt(S.docSaved, { f: snap.paths[id] }));
      $('viewer').close();
      await load();
    } catch (err) {
      toast(fmt(S.failed, { m: err.message }));
    } finally {
      save.disabled = false;
    }
  }, 'primary');
  showViewer(snap.paths[id], area, [todoButton(S.cancel, () => openViewer(id)), save]);
  area.focus();
  area.setSelectionRange(0, 0);
}

function openAsk(next) {
  ask = next;
  $('ask-title').textContent = next.heading;
  $('ask-hint').textContent = next.hint || S.askHint;
  $('ask-text').value = next.text;
  $('ask-send').disabled = !next.text.trim();
  $('ask').showModal();
  renderAskWarn(); // 先按手上的任务列表显示，再重读一次；之后任务状态变化时由 renderTasks 更新
  loadTasks().catch(() => {});
}

// 新任务可能和哪些任务共用目录时才提醒。从待办开始的任务在 git 项目里有独立 worktree，既不用提醒，
// 也不算手写任务的冲突对象。待确认的任务确认后还会接着改文件，也算没结束。读不到任务列表时不提醒。
function askWarnText() {
  if (!$('ask').open || !snap || !Array.isArray(taskList)) return '';
  if (!ask.todos && !ask.manual) return '';
  // 和 createWorktree 同一判据：不是 git 仓库或还没有提交时建不了 worktree。
  const canIsolate = snap.git?.commits.length > 0;
  if (ask.todos && canIsolate) return '';
  const inWorktree = new Set(canIsolate ? Object.values(linksFor(current.id)) : []);
  const n = taskList.filter((t) => !t.archived && (t.status === 'running' || t.status === 'awaiting') && !inWorktree.has(t.id)).length;
  if (!n) return '';
  return fmt(ask.todos ? S.noWorktreeWarn : canIsolate ? S.manualGitWarn : S.manualNoGitWarn, { n });
}

function renderAskWarn() {
  const text = askWarnText();
  $('ask-warn').textContent = text;
  $('ask-warn').hidden = !text;
}
const openAiAsk = (kind) => openAsk({ heading: S.titles[kind], title: S.titles[kind], text: fmt(S.prompts[kind], { dir: current.id }) });

$('ask').addEventListener('close', async () => {
  if ($('ask').returnValue !== 'send' || !ask || !current) return;
  const text = $('ask-text').value.trim();
  if (!text) return;
  const project = current;
  const sending = ask; // 发送期间可能又打开新的提问框，这里固定本次的内容
  const firstLine = text.split('\n')[0];
  let worktree = null;
  try {
    // 宿主不能指定新任务的工作目录，只能在提示词里告诉任务去哪做。建不成就报错，不退回共用主工作目录。
    if (sending.todos) worktree = await call('createWorktree', { dir: project.id });
    const res = await call('askAi', {
      dir: project.id,
      title: sending.title || (firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine),
      text: worktree ? `${text}\n\n${fmt(S.worktreePrompt, { ...worktree, dir: project.id })}` : text,
      requestKey: `ask-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    });
    if (sending.todos && res?.taskId) updateLinks(project.id, (links) => { for (const t of sending.todos) links[t] = res.taskId; });
    toast(fmt(S.sent, { p: project.label }));
    sending.onSent?.();
    if (view === 'project' && current?.id === project.id) loadTasks();
  } catch (err) {
    // 任务可能已经建好时（结果不确定）留着 worktree，别把它脚下的目录抽走。
    if (worktree && err.code !== 'DELIVERY_UNCERTAIN' && err.code !== 'TIMEOUT')
      call('removeWorktree', { dir: project.id, name: worktree.name }).catch(() => {});
    toast(S.sendErrors[err.code] || fmt(S.failed, { m: err.message }));
  }
});

// ---------- 公开访问：把项目的本地端口映射到公网 ----------
// 隧道用这台电脑上已装的 cloudflared / tailscale 建立（在 node/tunnel.cjs 里）；这里只选方式、填参数、显示地址。
// 只走 HTTPS 的方式；没装的工具只提示需要用户自己先装好，插件不提供安装。
const SHARE_MODES = [['cloudflare-quick', 'cloudflared'], ['cloudflare', 'cloudflared'], ['tailscale', 'tailscale']];
const TOOL_OF = Object.fromEntries(SHARE_MODES);
let share = null; // 这台电脑上的隧道 { tunnels, projects, loggingIn }；读不到时为 { error }
let shareTools = null; // 检测到的工具；null = 需要重新检测
let shareDraft = null; // 当前项目表单里填的内容；切换项目时清空
let shareBusy = false;
let cfLoginUrl = null;

const tunnelOf = (dir) => share?.tunnels?.find((t) => t.dir === dir);
const isPublic = (dir) => tunnelOf(dir)?.state === 'online';

async function loadShare(withTools) {
  const wasLoggingIn = share?.loggingIn;
  const [state, tools] = await Promise.allSettled([call('tunnelList'), withTools || !shareTools ? call('tunnelTools') : shareTools]);
  share = state.status === 'fulfilled' ? state.value : { error: state.reason.message };
  if (tools.status === 'fulfilled') shareTools = tools.value;
  // Cloudflare 登录结束（浏览器里授权完或放弃）后重新检测一次，才知道登没登上。
  if (wasLoggingIn && !share.loggingIn) {
    cfLoginUrl = null;
    shareTools = await call('tunnelTools').catch(() => shareTools);
  }
  renderRail();
  if (view === 'project' && snap) renderShare();
}

function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function copyText(value, message = S.share.copied) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    // 嵌入页里剪贴板接口可能不可用，退回旧办法
    const area = h('textarea');
    area.value = value;
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  toast(message);
}
const openLink = (url) => call('openUrl', { url }).catch((err) => toast(fmt(S.failed, { m: err.message })));

function shareField(label, input) {
  const box = h('label', 'share-field');
  box.append(h('span', '', label), input);
  return box;
}
function draftInput(key, { type = 'text', placeholder = '', onInput } = {}) {
  const input = h('input');
  input.type = type;
  input.placeholder = placeholder;
  input.value = shareDraft[key] ?? '';
  input.addEventListener('input', () => {
    shareDraft[key] = input.value;
    onInput?.();
  });
  return input;
}

const shareError = (error) => S.share.errors[error?.code] || S.share.errors.TOOL_FAILED;

// 正在填写时不被自动刷新冲掉；用户自己的操作传 force。
function renderShare(force) {
  const body = $('share-body');
  if (!force && body.contains(document.activeElement) && document.activeElement.matches('input, select')) return;
  const tunnel = tunnelOf(current.id);
  $('share-state').textContent = tunnel?.state === 'online' ? S.share.online : '';
  body.replaceChildren();
  if (share?.error) body.append(h('p', 'empty', fmt(S.failed, { m: share.error })));
  else if (!share || !shareTools) body.append(h('p', 'empty', S.share.checking));
  else if (tunnel) renderTunnel(body, tunnel);
  else renderShareForm(body);
}

function renderTunnel(body, t) {
  const mode = S.share.modes[t.mode];
  const acts = h('div', 'actions');
  if (t.state === 'starting') {
    body.append(h('p', 'meta', fmt(S.share.starting, { mode: mode.name })));
    acts.append(todoButton(S.share.stop, stopShare));
  } else if (t.state === 'online') {
    const row = h('div', 'share-url');
    const link = h('button', 'share-link', t.url);
    link.type = 'button';
    link.title = S.share.openInBrowser;
    link.addEventListener('click', () => openLink(t.url));
    row.append(link, todoButton(S.share.copy, () => copyText(t.url), 'ghost small'));
    body.append(row);
    const codeRow = h('div', 'share-key');
    codeRow.append(h('span', '', fmt(S.share.code, { c: t.code })), todoButton(S.share.copyCode, () => copyText(t.code), 'ghost small'));
    const inviteRow = h('div', 'share-acts');
    inviteRow.append(todoButton(S.share.invite, copyInvite));
    body.append(codeRow, inviteRow, h('p', 'meta', S.share.accessHint));
    body.append(h('p', 'meta', fmt(S.share.onlineMeta, { port: t.port, mode: mode.name, t: ago(t.startedAt) })));
    if (mode.note) body.append(h('p', 'meta', mode.note));
    acts.append(todoButton(S.share.stop, stopShare));
  } else {
    body.append(h('p', 'warn', shareError(t.error)));
    if (t.error?.actionUrl) acts.append(todoButton(S.share.openAction, () => openLink(t.error.actionUrl)));
    if (t.error?.message && t.error.message !== t.error.code) {
      const details = h('details', 'share-log');
      details.append(h('summary', '', S.share.details), h('pre', '', t.error.message));
      body.append(details);
    }
    acts.append(todoButton(S.share.dismiss, stopShare), todoButton(S.share.retry, () => confirmShare(t.mode, share.projects?.[t.dir]?.port ?? t.port), 'primary'));
  }
  body.append(acts);
}

function defaultMode() {
  return (SHARE_MODES.find(([, tool]) => shareTools[tool]?.installed) || SHARE_MODES[0])[0];
}

function renderShareForm(body) {
  const saved = share.projects?.[current.id] || {};
  shareDraft ||= {
    mode: TOOL_OF[saved.mode] ? saved.mode : defaultMode(), port: saved.port ? String(saved.port) : '',
    hostname: saved.hostname || '',
  };
  const d = shareDraft;
  const tool = TOOL_OF[d.mode];
  const info = shareTools[tool];
  const form = h('div', 'share-form');
  body.append(form);

  const select = h('select');
  for (const [id, t] of SHARE_MODES) {
    select.append(new Option(shareTools[t]?.installed ? S.share.modes[id].name : fmt(S.share.notInstalledTag, { m: S.share.modes[id].name }), id));
  }
  select.value = d.mode;
  select.addEventListener('change', () => { d.mode = select.value; renderShare(true); });
  form.append(shareField(S.share.mode, select), h('p', 'meta', S.share.modes[d.mode].hint));

  if (!info?.installed) {
    const acts = h('div', 'share-acts');
    acts.append(todoButton(S.share.recheck, () => loadShare(true)));
    form.append(h('p', 'warn', fmt(S.share.notInstalled, { t: tool })), acts);
    return;
  }

  const start = todoButton(shareBusy ? S.share.startingShort : S.share.start, () => confirmShare(d.mode, d.port), 'primary');
  const ready = () => {
    const port = Number(d.port);
    let ok = Number.isInteger(port) && port > 0 && port < 65536;
    if (d.mode === 'cloudflare') ok &&= shareTools.cloudflared.loggedIn && Boolean(d.hostname.trim());
    if (d.mode === 'tailscale') ok &&= shareTools.tailscale.running;
    start.disabled = shareBusy || !ok;
  };
  form.append(shareField(S.share.port, draftInput('port', { type: 'number', placeholder: '5173', onInput: ready })));

  if (d.mode === 'cloudflare') renderCloudflare(form, ready);
  if (d.mode === 'tailscale') {
    form.append(shareTools.tailscale.running
      ? h('p', 'meta', fmt(S.share.tsHost, { h: shareTools.tailscale.host || '' }))
      : h('p', 'warn', S.share.tsNotRunning));
  }

  const acts = h('div', 'actions');
  acts.append(start);
  form.append(acts);
  ready();
}

function renderCloudflare(form, ready) {
  const cf = shareTools.cloudflared;
  if (cf.loggedIn) {
    form.append(shareField(S.share.hostname, draftInput('hostname', { placeholder: 'demo.example.com', onInput: ready })), h('p', 'meta', S.share.hostnameHint));
    return;
  }
  form.append(h('p', 'meta', share.loggingIn ? S.share.cfWaiting : S.share.cfLoginHint));
  const acts = h('div', 'share-acts');
  if (share.loggingIn && cfLoginUrl) acts.append(todoButton(S.share.cfOpenAgain, () => openLink(cfLoginUrl)));
  if (!share.loggingIn) acts.append(todoButton(S.share.cfLogin, cloudflareLogin));
  acts.append(todoButton(S.share.recheck, () => loadShare(true)));
  form.append(acts);
}

// 公开前说清楚公开的是什么、有什么风险，用户勾选确认后才开始。
function confirmShare(mode, port) {
  $('share-confirm-title').textContent = fmt(S.share.confirmTitle, { port });
  $('share-confirm-body').replaceChildren(...S.share.confirmPoints.map((point) => h('li', '', fmt(point, { port, via: S.share.modes[mode].via }))));
  $('share-confirm-check').checked = false;
  $('share-confirm-ok').disabled = true;
  $('share-confirm').onclose = () => {
    if ($('share-confirm').returnValue === 'ok' && $('share-confirm-check').checked) startShare(mode);
  };
  $('share-confirm').showModal();
}

async function copyInvite() {
  try {
    const { url } = await call('tunnelInvite', { dir: current.id });
    await copyText(url, S.share.inviteCopied);
  } catch (err) {
    toast(S.share.errors[err.code] || fmt(S.failed, { m: err.message }));
  }
}

async function cloudflareLogin() {
  try {
    const res = await call('tunnelLogin');
    if (res.url) {
      cfLoginUrl = res.url;
      toast(S.share.cfOpened);
    }
  } catch (err) {
    toast(fmt(S.failed, { m: S.share.errors[err.code] || err.message }));
  }
  await loadShare(true);
}

async function startShare(mode) {
  const dir = current.id;
  const saved = share.projects?.[dir] || {};
  // 重试时表单不在页面上，用上次保存的设置。
  const d = shareDraft && shareDraft.mode === mode ? shareDraft : { ...saved, mode };
  shareBusy = true;
  renderShare(true);
  try {
    const res = await call('tunnelStart', {
      dir, mode, port: Number(d.port), hostname: d.hostname?.trim() || undefined,
    });
    if (res.state === 'online') toast(S.share.started);
  } catch (err) {
    // 等待超时只说明还没连上，隧道还在建，状态变化时会刷新。
    if (err.code !== 'TIMEOUT') toast(S.share.errors[err.code] || fmt(S.failed, { m: err.message }));
  } finally {
    shareBusy = false;
  }
  if (current?.id === dir) shareDraft = null;
  await loadShare(false);
}

async function stopShare() {
  try {
    await call('tunnelStop', { dir: current.id });
  } catch (err) {
    toast(fmt(S.failed, { m: err.message }));
  }
  await loadShare(false);
}

// ---------- 全部项目总览 ----------
const ATTENTION = new Set(['awaiting', 'error']);

async function loadOverview() {
  $('board').hidden = true;
  $('path').hidden = true;
  await Promise.all([loadStats(true), loadShare(false).catch(() => {})]);
  if (view !== 'all') return;
  notice('');
  redrawOverview();
}
const redrawOverview = () => withKept(() => renderOverview(projects.map((p) => ({ project: p, ...stats.get(p.id) }))));

// 读各项目的任务；full 时再读待办数和 Git 摘要（每个项目都要跑 git，只在整体刷新时读），否则沿用上次的。
async function loadStats(full) {
  await Promise.all(projects.map(async (p) => {
    const prev = stats.get(p.id);
    const [tasks, summary] = await Promise.allSettled([
      call('tasks', { dir: p.id }),
      full || !prev?.summary ? call('summary', { dir: p.id }) : prev.summary,
    ]);
    stats.set(p.id, { tasks: tasks.status === 'fulfilled' ? tasks.value : null, summary: summary.status === 'fulfilled' ? summary.value : null });
  }));
  renderRail();
}

function taskCounts(tasks) {
  const active = (tasks || []).filter((t) => !t.archived);
  return {
    attention: active.filter((t) => ATTENTION.has(t.status)).length,
    running: active.filter((t) => t.status === 'running').length,
    done: active.filter((t) => t.status === 'done').length,
    last: Math.max(0, ...(tasks || []).map((t) => t.lastActivityAt)),
  };
}

function renderRail() {
  document.body.classList.toggle('has-rail', projects.length > 1);
  if (projects.length < 2) return;
  const item = (id, label, badges) => {
    const b = document.createElement('button');
    b.type = 'button';
    const active = id === ALL ? view === 'all' : view === 'project' && current?.id === id;
    b.className = `rail-item${active ? ' active' : ''}`;
    if (active) b.setAttribute('aria-current', 'page');
    const name = document.createElement('span');
    name.className = 'rn';
    name.textContent = label;
    const line = document.createElement('span');
    line.className = 'rail-badges';
    line.append(...badges);
    b.title = label;
    b.append(name, line);
    b.addEventListener('click', () => switchTo(id));
    return b;
  };
  const badge = (cls, text) => {
    const span = document.createElement('span');
    span.className = cls;
    span.textContent = text;
    return span;
  };
  $('rail').replaceChildren(item(ALL, S.allProjects, []), ...projects.map((p) => {
    const { tasks, summary } = stats.get(p.id) || {};
    const c = tasks ? taskCounts(tasks) : null;
    const badges = [];
    if (c?.attention) badges.push(badge('dot attention', `${c.attention} ${S.columns.attention}`));
    if (c?.running) badges.push(badge('dot running', `${c.running} ${S.columns.running}`));
    if (c?.done) badges.push(badge('dot done', `${c.done} ${S.columns.done}`));
    // 没有进行中的任务（或宿主不提供任务）时，用待办数说明这个项目还有事
    if (!badges.length && summary?.openTodos) {
      badges.push(badge('', fmt(S.overview.todos, { n: summary.openTodos })));
    }
    if (isPublic(p.id)) badges.push(badge('dot public', S.share.badge));
    return item(p.id, p.label, badges);
  }));
}

function renderOverview(rows) {
  const box = $('overview');
  box.hidden = false;
  const cards = rows.map((row) => ({ ...row, ...taskCounts(row.tasks) }));
  // 等你处理的排最前，其次是正在跑的，再按最近活动排。
  cards.sort((a, b) => b.attention - a.attention || b.running - a.running || b.last - a.last);
  box.replaceChildren(...cards.map(projectCard));
}

function projectCard(row) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'card project-card';
  card.title = S.openProject;
  const head = document.createElement('div');
  head.className = 'pc-head';
  const name = document.createElement('strong');
  name.textContent = row.project.label;
  const where = document.createElement('small');
  where.textContent = row.project.detail || row.project.id;
  head.append(name, where);

  const badges = document.createElement('div');
  badges.className = 'pc-badges';
  const badge = (text, cls) => {
    const b = document.createElement('span');
    b.className = `pc-badge ${cls}`;
    b.textContent = text;
    badges.append(b);
  };
  if (!row.tasks && !row.summary) badge(S.overview.failed, 'muted');
  if (row.attention) badge(fmt(S.overview.attention, { n: row.attention }), 'attention');
  if (row.running) badge(fmt(S.overview.running, { n: row.running }), 'running');
  if (row.done) badge(fmt(S.overview.done, { n: row.done }), 'done');
  if (row.tasks && !row.attention && !row.running && !row.done) badge(S.overview.quiet, 'muted');
  if (isPublic(row.project.id)) badge(S.share.badge, 'public');
  if (row.summary?.candidates) badge(fmt(S.overview.candidates, { n: row.summary.candidates }), 'todos');
  if (row.summary) badge(row.summary.openTodos ? fmt(S.overview.todos, { n: row.summary.openTodos }) : S.overview.noTodos, row.summary.openTodos ? 'todos' : 'muted');

  const meta = document.createElement('small');
  meta.className = 'pc-meta';
  const git = row.summary?.git;
  meta.textContent = [
    git?.branch,
    git?.changedFiles ? fmt(S.overview.changes, { n: git.changedFiles }) : '',
    row.tasks ? (row.last ? fmt(S.overview.last, { t: ago(row.last) }) : S.overview.noTasks) : '',
  ].filter(Boolean).join(' · ');

  card.append(head, badges, meta);
  card.addEventListener('click', () => switchTo(row.project.id));
  return card;
}

// ---------- 切换项目 / 刷新 ----------
function switchTo(id) {
  $('project').value = id;
  kept.clear();
  editingIntro = null;
  introOpen = false;
  selected = null;
  shareDraft = null;
  if (id === ALL) view = 'all';
  else {
    view = 'project';
    if (current?.id !== id) { snap = null; taskList = null; }
    current = projects.find((p) => p.id === id);
  }
  remember(id);
  $('title').textContent = view === 'all' ? S.allProjects : current.label;
  renderRail();
  load();
}

// 正在改待办文字时不自动重绘，免得冲掉输入框（项目介绍编辑中由 renderIntro 自己跳过）。
const idle = () => !document.hidden && !document.activeElement?.matches('.todo input.edit');
let refreshTimer = null;
let refreshFull = false;
function scheduleRefresh(full) {
  refreshFull = refreshFull || full;
  clearTimeout(refreshTimer);
  // 页面在后台时不刷新，回到页面时会整体重读。
  if (document.hidden) return;
  refreshTimer = setTimeout(() => {
    if (!idle()) {
      refreshTimer = setTimeout(() => scheduleRefresh(false), 3000);
      return;
    }
    const all = refreshFull;
    refreshFull = false;
    (all ? load() : loadTasks()).catch(() => {});
  }, 800);
}

function remember(id) {
  try { localStorage.setItem('project-board:last', id); } catch { /* 存不了就不记 */ }
}
function recalled() {
  try { return localStorage.getItem('project-board:last'); } catch { return null; }
}

async function init() {
  const ctx = await (await fetch('/app-context')).json();
  lang = pickLang(ctx.context?.locale);
  S = STRINGS[lang];
  document.querySelectorAll('[data-t]').forEach((el) => { el.textContent = S[el.dataset.t]; });
  $('refresh').textContent = S.refresh;
  document.querySelector('[data-ai="todos"]').textContent = S.organize;
  document.querySelector('[data-ai="extract"]').textContent = S.extract;
  document.querySelectorAll('[data-ai]').forEach((el) => el.addEventListener('click', () => openAiAsk(el.dataset.ai)));
  $('task-new').addEventListener('click', () => openAsk({ heading: S.newTask, hint: S.newTaskHint, text: '', manual: true }));
  $('ask-text').addEventListener('input', () => { $('ask-send').disabled = !$('ask-text').value.trim(); });
  $('todo-new').placeholder = S.todoNew;
  $('todo-add').addEventListener('submit', addTodo);
  $('note-new').placeholder = S.noteNew;
  $('note-add').addEventListener('submit', addNote);
  $('intro-more').addEventListener('click', () => { introOpen = !introOpen; fitIntro(); });
  // 关掉弹窗时清空内容，停止 iframe 里还在播放的音视频。
  $('viewer').addEventListener('close', () => $('viewer-body').replaceChildren());
  $('file-upload').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', () => {
    const files = [...$('file-input').files];
    $('file-input').value = '';
    if (files.length && current) uploadFiles(files);
  });
  $('intro-edit').addEventListener('click', startIntroEdit);
  $('todo-select').addEventListener('click', toggleSelecting);
  $('todo-select-task').addEventListener('click', askForSelected);
  $('refresh').addEventListener('click', () => load());
  $('share-confirm-check').addEventListener('change', () => { $('share-confirm-ok').disabled = !$('share-confirm-check').checked; });

  try {
    projects = await call('projects');
  } catch (err) {
    notice(err.code === 'HOST_TOO_OLD' ? S.hostTooOld : fmt(S.failed, { m: err.message }));
    return;
  }
  if (!projects.length) {
    notice(S.noProjects);
    return;
  }
  const select = $('project');
  if (projects.length > 1) select.append(new Option(S.allProjects, ALL));
  for (const p of projects) select.append(new Option(p.label, p.id));
  select.addEventListener('change', () => switchTo(select.value));
  const last = recalled();
  current = projects.find((p) => p.id === last) || projects[0];
  // 多个项目时默认先看总览。
  switchTo(last === ALL || (!projects.some((p) => p.id === last) && projects.length > 1) ? ALL : current.id);
  // 任务事件到达时会立即刷新（见 channel.onmessage）；这里是兜底：
  // 自动化等不推送事件的任务每 30 秒重读一次，AI 在后台改的文件每 60 秒整体重读一次。
  document.addEventListener('visibilitychange', () => { if (idle()) load(); });
  // 用户可能刚去装了 cloudflared 等工具，回到页面时重新检测。
  document.addEventListener('visibilitychange', () => { if (!document.hidden) shareTools = null; });
  let tick = 0;
  setInterval(() => {
    tick += 1;
    if (!idle()) return;
    (tick % 2 === 0 ? load() : loadTasks()).catch(() => {});
    // 项目栏里其他项目的待办数和改动数也每 60 秒重读一次
    if (tick % 2 === 0 && view === 'project') loadStats(true).catch(() => {});
  }, 30000);
}

init();
