/**
 * 工具层的会话边界测试。
 *
 * 插件索引的第二次复核要求：模型不能借 offpeak 工具向任意已知会话投递指令
 * 并唤醒 Agent。这里用假 guard 验证工具在进入业务逻辑前就把跨会话请求拒掉，
 * 并确认默认目标始终是调用者自己的会话。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const { createOffpeakTools } = await import('../lib/tools.js');

const CALLER = 'session-a';
const OTHER = 'session-b';

function fakeGuard() {
  const calls = [];
  const desc = () => ({
    phase: 'offpeak',
    next: { phase: 'peak', label: '09:00', inMs: 1000 },
    localTime: '2026-11-15 01:00',
    weekday: '周日',
    timezone: 'Asia/Shanghai',
    presetLabel: 'DeepSeek 官方',
    holiday: false,
  });
  const guard = {
    options: { pollMs: 15000 },
    calls,
    describe: desc,
    async status() {
      return {
        desc: desc(),
        snapshot: {
          plans: [
            { id: 'mine', title: '当前会话的规划', sessionId: CALLER, createdBySessionId: CALLER, hasPrompt: true },
            { id: 'other', title: '别的会话的规划', sessionId: OTHER, createdBySessionId: OTHER, hasPrompt: true },
            { id: 'legacy', title: '当前会话的旧规划', sessionId: CALLER, createdBySessionId: null, hasPrompt: true },
          ],
          interrupted: [
            { id: 'p1', sessionId: CALLER, title: '当前会话暂停', status: 'paused' },
            { id: 'w1', sessionId: CALLER, title: '当前会话等待', status: 'waiting-turn' },
            { id: 'p2', sessionId: OTHER, title: '别的会话暂停', status: 'paused' },
          ],
          exemptSessions: [
            { sessionId: CALLER, title: '当前会话' },
            { sessionId: OTHER, title: '别的会话' },
          ],
          heldMessages: [
            { id: 'h1', sessionId: CALLER, title: '当前会话挂起' },
            { id: 'h2', sessionId: OTHER, title: '别的会话挂起' },
          ],
          sessions: {
            [CALLER]: { title: '当前会话' },
            [OTHER]: { title: '别的会话' },
          },
          counts: { plans: 3, interrupted: 2, exempt: 2 },
          peakWindows: [{ start: '09:00', end: '12:00' }],
          peakWeekdays: [1, 2, 3, 4, 5],
          guard: { enabled: true, pauseRunningOnPeak: true, deferNewTurnsOnPeak: true, resumeOnOffPeak: true },
          model: { id: 'deepseek-flash', label: 'DeepSeek-Flash', provider: 'p', peakPriced: true },
          pauseMode: 'pause-now',
        },
      };
    },
    async addPlan(input) {
      calls.push(['addPlan', input]);
      return { id: 'new-plan', title: input.title, prompt: input.prompt ?? '' };
    },
    async removePlan(id, owner) {
      calls.push(['removePlan', id, owner]);
      return true;
    },
    async clearPlans(owner) {
      calls.push(['clearPlans', owner]);
      return 1;
    },
    async runPlansNow(owner) {
      calls.push(['runPlansNow', owner]);
      return [];
    },
    async pauseNow(owner) {
      calls.push(['pauseNow', owner]);
      return [];
    },
    async resumeNow(sessionIds) {
      calls.push(['resumeNow', sessionIds]);
      return [];
    },
    async setExempt(sessionId, exempt) {
      calls.push(['setExempt', sessionId, exempt]);
      return { sessionId, exempt };
    },
    async setPauseMode(mode) {
      calls.push(['setPauseMode', mode]);
      return mode;
    },
  };
  return guard;
}

function tool(guard, name) {
  const found = createOffpeakTools(guard).find((item) => item.name === name);
  assert.ok(found, `缺少工具 ${name}`);
  return found;
}

const exec = (id = CALLER) => ({ agent: { id } });

test('offpeak_plan 拒绝把规划排到其它会话，且不调用 guard', async () => {
  const guard = fakeGuard();
  await assert.rejects(
    () => tool(guard, 'offpeak_plan').execute({ action: 'add', title: 'x', sessionId: OTHER }, exec()),
    /只能为当前会话/,
  );
  assert.deepEqual(guard.calls, []);
});

test('offpeak_plan 默认使用调用者会话并记录创建者', async () => {
  const guard = fakeGuard();
  const result = await tool(guard, 'offpeak_plan').execute({ action: 'add', title: '整理', prompt: '继续' }, exec());
  assert.match(result.text, /已排定/);
  assert.equal(guard.calls.length, 1);
  assert.equal(guard.calls[0][0], 'addPlan');
  assert.equal(guard.calls[0][1].sessionId, CALLER);
  assert.equal(guard.calls[0][1].createdBySessionId, CALLER);
});

test('offpeak_plan list 只显示当前会话的规划（含旧版目标为本会话的规划）', async () => {
  const guard = fakeGuard();
  const result = await tool(guard, 'offpeak_plan').execute({ action: 'list' }, exec());
  assert.match(result.text, /当前会话的规划/);
  assert.match(result.text, /当前会话的旧规划/);
  assert.doesNotMatch(result.text, /别的会话的规划/);
  assert.deepEqual(result.data.plans.map((item) => item.id), ['mine', 'legacy']);
});

test('offpeak_plan remove/clear 只带当前会话 id', async () => {
  const guard = fakeGuard();
  await tool(guard, 'offpeak_plan').execute({ action: 'remove', id: 'x' }, exec());
  await tool(guard, 'offpeak_plan').execute({ action: 'clear' }, exec());
  assert.deepEqual(guard.calls, [
    ['removePlan', 'x', CALLER],
    ['clearPlans', CALLER],
  ]);
});

test('offpeak_guard resume_now 拒绝指定其它会话，且不调用 guard', async () => {
  const guard = fakeGuard();
  await assert.rejects(
    () => tool(guard, 'offpeak_guard').execute({ action: 'resume_now', sessionId: OTHER }, exec()),
    /只能操作当前会话/,
  );
  assert.deepEqual(guard.calls, []);
});

test('offpeak_guard resume_now 默认只恢复当前会话', async () => {
  const guard = fakeGuard();
  await tool(guard, 'offpeak_guard').execute({ action: 'resume_now' }, exec());
  assert.deepEqual(guard.calls, [['resumeNow', [CALLER]]]);
});

test('offpeak_guard 显式传当前会话 id 仍然兼容', async () => {
  const guard = fakeGuard();
  await tool(guard, 'offpeak_guard').execute({ action: 'resume_now', sessionId: CALLER }, exec());
  assert.deepEqual(guard.calls, [['resumeNow', [CALLER]]]);
});

test('offpeak_guard pause_now 只暂停当前会话', async () => {
  const guard = fakeGuard();
  await assert.rejects(
    () => tool(guard, 'offpeak_guard').execute({ action: 'pause_now', sessionId: OTHER }, exec()),
    /只能操作当前会话/,
  );
  assert.deepEqual(guard.calls, []);
  await tool(guard, 'offpeak_guard').execute({ action: 'pause_now' }, exec());
  assert.deepEqual(guard.calls, [['pauseNow', CALLER]]);
});

test('offpeak_guard 不再允许模型修改全局 pause_mode', async () => {
  const guard = fakeGuard();
  await assert.rejects(
    () => tool(guard, 'offpeak_guard').execute({ action: 'pause_mode', mode: 'finish-turn' }, exec()),
    /只能由用户/,
  );
  assert.deepEqual(guard.calls, []);
});

test('offpeak_guard status 不返回其它会话的明细', async () => {
  const guard = fakeGuard();
  const result = await tool(guard, 'offpeak_guard').execute({ action: 'status' }, exec());
  assert.deepEqual(Object.keys(result.data.sessions), [CALLER]);
  assert.deepEqual(result.data.interrupted.map((item) => item.id), ['p1', 'w1']);
  assert.equal(result.data.counts.interrupted, 1);
  assert.equal(result.data.counts.waiting, 1);
  assert.equal(result.data.counts.held, 1);
  assert.deepEqual(result.data.heldMessages.map((item) => item.id), ['h1']);
  assert.deepEqual(result.data.exemptSessions.map((item) => item.sessionId), [CALLER]);
  assert.deepEqual(result.data.plans.map((item) => item.id), ['mine', 'legacy']);
  assert.doesNotMatch(result.text, /别的会话/);
});

test('offpeak_guard exempt/unexempt 拒绝指定其它会话，默认只操作当前会话', async () => {
  const guard = fakeGuard();
  await assert.rejects(
    () => tool(guard, 'offpeak_guard').execute({ action: 'exempt', sessionId: OTHER }, exec()),
    /只能操作当前会话/,
  );
  await assert.rejects(
    () => tool(guard, 'offpeak_guard').execute({ action: 'unexempt', sessionId: OTHER }, exec()),
    /只能操作当前会话/,
  );
  assert.deepEqual(guard.calls, []);
  await tool(guard, 'offpeak_guard').execute({ action: 'exempt' }, exec());
  assert.deepEqual(guard.calls, [['setExempt', CALLER, true]]);
});

test('offpeak_guard run_plans_now 只执行当前会话的规划', async () => {
  const guard = fakeGuard();
  await tool(guard, 'offpeak_guard').execute({ action: 'run_plans_now' }, exec());
  assert.deepEqual(guard.calls, [['runPlansNow', CALLER]]);
});

test('没有调用者会话时，会话级工具直接拒绝', async () => {
  const guard = fakeGuard();
  await assert.rejects(
    () => tool(guard, 'offpeak_plan').execute({ action: 'add', title: 'x' }, {}),
    /只能在会话内调用/,
  );
  await assert.rejects(
    () => tool(guard, 'offpeak_guard').execute({ action: 'resume_now' }, {}),
    /只能在会话内调用/,
  );
  assert.deepEqual(guard.calls, []);
});
