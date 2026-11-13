/**
 * 设置路由的端到端接线测试（假 webServer + 假 connection，真 handler）。
 *
 * 验证点：
 *   - 宿主 `connection.requestRejection` 拒绝时，请求在进入业务逻辑前就被挡掉；
 *   - `connection` 缺失 / 抛错时失败关闭；
 *   - 放行后才轮到方法与路由校验；
 *   - 请求体超过 64 KiB 返回 413。
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// guard 的数据目录由 DSH_HOME 决定：指向临时目录，避免测试写用户的 state.json。
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'opg-admission-'));

const { apply } = await import('../index.js');

const ACTION_URL = '/plugins/dsh-offpeak-guard/action';

function fakeReq({ method = 'POST', url = ACTION_URL, headers = {}, body = null } = {}) {
  return {
    method,
    url,
    headers,
    resume() {},
    async *[Symbol.asyncIterator]() {
      if (body !== null) yield Buffer.from(body, 'utf8');
    },
  };
}

function fakeRes() {
  const state = { status: 0, headers: {}, body: '', ended: false };
  const res = {
    get statusCode() {
      return state.status;
    },
    set statusCode(value) {
      state.status = value;
    },
    setHeader(name, value) {
      state.headers[name.toLowerCase()] = value;
    },
    end(chunk) {
      if (chunk !== undefined) state.body += String(chunk);
      state.ended = true;
    },
  };
  return { res, state };
}

/** 用最小 Context 跑 apply，返回真正的路由 handler。 */
function mount({ connection } = {}) {
  let handler;
  const webCtx = {
    connection,
    webServer: {
      register(spec) {
        handler = spec.handler;
        return () => {};
      },
    },
    effect(fn) {
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
  };
  const ctx = {
    get: () => undefined,
    inject: (deps, cb) => cb(webCtx),
    // 不启动 tick loop 与工具注册：本测试只关心路由。
    effect: () => () => {},
    tools: { register: () => () => {} },
  };
  apply(ctx, { enabled: false });
  assert.equal(typeof handler, 'function', '路由应当注册');
  return handler;
}

async function call(handler, { connection, ...reqOptions } = {}) {
  const { res, state } = fakeRes();
  await handler(fakeReq(reqOptions), res);
  return state;
}

test('准入拒绝时直接回状态码，不进入业务逻辑', async () => {
  const seen = [];
  const handler = mount({
    connection: {
      requestRejection(request) {
        seen.push(request.headers);
        return 403;
      },
    },
  });
  const state = await call(handler, {
    headers: { host: '127.0.0.1:3080', origin: 'https://evil.example' },
    body: JSON.stringify({ action: 'pauseMode', mode: 'pause-now' }),
  });
  assert.equal(state.status, 403);
  assert.deepEqual(JSON.parse(state.body), { ok: false, error: 'unauthorized' });
  assert.deepEqual(seen, [{ host: '127.0.0.1:3080', origin: 'https://evil.example' }]);
});

test('没有 connection 服务时失败关闭', async () => {
  const handler = mount({});
  const state = await call(handler, { body: JSON.stringify({ action: 'pauseMode' }) });
  assert.equal(state.status, 403);
});

test('connection.requestRejection 抛错时失败关闭', async () => {
  const handler = mount({
    connection: {
      requestRejection() {
        throw new Error('auth unavailable');
      },
    },
  });
  const state = await call(handler, { body: JSON.stringify({ action: 'pauseMode' }) });
  assert.equal(state.status, 403);
});

test('放行后非 POST 仍按 404 处理', async () => {
  const handler = mount({ connection: { requestRejection: () => undefined } });
  const state = await call(handler, { method: 'GET' });
  assert.equal(state.status, 404);
});

test('放行的 pauseMode 请求返回 200', async () => {
  const handler = mount({ connection: { requestRejection: () => undefined } });
  const state = await call(handler, {
    body: JSON.stringify({ action: 'pauseMode', mode: 'finish-turn' }),
  });
  assert.equal(state.status, 200);
  assert.equal(JSON.parse(state.body).ok, true);
});

test('超过 64 KiB 的请求体返回 413', async () => {
  const handler = mount({ connection: { requestRejection: () => undefined } });
  const state = await call(handler, { body: 'x'.repeat(64 * 1024 + 1) });
  assert.equal(state.status, 413);
  assert.match(state.body, /too large/u);
});

test('准入先于体积检查：超限请求在未认证时仍是 403', async () => {
  const handler = mount({ connection: { requestRejection: () => 401 } });
  const state = await call(handler, { body: 'x'.repeat(64 * 1024 + 1) });
  assert.equal(state.status, 401);
});
