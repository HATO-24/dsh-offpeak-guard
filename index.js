/**
 * dsh-offpeak-guard 入口（Host 半）。
 *
 * 三件事：
 *   1. 时间识别 —— 按 DeepSeek 官方峰谷规则（工作日 9–12、14–18，法定节假日全天谷价）判断时段；
 *   2. 模型识别 —— 只有使用峰谷计价模型的会话才会被暂停/恢复；
 *   3. 工作规划 —— 峰时暂停运行中的任务、延后新任务，谷价开始时自动恢复；
 *      另提供 offpeak_plan 把稍后要做的事排进谷价时段。
 *
 * 配置优先级：环境变量（DSH_OFFPEAK_*）> 设置/patch > 代码默认。
 */
import z from '@deepseek-ai/schemastery';
import { createGuard } from './lib/guard.js';
import { createOffpeakTools } from './lib/tools.js';

export const name = 'offpeak-guard';
export const inject = ['tools'];

const OFFICIAL_WINDOWS = [
  { start: '09:00', end: '12:00' },
  { start: '14:00', end: '18:00' },
];

export const Config = z.object({
  enabled: z.boolean().default(true),
  preset: z.string().default('auto'),
  pauseMode: z.string().default('pause-now'),
  timezone: z.string().default('Asia/Shanghai'),
  peakWeekdays: z.array(z.natural().max(6)).default([1, 2, 3, 4, 5]),
  peakWindows: z
    .array(z.object({ start: z.string(), end: z.string() }))
    .default(OFFICIAL_WINDOWS),
  discount: z.number().min(0.1).max(1).default(0.5),
  holidays: z.array(z.string()).default([]),
  holidaySource: z.string().default('auto'),
  holidayApi: z.string().default('https://timor.tech/api/holiday/year'),
  modelPattern: z.string().default('deepseek'),
  peakPricedModels: z.array(z.string()).default([]),
  exemptModels: z.array(z.string()).default([]),
  pauseRunningOnPeak: z.boolean().default(true),
  deferNewTurnsOnPeak: z.boolean().default(true),
  resumeOnOffPeak: z.boolean().default(true),
  pollSeconds: z.natural().min(5).max(300).default(15),
  resumeDelaySeconds: z.natural().min(0).max(120).default(3),
  bypassMinutes: z.natural().min(0).max(120).default(10),
  alertMinutes: z.natural().min(0).max(120).default(10),
});

function parseBoolean(value) {
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  return undefined;
}

function parseNumber(value) {
  const number = Number(String(value).trim());
  return Number.isFinite(number) ? number : undefined;
}

function parseWeekdays(value) {
  const days = String(value)
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item >= 0 && item <= 6);
  return days.length > 0 ? days : undefined;
}

function parseWindows(value) {
  const windows = [];
  for (const part of String(value).split(',')) {
    const match = /^\s*(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s*$/.exec(part);
    if (match !== null) windows.push({ start: match[1], end: match[2] });
  }
  return windows.length > 0 ? windows : undefined;
}

function parseList(value) {
  const items = String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

/**
 * 读取部署环境变量。用于容器/CI/多实例统一注入，避免每个用户改 patch。
 * 无效值忽略，不改变原有配置。
 */
export function envConfig(env = process.env) {
  const out = {};
  if (env.DSH_OFFPEAK_ENABLED !== undefined) {
    const value = parseBoolean(env.DSH_OFFPEAK_ENABLED);
    if (value !== undefined) out.enabled = value;
  }
  if (env.DSH_OFFPEAK_PRESET) out.preset = String(env.DSH_OFFPEAK_PRESET).trim();
  if (env.DSH_OFFPEAK_PAUSE_MODE) out.pauseMode = String(env.DSH_OFFPEAK_PAUSE_MODE).trim();
  if (env.DSH_OFFPEAK_TIMEZONE) out.timezone = String(env.DSH_OFFPEAK_TIMEZONE).trim();
  if (env.DSH_OFFPEAK_PEAK_WEEKDAYS !== undefined) {
    const value = parseWeekdays(env.DSH_OFFPEAK_PEAK_WEEKDAYS);
    if (value !== undefined) out.peakWeekdays = value;
  }
  if (env.DSH_OFFPEAK_PEAK_WINDOWS !== undefined) {
    const value = parseWindows(env.DSH_OFFPEAK_PEAK_WINDOWS);
    if (value !== undefined) out.peakWindows = value;
  }
  if (env.DSH_OFFPEAK_DISCOUNT !== undefined) {
    const value = parseNumber(env.DSH_OFFPEAK_DISCOUNT);
    if (value !== undefined) out.discount = value;
  }
  if (env.DSH_OFFPEAK_HOLIDAYS !== undefined) {
    const value = parseList(env.DSH_OFFPEAK_HOLIDAYS);
    if (value !== undefined) out.holidays = value;
  }
  if (env.DSH_OFFPEAK_HOLIDAY_SOURCE) out.holidaySource = String(env.DSH_OFFPEAK_HOLIDAY_SOURCE).trim();
  if (env.DSH_OFFPEAK_HOLIDAY_API) out.holidayApi = String(env.DSH_OFFPEAK_HOLIDAY_API).trim();
  if (env.DSH_OFFPEAK_MODEL_PATTERN) out.modelPattern = String(env.DSH_OFFPEAK_MODEL_PATTERN).trim();
  if (env.DSH_OFFPEAK_PEAK_MODELS !== undefined) {
    const value = parseList(env.DSH_OFFPEAK_PEAK_MODELS);
    if (value !== undefined) out.peakPricedModels = value;
  }
  if (env.DSH_OFFPEAK_EXEMPT_MODELS !== undefined) {
    const value = parseList(env.DSH_OFFPEAK_EXEMPT_MODELS);
    if (value !== undefined) out.exemptModels = value;
  }
  const booleans = [
    ['DSH_OFFPEAK_PAUSE_RUNNING', 'pauseRunningOnPeak'],
    ['DSH_OFFPEAK_DEFER_NEW', 'deferNewTurnsOnPeak'],
    ['DSH_OFFPEAK_RESUME', 'resumeOnOffPeak'],
  ];
  for (const [key, field] of booleans) {
    if (env[key] !== undefined) {
      const value = parseBoolean(env[key]);
      if (value !== undefined) out[field] = value;
    }
  }
  const numbers = [
    ['DSH_OFFPEAK_POLL_SECONDS', 'pollSeconds'],
    ['DSH_OFFPEAK_RESUME_DELAY_SECONDS', 'resumeDelaySeconds'],
    ['DSH_OFFPEAK_BYPASS_MINUTES', 'bypassMinutes'],
    ['DSH_OFFPEAK_ALERT_MINUTES', 'alertMinutes'],
  ];
  for (const [key, field] of numbers) {
    if (env[key] !== undefined) {
      const value = parseNumber(env[key]);
      if (value !== undefined) out[field] = value;
    }
  }
  return out;
}

/** 设置接口只收几个字段的小 JSON，超过这个体积按可疑请求拒绝。 */
const MAX_BODY_BYTES = 64 * 1024;

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk?.byteLength ?? Buffer.byteLength(String(chunk));
    if (size > MAX_BODY_BYTES) {
      // 先排空再拒绝，让客户端读到响应而不是被一刀切断连接。
      req.resume();
      const error = new Error('request body too large');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(body);
}

/**
 * 设置路由的准入栅栏。
 *
 * `connection.requestRejection` 是宿主唯一的本机接口准入点：它同时做 Host/Origin
 * 校验（挡 DNS rebinding 和跨站请求）与浏览器令牌鉴权（挡没登录的本机网页）。
 * 没有它，本机任意网页都能改会话豁免、峰谷规则和暂停方式。
 *
 * 拿不到 `connection`、或它自己抛错时一律拒绝（失败关闭），不退回到只检查
 * Host/Origin/回环地址——那条路挡不住别的网页。
 */
export function admissionRejection(ctx, req) {
  let connection;
  try {
    connection = Reflect.get(ctx, 'connection');
  } catch {
    return 403;
  }
  if (connection === undefined || connection === null || typeof connection.requestRejection !== 'function') {
    return 403;
  }
  try {
    return connection.requestRejection({ headers: req.headers }) ?? undefined;
  } catch {
    return 403;
  }
}

export function apply(ctx, rawConfig = {}) {
  const config = { ...(rawConfig ?? {}), ...envConfig() };
  const guard = createGuard(ctx, config);

  ctx.effect(() => guard.start(), 'offpeak-guard: tick loop');

  ctx.effect(() => {
    const disposers = [];
    try {
      for (const tool of createOffpeakTools(guard)) {
        disposers.push(ctx.tools.register(tool));
      }
    } catch (error) {
      for (const dispose of disposers.splice(0).reverse()) {
        try {
          dispose();
        } catch {
          /* ignore */
        }
      }
      throw error;
    }
    return () => {
      for (const dispose of disposers.splice(0).reverse()) {
        try {
          dispose();
        } catch {
          /* ignore */
        }
      }
    };
  }, 'offpeak-guard: tools');

  ctx.inject(['webServer', 'connection'], (webCtx) => {
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'prefix',
          path: '/plugins/dsh-offpeak-guard',
          async handler(req, res) {
            try {
              const rejection = admissionRejection(webCtx, req);
              if (rejection !== undefined) {
                sendJson(res, rejection, { ok: false, error: 'unauthorized' });
                return;
              }
              const url = new URL(req.url || '/', 'http://x');
              const rest = url.pathname.replace(/^\/plugins\/dsh-offpeak-guard/, '') || '/';
              if (req.method !== 'POST' || rest !== '/action') {
                sendJson(res, 404, { ok: false, error: 'not found' });
                return;
              }
              const body = await readJsonBody(req);
              if (body.action === 'exempt' || body.action === 'unexempt') {
                const exempt = body.action === 'exempt' ? body.exempt === true : false;
                const result = await guard.setExempt(String(body.sessionId || ''), exempt);
                sendJson(res, 200, { ok: true, result });
                return;
              }
              if (body.action === 'model') {
                const result = await guard.setModelRule(
                  String(body.provider || ''),
                  String(body.model || ''),
                  body.peakPriced === null || body.peakPriced === undefined ? null : body.peakPriced === true,
                );
                sendJson(res, 200, { ok: true, result });
                return;
              }
              if (body.action === 'pauseMode') {
                const result = await guard.setPauseMode(body.mode === 'finish-turn' ? 'finish-turn' : 'pause-now');
                sendJson(res, 200, { ok: true, result });
                return;
              }
              sendJson(res, 400, { ok: false, error: 'unknown action' });
            } catch (error) {
              const status = Number.isInteger(error?.statusCode) ? error.statusCode : 400;
              sendJson(res, status, { ok: false, error: String(error?.message ?? error) });
            }
          },
        }),
      'offpeak-guard: settings route',
    );
  });
}
