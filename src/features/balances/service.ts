/*
 * 智能体余额模块 · 常驻服务
 * ------------------------------------------------------------------
 * 为什么要有这个文件？
 *   「连上蓝牙时自动推送」是一个**副作用**，它不该依赖某个 React 组件是否被挂载。
 *   之前它写在 BalancesView 的 effect 里 —— 只有用户点进过「智能体余额」、
 *   组件挂载之后才会去订阅 aipassport:state。结果是「本次会话从没打开过这个模块，
 *   徽章连上就一点反应都没有」。
 *
 *   现在改成模块级服务：模块入口（index.tsx）在 import 时就把它启动起来。
 *   而 index.tsx 被 core/modules.ts 静态引用，所以应用一启动服务就在跑，
 *   与界面是否打开无关。（组件级的 keepAlive 解决的是「切走后不卸载」，
 *   解决不了「从没打开过」——这两件事得分开处理。）
 *
 * 数据来源（按优先级）：
 *   1. 内存里的实时余额（本会话刷新过）
 *   2. localStorage 快照（可能是上次会话留下的）
 *   所以冷启动、甚至从没打开过面板，徽章一连上也能立刻看到数据；
 *   随后再后台刷新一次，数据变了会自动补推。
 *
 * 去重：同一份摘要只推一次，避免每次状态变化都往设备写一遍。
 * 口径：只统计「显示中」的平台，与面板和摘要完全一致（见 prefs.ts）。
 * @Author: fu
 */
import { create } from 'zustand';
import * as bridge from './bridge';
import { listen } from '@tauri-apps/api/event';
import { ALERT_THRESHOLDS, alertBody, evaluateAlerts, unmarkAlert } from './alerts';
import { buildDeviceLines, deviceLinesKey } from './device';
import {
  buildBadgeSummary,
  buildBadgeSummaryResult,
  healthBadgeText,
  healthBadgeTone,
  worstHealth,
} from './format';
import { buildTrayItems } from './tray';
import type { TraySource } from './tray';
import { trayIconBitmap, trayInkPx } from './icons';
import { refresh as ipcRefresh, refreshOne as ipcRefreshOne, setRefreshPlan as ipcSetRefreshPlan, reschedule as ipcReschedule } from './ipc';
import { useBalancesPrefs } from './prefs';
import { useBalancesSnapshot } from './snapshot';
import { useBalancesStore } from './store';
import { syncTrayItems } from '@/core/tray';
import type { TrayItemPayload } from '@/core/tray';
import { useWorkbenchStore } from '@/store/useWorkbenchStore';
import type { BadgeSummaryInput, BadgeSummaryResult } from './format';
import type { ModuleBadge } from '@/core/types';
import type { AgentBalance } from './types';

/** 数据超过这个时间就认为「陈旧」，徽章连上时顺手在后台刷一次 */
const STALE_SEC = 300;
/** 两次后台刷新之间的最小间隔，防止蓝牙反复重连时打网络 */
const REFRESH_MIN_GAP_SEC = 60;

/* =============================================
   ====== 运行时状态（供面板显示） ======
   ============================================= */
interface RuntimeState {
  /** 徽章是否已连接（服务级，面板只读，不再自己订阅一遍） */
  bleConnected: boolean;
  /** 最近一次成功推送到徽章的时间（Unix 秒）；0 = 本次会话还没推过 */
  lastPushedAt: number;
  /** 是否有推送正在进行 */
  pushing: boolean;
  /**
   * 下一次自动刷新的时间（Unix 秒）；0 = 自动刷新已关闭。
   * 界面把它显示成倒计时 —— 定时器是分钟级的、而且发生在后台，
   * 不给个可见的倒计时，用户没法确认它到底有没有在跑。
   * 单平台独立刷新后，这里取**所有平台里最近的那一次**作为总览倒计时。
   */
  nextRefreshAt: number;
  /**
   * 每个平台下一次自动刷新的时间（Unix 秒）；键缺失 = 该平台当前没有定时刷新。
   * 由单平台调度器维护，界面可据此在每张卡片上显示「下次自动刷新约 X 分钟」。
   */
  providerNextRefresh: Record<string, number>;
}

export const useBalancesRuntime = create<RuntimeState>(() => ({
  bleConnected: false,
  lastPushedAt: 0,
  pushing: false,
  nextRefreshAt: 0,
  providerNextRefresh: {},
}));

/* =============================================
   ====== 摘要口径 ======
   ============================================= */

/** 只保留「显示中」的平台，与面板口径一致（visibleProviders 为 null 表示全部） */
function onlyVisible<T extends { provider: string }>(list: T[]): T[] {
  const v = useBalancesPrefs.getState().visibleProviders;
  return v === null ? list : list.filter((b) => v.includes(b.provider));
}

/** 摘要的数据源条目：既要能打包，也要能按 provider 过滤 */
export type SummarySource = BadgeSummaryInput & { provider: string };

/**
 * 摘要的数据源：**按平台逐个合并**，优先用实时数据，其次用 localStorage 快照。
 *
 * 为什么要逐个回落而不是「整体二选一」：
 *   - 本次会话还没打开过面板时，内存里什么都没有，只能用快照（否则永远推不出东西）；
 *   - 打开了面板但某个平台这次刷新失败（网络抖动、凭证未解锁）时，
 *     整体二选一会把那个平台整个丢掉，徽章上它的数值就「凭空消失」了 —— 不如沿用上次的值。
 */
function badgeSource(): SummarySource[] {
  const live = useBalancesStore.getState().balances;
  const out: SummarySource[] = [];
  const seen = new Set<string>();

  for (const b of live) {
    if (b.error || b.items.length === 0) continue;
    out.push(b);
    seen.add(b.provider);
  }
  for (const s of Object.values(useBalancesSnapshot.getState().snapshots)) {
    if (!seen.has(s.provider)) out.push(s);
  }
  return out;
}

/**
 * 全部可用的余额数据源（**不按面板显隐过滤**）。
 *
 * 存在的理由：设置页的推送勾选列表要标出「哪些平台有数据」，
 * 而推送与面板显隐是解耦的 —— 一个在面板上隐藏、但确实有数据的平台
 * 依然可以被勾选推送。所以这里不能复用 onlyVisible 的口径。
 */
export function currentBadgeSources(): SummarySource[] {
  return badgeSource();
}

/**
 * 推送到徽章的**余额摘要**里包含哪些平台。
 *
 * 两层过滤：
 *   ① `ids` 为 null 时 = 跟随「显示中的平台」（onlyVisible + badgeSource，与角标同口径）；
 *   ② `ids` 非 null 时 = **精确指定这几个平台**，不受面板显隐影响。
 *
 * ⚠️ 第 ② 条是刻意的：把「推什么」与「显示什么」解耦，正是这个设置存在的意义。
 * 若仍要求「推送 ⊆ 面板显示中」，用户想只推 ChatGPT 就得先把面板上其它平台全取消勾选 ——
 * 那等于没给选择，只是把耦合换了个地方。
 *
 * **为什么要参数化并导出**：设置页的实时预览与实际推送**必须走同一个函数**。
 * 预览自己再实现一遍过滤的话，一旦两边逻辑有细微差别，用户看到的预览就
 * 和真正推到徽章上的东西不一致 —— 而这类不一致极难发现。
 *
 * `ids` 传 `[]`（空数组）与 `null` 语义不同：`[]` = 一个都不推，
 * `null` = 跟随「显示中的平台」。见 prefs.setPushProviders 的说明。
 */
export function currentPushSources(ids: string[] | null): SummarySource[] {
  const src = badgeSource();
  if (ids === null) return onlyVisible(src);
  return src.filter((b) => ids.includes(b.provider));
}

/** 当前应推送到徽章的摘要；空字符串 = 没有可推的数据 */
export function currentBadgeSummary(): string {
  return buildBadgeSummary(currentPushSources(useBalancesPrefs.getState().pushProviders));
}

/**
 * 按指定平台集合算出摘要（**设置页预览与真实推送共用**）。
 *
 * 为什么要单独一个函数：预览必须与实际推送**逐字一致**。
 * 预览自己拼一遍字符串的话，两边一旦有细微差别（标签、排序、字节预算），
 * 用户看到的预览就和徽章上真实显示的不一样 —— 而这类不一致极难发现，
 * 用户只会觉得「这个预览是骗人的」。
 *
 * 返回的是完整结果（正文 + 谁进了摘要），而不只是字符串：
 * 设置页要能说出「你勾了 5 个，其中 3 个因为放不下被略过了」——
 * 光有正文的话只能靠 `text.includes(name)` 猜，而那是子串匹配，
 * 平台名互相包含时会误判。
 */
export function pushSummaryFor(ids: string[] | null): BadgeSummaryResult {
  return buildBadgeSummaryResult(currentPushSources(ids));
}

/* =============================================
   ====== 图表数据（徽章上的余额图表页） ======
   ============================================= */

/**
 * 当前应推给设备的余额图表行（只有一行 BAL），空数组 = 没有可推的数据。
 *
 * 口径**与首页的余额图表卡片一致**：都取「在余额模块里被固定到首页」的那个
 * 平台。没固定就不推 —— 否则设备上显示的会是另一个平台，和电脑上首页看到的
 * 对不上，用户只会以为哪边算错了。
 *
 * 不推趋势：设备屏上不画 sparkline（见 device.ts 的说明）。
 *
 * 纯逻辑（编码）在 device.ts，这里只负责取数。
 */
export function currentDeviceLines(): string[] {
  const pinned = useBalancesPrefs.getState().homePinnedProvider;
  if (!pinned) return [];

  const snap = useBalancesSnapshot.getState().snapshots[pinned];
  if (!snap || snap.items.length === 0) return [];

  return buildDeviceLines({ snapshot: snap });
}

/* =============================================
   ====== 侧栏角标 ======
   ============================================= */

/**
 * 侧栏角标：所有「显示中」指标里最低的健康度，**只在跌破首个提醒档位时才显示**。
 *
 * 为什么要有它：额度提醒只在「徽章已连接」时才评估（见 maybeAlert）——
 * 徽章没连、或者在充电时，额度掉到 5% 在应用里是**一点提示都没有**的。
 * 角标不依赖蓝牙，正好补上这个洞。
 *
 * 为什么健康时返回 null：一个永远挂着「78%」的角标会立刻变成噪音，
 * 用户很快就视而不见了。只在需要留意时才出现，才有信息量。
 *
 * 阈值复用 ALERT_THRESHOLDS[0]（= 50）而不是写死，免得两处日后各改各的。
 */
export function balancesBadge(): ModuleBadge | null {
  const worst = worstHealth(onlyVisible(badgeSource()));
  const text = healthBadgeText(worst, ALERT_THRESHOLDS[0]);
  /* 健康时（text 为 null）不出角标；worst 非空是 text 非空的前提，这里顺手收窄类型 */
  if (text === null || worst === null) return null;
  return { text, tone: healthBadgeTone(worst) };
}

/**
 * 角标数据源订阅：余额 / 快照 / 偏好任一变化都要重算。
 * 偏好也要订阅 —— 用户取消勾选某个平台时，最低值可能就变了。
 */
export function subscribeBalancesBadge(onChange: () => void): () => void {
  const unsubs = [
    useBalancesStore.subscribe(onChange),
    useBalancesSnapshot.subscribe(onChange),
    useBalancesPrefs.subscribe(onChange),
  ];
  return () => unsubs.forEach((u) => u());
}

/* =============================================
   ====== 系统菜单栏 ======
   ============================================= */

/**
 * 上一次推给菜单栏的内容，用于去重。
 *
 * 为什么要去重：`schedulePushEval` 每次数据/偏好变化都会跑一遍，而
 * 「显示哪些平台」「关掉再打开」这类偏好改动、以及每轮刷新的收尾，
 * 都会走到这里。每次订阅回调都跨一次 IPC 去改状态项是没必要的噪音
 * （而且每次 set_title 都要过一次主线程），何况每格还带着几 KB 的图标位图。
 */
let lastTrayKey = '';

/**
 * 「同步进行中又来了新配置」的补偿标记 —— 与推送那边的 `pushPending` 同一套理由。
 *
 * 为什么需要它：图标大小是**连续可调**的（设置页的滑块），拖一次会连着触发十几次
 * 偏好变更。每次都真的发一次 IPC 有两个问题：
 *   ① 十几个 `invoke` 同时在飞，**谁最后落地是不确定的** —— 菜单栏可能停在中间
 *      某一档，看起来像「拖了没反应」；
 *   ② 每一档都要重画一遍位图（虽然按「尺寸」缓存，但每个尺寸都是一次新计算）。
 *
 * 于是：同一时刻最多一个 IPC 在飞；期间来的变更只记一笔，等它回来再按**最新**配置
 * 补一次。收敛后菜单栏上的就是最终值，且拖动全程最多两次 IPC。
 * 注意补的那一次要**重新读偏好**（不是重发旧 payload）—— 否则补的还是中间某一档。
 */
let traySyncInFlight = false;
let traySyncPending = false;

/**
 * 菜单栏的数据源：**两层过滤 + 附上用户指定的指标**。
 *
 *   ① 先按「显示中的平台」过滤（onlyVisible + badgeSource，与角标、徽章摘要同口径，
 *      实时数据优先、缺失的用 localStorage 快照回落）；
 *   ② 再按「菜单栏勾选」过滤（`ids` 为 null = 跟随第 ① 步的结果）；
 *   ③ 把 `fields[provider]` 挂到每一项上，交给 tray.trayItem 决定用哪个指标。
 *
 * **为什么要参数化并导出**：设置页的实时预览与实际推送**必须走同一个函数**。
 * 预览自己再实现一遍过滤的话，一旦两边逻辑有细微差别（比如空数组算「全不选」
 * 还是「跟随全部」），用户看到的预览就和菜单栏上真实的东西不一致 ——
 * 而这类不一致极难发现，用户只会觉得「这个预览是骗人的」。
 *
 * `ids` 传 `[]`（空数组）与 `null` 语义不同：`[]` = 一个都不上菜单栏，
 * `null` = 跟随「显示中的平台」。见 prefs.setTrayProviders 的说明。
 */
export function currentTraySources(
  ids: string[] | null,
  fields: Record<string, string>,
): TraySource[] {
  const vis = onlyVisible(badgeSource());
  const picked = ids === null ? vis : vis.filter((b) => ids.includes(b.provider));
  return picked.map((b) => ({ ...b, field: fields[b.provider] ?? null }));
}

/**
 * 把「使用 / 剩余额度」同步到系统菜单栏：**每个平台一格**。
 *
 * 关闭开关时声明一个空数组 —— 后端把上一轮建过的项全部藏掉（`sync` 的语义是
 * 全量声明，见 core/tray.ts），所以「关掉」不需要另一条命令。
 *
 * 显示哪些平台、每个平台用哪个指标 / 哪个名字 / 要不要图标，全都读用户偏好；
 * 取数走 currentTraySources、内容走 tray.buildTrayItems —— 与设置页预览
 * 完全同一份逻辑。压缩规则在 tray.ts（纯逻辑，可单测），
 * 字形画成位图在 icons.ts。
 */
function syncTray(): void {
  const prefs = useBalancesPrefs.getState();
  const on = prefs.trayEnabled;
  const items = on
    ? buildTrayItems(currentTraySources(prefs.trayProviders, prefs.trayFields), {
        labels: prefs.trayLabels,
        iconOff: prefs.trayIconOff,
      })
    : [];

  /*
   * 去重键**从 items 自己算**，而不是另拼一份。
   *
   * 另拼一份意味着「键里含哪些字段」与「真正发出去的字段」是两处独立代码：
   * 以后加了字段（比如每格的宽度策略）忘了改键，现象就是「改了偏好但菜单栏不动」，
   * 而且只在**恰好只有那个字段变**的时候才复现 —— 极难查。
   * 从 items 算则不可能漏。
   *
   * ⚠️ **图标大小是个例外，必须显式拼进键**：它不在 items 里（items 只描述
   * 「显示什么内容」，尺寸是渲染参数），但改了它菜单栏确实要重画。
   * 不拼的话表现就是「拖动滑块没反应，重启才生效」—— 典型的「键漏了字段」。
   * 用 `trayInkPx` 量化后的**墨迹像素数**而不是 scale 原值，与 icons.ts 的
   * 缓存键同一口径（滑块的浮点噪声不会白白触发一次重推）。
   *
   * 图标**位图**仍然不进键：它由 `(key, glyph, 尺寸)` 唯一决定，
   * 三个要素要么已在键里、要么已量化成一个数，把几 KB 的像素拼进来纯属浪费。
   */
  const box = trayInkPx(prefs.trayIconScale);
  const key = items
    .map(
      (it) =>
        `${it.key}\u0001${it.title}\u0001${it.tooltip}\u0001${it.glyph ?? ''}` +
        `\u0001${it.detailTitle ?? ''}\u0001${it.details.join('\u0004')}`,
    )
    .join('\u0002')
    .concat(`\u0003${box}`);
  if (key === lastTrayKey) return;

  /*
   * 正在同步 → 只记一笔，等它回来再按**最新**配置补一次（理由见 traySyncPending）。
   *
   * ⚠️ 这里**先不要更新 lastTrayKey**：更新了的话，补跑的那一次会算出同一个键、
   * 被上面那行去重挡掉，最终值就永远推不出去 —— 表现是「拖到哪一档都停在第一档」。
   */
  if (traySyncInFlight) {
    traySyncPending = true;
    return;
  }
  lastTrayKey = key;

  const payload: TrayItemPayload[] = items.map((it) => ({
    key: it.key,
    title: it.title,
    tooltip: it.tooltip,
    visible: true,
    icon: it.glyph ? trayIconBitmap(it.key, it.glyph, prefs.trayIconScale) : null,
    details: it.details,
    detailTitle: it.detailTitle,
  }));
  /*
   * 记下**这次真的带上图标的格数**。
   *
   * 为什么不能只看 `trayItems`（后端返回的可见格数）：图标位图是**前端**画的
   * （icons.ts —— 有品牌 logo 的平台查内置 alpha 位图，其余用 canvas 画字形），
   * 两者都可能拿不到（base64 坏了 / 画布拿不到 2D 上下文）而返回 null，
   * 那一格照样可见、只是没图标，而且**不报任何错**。
   * 两个数放在一起读就能一眼分清三种状态：
   *   trayItems=0              → 配置没生效，或没有数据
   *   trayItems=2, trayIcons=0 → 格子在，但图标没画出来（画布问题）
   *   trayItems=2, trayIcons=2 → 正常
   */
  const icons = payload.filter((p) => p.icon !== null).length;

  traySyncInFlight = true;
  syncTrayItems(payload)
    .then((n) => {
      /*
       * 恢复成功后清掉痕迹（只在真的有过错误时才写一次 localStorage）。
       * 顺便记下**这次真的推上去了几格** —— 菜单栏在屏幕最上面，
       * 想确认「有没有生效」不该要求用户去数那几格（见 DIAG_KEY 的说明）。
       */
      writeDiag({ lastTrayError: '', trayItems: n, trayIcons: icons });
    })
    .catch((e) => {
      /*
       * 菜单栏不可用（非 macOS、系统限制）**不该影响余额本身**，所以静默；
       * 但要撤销记账，否则「失败了」会被当成「已经是这个内容」，之后永远不再试。
       */
      lastTrayKey = '';
      writeDiag({
        lastTrayError: (e as Error)?.message || String(e),
        trayItems: 0,
        trayIcons: 0,
      });
    })
    .finally(() => {
      traySyncInFlight = false;
      /*
       * 期间来过变更 → 补一次。**重新走整个 syncTray**（而不是重发旧 payload）：
       * 它会重新读偏好、重新算键，于是补的就是当前最新的那一档。
       * 若最新档恰好等于已推过的内容，上面的去重会把它挡掉，不会白推。
       */
      if (traySyncPending) {
        traySyncPending = false;
        syncTray();
      }
    });
}

/* =============================================
   ====== 推送 ======
   ============================================= */

/** 上一次推送的**摘要**，用于去重（断开连接时清空，重连后允许再推一遍） */
let lastPushed = '';
/** 上一次推送的**图表行**，同样用于去重 */
let lastChartPushed = '';

/**
 * 「推送进行中又来了新数据」的补偿标记。
 *
 * `maybeAutoPush()` 在 `pushing` 为真时直接返回（避免同一份内容并发写两遍），
 * 但**返回不等于丢弃**：BLE 写一行要几十毫秒，这期间刷新完成是很常见的 ——
 * 尤其是「徽章连上 → 立刻后台补刷」这条路径（`setConnected` 里先用旧数据推一条，
 * 紧接着就发起刷新）。丢掉的话设备上就停在旧数据上，直到下一次状态变化，
 * 而那可能要等一整个自动刷新周期（默认 15 分钟）。
 */
let pushPending = false;

/**
 * 把「有变化的内容」推一次（摘要 + 图表数据）。
 *
 * 为什么两种内容各用一个去重键，而不是合成一个：
 *   摘要只在**文本**变了才需要重推（`buildBadgeSummary` 是当前值的一句话快照，
 *   里面不含时间），而图表行里带着**刷新时刻**，每次刷新都不一样。
 *   合成一个键的话，摘要会被图表行的时间戳拖着「每次刷新都重推一遍」——
 *   徽章的通知列表里会堆满一模一样的「余额」条目。
 *
 * 两者都没变就直接返回，所以每个 tick / 每次状态变化调用它是廉价的。
 * 手动推送会先把两个键清空（见 pushBadgeNow），从而无视去重。
 */
async function sendChanged(): Promise<void> {
  const summary = currentBadgeSummary();
  const lines = currentDeviceLines();

  const wantSummary = summary && summary !== lastPushed ? summary : '';
  const chartKey = lines.length > 0 ? deviceLinesKey(lines) : '';
  const wantChart = chartKey !== '' && chartKey !== lastChartPushed;
  if (!wantSummary && !wantChart) return;

  /*
   * 先记账再发送：send 是异步的，期间余额可能又变了。
   * 不先记的话，同一份内容会被并发推两次。
   */
  if (wantSummary) lastPushed = wantSummary;
  if (wantChart) lastChartPushed = chartKey;

  useBalancesRuntime.setState({ pushing: true });
  try {
    if (wantSummary) await bridge.pushToBadge('余额', wantSummary);
    /* 图表行必须**后发**：固件收到 BAL 会整块重置（含趋势），
     * 顺序反了趋势会被刚收到的 BAL 清空。device.ts 已保证 BAL 在数组首位。 */
    if (wantChart) await bridge.pushLines(lines);
    useBalancesRuntime.setState({ lastPushedAt: Math.floor(Date.now() / 1000) });
  } catch (e) {
    /* 推送失败就撤销记账，下次状态变化时允许重试 */
    if (wantSummary && lastPushed === wantSummary) lastPushed = '';
    if (wantChart && lastChartPushed === chartKey) lastChartPushed = '';
    throw e;
  } finally {
    useBalancesRuntime.setState({ pushing: false });
    /*
     * 推送期间数据又变了 → 补一次评估。
     * 放在 finally 而不是 try 里：失败路径同样要补（记账已被撤销，重试靠这一次）。
     * 走 schedulePushEval 而不是直接调 maybeAutoPush，免得在 finally 里递归。
     */
    if (pushPending) {
      pushPending = false;
      schedulePushEval();
    }
  }
}

/** 手动推送（面板上的「推送到徽章」按钮）。失败时抛错，由调用方 toast。 */
export async function pushBadgeNow(): Promise<void> {
  if (!currentBadgeSummary() && currentDeviceLines().length === 0) {
    /*
     * 两种「推不出东西」要分开说：
     *   · 用户在「推送」里选了「一个都不推」→ 这是**他自己的选择**，
     *     却提示「请先刷新」会让他去刷新（刷新当然没用），
     *     真正该做的是去设置里勾一个平台；
     *   · 真的没数据 → 刷新是对的。
     * 不区分的话，这类「提示指错方向」比不提示更浪费时间。
     */
    const ids = useBalancesPrefs.getState().pushProviders;
    throw new Error(
      ids !== null && ids.length === 0
        ? '「推送」里选的是「一个都不推」，没有摘要可发。到 偏好设置 → 推送 勾选至少一个平台。'
        : '暂无可推送的余额数据，请先刷新',
    );
  }
  /*
   * 手动推送**无视去重**：用户点这个按钮就是要「现在就发一条」。
   * 内容和上次一样也该发 —— 典型场景是设备刚重启、屏幕上还是空的，
   * 而去重键还在内存里。
   */
  lastPushed = '';
  lastChartPushed = '';
  await sendChanged();
}

/**
 * 推一条示例提醒到徽章，用来验证「提醒通道」本身是通的。
 *
 * 为什么需要它：额度提醒要真的把额度耗到 50% 以下才会触发，用户没法主动验证通不通 ——
 * 换新徽章、重连、改过固件之后，最想知道的就是「提醒到底能不能到」。
 * 这条**不参与 alerts 的「已提醒」记账**（完全不碰 alerts 状态），随便点几次都行。
 */
export async function pushTestAlert(): Promise<void> {
  await bridge.pushReminder('余额', '测试提醒：本周剩余 5%');
}

/**
 * 自动推送：已连接 + 开关打开 + 摘要或图表有变化。
 *
 * 三道闸的顺序有讲究：**先看连接与开关，最后才看 pushing**。
 * 只有 `pushing` 那一支才记 pushPending —— 「没连接」和「用户关了自动推送」
 * 不是「稍后补上」，而是「现在根本不该推」，记了只会攒下一次无意义的评估。
 */
function maybeAutoPush(): void {
  const rt = useBalancesRuntime.getState();
  if (!rt.bleConnected) return;
  if (!useBalancesPrefs.getState().autoPush) return;
  /* 正在推送中就记一笔，等这次推完再评估（见 pushPending） */
  if (rt.pushing) {
    pushPending = true;
    return;
  }
  /* 去重与记账都在 sendChanged 里，这里只做「该不该推」的前置判断 */
  void sendChanged().catch(() => {
    /* 推送失败已在 sendChanged 里撤销记账，下一轮状态变化时会重试 */
  });
}

/**
 * 把「重新评估要不要推」合流到**微任务**里：同一个同步块内的多次写入只评估一次。
 *
 * 为什么非做不可：一次刷新会**连着写两个 store** —— 先余额 store、再快照 store
 * （见 refreshBalances），而 zustand 的订阅是**同步**触发的。于是订阅回调会跑两次：
 *   ① 第一次看到的是「余额已更新、快照还是旧的」这种半成品状态；
 *   ② 第二次才是完整状态。
 * 半成品那次算出来的刷新时刻是**上一轮**的（图表数据读的是快照），推给设备就是
 * 「设备上的时间永远慢一个周期」；而第二次（正确的那次）又会被 pushing 守卫吞掉。
 * 两个毛病叠在一起，表现就是「明明过了 5 分钟，设备上还是上一次的时间，
 * 要等到第二个 5 分钟才真正刷新」。
 *
 * 用 queueMicrotask 而不是 setTimeout(0)：微任务在**本次同步执行结束后立刻**跑，
 * 既保证两次写入都已落定，又不额外拖一帧、也不会被下一轮 BLE 事件插队。
 */
let pushEvalScheduled = false;
function schedulePushEval(): void {
  if (pushEvalScheduled) return;
  pushEvalScheduled = true;
  queueMicrotask(() => {
    pushEvalScheduled = false;
    maybeAutoPush();
    maybeAlert();
    /*
     * 菜单栏也挂在这一轮里：它和推送一样是「数据变了 → 输出跟着变」，
     * 而且同样会被「一次刷新写两个 store」骗到（见上面 schedulePushEval 的说明），
     * 所以必须和推送用同一个合流点，不能各自订阅。
     */
    syncTray();
  });
}

/* =============================================
   ====== 刷新 ======
   ============================================= */

let refreshing = false;
let lastRefreshAt = 0;

/**
 * 触发一次余额刷新，并把结果同时写回模块状态与前端快照。
 * 面板、首页图表卡片、本服务的后台刷新都走这一个入口。
 *
 * **不涉及系统钥匙串**：只把「内存里已有的」主密钥传下去（或调用方显式传入），
 * 没有就传 null，后端会回落读 ~/.codex/auth.json。
 * 工作台约定：钥匙串授权框只在进入 LogSight 时出现。
 */
export async function refreshBalances(masterKey?: string | null): Promise<AgentBalance[]> {
  const key = masterKey !== undefined ? masterKey : useWorkbenchStore.getState().masterKey;
  const list = await ipcRefresh(key ?? null);
  /*
   * 这里是**两次**写库，顺序不能反、也不能只写一个：
   *   - 余额 store 是面板的数据源；
   *   - 快照 store 是首页图表卡片与**设备推送**的数据源（图表行读的是快照）。
   * 两次写会各触发一轮订阅，所以推送评估必须合流到微任务里跑 ——
   * 否则第一轮会拿着「快照还是旧的」去推，设备上的刷新时刻就永远慢一个周期。
   * 详见 schedulePushEval。
   */
  useBalancesStore.getState().setBalances(list);
  useBalancesSnapshot.getState().applyBalances(list);
  /*
   * 一次全量刷新等于所有平台都刚刷过一遍，把各自的「下次刷新」往后推，
   * 避免紧接着的调度 tick 又重复刷一遍（手动刷新 / 徽章连上补刷都是全量）。
   * 排期现在由后端持有，这里只把后端 next_at 拨回去并刷新前端倒计时显示。
   */
  void ipcReschedule(null).then(updateScheduleDisplay).catch(() => {});
  return list;
}

/**
 * 触发**单个平台**的刷新，只更新那一张卡片的数据 + 它的快照。
 * 面板、首页图表卡片、单平台定时刷新都走这一个入口。
 * 与 refreshBalances 同一套「内存主密钥」约定，不碰钥匙串。
 */
export async function refreshProviderBalances(
  provider: string,
  masterKey?: string | null,
): Promise<AgentBalance> {
  const key = masterKey !== undefined ? masterKey : useWorkbenchStore.getState().masterKey;
  const b = await ipcRefreshOne(provider, key ?? null);
  useBalancesStore.getState().upsertBalance(b);
  useBalancesSnapshot.getState().applyProvider(b);
  void ipcReschedule(provider).then(updateScheduleDisplay).catch(() => {});
  return b;
}

/** 现有数据是否陈旧（或压根没有） */
function isStale(): boolean {
  const now = Math.floor(Date.now() / 1000);

  const live = useBalancesStore
    .getState()
    .balances.filter((b) => !b.error && b.items.length > 0);
  if (live.length > 0) {
    return now - Math.max(...live.map((b) => b.refreshed_at || 0)) > STALE_SEC;
  }

  const snaps = Object.values(useBalancesSnapshot.getState().snapshots);
  if (snaps.length === 0) return true;
  return now - Math.max(...snaps.map((s) => s.refreshedAt || 0)) > STALE_SEC;
}

/**
 * 后台刷新：互斥 + 限流，刷新成功后状态变化会自动触发补推 / 补提醒。
 *
 * `reason` 同时决定两件事，所以做成必填参数而不是两个布尔开关：
 *   - `'auto'`（定时器）：**跳过限流** —— 那个间隔是用户自己定的，不该再被卡住；
 *     同时记进诊断键，于是不看界面也能确认「定时器真的在跑」。
 *   - `'stale'`（徽章连上时的补刷）：走限流，防止蓝牙反复重连打网络。
 */
function refreshInBackground(reason: 'auto' | 'stale'): void {
  if (refreshing) return;
  const now = Math.floor(Date.now() / 1000);
  if (reason !== 'auto' && now - lastRefreshAt < REFRESH_MIN_GAP_SEC) return;

  refreshing = true;
  lastRefreshAt = now;
  refreshBalances()
    .then(() => markRefresh(reason))
    .catch((e) => {
      /* 没配置凭证 / 网络不通等：界面上静默（不该打扰用户），但记进诊断键备查 */
      markRefresh(reason, e);
    })
    .finally(() => {
      refreshing = false;
    });
}

/* =============================================
   ====== 自动刷新（排期由后端驱动）======
   =============================================
 *
 * 为什么放后端：关窗转后台时窗口只是被 hide()，webkit 会对隐藏页面的
 * setInterval 做后台节流 / App Nap，前端的 30 秒调度定时器在后台几乎不触发，
 * 「自动刷新」于是形同停摆。后端 tokio 运行时独立于 webview、不受页面可见性影响，
 * 由它持有排期、真正发起取数，再把结果用 balances:updated 事件推回前端渲染。
 * 前端只负责三件事：下发排期、接收事件更新界面、手动刷新（手动刷新仍走命令返回值）。
 */

/** 用后端回传的 next_at 地图更新运行时倒计时显示 */
function updateScheduleDisplay(map: Record<string, number>): void {
  const vals = Object.values(map);
  const soonest = vals.reduce<number>((m, v) => Math.min(m, v), Infinity);
  useBalancesRuntime.setState({
    providerNextRefresh: { ...map },
    nextRefreshAt: Number.isFinite(soonest) ? soonest : 0,
  });
}

/** 把当前偏好（开关 / 全局间隔 / 单平台覆盖 / 主密钥）下发给后端调度器 */
function applyRefreshPlan(): void {
  const prefs = useBalancesPrefs.getState();
  const masterKey = useWorkbenchStore.getState().masterKey;
  ipcSetRefreshPlan(
    prefs.autoRefresh,
    prefs.autoRefreshIntervalMin,
    prefs.providerRefreshMin,
    masterKey ?? null,
  )
    .then(updateScheduleDisplay)
    .catch(() => {});
}

/** 订阅后端推送的刷新结果：更新余额 + 快照 + 倒计时 */
function subscribeBackendRefresh(): void {
  listen<{ balance: AgentBalance; next_at: Record<string, number> }>(
    'balances:updated',
    (e) => {
      const { balance, next_at } = e.payload;
      useBalancesStore.getState().upsertBalance(balance);
      useBalancesSnapshot.getState().applyProvider(balance);
      updateScheduleDisplay(next_at);
      /* 记一笔诊断：证明后台定时器确实在跑（见 DIAG_KEY 说明） */
      markRefresh('auto', balance.error);
    },
  ).catch(() => {});
}

/* =============================================
   ====== 额度阈值提醒 ======
   ============================================= */

/**
 * 跌破 50/30/20/10/5 时各提醒一次（逻辑与去重都在 alerts.ts）。
 *
 * **只在「已连接 + 开着自动推送」时才评估**：评估会推进「已提醒」状态，
 * 离线时评估等于把提醒记成已发，用户就永远收不到了。
 * 代价是「离线期间跌破又回升」这种极端情况会漏一次提醒，可以接受。
 *
 * **只评估「推送勾选」里的平台**（与摘要同一口径）：用户既然在设置里
 * 明确说「只推这几个」，就不该再收到没勾的平台的额度提醒。
 */
function maybeAlert(): void {
  const rt = useBalancesRuntime.getState();
  if (!rt.bleConnected) return;
  if (!useBalancesPrefs.getState().autoPush) return;

  for (const a of evaluateAlerts(currentPushSources(useBalancesPrefs.getState().pushProviders))) {
    bridge.pushReminder('余额', alertBody(a)).catch(() => {
      /* 发失败就撤销记账，下一轮刷新时会重试 */
      unmarkAlert(a);
    });
  }
}

/* =============================================
   ====== 连接状态 ======
   ============================================= */

function setConnected(v: boolean): void {
  const prev = useBalancesRuntime.getState().bleConnected;
  useBalancesRuntime.setState({ bleConnected: v });
  if (v === prev) return;

  if (!v) {
    /*
     * 断开时清掉去重记录：徽章可能被重启/清屏，重连后应该重新收到一条。
     * pushPending 也一并清 —— 它是「这次推完再评估一次」的承诺，
     * 链路已经断了，那个承诺没有意义（重连时本来就会无视去重重推一遍）。
     */
    lastPushed = '';
    lastChartPushed = '';
    pushPending = false;
    return;
  }

  /*
   * 先用已有数据推一条（可能来自上次会话的快照），再按需后台刷新。
   * 走 schedulePushEval 与别处保持同一条路径：这里虽然只写了一个 store，
   * 但紧接着的 refreshInBackground 会连着写两个（见 schedulePushEval）。
   */
  schedulePushEval();
  if (isStale()) refreshInBackground('stale');
}

/* =============================================
   ====== 启动 ======
   ============================================= */

let started = false;

/**
 * 诊断痕迹（localStorage 键）。
 *
 * 存在的意义：界面上的任何提示都要先打开模块才看得见，而自动刷新是**分钟级**且
 * 发生在后台 —— 想确认「定时器到底有没有在跑」时，看界面既不方便也不可信
 * （倒计时归零可能只是刚重建过定时器）。写一份实况进 localStorage，
 * 就能在读数据库这一层直接验证（读法见 SKILL.md「验证服务是否真的常驻」）。
 */
const DIAG_KEY = 'balances:service';

interface ServiceDiag {
  /** 常驻服务启动时间（Unix 秒） */
  bootAt: number;
  /** 是否成功订阅到蓝牙状态事件 */
  bleSubscribed: boolean;
  /** 后台刷新**尝试**累计次数（含失败） */
  refreshTried: number;
  /** 后台刷新**成功**累计次数 */
  refreshOk: number;
  /** 最近一次后台刷新的时间（Unix 秒） */
  lastRefreshAt: number;
  /** 最近一次后台刷新的触发原因：auto = 定时器，stale = 徽章连上补刷 */
  lastRefreshReason: 'auto' | 'stale' | '';
  /** 最近一次失败的原因；成功时清空 */
  lastError: string;
  /**
   * 最近一次同步菜单栏失败的原因；成功时清空。
   * 单独一个键而不是塞进 lastError：菜单栏失败（非 macOS）与刷新失败
   * 是两回事，混在一起会让「刷新一直好好的」看起来像出了问题。
   */
  lastTrayError: string;
  /**
   * 最近一次同步后**真正挂在菜单栏上的智能体格数**（0 = 一格都没有）。
   *
   * 为什么要单独记：菜单栏在屏幕最上面，而「有没有生效」这件事如果只能靠
   * 抬头去数，那在无头/远程环境里就完全无法验证。记下这个数，
   * 读一次 localStorage 就能确认「是配置没生效，还是配置生效了但没数据」——
   * 前者格数是 0 而 lastTrayError 为空，后者同样为 0 但设置页里勾选还在。
   */
  trayItems: number;
  /**
   * 最近一次同步里**真的带上图标的格数**（前端 canvas 画出来的）。
   *
   * 与 `trayItems` 配合读才能分清「格子在但图标没画出来」（画布拿不到 2D 上下文时
   * `trayIconBitmap` 静默返回 null，不报任何错）与「正常」—— 见 syncTray 里的说明。
   */
  trayIcons: number;
}

/** 读回诊断对象（容忍旧版本只写了 bootAt / bleSubscribed） */
function readDiag(): Partial<ServiceDiag> {
  try {
    const raw = localStorage.getItem(DIAG_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Partial<ServiceDiag>)
      : {};
  } catch {
    return {};
  }
}

function writeDiag(next: Partial<ServiceDiag>): void {
  try {
    localStorage.setItem(DIAG_KEY, JSON.stringify({ ...readDiag(), ...next }));
  } catch {
    /* 隐私模式等场景下忽略 */
  }
}

function markBoot(): void {
  /*
   * 刷新计数**按会话重置**。这个键要回答的是「**本次会话**的定时器有没有跑」，
   * 留着上一轮的计数会让人误以为本会话已经刷过了 —— 那比没有诊断更糟。
   *
   * `bleSubscribed` 一律先写 false，订阅成功后再由调用方补一次 true ——
   * 于是「订阅了但还没成功」与「压根没订阅上」在诊断里是同一个中间态，
   * 而**终态**（true / false）是确定的。写成入参只会诱导调用方在这里传值，
   * 那又会把重置时机推到异步回调里（见 startBalancesService 的说明）。
   */
  writeDiag({
    bootAt: Math.floor(Date.now() / 1000),
    bleSubscribed: false,
    refreshTried: 0,
    refreshOk: 0,
    lastRefreshAt: 0,
    lastRefreshReason: '',
    lastError: '',
    lastTrayError: '',
    trayItems: 0,
    trayIcons: 0,
  });
}

/**
 * 记一次后台刷新的结果。
 *
 * 为什么「尝试 / 成功 / 失败原因」要分开记，而不是只记成功次数：
 * 只看成功次数的话，「定时器压根没跑」和「定时器跑了但每次都失败」读出来一模一样 ——
 * 而这两种情况要修的东西完全不同（前者查 setInterval，后者查网络 / 凭证）。
 * 失败的静默是设计（不该弹窗打扰），那就更需要在诊断键里留个痕迹。
 */
function markRefresh(reason: 'auto' | 'stale', error?: unknown): void {
  const prev = readDiag();
  writeDiag({
    refreshTried: Number(prev.refreshTried ?? 0) + 1,
    lastRefreshAt: Math.floor(Date.now() / 1000),
    lastRefreshReason: reason,
    ...(error === undefined
      ? { refreshOk: Number(prev.refreshOk ?? 0) + 1, lastError: '' }
      : { lastError: (error as Error)?.message || String(error) }),
  });
}

/**
 * 启动常驻服务。重复调用无副作用。
 * 由模块入口在 import 时调用，不依赖任何组件挂载。
 */
export function startBalancesService(): void {
  if (started) return;
  started = true;

  /*
   * **先同步**写下「本次会话开始」，再谈订阅。
   *
   * ⚠️ 顺序有讲究：`markBoot` 会按会话重置计数（含 trayItems），而本函数末尾的
   * `syncTray()` 是**同步**执行的、并且也写这个键。若把重置放进 `listen` 的
   * `.then` 里，重置就可能**晚于**第一次同步落地，把刚记下的格数抹成 0 ——
   * 表现是「菜单栏上明明有内容，诊断却说是 0 格」，比没有诊断更误导
   * （谁先跑取决于 promise 调度，不是能靠读代码看出来的东西）。
   *
   * 副作用是好的：即使 `listen` 永远不 resolve，bootAt 也一定写得下。
   */
  markBoot();

  /* 订阅 AI-Passport 连接状态（模块级订阅，与界面无关） */
  bridge
    .onBleState((s) => setConnected(s.state === 'connected'))
    /* 这里**只补 bleSubscribed**，不再调 markBoot —— 理由见上面那段说明 */
    .then(() => writeDiag({ bleSubscribed: true }))
    .catch(() => {
      /* 蓝牙后端不可用（例如构建时未启用该特性）时忽略；bleSubscribed 已是 false */
    });
  /* 事件可能在本服务启动前就发过了，主动拉一次当前状态兜底 */
  bridge
    .getBleState()
    .then((s) => setConnected(s.state === 'connected'))
    .catch(() => {});

  /*
   * 余额 / 偏好 / 快照 任一变化 → 重新评估是否需要推送与提醒。
   * 走 schedulePushEval（合流到微任务）而不是直接调：一次刷新会连着写两个 store，
   * 直接调会评估两次，而第一次看到的是半成品状态（详见 schedulePushEval）。
   */
  const onDataChanged = () => schedulePushEval();
  useBalancesStore.subscribe(() => {
    onDataChanged();
    /* 平台集合变化无需前端重建排期：后端 all_providers() 是静态全集，
     * 调度循环每 15 秒自动覆盖所有平台，新平台立刻纳入。 */
  });
  useBalancesPrefs.subscribe(() => {
    onDataChanged();
    applyRefreshPlan();
  });
  useBalancesSnapshot.subscribe(onDataChanged);

  /* 主密钥解锁 / 变化时，把新密钥下发给后端调度器（用于需要解密的凭证） */
  useWorkbenchStore.subscribe((state, prev) => {
    if (state.masterKey !== prev.masterKey) applyRefreshPlan();
  });

  /* 单平台独立刷新调度：排期交给后端定时器持有（见本文件顶部说明）。
   * 前端把当前偏好下发给后端，并订阅后端推送的刷新结果。 */
  applyRefreshPlan();
  subscribeBackendRefresh();

  /*
   * 先把菜单栏画出来。
   * 不能只等订阅触发 —— 冷启动时数据来自 localStorage 快照，而快照是在
   * store 初始化时一次性读进来的，之后**没有新的写入**，订阅根本不会被触发。
   * 那样菜单栏就要等到第一次刷新（可能 15 分钟后）才有内容。
   */
  syncTray();
}
