// 侧栏状态条：在假宿主里运行 main.js，检查分组、跨项目汇总和宿主拒绝后的行为。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../project-board-plugin/main.js'), 'utf8');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run({ projects, send, locale = 'zh-CN', statDelays = [] }) {
  let hostMessage;
  const sent = [];
  const stats = { running: 0, maxRunning: 0 };
  const cindy = {
    onHostMessage: (fn) => { hostMessage = fn; },
    request: async () => ({ ok: true, context: { locale } }),
    targets: { list: async () => ({ targets: Object.keys(projects).map((id) => ({ id, label: id, detail: id })) }) },
    observe: {
      projectTasks: async ({ project }) => {
        stats.running += 1;
        stats.maxRunning = Math.max(stats.maxRunning, stats.running);
        await wait(statDelays.shift() ?? 0);
        stats.running -= 1;
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
  return { sent, stats, event: (name) => hostMessage({ type: 'event', name }) };
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

test('统计很慢时不重叠，上报间隔大于宿主限速，期间的事件不丢', async () => {
  const projects = { a: [task('a1', 'running')] };
  const times = [];
  const { sent, stats, event } = run({
    projects,
    statDelays: [1200],
    send: () => {
      times.push(Date.now());
      return times.length > 1 && times.at(-1) - times.at(-2) < 500 ? { ok: false, message: 'too fast' } : { ok: true };
    },
  });
  await wait(1100); // 第一次统计进行中
  projects.a = [task('a1', 'done')];
  event('did-turn-end');
  await wait(2500);
  assert.equal(stats.maxRunning, 1);
  assert.equal(sent.length, 2);
  assert.ok(times[1] - times[0] >= 500, `间隔只有 ${times[1] - times[0]} 毫秒`);
  assert.equal(sent.at(-1).groups[0].key, 'done');
});

test('宿主拒绝一次后，下一个事件还会上报', async () => {
  let rejected = false;
  const { sent, event } = run({
    projects: { a: [] },
    send: () => {
      if (rejected) return { ok: true };
      rejected = true;
      return { ok: false, message: 'denied' };
    },
  });
  await wait(1100);
  event('did-turn-end');
  await wait(1100);
  assert.equal(sent.length, 2);
});

test('旧版宿主抛错后不再上报', async () => {
  const { sent, event } = run({ projects: { a: [] }, send: () => { throw new Error('未知的管子消息类型'); } });
  await wait(1100);
  event('did-turn-end');
  await wait(1100);
  assert.equal(sent.length, 1);
});
