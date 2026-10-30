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
  updateTodo: (args) => node('project/update-todo', args),
  addTodo: (args) => node('project/add-todo', args),
  writeIntro: (args) => node('project/write-intro', args),
  tasks,
  openTask: ({ taskId }) => cindy.observe.openTask({ taskId }),
  askAi,
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
