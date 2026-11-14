/**
 * offpeak_* 工具的模型侧定义。
 * 每个工具返回 { text, data }：text 给模型读，data 给界面/脚本用。
 */
import { formatDuration } from './peak.js';

const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      text: { type: 'string', description: '人类可读的结果摘要' },
      data: { type: 'object', additionalProperties: true, description: '同一结果的结构化字段' },
    },
    required: ['text', 'data'],
  },
  render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
};

const result = (text, data = {}) => ({ text, data });

/** 工具只能在真实会话内调用；返回调用者自己的 session id。 */
function callerSessionId(exec) {
  const id = exec?.agent?.id;
  if (typeof id !== 'string' || id === '') {
    throw new Error('该操作只能在会话内调用，无法确定当前会话');
  }
  return id;
}

/** 会话级操作默认且只允许作用于当前会话；显式传其它 sessionId 直接拒绝。 */
function ownSessionId(exec, requested) {
  const own = callerSessionId(exec);
  const target = typeof requested === 'string' && requested.trim() !== '' ? requested.trim() : own;
  if (target !== own) {
    throw new Error('只能操作当前会话；跨会话请从目标会话调用，或使用设置面板由用户操作');
  }
  return own;
}

/** 快照里的规划按创建者过滤，避免工具读取/管理其它会话的规划。 */
function ownPlanSnapshot(snapshot, owner) {
  const plans = (Array.isArray(snapshot.plans) ? snapshot.plans : []).filter(
    (item) =>
      item.createdBySessionId === owner ||
      ((item.createdBySessionId === null || item.createdBySessionId === undefined) &&
        item.sessionId === owner),
  );
  return {
    ...snapshot,
    plans,
    counts: { ...(snapshot.counts ?? {}), plans: plans.length },
  };
}

/** 状态工具只返回当前会话的暂停/豁免/规划明细；规则与倒计时保持全局。 */
function ownStatusSnapshot(snapshot, owner) {
  const interrupted = (Array.isArray(snapshot.interrupted) ? snapshot.interrupted : []).filter(
    (item) => item.sessionId === owner,
  );
  const exemptSessions = (Array.isArray(snapshot.exemptSessions) ? snapshot.exemptSessions : []).filter(
    (item) => item.sessionId === owner,
  );
  const plans = (Array.isArray(snapshot.plans) ? snapshot.plans : []).filter(
    (item) =>
      item.createdBySessionId === owner ||
      ((item.createdBySessionId === null || item.createdBySessionId === undefined) &&
        item.sessionId === owner),
  );
  const ownSession =
    snapshot.sessions !== null && typeof snapshot.sessions === 'object' ? snapshot.sessions[owner] : undefined;
  const sessions = ownSession !== undefined ? { [owner]: ownSession } : {};
  const model =
    ownSession !== undefined
      ? {
          id: ownSession.id,
          provider: ownSession.provider,
          label: ownSession.id,
          peakPriced: ownSession.peakPriced === true,
        }
      : snapshot.model;
  return {
    ...snapshot,
    model,
    interrupted,
    exemptSessions,
    plans,
    sessions,
    counts: {
      ...(snapshot.counts ?? {}),
      interrupted: interrupted.filter((item) => item.status === 'paused').length,
      waiting: interrupted.filter(
        (item) => item.status === 'waiting-turn' || item.status === 'waiting-children',
      ).length,
      exempt: exemptSessions.length,
      plans: plans.length,
    },
  };
}


function timeLine(desc) {
  return `现在：${desc.localTime} ${desc.weekday}（${desc.timezone}）`;
}

function phaseLine(desc) {
  return `时段：${desc.phaseLabel}${desc.holiday === true ? '（法定节假日，全天谷价）' : ''}`;
}

function weekdayText(days) {
  const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const list = Array.isArray(days) ? [...new Set(days)].sort((a, b) => a - b) : [];
  if (list.length === 7) return '每天';
  if (list.length === 5 && list.every((day, index) => day === index + 1)) return '周一至周五';
  if (list.length === 0) return '无';
  return list.map((day) => names[day] ?? String(day)).join('、');
}

function ruleLine(desc, snapshot) {
  const windows = Array.isArray(snapshot.peakWindows)
    ? snapshot.peakWindows.map((item) => `${item.start}–${item.end}`).join('、')
    : '—';
  const holiday = desc.holiday === true ? ' · 今天法定节假日全天空闲' : '';
  return `规则：${desc.presetLabel} · ${weekdayText(snapshot.peakWeekdays)} ${windows}${holiday}`;
}

function nextLine(desc) {
  const nextLabel = desc.next.phase === 'peak' ? '峰时原价' : '谷价';
  return `下次切换：${desc.next.label} 进入${nextLabel}（${formatDuration(desc.next.inMs)}后）`;
}

function modelLine(snapshot) {
  if (snapshot.model.id === null) return '模型：暂未读到当前会话的模型';
  const label =
    typeof snapshot.model.label === 'string' && snapshot.model.label !== '' && snapshot.model.label !== snapshot.model.id
      ? `${snapshot.model.label}（${snapshot.model.id}）`
      : snapshot.model.id;
  const priced = snapshot.model.peakPriced ? '适用峰谷计价' : '不适用峰谷计价（不会被暂停）';
  const provider = snapshot.model.provider === null ? '' : ` · ${snapshot.model.provider}`;
  return `模型：${label}${provider} · ${priced}`;
}

function guardLine(snapshot) {
  const guard = snapshot.guard;
  if (!guard.enabled) return '守卫：已关闭';
  const parts = [];
  if (guard.pauseRunningOnPeak) parts.push(snapshot.pauseMode === 'finish-turn' ? '峰时完成当前轮后暂停' : '峰时立即暂停');
  if (guard.deferNewTurnsOnPeak) parts.push('峰时新任务延后');
  if (guard.resumeOnOffPeak) parts.push('谷价自动恢复');
  return `守卫：开启 · ${parts.join(' · ')}`;
}

function exemptLine(snapshot) {
  const count = snapshot.counts.exempt;
  if (count === 0) return '会话豁免：无';
  const lines = [`会话豁免：${count} 个（不参与暂停/恢复）`];
  for (const item of snapshot.exemptSessions.slice(0, 5)) {
    lines.push(`  - ${item.title ?? item.sessionId}`);
  }
  return lines.join('\n');
}

function pauseLine(snapshot) {
  const count = snapshot.counts.interrupted;
  const waiting = snapshot.counts.waiting ?? 0;
  const parts = [];
  if (count > 0) parts.push(`暂停中：${count} 个任务（谷价开始后自动恢复）`);
  if (waiting > 0) parts.push(`等待中：${waiting} 个（当前轮结束或子代理结束后暂停）`);
  if (parts.length === 0) return '暂停中：无';
  const lines = [parts.join('；')];
  for (const item of snapshot.interrupted.slice(0, 5)) {
    const title = item.title === null ? item.sessionId : `${item.title}（${item.sessionId}）`;
    lines.push(`  - ${title} · 模型 ${item.model ?? '未知'} · ${formatAt(item.at)}`);
  }
  return lines.join('\n');
}

function planLine(snapshot) {
  const count = snapshot.counts.plans;
  if (count === 0) return '规划：无';
  const lines = [`规划：${count} 项（谷价时段执行）`];
  for (const item of snapshot.plans.slice(0, 8)) {
    lines.push(`  - ${item.title}${item.hasPrompt ? ' · 含指令' : ' · 仅提醒'}`);
  }
  return lines.join('\n');
}

function formatAt(at) {
  if (!Number.isFinite(Number(at))) return '未知时间';
  const date = new Date(Number(at));
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function statusText(desc, snapshot) {
  return [
    timeLine(desc),
    phaseLine(desc),
    ruleLine(desc, snapshot),
    nextLine(desc),
    modelLine(snapshot),
    guardLine(snapshot),
    exemptLine(snapshot),
    pauseLine(snapshot),
    planLine(snapshot),
  ].join('\n');
}

/**
 * @param {ReturnType<import('./guard.js').createGuard>} guard
 */
export function createOffpeakTools(guard) {
  return [
    {
      name: 'offpeak_status',
      description:
        '查看 DeepSeek 峰谷计价状态：现在处于峰值原价还是谷价时段、距下次切换多久、当前会话使用的模型是否适用峰谷计价，' +
        '以及当前会话被暂停了哪些任务、排定了哪些错峰规划。要在动手前判断「现在做这件事是否贵」，或想确认插件是否在工作时用它。' +
        '会话明细只返回当前会话，其它会话请在界面查看。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: OUTPUT,
      async execute(_args, exec) {
        const owner = callerSessionId(exec);
        const { desc, snapshot } = await guard.status();
        const mine = ownStatusSnapshot(snapshot, owner);
        return result(statusText(desc, mine), mine);
      },
    },
    {
      name: 'offpeak_plan',
      description:
        '错峰工作规划：把一件稍后再做的事排进队列，峰时排定、谷价时段自动执行（只会向调用本工具的当前会话发一条继续指令）。' +
        'action=add 需要 title 或 prompt；action=list 查看；action=remove 需要 id；action=clear 清空未执行的规划。' +
        '所有操作只作用于当前会话，显式传其它 sessionId 会被拒绝；适合「现在峰时，别开长任务，等 12:00 谷价再跑」这类安排。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'list', 'remove', 'clear'], description: '要执行的操作，默认 add' },
          title: { type: 'string', description: '规划名称（add 时建议填写）' },
          prompt: { type: 'string', description: '到谷价时段要发给当前会话的完整指令（add 时可选；省略则只做提醒）' },
          id: { type: 'string', description: 'remove 时要删除的规划 id' },
          sessionId: {
            type: 'string',
            description: '仅为兼容保留：只接受当前会话 id；省略即当前会话，传其它会话会被拒绝',
          },
        },
        additionalProperties: false,
      },
      output: OUTPUT,
      async execute(args, exec) {
        const action = typeof args?.action === 'string' ? args.action : 'add';
        const owner = callerSessionId(exec);
        if (action === 'add') {
          if (typeof args?.sessionId === 'string' && args.sessionId.trim() !== '' && args.sessionId.trim() !== owner) {
            throw new Error('只能为当前会话排定规划；跨会话请从目标会话调用');
          }
          const plan = await guard.addPlan({
            title: args?.title,
            prompt: args?.prompt,
            sessionId: owner,
            createdBySessionId: owner,
          });
          const desc = guard.describe();
          const when = desc.phase === 'offpeak' ? `下一轮检查（约 ${Math.round(guard.options.pollMs / 1000)} 秒内）` : `${desc.next.label} 谷价开始后`;
          return result(
            `已排定「${plan.title}」，会在${when}自动执行${plan.prompt ? '' : '（仅提醒，不含指令）'}。`,
            plan,
          );
        }
        if (action === 'remove') {
          if (typeof args?.id !== 'string' || args.id === '') throw new Error('remove 需要 id');
          const removed = await guard.removePlan(args.id, owner);
          return result(removed ? `已删除规划 ${args.id}。` : `没有找到规划 ${args.id}。`, { removed, id: args.id });
        }
        if (action === 'clear') {
          const removed = await guard.clearPlans(owner);
          return result(`已清空 ${removed} 项未执行的规划。`, { removed });
        }
        const { desc, snapshot } = await guard.status();
        const mine = ownPlanSnapshot(snapshot, owner);
        return result(planLine(mine) + `\n${nextLine(desc)}`, {
          plans: mine.plans,
          counts: { plans: mine.plans.length },
        });
      },
    },
    {
      name: 'offpeak_guard',
      description:
        '峰谷守卫的手动控制：status 查看当前会话状态；pause_now 按当前策略暂停当前会话的峰谷计价任务（峰时才生效）；' +
        'resume_now 立刻恢复当前会话被暂停的任务（谷价时才自动恢复，手动可在任何时段强制恢复）；run_plans_now 立刻执行当前会话排定的错峰规划；' +
        'exempt / unexempt 让当前会话豁免/取消豁免。' +
        '所有操作都只作用于调用本工具的当前会话；全局峰时策略请在设置面板由用户修改。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'pause_now', 'resume_now', 'run_plans_now', 'exempt', 'unexempt'],
            description: '要执行的操作，默认 status',
          },
          sessionId: {
            type: 'string',
            description: '仅为兼容保留：只接受当前会话 id；resume_now / exempt / unexempt 传其它会话会被拒绝',
          },
        },
        additionalProperties: false,
      },
      output: OUTPUT,
      async execute(args, exec) {
        const action = typeof args?.action === 'string' ? args.action : 'status';
        const owner = callerSessionId(exec);
        if (action === 'pause_now') {
          ownSessionId(exec, args?.sessionId);
          const handled = await guard.pauseNow(owner);
          const paused = handled.filter((item) => item.status === 'paused');
          const waiting = handled.filter((item) => item.status === 'waiting-turn' || item.status === 'waiting-children');
          const names = handled.map((item) => item.title ?? item.sessionId).join('、');
          return result(
            handled.length === 0
              ? '当前会话没有可暂停的任务（可能不在峰时，或任务模型不适用峰谷计价）。'
              : `已处理当前会话的 ${handled.length} 个任务：${names}。` +
                  (paused.length > 0 ? ` 已暂停 ${paused.length} 个。` : '') +
                  (waiting.length > 0 ? ` ${waiting.length} 个等当前轮/子代理结束后暂停。` : '') +
                  ' 谷价开始后会自动恢复。',
            { handled },
          );
        }
        if (action === 'resume_now') {
          ownSessionId(exec, args?.sessionId);
          const resumed = await guard.resumeNow([owner]);
          return result(resumed.length === 0 ? '当前会话没有需要恢复的任务。' : `已恢复 ${resumed.length} 个任务。`, { resumed });
        }
        if (action === 'run_plans_now') {
          const executed = await guard.runPlansNow(owner);
          return result(executed.length === 0 ? '当前会话没有待执行的错峰规划。' : `已执行 ${executed.length} 项规划。`, { executed });
        }
        if (action === 'exempt' || action === 'unexempt') {
          const sessionId = ownSessionId(exec, args?.sessionId);
          const resultState = await guard.setExempt(sessionId, action === 'exempt');
          return result(
            action === 'exempt' ? `已豁免会话 ${sessionId}，守卫不会再暂停它。` : `已取消会话 ${sessionId} 的豁免。`,
            resultState,
          );
        }
        if (action === 'pause_mode') {
          throw new Error('pause_mode 只能由用户在设置面板修改，模型工具不提供全局策略修改');
        }
        const { desc, snapshot } = await guard.status();
        const mine = ownStatusSnapshot(snapshot, owner);
        return result(statusText(desc, mine), mine);
      },
    },
  ];
}
