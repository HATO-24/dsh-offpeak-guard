/**
 * 峰时消息挂起：验证 agent/inbox/inserted 在进入模型回合前被摘出并暂存，
 * 而不是让消息在峰时直接进入 turn。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const { createGuard } = await import('../lib/guard.js');

test('峰时用户消息被从 inbox 摘出并暂存', async () => {
  const root = mkdtempSync(join(process.cwd(), '.tmp-hold-test-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  mkdirSync(join(root, 'offpeak-guard'), { recursive: true });

  const listeners = new Map();
  const removed = [];
  const ctx = {
    get(name) {
      if (name === 'sessionController') {
        return {
          async prompt() {
            return { accepted: true };
          },
          cancel() {
            return { accepted: true };
          },
        };
      }
      if (name === 'sessions') return { get: () => undefined };
      return undefined;
    },
    on(event, listener) {
      listeners.set(event, listener);
      return () => listeners.delete(event);
    },
    logger: { warn() {}, info() {}, error() {} },
  };
  const agent = {
    id: 'session-hold',
    status: 'idle',
    session: {
      header: { cwd: 'C:\\tmp' },
      requestHeader: () => ({ config: { provider: 'p', model: 'deepseek-flash' } }),
    },
    inbox: {
      remove(id) {
        removed.push(id);
        return true;
      },
    },
  };
  const message = {
    id: 'message-hold',
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: '峰时先别发' }],
  };
  const guard = createGuard(ctx, {
    enabled: true,
    preset: 'custom',
    holdMessages: true,
    timezone: 'Asia/Shanghai',
    peakWeekdays: [0, 1, 2, 3, 4, 5, 6],
    peakWindows: [{ start: '00:00', end: '23:59' }],
  });
  const stop = guard.start();
  try {
    const onInsert = listeners.get('agent/inbox/inserted');
    assert.equal(typeof onInsert, 'function');
    onInsert({ agent, message });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(removed, ['message-hold']);
    const state = JSON.parse(readFileSync(join(root, 'offpeak-guard', 'state.json'), 'utf8'));
    assert.equal(state.heldMessages.length, 1);
    assert.equal(state.heldMessages[0].status, 'held');
    assert.equal(state.heldMessages[0].sessionId, 'session-hold');
    assert.equal(state.heldMessages[0].content[0].text, '峰时先别发');
  } finally {
    stop();
    await new Promise((resolve) => setTimeout(resolve, 30));
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('谷价 tick 把暂存消息按原内容投递', async () => {
  const root = mkdtempSync(join(process.cwd(), '.tmp-hold-test-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  mkdirSync(join(root, 'offpeak-guard'), { recursive: true });
  const held = {
    version: 1,
    interrupted: [],
    plans: [],
    heldMessages: [
      {
        id: 'held-1',
        sessionId: 'session-hold',
        title: '测试会话',
        content: [{ type: 'text', text: '谷价再发' }],
        at: Date.now(),
        status: 'held',
      },
    ],
    exemptSessions: {},
    modelRules: {},
    settings: {},
    meta: {},
  };
  writeFileSync(join(root, 'offpeak-guard', 'state.json'), JSON.stringify(held), 'utf8');
  const prompts = [];
  const ctx = {
    get(name) {
      if (name === 'sessionController') {
        return {
          async prompt(request) {
            prompts.push(request);
            return { accepted: true };
          },
        };
      }
      if (name === 'sessions') return { get: () => undefined };
      return undefined;
    },
    on: () => () => {},
    logger: { warn() {}, info() {}, error() {} },
  };
  const guard = createGuard(ctx, {
    enabled: true,
    preset: 'custom',
    holdMessages: true,
    timezone: 'Asia/Shanghai',
    peakWeekdays: [0, 1, 2, 3, 4, 5, 6],
    peakWindows: [{ start: '00:00', end: '00:01' }],
  });
  const stop = guard.start();
  try {
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].sessionId, 'session-hold');
    assert.equal(prompts[0].content[0].text, '谷价再发');
    const state = JSON.parse(readFileSync(join(root, 'offpeak-guard', 'state.json'), 'utf8'));
    assert.equal(state.heldMessages[0].status, 'delivered');
  } finally {
    stop();
    await new Promise((resolve) => setTimeout(resolve, 30));
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

