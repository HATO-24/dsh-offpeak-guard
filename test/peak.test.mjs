import assert from 'node:assert/strict';
import test from 'node:test';
import { describeWindow, formatDuration, nextPhaseStart, resolveRules } from '../lib/peak.js';

const rules = resolveRules({});

/** 北京时间（UTC+8）的绝对时间戳。 */
function bj(text) {
  return Date.parse(`${text}+08:00`);
}

const local = (ms) => new Date(ms).toISOString();

test('工作日午休属于谷价，下次切换是 14:00', () => {
  const now = bj('2026-11-05T12:36:00');
  const desc = describeWindow(now, rules);
  assert.equal(desc.phase, 'offpeak');
  assert.equal(desc.next.phase, 'peak');
  assert.equal(desc.next.label, '14:00');
  assert.equal(desc.next.at, bj('2026-11-05T14:00:00'));
  assert.equal(desc.weekday, '周四');
});

test('工作日 09:30 处于峰时，12:00 结束', () => {
  const desc = describeWindow(bj('2026-11-05T09:30:00'), rules);
  assert.equal(desc.phase, 'peak');
  assert.equal(desc.window.start, '09:00');
  assert.equal(desc.window.end, '12:00');
  assert.equal(desc.next.phase, 'offpeak');
  assert.equal(desc.next.at, bj('2026-11-05T12:00:00'));
});

test('峰时边界：09:00 整点到 12:00 整点前', () => {
  assert.equal(describeWindow(bj('2026-11-05T08:59:59'), rules).phase, 'offpeak');
  assert.equal(describeWindow(bj('2026-11-05T09:00:00'), rules).phase, 'peak');
  assert.equal(describeWindow(bj('2026-11-05T11:59:59'), rules).phase, 'peak');
  assert.equal(describeWindow(bj('2026-11-05T12:00:00'), rules).phase, 'offpeak');
});

test('周五 18:00 之后到周一 09:00 全为谷价', () => {
  const friday = describeWindow(bj('2026-11-06T18:30:00'), rules);
  assert.equal(friday.phase, 'offpeak');
  assert.equal(friday.next.phase, 'peak');
  assert.equal(friday.next.at, bj('2026-11-09T09:00:00'));
});

test('周末全天谷价，下一次峰时是周一 09:00', () => {
  const saturday = describeWindow(bj('2026-11-07T10:00:00'), rules);
  assert.equal(saturday.phase, 'offpeak');
  assert.equal(saturday.next.at, bj('2026-11-09T09:00:00'));
});

test('自定义窗口与折扣会生效', () => {
  const custom = resolveRules({
    peakWindows: [{ start: '08:00', end: '10:00' }],
    peakWeekdays: [1, 2, 3, 4, 5, 6, 0],
    discount: 0.8,
  });
  const desc = describeWindow(bj('2026-11-07T09:00:00'), custom);
  assert.equal(desc.phase, 'peak');
  assert.equal(desc.phaseLabel, '峰值原价');
  assert.deepEqual(
    custom.peakWindows.map((item) => [item.start, item.end]),
    [['08:00', '10:00']],
  );
});

test('坏配置退回默认规则而不是崩溃', () => {
  const bad = resolveRules({
    timezone: '',
    peakWeekdays: [],
    peakWindows: [{ start: '25:99', end: '03:00' }, { start: '14:00', end: '09:00' }],
    discount: 9,
  });
  assert.equal(bad.timezone, 'Asia/Shanghai');
  assert.deepEqual(bad.peakWeekdays, [1, 2, 3, 4, 5]);
  assert.equal(bad.peakWindows.length, 2);
  assert.equal(bad.discount, 0.5);
});

test('nextPhaseStart 能跳过午餐谷价找到下一次峰时', () => {
  const next = nextPhaseStart(new Date(bj('2026-11-05T10:00:00')), rules, 'peak');
  assert.equal(local(next), local(bj('2026-11-05T14:00:00')));
});

test('formatDuration 的人话输出', () => {
  assert.equal(formatDuration(30_000), '不到1分钟');
  assert.equal(formatDuration(43 * 60_000), '43分');
  assert.equal(formatDuration(2 * 60 * 60_000 + 13 * 60_000), '2小时13分');
  assert.equal(formatDuration(26 * 60 * 60_000), '1天2小时');
});
