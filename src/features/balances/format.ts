/*
 * 智能体余额模块 · 纯逻辑（无 React / 无 store 依赖）
 * ------------------------------------------------------------------
 * 面板与蓝牙摘要共用同一套「指标优先级 / 短标签 / 字节预算」规则，
 * 保证两处展示的先后顺序一致（都以「余额」为主指标）。
 *
 * 这里同时收纳所有「值得单独测、但挂到 store 上就测不了」的判定逻辑：
 * 指标优先级、健康度归一、颜色、角标阈值与色调、趋势序列的取舍。
 */
import type { BalanceItem } from './types';
import type { BadgeTone } from '@/core/types';

/** 固件限制：推送到徽章的正文 ≤95 字节（见 aipassport 模块） */
export const BODY_MAX = 95;

/**
 * 平台之间的分隔符。
 *
 * ⚠️ 它的**字节数必须算出来，不能手写常量**：`·` 是 U+00B7，UTF-8 占 **2 字节**，
 * 加上两侧空格一共 **4 字节**。曾手写成 3，于是两个平台时摘要实际比预算多 1 字节，
 * 推送到徽章被后端拒掉（"正文过长（96 字节，徽章最多 95 字节）"）——
 * 而界面上看不出任何异常，只是「推送」按钮一直报错。
 *
 * 通用教训：**任何要按字节计预算的常量，都用 byteLen() 现算**，别抄数字。
 */
export const SUMMARY_SEP = ' · ';

/**
 * 摘要打包只关心这三样，不必是完整的 AgentBalance。
 * 这样「内存里的实时数据」和「localStorage 快照」都能直接喂进来。
 */
export interface BadgeSummaryInput {
  name: string;
  items: BalanceItem[];
  error?: string | null;
}

/**
 * 摘要里的短标签：省字节，且让「余额」先露出来。
 *
 * ⚠️ 键必须与**后端产出的 label 逐字相同** —— 对不上不会报错，只是悄悄退回全称，
 * 表现为徽章上少显示了几个平台（95 字节的预算被长标签吃掉）。
 * **注意后端有两条产出路径**：`qoder_cli.rs::build_balance`（CLI，首选）与
 * `qoder.rs::build_balance`（PAT 兜底），**两边的标签都要抄全**。
 * 新增平台时到对应 `build_balance` 里抄一遍标签，并补一条断言钉住。
 */
const SHORT_LABEL: Record<string, string> = {
  本时段已用: '本时段',
  本周已用: '本周',
  剩余额度: '余额',
  约可用消息: '可用',
  可用重置次数: '重置',
  /* Qoder CN · CLI 路径（qoder_cli.rs） */
  组织池剩余: '组织池',
  资源包已用: '资源包',
  今日已用: '今日',
  加量包剩余: '加量包',
  个人额度已用: '个人额度',
  可用总额: '可用',
  额度到期: '到期',
  /* Qoder CN · PAT 兜底路径（qoder.rs）—— 这几个只在没装 CLI 时才出现 */
  额度已用: '额度',
  组织资源包: '组织包',
  /* Trae · 网页登录态路径（trae.rs）—— 「本周期」是订阅周期，别与 ChatGPT 的「本时段」混 */
  本周期剩余: '剩余',
  本周期已用: '已用',
  本周期总额: '总额',
  已用比例: '比例',
  权益包额度: '权益包',
};

/**
 * 带序号的动态标签用前缀表归一 —— 静态表放不下无限序号。
 *
 * 后端 `format!("专用资源包 {}", i + 1)` 会产出「专用资源包 1 / 2 / …」，
 * 命中后**把序号原样接回去**（「专用包 1」）：多个专用包之间就靠这个序号区分，
 * 丢掉它反而看不出是哪一个。
 */
const SHORT_LABEL_PREFIX: readonly [string, string][] = [['专用资源包 ', '专用包']];

/** 指标优先级：余额/额度 > 已用/用量 > 其他（越小越优先） */
export function itemPriority(label: string): number {
  if (/余额|额度|剩余|credit/i.test(label)) return 0;
  if (/已用|用量|使用|percent|%/.test(label)) return 1;
  return 2;
}

/** 按优先级排序（不改原数组），余额类指标排在最前 */
export function sortItems(items: BalanceItem[]): BalanceItem[] {
  return [...items].sort((a, b) => itemPriority(a.label) - itemPriority(b.label));
}

/** UTF-8 字节数：中文 1 字 = 3 字节，不能用 String.length */
export function byteLen(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * 按 UTF-8 字节数截断，**不切断字符**。
 *
 * 用 for...of 按码点迭代，所以代理对（emoji 等）不会被劈成两半。
 *
 * ⚠️ 截断只适合「兜底」，**不要用它来裁剪数值** —— 把「984.31」截成「984.3」
 * 得到的是另一个数字，比少显示一项糟糕得多。要丢内容就整块丢（见 buildBadgeSummary）。
 */
export function truncateBytes(s: string, maxBytes: number): string {
  if (byteLen(s) <= maxBytes) return s;
  let out = '';
  let used = 0;
  for (const ch of s) {
    const n = byteLen(ch);
    if (used + n > maxBytes) break;
    out += ch;
    used += n;
  }
  return out;
}

/** 展示用短标签 */
export function shortLabel(label: string): string {
  const exact = SHORT_LABEL[label];
  if (exact !== undefined) return exact;
  /* 带序号的动态标签走前缀表（见 SHORT_LABEL_PREFIX）。前缀自带尾空格，所以
     「专用资源包」这个裸标签不会被误命中；这里再补一个空格 —— 否则徽章上会粘成
     「专用包175%」，序号和数值分不开。 */
  for (const [prefix, short] of SHORT_LABEL_PREFIX) {
    if (label.startsWith(prefix)) return `${short} ${label.slice(prefix.length)}`;
  }
  return label;
}

/* =============================================
   ====== 百分比：健康度与颜色 ======
   ============================================= */

/*
 * 底色明暗。故意不从 @/core/theme 引 ThemeMode —— 那会让这个纯函数文件
 * 沾上 core 的类型依赖（也就把 antd 拖进来），而它要能在 node 里单独跑测试。
 * 结构上与 ThemeMode 完全一致，传进来不会有类型问题。
 */
export type HealthColorMode = 'dark' | 'light';

/** "29%" → 29；不是「纯百分比」或超出 0~100 的返回 null */
export function percentOf(value: string): number | null {
  const m = value.trim().match(/^(-?\d+(?:\.\d+)?)\s*%$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

/**
 * 百分比标签的语义：`已用 / 用量` 越高越糟，`剩余 / 额度` 越低越糟。
 * 两种语义必须先归一到同一个轴，否则颜色和阈值的方向会反。
 */
export function isUsageLabel(label: string): boolean {
  if (/已用|用量|使用|消耗|used|usage/i.test(label)) return true;
  if (/剩余|余额|额度|可用|余量|remaining|left|credit/i.test(label)) return false;
  /* 接口给的就是 used_percent，认不出来时按「已用」处理 */
  return true;
}

/**
 * 把百分比统一成「健康度」：**100 = 额度充足，0 = 额度耗尽**。
 *
 * 阈值提醒与颜色渐变都建在这个轴上，于是「已用 95%」和「剩余 5%」等价 ——
 * 界面照旧显示接口给的那个数，只有颜色和告警看健康度。
 */
export function healthPercentOf(label: string, value: string): number | null {
  const v = percentOf(value);
  if (v === null) return null;
  return isUsageLabel(label) ? 100 - v : v;
}

/**
 * 一批指标里**最低的健康度**（最紧张的那个）；没有任何可比的百分比时返回 null。
 *
 * 抽成纯函数是为了能单独跑测试 —— 侧栏角标依赖它，而角标本身要挂到 zustand 上，
 * 在 node 里没法直接测。带 `error` 的平台整块跳过（它的 items 是上次的残留或空的）。
 */
export function worstHealth(list: BadgeSummaryInput[]): number | null {
  let worst: number | null = null;
  for (const b of list) {
    if (b.error) continue;
    for (const it of b.items) {
      const h = healthPercentOf(it.label, it.value);
      if (h === null) continue;
      if (worst === null || h < worst) worst = h;
    }
  }
  return worst === null ? null : Math.round(worst);
}

/**
 * 侧栏角标文案：最低健康度**跌破等于**阈值时才显示（用 `<=`，与提醒档位同一口径 ——
 * 「正好 50%」算已经跌破），否则返回 null。
 *
 * 抽出来是为了让这个边界可测：`<=` 还是 `<` 正是最容易想当然搞错的那类判断，
 * 而它在界面上看不出来（角标要么出现要么不出现，没人会去试「恰好 50%」这一格）。
 */
export function healthBadgeText(worst: number | null, threshold: number): string | null {
  return worst !== null && worst <= threshold ? `${worst}%` : null;
}

/**
 * 角标三档的边界。**刻意取 ALERT_THRESHOLDS 里已有的档位**（30 与 10），
 * 而不是新造一套刻度 —— 否则用户得同时学「颜色分几档」和「提醒分几档」两套规则。
 *
 * 角标只在 health ≤ 50 时才出现（见 healthBadgeText），所以三段正好铺满它的可见区间：
 *   50..31 info（开始关注）· 30..11 warn（紧张）· ≤10 danger（危险）
 * 一致性由 logic-test 断言守住（断言这两个值必须出现在 ALERT_THRESHOLDS 里），
 * 不能靠人记得同步。
 */
export const BADGE_TONE_WARN_AT = 30;
export const BADGE_TONE_DANGER_AT = 10;

/**
 * 健康度 → 角标色调。
 *
 * 存在的意义：角标原来只有一种样式，于是「健康度 5%」和「健康度 49%」长得一模一样 ——
 * 而余额角标唯一的用处就是「额度快没了」，传达不出紧急程度的角标等于没有信息量。
 */
export function healthBadgeTone(health: number): BadgeTone {
  if (health <= BADGE_TONE_DANGER_AT) return 'danger';
  if (health <= BADGE_TONE_WARN_AT) return 'warn';
  return 'info';
}

/* 趋势历史点的取舍结果 */
export type HistoryDecision = 'append' | 'reset' | 'skip';

/**
 * 决定新采样点怎么并入趋势序列。
 *
 * **为什么需要它**：趋势图画的是「主指标」，而主指标是 `pickPrimaryMetric`
 * 按优先级挑出来的 —— 它会随接口返回的字段而变。ChatGPT 这次返回
 * 「剩余额度 984.31」、下次可能不返回该项而落到「本时段已用 64」，
 * 于是同一条曲线里混进了**美元和百分比两种量纲**，按 min/max 归一化后
 * 会画出一个毫无意义的断崖。
 *
 * 所以每个点都要带上它属于哪个指标；指标一变就 `reset` 重开序列。
 * 注意顺序：**先判指标、再判去重** —— 量纲不同的两个 64 不是「重复」。
 *
 * `prev.label` 缺失（升级前存下的老点）也走 reset，等于一次性把脏序列清掉。
 */
export function decideHistory(
  prev: { t: number; v: number; label?: string } | null,
  v: number,
  label: string,
  nowSec: number,
  dedupeWindowSec: number,
): HistoryDecision {
  if (prev && prev.label !== label) return 'reset';
  if (prev && prev.v === v && nowSec - prev.t < dedupeWindowSec) return 'skip';
  return 'append';
}

/**
 * sparkline 的纵向映射：把数值映射到 SVG 的 y 坐标。
 *
 * **全等序列必须画在正中**。原来的写法是 `span = max - min || 1`，
 * 全等时所有点都落到 `height - pad`，也就是贴着图表**最底部** ——
 * 「值一直没变」看起来像「值处于最低点」。
 *
 * 而这不是理论情况：2026-09-18 读真机 localStorage，
 * `chatgpt` 的 10 个采样点**全是 984.31**（余额长期不变），
 * 于是趋势图就是一条贴着底边的线、面积填充退化为零，看着像坏了。
 *
 * 抽成纯函数是为了能测：几何算错在界面上不容易看出来。
 */
export function sparkY(v: number, min: number, max: number, height: number, pad: number): number {
  const span = max - min;
  /* 全等：画在正中，读作「没有变化」 */
  if (span === 0) return height / 2;
  return height - pad - ((v - min) / span) * (height - pad * 2);
}

/**
/* 色标：[健康度 0~1, 颜色]。位置必须递增，首尾必须是 0 和 1 */
type HealthRamp = Array<[number, string]>;

/**
 * 按主题挑好的色标。
 *
 * 深色主题没有对比度约束（亮色直接可用），色标全饱和 ——
 * 整条是干净的红 → 橙 → 黄 → 黄绿 → 绿。
 *
 * 浅色主题受「大号文字 ≥3:1」约束（首页 34px/700、面板 22px/600 都算大号字），
 * 黄区只能压暗 —— 而**暗黄就是金/橄榄**，这是色度学而不是实现问题：
 * 在 3:1 约束下，色相 40°~90°（黄区）能到的最大亮度只有 31%~40%，
 * 而 0°~30°（红橙）能到 46%~68%、100°~160°（绿）能到 33%~34%。
 *
 * 所以浅色主题的做法是**压缩黄区占的范围**：色标放在 0/20/40/60/100%，
 * 让「金 → 黄绿」的过渡只占 40%~60% 这一段，其余区段都是干净的红橙或绿。
 * 实测：全段对比度 ≥3.09:1、饱和度 ≥59%（0.8 处再补一个深绿色标，
 * 否则 60%~100% 这段会闷成灰绿）。
 */
const HEALTH_RAMP: Record<HealthColorMode, HealthRamp> = {
  dark: [
    [0.0, '#F87171'],
    [0.25, '#FB923C'],
    [0.5, '#FACC15'],
    [0.75, '#A3E635'],
    [1.0, '#34D399'],
  ],
  light: [
    [0.0, '#DC2626'],
    [0.2, '#EA580C'],
    [0.4, '#D97706'],
    [0.6, '#65A30D'],
    [0.8, '#16A34A'],
    [1.0, '#059669'],
  ],
};

function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * 健康度 → 颜色：100 绿 → 0 红，中间连续过渡。
 *
 * **为什么不再用 `hsl(色相, 固定 S/L)` 插值**（原来的写法，也正是「发棕」的根因）：
 * 色相从 120° 扫到 0° 必然经过 60° 的黄，而黄在同一亮度下天生更亮。
 * 固定亮度等于拿红绿的标准去要求黄，结果就是：
 *   hsl(60, 72%, 34%) = #959518  ← 橄榄/土黄，肉眼读成「棕」（浅色主题）
 *   hsl(60, 68%, 62%) = #E0E05C  ← 土黄（深色主题）
 * 改成按主题挑色标再线性插值，每个色标都是挑过的干净颜色，观感可控。
 *
 * `mode` 故意**不给默认值**：默认错了会让某一主题下的数字看不清，
 * 而这一点在代码里看不出来，所以强制每个调用点显式说明自己的底色。
 */
export function healthColor(health: number, mode: HealthColorMode): string {
  const p = Math.max(0, Math.min(100, health)) / 100;
  const ramp = HEALTH_RAMP[mode];
  let lo = ramp[0];
  let hi = ramp[ramp.length - 1];
  for (let i = 0; i < ramp.length - 1; i += 1) {
    if (p >= ramp[i][0] && p <= ramp[i + 1][0]) {
      lo = ramp[i];
      hi = ramp[i + 1];
      break;
    }
  }
  const span = hi[0] - lo[0];
  const k = span === 0 ? 0 : (p - lo[0]) / span;
  const a = hexToRgb(lo[1]);
  const b = hexToRgb(hi[1]);
  const r = Math.round(a[0] + (b[0] - a[0]) * k);
  const g = Math.round(a[1] + (b[1] - a[1]) * k);
  const bl = Math.round(a[2] + (b[2] - a[2]) * k);
  return `rgb(${r} ${g} ${bl})`;
}

/**
 * 把各平台余额打包成徽章可推送的摘要（≤95 字节）。
 *
 * 策略：先按「余额优先」排序各指标；再保证每个平台至少露出主指标（宽度优先），
 * 仍有余量才回填次要指标（深度优先）。超长时整块丢弃末尾平台/指标，
 * 绝不把数值截成一半。
 */
export function buildBadgeSummary(list: BadgeSummaryInput[]): string {
  return buildBadgeSummaryResult(list).text;
}

/** 摘要的打包结果：正文 + 实际进了摘要的平台名 */
export interface BadgeSummaryResult {
  /** 摘要正文（≤ BODY_MAX 字节） */
  text: string;
  /**
   * 实际进入摘要的平台名（按出现顺序）。
   *
   * 为什么要单独返回：超限时平台是**整块被丢弃**的，不是被截断 ——
   * 用户勾了 5 个平台、徽章上只看到 2 个，不告诉他这件事他只会以为程序有 bug。
   */
  included: string[];
}

/**
 * 打包摘要的完整版（同时给出「谁进了摘要」）。
 *
 * 与 buildBadgeSummary 走**同一段逻辑** —— 后者是本函数的一层包装，
 * 两处不会算出不同的结果。
 */
export function buildBadgeSummaryResult(list: BadgeSummaryInput[]): BadgeSummaryResult {
  const fmt = (it: BalanceItem) => `${shortLabel(it.label)}${it.value}`;

  const chunks = list
    .filter((b) => !b.error && b.items.length > 0)
    .map((b) => {
      const items = sortItems(b.items);
      return {
        name: b.name,
        head: fmt(items[0]),
        extras: items.slice(1).map(fmt),
      };
    });

  const pieces: string[] = [];
  let used = 0;
  /*
   * 分隔符的字节数**现算**，不要手写常量。
   *
   * 曾写成 3（以为 ' · ' 是 3 字节），而中间的 '·' 是 U+00B7，UTF-8 占 2 字节，
   * 加上两侧空格实际是 **4 字节**。于是每多一个平台就少算 1 字节：
   * 两个平台时预算算出来正好 95，真实字符串却是 96 —— 前端放行、后端拒绝，
   * 表现为「推送总是报正文过长」，而界面上看不出任何异常。
   *
   * 通用教训：**要按字节计预算的常量，一律用 byteLen() 现算**，别抄数字。
   */
  const sepBytes = byteLen(SUMMARY_SEP);

  /* 第一步：宽度优先——每个平台先只放「名称 + 主指标」 */
  const pendingExtras: string[][] = [];
  const keptNames: string[] = [];
  for (const c of chunks) {
    const text = `${c.name} ${c.head}`;
    const add = (pieces.length ? sepBytes : 0) + byteLen(text);
    if (used + add > BODY_MAX) break;
    used += add;
    pieces.push(text);
    keptNames.push(c.name);
    pendingExtras.push(c.extras);
  }

  /*
   * 一个平台都放不下 → 兜底：只保留**主指标**，必要时截短平台名。
   *
   * ⚠️ 截断的必须是**名字**而不是指标：把「$984.31」截成「$984.3」得到的是
   * 另一个数字（错的），而名字截短只是「认不全是哪个平台」（信息少了点，但没错）。
   */
  if (pieces.length === 0) {
    if (chunks.length === 0) return { text: '', included: [] };
    const { name, head } = chunks[0];
    /* 指标本身就要一个字节都超 —— 那就没有任何东西可推了 */
    if (byteLen(head) > BODY_MAX) {
      return { text: truncateBytes(head, BODY_MAX), included: [name] };
    }
    /* 名字 + 指标放不下 → 砍名字，砍到刚好装下为止 */
    const room = BODY_MAX - byteLen(head) - 1; // 留一个空格
    return {
      text: room <= 0 ? head : `${truncateBytes(name, room)} ${head}`,
      included: [name],
    };
  }

  /* 第二步：深度优先——还有余量就把次要指标回填到各平台末尾 */
  for (let i = 0; i < pendingExtras.length; i++) {
    for (const e of pendingExtras[i]) {
      /* 平台内部的次要指标用空格分隔（1 字节），与平台之间的 ' · ' 不同 */
      const merged = `${pieces[i]} ${e}`;
      const delta = byteLen(merged) - byteLen(pieces[i]);
      if (used + delta > BODY_MAX) break;
      used += delta;
      pieces[i] = merged;
    }
  }

  /*
   * 最后一道保险：**按真实字节数复核**，超了就整块丢掉末尾的平台。
   *
   * 上面的预算计算已经是对的，但它是「增量累加」，一旦有人改了分隔符或
   * 拼接方式（就像 SEP 那个 bug），偏差就会一路累积到底。
   * 这里按最终字符串的真实长度复核 —— 超了就**整块丢弃**而不是截断字符，
   * 因为截断会把一个数值拦腰砍断（「984.31」变成「984.3」是错的数字，
   * 而徽章上少一个平台只是少一条信息）。
   *
   * 为什么要这么较真：正文超限不是「显示不全」，而是**整条推送被后端拒绝** ——
   * 一次超长会让这次推送的所有内容都推不出去。
   */
  while (pieces.length > 0 && byteLen(pieces.join(SUMMARY_SEP)) > BODY_MAX) {
    pieces.pop();
    /* 名字要跟着一起丢，否则 UI 会告诉用户「X 已经推上去了」而实际没推 */
    keptNames.pop();
  }
  return { text: pieces.join(SUMMARY_SEP), included: keptNames };
}

/**
 * 本地时刻文本：当天 `HH:mm`，跨天 `MM-DD HH:mm`；无效时间返回 null。
 *
 * 为什么跨天也要带时分：额度重置 / 数据刷新这类时刻，用户要判断的是
 * 「还有多久」和「几点回来」。只给日期会把「今天 16:42」和「明天 00:42」
 * 压成同一个 `11-10`，等于没说。用**本地时区**，与后端 chatgpt.rs
 * 生成 sub 文案时的口径一致。
 *
 * `now` 可注入以便单测固定「今天」；省略时取当前时刻。
 */
export function clockAt(secs: number, now: number = Date.now() / 1000): string | null {
  const t = new Date(Math.floor(secs) * 1000);
  if (Number.isNaN(t.getTime())) return null;
  const n = new Date(Math.floor(now) * 1000);
  const pad = (v: number) => String(v).padStart(2, '0');
  const clock = `${pad(t.getHours())}:${pad(t.getMinutes())}`;
  const sameDay =
    t.getFullYear() === n.getFullYear() &&
    t.getMonth() === n.getMonth() &&
    t.getDate() === n.getDate();
  return sameDay ? clock : `${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${clock}`;
}

/** 相对时间短语：`刚刚` / `30 秒前` / `3 分钟前` …；secs 为 0 时返回空串 */
export function relativePhrase(secs: number): string {
  if (!secs) return '';
  const diff = Math.floor(Date.now() / 1000) - secs;
  /* 时钟回拨、或后端给的时间略超前时 diff 会是负数，一律显示「刚刚」 */
  if (diff < 10) return '刚刚';
  if (diff < 60) return `${diff} 秒前`;
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  return `${Math.floor(diff / 86400)} 天前`;
}

/**
 * 「刷新于 …」：**绝对时刻 + 相对时长**（`16:42 刷新 · 3 分钟前`）。
 *
 * 只给「3 分钟前」看不出数据到底是几点拉的；只给时刻又要用户自己算新旧。
 * 两者一起给，才既能定位（几点几分）又能判断数据还新不新。
 */
export function formatRefreshedAt(secs: number): string {
  const p = relativePhrase(secs);
  if (!p) return '';
  const clock = clockAt(secs);
  return clock ? `${clock} 刷新 · ${p}` : `${p}刷新`;
}

/**
 * 倒计时短语（用于「约 N 分钟后自动刷新」）。
 *
 * 刻意**只精确到分钟**：界面上写「约 12 分钟后」就够了，
 * 秒级倒计时反而会让人盯着数字看。不足 1 分钟时给一个下限文案，
 * 免得出现「约 0 分钟后」这种读起来像坏了的说法。
 */
export function formatCountdown(secs: number): string {
  if (secs <= 0) return '不到 1 分钟';
  if (secs < 60) return '不到 1 分钟';
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} 小时 ${rest} 分` : `${h} 小时`;
}

/** 相对时间描述（用于「上次推送到徽章 …」） */
export function formatPushedAt(secs: number): string {
  const p = relativePhrase(secs);
  return p ? `上次推送：${p}` : '';
}


/* =============================================
   ====== 趋势粒度：按次 / 按小时 / 按天 ======
   ============================================= */

/* 趋势的聚合粒度 */
export type TrendGranularity = 'raw' | 'hour' | 'day';

/* 首页分段控件的选项（顺序即展示顺序） */
export const TREND_GRANULARITY_OPTIONS: Array<{ value: TrendGranularity; label: string }> = [
  { value: 'raw', label: '按次' },
  { value: 'hour', label: '按小时' },
  { value: 'day', label: '按天' },
];

/*
 * 结构类型，**故意不 import snapshot 的 HistoryPoint**：
 * snapshot.ts 依赖本文件（用 decideHistory），反向 import 会成环。
 * 结构相同即可，调用方传 HistoryPoint[] 一样能通过类型检查。
 */
export interface TrendPoint {
  t: number;
  v: number;
  label?: string;
}

/* 24 小时内保留每一次采样 */
export const RAW_WINDOW_SEC = 24 * 3600;
/* 7 天内每小时留一条 */
export const HOUR_WINDOW_SEC = 7 * 24 * 3600;
/* 趋势序列的硬上限（超出后从最旧开始丢） */
export const TREND_MAX = 600;

/*
 * 本地时区的时间桶键。
 *
 * 必须用本地分量而不是 `Math.floor(t / 3600)`：按天切分时用 UTC 会让
 * UTC+8 的用户看到「凌晨 8 点换天」。按小时同理（整点时区恰好不出错，
 * 半小时时区就会错位），所以统一走 Date 的本地取值。
 */
function bucketKey(t: number, granularity: TrendGranularity): string {
  const d = new Date(t * 1000);
  const base = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  return granularity === 'day' ? base : `${base}-${d.getHours()}`;
}

/**
 * 按粒度聚合：同一桶里**保留最后一个采样**。
 *
 * 为什么取「最后一个」而不是平均或极值：
 *   - 取平均会让曲线与实际余额对不上（图上 984 而实际是 1000，没法解释）；
 *   - 取极值要先区分「已用」和「剩余」两种方向，等于把方向逻辑渗透进图表；
 *   - 「每小时 / 每天的最后一个采样」最好解释，也最接近用户的直觉。
 *
 * 前提：`points` 按时间升序（写入时即有序），所以同桶直接覆盖即可。
 */
export function bucketHistory<T extends TrendPoint>(
  points: T[],
  granularity: TrendGranularity,
): T[] {
  if (granularity === 'raw') return points;
  const out: T[] = [];
  let lastKey: string | null = null;
  for (const p of points) {
    const key = bucketKey(p.t, granularity);
    if (key === lastKey && out.length > 0) {
      /* 同桶：用更新的采样覆盖，等价于「取桶内最后一条」 */
      out[out.length - 1] = p;
    } else {
      out.push(p);
      lastKey = key;
    }
  }
  return out;
}

/**
 * 分层降采样：越久远的点留得越稀。
 *
 * 为什么必须有它：「按天查看」至少要有几周数据，而 15 分钟自动刷新下
 * 一天就是 96 条 —— 直接提高上限会让 localStorage 迅速膨胀，图表也画不下。
 * 所以按「24 小时内留全部 / 7 天内每小时一条 / 更早每天一条」降采样，
 * **一份数据同时服务三种粒度**，不用为每种粒度各存一份。
 *
 * `points` 必须按时间升序；同桶内保留最后一条（与 bucketHistory 口径一致）。
 */
export function pruneHistory<T extends TrendPoint>(points: T[], nowSec: number): T[] {
  const out: T[] = [];
  let lastHourKey: string | null = null;
  let lastDayKey: string | null = null;

  for (const p of points) {
    const age = nowSec - p.t;
    const hourKey = bucketKey(p.t, 'hour');
    const dayKey = bucketKey(p.t, 'day');

    if (age <= RAW_WINDOW_SEC) {
      out.push(p);
    } else if (age <= HOUR_WINDOW_SEC) {
      if (hourKey === lastHourKey && out.length > 0) out[out.length - 1] = p;
      else out.push(p);
    } else {
      if (dayKey === lastDayKey && out.length > 0) out[out.length - 1] = p;
      else out.push(p);
    }

    lastHourKey = hourKey;
    lastDayKey = dayKey;
  }

  return out.length > TREND_MAX ? out.slice(-TREND_MAX) : out;
}

/** 从 "984.31" / "$12.50" / "120 次" / "246~1280" / "29%" 里取出第一个数字 */
export function parseNumeric(value: string): number | null {
  const m = value.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/**
 * 值是不是「日期 / 时间」这类**不是量**的东西（`额度到期 2026-10-01`、`2026年10月1日`）。
 *
 * ⚠️ 必须有这个判断，不能只看「能不能解析出数字」：`parseNumeric('2026-10-01')`
 * 会返回 **2026**，于是「额度到期」会被当成余额染成数量色。
 */
export function looksLikeDate(value: string): boolean {
  return /\d{4}\s*[-/年]\s*\d{1,2}(?:\s*[-/月]\s*\d{1,2}\s*日?)?/.test(value.trim());
}

/** 指标数值的颜色分类。界面按这个分类取色（见 BalancesView 的 renderBalance） */
export type MetricValueKind = 'health' | 'amount' | 'plain';

/**
 * 某条指标「该用哪一类颜色」—— 归一到统一的健康度再判。
 *
 * 优先级：
 *   1. 有 `usedPercent`（后端给的「已用百分比」，上限已知时）→ 走健康度色
 *   2. value 本身就是百分比 → 走健康度色（健康度轴由 `healthPercentOf` 归一）
 *   3. 是日期 → 不染色
 *   4. 其它数字（余额 / credits / 次数）→ 中性信息色
 *
 * ⚠️ `usedPercent` 这条让「降级成绝对值展示、但上限已知」的指标也能染色 ——
 * 否则「个人额度已用 3000 credits」会被当成普通数量染成中性蓝，「用完」这件事
 * 在界面上没有任何信号。健康度方向固定为「已用」（= 100 − usedPercent），
 * 不靠 label 关键词猜。
 */
export function itemHealth(item: BalanceItem): number | null {
  if (item.usedPercent !== null && item.usedPercent !== undefined && Number.isFinite(item.usedPercent)) {
    return Math.max(0, Math.min(100, 100 - item.usedPercent));
  }
  return healthPercentOf(item.label, item.value);
}

export function metricValueKind(item: BalanceItem): MetricValueKind {
  if (itemHealth(item) !== null) return 'health';
  if (looksLikeDate(item.value)) return 'plain';
  return parseNumeric(item.value) === null ? 'plain' : 'amount';
}

/**
 * 额度用满时要额外显示的那句「什么时候回来」。
 *
 * 直接取该项的 `sub` —— 后端把它填成「重置 10月27日 08:00」，
 * 本时段还会带上「已达上限」（见 chatgpt.rs）。
 *
 * 返回 null 的三种情况（都不显示任何东西）：
 *   · 不是「已用 / 用量」类指标 —— 剩余额度的 sub 是「credits」，不是重置时间；
 *   · 没用满（健康度 > 0）；
 *   · 用满了、但后端没给重置时间（`reset_at` 缺失）。
 *
 * 放在纯逻辑里而不是组件里，是因为这三条判据都容易写反，
 * 而「写反了」的表现只是界面上少一行或多一行，肉眼根本发现不了。
 */
export function exhaustedNote(item: BalanceItem | null | undefined): string | null {
  if (!item) return null;
  if (!isUsageLabel(item.label)) return null;
  const h = itemHealth(item);
  if (h === null || h > 0) return null;
  const sub = (item.sub ?? '').trim();
  return sub || null;
}

/**
 * 选出趋势要记录的指标。
 *
 * `preferred` 是用户在首页显式选的指标名（null = 自动）。
 *
 * 自动时**优先挑百分比指标**，而不是直接沿用主指标。原因（2026-09-18 真机踩到）：
 * 主指标按 `itemPriority` 选，绝对量优先，而绝对量常常是**恒定值** ——
 * ChatGPT 的「剩余额度 984.31」（credits）在连续 18 次刷新里一次都没变过，
 * 于是趋势图永远是一条直线，看起来像画坏了。
 * 百分比指标（本时段 / 本周已用）才真正随时间变化。
 * 一个百分比都没有时才回落到主指标。
 */
export function pickTrendMetric(
  items: BalanceItem[],
  preferred: string | null,
  fallbackPrimary: BalanceItem | null,
): BalanceItem | null {
  if (preferred) {
    const hit = items.find((it) => it.label === preferred);
    if (hit) return hit;
  }
  const pct = items
    .filter((it) => it.value.includes('%') && parseNumeric(it.value) !== null)
    .sort((a, b) => itemPriority(a.label) - itemPriority(b.label));
  return pct[0] ?? fallbackPrimary;
}
