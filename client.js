/**
 * 峰谷守卫的 Web 半：输入框下方的状态条。
 * 只读展示，数据来自 Host 周期写出的 status.json，倒计时在本地按秒刷新。
 */
window.__ModuleLoader__.load({
  id: 'dsh-offpeak-guard',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'offpeak-guard';

    const zh = {
      peak: '峰时原价',
      offpeak: '谷价',
      toPeak: '距峰时',
      toOffpeak: '距谷价',
      paused: '已暂停',
      plans: '规划',
      title: 'DeepSeek 峰谷计价',
      windows: '峰时：工作日 09:00–12:00、14:00–18:00',
      offpeakNote: '谷价：其余时间（含周末与午间），按 5 折计费',
      model: '当前模型',
      guard: '守卫',
      on: '开',
      off: '关',
      pausedNote: '被峰时暂停的任务会在谷价开始时自动恢复',
      plansNote: '排定的错峰任务会在谷价时段自动执行',
      unavailable: '峰谷状态暂不可用',
      peakShort: '峰',
      valleyShort: '谷',
      toPeakShort: '距峰',
      toOffpeakShort: '距谷',
      clockHint: '临近切换时闪烁：红色 = 峰价快开始，绿色 = 谷价快开始',
      clockTitle: '峰谷计时',
      nextSwitch: '下次切换',
    };

    const en = {
      peak: 'Peak price',
      offpeak: 'Off-peak',
      toPeak: 'to peak',
      toOffpeak: 'to off-peak',
      paused: 'paused',
      plans: 'planned',
      title: 'DeepSeek peak/off-peak pricing',
      windows: 'Peak: weekdays 09:00–12:00 and 14:00–18:00',
      offpeakNote: 'Off-peak: all other hours (including weekends and lunch), billed at 50%',
      model: 'Model',
      guard: 'Guard',
      on: 'on',
      off: 'off',
      pausedNote: 'Tasks paused at peak resume automatically when off-peak starts',
      plansNote: 'Planned tasks run automatically during off-peak',
      unavailable: 'Off-peak status unavailable',
      peakShort: 'Peak',
      valleyShort: 'Valley',
      toPeakShort: 'to peak',
      toOffpeakShort: 'to off-peak',
      clockHint: 'Blink near the switch: red = peak starts soon, green = off-peak starts soon',
      clockTitle: 'Peak/off-peak timer',
      nextSwitch: 'next switch',
    };

    function fmtDuration(ms) {
      const totalMinutes = Math.floor(Math.max(0, ms) / 60000);
      if (totalMinutes < 1) return '不到1分';
      const days = Math.floor(totalMinutes / 1440);
      const hours = Math.floor((totalMinutes % 1440) / 60);
      const minutes = totalMinutes % 60;
      if (days > 0) return hours > 0 ? `${days}天${hours}小时` : `${days}天`;
      if (hours > 0) return minutes > 0 ? `${hours}小时${minutes}分` : `${hours}小时`;
      return `${minutes}分`;
    }

    function useLocale(ctx) {
      const [, force] = React.useState(0);
      React.useEffect(() => {
        if (!ctx.locale || typeof ctx.locale.subscribe !== 'function') return undefined;
        const off = ctx.locale.subscribe(() => force((value) => value + 1));
        return () => {
          if (typeof off === 'function') {
            try {
              off();
            } catch {
              /* ignore */
            }
          }
        };
      }, []);
      return ctx.locale ? ctx.locale.bind(NS) : (key) => key;
    }

    function snapshotTextOf(result) {
      if (result?.ok === false) throw new Error(result?.error?.message ?? 'status read failed');
      const page = result?.value ?? result;
      const text = typeof page === 'string' ? page : page?.text;
      if (typeof text !== 'string' || text.length === 0) throw new Error('status file is empty');
      return text;
    }

    function useSnapshot(ctx, sessionId) {
      const [snapshot, setSnapshot] = React.useState(null);
      const [error, setError] = React.useState(null);
      const busy = React.useRef(false);
      const mounted = React.useRef(true);

      const load = React.useCallback(async () => {
        if (busy.current) return;
        busy.current = true;
        try {
          const remote = ctx.remote;
          if (!remote || typeof remote.workspaceFiles?.read !== 'function') {
            throw new Error('remote.workspaceFiles 不可用');
          }
          let target = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null;
          if (target === null) {
            if (typeof remote.session?.list !== 'function') throw new Error('remote.session 不可用');
            const listed = await remote.session.list({});
            const items = listed?.value?.items ?? listed?.items ?? [];
            if (!Array.isArray(items) || items.length === 0) return;
            const sorted = [...items].sort(
              (left, right) => Number(right.updatedAt ?? right.lastActivityAt ?? 0) - Number(left.updatedAt ?? left.lastActivityAt ?? 0),
            );
            target = sorted[0]?.sessionId ?? sorted[0]?.id ?? null;
          }
          const home = remote.$host?.home;
          if (typeof target !== 'string' || target.length === 0) throw new Error('没有可用的会话');
          if (typeof home !== 'string' || home.length === 0) throw new Error('读不到 Harness 主目录');
          const result = await remote.workspaceFiles.read(target, `${home}/.dsh/offpeak-guard/status.json`, {});
          const parsed = JSON.parse(snapshotTextOf(result));
          if (mounted.current && parsed !== null && typeof parsed === 'object') {
            setSnapshot(parsed);
            setError(null);
          }
        } catch (caught) {
          if (mounted.current) setError(String(caught?.message ?? caught));
        } finally {
          busy.current = false;
        }
      }, [sessionId]);

      React.useEffect(() => {
        mounted.current = true;
        void load();
        const timer = setInterval(() => void load(), 30000);
        return () => {
          mounted.current = false;
          clearInterval(timer);
        };
      }, [load]);

      return { snapshot, error };
    }

    function makeStrip(pluginCtx) {
      return function Strip(props) {
        const ctx = pluginCtx;
        const t = useLocale(ctx);
      const { snapshot, error } = useSnapshot(ctx, props?.sessionId);
      const [, force] = React.useState(0);

      React.useEffect(() => {
        const timer = setInterval(() => force((value) => value + 1), 1000);
        return () => clearInterval(timer);
      }, []);

      if (snapshot === null) {
        if (error === null) return h('div', { style: { textAlign: 'center', fontSize: 11, opacity: 0.4, padding: '2px 0 4px' } }, '…');
        return h('div', { title: error, style: { textAlign: 'center', fontSize: 11, opacity: 0.5, padding: '2px 0 4px' } }, t('unavailable'));
      }

      const phase = snapshot.phase === 'peak' ? 'peak' : 'offpeak';
      const nextAt = Number(snapshot.next?.at);
      const remaining = Number.isFinite(nextAt) ? Math.max(0, nextAt - Date.now()) : 0;
      const ownModel =
        props?.sessionId && snapshot.sessions && typeof snapshot.sessions === 'object'
          ? snapshot.sessions[props.sessionId]
          : null;
      const activeModel = ownModel ?? snapshot.model ?? {};
      const modelId =
        typeof activeModel.label === 'string' && activeModel.label !== ''
          ? activeModel.label
          : typeof activeModel.id === 'string'
            ? activeModel.id
            : '';
      const paused = Number(snapshot.counts?.interrupted ?? 0);
      const plans = Number(snapshot.counts?.plans ?? 0);
      const guardOn = snapshot.guard?.enabled === true;
      const nextLabel = phase === 'peak' ? t('toOffpeak') : t('toPeak');

      const tip = [
        t('title'),
        t('windows'),
        t('offpeakNote'),
        `${t('model')}: ${modelId || '—'}${activeModel.peakPriced ? ` (${phase === 'peak' ? t('peak') : t('offpeak')})` : ''}`,
        `${t('guard')}: ${guardOn ? t('on') : t('off')}`,
        paused > 0 ? `${t('paused')}: ${paused} — ${t('pausedNote')}` : '',
        plans > 0 ? `${t('plans')}: ${plans} — ${t('plansNote')}` : '',
      ]
        .filter(Boolean)
        .join('\n');

      const children = [
        h('span', {
          key: 'dot',
          'aria-hidden': true,
          style: {
            width: 7,
            height: 7,
            borderRadius: '50%',
            flex: '0 0 auto',
            backgroundColor: phase === 'peak' ? '#e0a33e' : '#3f9d7a',
          },
        }),
        h('span', { key: 'phase', style: { fontWeight: 600 } }, t(phase)),
        h('span', { key: 'next' }, `${nextLabel} ${fmtDuration(remaining)}`),
      ];
      if (modelId !== '') children.push(h('span', { key: 'model', style: { opacity: 0.75 } }, `· ${modelId}`));
      if (paused > 0) children.push(h('span', { key: 'paused', style: { color: '#e0a33e' } }, `· ${t('paused')} ${paused}`));
      if (plans > 0) children.push(h('span', { key: 'plans' }, `· ${t('plans')} ${plans}`));

      return h(
        'div',
        {
          title: tip,
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            padding: '2px 6px 6px',
            fontSize: 11,
            lineHeight: 1.4,
            color: 'var(--dsw-alias-label-secondary, rgba(115,119,128,0.92))',
            userSelect: 'none',
          },
        },
        children,
      );
    };
    }

    function fmtClock(ms) {
      const total = Math.max(0, Math.floor(ms / 1000));
      const days = Math.floor(total / 86400);
      const hours = Math.floor((total % 86400) / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      const seconds = total % 60;
      const pad = (value) => String(value).padStart(2, '0');
      if (days > 0) return `${days}天${hours}时`;
      if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
      return `${minutes}:${pad(seconds)}`;
    }

    /** 平时只显示到分钟（紧凑，不挤占左栏其它按钮）；临近切换时显示秒。 */
    function fmtClockCompact(ms, withSeconds) {
      const total = Math.max(0, Math.floor(ms / 1000));
      const days = Math.floor(total / 86400);
      const hours = Math.floor((total % 86400) / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      const seconds = total % 60;
      const pad = (value) => String(value).padStart(2, '0');
      if (days > 0) return withSeconds ? `${days}天${hours}时` : `${days}天${hours}时`;
      if (hours > 0) return withSeconds ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${hours}:${pad(minutes)}`;
      return `${minutes}:${pad(seconds)}`;
    }

    const clockStyle = `
.opg-clock{box-sizing:border-box;display:inline-flex;flex:0 0 auto;align-items:center;gap:5px;width:auto;max-width:100%;min-height:32px;margin-left:auto;padding:4px 8px;border-radius:8px;color:var(--dsw-alias-label-primary,#252936);font:500 12px/18px var(--dsw-font-family,system-ui,sans-serif);white-space:nowrap;-webkit-app-region:no-drag;}
.opg-clock[data-compact="true"]{width:32px;min-height:32px;justify-content:center;padding:6px;gap:0;}
.opg-clock-dot{flex:none;width:7px;height:7px;border-radius:50%;background:currentColor;}
.opg-clock-state{flex:none;}
.opg-clock-time{flex:none;font-variant-numeric:tabular-nums;letter-spacing:.2px;}
.opg-clock[data-tone="peak"]{color:#e0554e;}
.opg-clock[data-tone="valley"]{color:#3f9d7a;}
.opg-clock[data-blink="red"]{animation:opg-blink-red .9s ease-in-out infinite;}
.opg-clock[data-blink="green"]{animation:opg-blink-green .9s ease-in-out infinite;}
@keyframes opg-blink-red{0%,100%{color:#e0554e;opacity:1;}50%{color:#ff8f8a;opacity:.4;}}
@keyframes opg-blink-green{0%,100%{color:#3f9d7a;opacity:1;}50%{color:#69d3aa;opacity:.4;}}
@media (prefers-reduced-motion: reduce){.opg-clock[data-blink]{animation:none;}}
`;

    function ClockIcon() {
      return h(
        'svg',
        {
          width: 16,
          height: 16,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { flex: 'none' },
        },
        [h('circle', { key: 'c', cx: 12, cy: 12, r: 8.5 }), h('path', { key: 'h', d: 'M12 7.5V12l3 1.8' })],
      );
    }

    function makeClock(pluginCtx) {
      return function Clock(props) {
        const t = useLocale(pluginCtx);
        const { snapshot } = useSnapshot(pluginCtx, null);
        const [, force] = React.useState(0);
        React.useEffect(() => {
          const timer = setInterval(() => force((value) => value + 1), 1000);
          return () => clearInterval(timer);
        }, []);
        if (snapshot === null) return null;

        const phase = snapshot.phase === 'peak' ? 'peak' : 'offpeak';
        const nextAt = Number(snapshot.next?.at);
        const remaining = Number.isFinite(nextAt) ? Math.max(0, nextAt - Date.now()) : 0;
        const alertMs = Math.max(0, Number(snapshot.alertMinutes ?? 10)) * 60000;
        const near = alertMs > 0 && remaining > 0 && remaining <= alertMs;
        const blink = near ? (phase === 'offpeak' ? 'red' : 'green') : null;
        const tone = phase === 'peak' ? 'peak' : 'valley';
        const wide = props?.wide !== false;
        const stateText = phase === 'peak' ? t('peakShort') : t('valleyShort');
        const dirText = phase === 'peak' ? t('toOffpeakShort') : t('toPeakShort');
        const modelId =
          typeof snapshot.model?.label === 'string' && snapshot.model.label !== ''
            ? snapshot.model.label
            : typeof snapshot.model?.id === 'string'
              ? snapshot.model.id
              : '';
        // 悬浮说明保持稳定：不能带每秒变化的倒计时，否则原生 tooltip 会被
        // 逐秒重置而看起来一直在闪。倒计时只放在可见文本里。
        const tip = [
          t('clockTitle'),
          `${stateText} · ${t('nextSwitch')} ${snapshot.next?.label ?? '--:--'}`,
          t('windows'),
          t('offpeakNote'),
          `${t('model')}: ${modelId || '—'}`,
          t('clockHint'),
        ]
          .filter(Boolean)
          .join('\n');

        const inner = wide
          ? [
              h('span', { key: 'dot', className: 'opg-clock-dot' }),
              h('span', { key: 'state', className: 'opg-clock-state' }, stateText),
              h('span', { key: 'time', className: 'opg-clock-time' }, fmtClockCompact(remaining, near)),
            ]
          : [ClockIcon()];

        return h(
          'div',
          {
            className: 'opg-clock',
            role: 'status',
            title: tip,
            'aria-label': `${stateText} ${dirText} ${fmtClock(remaining)}`,
            'data-tone': tone,
            'data-blink': blink ?? undefined,
            'data-compact': wide ? 'false' : 'true',
          },
          [h('style', { key: 'style' }, clockStyle)].concat(inner),
        );
      };
    }

    return {
      inject: ['slots', 'locale', 'remote', 'remote.session', 'remote.workspaceFiles'],
      apply(ctx) {
        const Strip = makeStrip(ctx);
        const Clock = makeClock(ctx);
        ctx.effect(() => ctx.locale.register(NS, { zh, en }));
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'offpeak-guard',
              order: 90,
            },
            Strip,
          ),
        );
        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            {
              name: 'sidebar.footer.action',
              id: 'offpeak-guard-clock',
              order: 45,
            },
            Clock,
          ),
        );
      },
    };
  },
});
