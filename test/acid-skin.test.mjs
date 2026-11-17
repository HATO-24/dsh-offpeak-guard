/**
 * 工业酸性皮肤适配：锁住 client.js 里的皮肤样式块，避免它退化成
 * 影响所有主题的全局覆盖，也避免关键布局规则被误删。
 *
 * 这些规则只描述“皮肤存在时”的行为，因此每条（包括逗号分组和
 * @media 内层）都必须以 html[data-industrial-acid] 开头；
 * 未安装皮肤时一分不生效。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const match = client.match(/const acidSkinStyle = `([\s\S]*?)`;/);
assert.ok(match, 'client.js 应定义 acidSkinStyle 常量');

const skinStyle = match[1];
const lines = skinStyle
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '');

const SCOPED = /^html\[data-industrial-acid\]/;

/** 取规则选择器部分；兼容一行一条规则的写法。 */
function selectorsOf(rule) {
  const brace = rule.indexOf('{');
  return brace === -1 ? '' : rule.slice(0, brace);
}

/** 拆分逗号分组，逐个检查作用域；否则 `html[...] .a, .b` 会漏掉 .b。 */
function assertScoped(selectorText, origin) {
  const parts = selectorText.split(',').map((part) => part.trim()).filter((part) => part !== '');
  assert.ok(parts.length > 0, `空选择器：${origin}`);
  for (const part of parts) {
    assert.match(part, SCOPED, `规则没有皮肤作用域（${origin}）：${part}`);
  }
}

test('皮肤样式块里的每条规则都以 html[data-industrial-acid] 开头', () => {
  for (const line of lines) {
    if (line.startsWith('@keyframes ')) continue;
    if (line.startsWith('@media ')) {
      // 本项目每个 @media 只包一条规则；内部仍要逐条检查作用域。
      const inner = line.slice(line.indexOf('{') + 1, line.lastIndexOf('}'));
      const innerRules = [...inner.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
      assert.ok(innerRules.length > 0, `@media 内没有规则：${line}`);
      for (const [, selector] of innerRules) assertScoped(selector, '@media');
      continue;
    }
    assertScoped(selectorsOf(line), 'rule');
  }
});

test('皮肤样式块的括号成对、规则体非空', () => {
  assert.equal((skinStyle.match(/\{/g) ?? []).length, (skinStyle.match(/\}/g) ?? []).length);
  for (const line of lines) {
    if (line.startsWith('@keyframes ')) continue;
    if (line.startsWith('@media ')) continue;
    const body = line.slice(line.indexOf('{') + 1, line.lastIndexOf('}')).trim();
    assert.notEqual(body, '', `空规则：${line}`);
  }
});

test('皮肤下 sidebar.footer.action 容器改为纵向堆叠', () => {
  const footer = lines.find(
    (line) => line.includes('div:has(> [data-slot="sidebar.footer.action"])'),
  );
  assert.ok(footer, '应包含 footer.action 容器规则');
  assert.match(footer, /^html\[data-industrial-acid\] div:has\(> \[data-slot="sidebar\.footer\.action"\]\)\{/);
  assert.match(footer, /flex-direction:column/);
});

test('皮肤下时钟改为整行直角样式并有紧凑态', () => {
  const clock = lines.find((line) => line.startsWith('html[data-industrial-acid] .opg-clock{'));
  assert.ok(clock);
  assert.match(clock, /width:100%/);
  assert.match(clock, /height:30px/);
  assert.match(clock, /border-radius:2px/);

  const compact = lines.find((line) => line.includes('[data-compact="true"]'));
  assert.ok(compact, '应保留折叠侧栏的紧凑时钟');
  assert.match(compact, /width:32px/);
});

test('皮肤下设置面板沿用皮肤的直角、等宽字体和色板', () => {
  const panel = lines.find((line) => line.startsWith('html[data-industrial-acid] .opg-panel{'));
  assert.ok(panel);
  assert.match(panel, /border-radius:2px/);
  assert.match(panel, /var\(--opg-page-border/);
  assert.match(panel, /box-shadow:7px 7px 0/);

  const heading = lines.find((line) => line.includes('.opg-panel-head strong'));
  assert.ok(heading);
  assert.match(heading, /var\(--opg-acid-font\)/);

  const search = lines.find((line) => line.includes('.opg-search'));
  assert.ok(search, '设置面板搜索框也要走皮肤直角');
  assert.match(search, /border-radius:2px/);
});

test('颜色变量必须定义在 body 上（html 上没有 --dsw alias token）', () => {
  const bodyRule = lines.find((line) => line.startsWith('html[data-industrial-acid] body{'));
  assert.ok(bodyRule, '应在 body 上定义 --opg-* 颜色变量');
  assert.match(bodyRule, /--opg-peak-dot:color-mix\(/);
  assert.match(bodyRule, /--opg-valley-dot:color-mix\(/);
  assert.match(bodyRule, /var\(--dsw-alias-label-primary\)/);
  assert.match(bodyRule, /--opg-page-label:var\(--dsw-alias-label-primary\)/);

  const htmlRule = lines.find((line) => line.startsWith('html[data-industrial-acid]{'));
  if (htmlRule !== undefined) {
    assert.ok(!htmlRule.includes('--opg-peak-dot'), '颜色变量不应定义在 html 上');
  }
});

test('侧栏内重算峰谷色，使用侧栏前景而不是页面前景', () => {
  const sidebarRule = lines.find((line) => line.startsWith('html[data-industrial-acid] [data-slot="sidebar"]{'));
  assert.ok(sidebarRule, '侧栏作用域应重算峰谷色');
  assert.match(sidebarRule, /--opg-peak-dot:color-mix\(/);
  assert.match(sidebarRule, /--opg-valley-dot:color-mix\(/);
});

test('减弱动效的关闭规则在闪烁规则之后，且皮肤关动效时也生效', () => {
  const red = skinStyle.indexOf('html[data-industrial-acid] .opg-clock[data-blink="red"]');
  const green = skinStyle.indexOf('html[data-industrial-acid] .opg-clock[data-blink="green"]');
  const reduce = skinStyle.indexOf('@media (prefers-reduced-motion: reduce)');
  assert.ok(red > 0 && green > 0 && reduce > red && reduce > green, 'reduce 规则必须在 animation 规则之后');
  assert.ok(lines.some((line) => line.includes('data-industrial-motion="off"') && line.includes('.opg-clock[data-blink]')));
});

test('皮肤下保留减弱动效的静态状态', () => {
  assert.ok(
    lines.some((line) => line.startsWith('@media (prefers-reduced-motion: reduce)') && line.includes('.opg-clock[data-blink]')),
    '应关闭皮肤下的闪烁动画',
  );
  assert.ok(lines.some((line) => line.startsWith('@keyframes opg-acid-blink-red')));
  assert.ok(lines.some((line) => line.startsWith('@keyframes opg-acid-blink-green')));
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
  assert.match(client, /\.opg-search\{[^}]*border-radius:7px/);
});
