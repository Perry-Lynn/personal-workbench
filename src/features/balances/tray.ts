/*
 * 智能体余额 · 菜单栏内容（纯逻辑）
 * ------------------------------------------------------------------
 * 只做一件事：把余额变成「菜单栏上每个平台一格」的**内容**——
 * 每格的文字、悬停提示、以及该用哪个字形做图标。
 * 不碰 IPC、不碰 store、不引 react，也不碰 canvas —— 以便
 * scripts/logic-test.ts 直接 import 进 node 跑断言。
 *
 * 真正把内容推给系统的是 service.ts（syncTray）；把字形画成位图的是 icons.ts；
 * IPC 封装在 @/core/tray。
 *
 * ## 为什么从「一行文字」改成了「每平台一格」
 *
 * 旧版把所有平台压成**一个**状态项上的一行字（「Qoder 余26099 · ChatGPT 用87%」），
 * 于是所有平台共用一份 30 列的预算，超了就整段丢掉、末尾补 `…`。
 * 那个模型下「平台名」是识别平台**唯一**的手段，所以每个字都很贵，
 * 短名表（PROVIDER_SHORT）才成了一个必须由 check:labels 守住的契约。
 *
 * 现在每个平台是**独立的状态项**（见 src-tauri/src/core/tray.rs），
 * 于是：
 *   1. 预算不再共享 —— 一个平台宽了不会把别的挤掉，也就不再有「丢最后几个平台」
 *      这件事（TRAY_MAX_COLS / TRAY_SEP / TRAY_EMPTY_TITLE 随之删除）；
 *   2. 平台靠**图标**识别，名字从「必需」降级成「图标关掉时的兜底」；
 *   3. 名字可以自定义了 —— 用户想叫它什么都行。
 *
 * ## 文字与图标是**互补**的（这条规则是整个设计的枢纽）
 *
 *   图标开 → 文字只放数值（`余26099`），平台由图标认
 *   图标关 → 文字自动补上名字（`Qoder 余26099`），否则只剩一个数字谁也认不出
 *
 * 所以「关掉图标」不会让某一格变得不可辨认，用户不必担心自己把菜单栏搞坏。
 *
 * ## 与蓝牙摘要（format.buildBadgeSummary）的关系
 *   两者都在做「压缩」，但**约束完全不同，所以不能复用同一个函数**：
 *     徽章    ≤ 95 **字节**（固件通知上限），中文一个字 3 字节，超了整块丢弃；
 *     菜单栏  每格 ≤ TRAY_ITEM_BUDGET_COLS **显示列**（中文占 2 列，数字占 1 列），
 *             超了先把**名字**截短，**数值一格都不动**（见 composeTitle）。
 *   取值口径上刻意共用 format.sortItems —— 于是「哪个指标是主指标」这件事
 *   在面板、徽章、菜单栏三处永远一致，不会出现「面板显示剩余额度、
 *   菜单栏显示已用量」这种两处打架的情况。
 *
 * ## 为什么每个平台只留**一个数**
 *   更要紧的是 —— 一个平台的「剩余」和「已用」**可能不是同一个层级**
 *   （Qoder 实测：`组织池剩余` 是整个组织池的，`资源包已用` 是本人当月的），
 *   把它们并排成「余X 用Y」读起来就是「我剩 X、我只用了 Y」，而事实并非如此。
 *   所以这里只取**一个**方向明确的数，方向用「余 / 用」一个字标出，
 *   完整口径连同 sub（全组织共享 / 本人当月）放在悬停提示里。
 *   取哪一个默认由 quotaItem 自动挑，用户也可以在设置页按平台指定（TraySource.field）。
 * @Author: fu
 */
import { clockAt, isUsageLabel, sortItems } from './format';
import type { BalanceItem } from './types';

/**
 * 单格文字的显示列宽**预算**（中文按 2 列算）。
 *
 * 18 列大约是「WorkBuddy 余26099」这个长度。这是**经验值**，不是系统限制：
 * 每格都是独立的状态项，macOS 不会因为太长而报错，只会把菜单栏挤满。
 *
 * ⚠️ 它是**预算而不是硬上限** —— 见 composeTitle：这个名字只用来说明
 * 「名字最多能占多宽」，**数值永远原样显示，哪怕整格超出这个数**。
 * 理由：截一个额度数字会让它读成另一个数（`26099` → `2609`），
 * 那是**错的**；而一格挤一点只是难看。
 */
export const TRAY_ITEM_BUDGET_COLS = 18;

/**
 * 摘要输入：与 format.BadgeSummaryInput 同构，额外要求 `provider`。
 * 单独声明而不是直接 extends，是为了让这个文件**只依赖 format 的运行时函数**，
 * 类型上不跟它绑死（两个文件都只是「同一份数据的两个视图」）。
 */
export interface TraySource {
  provider: string;
  name: string;
  items: BalanceItem[];
  error?: string | null;
  /**
   * 用户为该平台指定的指标 label（设置页里选的）；null / 省略 = 自动挑。
   * 见 trayItem —— 指定的指标若已失效（后端改了 label、或值认不出数值），
   * 会**回落到自动挑**，不会让这个平台从菜单栏上消失。
   */
  field?: string | null;
}

/* =============================================
   ====== 名字：内置短名 + 用户自定义 ======
   ============================================= */

/**
 * 平台短名。**键是后端 all_providers() 里的 id**。
 *
 * 为什么要有这张表：后端给的是展示名（"Qoder CN" / "OpenAI API"），
 * 菜单栏上每个字都很贵。`npm run check:labels` 会核对
 * 「后端每个平台 id 在这里都有短名」—— 漏了会退 1，不会静默退回长名。
 * 没登记的 id 回落用展示名（新平台先能用，只是占地方）。
 *
 * ⚠️ 这张表现在是**兜底**而不再是唯一来源：用户可以在设置页给某个平台改名
 * （trayLabels）。但兜底仍然是必需的 —— 用户没改名的平台全靠它。
 */
const PROVIDER_SHORT: Record<string, string> = {
  chatgpt: 'ChatGPT',
  qoder: 'Qoder',
  openai: 'OpenAI',
  claude: 'Claude',
  gemini: 'Gemini',
  trae: 'Trae',
  workbuddy: 'WorkBuddy',
};

/**
 * 平台图标上用的**字形**（一个字符）。**键是后端 all_providers() 里的 id**。
 *
 * 为什么默认用字形而不是品牌 logo：本仓没有任何平台图标资源，也不该去下载
 * 第三方商标（版权 + 随版本过期）。一个字母能稳定地做到「彼此可区分」，
 * 而平台名在悬停提示里始终可见，不会认错。
 *
 * ⚠️ **这张表是兜底，不再是唯一来源**：用户可以为某个平台提供官方 logo
 * （2026-09-24 起，`icons.PROVIDER_LOGO_ALPHA`；qoder 已登记），
 * 那时图标恒为 logo、这张表对它只作「logo 数据坏了」的退路。
 * 没有 logo 的平台照旧用这里的字形，**而且改名时字形跟着名字走**。
 *
 * `npm run check:labels` 会核对两件事：① 每个后端平台 id 都登记过；
 * ② **字形两两不同** —— 这条比第 ① 条更要紧：两个平台用同一个字母时，
 * 菜单栏上会出现两格长得一样的项，图标就彻底失去意义了，
 * 而这件事**不会报任何错**，只有肉眼比对才看得出来。
 *
 * 字母的选取（同一字母只能给一个平台，所以有取舍）：
 *   ChatGPT → C，Claude → A（Anthropic，否则与 ChatGPT 撞 C），
 *   Gemini → G，OpenAI → O，Qoder → Q，Trae → T，WorkBuddy → W。
 * 全部是单个大写拉丁字母，任何系统字体都画得出来，不会出现豆腐块。
 * （Qoder 现在走官方 logo，这个 Q 只是它 logo 数据出问题时的退路。）
 */
const PROVIDER_GLYPH: Record<string, string> = {
  chatgpt: 'C',
  qoder: 'Q',
  openai: 'O',
  claude: 'A',
  gemini: 'G',
  trae: 'T',
  workbuddy: 'W',
};

/** 平台短名；没登记就退回展示名 */
export function providerShort(id: string, name: string): string {
  return PROVIDER_SHORT[id] ?? name;
}

/**
 * 菜单栏上该显示的名字：**用户自定义优先，其次内置短名，最后展示名**。
 *
 * 空串 / 纯空白一律当「没自定义」—— 与 prefs.validTrayLabels 的收敛口径一致
 * （那边落盘时就把空白值丢掉了，这里再判一次是为了让「内存里刚清空、
 * 还没落盘」的那一瞬也走对分支）。
 */
export function providerLabel(id: string, name: string, custom?: string | null): string {
  const c = (custom ?? '').trim();
  return c || providerShort(id, name);
}

/**
 * 该平台图标上画哪个字形。
 *
 * **自定义名字时自动跟着名字走** —— 把「Qoder CN」改成「主力号」，
 * 图标就从 Q 变成「主」，不需要用户再去配一遍图标。
 * 这是有意的耦合：图标的作用是标识这一格是哪个平台，
 * 名字变了图标还停在旧字母，反而会误导。
 *
 * ⚠️ **登记了品牌 logo 的平台不走这条路**（`icons.PROVIDER_LOGO_ALPHA`）——
 * 它们的图标**恒为 logo**，改名也不变（logo 标识的是**平台**，不是名字）。
 * 所以对它们来说，这里算出的字形只是「logo 数据坏了」时的兜底，
 * 真正的取舍在 `icons.trayIconBitmap`（它按 provider 查表）。
 * 这也是为什么 `glyph` 字段对它们仍然非 null：见 TrayItem.glyph 的说明。
 *
 * 取首字符并转大写（ASCII 小写转大写；中文不受影响）。
 * ⚠️ 转大写后**可能变成多个码点**（如德文 ß → SS），所以再取一次首码点 ——
 * 否则画出来会是一个被裁掉一半的字形。
 */
export function glyphOf(provider: string, customLabel?: string | null): string {
  const custom = (customLabel ?? '').trim();
  const source = custom || PROVIDER_GLYPH[provider] || provider;
  const ch = [...source][0] ?? '?';
  return [...ch.toUpperCase()][0] ?? ch;
}

/* =============================================
   ====== 显示列宽 ======
   ============================================= */

/*
 * 东亚宽字符的码点区间。**只列会被我们真正用到的范围** ——
 * 菜单栏文字里的非 ASCII 只有中日韩文字与全角标点，不需要覆盖 Unicode 的
 * East Asian Width 全表（那要一张上千项的区间表，还得跟着 Unicode 版本更新）。
 * 认不出来的一律按 1 列算，偏窄不会溢出，偏宽只是保守。
 */
const WIDE_RANGES: readonly [number, number][] = [
  [0x1100, 0x115f], // 韩文字母
  [0x2e80, 0x303e], // 中日韩部首、标点
  [0x3041, 0x33ff], // 假名、注音、中日韩兼容
  [0x3400, 0x4dbf], // 中日韩扩展 A
  [0x4e00, 0x9fff], // 中日韩统一表意文字
  [0xa000, 0xa4cf], // 彝文
  [0xac00, 0xd7a3], // 韩文音节
  [0xf900, 0xfaff], // 中日韩兼容表意文字
  [0xfe30, 0xfe4f], // 中日韩兼容形式
  [0xff00, 0xff60], // 全角字符
  [0xffe0, 0xffe6], // 全角符号
  [0x20000, 0x3fffd], // 中日韩扩展 B 及以上
];

/**
 * 字符串在菜单栏上占几个「列」。
 *
 * 为什么不能直接用 `String.length`：`"余26099"` 的长度是 6，
 * 但它在菜单栏上占 2 + 5 = 7 列 —— 中文是全角。按 length 算预算，
 * 中英混排时实际宽度会比预算多出 30%~100%，文字就冲出预设宽度了。
 */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    w += WIDE_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi) ? 2 : 1;
  }
  return w;
}

/** 按显示列宽截断并补 `…`（截断后总宽度不超过 max） */
export function truncateToWidth(s: string, max: number): string {
  if (displayWidth(s) <= max) return s;
  /* 留 1 列给省略号 */
  const budget = Math.max(0, max - 1);
  let w = 0;
  let out = '';
  for (const ch of s) {
    const cw = displayWidth(ch);
    if (w + cw > budget) break;
    w += cw;
    out += ch;
  }
  return `${out}…`;
}

/* =============================================
   ====== 数值压缩 ======
   ============================================= */

/** 货币前缀 + 数字 + 可选百分号；数字允许千分位逗号 */
const NUM_RE = /^([$¥€]?)\s*(-?[\d,]+(?:\.\d+)?)\s*(%?)/;

/**
 * 把指标值压成菜单栏能放下的形式：**只保留数字本体，丢掉单位**。
 *
 *   "26099 credits" → "26099"     "87%" → "87%"     "$12.34" → "$12.34"
 *   "2026-10-01"    → null（日期不是额度）
 *   "已用尽"         → null（认不出数值）
 *
 * 为什么敢丢单位：单位在面板和悬停提示里都有，而菜单栏每一列都很贵；
 * 「Qoder 余26099」比「Qoder 组织池剩余 26099 credits」可读得多。
 * 认不出来就返回 null —— **宁可不显示这个平台，也不要在菜单栏上放一段
 * 莫名其妙的文本**（那看起来像程序出错了）。
 */
export function compactValue(value: string): string | null {
  const s = value.trim();
  if (!s) return null;
  /*
   * 日期必须先挡掉：`额度到期` 的值是 `2026-10-01`，而下面的正则能从中
   * 匹配出 `2026` 这个「数字」—— 于是菜单栏会显示「Qoder 余2026」，
   * 看起来像额度，其实是个年份。这类误读比不显示更糟。
   */
  if (/^\d{4}-\d{1,2}-\d{1,2}/.test(s)) return null;
  const m = s.match(NUM_RE);
  if (!m) return null;
  const [, sym, num, pct] = m;
  if (!/\d/.test(num)) return null;
  return `${sym}${num}${pct}`;
}

/* =============================================
   ====== 挑「使用 / 剩余额度」 ======
   ============================================= */

/*
 * 哪些标签算「使用 / 剩余额度」。
 * 比 format.isUsageLabel 宽一点：那边只判方向（已用 / 剩余），这里还要
 * **认出这是不是额度**，所以多收了「可用 / 余量 / credit」。
 * 「额度到期」也会命中 —— 它由 compactValue 的日期判定挡掉，两道闸各管一件事。
 */
const QUOTA_LABEL = /余额|额度|剩余|余量|可用|已用|用量|使用|消耗|credit|percent|%/i;

/** 这一项的标签看起来是不是「使用 / 剩余额度」类指标 */
export function isQuotaLabel(label: string): boolean {
  return QUOTA_LABEL.test(label);
}

/**
 * 一个平台里最该上菜单栏的那一项；没有合适的就返回 null。
 *
 * 取「余额 / 额度 / 剩余」优先、「已用 / 用量」其次（顺序沿用 format.sortItems，
 * 与面板和徽章完全一致），且**只要数值能认出来**的那一项。
 * 一个平台只给一个数，理由见文件头的说明。
 */
export function quotaItem(items: BalanceItem[]): BalanceItem | null {
  for (const it of sortItems(items)) {
    if (!isQuotaLabel(it.label)) continue;
    if (compactValue(it.value) === null) continue;
    return it;
  }
  return null;
}

/* =============================================
   ====== 按平台指定指标（设置页用） ======
   ============================================= */

/**
 * 该平台**可以**上菜单栏的指标（值能压成数值的），供设置页列下拉选项。
 *
 * 为什么要把「不可选」的也过滤掉而不是让用户选了再报错：
 * `额度到期 2026-10-01` 这类值在菜单栏上只能显示成 `2026`，看着像额度其实是年份。
 * 与其让用户选完得到一个看不懂的数，不如在选项里就不给选。
 * 顺序沿用 sortItems（余额/剩余优先），与自动挑的偏好一致 —— 下拉第一项
 * 往往就是「自动」会选中的那个。
 */
export function trayFieldOptions(items: BalanceItem[]): BalanceItem[] {
  return sortItems(items).filter((it) => compactValue(it.value) !== null);
}

/**
 * 该平台最终要显示的那一项：**用户指定优先，失效则回落自动挑**。
 *
 * 两种「失效」都要回落，且都要静默：
 *   ① 指定的 label 在本次数据里不存在（后端改了标签文案）；
 *   ② 存在但值认不出数值（如变成了「已用尽」）。
 * 回落的理由是菜单栏属于「常驻显示」，**一个平台因为一次文案改动就整格消失，
 * 比显示一个次优指标更糟** —— 用户会以为程序坏了。设置页那边也会把
 * 当前失效的选项标出来，让用户知道该重选（见 BalancesView 的下拉）。
 */
export function trayItem(items: BalanceItem[], field?: string | null): BalanceItem | null {
  if (field) {
    const hit = items.find((it) => it.label === field);
    if (hit && compactValue(hit.value) !== null) return hit;
  }
  return quotaItem(items);
}

/* =============================================
   ====== ChatGPT 双额度窗口 ======
   ============================================= */

/*
 * ChatGPT 的两个限流窗口在数据里是**两条独立指标**（后端 chatgpt.rs 按
 * primary_window / secondary_window 分别产出「本时段已用」「本周已用」），
 * 而不是一条带两个数的指标。菜单栏这一格要同时看见它们，就得在这里合并。
 *
 * 窗口长度（18000s / 604800s）**没有进数据模型**（chatgpt.rs 的 UsageWindow
 * 只解析 used_percent 与 reset_at），所以 `5h` / `7d` 是展示层的固定映射，
 * 依据是接口约定与代码注释：primary = 本时段(~5h)，secondary = 本周(~7d)。
 *
 * ⚠️ 语义：值是 `used_percent`，即**已用比例**（0~100），不是剩余比例。
 * 因此这里原样显示百分比，不在展示层做 `100 - x` 的换算 —— 换算了就必须
 * 再解释「这是剩余」，而菜单栏没有地方放这层解释（悬停提示里有完整标签）。
 */
const CHATGPT_WINDOW_TAGS: readonly [string, string][] = [
  ['本时段已用', '5h'],
  ['本周已用', '7d'],
];

/**
 * 百分比文本 → 数字；不是百分比就返回 null。
 * 只认 `compactValue` 已经压过的值（`68%`），所以不会把 credits 误当比例。
 */
function percentOf(value: string): number | null {
  if (!value.endsWith('%')) return null;
  const n = Number(value.slice(0, -1));
  return Number.isFinite(n) ? n : null;
}

/*
 * 重置时刻的短文本直接走 format.clockAt：
 * 当天 `HH:MM`、跨天 `MM-DD HH:MM`。
 * 跨天也必须带时分 —— 只给日期的话，「今天 23:00 重置」与
 * 「明天 01:00 重置」都会显示成同一个 `11-09/11-10`，用户判断不了还有多久。
 */

/** 一个 ChatGPT 限流窗口的展示视图（标题段与明细行都从它派生） */
interface ChatgptWindowView {
  /** 展示层窗口标签：`5h` / `7d` */
  tag: string;
  /** 已用百分比文本，如 `68%` */
  value: string;
  /** 已用百分比数字；认不出（不是百分比）时为 null */
  percent: number | null;
  /** 是否额度耗尽（已用 >= 100%） */
  exhausted: boolean;
  /** 重置时刻的短文本；后端没给 reset_at 时为 null */
  reset: string | null;
}

/** ChatGPT 双窗口的完整展示结果：标题那一行 + 右键菜单里的明细行 */
interface ChatgptWindowsView {
  title: string;
  details: string[];
}

/**
 * 两个窗口的展示视图；少一个窗口就返回 null，交给单指标逻辑。
 *
 * 为什么**必须两个都在**才合并：只有一个窗口时，后端无法从数据上区分它是
 * 5h 还是 7d（chatgpt.rs 把「只有 primary」的套餐一律当作周窗口），
 * 这时硬贴一个 `7d` 标签，在窗口长度真是 5h 的套餐上就是错的。
 * 宁可退回原有的单值显示，也不显示一个可能错的窗口标签。
 *
 * 耗尽态（`used_percent >= 100`）：
 *   - 标题里用重置时间替代百分比（`5h 19:00`），因为「100%」已无信息量；
 *   - 两个窗口同时耗尽时去掉标签后的空格（`5h19:00 · 7d11-02`），
 *     避免整格撑爆菜单栏宽度；
 *   - 明细行写成「已用尽 · 19:00 重置」，把状态与时间都说清楚。
 */
function chatgptWindowsView(items: BalanceItem[], now: number): ChatgptWindowsView | null {
  const wins: ChatgptWindowView[] = [];
  for (const [label, tag] of CHATGPT_WINDOW_TAGS) {
    const hit = items.find((it) => it.label === label);
    if (!hit) continue;
    const value = compactValue(hit.value);
    if (value === null) continue;
    const percent = percentOf(value);
    const reset =
      typeof hit.resetAt === 'number' && hit.resetAt > 0
        ? clockAt(hit.resetAt, now)
        : null;
    wins.push({
      tag,
      value,
      percent,
      exhausted: percent !== null && percent >= 100,
      reset,
    });
  }
  if (wins.length !== CHATGPT_WINDOW_TAGS.length) return null;

  const bothExhausted = wins.every((w) => w.exhausted);
  const title = wins
    .map((w) => {
      const body = w.exhausted ? w.reset ?? w.value : w.value;
      /* 同时耗尽时压缩掉标签后的空格，给另一段留出宽度 */
      return bothExhausted ? `${w.tag}${body}` : `${w.tag} ${body}`;
    })
    .join(' · ');

  const details = wins.map((w) => {
    const used = w.exhausted ? '已用尽' : `已用 ${w.value}`;
    return w.reset ? `${w.tag} ${used} · ${w.reset} 重置` : `${w.tag} ${used}`;
  });

  return { title, details };
}

/**
 * 两个窗口都在且值都能认出来时，合成标题那一行；否则返回 null。
 * `now` 可注入以便单测固定时间（省略时取当前时刻）。
 */
export function chatgptWindowsBody(
  items: BalanceItem[],
  now: number = Date.now() / 1000,
): string | null {
  return chatgptWindowsView(items, now)?.title ?? null;
}

/* =============================================
   ====== 每个平台一格 ======
   ============================================= */

/** 菜单栏上的一个状态项（内容部分；图标位图由 icons.ts 画） */
export interface TrayItem {
  /** 稳定标识 = provider id。后端用它拼状态项 id；icons.ts 也用它查品牌 logo */
  key: string;
  /** 状态项上的文字 */
  title: string;
  /** 悬停提示（该平台的完整明细） */
  tooltip: string;
  /**
   * 图标上画什么。
   *
   * **非 null ⇔ 这一格要显示图标**（用户没关掉）—— 这是它唯一的判据作用，
   * 调用方（service.syncTray）只看它非不非空。
   *
   * 具体画什么由 icons.trayIconBitmap 按 `key` 决定：
   *   登记了品牌 logo 的平台 → 画 logo（本字段只是兜底，见 glyphOf 的说明）
   *   其余 → 画这个字形
   *
   * null = 这一格不显示图标（用户关掉了，文字会自动补上名字）
   */
  glyph: string | null;
  /**
   * 右键菜单里这一格下面的只读明细行。
   * 目前只有 ChatGPT 双窗口会带（`5h 已用 68% · 19:00 重置`）；
   * 其它平台为空数组，菜单保持默认的「显示主窗口 / 退出工作台」。
   */
  details: string[];
  /** 明细的分组标题；没有明细时为 null */
  detailTitle: string | null;
}

export interface TrayItemOptions {
  /** 自定义名字：provider → 文字（见 prefs.trayLabels） */
  labels: Record<string, string>;
  /** 不显示图标的平台（见 prefs.trayIconOff） */
  iconOff: string[];
  /**
   * 当前时刻（Unix 秒）。只有单测需要注入固定时间；省略时取系统当前时间。
   * 耗尽态要用它判断重置时间该显示 `HH:MM` 还是 `MM-DD HH:MM`（见 format.clockAt）。
   */
  now?: number;
}

/**
 * 拼一格文字：图标开着就只放数值，图标关掉就补上名字。
 *
 * **数值永远原样输出，一格都不截。** 超预算时截的是名字 —— 名字截短了还能靠
 * 悬停提示认出来，而一个被截掉几位的额度数字是**错的**（`余2609…` 看着像 2609，
 * 用户会照着它做判断）。所以这个函数的返回值**可能超过**
 * TRAY_ITEM_BUDGET_COLS：预算是用来决定名字能占多宽的，不是用来切数字的。
 *
 * 名字连 2 列都放不下时干脆不放：与其显示一个只剩一个字母加省略号的名字，
 * 不如留一个干净的数字，平台由悬停提示说明。
 */
function composeTitle(label: string, body: string, withLabel: boolean): string {
  if (!withLabel) return body;
  const room = TRAY_ITEM_BUDGET_COLS - displayWidth(body) - 1; /* 1 = 中间那个空格 */
  if (room < 2) return body;
  return `${truncateToWidth(label, room)} ${body}`;
}

/**
 * 一格平台的悬停提示：**完整明细，不压缩**。
 *
 * 这是「菜单栏只显示一个数」的代价补偿 —— 压缩掉的单位、口径（sub）
 * 全都放这里，所以菜单栏上没有任何信息是真的丢了，只是要悬停才看得到。
 * 一行一个指标，行内用 ` · ` 分隔；读不到数就写明原因。
 *
 * 第二参是**用户自定义的名字**（不是最终显示名）：只有在用户真的改过名、
 * 且新名字与展示名不同时，才把展示名补在括号里（`主力号（Qoder CN）`）——
 * 用户改了名之后还得能对上面板里那个平台。
 * ⚠️ 判据必须是「有没有自定义」，不能是「最终显示名 ≠ 展示名」：
 * 后者在**没改名**时也成立（内置短名 `Qoder` 本来就 ≠ 展示名 `Qoder CN`），
 * 于是每一格都会变成 `Qoder（Qoder CN） · …` 这种重复噪音。
 *
 * 刻意**不带刷新时间**：那需要把 refreshed_at 一路传进来（实时数据叫 refreshed_at、
 * 快照叫 refreshedAt，两套命名），为一行提示加一层归一不值得；
 * 数据新不新看面板上的倒计时更准。
 */
export function buildTrayItemTooltip(b: TraySource, custom?: string | null): string {
  const c = (custom ?? '').trim();
  const head = c && c !== b.name ? `${c}（${b.name}）` : b.name;
  if (b.error) return `${head}：读取失败（${b.error}）`;
  if (b.items.length === 0) return `${head}：暂无数据`;
  const parts = b.items.map(
    (it) => `${it.label} ${it.value}${it.sub ? `（${it.sub}）` : ''}`,
  );
  return `${head} · ${parts.join(' · ')}`;
}

/**
 * 把「要上菜单栏的平台」变成**一格一格的内容**。
 *
 * 哪些平台要上由调用方先过滤好（service.currentTraySources，与设置页预览共用）。
 * 本函数只负责：挑指标 → 压数值 → 拼文字 → 决定要不要图标。
 *
 * **读不到数的平台整格不出**（返回数组里没有它）——
 * 菜单栏是常驻显示，一格只写「暂无数据」的项是纯噪音；而配置本身在设置页里
 * 看得见（那里会标明「已勾选但这几个暂时没数据」），不会让人以为配置丢了。
 *
 * 返回顺序 = 入参顺序，前端不再重排 —— 顺序由「显示中」的平台顺序决定，
 * 与面板卡片一致，用户不会在两处看到不同的排列。
 */
/*
 * 使用类指标达到 100% 时，菜单栏改显「重置时间」而不是「100%」。
 *
 * 为什么：本时段已用 / 本周已用这类**已用百分比**到 100% 的那一刻，
 * 「100%」已经不携带任何新信息 —— 用户此刻真正想知道的是
 * 「什么时候能再用」，而 ChatGPT 后端已经在 sub 里带上了这个时间
 * （`重置 MM月DD日 HH:mm`，达到上限时是 `已达上限 · 重置 MM月DD日 HH:mm`）。
 * 于是菜单栏这一格从 `用100%` 改成 `重置09-28 14:30`，把没有信息量的
 * 数字换成用户此刻真正关心的那个。
 *
 * 优先用机器值 `resetAt`（chatgpt.rs 已解析的 reset_at），按当天/跨天压成
 * `HH:MM` / `MM-DD HH:MM`；没有机器值时再退回 sub 里形如
 * `MM-DD HH:mm` 或 `MM月DD日 HH:mm` 的时间，
 * 避免把无关的 sub 误当重置时间。两者都提取不到就回落显示 `100%`，不强行改写。
 * 这一改**只影响菜单栏这一格**：面板与悬停提示（buildTrayItemTooltip）
 * 仍照常显示 `100%` 与完整 sub，没有信息真的丢失。
 */
/* 后端 sub 现在写「重置 11月14日 06:46」；老格式「重置 11-14 06:46」也一并认 */
const RESET_TIME_RE = /(?:\d{2}-\d{2}|\d{1,2}月\d{1,2}日) \d{2}:\d{2}/;
function usageFullReset(it: BalanceItem, now: number): string | null {
  if (!isUsageLabel(it.label)) return null;
  const pct = percentOf(compactValue(it.value) ?? '');
  if (pct === null || pct < 100) return null;
  if (typeof it.resetAt === 'number' && it.resetAt > 0) {
    const clock = clockAt(it.resetAt, now);
    if (clock) return `重置${clock}`;
  }
  const m = it.sub?.match(RESET_TIME_RE);
  return m ? `重置${m[0]}` : null;
}

export function buildTrayItems(list: TraySource[], opts: TrayItemOptions): TrayItem[] {
  const now = opts.now ?? Date.now() / 1000;
  const out: TrayItem[] = [];
  for (const b of list) {
    /* 出错或没数据的平台整格不出（理由见函数说明） */
    if (b.error || b.items.length === 0) continue;

    /*
     * ChatGPT 走「双窗口合并」：数据里两条窗口指标是分开的，两个都在时
     * 合成 `5h 68% · 7d 75%`，此时优先于单指标（包括 credits 里的「剩余额度」）。
     *
     * ⚠️ **双窗口优先于 `trayFields.chatgpt`**（2026-11-06 调整）：
     * 用户要的是 ChatGPT 常驻显示 5h/7d。若还让显式 field 压过合并，
     * 凡是以前在设置里选过「本时段已用」的账号，5h/7d 就永远不出现 ——
     * 等于这个功能默认不可见，用户还得翻设置才能打开。
     * 所以这里不再判断 `b.field`：两个窗口都在就合并。
     * 显式 field 只对**单窗口账号**有意义，那种情况下方 `trayItem` 仍按
     * `b.field` 取值，原有回退行为完全不变；历史偏好也原样保留，不清空。
     *
     * 合并结果同时带**右键菜单明细**（每个窗口一行，含已用百分比与重置时间）。
     * 标题那一行的宽度预算只有 18 列，放不下两条完整明细；菜单是
     * 「点开才看」，不受这个预算约束。
     */
    const dual = b.provider === 'chatgpt' ? chatgptWindowsView(b.items, now) : null;

    const it = trayItem(b.items, b.field);
    const v = it ? compactValue(it.value) : null;
    /* 合并成功时不要求单指标可解析；否则仍需单指标兜底 */
    if (dual === null && (it === null || v === null)) continue;

    const custom = opts.labels[b.provider];
    const label = providerLabel(b.provider, b.name, custom);
    const withIcon = !opts.iconOff.includes(b.provider);

    /*
     * 使用类指标达到 100% 时，菜单栏不再显示「100%」（已无信息量），
     * 改用重置时间。具体取舍见 usageFullReset。
     * 单指标路径（含「只有一个窗口」的 ChatGPT 回退）仍走这里；
     * 双窗口路径的耗尽态已在 chatgptWindowsView 里处理。
     */
    const resetBody = it ? usageFullReset(it, now) : null;
    const body =
      dual?.title ??
      resetBody ??
      `${isUsageLabel(it!.label) ? '用' : '余'}${v}`;

    out.push({
      key: b.provider,
      title: composeTitle(label, body, !withIcon),
      tooltip: buildTrayItemTooltip(b, custom),
      glyph: withIcon ? glyphOf(b.provider, custom) : null,
      details: dual?.details ?? [],
      detailTitle: dual ? `${label} 额度` : null,
    });
  }
  return out;
}
