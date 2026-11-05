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
import {
  describeWindow,
  formatClock,
  formatDateClock,
  formatDuration,
  resolveRules,
} from './peak.js';
import { StateFile, emptyState, writeStatusFiles } from './store.js';

const DEFAULTS = {
  enabled: true,
  pauseRunningOnPeak: true,
  deferNewTurnsOnPeak: true,
  resumeOnOffPeak: true,
  modelPattern: 'deepseek',
  exemptModels: [],
  pollSeconds: 15,
  resumeDelaySeconds: 3,
  bypassMinutes: 10,
  alertMinutes: 10,
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
    pauseRunningOnPeak: config.pauseRunningOnPeak !== false && DEFAULTS.pauseRunningOnPeak,
    deferNewTurnsOnPeak: config.deferNewTurnsOnPeak !== false && DEFAULTS.deferNewTurnsOnPeak,
    resumeOnOffPeak: config.resumeOnOffPeak !== false && DEFAULTS.resumeOnOffPeak,
    modelPattern:
      typeof config.modelPattern === 'string' && config.modelPattern.trim() !== ''
        ? config.modelPattern.trim().toLowerCase()
        : DEFAULTS.modelPattern,
    exemptModels: Array.isArray(config.exemptModels) ? config.exemptModels.map((item) => String(item)) : [],
    pollMs: clampNumber(config.pollSeconds, DEFAULTS.pollSeconds, 5, 300) * 1000,
    resumeDelayMs: clampNumber(config.resumeDelaySeconds, DEFAULTS.resumeDelaySeconds, 0, 120) * 1000,
    bypassMs: clampNumber(config.bypassMinutes, DEFAULTS.bypassMinutes, 0, 120) * 60 * 1000,
    alertMinutes: clampNumber(config.alertMinutes, DEFAULTS.alertMinutes, 0, 120),
  };

  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  const dataDir = path.join(home, 'offpeak-guard');
  const stateFile = new StateFile(path.join(dataDir, 'state.json'));
  const statusFiles = [path.join(dataDir, 'status.json')];
  const mirror = path.join(os.homedir(), '.dsh', 'offpeak-guard', 'status.json');
  if (path.resolve(mirror) !== path.resolve(statusFiles[0])) statusFiles.push(mirror);

  const bypass = new Map();
  const deferring = new Set();
  const rulesCache = new Map();
  const busy = { tick: false, pause: false, resume: false, plans: false };
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
    if (typeof model !== 'string' || model === '' || options.exemptModels.includes(model)) return false;
    const needle = options.modelPattern;
    return model.toLowerCase().includes(needle) || String(provider ?? '').toLowerCase().includes(needle);
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
    if (!rulesCache.has(key)) rulesCache.set(key, resolveRules(config, provider));
    return rulesCache.get(key);
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
        peakPriced: isPeakPriced(route.provider, route.model),
      };
    }
    const activeRules = rulesFor(currentProvider());
    return {
      version: 1,
      generatedAt: Date.now(),
      preset: desc.preset,
      presetLabel: desc.presetLabel,
      timezone: desc.timezone,
      peakWeekdays: activeRules.peakWeekdays,
      peakWindows: activeRules.peakWindows.map((item) => ({ start: item.start, end: item.end })),
      discount: desc.discount,
      phase: desc.phase,
      phaseLabel: desc.phaseLabel,
      holiday: desc.holiday === true,
      localTime: desc.localTime,
      weekday: desc.weekday,
      window: desc.window,
      next: desc.next,
      alertMinutes: options.alertMinutes,
      model: {
        id: selected.model,
        label: label ?? selected.model,
        provider: selected.provider,
        peakPriced: isPeakPriced(selected.provider, selected.model),
      },
      sessions,
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
   * 峰时暂停所有正在跑的、使用峰谷计价模型的根会话。
   * @param {'window-start'|'manual'} cause
   */
  async function pauseRunning(cause) {
    if (busy.pause) return [];
    busy.pause = true;
    try {
      const state = await stateFile.read();
      const now = Date.now();
      const paused = [];
      let changed = false;
      for (const agent of liveAgents()) {
        if (agent.status !== 'running') continue;
        const session = guardableSession(agent);
        if (session === null) continue;
        const { provider, model } = modelOf(agent);
        if (!isPeakPriced(provider, model)) continue;
        if ((bypass.get(agent.id) ?? 0) > now) continue;
        const desc = describeWindow(now, rulesFor(provider));
        if (desc.phase !== 'peak') continue;
        const existing = state.interrupted.find((item) => item.sessionId === agent.id && item.status === 'paused');
        if (existing !== undefined) {
          existing.at = now;
          changed = true;
          continue;
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
          cause,
        };
        state.interrupted.unshift(item);
        paused.push(item);
        try {
          await cancelSession(agent.id);
        } catch (error) {
          item.status = 'failed';
          item.error = messageOf(error);
          log('warn', `暂停会话 ${agent.id} 失败：${messageOf(error)}`);
        }
      }
      if (paused.length > 0 || changed) await stateFile.write(state);
      return paused;
    } finally {
      busy.pause = false;
    }
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
      const state = await stateFile.read();
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
      const state = await stateFile.read();
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

  /** 峰时新起的任务：立刻停住，等谷价再恢复。 */
  async function onAgentRunning(agent) {
    if (disposed || !options.enabled || !options.deferNewTurnsOnPeak || busy.pause) return;
    if (deferring.has(agent.id)) return;
    const now = Date.now();
    if ((bypass.get(agent.id) ?? 0) > now) return;
    const session = guardableSession(agent);
    if (session === null) return;
    const { provider, model } = modelOf(agent);
    if (!isPeakPriced(provider, model)) return;
    const desc = describeWindow(now, rulesFor(provider));
    if (desc.phase !== 'peak') return;
    deferring.add(agent.id);
    try {
      const state = await stateFile.read();
      if (state.interrupted.some((item) => item.sessionId === agent.id && item.status === 'paused')) return;
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
      const state = await stateFile.read();
      const now = Date.now();
      const desc = describeWindow(now, rulesFor(currentProvider()));

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
    void tick();
    timer = setInterval(() => {
      void tick();
    }, options.pollMs);
    if (typeof timer.unref === 'function') timer.unref();
    return () => {
      disposed = true;
      if (timer !== null) clearInterval(timer);
      timer = null;
      try {
        offStatus?.();
      } catch {
        /* ignore */
      }
    };
  }

  async function status() {
    const state = await stateFile.read();
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
    const state = await stateFile.read();
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
    const state = await stateFile.read();
    const before = state.plans.length;
    state.plans = state.plans.filter((item) => item.id !== id);
    const removed = before !== state.plans.length;
    if (removed) await stateFile.write(state);
    await status();
    return removed;
  }

  async function clearPlans() {
    const state = await stateFile.read();
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
    describe: (now = Date.now()) => describeWindow(now, rules),
    formatClock: (date) => formatClock(date, rules.timezone),
    formatDuration,
    isPeakPriced,
    modelOf,
    emptyState,
  };
}
