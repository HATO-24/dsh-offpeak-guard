/**
 * 会话被豁免时，立即投递该会话在峰时挂起的消息。
 * 其它会话的挂起消息保持不变；取消豁免不会重复投递。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const { createGuard } = await import('../lib/guard.js');

test('豁免会话时立即发送该会话的挂起消息，其它会话不动', async () => {
  const root = mkdtempSync(join(process.cwd(), '.tmp-exempt-test-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  mkdirSync(join(root, 'offpeak-guard'), { recursive: true });

  const held = {
    version: 1,
    interrupted: [],
    plans: [],
    heldMessages: [
      { id: 'held-b1', sessionId: 'session-b', title: 'B', content: [{ type: 'text', text: 'b1' }], at: 900, status: 'held' },
      { id: 'held-a1', sessionId: 'session-a', title: 'A', content: [{ type: 'text', text: 'a1' }], at: 1000, status: 'held' },
      { id: 'held-a2', sessionId: 'session-a', title: 'A', content: [{ type: 'text', text: 'a2' }], at: 2000, status: 'held' },
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
          cancel() {
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
    peakWindows: [{ start: '00:00', end: '23:59' }],
  });

  try {
    const result = await guard.setExempt('session-a', true);
    assert.equal(result.releasedHeld, 2);
    assert.deepEqual(
      prompts.map((request) => request.sessionId),
      ['session-a', 'session-a'],
    );
    assert.deepEqual(
      prompts.map((request) => request.content[0].text),
      ['a1', 'a2'],
    );

    const state = JSON.parse(readFileSync(join(root, 'offpeak-guard', 'state.json'), 'utf8'));
    const byId = Object.fromEntries(state.heldMessages.map((item) => [item.id, item]));
    assert.equal(byId['held-a1'].status, 'delivered');
    assert.equal(byId['held-a2'].status, 'delivered');
    assert.equal(byId['held-a1'].deliveredBy, 'exempt');
    assert.equal(byId['held-b1'].status, 'held');

    // 取消豁免不应再次投递
    await guard.setExempt('session-a', false);
    assert.equal(prompts.length, 2);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
