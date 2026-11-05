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
            sharedStatus.snapshot = parsed;
            for (const listener of sharedStatus.listeners) listener();
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

      return { snapshot, error, refresh: load };
    }

    const sharedStatus = { snapshot: null, listeners: new Set(), timer: null, loading: false, ctx: null };

    async function readSharedStatus(ctx) {
      const remote = ctx.remote;
      if (!remote || typeof remote.session?.list !== 'function' || typeof remote.workspaceFiles?.read !== 'function') return null;
      const listed = await remote.session.list({});
      const items = listed?.value?.items ?? listed?.items ?? [];
      if (!Array.isArray(items) || items.length === 0) return null;
      const sorted = [...items].sort(
        (left, right) => Number(right.updatedAt ?? right.lastActivityAt ?? 0) - Number(left.updatedAt ?? left.lastActivityAt ?? 0),
      );
      const home = remote.$host?.home;
      if (typeof home !== 'string' || home.length === 0) return null;
      const candidates = sorted
        .filter((item) => item?.parentSession === undefined && item?.parentSessionId === undefined)
        .map((item) => item?.sessionId ?? item?.id)
        .filter((id) => typeof id === 'string' && id.length > 0)
        .slice(0, 5);
      for (const sessionId of candidates) {
        try {
          const result = await remote.workspaceFiles.read(sessionId, `${home}/.dsh/offpeak-guard/status.json`, {});
          const parsed = JSON.parse(snapshotTextOf(result));
          if (parsed !== null && typeof parsed === 'object') return parsed;
        } catch {
          /* 换下一个最近会话再试 */
        }
      }
      return null;
    }

    async function loadSharedStatus(ctx) {
      if (sharedStatus.loading) return;
      sharedStatus.loading = true;
      try {
        const snapshot = await readSharedStatus(ctx);
        if (snapshot !== null) {
          sharedStatus.snapshot = snapshot;
          for (const listener of sharedStatus.listeners) listener();
        }
      } catch {
        /* 状态文件尚未生成时保持旧值 */
      } finally {
        sharedStatus.loading = false;
      }
    }

    function ensureSharedStatus(ctx) {
      sharedStatus.ctx = ctx;
      if (sharedStatus.timer !== null) return;
      void loadSharedStatus(ctx);
      sharedStatus.timer = setInterval(() => void loadSharedStatus(ctx), 30000);
    }

    function useSharedStatus(ctx) {
      const [, force] = React.useState(0);
      React.useEffect(() => {
        const listener = () => force((value) => value + 1);
        sharedStatus.listeners.add(listener);
        ensureSharedStatus(ctx);
        return () => {
          sharedStatus.listeners.delete(listener);
          if (sharedStatus.listeners.size === 0 && sharedStatus.timer !== null) {
            clearInterval(sharedStatus.timer);
            sharedStatus.timer = null;
          }
        };
      }, []);
      return sharedStatus.snapshot;
    }

    async function postAction(body) {
      const response = await fetch('/plugins/dsh-offpeak-guard/action', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      let json = {};
      try {
        json = text === '' ? {} : JSON.parse(text);
      } catch {
        json = {};
      }
      if (!response.ok || json.ok === false) throw new Error(json.error ?? `HTTP ${response.status}`);
      if (sharedStatus.ctx !== null) await loadSharedStatus(sharedStatus.ctx);
      return json;
    }

    function makeStrip(pluginCtx) {
      return function Strip(props) {
        const ctx = pluginCtx;
        const t = useLocale(ctx);
        const { snapshot, error, refresh } = useSnapshot(ctx, props?.sessionId);
        const [busy, setBusy] = React.useState(false);
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
      const currentSessionId = typeof props?.sessionId === 'string' ? props.sessionId : '';
      const currentExempt =
        currentSessionId !== '' &&
        (snapshot.exemptSessions ?? []).some((item) => item.sessionId === currentSessionId);
      if (currentSessionId !== '') {
        children.push(
          h(
            'button',
            {
              key: 'exempt',
              type: 'button',
              className: 'opg-exempt',
              'data-exempt': currentExempt ? 'true' : undefined,
              disabled: busy,
              title: currentExempt ? '取消本会话的峰谷豁免' : '让本会话豁免峰谷守卫（不暂停/不恢复）',
              onClick: async (event) => {
                event.stopPropagation();
                setBusy(true);
                try {
                  await postAction({ action: 'exempt', sessionId: currentSessionId, exempt: !currentExempt });
                  await refresh();
                } catch {
                  /* 下一次点击重试 */
                } finally {
                  setBusy(false);
                }
              },
            },
            [h(ShieldIcon, { key: 'icon', active: currentExempt }), currentExempt ? '取消豁免' : '豁免本会话'],
          ),
        );
      }

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
.opg-clock{box-sizing:border-box;display:inline-flex;flex:0 0 auto;align-items:center;gap:5px;width:auto;max-width:100%;min-height:32px;margin-left:auto;padding:4px 8px;border-radius:8px;color:var(--dsw-alias-label-primary,#252936);font:500 12px/18px var(--dsw-font-family,system-ui,sans-serif);white-space:nowrap;-webkit-app-region:no-drag;cursor:pointer;}
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
.opg-panel{border:none;border-radius:14px;padding:0;width:min(600px,92vw);max-height:84vh;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#252936);box-shadow:0 24px 80px #0006;font:13px/1.6 var(--dsw-font-family,system-ui,sans-serif);}
.opg-panel::backdrop{background:#0006;}
.opg-panel-shell{display:flex;flex-direction:column;max-height:84vh;}
.opg-panel-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 20px;border-bottom:1px solid var(--dsw-alias-border-l1,#dde0e6);}
.opg-panel-head strong{font-size:15px;}
.opg-panel-close{border:1px solid var(--dsw-alias-border-l1,#dde0e6);background:transparent;color:inherit;border-radius:8px;padding:4px 10px;cursor:pointer;font:inherit;}
.opg-panel-body{padding:16px 20px;overflow:auto;}
.opg-panel-meta{color:var(--dsw-alias-label-secondary,#6c7769);font-size:12px;margin-bottom:14px;}
.opg-section{margin-bottom:18px;}
.opg-section h4{margin:0 0 8px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#6c7769);}
.opg-row{display:flex;align-items:center;gap:10px;padding:6px 0;border-top:1px solid var(--dsw-alias-border-l1,#eef0f3);min-width:0;}
.opg-row:first-of-type{border-top:0;}
.opg-row-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.opg-row-sub{color:var(--dsw-alias-label-secondary,#8a8d94);font-size:11px;margin-left:4px;}
.opg-group-name{font-size:11px;color:var(--dsw-alias-label-secondary,#8a8d94);margin:8px 0 2px;}
.opg-check{width:15px;height:15px;accent-color:var(--dsw-alias-state-business-primary,#4d6bfe);flex:none;}
.opg-seg{display:inline-flex;border:1px solid var(--dsw-alias-border-l1,#dde0e6);border-radius:8px;overflow:hidden;}
.opg-seg button{border:0;background:transparent;color:inherit;padding:5px 10px;font:inherit;cursor:pointer;}
.opg-seg button[data-active="true"]{background:var(--dsw-alias-state-business-primary,#4d6bfe);color:#fff;}
.opg-note{color:var(--dsw-alias-label-secondary,#8a8d94);font-size:11px;line-height:1.6;}
.opg-error{color:#e0554e;font-size:12px;margin-top:8px;}
.opg-row-action{display:inline-flex;align-items:center;justify-content:center;flex:none;width:26px;height:26px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#6c7769);cursor:pointer;padding:0;}
.opg-row-action:hover{background:var(--dsw-alias-interactive-bg-hover,#4d6bfe12);color:var(--dsw-alias-label-primary,#252936);}
.opg-row-action[data-exempt="true"]{color:#e0554e;}
.opg-trail{display:inline-flex;align-items:center;justify-content:center;flex:none;color:#e0554e;opacity:.85;}
.opg-exempt{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--dsw-alias-border-l1,#dde0e6);border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#6c7769);font:11px/16px var(--dsw-font-family,system-ui,sans-serif);padding:1px 6px;cursor:pointer;white-space:nowrap;}
.opg-exempt[data-exempt="true"]{color:#e0554e;border-color:#e0554e66;}
.opg-exempt:hover{border-color:var(--dsw-alias-label-secondary,#8a8d94);}
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

    function useCatalog(ctx, enabled) {
      const [groups, setGroups] = React.useState([]);
      React.useEffect(() => {
        if (!enabled) return undefined;
        let alive = true;
        (async () => {
          try {
            const result = await ctx.remote.session.modelCatalog();
            const list = result?.value?.groups ?? result?.groups ?? [];
            if (alive && Array.isArray(list)) setGroups(list);
          } catch {
            /* 目录不可用时留空 */
          }
        })();
        return () => {
          alive = false;
        };
      }, [enabled]);
      return groups;
    }

    function SettingsPanel({ ctx, snapshot, refresh, groups, onClose }) {
      const [busy, setBusy] = React.useState('');
      const [error, setError] = React.useState('');
      const [query, setQuery] = React.useState('');
      const post = async (body) => {
        setBusy(`${body.action}:${body.sessionId ?? body.provider ?? body.mode ?? ''}`);
        setError('');
        try {
          const response = await fetch('/plugins/dsh-offpeak-guard/action', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
          const text = await response.text();
          let json = {};
          try {
            json = text === '' ? {} : JSON.parse(text);
          } catch {
            json = {};
          }
          if (!response.ok || json.ok === false) throw new Error(json.error ?? `HTTP ${response.status}`);
          await refresh();
        } catch (caught) {
          setError(String(caught?.message ?? caught));
        } finally {
          setBusy('');
        }
      };
      const modelManaged = (provider, model) => {
        const key = `${provider}/${model}`;
        if (Object.prototype.hasOwnProperty.call(snapshot.modelRules ?? {}, key)) return snapshot.modelRules[key] === true;
        if ((snapshot.peakPricedModels ?? []).length > 0) {
          return snapshot.peakPricedModels.includes(key) || snapshot.peakPricedModels.includes(model);
        }
        if ((snapshot.exemptModels ?? []).includes(model)) return false;
        const needle = String(snapshot.modelPattern ?? 'deepseek').toLowerCase();
        return model.toLowerCase().includes(needle) || provider.toLowerCase().includes(needle);
      };
      const sessions = Object.values(snapshot.sessions ?? {}).filter((session) => {
        if (query.trim() === '') return true;
        const needle = query.trim().toLowerCase();
        return String(session.title ?? '').toLowerCase().includes(needle) || String(session.id).toLowerCase().includes(needle);
      });
      return h('div', { className: 'opg-panel-shell' }, [
        h('div', { className: 'opg-panel-head', key: 'head' }, [
          h('strong', { key: 'title' }, '峰谷守卫设置'),
          h('button', { key: 'close', className: 'opg-panel-close', onClick: onClose }, '关闭'),
        ]),
        h('div', { className: 'opg-panel-body', key: 'body' }, [
          h(
            'div',
            { className: 'opg-panel-meta', key: 'meta' },
            `${snapshot.presetLabel ?? ''} · ${snapshot.phaseLabel ?? ''} · ${snapshot.holiday ? '今天法定节假日（全天谷价）' : '按工作日峰时'}`,
          ),
          h('div', { className: 'opg-section', key: 'mode' }, [
            h('h4', { key: 'h' }, '峰时策略'),
            h('div', { className: 'opg-seg' }, [
              h(
                'button',
                {
                  key: 'now',
                  'data-active': snapshot.pauseMode !== 'finish-turn' ? 'true' : 'false',
                  disabled: busy !== '',
                  onClick: () => post({ action: 'pauseMode', mode: 'pause-now' }),
                },
                '立即暂停',
              ),
              h(
                'button',
                {
                  key: 'finish',
                  'data-active': snapshot.pauseMode === 'finish-turn' ? 'true' : 'false',
                  disabled: busy !== '',
                  onClick: () => post({ action: 'pauseMode', mode: 'finish-turn' }),
                },
                '完成当前轮后暂停',
              ),
            ]),
            h('div', { className: 'opg-note', key: 'note' }, '有子代理在运行时，会先放行子代理；子代理结束后再暂停父会话。'),
          ]),
          h('div', { className: 'opg-section', key: 'models' }, [
            h('h4', { key: 'h' }, '模型管理（精确到 provider/model）'),
            groups.length === 0
              ? h('div', { className: 'opg-note', key: 'empty' }, '模型目录暂不可用；仍可在配置里用 modelPattern / exemptModels 管理。')
              : groups.map((group) =>
                  h('div', { key: `g:${group.id}` }, [
                    h('div', { className: 'opg-group-name', key: 'name' }, group.name ?? group.id),
                    ...(Array.isArray(group.models) ? group.models : []).map((model) =>
                      h('label', { className: 'opg-row', key: `m:${group.id}/${model.id}` }, [
                        h('input', {
                          className: 'opg-check',
                          type: 'checkbox',
                          checked: modelManaged(String(group.id), String(model.id)),
                          disabled: busy !== '',
                          onChange: (event) =>
                            post({
                              action: 'model',
                              provider: String(group.id),
                              model: String(model.id),
                              peakPriced: event.target.checked,
                            }),
                        }),
                        h('span', { className: 'opg-row-label' }, [
                          model.name ?? model.id,
                          h('span', { className: 'opg-row-sub', key: 'id' }, model.id),
                        ]),
                      ]),
                    ),
                  ]),
                ),
          ]),
          h('div', { className: 'opg-section', key: 'sessions' }, [
            h('h4', { key: 'h' }, '会话豁免（不参与暂停/恢复）'),
            h('input', {
              key: 'search',
              type: 'search',
              value: query,
              placeholder: '按标题或 session id 过滤…',
              onChange: (event) => setQuery(event.target.value),
              style: {
                width: '100%',
                boxSizing: 'border-box',
                margin: '0 0 6px',
                padding: '5px 8px',
                border: '1px solid var(--dsw-alias-border-l1,#dde0e6)',
                borderRadius: '7px',
                background: 'transparent',
                color: 'inherit',
                font: 'inherit',
              },
            }),
            sessions.length === 0
              ? h('div', { className: 'opg-note', key: 'empty' }, '没有匹配的运行中根会话。')
              : sessions.map((session) =>
                  h('label', { className: 'opg-row', key: `s:${session.id}` }, [
                    h('input', {
                      className: 'opg-check',
                      type: 'checkbox',
                      checked: session.exempt === true,
                      disabled: busy !== '',
                      onChange: (event) =>
                        post({ action: 'exempt', sessionId: String(session.id), exempt: event.target.checked }),
                    }),
                    h('span', { className: 'opg-row-label' }, [
                      session.title ?? session.id,
                      h('span', { className: 'opg-row-sub', key: 'model' }, session.id),
                    ]),
                  ]),
                ),
          ]),
          h('div', { className: 'opg-section', key: 'holidays' }, [
            h('h4', { key: 'h' }, '节假日'),
            h(
              'div',
              { className: 'opg-note', key: 'note' },
              snapshot.holidaySource === 'auto'
                ? `动态识别：已同步（${snapshot.holidaySyncedAt ? new Date(snapshot.holidaySyncedAt).toLocaleString() : '尚未同步'}），失败时回退内置 2026 列表。`
                : '使用内置节假日（可在配置 holidays 追加）。',
            ),
          ]),
          error === '' ? null : h('div', { className: 'opg-error', key: 'error' }, error),
        ]),
      ]);
    }

    function ShieldIcon({ active }) {
      return h(
        'svg',
        {
          width: 15,
          height: 15,
          viewBox: '0 0 24 24',
          fill: active ? 'currentColor' : 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        [h('path', { key: 'p', d: 'M12 3l7 3v5c0 4.4-2.9 8.1-7 10-4.1-1.9-7-5.6-7-10V6z' })],
      );
    }

    function makeRowAction(pluginCtx) {
      return function RowAction(props) {
        const snapshot = useSharedStatus(pluginCtx);
        const [busy, setBusy] = React.useState(false);
        const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : '';
        if (sessionId === '') return null;
        const exempt = (snapshot?.exemptSessions ?? []).some((item) => item.sessionId === sessionId);
        return h(
          'button',
          {
            type: 'button',
            className: 'opg-row-action',
            title: exempt ? '取消峰谷豁免' : '本会话豁免峰谷守卫',
            'aria-label': exempt ? '取消峰谷豁免' : '本会话豁免峰谷守卫',
            'aria-pressed': exempt,
            'data-exempt': exempt ? 'true' : undefined,
            disabled: busy,
            onClick: async (event) => {
              event.stopPropagation();
              setBusy(true);
              try {
                await postAction({ action: 'exempt', sessionId, exempt: !exempt });
              } catch {
                /* 状态文件/路由暂不可用时静默，下一次点击重试 */
              } finally {
                setBusy(false);
              }
            },
          },
          h(ShieldIcon, { active: exempt }),
        );
      };
    }

    function makeTrailing(pluginCtx) {
      return function Trailing(props) {
        const snapshot = useSharedStatus(pluginCtx);
        const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : '';
        if (snapshot === null || sessionId === '') return null;
        const exempt = (snapshot.exemptSessions ?? []).some((item) => item.sessionId === sessionId);
        if (!exempt) return null;
        return h('span', { className: 'opg-trail', title: '峰谷豁免中', 'aria-hidden': true }, h(ShieldIcon, { active: true }));
      };
    }

    function makeClock(pluginCtx) {
      return function Clock(props) {
        const t = useLocale(pluginCtx);
        const { snapshot, refresh } = useSnapshot(pluginCtx, null);
        const [open, setOpen] = React.useState(false);
        const dialogRef = React.useRef(null);
        const groups = useCatalog(pluginCtx, open);
        const [, force] = React.useState(0);
        React.useEffect(() => {
          const timer = setInterval(() => force((value) => value + 1), 1000);
          return () => clearInterval(timer);
        }, []);
        React.useEffect(() => {
          const dialog = dialogRef.current;
          if (dialog === null) return;
          if (open && !dialog.open) dialog.showModal();
          if (!open && dialog.open) dialog.close();
        }, [open]);
        React.useEffect(() => {
          const dialog = dialogRef.current;
          if (dialog === null) return undefined;
          const onClose = () => setOpen(false);
          dialog.addEventListener('close', onClose);
          return () => dialog.removeEventListener('close', onClose);
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
          '点击打开设置 / Click to open settings',
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

        const clock = h(
          'div',
          {
            className: 'opg-clock',
            role: 'status',
            title: tip,
            'aria-label': `${stateText} ${dirText} ${fmtClock(remaining)}`,
            'data-tone': tone,
            'data-blink': blink ?? undefined,
            'data-compact': wide ? 'false' : 'true',
            onClick: () => setOpen(true),
          },
          [h('style', { key: 'style' }, clockStyle)].concat(inner),
        );
        const dialog = h(
          'dialog',
          {
            key: 'dialog',
            ref: dialogRef,
            className: 'opg-panel',
            onClick: (event) => {
              if (event.target === event.currentTarget) setOpen(false);
            },
          },
          open
            ? h(SettingsPanel, {
                ctx: pluginCtx,
                snapshot,
                refresh,
                groups,
                onClose: () => setOpen(false),
              })
            : null,
        );
        return h(React.Fragment, null, [clock, dialog]);
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
        const RowAction = makeRowAction(ctx);
        const Trail = makeTrailing(ctx);
        ctx.slots.inject('sidebar.workspaces.session.row.action', () =>
          ctx.slots.register(
            {
              name: 'sidebar.workspaces.session.row.action',
              id: 'offpeak-guard-exempt',
              order: 150,
            },
            RowAction,
          ),
        );
        ctx.slots.inject('sidebar.session.row.trailing', () =>
          ctx.slots.register(
            {
              name: 'sidebar.session.row.trailing',
              id: 'offpeak-guard-exempt-trail',
              order: 20,
            },
            Trail,
          ),
        );
      },
    };
  },
});
