/*
 * 智能体余额模块 · 用户偏好
 * ------------------------------------------------------------------
 * 全部持久化到 localStorage（纯前端，不涉及密钥、不涉及 IPC）：
 *   visibleProviders     面板显示哪些平台卡片；null = 全部显示
 *   pushProviders        推送到徽章的摘要里包含哪些平台；null = 跟随「显示中的平台」
 *   homePinnedProvider   首页图表展示哪个平台；null = 不展示
 *   autoPush             连上蓝牙时是否自动推摘要
 *   trayEnabled          是否把余额挂到系统菜单栏
 *   trayProviders        菜单栏显示哪些平台；null = 跟随「显示中的平台」
 *   trayFields           菜单栏每个平台显示哪个指标（provider → label）
 *   trayLabels           菜单栏上每个平台的自定义名字（provider → 文字）
 *   trayIconOff          菜单栏上**不显示图标**的平台（缺省 = 都显示图标）
 *   trayIconScale        菜单栏图标的**大小**（全局一个，0.5~1.0；1 = 图形填满 18pt 方框）
 *   autoRefresh/Interval 定时刷新
 *   trendGranularity/Metric 首页趋势图
 *
 * 四处「显示哪些平台」是**四个独立的粒度**，不要合并：
 *   面板（visibleProviders）→ 可以铺满一屏，给「看细节」用
 *   徽章（pushProviders）    → 正文只有 95 字节，通常只放最关心的几个
 *   菜单栏（trayProviders）  → 挤在系统图标之间，只能放两三个
 *   首页（homePinnedProvider）→ 只画一个平台
 *
 * ⚠️ 只有菜单栏与首页**先过 onlyVisible**（它们是面板的子集，否则会出现
 * 「面板里没有、菜单栏里却有」这种对不上的情况）。
 * **徽章不在此列**：推送与面板显示刻意解耦（2026-10-22）——
 * 若要求「推送 ⊆ 显示中」，用户想只推 ChatGPT 就得先把面板上其它平台全取消勾选，
 * 那等于没给选择，只是把耦合换了个地方。
 * @Author: fu
 */
import { create } from 'zustand';
import type { TrendGranularity } from './format';

export interface BalancesPrefs {
  /** 面板显示哪些平台；null = 全部显示（默认） */
  visibleProviders: string[] | null;
  /**
   * 推送到徽章的**余额摘要**里包含哪些平台；null = 跟随「显示中的平台」。
   *
   * 为什么要独立于 visibleProviders：
   *   徽章正文只有 95 字节（固件上限），一次最多放得下两三个平台；
   *   而面板是给「看细节」用的，可以铺满一屏。
   *   两个场景要的粒度天然不同，所以推送自己一组勾选。
   *
   * 语义与 trayProviders 基本一致：
   *   null = 跟随「显示中的平台」（默认，装上就用）
   *   []   = 一个都不推（只留手动推送，或干脆不推）
   *   其余 = 精确指定这几个
   *
   * ⚠️ 与 trayProviders 的唯一区别：**不要求是「显示中平台」的子集**。
   * 推送与面板显示刻意解耦 —— 面板上铺满一屏、徽章上只推一个平台是正常用法。
   * （菜单栏那边仍要求子集，因为「面板里没有、菜单栏里却有」会让人对不上号；
   *   而徽章是一块独立的小屏，不存在这种对照关系。）
   */
  pushProviders: string[] | null;
  /** 首页图表固定展示哪个平台；null = 不展示 */
  homePinnedProvider: string | null;
  /**
   * 固定平台的展示名。存下来是因为首页可能还没有该平台的余额快照，
   * 拿不到 name —— 那时如果只显示 provider id（"chatgpt"）会很怪。
   */
  homePinnedName: string | null;
  /** 连上蓝牙时是否自动推送余额摘要 */
  autoPush: boolean;
  /**
   * 是否把「使用 / 剩余额度」压成一行挂到系统菜单栏（macOS 顶部状态栏）。
   * 默认开：菜单栏不占窗口、不抢焦点，是余额最合适的常驻位置。
   */
  trayEnabled: boolean;
  /**
   * 菜单栏上显示**哪些**平台；null = 跟随「显示中的平台」。
   *
   * 为什么要独立于 visibleProviders：面板是给「看细节」用的，可以铺满一屏；
   * 菜单栏和系统图标、输入法、时钟挤在同一条线上，放不下几个 ——
   * 用户实测「东西太多，都展示不开看」。两个场景要的粒度天然不同，
   * 所以菜单栏自己一组勾选，**不影响**面板显示与徽章推送。
   */
  trayProviders: string[] | null;
  /**
   * 菜单栏上每个平台显示**哪个指标**：键 = provider id，值 = 指标 label。
   * 没有键 = 自动挑（余额/剩余优先，见 tray.quotaItem）。
   *
   * 值刻意存 **label 而不是下标或 value**：label 是后端产出的稳定标识
   * （`npm run check:labels` 在守它的契约），而下标会随指标增删错位、
   * value 每次刷新都在变（存了必然对不上）。
   */
  trayFields: Record<string, string>;
  /**
   * 菜单栏上每个平台的**自定义名字**：键 = provider id，值 = 用户写的文字。
   * 没有键（或值是空串）= 用内置短名表（tray.PROVIDER_SHORT）。
   *
   * 为什么是「覆盖表」而不是把内置表也搬到这里：内置短名是**契约**，
   * 由 `npm run check:labels` 保证「后端每个平台都登记过」；
   * 搬进来就没人守了，新平台会静默退回长展示名。
   * 这里只放用户的覆盖，两者在 `tray.providerLabel` 里合成。
   *
   * ⚠️ 值**不在这里限长**：超长由显示层的 truncateToWidth 截断。
   * 存原值才能让用户在设置页看见自己输的是什么，而不是被悄悄改短。
   */
  trayLabels: Record<string, string>;
  /**
   * 菜单栏上**不显示图标**的平台 id。缺省（不在列表里）= 显示图标。
   *
   * 为什么用「关闭列表」而不是 `Record<provider, boolean>`：
   * 后者的缺省值（true 还是 false）光看类型看不出来，读代码的人必须先找到
   * DEFAULTS 才知道。用列表则名字自带默认值 —— 不在列表里就是显示。
   *
   * 关掉图标后，菜单栏上的文字会**自动补上平台短名**（见 tray.buildTrayItems），
   * 否则只剩一个数字，谁也认不出是哪个平台。
   */
  trayIconOff: string[];
  /**
   * 菜单栏图标的大小（**全局一个**，0.5 ~ 1.3）。
   *
   * ⚠️ 这里调的不是「图标显示多大」—— 那个改不了：tray-icon 在
   * `macos/mod.rs` 里把 `icon_height` 写死成 18.0，宽度按位图宽高比推算。
   * 能调的只有**图形（墨迹）在 18pt 方框里占多大**，也就是靠四周留白。
   *
   * 于是这个值的含义是「**墨迹边长 = 26px × scale**」（36px 画布，见 bitmap.ts）：
   *   · 1.0 = 墨迹 26px，**统一口径**（字形与品牌 logo 同尺寸）；
   *   · 1.3 = 墨迹 34px，恰好是加这个偏好之前 **logo** 的大小（想回旧观感就拉到头）；
   *   · 0.5 = 墨迹 13px，能看清但不抢眼。
   *
   * 为什么是全局而不是每平台：菜单栏上几格并排，大小不一观感很碎；
   * 而且用户要的是「整体偏小一点」，不是一个一个调。
   */
  trayIconScale: number;
  /** 是否定时自动刷新余额 */
  autoRefresh: boolean;
  /** 自动刷新的间隔（分钟） */
  autoRefreshIntervalMin: number;
  /**
   * 每个平台**独立的**刷新间隔（分钟）；缺失键 = 跟随全局默认 `autoRefreshIntervalMin`。
   *
   * 与 trayFields / trayLabels 同一个套路：全局一个默认值，单平台可覆盖。
   * 存的是「显式覆盖值」，所以「跟随全局」= 不在 map 里（而不是存一个和全局一样的数字）。
   */
  providerRefreshMin: Record<string, number>;
  /** 首页趋势图的聚合粒度 */
  trendGranularity: TrendGranularity;
  /**
   * 首页那格**展示哪个指标**（指标名）；null = 自动挑。
   *
   * 名字里带 trend 是历史原因（最早只有走势跟它走），现在它是整格的取数口径 ——
   * 大数字、副行、进度条、走势全由 `snapshot.pickHomeMetric` 按它挑同一个指标。
   * 改名要迁移 localStorage，不值当，注释说清楚即可。
   */
  trendMetric: string | null;
}

/**
 * 自动刷新间隔的**预设**值（分钟）。
 * 这些只是下拉里的快捷项，**不是白名单** —— 用户可以填任意分钟数（见 validInterval）。
 */
export const AUTO_REFRESH_OPTIONS = [1, 2, 3, 5, 10, 15, 30, 60] as const;
/** 自动刷新间隔的默认值（分钟） */
export const DEFAULT_REFRESH_MIN = 15;
/**
 * 自定义间隔的上下限（分钟）。
 * 下限取 1：再小就等于「每帧刷新」，会把平台接口打爆。
 * 上限取 1440（24 小时）：再长还不如手动点刷新。
 */
export const MIN_REFRESH_MIN = 1;
export const MAX_REFRESH_MIN = 1440;

/*
 * 菜单栏图标大小的上下限与步进（比例，见 trayIconScale 的说明）。
 *
 * 上限 1.3 而不是「越大越好」：tray-icon 把显示高度写死成 18pt，
 * 位图给得再大也只是被缩回去 —— 真正能调的只有墨迹占方框的比例，
 * 而墨迹最大就是画布本身。1.3 对应的墨迹是 34px / 36px，
 * 恰好等于**加这个偏好之前 logo 的大小**（素材四周只留 1px 边距），
 * 再往上就会贴边、和相邻状态项的间距挤在一起。
 *
 * 下限 0.5 —— 墨迹 13px，再小图形就只剩几个像素，18pt 下会糊成一团，
 * 那已经不是「小」而是「坏了」。
 */
export const MIN_TRAY_ICON_SCALE = 0.5;
export const MAX_TRAY_ICON_SCALE = 1.3;
export const DEFAULT_TRAY_ICON_SCALE = 1;
/** 滑块的步进。0.05 一档：墨迹每档差 1.3px，肉眼能分辨，又不会调起来没完 */
export const TRAY_ICON_SCALE_STEP = 0.05;

const LS_KEY = 'balances:prefs';
/** 旧版本把开关单独存过一份，读取时做一次兼容 */
const LEGACY_AUTOPUSH_KEY = 'balances:autopush';

const DEFAULTS: BalancesPrefs = {
  visibleProviders: null,
  /*
   * 默认「跟随显示中的平台」—— 也就是装上就用、不用配。
   * 徽章正文只有 95 字节，用户觉得挤了自然会去设置里减平台，那时才产生显式配置。
   */
  pushProviders: null,
  homePinnedProvider: null,
  homePinnedName: null,
  autoPush: true,
  trayEnabled: true,
  /*
   * 默认「跟随显示中的平台」+「全部自动挑指标」—— 也就是装上就用、不用配。
   * 菜单栏挤不下时用户自然会去设置里减平台，那时才产生显式配置。
   */
  trayProviders: null,
  trayFields: {},
  /*
   * 默认「不改名、都显示图标」—— 也就是装上就用、不用配。
   * 自定义名与图标开关都是「用户觉得菜单栏不够顺手时」才去动的东西。
   */
  trayLabels: {},
  trayIconOff: [],
  /* 默认 1 = 墨迹 26px，统一口径（字形与品牌 logo 同尺寸）；拉到 1.3 就是旧 logo 的大小 */
  trayIconScale: DEFAULT_TRAY_ICON_SCALE,
  /*
   * 自动刷新默认开：余额是「越放越不准」的数据，用户要的也是「别让我手动点」。
   * 间隔取 15 分钟 —— ChatGPT 的用量接口没必要更频繁地打。
   */
  autoRefresh: true,
  autoRefreshIntervalMin: DEFAULT_REFRESH_MIN,
  /* 默认没有单平台覆盖 = 全部跟随上面的全局默认 */
  providerRefreshMin: {},
  /*
   * 趋势默认「按小时」：15 分钟刷新下一次就是一天 96 个点，曲线全是毛刺；
   * 按小时聚合后一天 24 个点，走势看得清。想要最细的仍可切「按次」。
   */
  trendGranularity: 'hour',
  /*
   * 默认「自动」：由 format.pickTrendMetric 优先挑百分比指标。
   * 不写死具体指标名 —— 指标名是接口给的，换平台/换套餐就变了。
   * （首页那一格的实际取数口径见 snapshot.pickHomeMetric。）
   */
  trendMetric: null,
};

/* 粒度值同样要收敛：localStorage 是用户可改的，塞进未知值会让分段控件空白 */
function validGranularity(v: unknown): TrendGranularity {
  return v === 'raw' || v === 'hour' || v === 'day' ? v : DEFAULTS.trendGranularity;
}

/** 兼容旧版的独立开关键 */
function loadLegacyAutoPush(): boolean {
  try {
    return localStorage.getItem(LEGACY_AUTOPUSH_KEY) !== 'off';
  } catch {
    return true;
  }
}

/*
 * 间隔值收敛。**不再是「必须落在预设集合里」** —— 用户可填任意分钟数（2026-09-21 起），
 * 所以改成夹到 [MIN_REFRESH_MIN, MAX_REFRESH_MIN]。
 *
 * 但下限不能靠「夹」：localStorage 是用户可改的，塞进 0 / 负数属于**损坏值**
 * （不是用户意图），夹成 1 分钟会把它变成「每分钟打一次接口」。这类值一律回默认值。
 *
 * 导出是为了让 scripts/logic-test.ts 能直接断言边界 —— 这个函数一错，
 * 要么接口被打爆、要么用户的设置被静默改掉，两种都不会在界面上显形。
 */
export function validInterval(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_REFRESH_MIN;
  const n = Math.round(v);
  if (n < MIN_REFRESH_MIN) return DEFAULT_REFRESH_MIN;
  return n > MAX_REFRESH_MIN ? MAX_REFRESH_MIN : n;
}

/**
 * `providerRefreshMin` 的收敛：只留「非空字符串键 → 合法分钟数」的条目。
 *
 * 左右两侧都 trim/校验：localStorage 是用户可改的，塞进数组、null、
 * `{qoder: "x"}`（值不是数字）、`{qoder: 0}`（越界损坏值）这类都会让某个平台
 * 的覆盖值变成「不存在」—— 而「不存在」语义上就是「跟随全局」，用户不会察觉配置被悄悄丢弃。
 * 越界值（< MIN 或 > MAX）直接丢弃该键，而不是夹回边界：它只可能来自手改或 bug，
 * 夹成边界等于「静默把用户没设过的值写进去」。
 *
 * 导出是为了让 scripts/logic-test.ts 直接断言这些坏值都退回 {}。
 */
export function validProviderRefreshMin(v: unknown): Record<string, number> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, number> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof k !== 'string' || !k) continue;
    if (typeof val === 'number' && Number.isFinite(val)) {
      const n = Math.round(val);
      if (n >= MIN_REFRESH_MIN && n <= MAX_REFRESH_MIN) out[k] = n;
    }
  }
  return out;
}

/**
 * 某平台生效的刷新间隔（分钟）。
 *
 * 纯函数：缺失覆盖值 → 回落全局默认 `autoRefreshIntervalMin`。
 * 抽出是为了让 service 的定时器调度与界面的「跟随全局」显示都走同一段口径，
 * 不会出现「界面说跟随全局、定时器却用了别的值」。
 * 导出是为了让 scripts/logic-test.ts 直接断言回落逻辑。
 */
export function resolveRefreshMin(provider: string, prefs: BalancesPrefs): number {
  const over = prefs.providerRefreshMin[provider];
  return typeof over === 'number' ? over : prefs.autoRefreshIntervalMin;
}

/**
 * `pushProviders` 的收敛：只留「非空字符串 → 字符串」的条目，且**去重**。
 *
 * 语义与 `trayProviders` 一致，但多一条**不能丢空串**的规则：
 * `null` = 跟随「显示中的平台」，`[]` = 一个都不推 —— 两者语义完全不同，
 * 所以收敛时必须**保留空数组**，不能当成「没配置」而回退成 null。
 * （回退成 null 会让用户「一个都不推」的意图变成「全推」，正好相反。）
 *
 * 导出是为了让 scripts/logic-test.ts 直接断言这些坏值都退回 null。
 */
export function validPushProviders(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const x of v) {
    if (typeof x === 'string' && x && !out.includes(x)) out.push(x);
  }
  return out;
}

/**
 * `trayFields` 的收敛：只留「非空字符串 → 非空字符串」的条目。
 *
 * 为什么必须收敛而不是直接用：localStorage 是用户可改的，塞进数组、null、
 * `{qoder: 123}` 这类值都会让界面上的下拉匹配不到选项（显示空白），
 * 而**空白下拉比默认值更难解释** —— 用户会以为配置坏了。
 * 导出是为了让 scripts/logic-test.ts 直接断言这些坏值都退回 {}。
 */
export function validTrayFields(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (k && typeof val === 'string' && val) out[k] = val;
  }
  return out;
}

/**
 * `trayLabels` 的收敛：只留「非空 key → 非空字符串」的条目，且**两侧都 trim**。
 *
 * trim 是必须的：用户输入框里打一个空格再删掉，值会变成 `" "` —— 它既不是空串
 * （躲过了上面的 `val` 判空），又会把菜单栏上的名字变成一个看不见的空格，
 * 表现为「这个平台的名字凭空消失了」。存成 `" "` 还是「没有自定义名」，
 * 语义上也说不通。
 */
export function validTrayLabels(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (!k || typeof val !== 'string') continue;
    const s = val.trim();
    if (s) out[k] = s;
  }
  return out;
}

/**
 * `trayIconOff` 的收敛：只留非空字符串，**并去重**。
 *
 * 去重不是洁癖：界面上的开关是「在列表里 = 关掉图标」，重复项会让
 * 「开一次、关一次」的操作在列表里留下两份同一个 id —— 再去开的时候
 * 删掉一份还剩一份，表现为「开关点了没反应」。
 */
export function validTrayIconOff(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (typeof x === 'string' && x && !out.includes(x)) out.push(x);
  }
  return out;
}

/**
 * `trayIconScale` 的收敛。
 *
 * 两步，顺序不能换：
 *   ① **先量化**到两位小数 —— 滑块吐出来的是浮点，`0.7000000000000001` 这种值
 *      会一路进到图标缓存键与菜单栏去重键里，让「同一档位」被判成两个不同的值
 *      （表现为反复重推、或改了没反应）。量化也顺带把 `0.499` 这类
 *      「只差浮点噪声就是合法值」的输入修正成 `0.5`。
 *   ② 量化后**越界一律回默认值**，不是夹到边界。
 *      理由与 validInterval 一致：越界值只可能来自手改 localStorage 或上游的 bug，
 *      都不是「用户意图」。夹到 0.5 会把它变成「静默把一个用户没设过的尺寸写进去」，
 *      而回默认值是**可见的**（图标跳回满尺寸），用户一眼就知道自己的值没被接受。
 *
 * ⚠️ 注意默认值**恰好等于上限**，所以「调得太大」与「值损坏」最终落到同一个结果，
 *    不必（也无法）在行为上区分这两者 —— 别写成两段来暗示它们不同。
 *
 * 导出是为了让 scripts/logic-test.ts 直接断言边界。
 */
export function validTrayIconScale(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_TRAY_ICON_SCALE;
  const n = Math.round(v * 100) / 100;
  if (n < MIN_TRAY_ICON_SCALE || n > MAX_TRAY_ICON_SCALE) return DEFAULT_TRAY_ICON_SCALE;
  return n;
}

function load(): BalancesPrefs {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { ...DEFAULTS, autoPush: loadLegacyAutoPush() };
    const parsed = JSON.parse(raw) as Partial<BalancesPrefs>;
    return {
      autoPush: typeof parsed.autoPush === 'boolean' ? parsed.autoPush : loadLegacyAutoPush(),
      trayEnabled:
        typeof parsed.trayEnabled === 'boolean' ? parsed.trayEnabled : DEFAULTS.trayEnabled,
      trayProviders: Array.isArray(parsed.trayProviders)
        ? parsed.trayProviders.filter((x): x is string => typeof x === 'string')
        : null,
      trayFields: validTrayFields(parsed.trayFields),
      trayLabels: validTrayLabels(parsed.trayLabels),
      trayIconOff: validTrayIconOff(parsed.trayIconOff),
      trayIconScale: validTrayIconScale(parsed.trayIconScale),
      autoRefresh: typeof parsed.autoRefresh === 'boolean' ? parsed.autoRefresh : DEFAULTS.autoRefresh,
      autoRefreshIntervalMin: validInterval(parsed.autoRefreshIntervalMin),
      providerRefreshMin: validProviderRefreshMin(parsed.providerRefreshMin),
      visibleProviders: Array.isArray(parsed.visibleProviders)
        ? parsed.visibleProviders.filter((x): x is string => typeof x === 'string')
        : null,
      pushProviders: validPushProviders(parsed.pushProviders),
      homePinnedProvider:
        typeof parsed.homePinnedProvider === 'string' ? parsed.homePinnedProvider : null,
      homePinnedName:
        typeof parsed.homePinnedName === 'string' ? parsed.homePinnedName : null,
      trendGranularity: validGranularity(parsed.trendGranularity),
      trendMetric: typeof parsed.trendMetric === 'string' ? parsed.trendMetric : null,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function persist(p: BalancesPrefs): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(p));
  } catch {
    /* 隐私模式等场景下忽略 */
  }
}

interface PrefsState extends BalancesPrefs {
  /** null = 恢复为「全部显示」 */
  setVisibleProviders: (ids: string[] | null) => void;
  /**
   * 指定推送到徽章摘要里的平台；id 为 null 表示「跟随显示中的平台」。
   *
   * ⚠️ 这里**不做**「全选 → 收敛成 null」的自动转换：那与 trayProviders 不同 ——
   * 用户主动取消勾选最后一个平台时，意图是「别推这些」，若变成「跟随全部」
   * 反而会把所有平台都推上去。
   */
  setPushProviders: (ids: string[] | null) => void;
  /** 固定到首页；id 为 null 表示取消。name 是展示名，一起存下来 */
  setHomePinned: (id: string | null, name?: string | null) => void;
  setAutoPush: (v: boolean) => void;
  setTrayEnabled: (v: boolean) => void;
  /** null = 恢复为「跟随显示中的平台」 */
  setTrayProviders: (ids: string[] | null) => void;
  /** 指定某平台在菜单栏上显示哪个指标；label 为 null 表示恢复「自动挑」 */
  setTrayField: (provider: string, label: string | null) => void;
  /** 自定义某平台在菜单栏上的名字；text 为空/纯空白表示恢复内置短名 */
  setTrayLabel: (provider: string, text: string | null) => void;
  /** 显示 / 隐藏某平台在菜单栏上的图标 */
  setTrayIconVisible: (provider: string, visible: boolean) => void;
  /** 菜单栏图标大小（全局，0.5~1.0） */
  setTrayIconScale: (v: number) => void;
  setAutoRefresh: (v: boolean) => void;
  setAutoRefreshInterval: (min: number) => void;
  /**
   * 设置某平台的刷新间隔覆盖值；min 为 null = 恢复「跟随全局默认」。
   * 只存合法值（见 validProviderRefreshMin）：越界 / 非数字会被收敛掉。
   */
  setProviderRefreshMin: (provider: string, min: number | null) => void;
  setTrendGranularity: (g: TrendGranularity) => void;
  setTrendMetric: (label: string | null) => void;
  /** 某平台是否显示（visibleProviders 为 null 时全部显示） */
  isVisible: (id: string) => boolean;
}

export const useBalancesPrefs = create<PrefsState>((set, get) => ({
  ...load(),
  setVisibleProviders: (ids) => {
    const next = { ...get(), visibleProviders: ids };
    persist(next);
    set({ visibleProviders: ids });
  },
  setPushProviders: (ids) => {
    const next = { ...get(), pushProviders: ids };
    persist(next);
    set({ pushProviders: ids });
  },
  setHomePinned: (id, name) => {
    const homePinnedName = id ? name ?? null : null;
    const next = { ...get(), homePinnedProvider: id, homePinnedName };
    persist(next);
    set({ homePinnedProvider: id, homePinnedName });
  },
  setAutoPush: (v) => {
    const next = { ...get(), autoPush: v };
    persist(next);
    set({ autoPush: v });
  },
  setTrayEnabled: (v) => {
    const next = { ...get(), trayEnabled: v };
    persist(next);
    set({ trayEnabled: v });
  },
  setTrayProviders: (ids) => {
    /* 空数组与 null 语义不同：[] = 「一个都不上菜单栏」，null = 「跟随显示中的平台」。
       这里不把 [] 收敛成 null —— 用户取消勾选最后一个平台时若变成「跟随全部」，
       菜单栏反而会一下冒出所有平台，正是他要避免的事。 */
    const next = { ...get(), trayProviders: ids };
    persist(next);
    set({ trayProviders: ids });
  },
  setTrayField: (provider, label) => {
    const trayFields = { ...get().trayFields };
    /*
     * 恢复「自动」时**删键**而不是存空串：空串会在 validTrayFields 里被过滤掉，
     * 但保留一个空串键会让「有没有配置过」这件事在内存里与落盘后不一致。
     * 取消勾选平台时也**不删**该平台的字段配置 —— 重新勾选回来还能记得上次选的指标。
     */
    if (label) trayFields[provider] = label;
    else delete trayFields[provider];
    const next = { ...get(), trayFields };
    persist(next);
    set({ trayFields });
  },
  setTrayLabel: (provider, text) => {
    const trayLabels = { ...get().trayLabels };
    /*
     * 清空输入框 = 恢复内置短名，所以**删键**而不是存空串 —— 与 setTrayField
     * 同一个理由：内存里存空串、落盘时被 validTrayLabels 过滤掉，
     * 会让「有没有配置过」这件事在内存与磁盘之间不一致。
     *
     * trim 之后才判断：用户把原来输的字全删了、剩一个空格时，意图显然是「恢复默认」。
     */
    const s = (text ?? '').trim();
    if (s) trayLabels[provider] = s;
    else delete trayLabels[provider];
    const next = { ...get(), trayLabels };
    persist(next);
    set({ trayLabels });
  },
  setTrayIconVisible: (provider, visible) => {
    /*
     * 存「关闭列表」而不是布尔表（见 trayIconOff 的说明）。
     * 这里用 filter 重建而不是 push/splice：列表里的项是「关掉图标的平台」，
     * 重复项会让开关失效（删掉一份还剩一份），重建天然去重。
     */
    const cur = get().trayIconOff;
    const trayIconOff = visible
      ? cur.filter((id) => id !== provider)
      : [...cur.filter((id) => id !== provider), provider];
    const next = { ...get(), trayIconOff };
    persist(next);
    set({ trayIconOff });
  },
  setTrayIconScale: (v) => {
    /* 收敛在 setter 里也做一遍：调用方（滑块）传进来的可能就是越界值，
       而「内存里的值与落盘后的值不一致」是最难查的一类问题 */
    const trayIconScale = validTrayIconScale(v);
    const next = { ...get(), trayIconScale };
    persist(next);
    set({ trayIconScale });
  },
  setAutoRefresh: (v) => {
    const next = { ...get(), autoRefresh: v };
    persist(next);
    set({ autoRefresh: v });
  },
  setTrendMetric: (label) => {
    const trendMetric = typeof label === 'string' && label ? label : null;
    const next = { ...get(), trendMetric };
    persist(next);
    set({ trendMetric });
  },
  setTrendGranularity: (g) => {
    const trendGranularity = validGranularity(g);
    const next = { ...get(), trendGranularity };
    persist(next);
    set({ trendGranularity });
  },
  setAutoRefreshInterval: (min) => {
    const autoRefreshIntervalMin = validInterval(min);
    const next = { ...get(), autoRefreshIntervalMin };
    persist(next);
    set({ autoRefreshIntervalMin });
  },
  setProviderRefreshMin: (provider, min) => {
    const providerRefreshMin = { ...get().providerRefreshMin };
    if (min === null) delete providerRefreshMin[provider];
    else providerRefreshMin[provider] = validInterval(min);
    const next = { ...get(), providerRefreshMin };
    persist(next);
    set({ providerRefreshMin });
  },
  isVisible: (id) => {
    const v = get().visibleProviders;
    return v === null || v.includes(id);
  },
}));

export type { PrefsState };
