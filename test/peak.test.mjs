import assert from 'node:assert/strict';
import test from 'node:test';
import { describeWindow, formatDuration, nextPhaseStart, resolvePreset, resolveRules } from '../lib/peak.js';
import { envConfig } from '../index.js';

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
  assert.equal(desc.presetLabel, 'DeepSeek 官方');
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
  assert.equal(desc.holiday, false);
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

test('官方规则：法定节假日全天谷价', () => {
  const nationalDay = describeWindow(bj('2026-10-01T10:00:00'), rules);
  assert.equal(nationalDay.phase, 'offpeak');
  assert.equal(nationalDay.holiday, true);
  assert.equal(nationalDay.next.at, bj('2026-10-08T09:00:00'));

  const midAutumn = describeWindow(bj('2026-09-25T10:00:00'), rules);
  assert.equal(midAutumn.phase, 'offpeak');
  assert.equal(midAutumn.holiday, true);
  assert.equal(midAutumn.next.at, bj('2026-09-28T09:00:00'));
});

test('自定义预设才使用配置里的窗口与折扣', () => {
  const custom = resolveRules({
    preset: 'custom',
    peakWindows: [{ start: '08:00', end: '10:00' }],
    peakWeekdays: [0, 1, 2, 3, 4, 5, 6],
    discount: 0.8,
  });
  const desc = describeWindow(bj('2026-11-07T09:00:00'), custom);
  assert.equal(desc.phase, 'peak');
  assert.equal(desc.preset, 'custom');
  assert.equal(desc.phaseLabel, '峰值原价');
  assert.deepEqual(
    custom.peakWindows.map((item) => [item.start, item.end]),
    [['08:00', '10:00']],
  );
});

test('命名预设忽略配置里的窗口默认值', () => {
  const official = resolveRules({
    preset: 'deepseek-official',
    peakWindows: [{ start: '00:00', end: '01:00' }],
  });
  assert.deepEqual(
    official.peakWindows.map((item) => [item.start, item.end]),
    [['09:00', '12:00'], ['14:00', '18:00']],
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

test('自定义 holidays 追加后按谷价处理', () => {
  const custom = resolveRules({ preset: 'custom', holidays: ['2026-11-05'] });
  const desc = describeWindow(bj('2026-11-05T10:00:00'), custom);
  assert.equal(desc.phase, 'offpeak');
  assert.equal(desc.holiday, true);
});

test('按 provider 自动选预设', () => {
  assert.equal(resolvePreset({ preset: 'auto' }, 'deepseek-account'), 'deepseek-official');
  assert.equal(resolvePreset({ preset: 'auto' }, 'workbuddy'), 'workbuddy');
  assert.equal(resolvePreset({ preset: 'auto' }, 'codebuddy-cn'), 'workbuddy');
  assert.equal(resolvePreset({ preset: 'custom' }, 'workbuddy'), 'custom');
  assert.equal(describeWindow(bj('2026-11-05T10:00:00'), resolveRules({}, 'workbuddy')).presetLabel, 'WorkBuddy 积分');
});

test('环境变量覆盖配置', () => {
  const env = envConfig({
    DSH_OFFPEAK_PRESET: 'custom',
    DSH_OFFPEAK_PAUSE_MODE: 'finish-turn',
    DSH_OFFPEAK_TIMEZONE: 'Asia/Tokyo',
    DSH_OFFPEAK_PEAK_WEEKDAYS: '1,3,5',
    DSH_OFFPEAK_PEAK_WINDOWS: '08:00-10:00, 15:00-17:00',
    DSH_OFFPEAK_PEAK_MODELS: 'deepseek-flash,workbuddy/deepseek-v4-pro',
    DSH_OFFPEAK_EXEMPT_MODELS: 'deepseek-v4-pro, deepseek-flash',
    DSH_OFFPEAK_ALERT_MINUTES: '3',
    DSH_OFFPEAK_PAUSE_RUNNING: '0',
    DSH_OFFPEAK_HOLIDAY_SOURCE: 'builtin',
  });
  assert.equal(env.preset, 'custom');
  assert.equal(env.pauseMode, 'finish-turn');
  assert.equal(env.timezone, 'Asia/Tokyo');
  assert.deepEqual(env.peakWeekdays, [1, 3, 5]);
  assert.deepEqual(env.peakWindows, [
    { start: '08:00', end: '10:00' },
    { start: '15:00', end: '17:00' },
  ]);
  assert.deepEqual(env.peakPricedModels, ['deepseek-flash', 'workbuddy/deepseek-v4-pro']);
  assert.deepEqual(env.exemptModels, ['deepseek-v4-pro', 'deepseek-flash']);
  assert.equal(env.alertMinutes, 3);
  assert.equal(env.pauseRunningOnPeak, false);
  assert.equal(env.holidaySource, 'builtin');
});

test('状态文件保留会话豁免与精确模型规则', async () => {
  const { normalizeState } = await import('../lib/store.js');
  const state = normalizeState({
    exemptSessions: { 'session-a': { title: '别动我', at: 1 } },
    modelRules: { 'deepseek-account/deepseek-flash': false, 'vendor/model': true },
    settings: { pauseMode: 'finish-turn' },
  });
  assert.equal(state.exemptSessions['session-a'].title, '别动我');
  assert.equal(state.modelRules['deepseek-account/deepseek-flash'], false);
  assert.equal(state.modelRules['vendor/model'], true);
  assert.equal(state.settings.pauseMode, 'finish-turn');
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
