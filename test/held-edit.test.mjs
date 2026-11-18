/**
 * 挂起消息在自动发送前可编辑/删除，投递时使用修改后的内容。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const { createGuard } = await import('../lib/guard.js');

test('挂起消息可以编辑、保留附件、删除，并按编辑后的内容投递', async () => {
  const root = mkdtempSync(join(process.cwd(), '.tmp-held-edit-test-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  mkdirSync(join(root, 'offpeak-guard'), { recursive: true });

  const held = {
    version: 1,
    interrupted: [],
    plans: [],
    heldMessages: [
      { id: 'held-a1', sessionId: 'session-a', title: 'A', content: [{ type: 'text', text: '旧内容' }], at: 1000, status: 'held' },
      {
        id: 'held-a2',
        sessionId: 'session-a',
        title: 'A',
        content: [{ type: 'text', text: '带附件' }, { type: 'image', url: 'x' }],
        at: 2000,
        status: 'held',
      },
      { id: 'held-b1', sessionId: 'session-b', title: 'B', content: [{ type: 'text', text: 'b' }], at: 900, status: 'held' },
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
    await guard.updateHeld('session-a', 'held-a1', '修改后内容');
    let state = JSON.parse(readFileSync(join(root, 'offpeak-guard', 'state.json'), 'utf8'));
    const a1 = state.heldMessages.find((item) => item.id === 'held-a1');
    assert.equal(a1.content[0].text, '修改后内容');
    assert.ok(a1.editedAt > 0);

    // 只改文本，附件块保留
    await guard.updateHeld('session-a', 'held-a2', '新文本');
    state = JSON.parse(readFileSync(join(root, 'offpeak-guard', 'state.json'), 'utf8'));
    const a2 = state.heldMessages.find((item) => item.id === 'held-a2');
    assert.equal(a2.content[0].text, '新文本');
    assert.equal(a2.content.some((block) => block.type === 'image'), true);

    // 不允许编辑其它会话的消息
    await assert.rejects(() => guard.updateHeld('session-b', 'held-a1', '越权'));
    await assert.rejects(() => guard.deleteHeld('session-b', 'held-a1'));

    // 删除有效
    await guard.deleteHeld('session-a', 'held-a2');
    state = JSON.parse(readFileSync(join(root, 'offpeak-guard', 'state.json'), 'utf8'));
    assert.equal(state.heldMessages.some((item) => item.id === 'held-a2'), false);
    await assert.rejects(() => guard.deleteHeld('session-a', 'held-a2'));

    // 投递时使用修改后的文本
    await guard.setExempt('session-a', true);
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].sessionId, 'session-a');
    assert.equal(prompts[0].content[0].text, '修改后内容');
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
