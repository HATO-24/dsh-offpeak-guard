/**
 * 峰谷时间引擎（纯函数，无框架依赖）。
 *
 * 规则来自 DeepSeek 的「夜间折扣」：工作日 09:00–12:00、14:00–18:00 为高峰原价，
 * 其余时间（含午间、夜间与周末）为谷价，谷价按 5 折计费。时区默认 Asia/Shanghai。
 * 所有窗口都由配置给出，不写死在调用处，方便官方调价后只改 patch。
 */

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export const DEFAULT_RULES = {
  timezone: 'Asia/Shanghai',
  peakWeekdays: [1, 2, 3, 4, 5],
  peakWindows: [
    { start: '09:00', end: '12:00' },
    { start: '14:00', end: '18:00' },
  ],
  discount: 0.5,
};

/** 解析 "HH:MM"。非法值返回 null，由调用方决定退回默认。 */
function parseHm(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!(hour >= 0 && hour <= 23) || !(minute >= 0 && minute <= 59)) return null;
  return { hour, minute };
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function hmText(minutes) {
  return `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`;
}

/**
 * 把 patch 里的原始配置归一成引擎可用的规则；坏值逐项退回默认，不整体失败。
 * @param {Record<string, unknown>} [config]
 */
export function resolveRules(config = {}) {
  const timezone =
    typeof config.timezone === 'string' && config.timezone.trim() !== ''
      ? config.timezone.trim()
      : DEFAULT_RULES.timezone;

  let weekdays = Array.isArray(config.peakWeekdays)
    ? config.peakWeekdays.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value >= 0 && value <= 6)
    : DEFAULT_RULES.peakWeekdays;
  if (weekdays.length === 0) weekdays = [...DEFAULT_RULES.peakWeekdays];
  weekdays = [...new Set(weekdays)].sort((a, b) => a - b);

  const rawWindows =
    Array.isArray(config.peakWindows) && config.peakWindows.length > 0
      ? config.peakWindows
      : DEFAULT_RULES.peakWindows;
  const windows = [];
  for (const raw of rawWindows) {
    const start = parseHm(raw?.start);
    const end = parseHm(raw?.end);
    if (start === null || end === null) continue;
    const startMin = start.hour * 60 + start.minute;
    const endMin = end.hour * 60 + end.minute;
    if (endMin <= startMin) continue;
    windows.push({ startMin, endMin, start: hmText(startMin), end: hmText(endMin) });
  }
  if (windows.length === 0) {
    for (const raw of DEFAULT_RULES.peakWindows) {
      const start = parseHm(raw.start);
      const end = parseHm(raw.end);
      windows.push({
        startMin: start.hour * 60 + start.minute,
        endMin: end.hour * 60 + end.minute,
        start: raw.start,
        end: raw.end,
      });
    }
  }
  windows.sort((a, b) => a.startMin - b.startMin);

  const rawDiscount = Number(config.discount);
  const discount = Number.isFinite(rawDiscount) && rawDiscount > 0 && rawDiscount <= 1 ? rawDiscount : DEFAULT_RULES.discount;

  return { timezone, peakWeekdays: weekdays, peakWindows: windows, discount };
}

const formatterCache = new Map();

function zoneFormatter(timeZone) {
  let formatter = formatterCache.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** 目标时区下的日期分量。 */
export function zonedParts(date, timeZone) {
  const record = {};
  for (const part of zoneFormatter(timeZone).formatToParts(date)) record[part.type] = part.value;
  return {
    year: Number(record.year),
    month: Number(record.month),
    day: Number(record.day),
    hour: record.hour === '24' ? 0 : Number(record.hour),
    minute: Number(record.minute),
    second: Number(record.second),
    weekday: WEEKDAY_INDEX[record.weekday] ?? 0,
  };
}

function zoneOffsetMs(date, timeZone) {
  const parts = zonedParts(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - date.getTime();
}

/** 目标时区的本地墙钟时间 → 绝对时间。 */
function zonedDate(year, month, day, minuteOfDay, timeZone) {
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  const wall = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = wall;
  for (let index = 0; index < 3; index += 1) {
    const next = wall - zoneOffsetMs(new Date(guess), timeZone);
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess);
}

function dayAt(parts, offsetDays) {
  const base = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12, 0, 0) + offsetDays * DAY_MS);
  return {
    year: base.getUTCFullYear(),
    month: base.getUTCMonth() + 1,
    day: base.getUTCDate(),
    weekday: base.getUTCDay(),
  };
}

/** 当前时刻所处的计价时段。 */
export function phaseAt(date, rules) {
  const parts = zonedParts(date, rules.timezone);
  const minute = parts.hour * 60 + parts.minute;
  const peakDay = rules.peakWeekdays.includes(parts.weekday);
  const window = peakDay ? rules.peakWindows.find((item) => minute >= item.startMin && minute < item.endMin) : undefined;
  return {
    phase: window === undefined ? 'offpeak' : 'peak',
    window: window ?? null,
    parts,
    minute,
  };
}

/**
 * 下一次计价切换：峰的结束或谷的结束（即下一次峰开始）。
 * @param {Date} date
 * @param {ReturnType<typeof resolveRules>} rules
 */
export function nextBoundary(date, rules) {
  const current = phaseAt(date, rules);
  const { parts } = current;
  if (current.phase === 'peak' && current.window !== null) {
    return {
      phase: 'offpeak',
      at: zonedDate(parts.year, parts.month, parts.day, current.window.endMin, rules.timezone),
      label: current.window.end,
    };
  }
  const nowMinutes = current.minute + parts.second / 60;
  for (let offset = 0; offset <= 8; offset += 1) {
    const day = dayAt(parts, offset);
    if (!rules.peakWeekdays.includes(day.weekday)) continue;
    for (const window of rules.peakWindows) {
      if (offset === 0 && window.startMin <= nowMinutes) continue;
      return {
        phase: 'peak',
        at: zonedDate(day.year, day.month, day.day, window.startMin, rules.timezone),
        label: window.start,
      };
    }
  }
  // 配置把所有日子都排除时不会到这里；保底退到 24 小时后。
  return { phase: 'offpeak', at: new Date(date.getTime() + DAY_MS), label: hmText(current.minute) };
}

/** 当前时段所属窗口的起止（峰时返回所在窗口，谷时返回 null）。 */
export function windowBounds(date, rules) {
  const current = phaseAt(date, rules);
  if (current.phase === 'peak' && current.window !== null) {
    return {
      phase: 'peak',
      startMin: current.window.startMin,
      endMin: current.window.endMin,
      start: current.window.start,
      end: current.window.end,
      startAt: zonedDate(current.parts.year, current.parts.month, current.parts.day, current.window.startMin, rules.timezone).getTime(),
      endAt: zonedDate(current.parts.year, current.parts.month, current.parts.day, current.window.endMin, rules.timezone).getTime(),
    };
  }
  return { phase: 'offpeak', startMin: null, endMin: null, start: null, end: null, startAt: null, endAt: null };
}

export function formatClock(date, timeZone) {
  const parts = zonedParts(date, timeZone);
  return `${pad2(parts.hour)}:${pad2(parts.minute)}`;
}

export function formatDateClock(date, timeZone) {
  const parts = zonedParts(date, timeZone);
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)} ${pad2(parts.hour)}:${pad2(parts.minute)}`;
}

export function formatWeekday(date, timeZone) {
  return WEEKDAY_NAMES[zonedParts(date, timeZone).weekday];
}

/** 时长的人话说法：2小时13分 / 43分 / 1天3小时。 */
export function formatDuration(ms) {
  const safe = Math.max(0, Math.floor(ms));
  const totalMinutes = Math.floor(safe / MINUTE_MS);
  if (totalMinutes < 1) return '不到1分钟';
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours > 0 ? `${days}天${hours}小时` : `${days}天`;
  if (hours > 0) return minutes > 0 ? `${hours}小时${minutes}分` : `${hours}小时`;
  return `${minutes}分`;
}

/**
 * 一次把状态需要的所有时间字段算出来，工具和快照共用同一份。
 * @param {number} nowMs
 * @param {ReturnType<typeof resolveRules>} rules
 */
export function describeWindow(nowMs, rules) {
  const now = new Date(nowMs);
  const current = phaseAt(now, rules);
  const boundary = nextBoundary(now, rules);
  const bounds = windowBounds(now, rules);
  const discountText = `${(rules.discount * 10).toFixed(1).replace(/\.0$/, '')} 折`;
  return {
    now: nowMs,
    timezone: rules.timezone,
    phase: current.phase,
    phaseLabel: current.phase === 'peak' ? '峰值原价' : `谷价 ${discountText}`,
    discount: rules.discount,
    localTime: formatDateClock(now, rules.timezone),
    weekday: formatWeekday(now, rules.timezone),
    window: current.phase === 'peak' ? { start: bounds.start, end: bounds.end, startAt: bounds.startAt, endAt: bounds.endAt } : null,
    next: {
      phase: boundary.phase,
      label: boundary.label,
      at: boundary.at.getTime(),
      inMs: Math.max(0, boundary.at.getTime() - nowMs),
    },
  };
}

/** 从起始时间找下一个目标时段（peak / offpeak）的开始时刻。 */
export function nextPhaseStart(date, rules, targetPhase) {
  let cursor = new Date(date.getTime());
  for (let index = 0; index < 16; index += 1) {
    const boundary = nextBoundary(cursor, rules);
    if (boundary.phase === targetPhase) return boundary.at;
    cursor = new Date(boundary.at.getTime());
  }
  return null;
}
