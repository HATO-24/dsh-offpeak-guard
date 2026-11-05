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
  if (guard.pauseRunningOnPeak) parts.push('峰时暂停运行中任务');
  if (guard.deferNewTurnsOnPeak) parts.push('峰时新任务延后');
  if (guard.resumeOnOffPeak) parts.push('谷价自动恢复');
  return `守卫：开启 · ${parts.join(' · ')}`;
}

function pauseLine(snapshot) {
  const count = snapshot.counts.interrupted;
  if (count === 0) return '暂停中：无';
  const lines = [`暂停中：${count} 个任务（谷价开始后自动恢复）`];
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
        '以及守卫暂停了哪些任务、排定了哪些错峰规划。要在动手前判断「现在做这件事是否贵」，或想确认插件是否在工作时用它。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: OUTPUT,
      async execute() {
        const { desc, snapshot } = await guard.status();
        return result(statusText(desc, snapshot), snapshot);
      },
    },
    {
      name: 'offpeak_plan',
      description:
        '错峰工作规划：把一件稍后再做的事排进队列，峰时排定、谷价时段自动执行（会向排定它的会话发一条继续指令）。' +
        'action=add 需要 title 或 prompt；action=list 查看；action=remove 需要 id；action=clear 清空未执行的规划。' +
        '适合「现在峰时，别开长任务，等 12:00 谷价再跑」这类安排。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'list', 'remove', 'clear'], description: '要执行的操作，默认 add' },
          title: { type: 'string', description: '规划名称（add 时建议填写）' },
          prompt: { type: 'string', description: '到谷价时段要发给会话的完整指令（add 时可选；省略则只做提醒）' },
          id: { type: 'string', description: 'remove 时要删除的规划 id' },
          sessionId: { type: 'string', description: '执行该规划的会话 id；省略时用调用本工具的会话' },
        },
        additionalProperties: false,
      },
      output: OUTPUT,
      async execute(args, exec) {
        const action = typeof args?.action === 'string' ? args.action : 'add';
        if (action === 'add') {
          const plan = await guard.addPlan({
            title: args?.title,
            prompt: args?.prompt,
            sessionId: args?.sessionId,
            fallbackSessionId: exec?.agent?.id,
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
          const removed = await guard.removePlan(args.id);
          return result(removed ? `已删除规划 ${args.id}。` : `没有找到规划 ${args.id}。`, { removed, id: args.id });
        }
        if (action === 'clear') {
          const removed = await guard.clearPlans();
          return result(`已清空 ${removed} 项未执行的规划。`, { removed });
        }
        const { desc, snapshot } = await guard.status();
        return result(planLine(snapshot) + `\n${nextLine(desc)}`, snapshot);
      },
    },
    {
      name: 'offpeak_guard',
      description:
        '峰谷守卫的手动控制：status 查看完整状态；pause_now 立刻暂停当前所有正在运行的峰谷计价任务（峰时才生效）；' +
        'resume_now 立刻恢复被暂停的任务（谷价时才自动恢复，手动可在任何时段强制恢复）；run_plans_now 立刻执行排定的错峰规划。' +
        '用户明确要求「先停一下 / 现在就恢复」时使用。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'pause_now', 'resume_now', 'run_plans_now'],
            description: '要执行的操作，默认 status',
          },
          sessionId: { type: 'string', description: 'resume_now 时只恢复这个会话；省略则恢复全部' },
        },
        additionalProperties: false,
      },
      output: OUTPUT,
      async execute(args) {
        const action = typeof args?.action === 'string' ? args.action : 'status';
        if (action === 'pause_now') {
          const paused = await guard.pauseNow();
          const names = paused.map((item) => item.title ?? item.sessionId).join('、');
          return result(
            paused.length === 0 ? '当前没有可暂停的任务（可能不在峰时，或任务模型不适用峰谷计价）。' : `已暂停 ${paused.length} 个任务：${names}。谷价开始后会自动恢复。`,
            { paused },
          );
        }
        if (action === 'resume_now') {
          const sessionId = typeof args?.sessionId === 'string' && args.sessionId !== '' ? args.sessionId : undefined;
          const resumed = await guard.resumeNow(sessionId === undefined ? undefined : [sessionId]);
          return result(resumed.length === 0 ? '没有需要恢复的任务。' : `已恢复 ${resumed.length} 个任务。`, { resumed });
        }
        if (action === 'run_plans_now') {
          const executed = await guard.runPlansNow();
          return result(executed.length === 0 ? '没有待执行的错峰规划。' : `已执行 ${executed.length} 项规划。`, { executed });
        }
        const { desc, snapshot } = await guard.status();
        return result(statusText(desc, snapshot), snapshot);
      },
    },
  ];
}
