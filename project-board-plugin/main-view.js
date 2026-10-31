'use strict';
// 项目看板主视图。所有宿主能力经电子脑（main.js）代办；这里只画界面、发请求。

const STRINGS = {
  'zh-CN': {
    refresh: '刷新', intro: '项目介绍', todos: '待办', files: '项目文件', tasks: '任务',
    columns: { attention: '待处理', running: '运行中', done: '刚完成', idle: '其他' },
    columnEmpty: '暂无', errored: '出错', archivedN: '已归档 {n} 个', tasksEmpty: '这个项目里还没有任务。',
    tasksUnsupported: '当前 Cindy 版本还不能给插件提供任务列表，更新 Cindy 后即可在这里按状态查看任务。',
    tasksDenied: '还没有允许查看任务。可在 Cindy 的插件详情页点「确认任务查看权限」。',
    ago: { now: '刚刚', m: '{n} 分钟前', h: '{n} 小时前', d: '{n} 天前' },
    introEmpty: '还没有项目介绍。让 AI 阅读项目后生成一份，保存在 .cindy/project.md，会随 git 提交。',
    todosEmpty: '还没有待办。让 AI 整理一份，保存在 .cindy/todos.md，会随 git 提交。',
    doneCount: '已完成 {n} 项', generate: '让 AI 生成', update: '让 AI 更新', create: '让 AI 创建', organize: '让 AI 整理',
    view: '查看', missing: '未创建', ready: '已创建', truncated: '（内容较长，只显示前 100 KB）',
    readme: 'README', agents: 'AGENTS.md', claude: 'CLAUDE.md', knowledge: '项目知识库',
    branch: '分支', changes: '未提交改动', changesN: '{n} 个文件', clean: '无', commits: '最近提交', worktrees: 'worktree',
    notGit: '这个目录不是 Git 仓库。',
    worktreesWarn: '.cindy-worktrees/ 没有被 git 忽略，在主目录执行 git add . 可能把 worktree 副本加进提交。',
    askHint: '确认或修改下面的提示词后发送，会在这个项目里新建一个任务并开始运行。', cancel: '取消', send: '发送到新任务', close: '关闭',
    sent: '已在「{p}」新建任务，可以在侧边栏的项目里查看进度。',
    sendErrors: {
      PERMISSION_DENIED: '项目看板还没有新建任务的权限，请在 Cindy 的插件详情页允许后再试。',
      TARGET_UNAVAILABLE: '这个项目在 Cindy 里已不可用，请刷新后重新选择项目。',
      DELIVERY_UNCERTAIN: '不确定任务是否已经创建。请先在侧边栏这个项目下确认，没有再重新发送，避免重复。',
      TIMEOUT: '等待太久没有结果，不确定任务是否已经创建。请先在侧边栏这个项目下确认，没有再重新发送，避免重复。',
    },
    noProjects: 'Cindy 里还没有项目。先在侧边栏添加一个项目文件夹。',
    hostTooOld: '当前 Cindy 版本不支持读取项目列表，请更新 Cindy。',
    changed: '待办文件刚被修改过，已重新读取，请再操作一次。', failed: '操作没有成功：{m}',
    edit: '编辑', save: '保存', add: '添加', remove: '删除', newTask: '新建任务', todoNew: '新增一条待办，回车添加',
    introChanged: '项目介绍刚在别处被修改过。你的内容还在编辑框里；再点一次保存会覆盖成你的版本，点取消可查看最新内容。',
    introSaved: '项目介绍已保存到 .cindy/project.md。',
    todoTaskHeading: '从待办新建任务',
    addEntry: '加入资料入口', entryReady: '已含资料入口', joiner: '；', period: '。',
    entryDone: { created: '新建了 AGENTS.md，写入项目资料入口', added: '已在 AGENTS.md 末尾加入项目资料入口', exists: 'AGENTS.md 已有项目资料入口' },
    claudeDone: { created: '新建了 CLAUDE.md 并导入 AGENTS.md', added: '在 CLAUDE.md 末尾导入了 AGENTS.md', exists: '' },
    select: '选择', selectedTask: '用选中的 {n} 条新建任务', manyTitle: '{t} 等 {n} 项',
    todosPrompt: '请完成这个项目里的以下待办：\n{list}\n\n这些待办来自 .cindy/todos.md，每完成一条就把它改成「- [x]」。',
    todoPrompt: '请完成这个项目里的一条待办：{t}\n\n这条待办来自 .cindy/todos.md，完成后请把它改成「- [x]」。',
    titles: { intro: '生成项目介绍', todos: '整理待办', agents: '维护 AGENTS.md', claude: '维护 CLAUDE.md', knowledge: '维护项目知识库' },
    prompts: {
      intro: '请阅读这个项目的代码和文档，写一份项目介绍，保存到 .cindy/project.md（已存在就更新）。内容包括：一句话定位、项目目标、主要功能、技术栈、目录结构、如何运行和测试。用简洁的 Markdown。这个文件会提交到 git、团队成员都能看到，不要写入密钥、Token 或个人信息。',
      todos: '请整理这个项目的待办清单，保存到 .cindy/todos.md（已存在就在原有基础上更新，保留已完成的条目）。来源可以是代码里的 TODO/FIXME、README 和文档里提到的计划，以及近期的改动。格式：每条一行，未完成写成「- [ ] 待办内容」，已完成写成「- [x] 待办内容」，可以用二级标题分组。这个文件会提交到 git，不要写入密钥、Token 或个人信息。',
      agents: '请根据这个项目当前的代码、目录结构和约定，创建或更新根目录的 AGENTS.md：写清项目结构、常用命令（安装、运行、测试）、代码风格和团队约定，方便 AI Agent 和新成员快速上手。保留文件里仍然有效的内容。',
      claude: '请创建或更新根目录的 CLAUDE.md。如果根目录已有 AGENTS.md，CLAUDE.md 只写一行「@AGENTS.md」引用它，避免两处重复维护；否则按 AGENTS.md 的写法整理项目结构、常用命令和团队约定。',
      knowledge: '请检查并更新 .cindy/project-knowledge/ 里的项目知识：按模块整理关键抽象、模块边界和注意事项，修正过期内容，并让 TOC.md 保持为索引。新任务启动时会自动读取 TOC.md，请保持精简。',
    },
  },
  en: {
    refresh: 'Refresh', intro: 'About This Project', todos: 'To-dos', files: 'Project Files', tasks: 'Tasks',
    columns: { attention: 'Needs you', running: 'Running', done: 'Just finished', idle: 'Other' },
    columnEmpty: 'None', errored: 'Error', archivedN: '{n} archived', tasksEmpty: 'No tasks in this project yet.',
    tasksUnsupported: 'This Cindy version cannot share tasks with plugins yet. Update Cindy to see tasks by status here.',
    tasksDenied: 'Viewing tasks is not allowed yet. Open this plugin\'s details in Cindy and choose "Review task viewing permission".',
    ago: { now: 'just now', m: '{n} min ago', h: '{n} h ago', d: '{n} d ago' },
    introEmpty: 'No project introduction yet. Ask AI to read the project and write one to .cindy/project.md, committed with git.',
    todosEmpty: 'No to-dos yet. Ask AI to compile them into .cindy/todos.md, committed with git.',
    doneCount: '{n} done', generate: 'Generate with AI', update: 'Update with AI', create: 'Create with AI', organize: 'Organize with AI',
    view: 'View', missing: 'Not created', ready: 'Created', truncated: '(Long file — showing the first 100 KB)',
    readme: 'README', agents: 'AGENTS.md', claude: 'CLAUDE.md', knowledge: 'Project Knowledge',
    branch: 'Branch', changes: 'Uncommitted', changesN: '{n} files', clean: 'None', commits: 'Recent commits', worktrees: 'Worktrees',
    notGit: 'This folder is not a Git repository.',
    worktreesWarn: '.cindy-worktrees/ is not ignored by git; running git add . in the main folder may commit the worktree copies.',
    askHint: 'Review or edit the prompt, then send it. A new session will start in this project.', cancel: 'Cancel', send: 'Send to New Session', close: 'Close',
    sent: 'Started a new session in "{p}". Follow it from the project in the sidebar.',
    sendErrors: {
      PERMISSION_DENIED: 'Project Board is not allowed to start sessions yet. Allow it in the plugin details in Cindy, then try again.',
      TARGET_UNAVAILABLE: 'This project is no longer available in Cindy. Refresh and choose the project again.',
      DELIVERY_UNCERTAIN: 'Not sure whether the session was created. Check this project in the sidebar first and only send again if it is missing, to avoid duplicates.',
      TIMEOUT: 'No answer in time, so the session may or may not have been created. Check this project in the sidebar first and only send again if it is missing, to avoid duplicates.',
    },
    noProjects: 'No projects in Cindy yet. Add a project folder from the sidebar first.',
    hostTooOld: 'This Cindy version cannot list projects for plugins. Please update Cindy.',
    changed: 'The to-do file just changed and was reloaded. Please try again.', failed: 'That did not work: {m}',
    edit: 'Edit', save: 'Save', add: 'Add', remove: 'Delete', newTask: 'New Session', todoNew: 'Add a to-do and press Enter',
    introChanged: 'The introduction was just changed elsewhere. Your text is still in the editor; save again to overwrite it with your version, or cancel to see the latest.',
    introSaved: 'Saved the introduction to .cindy/project.md.',
    todoTaskHeading: 'New session from to-do',
    addEntry: 'Add notes entry', entryReady: 'Notes entry included', joiner: '; ', period: '.',
    entryDone: { created: 'Created AGENTS.md with the project notes entry', added: 'Added the project notes entry to the end of AGENTS.md', exists: 'AGENTS.md already has the project notes entry' },
    claudeDone: { created: 'created CLAUDE.md importing AGENTS.md', added: 'added an AGENTS.md import to the end of CLAUDE.md', exists: '' },
    select: 'Select', selectedTask: 'New session with {n} selected', manyTitle: '{t} and {n} more',
    todosPrompt: 'Please complete these to-dos in the project:\n{list}\n\nThese items come from .cindy/todos.md. Change each one to "- [x]" when it is done.',
    todoPrompt: 'Please complete this to-do in the project: {t}\n\nThis item comes from .cindy/todos.md. When it is done, change it to "- [x]".',
    titles: { intro: 'Generate project introduction', todos: 'Organize to-dos', agents: 'Maintain AGENTS.md', claude: 'Maintain CLAUDE.md', knowledge: 'Maintain project knowledge' },
    prompts: {
      intro: "Read this project's code and docs and write a project introduction to .cindy/project.md (update it if it already exists). Cover: a one-line summary, goals, main features, tech stack, directory layout, and how to run and test it. Keep the Markdown concise. This file is committed to git and visible to the whole team, so do not include secrets, tokens, or personal information.",
      todos: "Compile this project's to-do list into .cindy/todos.md (if it already exists, update it and keep completed items). Sources can include TODO/FIXME comments, plans in the README and docs, and recent changes. Format: one item per line, \"- [ ] item\" for open items and \"- [x] item\" for completed ones; level-2 headings may group items. This file is committed to git, so do not include secrets, tokens, or personal information.",
      agents: "Based on this project's current code, layout, and conventions, create or update AGENTS.md at the repository root: describe the project structure, common commands (install, run, test), code style, and team conventions so AI agents and new teammates can get started quickly. Keep any content that is still accurate.",
      claude: 'Create or update CLAUDE.md at the repository root. If AGENTS.md already exists at the root, make CLAUDE.md a single line, "@AGENTS.md", so the two files are not maintained twice; otherwise write it the way AGENTS.md would be written.',
      knowledge: 'Review and update the project knowledge in .cindy/project-knowledge/: organize key abstractions, module boundaries, and caveats by module, fix outdated content, and keep TOC.md as the index. New sessions read TOC.md automatically, so keep it concise.',
    },
  },
};
const FILES = ['readme', 'agents', 'claude', 'knowledge'];
const AI_FILES = new Set(['agents', 'claude', 'knowledge']);

let S = STRINGS.en;
let lang = 'en';
let projects = [];
let current = null; // { id, label }
let snap = null;
let taskList = null; // null = 尚未读到；{ error } = 读取失败
let ask = null; // { heading, title, text }
let selected = null; // 多选模式下为选中待办的文字集合（按文字记，AI 改动文件导致行号变化时不丢），不在多选模式时为 null
let editingIntro = null; // 正在编辑时为打开编辑时读到的内容，保存时用来核对文件是否被别处改过

const $ = (id) => document.getElementById(id);
const fmt = (s, vars) => s.replace(/\{(\w+)\}/g, (_, k) => vars[k]);
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- 与电子脑通信：按 reqId 重发直到收到回执（电子脑按 reqId 去重） ----------
const channel = new BroadcastChannel('project-board');
const pending = new Map();
channel.onmessage = ({ data }) => {
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
  $('intro-edit').disabled = true;
  area.focus();
  area.setSelectionRange(0, 0);
  area.scrollTop = 0;
}

async function saveIntro(content, button) {
  button.disabled = true;
  try {
    const res = await call('writeIntro', { dir: current.id, content, expected: editingIntro });
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
    title: items.length === 1 ? first : fmt(S.manyTitle, { t: first, n: items.length }),
    text: fmt(S.todosPrompt, { list: items.map((t) => `- ${t.text}`).join('\n') }),
    onSent: () => { selected = null; renderTodos(); },
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
      const acts = document.createElement('span');
      acts.className = 'acts';
      if (selected) {
        // 多选时不显示单条操作
      } else if (!t.done) {
        acts.append(todoButton(S.newTask, () => openAsk({
          heading: S.todoTaskHeading,
          title: t.text.length > 60 ? `${t.text.slice(0, 60)}…` : t.text,
          text: fmt(S.todoPrompt, { t: t.text }),
        }), 'ai'));
      }
      if (!selected) {
        acts.append(
          todoButton(S.edit, () => editTodoText(t, text)),
          todoButton(S.remove, () => updateTodo(t, { remove: true }), 'ghost danger'),
        );
      }
      row.append(label, acts);
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
    const summary = document.createElement('summary');
    summary.textContent = fmt(S.doneCount, { n: done.length });
    details.append(summary);
    list(done, details);
    body.append(details);
  }
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
  button.addEventListener('click', () => call('openTask', { taskId: task.id }).catch((err) => toast(fmt(S.failed, { m: err.message }))));
  li.append(button);
  return li;
}

function renderTasks() {
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
    if (items.length) ul.append(...items.map(taskItem));
    else ul.innerHTML = `<li class="empty">${esc(S.columnEmpty)}</li>`;
    column.append(head, ul);
    columns.append(column);
  }
  body.append(columns);
  if (archived.length) {
    const details = document.createElement('details');
    details.className = 'archived';
    const summary = document.createElement('summary');
    summary.textContent = fmt(S.archivedN, { n: archived.length });
    const ul = document.createElement('ul');
    ul.className = 'archived-list';
    ul.append(...archived.map(taskItem));
    details.append(summary, ul);
    body.append(details);
  }
}

function render() {
  $('board').hidden = false;
  renderTasks();
  renderIntro();
  renderTodos();
  renderFiles();
  renderGit();
}

// ---------- 操作 ----------
async function load() {
  if (!current) return;
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
}

// change：{done} 勾选、{text} 改文字、{remove:true} 删除。box 是触发勾选的复选框，失败时恢复原状。
async function updateTodo(todo, change, box) {
  if (box) box.disabled = true;
  try {
    const res = await call('updateTodo', { dir: current.id, line: todo.line, text: todo.text, change });
    if (!res.ok) toast(S.changed);
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

function openViewer(id) {
  const doc = snap.docs[id];
  $('viewer-title').textContent = snap.paths[id];
  $('viewer-body').innerHTML = markdown(doc.content) + (doc.truncated ? `<p class="empty">${esc(S.truncated)}</p>` : '');
  $('viewer').showModal();
}

function openAsk(next) {
  ask = next;
  $('ask-title').textContent = next.heading;
  $('ask-text').value = next.text;
  $('ask').showModal();
}
const openAiAsk = (kind) => openAsk({ heading: S.titles[kind], title: S.titles[kind], text: S.prompts[kind] });

$('ask').addEventListener('close', async () => {
  if ($('ask').returnValue !== 'send' || !ask || !current) return;
  const text = $('ask-text').value.trim();
  if (!text) return;
  const project = current;
  const sending = ask; // 发送期间可能又打开新的提问框，这里固定本次的内容
  try {
    await call('askAi', {
      dir: project.id,
      title: sending.title,
      text,
      requestKey: `ask-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    });
    toast(fmt(S.sent, { p: project.label }));
    sending.onSent?.();
  } catch (err) {
    toast(S.sendErrors[err.code] || fmt(S.failed, { m: err.message }));
  }
});

function remember(id) {
  try { localStorage.setItem('project-board:last', id); } catch { /* 存不了就不记 */ }
}
function recalled() {
  try { return localStorage.getItem('project-board:last'); } catch { return null; }
}

async function init() {
  const ctx = await (await fetch('/app-context')).json();
  lang = STRINGS[ctx.context?.locale] ? ctx.context.locale : 'en';
  S = STRINGS[lang];
  document.querySelectorAll('[data-t]').forEach((el) => { el.textContent = S[el.dataset.t]; });
  $('refresh').textContent = S.refresh;
  document.querySelector('[data-ai="todos"]').textContent = S.organize;
  document.querySelectorAll('[data-ai]').forEach((el) => el.addEventListener('click', () => openAiAsk(el.dataset.ai)));
  $('todo-new').placeholder = S.todoNew;
  $('todo-add').addEventListener('submit', addTodo);
  $('intro-edit').addEventListener('click', startIntroEdit);
  $('todo-select').addEventListener('click', toggleSelecting);
  $('todo-select-task').addEventListener('click', askForSelected);
  $('refresh').addEventListener('click', load);

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
  for (const p of projects) select.append(new Option(p.label, p.id));
  current = projects.find((p) => p.id === recalled()) || projects[0];
  select.value = current.id;
  select.addEventListener('change', () => {
    current = projects.find((p) => p.id === select.value);
    editingIntro = null;
    selected = null;
    remember(current.id);
    load();
  });
  await load();
  // AI 在后台改文件：回到页面时刷新，停留期间每 20 秒刷新一次。
  // 正在改某条待办的文字时跳过，免得重绘冲掉输入框。
  const idle = () => !document.hidden && !document.activeElement?.matches('.todo input.edit');
  document.addEventListener('visibilitychange', () => { if (idle()) load(); });
  setInterval(() => { if (idle()) load(); }, 20000);
}

init();
