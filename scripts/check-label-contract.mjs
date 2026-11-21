/*
 * 余额模块「契约」机械核对
 * ------------------------------------------------------------------
 * 这里钉的是**两类静默故障** —— 它们都不会报错，只会让界面/菜单栏少显示东西，
 * 靠肉眼看 diff 一定会漏：
 *
 *   ① 标签契约：后端产出的 `BalanceItem.label` 会被前端 `shortLabel()` 换成短标签
 *      塞进 95 字节的蓝牙摘要。对不上不会报错，只是悄悄退回全称 ——
 *      表现为「徽章上少显示了几个平台」（预算被长标签吃掉）。
 *
 *   ② 平台短名契约：菜单栏上的名字用 `tray.providerShort()` 压短
 *      （"Qoder CN" → "Qoder"）。新增平台而没登记短名时，会退回长展示名 ——
 *      用户没自定义名字时，那一格就用不上简洁的名字。
 *
 *   ③ 平台**图标字形**契约：菜单栏上每个平台占一格，靠图标区分，
 *      字形来自 `tray.PROVIDER_GLYPH`。这里查两件事：
 *        · 每个后端平台都登记了字形（漏了会退回平台 id 的首字母，可能撞车）
 *        · **字形两两不同** —— 两个平台用同一个字母时，菜单栏上会出现两格
 *          长得一模一样的项，图标就彻底失去意义了。这件事**不报任何错**，
 *          只有肉眼比对才看得出来，所以必须机械地钉住。
 *
 *   ④ 平台**品牌 logo** 契约：有 logo 的平台（`icons.PROVIDER_LOGO_ALPHA`）
 *      图标恒为 logo 而不是字形。这里查三件事：
 *        · 登记的 id 是真平台（拼错一个字母就会静默退回字形，看不出来）
 *        · base64 解出来**正好 1296 字节**（36×36）—— 长度不对时 `logoBitmap`
 *          会返回 null 并静默退回字形，同样不报错
 *        · **位图不是「全透明」也不是「实心方块」** —— 这两种都是合法的 1296 字节，
 *          能骗过上面两条：`logoBitmap` 照常返回位图、`trayIcons` 照常把它算成
 *          「图标在」，而菜单栏上那一格**什么都没有**（全透明）或**一个白方块**
 *          （实心）。也就是诊断说「正常」、屏幕上却是空的。
 *
 * 用法：npm run check:labels
 * 何时跑：新增/修改 balances 平台、改了任何 `build_balance`、改了 SHORT_LABEL、
 *         或改了 tray.ts 的 PROVIDER_SHORT / PROVIDER_GLYPH、icons.ts 的
 *         PROVIDER_LOGO_ALPHA 之后。
 *
 * 注意：这里刻意用正则扫源码而不是引入解析器 —— 目标是「低成本地钉住一类静默故障」，
 * 不是做完整的语法分析。代价是它只能认出字面量形式；若哪天后端改成用变量拼标签，
 * 这里会漏（但也说明契约本身变脆了）。为此每条检查都带「抽出来的条目太少就报错」的
 * 自检 —— 脚本本身失效时要说出来，不能静静地报「全部通过」。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/* 路径可用环境变量覆盖 —— 这样能拿临时夹具验证「缺项时真的会失败」，
   不必去改真实源码再改回来（改回来忘了改干净，比没有检查更糟）。 */
const RS_DIR = process.env.LABEL_RS_DIR ?? join(ROOT, 'src-tauri/src/modules/balances');
const TS_FILE = process.env.LABEL_TS_FILE ?? join(ROOT, 'src/features/balances/format.ts');
const TRAY_FILE = process.env.LABEL_TRAY_FILE ?? join(ROOT, 'src/features/balances/tray.ts');
const ICONS_FILE = process.env.LABEL_ICONS_FILE ?? join(ROOT, 'src/features/balances/icons.ts');

const problems = [];

/* =============================================
   ====== 检查 ①：后端 label → 前端短标签 ======
   ============================================= */

/* 覆盖三种写法：
     label: "组织资源包".into()
     label: format!("专用资源包 {}", i + 1)
     push_quota(&mut items, "额度已用", q)        ← 标签是第二实参，容易漏
   第三种最阴：它不出现在 `label:` 字样里，纯靠肉眼看 diff 一定会漏。

   ⚠️ 但 `label:` 这个字样**并非只出现在余额指标上**：`models::CredField`（平台凭证
   字段声明，如 Trae 的「Authorization（整段…）」）也用 `label` 当字段名，而那类标签
   是**输入框标题**，永远不会进蓝牙摘要、也不需要短标签。所以扫之前先把
   `CredField { … }` 整块剥掉 —— 否则每加一个凭证字段都会报一次假警报，
   而假警报多了真警报就没人看了。 */
const PATTERNS = [
  /label:\s*"([^"]+)"/g,
  /label:\s*format!\(\s*"([^"{]+)/g,
  /push_quota\(\s*&mut\s+\w+\s*,\s*"([^"]+)"/g,
];

/*
 * 剥掉 CredField 字面量块（结构里没有嵌套大括号，所以 [^{}]* 够用）。
 * 带自检：文件里出现 CredField 却一个块都没剥到，说明写法变了（比如换成结构体变量
 * 构造），这时报错让人来更新规则 —— 不能静静地继续扫、然后报一堆假警报。
 */
const credFieldFiles = [];
const backendLabels = new Set();
for (const file of readdirSync(RS_DIR).filter((f) => f.endsWith('.rs'))) {
  const raw = readFileSync(join(RS_DIR, file), 'utf8');
  let stripped = 0;
  const src = raw.replace(/CredField\s*\{[^{}]*\}/gs, () => {
    stripped += 1;
    return '';
  });
  if (raw.includes('CredField') && stripped === 0) credFieldFiles.push(file);
  for (const re of PATTERNS) {
    for (const m of src.matchAll(re)) backendLabels.add(m[1]);
  }
}

if (credFieldFiles.length > 0) {
  console.error(
    `✗ 这些文件里出现了 CredField 但一个字面量块都没剥到：${credFieldFiles.join('、')}\n` +
      '  说明凭证字段的构造写法变了（不再是 CredField { … } 字面量），本脚本的剥离规则已失效。\n' +
      '  请更新 scripts/check-label-contract.mjs，否则下面的短标签比对会把输入框标题也算进去。',
  );
  process.exit(1);
}

/* ---------- 抽前端短标签表 ---------- */
const ts = readFileSync(TS_FILE, 'utf8');

const tableBody = /SHORT_LABEL[^{]*\{(.*?)\n\};/s.exec(ts);
if (!tableBody) {
  console.error('✗ 在 format.ts 里找不到 SHORT_LABEL 表 —— 检查脚本已失效，请更新它');
  process.exit(1);
}
const exactKeys = new Set(
  [...tableBody[1].matchAll(/^\s*([^\s:{}]+)\s*:/gm)].map((m) => m[1]),
);

/* 前缀表：带序号的动态标签（`专用资源包 1`）静态表放不下，按前缀归一 */
const prefixBody = /SHORT_LABEL_PREFIX[^=]*=\s*\[(.*?)\];/s.exec(ts);
const prefixes = prefixBody
  ? [...prefixBody[1].matchAll(/\['([^']+)'/g)].map((m) => m[1])
  : [];

/* ---------- 比对 ---------- */
const missing = [...backendLabels]
  .filter((l) => !exactKeys.has(l) && !prefixes.some((p) => l.startsWith(p)))
  .sort();

console.log(`后端产出 label：${backendLabels.size} 个`);
console.log(`前端短标签：精确 ${exactKeys.size} 项，前缀 ${prefixes.length} 项`);
if (prefixes.length) console.log(`  前缀表：${prefixes.map((p) => `「${p}…」`).join('、')}`);

if (missing.length > 0) {
  problems.push(
    `有 ${missing.length} 个 label 没登记短标签：\n` +
      missing.map((l) => `    ${l}`).join('\n') +
      '\n  这些标签会原样进蓝牙摘要，把 95 字节预算吃掉，可能让整个平台被丢弃。' +
      '\n  到 src/features/balances/format.ts 的 SHORT_LABEL 里补上，' +
      '\n  并在 scripts/logic-test.ts 加一条断言钉住。',
  );
}

/* =============================================
   ====== 检查 ②：平台 id → 菜单栏短名 ======
   ============================================= */

/*
 * 平台 id 只在 all_providers() 里定义，且是元组的第一个元素：
 *       (
 *           "chatgpt",
 *           "ChatGPT",
 * 所以先把这个函数的**函数体**切出来，再只认「整行只有一个字符串字面量」的行 ——
 * 不在函数体内扫，是因为 commands.rs 别处也有独立成行的字符串（错误消息等）。
 */
const cmdSrc = readFileSync(join(RS_DIR, 'commands.rs'), 'utf8');
const fnStart = cmdSrc.indexOf('fn all_providers');
const fnEnd = fnStart < 0 ? -1 : cmdSrc.indexOf('\n}', fnStart);
const fnBody = fnStart >= 0 && fnEnd > fnStart ? cmdSrc.slice(fnStart, fnEnd) : '';
const backendIds = [...fnBody.matchAll(/^\s*"([a-z0-9_]+)",\s*$/gm)].map((m) => m[1]);

if (backendIds.length < 3) {
  console.error(
    `✗ 只从 all_providers() 里抽到 ${backendIds.length} 个平台 id —— ` +
      '抽取规则已失效（函数被改名/改了写法？），请更新本脚本',
  );
  process.exit(1);
}

const trayTs = readFileSync(TRAY_FILE, 'utf8');
const shortBody = /const\s+PROVIDER_SHORT\s*:[^{]*\{(.*?)\n\};/s.exec(trayTs);
if (!shortBody) {
  console.error('✗ 在 tray.ts 里找不到 PROVIDER_SHORT 表 —— 检查脚本已失效，请更新它');
  process.exit(1);
}
const shortKeys = new Set(
  [...shortBody[1].matchAll(/^\s*([a-z0-9_]+)\s*:/gm)].map((m) => m[1]),
);

const missingShort = backendIds.filter((id) => !shortKeys.has(id)).sort();

console.log(`\n后端平台 id：${backendIds.length} 个（${backendIds.join('、')}）`);
console.log(`菜单栏短名：${shortKeys.size} 项`);

if (missingShort.length > 0) {
  problems.push(
    `有 ${missingShort.length} 个平台没登记菜单栏短名：\n` +
      missingShort.map((id) => `    ${id}`).join('\n') +
      '\n  用户没自定义名字时，那一格会退回长展示名（"OpenAI API" 而不是 "OpenAI"）。' +
      '\n  到 src/features/balances/tray.ts 的 PROVIDER_SHORT 里补上。',
  );
}

/* =============================================
   ====== 检查 ③：平台 id → 图标字形 ======
   ============================================= */

const glyphBody = /const\s+PROVIDER_GLYPH\s*:[^{]*\{(.*?)\n\};/s.exec(trayTs);
if (!glyphBody) {
  console.error('✗ 在 tray.ts 里找不到 PROVIDER_GLYPH 表 —— 检查脚本已失效，请更新它');
  process.exit(1);
}
/* 只认单引号字面量（表里的写法就是 `chatgpt: 'C',`），抽不到就说明写法变了 */
const glyphPairs = [...glyphBody[1].matchAll(/^\s*([a-z0-9_]+)\s*:\s*'([^']*)'/gm)].map((m) => [
  m[1],
  m[2],
]);

if (glyphPairs.length < 3) {
  console.error(
    `✗ 只从 PROVIDER_GLYPH 里抽到 ${glyphPairs.length} 项 —— ` +
      '抽取规则已失效（改成双引号了？被改名了？），请更新本脚本',
  );
  process.exit(1);
}

const glyphKeys = new Set(glyphPairs.map(([id]) => id));
const missingGlyph = backendIds.filter((id) => !glyphKeys.has(id)).sort();

/* 字形 → 用了它的平台们；长度 > 1 就是撞车 */
const byGlyph = new Map();
for (const [id, g] of glyphPairs) {
  if (!byGlyph.has(g)) byGlyph.set(g, []);
  byGlyph.get(g).push(id);
}
const dupGlyphs = [...byGlyph.entries()].filter(([, ids]) => ids.length > 1);
/* 多码点的字形在 18pt 的图标里会被裁掉一半（画布只按单个字形居中） */
const badGlyphs = glyphPairs.filter(([, g]) => [...g].length !== 1);

console.log(`\n图标字形：${glyphPairs.length} 项（${glyphPairs.map(([id, g]) => `${id}→${g}`).join('、')}）`);

if (missingGlyph.length > 0) {
  problems.push(
    `有 ${missingGlyph.length} 个平台没登记图标字形：\n` +
      missingGlyph.map((id) => `    ${id}`).join('\n') +
      '\n  会退回用平台 id 的首字母，很可能与别的平台撞车。' +
      '\n  到 src/features/balances/tray.ts 的 PROVIDER_GLYPH 里补上（记得别与已有字形重复）。',
  );
}

if (dupGlyphs.length > 0) {
  problems.push(
    `有 ${dupGlyphs.length} 组平台共用了同一个图标字形：\n` +
      dupGlyphs.map(([g, ids]) => `    「${g}」被 ${ids.join('、')} 同时使用`).join('\n') +
      '\n  菜单栏上每个平台占一格，撞车时会出现两格长得一模一样的项 ——' +
      '\n  图标就彻底失去意义了，而这件事**不报任何错**，只能靠肉眼比对。' +
      '\n  换掉其中一个（比如 Claude 用 A 表示 Anthropic，把 C 留给 ChatGPT）。',
  );
}

if (badGlyphs.length > 0) {
  problems.push(
    `有 ${badGlyphs.length} 个字形不是一个字符：\n` +
      badGlyphs.map(([id, g]) => `    ${id} → 「${g}」`).join('\n') +
      '\n  图标画布只按单个字形居中，多字符会被裁掉一半。' +
      '\n  只能用单个字符（拉丁字母或汉字）。',
  );
}

/* =============================================
   ====== 检查 ④：平台 → 品牌 logo 位图 ======
   ============================================= */

/*
 * 只在 icons.ts 里找 `PROVIDER_LOGO_ALPHA` 那张表。
 * ⚠️ 表是空的（一个平台都还没配 logo）**不算错** —— 那时所有平台走字形，
 * 本来就是合法状态。所以下面不用「条目太少就报错」那条自检，
 * 改用「表本身找不到就报错」：找不到说明脚本失效或表被改名了。
 */
const iconsTs = readFileSync(ICONS_FILE, 'utf8');
const logoBody = /const\s+PROVIDER_LOGO_ALPHA\s*:[^{]*\{([\s\S]*?)\n\};/.exec(iconsTs);
if (!logoBody) {
  console.error('✗ 在 icons.ts 里找不到 PROVIDER_LOGO_ALPHA 表 —— 检查脚本已失效，请更新它');
  process.exit(1);
}

/* 每个平台一条：`<id>:` 之后到下一个平台（或表尾）之间的所有单引号片段拼起来 */
const logoIds = [...logoBody[1].matchAll(/^\s*([a-z0-9_]+)\s*:/gm)].map((m) => m[1]);
const logoEntries = [];
for (let k = 0; k < logoIds.length; k++) {
  const from = logoBody[1].indexOf(`${logoIds[k]}:`);
  const to = k + 1 < logoIds.length ? logoBody[1].indexOf(`${logoIds[k + 1]}:`) : logoBody[1].length;
  const seg = logoBody[1].slice(from, to);
  const b64 = [...seg.matchAll(/'([A-Za-z0-9+/=]+)'/g)].map((m) => m[1]).join('');
  logoEntries.push([logoIds[k], b64]);
}

const unknownLogo = logoEntries.filter(([id]) => !backendIds.includes(id)).map(([id]) => id);
/* 36×36 的 8 位 alpha：正好 1296 字节 → base64 1728 字符 */
const LOGO_BYTES = 36 * 36;
const badLogoLen = logoEntries
  .map(([id, b64]) => [id, Buffer.from(b64, 'base64').length])
  .filter(([, n]) => n !== LOGO_BYTES);

/*
 * 长度对了还不够：**全透明**（1296 个 0）与**实心方块**都是「合法的 1296 字节」，
 * 能骗过上面两条 —— 见文件头 ④ 的说明。
 *
 * ⚠️ 判据必须是**结构性**的，既不能用比例阈值、也不能写「墨迹数 == 总像素数」：
 * 后者对生成器产出的位图是**死代码** —— MARGIN=1 保证四周必然有一圈透明像素，
 * 实心素材实际长成「34×34 实心块 + 1px 透明边框」，那条判据永远不成立
 * （生成器第一版就是这么写的，实心素材绕过守卫、一路走到自检才报了个误导性的原因）。
 * → 用「**墨迹外接矩形内部有没有镂空**」：真图形标必然有镂空（笔画之间是空的），
 *   实心方块没有。这条不含任何需要调参的常量。
 */
const INK_MIN = 40; /* 与生成器 ink_ratio 的阈值一致 */
const LOGO_SIDE = Math.round(Math.sqrt(LOGO_BYTES));
const degenerateLogo = [];
for (const [id, b64] of logoEntries) {
  const buf = Buffer.from(b64, 'base64');
  /* 长度不对的已由上面那条报出来，这里跳过，别对同一个问题报两次 */
  if (buf.length !== LOGO_BYTES) continue;

  const ink = [];
  for (let i = 0; i < buf.length; i++) if (buf[i] > INK_MIN) ink.push(i);
  if (ink.length === 0) {
    degenerateLogo.push([id, '整张全透明 —— 菜单栏上那一格会是**空的**']);
    continue;
  }
  const xs = ink.map((i) => i % LOGO_SIDE);
  const ys = ink.map((i) => Math.floor(i / LOGO_SIDE));
  const box =
    (Math.max(...xs) - Math.min(...xs) + 1) * (Math.max(...ys) - Math.min(...ys) + 1);
  if (ink.length === box) {
    degenerateLogo.push([
      id,
      `墨迹是个实心方块（外接矩形 ${box} 像素内一个镂空都没有）` +
        ' —— 菜单栏上那一格会是**一个白方块**',
    ]);
  }
}

console.log(
  logoEntries.length > 0
    ? `\n品牌 logo：${logoEntries.length} 项（${logoEntries.map(([id]) => id).join('、')}）`
    : '\n品牌 logo：0 项（全部平台走字形）',
);

if (unknownLogo.length > 0) {
  problems.push(
    `有 ${unknownLogo.length} 个品牌 logo 登记在**不存在的平台 id** 上：\n` +
      unknownLogo.map((id) => `    ${id}`).join('\n') +
      '\n  多半是拼错了 —— 后果是那个平台静默退回字形（图标变字母），不报任何错。' +
      '\n  到 src/features/balances/icons.ts 的 PROVIDER_LOGO_ALPHA 里核对 key。',
  );
}

if (badLogoLen.length > 0) {
  problems.push(
    `有 ${badLogoLen.length} 个品牌 logo 的 base64 长度不对（应为 ${LOGO_BYTES} 字节 = 36×36）：\n` +
      badLogoLen.map(([id, n]) => `    ${id} → 解出 ${n} 字节`).join('\n') +
      '\n  长度不对时 logoBitmap 会返回 null 并静默退回字形 —— 也是不报错的。' +
      '\n  别手改那段 base64：跑 .workbuddy-ai/assets/tray-logos/make-alpha-b64.py --write 重新生成。',
  );
}

if (degenerateLogo.length > 0) {
  problems.push(
    `有 ${degenerateLogo.length} 个品牌 logo 的位图是「退化」的（长度对、内容无意义）：\n` +
      degenerateLogo.map(([id, why]) => `    ${id} → ${why}`).join('\n') +
      '\n  这种数据**骗得过上面两条**：logoBitmap 照常返回位图、trayIcons 照常把它' +
      '\n  算成「图标在」，于是诊断报「正常」而屏幕上什么都没有 —— 纯静默失败。' +
      '\n  多半是手工粘 base64 时粘错了内容（或素材本身是空图/纯色图）。' +
      '\n  跑 .workbuddy-ai/assets/tray-logos/make-alpha-b64.py --write 重新生成。',
  );
}

/* =============================================
   ====== 汇总 ======
   ============================================= */

if (problems.length === 0) {
  console.log('\n✓ 标签、平台短名、图标字形与品牌 logo 契约全部满足');
  process.exit(0);
}

for (const p of problems) console.error(`\n✗ ${p}`);
process.exit(1);
