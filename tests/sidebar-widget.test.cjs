// 侧栏状态条：在假宿主里运行 main.js，检查分组、跨项目汇总和宿主拒绝后的行为。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../project-board-plugin/main.js'), 'utf8');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run({ projects, send, locale = 'zh-CN' }) {
  let hostMessage;
  const sent = [];
  const cindy = {
    onHostMessage: (fn) => { hostMessage = fn; },
    request: async () => ({ ok: true, context: { locale } }),
    targets: { list: async () => ({ targets: Object.keys(projects).map((id) => ({ id, label: id, detail: id })) }) },
    observe: {
      projectTasks: async ({ project }) => {
        const result = projects[project];
        if (result instanceof Error) throw result;
        return { tasks: result };
      },
    },
    send: async (message) => {
      sent.push(message);
      return send ? send(message) : { ok: true };
    },
  };
  new Function('cindy', 'BroadcastChannel', source)(cindy, class { postMessage() {} });
  return { sent, event: (name) => hostMessage({ type: 'event', name }) };
}

const task = (id, status, lastActivityAt = 1, archived = false) => ({ id, status, lastActivityAt, archived });

test('跨项目按状态分组，最近活动排前，归档和空闲不算，出错的项目目录跳过', async () => {
  const { sent } = run({
    projects: {
      a: [task('a1', 'running', 1), task('a2', 'done'), task('a3', 'idle'), task('a4', 'done', 1, true)],
      b: [task('b1', 'running', 9), task('b2', 'awaiting'), task('b3', 'error')],
      gone: new Error('TARGET_UNAVAILABLE'),
    },
  });
  await wait(1100);
  assert.deepEqual(sent.at(-1), {
    type: 'sidebar-widget',
    groups: [
      { key: 'running', label: '运行中', tone: 'running', taskIds: ['b1', 'a1'] },
      { key: 'done', label: '刚完成', tone: 'done', taskIds: ['a2'] },
      { key: 'awaiting', label: '待确认', tone: 'awaiting', taskIds: ['b2'] },
      { key: 'error', label: '出错', tone: 'error', taskIds: ['b3'] },
    ],
  });
});

test('连续事件合并成一次上报，切换任务也会刷新，思考事件不会', async () => {
  const { sent, event } = run({ projects: { a: [] } });
  await wait(1100);
  assert.equal(sent.length, 1);
  event('did-thinking-start');
  await wait(1100);
  assert.equal(sent.length, 1);
  event('did-turn-end');
  event('did-session-switched');
  await wait(1100);
  assert.equal(sent.length, 2);
});

for (const [name, send] of [
  ['宿主拒绝', () => ({ ok: false, message: 'denied' })],
  ['旧版宿主抛错', () => { throw new Error('未知的管子消息类型'); }],
]) {
  test(`${name}后不再上报`, async () => {
    const { sent, event } = run({ projects: { a: [] }, send });
    await wait(1100);
    event('did-turn-end');
    await wait(1100);
    assert.equal(sent.length, 1);
  });
}
