/*
 * 时区目录与时区换算（core 层，供首页世界时钟与时区对比模块共用）
 * ------------------------------------------------------------------
 * 为什么在 core 而不是某个 feature 里：**两个模块都要用**。
 * 工作台的约定是「模块之间不直接互相引用」，所以共享能力只能下沉到 core，
 * 或者由其中一个模块导出 public.ts 门面。时区换算显然是通用能力，放 core。
 *
 * 三层内容：
 *   1. 目录（ZONE_CATALOG）—— 手写的 IANA 白名单 + 中文城市名 + 搜索别名。
 *      为什么不用 `Intl.supportedValuesOf('timeZone')`：
 *        · 它返回的是 IANA id，界面要的是中文名，两者之间没有可推导的映射；
 *        · 它有 400+ 条，绝大多数是用户永远不会选的县级时区；
 *        · 它还是较新的 API（Safari 15.4+），而这里只需要一个数组。
 *      ⚠️ id 是**持久化数据**（`workbench:home-clocks`、`workbench:timezone-zones`）。
 *      只能新增，不能改写已有 id —— 改名等于把用户的选择弄丢。
 *   2. 换算（formatClock / instantParts / wallToInstant / nextTransition）
 *      —— 全部交给 `Intl.DateTimeFormat`，**不自己算夏令时**。DST 规则是政治
 *      决定、会变（欧盟 2018 年投票要取消、墨西哥 2022 年取消了），自己维护
 *      偏移表迟早是错的，而运行时的 tzdata 由系统更新。
 *   3. 文案（offsetLabel / dayDeltaLabel / formatUtcOffset）。
 *
 * ⚠️ 两个必须记住的坑（都有断言钉住）：
 *   · 本地偏移**不能**用 `Date.prototype.getTimezoneOffset()`：它返回「UTC − 本地」
 *     且符号与直觉相反（东八区返回 -480）。
 *   · 「墙上时间 → 瞬间」不是单射：夏令时前跳时那一段**不存在**（gap），
 *     回拨时那一段**出现两次**（ambiguous）。`wallToInstant` 把这两种情况显式
 *     返回给调用方，不许静默取一个了事。
 * @Author: fu
 */

/* =============================================
   ====== 目录 ======
   ============================================= */

/** 目录分区。顺序即选择面板里的展示顺序 */
export type ClockRegion = '亚洲' | '欧洲' | '美洲' | '大洋洲' | '非洲' | '其它';

export const CLOCK_REGION_ORDER: readonly ClockRegion[] = [
  '亚洲',
  '欧洲',
  '美洲',
  '大洋洲',
  '非洲',
  '其它',
];

export interface ClockZone {
  /** IANA 时区 id，直接喂给 Intl.DateTimeFormat */
  id: string;
  /** 中文城市名（界面上显示的就是它） */
  city: string;
  /** 英文名 / 别名，只用于搜索（输入 tokyo 也能找到东京） */
  en: string;
  region: ClockRegion;
  /**
   * 常见缩写，**只用于搜索**（输入 PT / PST 能直接找到洛杉矶）。
   *
   * 界面上的缩写不读这里，而是问 Intl 当前是 PST 还是 PDT ——
   * 静态表说不出「此刻是夏令时还是标准时」。这里的值允许重叠：
   * CST 既是美国中部也是中国标准时间，两个城市都列出来让用户自己选，
   * 比猜一个「更可能」的准确。
   */
  abbrs?: string[];
}

/**
 * 同时展示的地区上限（首页世界时钟用）。
 * 不是技术限制，是版面限制：一行放得下 6 个，8 个正好两行。
 */
export const CLOCK_MAX = 8;

export const ZONE_CATALOG: readonly ClockZone[] = [
  /* ---- 亚洲 ---- */
  { id: 'Asia/Shanghai', city: '上海', en: 'Shanghai', region: '亚洲', abbrs: ['CST', 'UTC+8'] },
  { id: 'Asia/Hong_Kong', city: '香港', en: 'Hong Kong', region: '亚洲', abbrs: ['HKT'] },
  { id: 'Asia/Macau', city: '澳门', en: 'Macau', region: '亚洲' },
  { id: 'Asia/Taipei', city: '台北', en: 'Taipei', region: '亚洲' },
  { id: 'Asia/Tokyo', city: '东京', en: 'Tokyo', region: '亚洲', abbrs: ['JST'] },
  { id: 'Asia/Seoul', city: '首尔', en: 'Seoul', region: '亚洲', abbrs: ['KST'] },
  { id: 'Asia/Singapore', city: '新加坡', en: 'Singapore', region: '亚洲', abbrs: ['SGT'] },
  { id: 'Asia/Kuala_Lumpur', city: '吉隆坡', en: 'Kuala Lumpur', region: '亚洲', abbrs: ['MYT'] },
  { id: 'Asia/Manila', city: '马尼拉', en: 'Manila', region: '亚洲', abbrs: ['PHT'] },
  { id: 'Asia/Ho_Chi_Minh', city: '胡志明市', en: 'Ho Chi Minh City / Saigon', region: '亚洲', abbrs: ['ICT'] },
  { id: 'Asia/Bangkok', city: '曼谷', en: 'Bangkok', region: '亚洲', abbrs: ['ICT'] },
  { id: 'Asia/Jakarta', city: '雅加达', en: 'Jakarta', region: '亚洲', abbrs: ['WIB'] },
  { id: 'Asia/Kolkata', city: '新德里', en: 'New Delhi / India', region: '亚洲', abbrs: ['IST'] },
  { id: 'Asia/Dubai', city: '迪拜', en: 'Dubai', region: '亚洲', abbrs: ['GST'] },
  { id: 'Asia/Riyadh', city: '利雅得', en: 'Riyadh', region: '亚洲', abbrs: ['AST'] },
  { id: 'Asia/Tehran', city: '德黑兰', en: 'Tehran', region: '亚洲' },

  /* ---- 欧洲 ---- */
  { id: 'Europe/London', city: '伦敦', en: 'London', region: '欧洲', abbrs: ['GMT', 'BST'] },
  { id: 'Europe/Paris', city: '巴黎', en: 'Paris', region: '欧洲', abbrs: ['CET', 'CEST'] },
  { id: 'Europe/Berlin', city: '柏林', en: 'Berlin', region: '欧洲', abbrs: ['CET', 'CEST'] },
  { id: 'Europe/Madrid', city: '马德里', en: 'Madrid', region: '欧洲', abbrs: ['CET', 'CEST'] },
  { id: 'Europe/Rome', city: '罗马', en: 'Rome', region: '欧洲', abbrs: ['CET', 'CEST'] },
  { id: 'Europe/Amsterdam', city: '阿姆斯特丹', en: 'Amsterdam', region: '欧洲', abbrs: ['CET', 'CEST'] },
  { id: 'Europe/Zurich', city: '苏黎世', en: 'Zurich', region: '欧洲', abbrs: ['CET', 'CEST'] },
  { id: 'Europe/Stockholm', city: '斯德哥尔摩', en: 'Stockholm', region: '欧洲', abbrs: ['CET', 'CEST'] },
  { id: 'Europe/Lisbon', city: '里斯本', en: 'Lisbon', region: '欧洲', abbrs: ['WET', 'WEST'] },
  { id: 'Europe/Moscow', city: '莫斯科', en: 'Moscow', region: '欧洲', abbrs: ['MSK'] },
  { id: 'Europe/Istanbul', city: '伊斯坦布尔', en: 'Istanbul', region: '欧洲', abbrs: ['TRT'] },

  /* ---- 美洲 ---- */
  {
    id: 'America/New_York',
    city: '纽约',
    en: 'New York',
    region: '美洲',
    abbrs: ['ET', 'EST', 'EDT'],
  },
  {
    id: 'America/Chicago',
    city: '芝加哥',
    en: 'Chicago',
    region: '美洲',
    abbrs: ['CT', 'CST', 'CDT'],
  },
  {
    id: 'America/Denver',
    city: '丹佛',
    en: 'Denver',
    region: '美洲',
    abbrs: ['MT', 'MST', 'MDT'],
  },
  {
    id: 'America/Los_Angeles',
    city: '洛杉矶',
    en: 'Los Angeles',
    region: '美洲',
    abbrs: ['PT', 'PST', 'PDT'],
  },
  {
    id: 'America/Anchorage',
    city: '安克雷奇',
    en: 'Anchorage',
    region: '美洲',
    abbrs: ['AKT', 'AKST', 'AKDT'],
  },
  {
    id: 'America/Vancouver',
    city: '温哥华',
    en: 'Vancouver',
    region: '美洲',
    abbrs: ['PT', 'PST', 'PDT'],
  },
  {
    id: 'America/Toronto',
    city: '多伦多',
    en: 'Toronto',
    region: '美洲',
    abbrs: ['ET', 'EST', 'EDT'],
  },
  { id: 'America/Mexico_City', city: '墨西哥城', en: 'Mexico City', region: '美洲', abbrs: ['CST'] },
  {
    /*
     * 凤凰城值得单列：它是美国**不实行夏令时**的时区（亚利桑那全年 MST）。
     * 把它放进来，用户能直接对照出「同样在美国，为什么这个不变」。
     */
    id: 'America/Phoenix',
    city: '凤凰城',
    en: 'Phoenix / Arizona',
    region: '美洲',
    abbrs: ['MST'],
  },
  { id: 'America/Bogota', city: '波哥大', en: 'Bogota', region: '美洲' },
  { id: 'America/Santiago', city: '圣地亚哥', en: 'Santiago', region: '美洲' },
  { id: 'America/Sao_Paulo', city: '圣保罗', en: 'Sao Paulo', region: '美洲', abbrs: ['BRT'] },
  {
    id: 'America/Argentina/Buenos_Aires',
    city: '布宜诺斯艾利斯',
    en: 'Buenos Aires',
    region: '美洲',
    abbrs: ['ART'],
  },

  /* ---- 大洋洲 ---- */
  {
    id: 'Australia/Sydney',
    city: '悉尼',
    en: 'Sydney',
    region: '大洋洲',
    abbrs: ['AET', 'AEST', 'AEDT'],
  },
  {
    id: 'Australia/Melbourne',
    city: '墨尔本',
    en: 'Melbourne',
    region: '大洋洲',
    abbrs: ['AET', 'AEST', 'AEDT'],
  },
  { id: 'Australia/Brisbane', city: '布里斯班', en: 'Brisbane', region: '大洋洲', abbrs: ['AEST'] },
  {
    id: 'Australia/Adelaide',
    city: '阿德莱德',
    en: 'Adelaide',
    region: '大洋洲',
    abbrs: ['ACST', 'ACDT'],
  },
  { id: 'Australia/Perth', city: '珀斯', en: 'Perth', region: '大洋洲', abbrs: ['AWST'] },
  { id: 'Pacific/Auckland', city: '奥克兰', en: 'Auckland', region: '大洋洲', abbrs: ['NZST', 'NZDT'] },
  { id: 'Pacific/Honolulu', city: '檀香山', en: 'Honolulu', region: '大洋洲', abbrs: ['HST'] },

  /* ---- 非洲 ---- */
  { id: 'Africa/Cairo', city: '开罗', en: 'Cairo', region: '非洲' },
  { id: 'Africa/Johannesburg', city: '约翰内斯堡', en: 'Johannesburg', region: '非洲', abbrs: ['SAST'] },
  { id: 'Africa/Lagos', city: '拉各斯', en: 'Lagos', region: '非洲', abbrs: ['WAT'] },
  { id: 'Africa/Nairobi', city: '内罗毕', en: 'Nairobi', region: '非洲', abbrs: ['EAT'] },
  { id: 'Africa/Casablanca', city: '卡萨布兰卡', en: 'Casablanca', region: '非洲' },

  /* ---- 其它 ---- */
  { id: 'UTC', city: '协调世界时', en: 'UTC / GMT', region: '其它', abbrs: ['UTC', 'GMT', 'Z'] },
];

/* 查表用 Map：每秒、每个地区都要查一次，数组 find 没必要 */
const BY_ID = new Map<string, ClockZone>(ZONE_CATALOG.map((z) => [z.id, z]));

/** 按 id 取城市；不在目录里返回 undefined（调用方负责降级） */
export function zoneById(id: string): ClockZone | undefined {
  return BY_ID.get(id);
}

/**
 * 这个 id 是否在目录里。
 *
 * 存在的意义不只是「查得到名字」：**只有已知时区才会被写进存储**。
 * 存进去一个 `Intl` 不认识的 id，下次启动就会在渲染时抛 RangeError，
 * 而 ErrorBoundary 一接住，整个页面都变成「这个模块出错了」。
 *
 * ⚠️ 有一个**唯一例外**：本机时区（`Intl.resolvedOptions().timeZone`）允许不在
 * 目录里。它由运行时给出、一定合法，而且必须能留在列表里 —— 否则身处目录外的
 * 用户会发现「本地」那一格不存在（见 cityFromZoneId）。
 */
export function isKnownZone(id: string): boolean {
  return BY_ID.has(id);
}

/**
 * 从 IANA id 里取一个能看的名字：`Europe/Kyiv` → `Kyiv`。
 * 只给「本机时区不在目录里」这一种情况兜底用。
 */
export function cityFromZoneId(id: string): string {
  const last = id.split('/').pop() ?? id;
  return last.replace(/_/g, ' ') || id;
}

/** 展示用的地区名：目录优先，目录里没有就按 id 兜底 */
export function zoneLabel(id: string): string {
  return zoneById(id)?.city ?? cityFromZoneId(id);
}

/* =============================================
   ====== 格式化器缓存 ======
   =============================================
   Intl.DateTimeFormat 的构造是**相对贵**的操作（要编译 locale 规则），
   而世界时钟每秒、每个地区都要格式化一次。按时区缓存后构造只发生一次。
   ============================================= */
const FMT_CACHE = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const hit = FMT_CACHE.get(timeZone);
  if (hit) return hit;
  const made = new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    /* h23 而不是默认：部分引擎在 hour12:false 下把午夜给成 24 点 */
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
  });
  FMT_CACHE.set(timeZone, made);
  return made;
}

/** 该时区在某个瞬间的「墙上时间」与 UTC 偏移（分钟） */
interface RawParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 「周一」这类短周名 */
  weekday: string;
  /** 相对 UTC 的偏移，东八区 = 480 */
  offsetMinutes: number;
}

function rawParts(date: Date, timeZone: string): RawParts | null {
  let p: Record<string, string>;
  try {
    p = {};
    for (const part of formatterFor(timeZone).formatToParts(date)) {
      if (part.type !== 'literal') p[part.type] = part.value;
    }
  } catch (_) {
    /* 非法时区 id：返回 null 让调用方降级，不要抛到 ErrorBoundary */
    return null;
  }

  const year = Number(p.year);
  const month = Number(p.month);
  const day = Number(p.day);
  const hour = Number(p.hour);
  const minute = Number(p.minute);
  const second = Number(p.second);
  if (![year, month, day, hour, minute, second].every((v) => Number.isFinite(v))) return null;

  /*
   * 偏移 = 「把该时区的墙上时间当作 UTC 读出来的毫秒」 − 「真实的 UTC 毫秒」。
   * 先把真实时刻抹到整秒：parts 里没有毫秒，不抹的话会差出几百毫秒，
   * 四舍五入后偶尔多算一分钟。
   */
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  const real = Math.floor(date.getTime() / 1000) * 1000;

  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    weekday: p.weekday ?? '',
    offsetMinutes: Math.round((wall - real) / 60_000),
  };
}

/* =============================================
   ====== 单个瞬间 ======
   ============================================= */

/** 一个地区此刻的展示数据。全部是**已经格式化好的字符串**，渲染层不再算 */
export interface ClockInfo {
  /** 时:分，两位补零，例如 `09:05` */
  time: string;
  /** 秒，两位补零。单独拆出来是为了用更小的字号弱化它 */
  second: string;
  /** 该时区此刻的日历日，`YYYY-MM-DD`。只用于和本地比「昨天 / 今天 / 明天」 */
  dayKey: string;
  /** 该时区的日期，例如 `10月26日 周一` */
  dateLabel: string;
  /** 相对 UTC 的偏移（分钟）。东八区 = 480 */
  offsetMinutes: number;
}

/**
 * 某个时区此刻的时间。
 * 时区 id 非法时返回 null 而不是抛错 —— 渲染层据此显示「—」。
 */
export function formatClock(now: Date, timeZone: string): ClockInfo | null {
  const p = rawParts(now, timeZone);
  if (!p) return null;
  return {
    time: `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`,
    second: String(p.second).padStart(2, '0'),
    dayKey: dayKeyOf(p),
    dateLabel: `${p.month}月${p.day}日 ${p.weekday}`.trim(),
    offsetMinutes: p.offsetMinutes,
  };
}

/** 一个瞬间在某时区的墙上时间（数字版，给「编辑时间」用） */
export interface WallParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: string;
  offsetMinutes: number;
}

/** 瞬间 → 某时区的墙上时间。非法时区返回 null */
export function instantParts(ms: number, timeZone: string): WallParts | null {
  const p = rawParts(new Date(ms), timeZone);
  return p ? { ...p } : null;
}

/**
 * 按**给定偏移**读墙上时间 —— 忽略该时区真实的夏令时规则。
 *
 * 用途：时区对比里把某个时区「固定成标准时」（不随夏令时跳）。
 * 此时墙上时间就是「瞬间 + 偏移」，不需要问任何时区库。
 *
 * ⚠️ 复用 `rawParts(d, 'UTC')` 而不是自己拼 `getUTC*`：
 *   周名的写法（`周一`）由同一套 Intl formatter 给出，自己写一张表迟早和别处不一致。
 *   偏移不能沿用它的 0，要换成调用方给的那个。
 */
export function partsAtOffset(ms: number, offsetMinutes: number): WallParts | null {
  const shifted = new Date(ms + offsetMinutes * 60_000);
  if (Number.isNaN(shifted.getTime())) return null;
  const p = rawParts(shifted, 'UTC');
  return p ? { ...p, offsetMinutes } : null;
}

/**
 * 墙上时间 → 瞬间（按给定偏移）。
 *
 * ⚠️ 与 `wallToInstant` 不同，这里**没有 gap / ambiguous**：
 *   固定偏移下每一段墙上时间都恰好对应一个瞬间，是单射。
 *   所以返回的是数字而不是 `WallResolution`。
 */
export function wallToInstantAtOffset(offsetMinutes: number, w: WallInput): number | null {
  if (![w.year, w.month, w.day, w.hour, w.minute].every((v) => Number.isFinite(v))) return null;
  const utc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, 0);
  return Number.isFinite(utc) ? utc - offsetMinutes * 60_000 : null;
}

/** 本机所在时区的 IANA id。取不到时按东八区兜底（宁可显示错一个，也不要白屏） */
export function localZoneId(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz) return tz;
  } catch (_) {
    /* 忽略：老 WebView / 被裁剪的 ICU */
  }
  return 'Asia/Shanghai';
}

/** 某个瞬间在该时区的 UTC 偏移（分钟）；非法时区返回 null */
export function offsetAt(ms: number, timeZone: string): number | null {
  const p = rawParts(new Date(ms), timeZone);
  return p ? p.offsetMinutes : null;
}

/**
 * 该时区此刻的缩写（`PST` / `PDT` / `EDT` …）。
 *
 * 只认**字母缩写**：Intl 对没有通用缩写的时区会返回 `GMT+8` 这种，
 * 那种情况返回空串，由调用方退回 `formatUtcOffset` —— 显示 `GMT+8`
 * 的同时又显示 `UTC+8` 是重复信息。
 *
 * 这也是「美国夏令时」在界面上最直接的证据：同一台机器，夏天显示 PDT、
 * 冬天显示 PST，不用我们判断任何规则。
 */
export function zoneAbbr(date: Date, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      timeZoneName: 'short',
    }).formatToParts(date);
    const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
    return /^[A-Z]{2,6}$/.test(name) ? name : '';
  } catch (_) {
    return '';
  }
}

/** `480` → `UTC+8`；`-210` → `UTC-3:30` */
export function formatUtcOffset(minutes: number): string {
  if (!Number.isFinite(minutes)) return '';
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(Math.round(minutes));
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${sign}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`;
}

/* =============================================
   ====== 跨日与时差文案 ======
   ============================================= */

function dayKeyOf(p: RawParts): string {
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** `YYYY-MM-DD` -> 从 1970-01-01 起的天数。非法输入返回 NaN */
function dayIndex(dayKey: string): number {
  const [y, m, d] = dayKey.split('-').map(Number);
  if (![y, m, d].every((v) => Number.isFinite(v))) return NaN;
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}

/**
 * 该地区此刻是本地日期的哪一天：`''`（同一天）/ `昨天` / `明天`。
 * 不返回「今天」—— 同一天是最常见的情况，每张卡都挂一个「今天」纯属噪声。
 */
export function dayDeltaLabel(zoneDayKey: string, localDayKey: string): string {
  const z = dayIndex(zoneDayKey);
  const l = dayIndex(localDayKey);
  if (!Number.isFinite(z) || !Number.isFinite(l)) return '';
  const diff = z - l;
  if (diff === 0) return '';
  if (diff === 1) return '明天';
  if (diff === -1) return '昨天';
  /* 正常时区差不会超过 ±1 天，走到这里说明数据有问题，如实显示 */
  return diff > 0 ? `+${diff} 天` : `${diff} 天`;
}

/**
 * 时差文案，例如 `比本地早 1 小时`、`比本地晚 12 小时`、`比本地晚 2 小时 30 分钟`。
 * 用「早/晚」而不是 `UTC+9`：用户脑子里比的是**自己现在几点**，不是格林尼治。
 *
 * `subject` 是参照物：首页世界时钟比的是「本地」，时区对比模块比的是「对方」。
 */
export function offsetLabel(diffMinutes: number, subject = '本地'): string {
  if (!Number.isFinite(diffMinutes)) return '';
  const diff = Math.round(diffMinutes);
  if (diff === 0) return `与${subject}相同`;

  const abs = Math.abs(diff);
  const hours = Math.floor(abs / 60);
  const minutes = abs % 60;
  /* 印度（+5:30）、德黑兰（+3:30）、阿德莱德（+9:30）这些半小时时区必须写全 */
  const span = [hours > 0 ? `${hours} 小时` : '', minutes > 0 ? `${minutes} 分钟` : '']
    .filter(Boolean)
    .join(' ');

  return `比${subject}${diff > 0 ? '早' : '晚'} ${span}`;
}

/* =============================================
   ====== 墙上时间 → 瞬间（夏令时的两个坑） ======
   ============================================= */

const DAY_MS = 86_400_000;

/** 墙上时间（该时区的日历 + 钟点） */
export interface WallInput {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

export type WallResolution =
  /** 唯一对应一个瞬间 */
  | { kind: 'ok'; ms: number }
  /** 该墙上时间出现两次（回拨）；ms 取较早的一次，alternativeMs 是另一次 */
  | { kind: 'ambiguous'; ms: number; alternativeMs: number }
  /** 该墙上时间不存在（前跳被跳过）；ms 已顺延过跳变点，gapMinutes 是被跳过的分钟数 */
  | { kind: 'gap'; ms: number; gapMinutes: number };

function sameWall(p: WallParts, w: WallInput): boolean {
  return (
    p.year === w.year &&
    p.month === w.month &&
    p.day === w.day &&
    p.hour === w.hour &&
    p.minute === w.minute
  );
}

/**
 * 把「某时区的墙上时间」换算成绝对瞬间。
 *
 * 做法（不查表、不写死规则）：
 *   1. 先把墙上时间**当作 UTC** 读成一个猜测值 guess；
 *   2. 取该时区在 guess ±1 天处的偏移（这两个值跨过了任何可能发生的跳变）；
 *   3. 用这两个偏移各反推一个候选瞬间，再看哪个候选的墙上时间真的等于输入。
 *
 * 于是三种情况自然分开：
 *   · 只有一个候选成立 → 唯一解；
 *   · 两个都成立 → **回拨**（同一墙上时间出现两次），取较早的那个；
 *   · 都不成立 → **前跳**（这段墙上时间根本不存在），取较晚的候选
 *     （= 顺延过跳变点，例如 02:30 顺延成 03:30）。
 *
 * 调用方必须处理 `ambiguous` / `gap`：静默取一个会让「差一小时」这种错误
 * 以「看起来正常」的方式出现。
 */
export function wallToInstant(timeZone: string, w: WallInput): WallResolution | null {
  if (![w.year, w.month, w.day, w.hour, w.minute].every((v) => Number.isFinite(v))) return null;

  const guess = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, 0);
  if (!Number.isFinite(guess)) return null;

  const before = offsetAt(guess - DAY_MS, timeZone);
  const after = offsetAt(guess + DAY_MS, timeZone);
  if (before === null || after === null) return null;

  const c1 = guess - before * 60_000;
  const c2 = guess - after * 60_000;

  const ok1 = (() => {
    const p = instantParts(c1, timeZone);
    return p ? sameWall(p, w) : false;
  })();
  const ok2 = (() => {
    const p = instantParts(c2, timeZone);
    return p ? sameWall(p, w) : false;
  })();

  if (ok1 && ok2) {
    const early = Math.min(c1, c2);
    const late = Math.max(c1, c2);
    return early === late ? { kind: 'ok', ms: early } : { kind: 'ambiguous', ms: early, alternativeMs: late };
  }
  if (ok1) return { kind: 'ok', ms: c1 };
  if (ok2) return { kind: 'ok', ms: c2 };
  return { kind: 'gap', ms: Math.max(c1, c2), gapMinutes: Math.abs(after - before) };
}

export interface Transition {
  /** 跳变发生的瞬间 */
  ms: number;
  /** 跳变前的偏移（分钟） */
  fromOffset: number;
  /** 跳变后的偏移（分钟） */
  toOffset: number;
}

/**
 * 从 `fromMs` 起，该时区的**下一次**偏移跳变（夏令时开始 / 结束）。
 *
 * 逐日扫（最多 400 天）找到偏移变化的那一天，再二分到分钟。
 * 逐日扫是安全的：任何 IANA 时区都不会在 24 小时内跳两次。
 * 找不到（例如 UTC、中国、日本这些不实行夏令时的时区）返回 null。
 */
export function nextTransition(timeZone: string, fromMs: number): Transition | null {
  const start = offsetAt(fromMs, timeZone);
  if (start === null) return null;

  let prevMs = fromMs;
  let prevOffset = start;

  for (let day = 1; day <= 400; day++) {
    const ms = fromMs + day * DAY_MS;
    const off = offsetAt(ms, timeZone);
    if (off === null) return null;

    if (off !== prevOffset) {
      let lo = prevMs;
      let hi = ms;
      /* 二分到分钟：跳变点总是整分钟（实际都是整小时或整半小时） */
      while (hi - lo > 60_000) {
        const mid = Math.round((lo + hi) / 2 / 60_000) * 60_000;
        if (mid <= lo || mid >= hi) break;
        if (offsetAt(mid, timeZone) === prevOffset) lo = mid;
        else hi = mid;
      }
      return { ms: hi, fromOffset: prevOffset, toOffset: off };
    }

    prevMs = ms;
    prevOffset = off;
  }

  return null;
}

/* =============================================
   ====== 城市别名（同一个时区下的其它城市） ======
   =============================================
   为什么需要这一层：目录是「一个时区一条主城」，而用户脑子里是**城市**。
   国内用户搜「北京」，目录里只有「上海」（两者都是 `Asia/Shanghai`），
   搜不到就等于没有这个功能。

   ⚠️ 别名**不能**直接塞进 ZONE_CATALOG：
     · `BY_ID` 是 id → 城市的唯一映射（`zoneLabel` 靠它），同 id 两条会互相覆盖；
     · 目录还要用来分组铺满选择面板，塞进几十条同 id 的重复项只会让面板变长。
   所以别名是**搜索层**的扩展：搜得到、加得进去、格子里显示的是你选的那个城市。

   ⚠️ id 必须已经存在于目录里 —— 构建时按 `BY_ID` 过滤，写错一个 zone 只会
   让那条别名静默消失，不会在运行时炸。
   ============================================= */
export interface CityAlias {
  /** IANA 时区 id（与目录里的主城共用） */
  id: string;
  /** 别名城市的中文名，也是格子上的显示名 */
  city: string;
  /** 英文名 / 别名，只用于搜索 */
  en: string;
}

/* [时区 id, 中文城市名, 英文名] —— 按大洲排，方便以后追加 */
const ALIAS_ROWS: ReadonlyArray<readonly [string, string, string]> = [
  /* ---- 中国（全部 Asia/Shanghai） ---- */
  ['Asia/Shanghai', '北京', 'Beijing'],
  ['Asia/Shanghai', '广州', 'Guangzhou'],
  ['Asia/Shanghai', '深圳', 'Shenzhen'],
  ['Asia/Shanghai', '成都', 'Chengdu'],
  ['Asia/Shanghai', '杭州', 'Hangzhou'],
  ['Asia/Shanghai', '南京', 'Nanjing'],
  ['Asia/Shanghai', '武汉', 'Wuhan'],
  ['Asia/Shanghai', '西安', "Xi'an"],
  ['Asia/Shanghai', '重庆', 'Chongqing'],
  ['Asia/Shanghai', '天津', 'Tianjin'],
  ['Asia/Shanghai', '苏州', 'Suzhou'],
  ['Asia/Shanghai', '青岛', 'Qingdao'],
  ['Asia/Shanghai', '厦门', 'Xiamen'],
  ['Asia/Shanghai', '长沙', 'Changsha'],

  /* ---- 东亚 / 东南亚 / 南亚 ---- */
  ['Asia/Tokyo', '大阪', 'Osaka'],
  ['Asia/Tokyo', '名古屋', 'Nagoya'],
  ['Asia/Tokyo', '札幌', 'Sapporo'],
  ['Asia/Tokyo', '京都', 'Kyoto'],
  ['Asia/Tokyo', '福冈', 'Fukuoka'],
  ['Asia/Seoul', '釜山', 'Busan'],
  ['Asia/Seoul', '仁川', 'Incheon'],
  ['Asia/Taipei', '高雄', 'Kaohsiung'],
  ['Asia/Taipei', '台中', 'Taichung'],
  ['Asia/Bangkok', '清迈', 'Chiang Mai'],
  ['Asia/Bangkok', '普吉', 'Phuket'],
  ['Asia/Jakarta', '泗水', 'Surabaya'],
  ['Asia/Kolkata', '孟买', 'Mumbai'],
  ['Asia/Kolkata', '班加罗尔', 'Bangalore'],
  ['Asia/Kolkata', '金奈', 'Chennai'],
  ['Asia/Dubai', '阿布扎比', 'Abu Dhabi'],
  ['Asia/Riyadh', '吉达', 'Jeddah'],

  /* ---- 欧洲 ---- */
  ['Europe/London', '曼彻斯特', 'Manchester'],
  ['Europe/London', '爱丁堡', 'Edinburgh'],
  ['Europe/Paris', '里昂', 'Lyon'],
  ['Europe/Paris', '马赛', 'Marseille'],
  ['Europe/Berlin', '慕尼黑', 'Munich'],
  ['Europe/Berlin', '法兰克福', 'Frankfurt'],
  ['Europe/Berlin', '汉堡', 'Hamburg'],
  ['Europe/Madrid', '巴塞罗那', 'Barcelona'],
  ['Europe/Rome', '米兰', 'Milan'],
  ['Europe/Rome', '那不勒斯', 'Naples'],
  ['Europe/Amsterdam', '鹿特丹', 'Rotterdam'],
  ['Europe/Amsterdam', '海牙', 'The Hague'],
  ['Europe/Zurich', '日内瓦', 'Geneva'],
  ['Europe/Lisbon', '波尔图', 'Porto'],
  ['Europe/Moscow', '圣彼得堡', 'Saint Petersburg'],
  ['Europe/Istanbul', '安卡拉', 'Ankara'],

  /* ---- 北美 ---- */
  ['America/New_York', '波士顿', 'Boston'],
  ['America/New_York', '华盛顿', 'Washington DC'],
  ['America/New_York', '费城', 'Philadelphia'],
  ['America/New_York', '亚特兰大', 'Atlanta'],
  ['America/New_York', '迈阿密', 'Miami'],
  ['America/New_York', '底特律', 'Detroit'],
  ['America/Chicago', '休斯顿', 'Houston'],
  ['America/Chicago', '达拉斯', 'Dallas'],
  ['America/Chicago', '奥斯汀', 'Austin'],
  ['America/Chicago', '圣安东尼奥', 'San Antonio'],
  ['America/Denver', '盐湖城', 'Salt Lake City'],
  ['America/Los_Angeles', '旧金山', 'San Francisco'],
  ['America/Los_Angeles', '圣何塞', 'San Jose'],
  ['America/Los_Angeles', '西雅图', 'Seattle'],
  ['America/Los_Angeles', '圣迭戈', 'San Diego'],
  ['America/Los_Angeles', '波特兰', 'Portland'],
  ['America/Los_Angeles', '拉斯维加斯', 'Las Vegas'],
  ['America/Vancouver', '维多利亚', 'Victoria'],
  ['America/Toronto', '渥太华', 'Ottawa'],
  ['America/Toronto', '蒙特利尔', 'Montreal'],
  ['America/Mexico_City', '瓜达拉哈拉', 'Guadalajara'],

  /* ---- 南美 / 大洋洲 / 非洲 ---- */
  ['America/Bogota', '麦德林', 'Medellin'],
  ['America/Sao_Paulo', '里约热内卢', 'Rio de Janeiro'],
  ['Australia/Sydney', '堪培拉', 'Canberra'],
  ['Australia/Brisbane', '黄金海岸', 'Gold Coast'],
  ['Australia/Brisbane', '凯恩斯', 'Cairns'],
  ['Pacific/Auckland', '惠灵顿', 'Wellington'],
  ['Pacific/Auckland', '基督城', 'Christchurch'],
  ['Africa/Cairo', '亚历山大', 'Alexandria'],
  ['Africa/Johannesburg', '开普敦', 'Cape Town'],
  ['Africa/Johannesburg', '德班', 'Durban'],
  ['Africa/Johannesburg', '比勒陀利亚', 'Pretoria'],
  ['Africa/Lagos', '阿布贾', 'Abuja'],
  ['Africa/Casablanca', '马拉喀什', 'Marrakech'],
];

export const CITY_ALIASES: readonly CityAlias[] = ALIAS_ROWS.filter(([id]) => BY_ID.has(id)).map(
  ([id, city, en]) => ({ id, city, en }),
);

/**
 * 这个城市名是不是该时区**真的有的**城市（主城或别名）。
 *
 * 用来挡住手改存储写进来的「`Asia/Tokyo` + 北京」这种组合 —— 格子上写着北京、
 * 走的却是东京时间，比丢一个城市名糟得多。
 */
export function cityBelongsTo(zone: string, city: string): boolean {
  const main = BY_ID.get(zone);
  if (main && main.city === city) return true;
  return CITY_ALIASES.some((a) => a.id === zone && a.city === city);
}

/* =============================================
   ====== 国家 / 地区检索 ======
   =============================================
   用户脑子里常常是**国家**而不是城市：搜「印度尼西亚」时他不会想到要输「雅加达」。
   目录里只有城市名，所以单靠目录永远搜不到 —— 这里补一张「国家 → 它有哪些时区」的表。

   ⚠️ 与 `CITY_ALIASES` 分开，理由有两条：
     · 国家不是城市，不能当成格子上的显示名（「印度尼西亚」不是地名）；
     · 一个国家往往对应多个时区（美国 7 个），命中的是**一组**，不是一条。

   ⚠️ 中国香港 / 中国澳门 / 中国台湾 都是中国的一部分，命名按官方口径写。
   ============================================= */
const COUNTRY_ROWS: ReadonlyArray<readonly [names: readonly string[], zones: readonly string[]]> = [
  [
    ['中国', 'China'],
    ['Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Macau', 'Asia/Taipei'],
  ],
  [['中国香港', '香港', 'Hong Kong'], ['Asia/Hong_Kong']],
  [['中国澳门', '澳门', 'Macao', 'Macau'], ['Asia/Macau']],
  [['中国台湾', '台湾', 'Taiwan'], ['Asia/Taipei']],
  [['日本', 'Japan'], ['Asia/Tokyo']],
  [['韩国', '南韩', 'South Korea', 'Korea'], ['Asia/Seoul']],
  [['新加坡', 'Singapore'], ['Asia/Singapore']],
  [['马来西亚', '大马', 'Malaysia'], ['Asia/Kuala_Lumpur']],
  [['菲律宾', 'Philippines'], ['Asia/Manila']],
  [['越南', 'Vietnam'], ['Asia/Ho_Chi_Minh']],
  [['泰国', 'Thailand'], ['Asia/Bangkok']],
  [['印度尼西亚', '印尼', 'Indonesia'], ['Asia/Jakarta']],
  [['印度', 'India'], ['Asia/Kolkata']],
  [['阿联酋', '阿拉伯联合酋长国', 'UAE', 'United Arab Emirates'], ['Asia/Dubai']],
  [['沙特', '沙特阿拉伯', 'Saudi Arabia'], ['Asia/Riyadh']],
  [['伊朗', 'Iran'], ['Asia/Tehran']],
  [['英国', '联合王国', 'UK', 'United Kingdom'], ['Europe/London']],
  [['法国', 'France'], ['Europe/Paris']],
  [['德国', 'Germany'], ['Europe/Berlin']],
  [['西班牙', 'Spain'], ['Europe/Madrid']],
  [['意大利', 'Italy'], ['Europe/Rome']],
  [['荷兰', 'Netherlands'], ['Europe/Amsterdam']],
  [['瑞士', 'Switzerland'], ['Europe/Zurich']],
  [['瑞典', 'Sweden'], ['Europe/Stockholm']],
  [['葡萄牙', 'Portugal'], ['Europe/Lisbon']],
  [['俄罗斯', 'Russia'], ['Europe/Moscow']],
  [['土耳其', 'Turkey'], ['Europe/Istanbul']],
  [
    ['美国', 'USA', 'United States', 'America'],
    [
      'America/New_York',
      'America/Chicago',
      'America/Denver',
      'America/Los_Angeles',
      'America/Anchorage',
      'America/Phoenix',
      'Pacific/Honolulu',
    ],
  ],
  [['加拿大', 'Canada'], ['America/Vancouver', 'America/Toronto']],
  [['墨西哥', 'Mexico'], ['America/Mexico_City']],
  [['哥伦比亚', 'Colombia'], ['America/Bogota']],
  [['智利', 'Chile'], ['America/Santiago']],
  [['巴西', 'Brazil'], ['America/Sao_Paulo']],
  [['阿根廷', 'Argentina'], ['America/Argentina/Buenos_Aires']],
  [
    ['澳大利亚', '澳洲', 'Australia'],
    [
      'Australia/Sydney',
      'Australia/Melbourne',
      'Australia/Brisbane',
      'Australia/Adelaide',
      'Australia/Perth',
    ],
  ],
  [['新西兰', 'New Zealand'], ['Pacific/Auckland']],
  [['埃及', 'Egypt'], ['Africa/Cairo']],
  [['南非', 'South Africa'], ['Africa/Johannesburg']],
  [['尼日利亚', 'Nigeria'], ['Africa/Lagos']],
  [['肯尼亚', 'Kenya'], ['Africa/Nairobi']],
  [['摩洛哥', 'Morocco'], ['Africa/Casablanca']],
];

/* 展开成「名字 → 时区组」，并丢掉目录里不存在的时区（防御：写错 id 只会静默失效） */
const COUNTRY_INDEX: ReadonlyArray<{ name: string; zones: readonly string[] }> =
  COUNTRY_ROWS.flatMap(([names, zones]) => {
    const valid = zones.filter((z) => BY_ID.has(z));
    return names.map((name) => ({ name: name.toLowerCase(), zones: valid }));
  });

/* 反查表：时区 → 它所属的国家/地区名（供各处的搜索框拼检索串） */
const COUNTRY_BY_ZONE = new Map<string, string[]>();
for (const c of COUNTRY_INDEX) {
  for (const z of c.zones) {
    const list = COUNTRY_BY_ZONE.get(z);
    if (list) list.push(c.name);
    else COUNTRY_BY_ZONE.set(z, [c.name]);
  }
}

/** 该时区所属的国家 / 地区名（小写，直接进检索串）。没登记返回空数组 */
export function countryNamesOf(zone: string): string[] {
  return COUNTRY_BY_ZONE.get(zone) ?? [];
}

/* =============================================
   ====== 选择面板的数据 ======
   ============================================= */

/**
 * 搜索：中文城市名 / 英文名 / IANA id / 分区名 / 缩写都算命中。
 *
 * 返回的元素与目录同形（`ClockZone`），但**同一个 `id` 可能出现多条**
 * （北京与上海共用 `Asia/Shanghai`）—— 调用方渲染时必须用 `id + city` 做 key，
 * 判断「已添加」时才按 `id` 去重。
 *
 * 空关键词返回**目录全量**（不含别名）：面板默认要的是「每个时区一条」的整齐列表，
 * 而不是几十条同 id 的城市。
 *
 * 三类命中，语义各不相同：
 *   · 城市 / 英文名 / 分区名 → **包含**匹配（搜索本来的语义）；
 *   · 缩写 → **全等**匹配（见下）；
 *   · 国家 / 地区名 → 命中后返回该国**全部**时区（搜「印度尼西亚」出雅加达）。
 *
 * ⚠️ 缩写用**全等**而不是包含：`ET` 若按包含匹配，所有 CET/CEST 的城市都会命中
 * （`cet`.includes('et') 成立），输入两个字母就刷出一屏欧洲城市。
 * 城市名/英文名才用包含 —— 那是搜索本来的语义。
 */
export function searchCities(keyword: string): ClockZone[] {
  const q = keyword.trim().toLowerCase();
  if (!q) return ZONE_CATALOG.slice();

  const abbrHit = (z: ClockZone) => (z.abbrs ?? []).some((a) => a.toLowerCase() === q);

  /*
   * 国家 / 地区名命中 → 该国**所有**时区都算命中。
   * 这是「搜印度尼西亚要能出雅加达」的唯一来源：目录里只有城市名。
   * 只作用于目录（不扩散到别名城市），否则搜「美国」会一次刷出二十几个城市。
   *
   * ⚠️ 中文用**包含**、英文用**前缀**：
   *   · 「印尼」是「印度尼西亚」的缩写而不是前缀，用 startsWith 就搜不到了；
   *   · 英文反过来 —— 用 includes 的话输 `pt` 会命中 `egypt`（埃及），
   *     而用户输 `pt` 想要的是太平洋时间。
   */
  const asciiQuery = /^[\x20-\x7e]+$/.test(q);
  const countryZones = new Set<string>();
  for (const c of COUNTRY_INDEX) {
    const hit = asciiQuery ? c.name.startsWith(q) : c.name.includes(q);
    if (hit) for (const z of c.zones) countryZones.add(z);
  }

  const catalog = ZONE_CATALOG.filter(
    (z) =>
      countryZones.has(z.id) ||
      z.city.includes(q) ||
      z.en.toLowerCase().includes(q) ||
      z.id.toLowerCase().includes(q) ||
      z.region.includes(q) ||
      abbrHit(z),
  );

  /*
   * 别名只按「城市名 / 英文名 / 分区」匹配，**不按 id**：
   * 否则搜 `shanghai` 会把「北京」也带出来（它俩 id 都是 Asia/Shanghai），
   * 用户看到的是「我搜上海，结果冒出北京」。
   */
  const regionOf = (id: string): ClockRegion => BY_ID.get(id)?.region ?? '其它';
  const aliases: ClockZone[] = CITY_ALIASES.filter(
    (a) => a.city.includes(q) || a.en.toLowerCase().includes(q) || regionOf(a.id).includes(q),
  ).map((a) => ({
    id: a.id,
    city: a.city,
    en: a.en,
    region: regionOf(a.id),
  }));

  return [...catalog, ...aliases];
}

export interface ZoneGroup {
  region: ClockRegion;
  zones: ClockZone[];
}

/** 按分区归组，空分区不出现；分区顺序固定（与目录顺序无关，目录可以随意追加） */
export function groupZones(zones: readonly ClockZone[]): ZoneGroup[] {
  const buckets = new Map<ClockRegion, ClockZone[]>();
  for (const z of zones) {
    const list = buckets.get(z.region);
    if (list) list.push(z);
    else buckets.set(z.region, [z]);
  }
  const out: ZoneGroup[] = [];
  for (const region of CLOCK_REGION_ORDER) {
    const list = buckets.get(region);
    if (list?.length) out.push({ region, zones: list });
  }
  return out;
}

/* =============================================
   ====== 夏令时档案（首页世界时钟 / 时区对比共用） ======
   =============================================
   回答两个问题：
     · 这个时区现在是不是夏令时、标准时是哪一档；
     · 同一个瞬间按两档分别写出来各是几点。

   ⚠️ 放在 core 而不是 features/timezone：**两个模块都要用**，
   而工作台的约定是「模块之间不直接互相引用」。
   ============================================= */

/** 两位补零 */
export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export interface DstProfile {
  /** 这个时区实不实行夏令时（未来 400 天内有没有跳变） */
  usesDst: boolean;
  /** 此刻是否正处于夏令时 */
  inDst: boolean;
  /** 此刻的偏移（分钟） */
  offset: number;
  /** 标准时偏移；不实行夏令时则等于此刻的偏移 */
  standardOffset: number;
  /** 夏令时相对标准时的增量（分钟，通常 60；不实行夏令时为 0） */
  shift: number;
}

/**
 * 组装夏令时档案。
 *
 * ⚠️ 刻意**不接收时间戳**，只接收 `offset` 与 `next`：
 *   · `offset` 由调用方现取（`instantParts` / `offsetAt`）—— 跳变当天上午和下午
 *     不一样，不能按「天」缓存，否则切换那一整天都会显示错的档；
 *   · `next` 由调用方按天缓存 —— 逐日扫 400 天很贵，而「下一次跳变」一天内不变。
 * 两个输入拼起来，既有实时性，又不重复做昂贵计算。
 */
export function dstProfile(offset: number | null, next: Transition | null): DstProfile | null {
  if (offset === null) return null;
  if (!next) {
    return { usesDst: false, inDst: false, offset, standardOffset: offset, shift: 0 };
  }

  /*
   * 下一次跳变是「开始」还是「结束」，决定了现在处在哪一侧：
   *   · 即将开始（偏移变大）→ 现在是标准时，标准偏移 = 跳变前的偏移；
   *   · 即将结束（偏移变小）→ 现在是夏令时，标准偏移 = 跳变后的偏移。
   * 夏令时**只会把钟往前拨**（偏移变大），所以标准偏移永远是两者中较小的那个。
   *
   * `inDst` 用「实时 offset 与标准偏移比大小」而不是「下次是开始还是结束」：
   * 跳变那一整天 `next` 是缓存的旧值，只有实时 offset 才能反映已经跳过去了。
   */
  const starting = next.toOffset > next.fromOffset;
  const standardOffset = starting ? next.fromOffset : next.toOffset;
  return {
    usesDst: true,
    inDst: offset > standardOffset,
    offset,
    standardOffset,
    shift: Math.abs(next.toOffset - next.fromOffset),
  };
}

export interface AbbrPair {
  /** 标准时缩写；该时区没有字母缩写时是空串 */
  standard: string;
  /** 夏令时缩写 */
  daylight: string;
}

/**
 * 同一个时区在标准时 / 夏令时两侧的缩写（`PST` / `PDT`）。
 *
 * 做法是**问 Intl 要跳变点两侧的缩写**，不查任何手写表：
 * 跳变前 1 秒必然还在旧的一侧，跳变后 1 秒必然已经在新的一侧。
 * 于是「哪个缩写属于哪一档」由运行时回答 —— 包括我们没预料到的时区。
 *
 * 不实行夏令时（`next` 为 null）返回 null：那里只有一个缩写，没有「另一档」。
 */
export function abbrPair(timeZone: string, next: Transition | null): AbbrPair | null {
  if (!next) return null;
  const before = zoneAbbr(new Date(next.ms - 1000), timeZone);
  const after = zoneAbbr(new Date(next.ms + 1000), timeZone);
  const starting = next.toOffset > next.fromOffset;
  return starting ? { standard: before, daylight: after } : { standard: after, daylight: before };
}

export interface OtherTier {
  /** 另一档的名字：`标准时` 或 `夏令时` */
  name: string;
  /** 另一档的缩写与偏移，例如 `PST（UTC-8）` */
  text: string;
}

/**
 * 「另一档」的描述：此刻在夏令时就给标准时那档，反之亦然。
 *
 * ⚠️ 没有字母缩写时只写偏移 —— 伦敦夏天 Intl 只给 `GMT+1`，直接拼括号会变成
 * 「UTC+1（UTC+1）」，同一个信息写两遍。
 */
export function otherTier(profile: DstProfile, pair: AbbrPair | null): OtherTier {
  const name = profile.inDst ? '标准时' : '夏令时';
  const offset = profile.inDst ? profile.standardOffset : profile.standardOffset + profile.shift;
  const abbr = (profile.inDst ? pair?.standard : pair?.daylight) ?? '';
  return {
    name,
    text: abbr ? `${abbr}（${formatUtcOffset(offset)}）` : formatUtcOffset(offset),
  };
}

export interface TierTimes {
  /** 按标准时算的钟点，`08:12` */
  standard: string;
  /** 按夏令时算的钟点，`09:12` */
  daylight: string;
}

/**
 * 两档钟点：同一个瞬间，按「如果按标准时算」和「如果按夏令时算」各写一次。
 *
 * 界面上两处并排显示，**标准时在前**（它是基准）。
 * 做法：把这个瞬间加上该档的偏移，再用 UTC 读出来 —— 不需要任何额外查表，
 * 因为「墙上时间」本来就是「瞬间 + 偏移」。
 */
export function tierTimes(ms: number, profile: DstProfile): TierTimes {
  const at = (offsetMinutes: number): string => {
    const d = new Date(ms + offsetMinutes * 60_000);
    return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
  };
  return {
    standard: at(profile.standardOffset),
    daylight: at(profile.standardOffset + profile.shift),
  };
}
