// 项目看板电子脑：主视图经 BroadcastChannel 发请求，这里转给 Cindy 宿主或随包 Node 进程。
// 项目目录只认 Cindy 已登记的项目（targets.list 返回值），别的路径一律拒绝，不交给 Node。
const channel = new BroadcastChannel('project-board');
const results = new Map(); // reqId → 已完成的回执；面板重发同一 reqId 时直接复用，不重复执行
const inFlight = new Set();
let knownProjects = new Set();

async function listProjects() {
  if (typeof cindy.targets?.list !== 'function') throw codeError('HOST_TOO_OLD');
  const { targets } = await cindy.targets.list({ targetKind: 'project' });
  knownProjects = new Set(targets.map((t) => t.id));
  return targets.map((t) => ({ id: t.id, label: t.label, detail: t.detail }));
}

async function requireProject(dir) {
  if (!knownProjects.has(dir)) await listProjects();
  if (!knownProjects.has(dir)) throw codeError('UNKNOWN_PROJECT');
}

async function node(method, params) {
  await requireProject(params.dir);
  const response = await cindy.node.request({ method, params, timeoutMs: 30000 });
  if (!response.ok) throw codeError('NODE_FAILED', response.message);
  return response.result;
}

// 任务列表走 Host 只读的 cindy.observe（需 agent.observe 权限）；旧版 Cindy 没有这个入口。
async function tasks({ dir }) {
  if (typeof cindy.observe?.projectTasks !== 'function') throw codeError('OBSERVE_UNSUPPORTED');
  await requireProject(dir);
  return (await cindy.observe.projectTasks({ project: dir })).tasks;
}

async function askAi({ dir, title, text, requestKey }) {
  await requireProject(dir);
  return cindy.targets.send({ target: { kind: 'project', id: dir }, requestKey, title, text });
}

const OPS = {
  projects: () => listProjects(),
  snapshot: ({ dir }) => node('project/snapshot', { dir }),
  summary: ({ dir }) => node('project/summary', { dir }),
  updateTodo: (args) => node('project/update-todo', args),
  addTodo: (args) => node('project/add-todo', args),
  addNote: (args) => node('project/add-note', args),
  removeNote: (args) => node('project/remove-note', args),
  readKnowledge: (args) => node('project/read-knowledge', args),
  removeFile: (args) => node('project/remove-file', args),
  uploadBegin: (args) => node('project/upload-begin', args),
  uploadChunk: (args) => node('project/upload-chunk', args),
  uploadFinish: (args) => node('project/upload-finish', args),
  uploadAbort: (args) => node('project/upload-abort', args),
  fileUrl: (args) => node('project/file-url', args),
  openFile: (args) => node('project/open-file', args),
  writeDoc: (args) => node('project/write-doc', args),
  addEntry: (args) => node('project/add-entry', args),
  acceptCandidate: (args) => node('project/accept-candidate', args),
  rejectCandidate: (args) => node('project/reject-candidate', args),
  tasks,
  openTask: ({ taskId }) => cindy.observe.openTask({ taskId }),
  askAi,
  createWorktree: (args) => node('project/create-worktree', args),
  removeWorktree: (args) => node('project/remove-worktree', args),
};

function codeError(code, message) {
  return Object.assign(new Error(message || code), { code });
}

channel.onmessage = async ({ data }) => {
  if (data?.type !== 'req' || !OPS[data.op]) return;
  const { reqId } = data;
  if (results.has(reqId)) return channel.postMessage(results.get(reqId));
  if (inFlight.has(reqId)) return;
  inFlight.add(reqId);
  let res;
  try {
    res = { type: 'res', reqId, ok: true, data: await OPS[data.op](data.args || {}) };
  } catch (err) {
    // 跨 contextBridge 抛出的错误会丢掉 code 属性，宿主把错误码同时放在 message 里。
    res = { type: 'res', reqId, ok: false, code: err.code || (/^[A-Z_]+$/.test(err.message) ? err.message : 'FAILED'), message: err.message };
  }
  inFlight.delete(reqId);
  results.set(reqId, res);
  if (results.size > 200) results.delete(results.keys().next().value);
  channel.postMessage(res);
};

// ---------- 侧栏状态条：跨项目的运行中、刚完成、待确认任务 ----------
const STATUS_LABELS = {
  'zh-CN': { running: '运行中', done: '刚完成', awaiting: '待确认', error: '出错' },
  en: { running: 'Running', done: 'Finished', awaiting: 'Needs you', error: 'Error' },
  ja: { running: '実行中', done: '完了', awaiting: '要確認', error: 'エラー' },
  ko: { running: '실행 중', done: '완료', awaiting: '확인 필요', error: '오류' },
};
let widgetLabels = STATUS_LABELS.en;
let widgetTimer = null;
let widgetRunning = false;
let widgetDirty = false; // 统计期间又来了事件，结束后再报一次
let widgetRetired = false; // 宿主不支持这个能力时不再重试

function onWidgetError(err) {
  if (/HOST_NOT_READY/.test(err.message)) setTimeout(scheduleSidebarWidget, 5000); // 启动时数据库可能还没好
  else widgetRetired = true;
}

async function publishSidebarWidget() {
  const byStatus = new Map(Object.keys(STATUS_LABELS.en).map((status) => [status, []]));
  for (const { id } of await listProjects()) {
    // 目录被删的项目跳过，不影响其它项目。
    const list = await tasks({ dir: id }).catch((err) => {
      if (/TARGET_UNAVAILABLE/.test(err.message)) return [];
      throw err;
    });
    for (const task of list) {
      if (!task.archived) byStatus.get(task.status)?.push(task);
    }
  }
  const groups = [...byStatus].filter(([, list]) => list.length > 0).map(([status, list]) => ({
    key: status,
    label: widgetLabels[status],
    tone: status,
    taskIds: list.sort((a, b) => b.lastActivityAt - a.lastActivityAt).slice(0, 50).map((task) => task.id),
  }));
  // 被拒（如权限被撤）不当成永久失败，下一个事件再试；旧版宿主不认识这条消息会抛错，走 onWidgetError。
  await cindy.send({ type: 'sidebar-widget', groups });
}

function scheduleSidebarWidget() {
  if (widgetRetired || widgetTimer) return;
  if (widgetRunning) {
    widgetDirty = true;
    return;
  }
  // 统计串行，下一次至少隔 1 秒，所以两次上报不会撞上宿主 500 毫秒的限速。
  widgetTimer = setTimeout(async () => {
    widgetTimer = null;
    widgetRunning = true;
    await publishSidebarWidget().catch(onWidgetError);
    widgetRunning = false;
    if (widgetDirty) {
      widgetDirty = false;
      scheduleSidebarWidget();
    }
  }, 1000);
}

async function startSidebarWidget() {
  const app = await cindy.request({ kind: 'app-context' });
  widgetLabels = STATUS_LABELS[app.context?.locale] || STATUS_LABELS.en;
  scheduleSidebarWidget();
}

// ---------- 给 Agent 调用的工具（伙伴经 ghost_call 记待办、存资料） ----------
const TOOL_ERRORS = {
  UNKNOWN_PROJECT: 'This project is not registered in Cindy. Call list_projects and use one of the returned ids.',
  ITEM_NOT_FOUND: 'The item was not found, or more than one item matches. Nothing was changed. Check the to-do list or notes before retrying.',
  INVALID_ITEM: 'Pass the item object returned by add_todo or add_note, or {kind:"todo", text}.',
};

// 写入前重读项目列表：项目刚从 Cindy 移除时不能再写。
async function write(method, project, params) {
  await listProjects();
  const result = await node(method, { dir: project, ...params });
  if (result.ok === false) throw codeError('ITEM_NOT_FOUND');
  channel.postMessage({ type: 'event', name: 'board-changed', dropped: 0 });
  return result;
}

const TOOLS = {
  async list_projects() {
    const list = [];
    // 逐个读：单插件的在途 Node 请求有上限，项目再多也不会超。
    for (const { id, label } of await listProjects()) {
      list.push({ id, name: label, intro: (await node('project/brief', { dir: id })).intro });
    }
    return { projects: list };
  },
  async add_todo({ project, text }) {
    const { item } = await write('project/add-todo', project, { text });
    return { project, item: { kind: 'todo', ...item } };
  },
  async add_note({ project, text }) {
    const { id } = await write('project/add-note', project, { text });
    return { project, item: { kind: 'note', id } };
  },
  async remove_item({ project, item }) {
    if (item?.kind === 'todo') await write('project/update-todo', project, { line: item.line, text: item.text, change: { remove: true } });
    else if (item?.kind === 'note') await write('project/remove-note', project, { id: item.id });
    else throw codeError('INVALID_ITEM');
    return { project, removed: true };
  },
  async propose_knowledge({ project, kind, file, text, replaces, evidence }) {
    const { id } = await write('project/propose-knowledge', project, { kind, file, text, replaces, evidence });
    return { project, id };
  },
};

async function runTool({ callId, tool, args }) {
  try {
    cindy.send({ type: 'tool-result', callId, ok: true, result: await TOOLS[tool](args || {}) });
  } catch (err) {
    const known = TOOL_ERRORS[err.code];
    cindy.send({ type: 'tool-result', callId, ok: false, errorCode: known ? err.code : 'TOOL_FAILED', message: known || err.message });
  }
}

// 任务事件（只有元数据，不含内容）转给主视图，主视图据此及时刷新。
// 思考开始/结束太频繁、切换任务只是用户换了个任务看，都不改变状态，不转。
cindy.onHostMessage((msg) => {
  if (msg?.type === 'tool-call') return runTool(msg);
  if (msg?.type === 'host-context-changed' && msg.context?.locale) {
    widgetLabels = STATUS_LABELS[msg.context.locale] || STATUS_LABELS.en;
    return scheduleSidebarWidget();
  }
  if (msg?.type !== 'event' || msg.name?.startsWith('did-thinking-')) return;
  scheduleSidebarWidget(); // 切换任务不用刷新看板，但看过「刚完成」的任务后状态条要变
  if (msg.name === 'did-session-switched') return;
  channel.postMessage({ type: 'event', name: msg.name, dropped: msg.dropped || 0 });
});

startSidebarWidget().catch(onWidgetError);
