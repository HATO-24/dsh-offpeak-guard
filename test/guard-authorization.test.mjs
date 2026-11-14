/**
 * guard 层的授权/隔离回归测试。
 *
 * 工具层只负责把 owner 传下来；真正决定是否投递的是 guard.addPlan /
 * runDuePlans。这里用真实 createGuard + 临时 state.json 驱动，避免只测
 * fake guard 时把 guard 里的条件写反也全绿。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const { createGuard } = await import('../lib/guard.js');

const CALLER = 'session-owner';
const OTHER = 'session-other';

function makeContext(prompts, options = {}) {
  return {
    get(name) {
      if (name === 'sessionController') {
        return {
          async prompt(request) {
            if (options.promptError !== undefined) throw new Error(options.promptError);
            prompts.push(request);
            return { ok: true };
          },
        };
      }
      if (name === 'sessions') {
        return { get: () => options.session ?? { header: {} } };
      }
      return undefined;
    },
    on: () => () => {},
    logger: { warn() {}, info() {}, error() {} },
  };
}

function makeGuard(options = {}) {
  const root = mkdtempSync(join(process.cwd(), '.tmp-guard-auth-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  const dataDir = join(root, 'offpeak-guard');
  mkdirSync(dataDir, { recursive: true });
  const state = {
    version: 1,
    interrupted: [],
    plans: options.plans ?? [],
    exemptSessions: {},
    modelRules: {},
    settings: {},
    meta: {},
  };
  writeFileSync(join(dataDir, 'state.json'), JSON.stringify(state), 'utf8');
  const prompts = [];
  const guard = createGuard(makeContext(prompts, options), { enabled: false });
  return {
    guard,
    prompts,
    readState() {
      return JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8'));
    },
    cleanup() {
      if (previous === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previous;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('guard.addPlan 拒绝 owner 与目标不一致的规划', async () => {
  const scope = makeGuard();
  try {
    await assert.rejects(
      () =>
        scope.guard.addPlan({
          title: 'x',
          prompt: '给别的会话',
          sessionId: OTHER,
          createdBySessionId: CALLER,
        }),
      /当前会话/,
    );
    assert.equal(scope.prompts.length, 0);
  } finally {
    scope.cleanup();
  }
});

test('runDuePlans 隔离旧计划/跨会话计划，只投递同会话计划', async () => {
  const scope = makeGuard({
    plans: [
      { id: 'legacy', title: '旧计划', prompt: 'legacy', sessionId: CALLER, status: 'queued' },
      {
        id: 'cross',
        title: '跨会话',
        prompt: 'cross',
        sessionId: OTHER,
        createdBySessionId: CALLER,
        status: 'queued',
      },
      {
        id: 'valid',
        title: '本会话',
        prompt: 'valid',
        sessionId: CALLER,
        createdBySessionId: CALLER,
        status: 'queued',
      },
    ],
  });
  try {
    const executed = await scope.guard.runDuePlans();
    assert.equal(scope.prompts.length, 1, '只应投递同会话计划');
    assert.match(scope.prompts[0].content[0].text, /valid/);
    assert.equal(executed.length, 1);
    const state = scope.readState();
    const byId = Object.fromEntries(state.plans.map((plan) => [plan.id, plan]));
    assert.equal(byId.legacy.status, 'failed');
    assert.equal(byId.cross.status, 'failed');
    assert.equal(byId.valid.status, 'done');
  } finally {
    scope.cleanup();
  }
});

test('runDuePlans(owner) 不会执行其它创建者的计划', async () => {
  const scope = makeGuard({
    plans: [
      {
        id: 'other',
        title: '别人的计划',
        prompt: 'other',
        sessionId: OTHER,
        createdBySessionId: OTHER,
        status: 'queued',
      },
      {
        id: 'mine',
        title: '我的计划',
        prompt: 'mine',
        sessionId: CALLER,
        createdBySessionId: CALLER,
        status: 'queued',
      },
    ],
  });
  try {
    const executed = await scope.guard.runDuePlans(CALLER);
    assert.equal(scope.prompts.length, 1);
    assert.match(scope.prompts[0].content[0].text, /mine/);
    assert.equal(executed.length, 1);
    const state = scope.readState();
    const byId = Object.fromEntries(state.plans.map((plan) => [plan.id, plan]));
    assert.equal(byId.other.status, 'queued');
    assert.equal(byId.mine.status, 'done');
  } finally {
    scope.cleanup();
  }
});

test('removePlan/clearPlans 只允许目标会话清理自己的旧计划', async () => {
  const scope = makeGuard({
    plans: [
      { id: 'legacy-mine', title: '旧计划', sessionId: CALLER, status: 'queued' },
      { id: 'legacy-other', title: '别人的旧计划', sessionId: OTHER, status: 'queued' },
    ],
  });
  try {
    assert.equal(await scope.guard.removePlan('legacy-other', CALLER), false);
    assert.equal(await scope.guard.removePlan('legacy-mine', CALLER), true);
    let state = scope.readState();
    assert.deepEqual(state.plans.map((plan) => plan.id), ['legacy-other']);
    assert.equal(await scope.guard.clearPlans(CALLER), 0);
    state = scope.readState();
    assert.equal(state.plans.length, 1);
  } finally {
    scope.cleanup();
  }
});

test('runDuePlans 拒绝把子代理会话当目标', async () => {
  const scope = makeGuard({
    session: { header: { parentSession: 'parent-session' } },
    plans: [
      {
        id: 'subagent',
        title: '子代理目标',
        prompt: 'subagent',
        sessionId: OTHER,
        createdBySessionId: OTHER,
        status: 'queued',
      },
    ],
  });
  try {
    await scope.guard.runDuePlans();
    assert.equal(scope.prompts.length, 0);
    const state = scope.readState();
    assert.equal(state.plans[0].status, 'failed');
    assert.match(state.plans[0].error, /根会话/);
  } finally {
    scope.cleanup();
  }
});

test('runDuePlans 在 prompt 失败时标记 failed', async () => {
  const scope = makeGuard({
    promptError: 'prompt failed',
    plans: [
      {
        id: 'valid',
        title: '会失败的计划',
        prompt: 'valid',
        sessionId: CALLER,
        createdBySessionId: CALLER,
        status: 'queued',
      },
    ],
  });
  try {
    await scope.guard.runDuePlans();
    const state = scope.readState();
    assert.equal(state.plans[0].status, 'failed');
    assert.match(state.plans[0].error, /prompt failed/);
  } finally {
    scope.cleanup();
  }
});
