/**
 * 工业酸性皮肤适配：锁住 client.js 里的皮肤样式块，避免它退化成
 * 影响所有主题的全局覆盖，也避免关键布局规则被误删。
 *
 * 这些规则只描述“皮肤存在时”的行为，因此每条都必须以
 * html[data-industrial-acid] 开头；未安装皮肤时一分不生效。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const match = client.match(/const acidSkinStyle = `([\s\S]*?)`;/);
assert.ok(match, 'client.js 应定义 acidSkinStyle 常量');

const skinStyle = match[1];
// @keyframes 内部的关键帧不是选择器规则，先剥离再逐条检查作用域。
const rules = [...skinStyle.replace(/@keyframes\s+[\w-]+\s*\{(?:[^{}]|\{[^{}]*\})*\}/g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
  selector: selector.trim().replace(/\s+/g, ' '),
  body,
}));

test('皮肤样式块里的每条规则都以 html[data-industrial-acid] 开头', () => {
  for (const rule of rules) {
    if (rule.selector.startsWith('@keyframes ')) continue;
    assert.match(
      rule.selector,
      /^html\[data-industrial-acid\]/,
      `规则没有皮肤作用域：${rule.selector}`,
    );
  }
});

test('皮肤样式块的括号成对、规则体非空', () => {
  assert.equal((skinStyle.match(/\{/g) ?? []).length, (skinStyle.match(/\}/g) ?? []).length);
  for (const rule of rules) assert.notEqual(rule.body.trim(), '', `空规则：${rule.selector}`);
});

test('皮肤下 sidebar.footer.action 容器改为纵向堆叠', () => {
  const footer = rules.find((rule) => rule.selector.includes('[data-slot="sidebar.footer.action"]'));
  assert.ok(footer, '应包含 footer.action 容器规则');
  assert.match(footer.selector, /div:has\(> \[data-slot="sidebar\.footer\.action"\]\)/);
  assert.match(footer.body, /flex-direction:column/);
});

test('皮肤下时钟改为整行直角样式并有紧凑态', () => {
  const clock = rules.find((rule) => rule.selector === 'html[data-industrial-acid] .opg-clock');
  assert.ok(clock);
  assert.match(clock.body, /width:100%/);
  assert.match(clock.body, /height:30px/);
  assert.match(clock.body, /border-radius:2px/);

  const compact = rules.find((rule) => rule.selector.includes('[data-compact="true"]'));
  assert.ok(compact, '应保留折叠侧栏的紧凑时钟');
  assert.match(compact.body, /width:32px/);
});

test('皮肤下设置面板沿用皮肤的直角、等宽字体和色板', () => {
  const panel = rules.find((rule) => rule.selector === 'html[data-industrial-acid] .opg-panel');
  assert.ok(panel);
  assert.match(panel.body, /border-radius:2px/);
  assert.match(panel.body, /var\(--acid-rule/);
  assert.match(panel.body, /box-shadow:7px 7px 0/);

  const heading = rules.find((rule) => rule.selector.includes('.opg-panel-head strong'));
  assert.ok(heading);
  assert.match(heading.body, /var\(--opg-acid-font\)/);
});

test('皮肤样式不使用 !important，避免与皮肤互相压制', () => {
  assert.ok(!/!important/.test(skinStyle));
});

test('状态条通过 CSS 变量取色，皮肤下可自适应明暗', () => {
  assert.match(client, /var\(--opg-peak-dot, #e0a33e\)/);
  assert.match(client, /var\(--opg-valley-dot, #3f9d7a\)/);
  assert.match(client, /var\(--opg-peak-text, #e0a33e\)/);
  assert.match(client, /var\(--opg-held-text, #b26a00\)/);
  assert.match(client, /--opg-peak-dot:color-mix\(/);
  assert.match(client, /--opg-valley-dot:color-mix\(/);
});

test('未启用皮肤时保留原有默认样式', () => {
  assert.match(client, /\.opg-clock\{[^}]*min-height:32px/);
  assert.match(client, /\.opg-panel\{border:none;border-radius:14px/);
  assert.match(client, /\.opg-exempt\[data-exempt="true"\]\{color:#e0554e/);
});
