#!/usr/bin/env node
/**
 * FinGuard 安全引擎 —— 命令行测试运行器
 * 与 tests.html 共用同一套用例定义（testcases.js），
 * 保证「浏览器演示」与「CI 回归」结论一致。
 *
 * 运行：node tests/run.js
 */
const path = require('path');
const fs = require('fs');

// 在 Node 中补齐浏览器全局
global.window = undefined;
global.localStorage = (() => {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
})();

const E = require(path.join(__dirname, '..', 'src', 'engine.js'));
Object.assign(global, E);

const { results, run } = require('./testcases.js');

const C = { g: '\x1b[90m', ok: '\x1b[32m', bad: '\x1b[31m', r: '\x1b[0m', b: '\x1b[1m' };

// 用例定义模块需要断言函数
run(C);

const cases = results.filter(r => r.type === 'case');
const passed = cases.filter(r => r.ok).length;
const failed = cases.length - passed;

console.log('');
for (const r of results) {
  if (r.type === 'group') { console.log(`${C.b}${r.group}${C.r}`); continue; }
  const mark = r.ok ? `${C.ok}✓ PASS${C.r}` : `${C.bad}✗ FAIL${C.r}`;
  console.log(`  ${mark}  ${r.name}${r.ok ? '' : `\n         ${C.bad}${r.msg}${C.r}`}`);
}
console.log('');
console.log(`${C.b}总计 ${cases.length} 条：通过 ${passed}，失败 ${failed}，通过率 ${(passed / cases.length * 100).toFixed(1)}%${C.r}`);
console.log('');

fs.writeFileSync(
  path.join(__dirname, 'report.json'),
  JSON.stringify({ total: cases.length, passed, failed, rate: +(passed / cases.length * 100).toFixed(1), cases }, null, 2)
);
process.exit(failed ? 1 : 0);
