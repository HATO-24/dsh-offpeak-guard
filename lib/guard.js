/**
 * 峰谷守卫：识别时间与模型，在峰时暂停运行中的任务，在谷价开始后自动恢复；
 * 同时提供错峰工作规划（排定任务，到谷价时段自动执行）。
 *
 * 关键 API（Host 半）：
 *   - ctx.agents.list()                  取出有 Agent 的会话，读 agent.status / agent.session
 *   - session.requestHeader().config     当前会话使用的 provider / model
 *   - sessionController.cancel(...)      停住一轮（保留待处理队列）
 *   - sessionController.prompt(...)      在谷价时段把任务重新交给会话（必要时自动唤醒冷会话）
 */
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import {
  describeWindow,
  formatClock,
  formatDateClock,
  formatDuration,
  resolveRules,
  zonedParts,
} from './peak.js';
import { StateFile, emptyState, writeStatusFiles } from './store.js';

const DEFAULTS = {
  enabled: true,
  pauseMode: 'pause-now',
  pauseRunningOnPeak: true,
  deferNewTurnsOnPeak: true,
  resumeOnOffPeak: true,
  modelPattern: 'deepseek',
  peakPricedModels: [],
  exemptModels: [],
  pollSeconds: 15,
  resumeDelaySeconds: 3,
  bypassMinutes: 10,
  alertMinutes: 10,
  holidaySource: 'auto',
  holidayApi: 'https://timor.tech/api/holiday/year',
};

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function shortId(prefix) {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

function messageOf(error) {
  return String(error?.message ?? error ?? '未知错误');
}

export function createGuard(ctx, config = {}) {
  const rules = resolveRules(config);
  const options = {
    enabled: config.enabled !== false,
    pauseMode: config.pauseMode === 'finish-turn' ? 'finish-turn' : 'pause-now',
    pauseRunningOnPeak: config.pauseRunningOnPeak !== false && DEFAULTS.pauseRunningOnPeak,
    deferNewTurnsOnPeak: config.deferNewTurnsOnPeak !== false && DEFAULTS.deferNewTurnsOnPeak,
    resumeOnOffPeak: config.resumeOnOffPeak !== false && DEFAULTS.resumeOnOffPeak,
    modelPattern:
      typeof config.modelPattern === 'string' && config.modelPattern.trim() !== ''
        ? config.modelPattern.trim().toLowerCase()
        : DEFAULTS.modelPattern,
    peakPricedModels: Array.isArray(config.peakPricedModels) ? config.peakPricedModels.map((item) => String(item)) : [],
    exemptModels: Array.isArray(config.exemptModels) ? config.exemptModels.map((item) => String(item)) : [],
    pollMs: clampNumber(config.pollSeconds, DEFAULTS.pollSeconds, 5, 300) * 1000,
    resumeDelayMs: clampNumber(config.resumeDelaySeconds, DEFAULTS.resumeDelaySeconds, 0, 120) * 1000,
    bypassMs: clampNumber(config.bypassMinutes, DEFAULTS.bypassMinutes, 0, 120) * 60 * 1000,
    alertMinutes: clampNumber(config.alertMinutes, DEFAULTS.alertMinutes, 0, 120),
    holidaySource: config.holidaySource === 'builtin' ? 'builtin' : 'auto',
    holidayApi:
      typeof config.holidayApi === 'string' && config.holidayApi.trim() !== ''
        ? config.holidayApi.trim().replace(/\/+$/, '')
        : DEFAULTS.holidayApi,
  };

  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  const dataDir = path.join(home, 'offpeak-guard');
  let pauseMode = options.pauseMode;
  const stateFile = new StateFile(path.join(dataDir, 'state.json'));
  const rawStateRead = () => stateFile.read();
  const statusFiles = [path.join(dataDir, 'status.json')];
  const mirror = path.join(os.homedir(), '.dsh', 'offpeak-guard', 'status.json');
  if (path.resolve(mirror) !== path.resolve(statusFiles[0])) statusFiles.push(mirror);

  const bypass = new Map();
  const deferring = new Set();
  const rulesCache = new Map();
  const childParent = new Map();
  const waitingBusy = new Set();
  const busy = { tick: false, pause: false, resume: false, plans: false };
  let exemptSessions = {};
  let modelRules = {};
  let dynamicHolidays = [];
  let holidayFetchedAt = 0;
  let holidayRefreshing = false;
  const holidayCachePath = path.join(dataDir, 'holidays.json');
  let timer = null;
  let lastPhase = null;
  let resumeAt = 0;
  let disposed = false;
  let restoreChecked = false;

  const service = (name) => {
    try {
      return ctx.get(name);
    } catch {
      return undefined;
    }
  };

  const log = (level, message) => {
    try {
      const logger = ctx.logger;
      if (logger !== undefined && typeof logger[level] === 'function') logger[level](`[offpeak-guard] ${message}`);
    } catch {
      /* 日志不可用不影响守卫 */
    }
  };

  async function readState() {
    const state = await rawStateRead();
    exemptSessions = state.exemptSessions ?? {};
    modelRules = state.modelRules ?? {};
    if (state.settings?.pauseMode === 'finish-turn' || state.settings?.pauseMode === 'pause-now') {
      pauseMode = state.settings.pauseMode;
    }
    return state;
  }

  function isExempt(sessionId) {
    return Object.prototype.hasOwnProperty.call(exemptSessions, sessionId);
  }

  function sessionOf(agent) {
    if (agent?.session !== undefined) return agent.session;
    const id = agent?.id;
    if (id === undefined) return undefined;
    return service('sessions')?.get?.(id);
  }

  function modelOf(agent) {
    const session = sessionOf(agent);
    let config;
    try {
      config = session?.requestHeader?.()?.config ?? session?.requestContext?.() ?? null;
    } catch {
      config = null;
    }
    let model = config?.model ?? null;
    let provider = config?.provider ?? null;
    if (model === null) {
      try {
        const selection = service('agentDefaultModel')?.currentSelection?.();
        model = selection?.model ?? null;
        provider = provider ?? selection?.provider ?? null;
      } catch {
        /* 没有默认模型时保持 null */
      }
    }
    return { provider, model };
  }

  function isPeakPriced(provider, model) {
    if (typeof model !== 'string' || model === '') return false;
    if (options.exemptModels.includes(model)) return false;
    const exactKey = `${provider ?? ''}/${model}`;
    if (Object.prototype.hasOwnProperty.call(modelRules, exactKey)) return modelRules[exactKey] === true;
    if (Object.prototype.hasOwnProperty.call(modelRules, model)) return modelRules[model] === true;
    if (options.peakPricedModels.length > 0) {
      return options.peakPricedModels.includes(exactKey) || options.peakPricedModels.includes(model);
    }
    const needle = options.modelPattern;
    return model.toLowerCase().includes(needle) || String(provider ?? '').toLowerCase().includes(needle);
  }

  function currentTurn(agent) {
    try {
      const session = sessionOf(agent);
      if (session === undefined || session === null) return 0;
      const boundary = service('agents')?.turnBoundaryOf?.(session);
      return Number(boundary?.lastTurn) || 0;
    } catch {
      return 0;
    }
  }

  async function hasRunningChildren(sessionId) {
    try {
      const subagents = service('subagents');
      if (subagents === undefined || typeof subagents.listChildren !== 'function') return false;
      const children = await subagents.listChildren(sessionId);
      for (const child of Array.isArray(children) ? children : []) {
        if (child?.activity === 'running') return true;
        if (child?.id !== undefined) {
          const live = service('agents')?.get?.(child.id);
          if (live?.status === 'running') return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  function titleOf(session) {
    try {
      const snapshot = service('sessionTitle')?.get?.(session);
      const title = snapshot?.title ?? snapshot?.text ?? null;
      return typeof title === 'string' && title.trim() !== '' ? title.trim() : null;
    } catch {
      return null;
    }
  }

  function liveAgents() {
    try {
      const agents = service('agents');
      const list = agents?.list?.();
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  function guardableSession(agent) {
    const session = sessionOf(agent);
    if (session === undefined || session === null) return null;
    if (session.header?.parentSession !== undefined) return null;
    if (session.header?.cwd === undefined) return null;
    return session;
  }

  function rulesFor(provider) {
    const key = String(provider ?? '');
    if (!rulesCache.has(key)) {
      const merged = {
        ...config,
        holidays: [...(Array.isArray(config.holidays) ? config.holidays : []), ...dynamicHolidays],
      };
      rulesCache.set(key, resolveRules(merged, provider));
    }
    return rulesCache.get(key);
  }

  function clearRulesCache() {
    rulesCache.clear();
  }

  function currentProvider() {
    const active = liveAgents().find((agent) => agent.status === 'running');
    if (active !== undefined) return modelOf(active).provider;
    try {
      return service('agentDefaultModel')?.currentSelection?.()?.provider ?? null;
    } catch {
      return null;
    }
  }

  const modelLabelCache = new Map();

  async function resolveModelLabel(provider, model) {
    if (typeof provider !== 'string' || typeof model !== 'string') return null;
    const key = `${provider}\u0000${model}`;
    if (modelLabelCache.has(key)) return modelLabelCache.get(key);
    let label = null;
    try {
      const resolved = await service('llm')?.resolveModelInfo?.(provider, model);
      if (typeof resolved?.name === 'string' && resolved.name.trim() !== '') label = resolved.name.trim();
    } catch {
      label = null;
    }
    modelLabelCache.set(key, label);
    return label;
  }

  async function snapshotOf(desc, state) {
    const active = liveAgents().find((agent) => agent.status === 'running') ?? null;
    let selected = { provider: null, model: null };
    if (active !== null) {
      selected = modelOf(active);
    } else {
      try {
        const fallback = service('agentDefaultModel')?.currentSelection?.();
        selected = { provider: fallback?.provider ?? null, model: fallback?.model ?? null };
      } catch {
        selected = { provider: null, model: null };
      }
    }
    const label = await resolveModelLabel(selected.provider, selected.model);
    const paused = state.interrupted.filter((item) => item.status === 'paused');
    const plans = state.plans.filter((item) => item.status === 'queued');
    const sessions = {};
    for (const agent of liveAgents().slice(0, 30)) {
      const session = sessionOf(agent);
      if (session === undefined || session === null || session.header?.parentSession !== undefined) continue;
      const route = modelOf(agent);
      sessions[agent.id] = {
        id: route.model,
        provider: route.provider,
        title: titleOf(session),
        peakPriced: isPeakPriced(route.provider, route.model),
        exempt: isExempt(agent.id),
      };
    }
    const activeRules = rulesFor(currentProvider());
    const waitingCount = state.interrupted.filter(
      (item) => item.status === 'waiting-turn' || item.status === 'waiting-children',
    ).length;
    return {
      version: 1,
      generatedAt: Date.now(),
      preset: desc.preset,
      presetLabel: desc.presetLabel,
      pauseMode,
      timezone: desc.timezone,
      peakWeekdays: activeRules.peakWeekdays,
      peakWindows: activeRules.peakWindows.map((item) => ({ start: item.start, end: item.end })),
      discount: desc.discount,
      phase: desc.phase,
      phaseLabel: desc.phaseLabel,
      holiday: desc.holiday === true,
      holidaySource: options.holidaySource,
      holidaySyncedAt: holidayFetchedAt,
      localTime: desc.localTime,
      weekday: desc.weekday,
      window: desc.window,
      next: desc.next,
      alertMinutes: options.alertMinutes,
      modelPattern: options.modelPattern,
      peakPricedModels: options.peakPricedModels,
      exemptModels: options.exemptModels,
      modelRules,
      model: {
        id: selected.model,
        label: label ?? selected.model,
        provider: selected.provider,
        peakPriced: isPeakPriced(selected.provider, selected.model),
      },
      sessions,
      exemptSessions: Object.entries(exemptSessions).map(([sessionId, record]) => ({
        sessionId,
        title: record?.title ?? null,
        at: record?.at ?? 0,
      })),
      guard: {
        enabled: options.enabled,
        pauseRunningOnPeak: options.pauseRunningOnPeak,
        deferNewTurnsOnPeak: options.deferNewTurnsOnPeak,
        resumeOnOffPeak: options.resumeOnOffPeak,
      },
      interrupted: paused.map((item) => ({
        id: item.id,
        sessionId: item.sessionId,
        title: item.title,
        model: item.model,
        at: item.at,
        cause: item.cause,
      })),
      plans: plans.map((item) => ({
        id: item.id,
        title: item.title,
        createdAt: item.createdAt,
        hasPrompt: typeof item.prompt === 'string' && item.prompt.trim() !== '',
      })),
      counts: {
        interrupted: paused.length,
        waiting: waitingCount,
        exempt: Object.keys(exemptSessions).length,
        plans: plans.length,
        resumed: state.interrupted.filter((item) => item.status === 'resumed').length,
      },
    };
  }

  async function publish(desc, state) {
    const payload = await snapshotOf(desc, state);
    await writeStatusFiles(statusFiles, payload);
    return payload;
  }

  function resumeText(item) {
    const itemRules = rulesFor(item.provider);
    const when = formatDateClock(new Date(Number(item.at) || Date.now()), itemRules.timezone);
    const modelText = item.model ? `（模型 ${item.model}）` : '';
    return [
      `【错峰调度】谷价时段已经开始，现在继续执行任务。`,
      `这轮任务在 ${when}${modelText}进入峰时计价后由插件自动暂停。`,
      `请接着上次中断的地方把剩余工作做完；如果已经完成，简要确认结果即可。`,
    ].join('\n');
  }

  function planText(plan) {
    const now = formatDateClock(new Date(), rules.timezone);
    return [
      `【错峰规划】现在进入谷价时段（${now}），执行此前排定的任务「${plan.title}」。`,
      plan.prompt,
    ].join('\n');
  }

  function cancelSession(sessionId) {
    const controller = service('sessionController');
    if (controller === undefined || typeof controller.cancel !== 'function') {
      throw new Error('sessionController 不可用，无法暂停会话');
    }
    return controller.cancel({ sessionId });
  }

  function promptSession(sessionId, text) {
    const controller = service('sessionController');
    if (controller === undefined || typeof controller.prompt !== 'function') {
      throw new Error('sessionController 不可用，无法恢复会话');
    }
    const requestId = `offpeak-${Date.now()}-${randomUUID().slice(0, 8)}`;
    return controller.prompt(
      {
        requestId,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
        clientTimeZone: rules.timezone,
      },
      new AbortController().signal,
    );
  }

  /**
   * 峰时暂停正在跑的、使用峰谷计价模型的根会话。
   * pause-now：立刻取消；finish-turn：当前轮跑完后再停。
   * 有子代理在跑时先放行，子代理结束后再按规则处理父会话。
   * @param {'window-start'|'manual'} cause
   */
  async function pauseRunning(cause) {
    if (busy.pause) return [];
    busy.pause = true;
    try {
      const state = await readState();
      const now = Date.now();
      const handled = [];
      let changed = false;
      for (const agent of liveAgents()) {
        if (agent.status !== 'running') continue;
        const session = guardableSession(agent);
        if (session === null) continue;
        if (isExempt(agent.id)) continue;
        const { provider, model } = modelOf(agent);
        if (!isPeakPriced(provider, model)) continue;
        if ((bypass.get(agent.id) ?? 0) > now) continue;
        const desc = describeWindow(now, rulesFor(provider));
        if (desc.phase !== 'peak') continue;
        const existing = state.interrupted.find(
          (item) =>
            item.sessionId === agent.id &&
            (item.status === 'paused' || item.status === 'waiting-turn' || item.status === 'waiting-children'),
        );
        if (existing !== undefined) {
          existing.at = now;
          changed = true;
          continue;
        }
        const children = await hasRunningChildren(agent.id);
        const allowedTurn = currentTurn(agent);
        const item = {
          id: shortId('pause'),
          sessionId: agent.id,
          title: titleOf(session),
          model,
          provider,
          at: now,
          windowStart: desc.window?.startAt ?? null,
          windowEnd: desc.window?.endAt ?? null,
          status: children ? 'waiting-children' : pauseMode === 'finish-turn' ? 'waiting-turn' : 'paused',
          cause: children ? 'children' : pauseMode === 'finish-turn' ? 'finish-turn' : cause,
          allowedTurn,
        };
        state.interrupted.unshift(item);
        handled.push(item);
        if (item.status === 'paused') {
          try {
            await cancelSession(agent.id);
          } catch (error) {
            item.status = 'failed';
            item.error = messageOf(error);
            log('warn', `暂停会话 ${agent.id} 失败：${messageOf(error)}`);
          }
        }
      }
      if (handled.length > 0 || changed) await stateFile.write(state);
      return handled;
    } finally {
      busy.pause = false;
    }
  }

  /** 等待中的会话：父会话已空闲/当前轮已结束则完成；有新轮或子代理结束则按规则取消。 */
  async function checkWaitingFor(state, sessionId) {
    const items = state.interrupted.filter(
      (item) =>
        item.sessionId === sessionId && (item.status === 'waiting-turn' || item.status === 'waiting-children'),
    );
    if (items.length === 0) return false;
    const agent = service('agents')?.get?.(sessionId);
    let changed = false;
    const children = await hasRunningChildren(sessionId);
    for (const item of items) {
      if (item.status === 'waiting-children') {
        if (children) continue;
        if (agent?.status === 'running') {
          try {
            await cancelSession(sessionId);
            item.status = 'paused';
            item.at = Date.now();
            item.cause = 'children-ended';
            changed = true;
          } catch (error) {
            item.status = 'failed';
            item.error = messageOf(error);
            changed = true;
          }
        } else {
          item.status = 'completed';
          changed = true;
        }
        continue;
      }
      const turn = currentTurn(agent);
      if (agent?.status === 'running' && turn > (Number(item.allowedTurn) || 0)) {
        try {
          await cancelSession(sessionId);
          item.status = 'paused';
          item.at = Date.now();
          item.cause = 'turn-boundary';
          changed = true;
        } catch (error) {
          item.status = 'failed';
          item.error = messageOf(error);
          changed = true;
        }
      } else if (agent?.status !== 'running') {
        item.status = 'completed';
        changed = true;
      }
    }
    return changed;
  }

  async function checkWaiting(state) {
    const ids = [...new Set(state.interrupted
      .filter((item) => item.status === 'waiting-turn' || item.status === 'waiting-children')
      .map((item) => item.sessionId))];
    let changed = false;
    for (const sessionId of ids) {
      changed = (await checkWaitingFor(state, sessionId)) || changed;
    }
    return changed;
  }

  async function checkWaitingForId(sessionId) {
    if (waitingBusy.has(sessionId)) return;
    waitingBusy.add(sessionId);
    try {
      const state = await readState();
      const changed = await checkWaitingFor(state, sessionId);
      if (changed) {
        await stateFile.write(state);
        await status();
      }
    } catch (error) {
      log('warn', `检查等待会话 ${sessionId} 失败：${messageOf(error)}`);
    } finally {
      waitingBusy.delete(sessionId);
    }
  }

  /** 谷价开始时把仍在等待的项收尾：已完成当前轮的直接完成，不再无意义地恢复一轮。 */
  async function settleWaiting(state) {
    let changed = false;
    for (const item of state.interrupted) {
      if (item.status === 'waiting-turn' || item.status === 'waiting-children') {
        item.status = 'completed';
        item.completedAt = Date.now();
        changed = true;
      }
    }
    return changed;
  }

  /**
   * 恢复暂停中的任务；手动指定 sessionId 时也会重试此前失败的记录。
   * @param {'window-start'|'manual'} reason
   * @param {string[] | undefined} onlySessionIds
   */
  async function resumePaused(reason, onlySessionIds) {
    if (busy.resume) return [];
    busy.resume = true;
    try {
      const state = await readState();
      const items = state.interrupted.filter((item) => {
        if (onlySessionIds === undefined) return item.status === 'paused';
        return onlySessionIds.includes(item.sessionId) && (item.status === 'paused' || item.status === 'failed');
      });
      if (items.length === 0) return [];
      const results = [];
      const now = Date.now();
      for (const item of items) {
        bypass.set(item.sessionId, now + options.bypassMs);
        try {
          await promptSession(item.sessionId, resumeText(item));
          item.status = 'resumed';
          item.resumedAt = Date.now();
          item.resumedBy = reason;
          delete item.error;
        } catch (error) {
          item.status = 'failed';
          item.error = messageOf(error);
          item.failedAt = Date.now();
          log('warn', `恢复会话 ${item.sessionId} 失败：${messageOf(error)}`);
        }
        results.push(item);
      }
      await stateFile.write(state);
      return results;
    } finally {
      busy.resume = false;
    }
  }

  /** 到谷价时段后执行排定的工作。 */
  async function runDuePlans() {
    if (busy.plans) return [];
    busy.plans = true;
    try {
      const state = await readState();
      const due = state.plans.filter((item) => item.status === 'queued');
      if (due.length === 0) return [];
      const executed = [];
      for (const plan of due) {
        if (typeof plan.prompt === 'string' && plan.prompt.trim() !== '') {
          try {
            await promptSession(plan.sessionId, planText(plan));
            plan.status = 'done';
            plan.executedAt = Date.now();
            delete plan.error;
          } catch (error) {
            plan.status = 'failed';
            plan.error = messageOf(error);
          }
        } else {
          plan.status = 'done';
          plan.executedAt = Date.now();
        }
        executed.push(plan);
      }
      await stateFile.write(state);
      return executed;
    } finally {
      busy.plans = false;
    }
  }

  async function loadHolidayCache() {
    try {
      const text = await readFile(holidayCachePath, 'utf8');
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed?.dates)) {
        dynamicHolidays = parsed.dates.filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(String(item)));
        holidayFetchedAt = Number(parsed.fetchedAt) || 0;
        clearRulesCache();
      }
    } catch {
      /* 没有缓存时使用内置节假日 */
    }
  }

  function parseHolidayYear(year, body) {
    const out = [];
    const holidays = body?.holiday;
    if (holidays === null || typeof holidays !== 'object') return out;
    for (const [day, entry] of Object.entries(holidays)) {
      if (!/^\d{2}-\d{2}$/.test(day)) continue;
      const type = entry?.type?.type ?? entry?.type;
      if (type === 'workday') continue;
      if (entry?.holiday === true || type === 'holiday') out.push(`${year}-${day}`);
    }
    return out;
  }

  async function refreshHolidays(force = false) {
    if (holidayRefreshing || options.holidaySource !== 'auto') return;
    if (!force && Date.now() - holidayFetchedAt < 24 * 60 * 60 * 1000) return;
    holidayRefreshing = true;
    try {
      const year = zonedParts(new Date(), rulesFor(currentProvider()).timezone).year;
      const years = [year, year + 1];
      const dates = new Set();
      let fetched = false;
      for (const item of years) {
        try {
          const response = await fetch(`${options.holidayApi}/${item}`, {
            signal: AbortSignal.timeout(8000),
            headers: { accept: 'application/json' },
          });
          if (!response.ok) continue;
          const body = await response.json();
          for (const date of parseHolidayYear(item, body)) dates.add(date);
          fetched = true;
        } catch {
          /* 单个年份失败不影响其它年份 */
        }
      }
      if (dates.size > 0) {
        dynamicHolidays = [...dates];
        holidayFetchedAt = Date.now();
        clearRulesCache();
        await writeFile(holidayCachePath, JSON.stringify({ fetchedAt: holidayFetchedAt, dates: dynamicHolidays }, null, 2), 'utf8').catch(() => {});
      } else if (fetched) {
        holidayFetchedAt = Date.now();
      }
    } finally {
      holidayRefreshing = false;
    }
  }

  /** 峰时新起的任务：按模式停住/等子代理，谷价再恢复。 */
  async function onAgentRunning(agent) {
    if (disposed || !options.enabled || !options.deferNewTurnsOnPeak || busy.pause) return;
    if (deferring.has(agent.id)) return;
    const now = Date.now();
    if ((bypass.get(agent.id) ?? 0) > now) return;
    if (isExempt(agent.id)) return;
    const session = guardableSession(agent);
    if (session === null) return;
    const { provider, model } = modelOf(agent);
    if (!isPeakPriced(provider, model)) return;
    const desc = describeWindow(now, rulesFor(provider));
    if (desc.phase !== 'peak') return;
    deferring.add(agent.id);
    try {
      const state = await readState();
      const waiting = state.interrupted.find(
        (item) =>
          item.sessionId === agent.id &&
          (item.status === 'waiting-turn' || item.status === 'waiting-children' || item.status === 'paused'),
      );
      if (waiting !== undefined) {
        if (waiting.status === 'paused') return;
        const children = await hasRunningChildren(agent.id);
        if (waiting.status === 'waiting-children') {
          if (children) return;
          waiting.status = 'paused';
          waiting.at = now;
          waiting.cause = 'children-ended';
          await stateFile.write(state);
          await cancelSession(agent.id);
          await publish(describeWindow(Date.now(), rulesFor(provider)), state);
          return;
        }
        const turn = currentTurn(agent);
        if (turn <= (Number(waiting.allowedTurn) || 0)) return;
        waiting.status = 'paused';
        waiting.at = now;
        waiting.cause = 'turn-boundary';
        await stateFile.write(state);
        try {
          await cancelSession(agent.id);
        } catch (error) {
          waiting.status = 'failed';
          waiting.error = messageOf(error);
          await stateFile.write(state);
          log('warn', `暂停会话 ${agent.id} 失败：${messageOf(error)}`);
        }
        await publish(describeWindow(Date.now(), rulesFor(provider)), state);
        return;
      }
      const children = await hasRunningChildren(agent.id);
      if (children) {
        const item = {
          id: shortId('pause'),
          sessionId: agent.id,
          title: titleOf(session),
          model,
          provider,
          at: now,
          windowStart: desc.window?.startAt ?? null,
          windowEnd: desc.window?.endAt ?? null,
          status: 'waiting-children',
          cause: 'children',
          allowedTurn: currentTurn(agent),
        };
        state.interrupted.unshift(item);
        await stateFile.write(state);
        await publish(describeWindow(Date.now(), rulesFor(provider)), state);
        return;
      }
      const item = {
        id: shortId('pause'),
        sessionId: agent.id,
        title: titleOf(session),
        model,
        provider,
        at: now,
        windowStart: desc.window?.startAt ?? null,
        windowEnd: desc.window?.endAt ?? null,
        status: 'paused',
        cause: 'new-task',
      };
      state.interrupted.unshift(item);
      await stateFile.write(state);
      try {
        await cancelSession(agent.id);
      } catch (error) {
        item.status = 'failed';
        item.error = messageOf(error);
        await stateFile.write(state);
        log('warn', `暂停新任务 ${agent.id} 失败：${messageOf(error)}`);
      }
      await publish(describeWindow(Date.now(), rulesFor(provider)), state);
    } finally {
      deferring.delete(agent.id);
    }
  }

  async function tick() {
    if (disposed || busy.tick) return;
    busy.tick = true;
    try {
      const state = await readState();
      const now = Date.now();
      const desc = describeWindow(now, rulesFor(currentProvider()));

      if (options.holidaySource === 'auto' && now - holidayFetchedAt > 24 * 60 * 60 * 1000) {
        void refreshHolidays();
      }

      if (!restoreChecked) {
        restoreChecked = true;
        const recentlyActive = Number(state.meta.lastTick) > 0 && now - Number(state.meta.lastTick) < 5 * 60 * 1000;
        if (recentlyActive && state.meta.lastPhase !== null) lastPhase = state.meta.lastPhase;
      }

      if (!options.enabled) {
        lastPhase = desc.phase;
        state.meta.lastPhase = desc.phase;
        state.meta.lastTick = now;
        await stateFile.write(state);
        await publish(desc, state);
        return;
      }

      if (desc.phase === 'offpeak') {
        const settled = await settleWaiting(state);
        if (settled) await stateFile.write(state);
        if (options.resumeOnOffPeak) {
          if (resumeAt === 0) resumeAt = now + options.resumeDelayMs;
          if (now >= resumeAt) {
            await resumePaused('window-start');
            resumeAt = 0;
          }
        }
        await runDuePlans();
      } else {
        resumeAt = 0;
        if (await checkWaiting(state)) await stateFile.write(state);
        if (options.pauseRunningOnPeak && lastPhase === 'offpeak') {
          await pauseRunning('window-start');
        }
      }

      lastPhase = desc.phase;
      state.meta.lastPhase = desc.phase;
      state.meta.lastTick = now;
      await stateFile.write(state);
      await publish(desc, state);
    } catch (error) {
      log('warn', `tick 失败：${messageOf(error)}`);
    } finally {
      busy.tick = false;
    }
  }

  function start() {
    const offStatus = ctx.on('agent/status', ({ agent, status }) => {
      if (status !== 'running' || agent === undefined) return;
      void onAgentRunning(agent);
    });
    const offSubStart = ctx.on('subagent/start', (info) => {
      const child = info?.childSessionId ?? info?.childId ?? info?.id;
      const parent = info?.parentSessionId ?? info?.parentId ?? info?.parent?.id;
      if (child !== undefined && parent !== undefined) childParent.set(String(child), String(parent));
    });
    const offSubEnd = ctx.on('subagent/end', (info) => {
      const child = info?.childSessionId ?? info?.childId ?? info?.id;
      const parent = info?.parentSessionId ?? info?.parentId ?? (child !== undefined ? childParent.get(String(child)) : undefined);
      if (child !== undefined) childParent.delete(String(child));
      if (parent !== undefined) void checkWaitingForId(String(parent));
    });
    void loadHolidayCache().then(() => refreshHolidays(true));
    void tick();
    timer = setInterval(() => {
      void tick();
    }, options.pollMs);
    if (typeof timer.unref === 'function') timer.unref();
    return () => {
      disposed = true;
      if (timer !== null) clearInterval(timer);
      timer = null;
      for (const off of [offStatus, offSubStart, offSubEnd]) {
        try {
          off?.();
        } catch {
          /* ignore */
        }
      }
    };
  }

  async function status() {
    const state = await readState();
    const desc = describeWindow(Date.now(), rulesFor(currentProvider()));
    await publish(desc, state);
    return { desc, state, snapshot: await snapshotOf(desc, state) };
  }

  async function pauseNow() {
    const paused = await pauseRunning('manual');
    await status();
    return paused;
  }

  async function resumeNow(sessionIds) {
    const resumed = await resumePaused('manual', sessionIds);
    await status();
    return resumed;
  }

  async function addPlan(input) {
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
    if (title === '' && prompt === '') throw new Error('规划至少要有 title 或 prompt');
    const state = await readState();
    const sessionId = typeof input.sessionId === 'string' && input.sessionId.trim() !== '' ? input.sessionId.trim() : input.fallbackSessionId;
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new Error('无法确定要执行的会话：请在已知会话里调用，或显式传 sessionId');
    }
    const plan = {
      id: shortId('plan'),
      title: title === '' ? prompt.slice(0, 40) : title,
      prompt,
      sessionId,
      createdAt: Date.now(),
      status: 'queued',
      runAt: 'next-offpeak',
    };
    state.plans.unshift(plan);
    await stateFile.write(state);
    await status();
    return plan;
  }

  async function removePlan(id) {
    const state = await readState();
    const before = state.plans.length;
    state.plans = state.plans.filter((item) => item.id !== id);
    const removed = before !== state.plans.length;
    if (removed) await stateFile.write(state);
    await status();
    return removed;
  }

  async function clearPlans() {
    const state = await readState();
    const removed = state.plans.filter((item) => item.status === 'queued').length;
    state.plans = state.plans.filter((item) => item.status !== 'queued');
    await stateFile.write(state);
    await status();
    return removed;
  }

  async function runPlansNow() {
    const executed = await runDuePlans();
    await status();
    return executed;
  }

  async function setExempt(sessionId, exempt) {
    const id = String(sessionId);
    const state = await readState();
    if (exempt === true) {
      const session = service('sessions')?.get?.(id);
      state.exemptSessions[id] = { title: session !== undefined ? titleOf(session) : null, at: Date.now() };
    } else {
      delete state.exemptSessions[id];
    }
    await stateFile.write(state);
    exemptSessions = state.exemptSessions ?? {};
    await status();
    return { sessionId: id, exempt: exempt === true };
  }

  async function setModelRule(provider, model, value) {
    const key = `${String(provider ?? '')}/${String(model ?? '')}`;
    const state = await readState();
    if (value === null || value === undefined) delete state.modelRules[key];
    else state.modelRules[key] = value === true;
    await stateFile.write(state);
    modelRules = state.modelRules ?? {};
    await status();
    return { key, value: value === true ? true : null };
  }

  async function setPauseMode(mode) {
    const next = mode === 'finish-turn' ? 'finish-turn' : 'pause-now';
    const state = await readState();
    state.settings = state.settings ?? {};
    state.settings.pauseMode = next;
    await stateFile.write(state);
    pauseMode = next;
    await status();
    return next;
  }

  return {
    rules,
    options,
    dataDir,
    statusFile: statusFiles[0],
    start,
    status,
    pauseNow,
    resumeNow,
    addPlan,
    removePlan,
    clearPlans,
    runPlansNow,
    setExempt,
    setModelRule,
    setPauseMode,
    describe: (now = Date.now()) => describeWindow(now, rules),
    formatClock: (date) => formatClock(date, rules.timezone),
    formatDuration,
    isPeakPriced,
    modelOf,
    emptyState,
  };
}
