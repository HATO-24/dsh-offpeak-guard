/**
 * dsh-offpeak-guard 入口（Host 半）。
 *
 * 三件事：
 *   1. 时间识别 —— 按 DeepSeek 夜间折扣规则判断现在处于峰值原价还是谷价；
 *   2. 模型识别 —— 只有使用峰谷计价模型的会话才会被暂停/恢复；
 *   3. 工作规划 —— 峰时暂停运行中的任务、延后新任务，谷价开始时自动恢复；
 *      另提供 offpeak_plan 把稍后要做的事排进谷价时段。
 */
import { createGuard } from './lib/guard.js';
import { createOffpeakTools } from './lib/tools.js';

export const name = 'offpeak-guard';
export const inject = ['tools'];

export function apply(ctx, config = {}) {
  const guard = createGuard(ctx, config ?? {});

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
}
