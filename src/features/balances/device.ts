/*
 * 智能体余额 → AI-Passport 徽章「余额页」的数据编码
 * ------------------------------------------------------------------
 * 工作台首页的余额卡片与设备上的余额页画的是同一份东西的主干部分
 * （主指标 / 环形进度），但设备只有 240x320 的屏、没有网络、也不该去解析 JSON。
 * 所以这里把首页那份数据**压成一行短文本**，经 BLE 推给固件，
 * 由固件侧的 balance_store 解析（协议见 ai-passport/main/balance_store.h）：
 *
 *   BAL|平台|刷新时刻|主指标标签~主指标值~健康度|环标签~百分比~健康度~重置时刻|...
 *
 * 「重置时刻」是环的**第 4 个子字段**（Unix 秒，空 = 不知道）。它回答的是
 * 「这个窗口的额度什么时候回来」，与行首那个「刷新时刻」（这份数据多旧）是两件事。
 * 同样推**绝对时刻**而不是「2 小时后」：短语写进设备就冻住了，断连后永远停在错的时刻上。
 *
 * ⚠️ 这一位对**旧固件**是有代价的：老版本按 3 段解析环，第 4 段会被并进第 3 段，
 * 于是健康度解析失败、环退回品牌色（弧长照旧）。也就是说「工作台先升级、固件后刷」
 * 的那段时间里，颜色会暂时不对 —— 可接受，但别把它当成新 bug 去查。
 * 反方向（旧工作台 + 新固件）没影响：新固件缺第 4 段时按「不知道」处理。
 *
 * 注意：**没有「当前时间」这个字段，也不该加**。设备自己有 NTP，余额页顶部那个
 * 时钟是设备本地算的；从这边推过去只会在链路断开时停在一个过时的时刻上。
 * 这一行里的「刷新时刻」回答的是另一个问题 —— 这份数据有多旧。
 *
 * ⚠️ 第三段推的是**绝对时刻（Unix 秒）**，不是「3 分钟前刷新」这种短语。
 *
 * 短语是**推送那一刻**算好的，写进设备后就再也不变了 —— 于是「3 分钟前」会一直
 * 说「3 分钟前」，直到下一次推送把它覆盖。而推送是有条件的（数据没变就不推、
 * 断连时推不了），所以这句话会在断连、或长时间没变化时**永久停在错误的时刻**上。
 * 时间戳没有这个毛病：设备自己有 NTP，算「几分钟前」是它自己的事，
 * 断连期间那句「N 分钟前」还会继续往上走 —— 那正是它该有的行为。
 * 顺带还解决了一个去重问题：时间戳每轮都变，去重键不会因为「短语没变」
 * 而把一次本该发生的推送吞掉（见 deviceLinesKey 的说明）。
 *
 * 兼容：固件按「纯数字且像 Unix 秒」识别时间戳，识别不出来就原样显示 ——
 * 所以旧版工作台推来的短语，在新固件上照旧能看。
 *
 * 三条设计约束，全部来自设备的物理条件：
 *
 * 1. **每行 ≤ 159 字节**（固件整行缓冲上限，含结尾 '\0' 是 160）。
 *    超长时固件**整行丢弃且没有任何报错** —— 用户只会看到「设备上什么都没变」。
 *    所以这里对每一行都做字节预算，超了就降级（丢最不关键的环形指标），
 *    **绝不按字节硬截断**：截一半会切出半条字段，固件解析出的是一堆垃圾，
 *    比丢一个环形指标糟得多。
 *
 * 2. **文本按「屏幕上能显示几个字」截断**，而不是按协议上限。
 *    环形标签的宽度只有 106px，塞 7 个以上汉字只会被 LVGL 打成省略号。
 *    在这里截干净，设备上看到的就是完整的一句话。
 *
 * 3. **不推趋势**。设备屏上不画 sparkline（240px 宽的屏放不下一条有信息量的
 *    曲线，却要占掉近 1/3 纵向空间），所以这里也不再生成 BALT 行。
 *    固件仍然「认领」BALT 只是为了让没重启的旧版工作台不污染通知列表。
 *
 * 本文件是纯逻辑（不碰 IPC、不碰 store），可以在 node 里单独跑测试。
 * @Author: fu
 */
import { byteLen, healthPercentOf, percentOf, truncateBytes } from './format';
import { pickPrimaryMetric } from './snapshot';
import type { BalanceSnapshot } from './snapshot';
import type { BalanceItem } from './types';

/* =============================================
   ====== 与固件对齐的硬上限 ======
   ============================================= */

/** 整行上限（固件 BAL_LINE_MAX - 1）。超了固件整行丢弃，所以必须自己先挡住 */
export const DEVICE_LINE_MAX = 159;
/** 环形指标个数（固件 BAL_RING_MAX） */
export const DEVICE_RING_MAX = 2;

/*
 * 文本字段的**显示宽度**上限（UTF-8 字节）。
 * 不是协议上限（固件那边是 27 字节）—— 按显示宽度截断，设备上才是完整的一句话。
 *
 * ⚠️ 设备端一改字号/布局，这里每个数字都要跟着复核。当前设备侧（见
 * ai-passport/main/demo_clock.c 的 BAL_* 常量）：
 *   平台名   14 号字、132px 宽、顶行靠左（右侧 76px 留给「当前时间」）
 *   刷新时刻 14 号字、216px 宽、独立一行居中（**但推的是数字，不受宽度约束**）
 *   环形标签 14 号字、106px 宽、环下居中
 */
export const DEVICE_PROVIDER_MAX = 21;  // 平台名:14 号字下 ≈ 9 个汉字 / 18 个 ASCII 字母
/*
 * 刷新时刻：**不再是给人看的文本**，而是 Unix 秒（到 2286 年都只有 11 位）。
 * 所以这里已经不是「显示宽度」约束，而是一道协议层防呆 —— 免得将来谁把
 * 别的东西塞进这个字段、把整行撑爆（超长固件整行丢弃且不报错）。
 *
 * ⚠️ 从 24 收到 12 是为了**给环的第 4 段（重置时刻）腾字节**：两个环各多 11 字节，
 * 最坏情况会顶到 163 > 159。12 位仍然比真实值（10 位，2286 年前 11 位）宽一位。
 */
export const DEVICE_REFRESHED_MAX = 12;
export const DEVICE_LABEL_MAX = 18;     // 指标标签:环下 106px ≈ 6 个汉字(两个环并排,留点余量)
export const DEVICE_VALUE_MAX = 16;     // 主指标值:设备按内容宽度在 48/28 号之间自选字号

/* =============================================
   ====== 文本清洗 ======
   ============================================= */

/**
 * 清洗一个要放进协议行的文本字段。
 *
 * `|` 是字段分隔、`~` 是子字段分隔、换行是行边界 —— 它们出现在内容里会把整行
 * 拆错位（固件解析出一堆垃圾，而且不会有任何报错）。统一替换成 `/`：
 * 保留「这里原本有个符号」的信息，又不会破坏结构。
 */
export function sanitizeField(s: string, maxBytes: number): string {
  const cleaned = s
    .replace(/[|\r\n\t~]/g, '/')
    .replace(/\s+/g, ' ')
    .trim();
  return truncateBytes(cleaned, maxBytes);
}

/* =============================================
   ====== 输入 ======
   ============================================= */

export interface DeviceChartInput {
  /** 首页固定展示的那个平台的快照（与首页图表同源） */
  snapshot: BalanceSnapshot;
}

/* =============================================
   ====== 头部行 BAL ======
   ============================================= */

interface RingOut {
  label: string;
  pct: number;
  health: number;
  /** 该窗口的重置时刻（Unix 秒）；null = 不知道（第 4 段留空，设备隐藏那行） */
  resetAt: number | null;
}

/*
 * **固定成环的两个窗口**（顺序即屏上从左到右的顺序）。
 *
 * 为什么不按健康度排序了：这块屏的环不是「随便两个最紧张的百分比」，而是
 * ChatGPT 那两个固定窗口 —— 用户看的是「本时段还剩多少 / 本周还剩多少」。
 * 按健康度取前二时，一旦「剩余额度」消失（credits 用光，`has_credits=false`），
 * 主指标会从「剩余额度」降级成「本时段已用」，而主指标又不参与环形候选，
 * 于是两个窗口只剩一个环（2026-10-30 实际发生）。
 *
 * 代价：主指标本身是百分比时，同一个数字会在大数值和环里各出现一次。
 * 这是**故意**的 —— 宁可重复，也不要让屏幕上的环数随数据变化。
 *
 * ⚠️ 这两个标签是 chatgpt.rs 里的字面量，改那边要同步改这里（logic-test 有断言盯着）。
 */
const WINDOW_RING_LABELS = ['本时段已用', '本周已用'] as const;

/** 把一个指标编成环；不是百分比、或数值不可解析时返回 null（不画环） */
function ringOf(it: BalanceItem): RingOut | null {
  const pct = percentOf(it.value);
  if (pct === null) return null;                       // 非百分比 → 不画环
  const health = healthPercentOf(it.label, it.value) ?? pct;
  const reset = typeof it.resetAt === 'number' && it.resetAt > 0 ? Math.floor(it.resetAt) : null;
  return {
    label: sanitizeField(it.label, DEVICE_LABEL_MAX),
    pct: Math.round(pct),
    health: Math.round(health),
    resetAt: reset,
  };
}

/**
 * 挑出要画成环形的指标（最多 DEVICE_RING_MAX 个）。
 *
 * ① 先取固定的两个窗口，**不看它是不是主指标**（理由见 WINDOW_RING_LABELS）；
 * ② 不足两个时，才用其它百分比指标按健康度升序补位 —— 补位这一档**避开主指标**，
 *    免得为了凑数把同一个数字再画一遍。固定的那两个窗口是屏幕的主干，重复也认；
 *    补位的只是凑数，没必要重复。
 */
function pickRings(items: BalanceItem[], primary: BalanceItem | null): RingOut[] {
  const out: RingOut[] = [];
  const taken = new Set<BalanceItem>();

  for (const label of WINDOW_RING_LABELS) {
    if (out.length >= DEVICE_RING_MAX) break;
    const it = items.find((x) => x.label === label && !taken.has(x));
    if (!it) continue;
    const r = ringOf(it);
    if (!r) continue;
    taken.add(it);
    out.push(r);
  }

  if (out.length < DEVICE_RING_MAX) {
    const rest = items
      .filter((it) => !taken.has(it) && it !== primary)
      .map(ringOf)
      .filter((r): r is RingOut => r !== null)
      .sort((a, b) => a.health - b.health);
    out.push(...rest.slice(0, DEVICE_RING_MAX - out.length));
  }

  return out.slice(0, DEVICE_RING_MAX);
}

function assembleHead(
  provider: string,
  refreshedField: string,
  primaryField: string,
  rings: RingOut[],
): string {
  const fields = ['BAL', provider, refreshedField, primaryField];
  /* 第 4 段空着也要占位：`filter` 掉空值会让后面的字段整体错位（固件不报错） */
  for (const r of rings) fields.push(`${r.label}~${r.pct}~${r.health}~${r.resetAt === null ? '' : String(r.resetAt)}`);
  return fields.join('|');
}

/* =============================================
   ====== 对外入口 ======
   ============================================= */

/**
 * 把首页那份余额数据编成设备可解析的行。
 *
 * 返回的是**数组**（虽然目前只有一行）—— 推送通道 `pushLines()` 的契约是按行发，
 * 将来若要加别的行（例如第二页指标）不用改签名。
 *
 * 没有可用数据时返回空数组（调用方据此提示「暂无可推送的余额数据」）。
 */
export function buildDeviceLines(input: DeviceChartInput): string[] {
  const { snapshot } = input;
  const items = snapshot.items;
  if (items.length === 0) return [];

  const primary = pickPrimaryMetric(items);

  const provider = sanitizeField(snapshot.name || snapshot.provider, DEVICE_PROVIDER_MAX);
  /*
   * 绝对时刻，不是短语（理由见文件头）。
   *
   * 取不到时间（0）就留**空字段** —— 固件那边「空」等于「不知道」，
   * 它会隐藏这一行；比编一个假的「刚刚刷新」诚实。
   */
  const refreshedField = sanitizeField(
    snapshot.refreshedAt > 0 ? String(Math.floor(snapshot.refreshedAt)) : '',
    DEVICE_REFRESHED_MAX,
  );

  const primaryLabel = primary ? sanitizeField(primary.label, DEVICE_LABEL_MAX) : '';
  const primaryValue = primary ? sanitizeField(primary.value, DEVICE_VALUE_MAX) : '';
  const primaryHealth = primary ? healthPercentOf(primary.label, primary.value) : null;
  const primaryField = [
    primaryLabel,
    primaryValue,
    primaryHealth === null ? '' : String(Math.round(primaryHealth)),
  ].join('~');

  /*
   * 环形指标按「能放下几个就放几个」逐个试加。
   *
   * 说明：按上面这几个字段上限算，最坏情况整行是 154 字节（< 159），所以这个
   * break 在目前的上限下**不会触发**。它是一道防呆 —— 将来谁放宽了某个上限
   * （比如把标签从 6 个汉字改到 10 个），这里会先丢掉最不关键的那个环，
   * 而不是让整行超长、被固件静默丢弃。
   *
   * ⚠️ 加了环的第 4 段（重置时刻）之后这个余量只剩 5 字节。再往环里加东西之前
   * 先重算一遍：两个环各 +11 就会顶到 176，那时 DEVICE_REFRESHED_MAX 或
   * DEVICE_LABEL_MAX 必须先让位。
   */
  const candidates = pickRings(items, primary);
  const rings: RingOut[] = [];
  for (const c of candidates) {
    if (byteLen(assembleHead(provider, refreshedField, primaryField, [...rings, c])) > DEVICE_LINE_MAX) break;
    rings.push(c);
  }

  return [assembleHead(provider, refreshedField, primaryField, rings)];
}

/**
 * 图表推送的去重键（内容相同就不重复往设备写）。
 *
 * 注意这一行里带着**刷新时刻**，所以「只刷新了、数值没变」也会算作内容变化 ——
 * 这是**故意的**：设备上那句「N 分钟前刷新」是靠这个时刻算出来的，
 * 不重推的话它会一直从上一轮开始数，越数越离谱。
 */
export function deviceLinesKey(lines: string[]): string {
  return lines.join('\u0001');
}
