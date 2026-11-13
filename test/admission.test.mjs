/**
 * 设置路由的准入栅栏回归测试。
 *
 * 审查要求：路由必须用宿主 `connection.requestRejection` 做准入；拿不到
 * `connection` 或它抛错时直接拒绝，不能退回到只检查 Host/Origin/回环地址。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { admissionRejection } from '../index.js';

const req = { headers: { host: '127.0.0.1:3080', origin: 'https://evil.example' } };

test('没有 connection 服务时失败关闭，返回 403', () => {
  assert.equal(admissionRejection({}, req), 403);
  assert.equal(admissionRejection({ connection: null }, req), 403);
  assert.equal(admissionRejection({ connection: {} }, req), 403);
});

test('读取 connection 抛错时失败关闭，返回 403', () => {
  const ctx = {
    get connection() {
      throw new Error('service disposed');
    },
  };
  assert.equal(admissionRejection(ctx, req), 403);
});

test('requestRejection 自己抛错时失败关闭，返回 403', () => {
  const ctx = {
    connection: {
      requestRejection() {
        throw new Error('boom');
      },
    },
  };
  assert.equal(admissionRejection(ctx, req), 403);
});

test('requestRejection 放行时透传 undefined', () => {
  let seen;
  const ctx = {
    connection: {
      requestRejection(request) {
        seen = request;
        return undefined;
      },
    },
  };
  assert.equal(admissionRejection(ctx, req), undefined);
  assert.deepEqual(seen, { headers: req.headers });
});

test('requestRejection 的 401 / 403 原样透传', () => {
  const rejecting = (status) => ({
    connection: { requestRejection: () => status },
  });
  assert.equal(admissionRejection(rejecting(401), req), 401);
  assert.equal(admissionRejection(rejecting(403), req), 403);
});
