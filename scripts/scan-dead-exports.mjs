#!/usr/bin/env node
/*
 * 扫描「从未被引用的导出」——死代码候选
 * ------------------------------------------------------------------
 * 为什么需要它：`tsconfig.json` 开了 `noUnusedLocals`，但它只管**局部**未使用。
 * 导出符号只要有人 import 一次就不算 unused，而「谁都没 import」它**完全不报** ——
 * 于是删功能、改实现之后留下的孤儿导出会一直静静躺着。
 *
 * 用法：NODE_OPTIONS= npm run scan:dead
 *
 * 判据：某个导出名在整个 src/ + scripts/ 里，除它自己的定义处之外一次都没出现。
 *
 * ⚠️ **输出是线索，不是判决**。它认不出动态引用（`api[cmdName]()`、字符串注册表），
 * 也分不清「死代码」和「有意预留的 API」（本仓就有几个，注释里写明了用途）。
 * 删之前先确认两件事：① 名字没有被拼字符串调用 ② 不是有意留的接口。
 *
 * 脚本刻意**只报告、不退出非零**：零引用里混着契约类型与预留 API，
 * 拿它当门禁会天天误报，反而让人不再看它的输出。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SCAN_DIRS = ['src', 'scripts'];
const EXTS = ['.ts', '.tsx', '.mjs', '.js'];

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (EXTS.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

const files = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d)));
const texts = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));

/* 值导出（函数/常量/类）与类型导出分开收集 —— 两者「零引用」的含义完全不同 */
const RE_VALUE =
  /^export\s+(?:default\s+)?(?:async\s+)?(?:function|const|let|var|class|enum)\s+(\w+)/gm;
const RE_TYPE = /^export\s+(?:type|interface)\s+(\w+)/gm;

const values = new Map();
const types = new Map();
for (const [f, t] of texts) {
  if (!relative(ROOT, f).startsWith('src')) continue; // 只把 src 当「定义方」
  for (const m of t.matchAll(RE_VALUE)) {
    if (!values.has(m[1])) values.set(m[1], []);
    values.get(m[1]).push(f);
  }
  for (const m of t.matchAll(RE_TYPE)) {
    if (!types.has(m[1])) types.set(m[1], []);
    types.get(m[1]).push(f);
  }
}

function refs(name, defFiles) {
  const re = new RegExp(`\\b${name}\\b`, 'g');
  let n = 0;
  for (const [f, t] of texts) {
    const hits = (t.match(re) ?? []).length;
    n += defFiles.includes(f) ? Math.max(0, hits - 1) : hits;
  }
  return n;
}

const rel = (f) => relative(ROOT, f);
const deadValues = [...values].filter(([n, d]) => refs(n, d) === 0);
const deadTypes = [...types].filter(([n, d]) => refs(n, d) === 0);

console.log(
  `扫描 ${files.length} 个文件（${SCAN_DIRS.join(' + ')}），` +
    `${values.size} 个值导出 / ${types.size} 个类型导出\n`,
);

console.log(`=== 零引用的值导出（${deadValues.length}）—— 死代码候选，逐个确认后再删 ===`);
for (const [n, d] of deadValues.sort()) console.log(`  ${n.padEnd(30)} ${rel(d[0])}`);
if (deadValues.length === 0) console.log('  （无）');

console.log(`\n=== 零引用的类型导出（${deadTypes.length}）—— 多为契约形状，通常是有意保留 ===`);
for (const [n, d] of deadTypes.sort()) console.log(`  ${n.padEnd(30)} ${rel(d[0])}`);
if (deadTypes.length === 0) console.log('  （无）');

console.log(
  '\n提示：零引用 ≠ 该删。先确认它没被动态调用，再确认它不是有意留的接口（看注释）。',
);
