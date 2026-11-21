#!/usr/bin/env node
/*
 * Git 模块「字号 / 配色」合同核对
 * ------------------------------------------------------------------
 * 这里钉的是**两类静默故障** —— 它们都不会报错，只会让界面在某个设置下悄悄走样，
 * 靠肉眼看 diff 一定会漏：
 *
 *   ① 字号脱队：Tailwind 的 text-sm / text-xs / text-[10px] 是**固定 px**，
 *      而设置页的「基准字号」（13~18）改的是 --wb-font-base。
 *      两者混用后，同一块面板里会出现两种节奏：一部分文字跟着滑块变、一部分纹丝不动。
 *      规则：本模块里的字号只能来自 .git-fs-* 四档阶梯（git.css 里的 --git-fs-*）。
 *
 *   ② 颜色失配：用到的 wb-* 类如果**在 tailwind.config 里不存在**，Tailwind 会
 *      **静默忽略**它 —— 不报错、只是没有生效（曾经就有 4 处 text-wb-text-quaternary
 *      是这么躺着的：第四档文字色在 config 里根本没映射）。
 *      另外「只在浅色下配了色、深色忘了配」也是同类问题，所以补一条主题成对检查。
 *
 * 用法：
 *   npm run check:git-theme
 *   临时夹具自检（改规则后一定要跑一次，确认缺项时**真的会失败**）：
 *   GIT_THEME_DIR=/tmp/夹具目录 node scripts/check-git-theme.mjs
 *
 * 何时跑：改 src/features/git/ 下的任何 .tsx / .css 之后；新增模块想接入同一套规则时，
 *         先用 GIT_THEME_DIR 指向那个模块跑一遍，看清欠账再决定要不要收编。
 *
 * 注意：这里刻意用正则扫源码而不是引入解析器 —— 目标是「低成本地钉住一类静默故障」，
 * 不是做完整语法分析。代价是它只认**字面量类名**；若哪天真用变量拼类名（`text-${x}`），
 * 这里会漏。为此每条检查都带自检（扫到的样本太少就报错）—— 脚本本身失效时必须说出来，
 * 不能静静地报「全部通过」。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/* 路径可用环境变量覆盖 —— 这样能拿临时夹具验证「违规时真的会失败」，
   不必去改真实源码再改回来（改回来忘了改干净，比没有检查更糟）。 */
const MODULE_DIR = process.env.GIT_THEME_DIR ?? join(ROOT, 'src/features/git');

const problems = [];

/* ---------- 收集源码 ---------- */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|css)$/.test(name)) out.push(p);
  }
  return out;
}

let files = [];
try {
  files = walk(MODULE_DIR);
} catch (e) {
  console.error(`✗ 扫不到模块目录 ${MODULE_DIR}：${e.message}`);
  process.exit(1);
}
const codeFiles = files.filter((f) => /\.tsx?$/.test(f));
const cssFiles = files.filter((f) => f.endsWith('.css'));
const rel = (f) => f.replace(ROOT + '/', '');

/*
 * 自检 ①：一个模块至少要有一个组件文件和一个样式表。
 * 判据是「**一个都没有**」而不是「少于 N 个」—— 后者在小模块上会误报，
 * 而假警报多了真警报就没人看了（见本仓 check-label-contract 的同类注释）。
 * 零样本才是无歧义的信号：路径配错了，或模块被搬走了。
 */
if (codeFiles.length === 0 || cssFiles.length === 0) {
  console.error(
    `✗ ${MODULE_DIR}\n  扫到 ${codeFiles.length} 个 ts/tsx、${cssFiles.length} 个 css。\n` +
      '  零样本说明路径不对（或模块没有样式表，还接不了这套字号阶梯规则）。本次不做判定。',
  );
  process.exit(1);
}

/* ---------- tailwind 的可用颜色叶子（递归展开嵌套键） ---------- */
const twConfig = (await import(pathToFileURL(join(ROOT, 'tailwind.config.js')).href)).default;
const leaves = new Set();
(function collect(obj, prefix) {
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') leaves.add(prefix ? `${prefix}-${k}` : k);
    else collect(v, prefix ? `${prefix}-${k}` : k);
  }
})(twConfig.theme.extend.colors, '');

/* 自检 ②：颜色表抽不出东西 → 规则 2b 会退化成「永远通过」 */
if (leaves.size < 10) {
  problems.push(
    `从 tailwind.config.js 只抽出 ${leaves.size} 个颜色叶子，规则「类名必须存在」已失去基线。\n` +
      '  多半是 colors 的结构换了写法（比如改成引用变量），需要同步更新本脚本的收集逻辑。',
  );
}

/* =============================================
   ====== 规则 1a：TSX 里不得出现固定 px 字号 ======
   ============================================= */
/* 固定 px 的字号类会让文字与「基准字号」脱钩。任意值写法（text-[13px]）一并拦下。 */
const FIXED_FS = /\btext-(?:sm|xs|lg|xl|2xl|base|\[[0-9.]+(?:px|pt|rem|em)\])/g;
for (const f of codeFiles) {
  const src = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const m of src.matchAll(FIXED_FS)) {
    problems.push(
      `${rel(f)} 用了固定字号类 ${m[0]}\n` +
        '  它是固定 px，不随设置页的「基准字号」变化 —— 请改用 .git-fs-lg/md/sm/xs 之一。',
    );
  }
}

/* =============================================
   ====== 规则 1b：CSS 的 font-size 只能来自阶梯 ======
   ============================================= */
const SCALE_STEPS = ['lg', 'md', 'sm', 'xs'];
const FS_OK = new RegExp(`^font-size:\\s*var\\(--git-fs-(?:${SCALE_STEPS.join('|')})\\);`);

const allCss = cssFiles.map((f) => ({ f, src: readFileSync(f, 'utf8') })).find(({ src }) => src.includes('--git-fs-lg'));
/* 自检 ③：阶梯定义没了，规则 1b 就没有基线 */
if (!allCss) {
  problems.push(
    `在 ${cssFiles.map(rel).join('、')} 里找不到 --git-fs-lg 的定义。\n` +
      '  字号阶梯是规则 1b 的基线，缺了它这条规则会退化成「只要不是固定 px 就放行」。',
  );
}

const scaledOffsets = new Map();
for (const f of cssFiles) {
  const lines = readFileSync(f, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith('font-size:') && !FS_OK.test(t)) {
      problems.push(
        `${rel(f)}:${i + 1} 字号没走阶梯 → ${t}\n` +
          '  git.css 里只允许 font-size: var(--git-fs-*)；阶梯是唯一来源，改一处即可全局等比。',
      );
    }
  });
  /* 记录阶梯自身的偏移量，供后面算实际 px 用 */
  for (const m of readFileSync(f, 'utf8').matchAll(/--git-fs-(lg|md|sm|xs):\s*calc\(var\(--wb-font-base\)\s*-\s*(\d+)px\)/g)) {
    scaledOffsets.set(m[1], Number(m[2]));
  }
}

/* 自检 ④：四档偏移量必须都存在，否则阶梯自检无从谈起 */
if (scaledOffsets.size !== SCALE_STEPS.length) {
  problems.push(
    `只解析出 ${scaledOffsets.size}/${SCALE_STEPS.length} 档阶梯的偏移量（${[...scaledOffsets.keys()].join('、')}）。\n` +
      '  .git-fs-* 的写法变了，请同步更新本脚本的解析规则。',
  );
}

/* =============================================
   ====== 规则 2a：源码里不得出现硬编码色值 ======
   ============================================= */
/* 颜色一律走 --wb-* 令牌 / wb-* 类；模块里唯一允许写死色值的地方是 git.css 的
   「主题成对」块（需要透明度的 diff 底色、胶囊底色），那些在规则 2c 里单独核对。 */
const HARD_COLOR = /#[0-9a-fA-F]{3,8}\b|\brgba?\(/g;
for (const f of codeFiles) {
  const stripped = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const m of stripped.matchAll(HARD_COLOR)) {
    problems.push(
      `${rel(f)} 出现硬编码色值 ${m[0]}\n` +
        '  写死的颜色不会跟着浅色/深色切换 —— 请改用 wb-* 类或 --wb-* 令牌。',
    );
  }
}

/* =============================================
   ====== 规则 2b：用到的 wb-* 类必须真的存在 ======
   ============================================= */
/* Tailwind 对不存在的类**不报错**，只是不生成样式 —— 于是「颜色没生效」不留痕迹。 */
const WB_CLASS = /(?:^|[\s'"`:])((?:text|bg|border|fill|accent|ring|shadow)-wb-[a-z0-9-]+)/g;
const seenClasses = new Set();
/*
 * 嵌套的颜色键（wb-text 下的 tertiary）在收集时已经拼成了 `wb-text-tertiary`，
 * 与类名去掉前缀后完全一致，所以直接查表即可 —— 不需要再做前缀回退猜测。
 */
const isKnownColorKey = (key) => leaves.has(key);
for (const f of codeFiles) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(WB_CLASS)) {
    const cls = m[1];
    seenClasses.add(cls);
    if (!isKnownColorKey(cls.slice(cls.indexOf('wb-')))) {
      problems.push(
        `${rel(f)} 用了 ${cls}，但它在 tailwind.config.js 的 colors 里没有对应项\n` +
          '  Tailwind 对这种类**静默忽略**：不报错、也不生效 —— 于是「深色下没颜色」不留任何痕迹。',
      );
    }
  }
}
/* 自检 ⑤：一个 wb-* 都没扫到 —— 类名写法多半变了（阈值同自检 ①，不用「少于 N 个」） */
if (seenClasses.size === 0) {
  problems.push(
    '一个 wb-* 类名都没扫到，规则 2b 已失去意义。\n' +
      '  类的拼法（模板串 / 变量）可能变了，请同步更新本脚本的正则。',
  );
}

/* =============================================
   ====== 规则 2c：主题块必须成对 ======
   ============================================= */
/* 只在 html.light 下配了色、深色忘了配 —— 深色主题里那块样式会整块消失，
   而源码上看不出任何异常。这条把两套主题的选择器集合做相等比较。 */
const themeSelectors = { light: new Set(), dark: new Set() };
for (const f of cssFiles) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/html\.(light|dark)\s+([^{]+)\{/g)) {
    for (const sel of m[2].split(',')) themeSelectors[m[1]].add(sel.trim().replace(/\s+/g, ' '));
  }
}
const onlyLight = [...themeSelectors.light].filter((s) => !themeSelectors.dark.has(s));
const onlyDark = [...themeSelectors.dark].filter((s) => !themeSelectors.light.has(s));
if (themeSelectors.light.size === 0 && themeSelectors.dark.size === 0) {
  problems.push('一个 html.light / html.dark 块都没解析到，规则 2c 已失效（选择器写法变了？）。');
} else if (onlyLight.length > 0 || onlyDark.length > 0) {
  problems.push(
    '主题配色没有成对：\n' +
      (onlyLight.length ? `    只配了浅色：${onlyLight.join('、')}\n` : '') +
      (onlyDark.length ? `    只配了深色：${onlyDark.join('、')}\n` : '') +
      '  缺一侧时，另一套主题里那块样式会整块消失，且源码上看不出异常。',
  );
}

/* =============================================
   ====== 汇总 ======
   ============================================= */

if (problems.length === 0) {
  /* 阶梯实际取值顺带打出来：改基准字号上下限时能一眼看出各档落点 */
  const bases = [13, 16, 18];
  const table = bases
    .map((b) => `base ${b}: ${SCALE_STEPS.map((s) => `${s}=${b - (scaledOffsets.get(s) ?? 0)}`).join('  ')}`)
    .join('\n    ');
  console.log(
    `✓ ${MODULE_DIR.replace(ROOT + '/', '')} 的字号阶梯与配色合同全部满足\n` +
      `  （扫描 ${codeFiles.length} 个 ts/tsx、${cssFiles.length} 个 css；${seenClasses.size} 个 wb-* 类名；` +
      `主题块浅色 ${themeSelectors.light.size} / 深色 ${themeSelectors.dark.size}）\n` +
      `  字号阶梯实际取值：\n    ${table}`,
  );
  process.exit(0);
}

for (const p of problems) console.error(`\n✗ ${p}`);
process.exit(1);
