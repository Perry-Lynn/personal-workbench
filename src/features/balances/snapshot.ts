/*
 * 智能体余额模块 · 余额快照与趋势历史
 * ------------------------------------------------------------------
 * 为什么要存快照？
 *   首页要展示余额图表，但首页**不能**去调 IPC —— 那会拉起主密钥、弹钥匙串授权框，
 *   也会在每次进首页时打网络请求。所以余额模块每次刷新成功后，把结果落一份到
 *   localStorage；首页只读这份缓存，零 IPC、零网络、零密钥。
 *
 * 历史点用于画趋势 sparkline：每次刷新追加一个「主指标」数值，
 * 相同数值在短时间内不重复记；保留策略见 format.pruneHistory（分层降采样，
 * 让「按次 / 按小时 / 按天」三种粒度共用同一份数据）。
 * @Author: fu
 */
import { create } from 'zustand';
import { decideHistory, itemPriority, parseNumeric, pickTrendMetric, pruneHistory } from './format';
import { useBalancesPrefs } from './prefs';
import type { AgentBalance, BalanceItem } from './types';

export interface BalanceSnapshot {
  provider: string;
  name: string;
  items: BalanceItem[];
  refreshedAt: number;
}

export interface HistoryPoint {
  /** Unix 秒 */
  t: number;
  v: number;
  /**
   * 这个点属于哪个指标（如「剩余额度」/「本时段已用」）。
   * 升级前存下的老点没有这个字段，会被 decideHistory 判为「指标已变」从而重开序列。
   */
  label?: string;
}

const LS_SNAPSHOT = 'balances:snapshots';
const LS_HISTORY = 'balances:history';
/** 同值去重窗口：60 秒内的相同数值不重复记点 */
const DEDUPE_WINDOW_SEC = 60;


/** 取一个平台的「主指标」：优先级最高、且数值可解析的那一项 */
export function pickPrimaryMetric(items: BalanceItem[]): BalanceItem | null {
  const sorted = [...items].sort((a, b) => itemPriority(a.label) - itemPriority(b.label));
  return sorted.find((it) => parseNumeric(it.value) !== null) ?? sorted[0] ?? null;
}

/**
 * 首页那一格展示哪个指标 —— **唯一的取数口径**。
 *
 * 用户在「设置 › 首页」里指定的指标优先；没指定（或指定的那个本次数据里没有）就自动挑。
 *
 * ⚠️ 首页的**大数字、副行、进度条、走势**必须全部走这一个函数。
 * 2026-10-26 的真 bug：主数字用 `pickPrimaryMetric`、走势用 `pickTrendMetric`，
 * 两者可以指向不同指标 —— 用户选了「本周已用」，首页照旧显示「剩余额度」，
 * 而且曲线画的是另一个指标（数字和曲线对不上，正是这段代码注释里警告过的事）。
 */
export function pickHomeMetric(
  items: BalanceItem[],
  preferred: string | null,
): BalanceItem | null {
  return pickTrendMetric(items, preferred, pickPrimaryMetric(items));
}

function readLS<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeLS(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 配额满 / 隐私模式：静默忽略，不影响主流程 */
  }
}

interface SnapshotState {
  snapshots: Record<string, BalanceSnapshot>;
  history: Record<string, HistoryPoint[]>;
  /** 刷新成功后调用：更新快照并追加历史点 */
  applyBalances: (list: AgentBalance[]) => void;
  /** 只更新某一个平台的快照与历史点（单平台定时刷新用） */
  applyProvider: (b: AgentBalance) => void;
  clear: () => void;
}

export const useBalancesSnapshot = create<SnapshotState>((set, get) => ({
  snapshots: readLS<Record<string, BalanceSnapshot>>(LS_SNAPSHOT, {}),
  history: readLS<Record<string, HistoryPoint[]>>(LS_HISTORY, {}),

  applyProvider: (b) => {
    // 有错的平台不覆盖旧快照，避免一次网络抖动把首页图表清空
    if (b.error || b.items.length === 0) return;

    const snapshots = { ...get().snapshots };
    const history = { ...get().history };
    const now = Math.floor(Date.now() / 1000);

    snapshots[b.provider] = {
      provider: b.provider,
      name: b.name,
      items: b.items,
      refreshedAt: b.refreshed_at || now,
    };

    /*
     * 记录哪个指标：优先用户在首页显式选的那个，否则挑一个会变化的百分比指标
     * （见 format.pickTrendMetric —— 恒定的绝对量会让趋势图永远是一条直线）。
     */
    const tracked = pickTrendMetric(
      b.items,
      useBalancesPrefs.getState().trendMetric,
      pickPrimaryMetric(b.items),
    );
    const v = tracked ? parseNumeric(tracked.value) : null;
    if (tracked && v !== null) {
      const prev = history[b.provider] ?? [];
      const last = prev[prev.length - 1] ?? null;
      /* 取舍规则（含「主指标换了就重开序列」）抽在 format.decideHistory，可单测 */
      const action = decideHistory(last, v, tracked.label, now, DEDUPE_WINDOW_SEC);
      // 同值且时间接近就不重复记，否则频繁刷新会把趋势图刷成一条噪声
      if (action !== 'skip') {
        const appended =
          action === 'reset'
            ? [{ t: now, v, label: tracked.label }]
            : [...prev, { t: now, v, label: tracked.label }];
        /*
         * 分层降采样：24h 内留全部、7 天内每小时一条、更早每天一条。
         * 这样一份数据同时服务「按次 / 按小时 / 按天」三种粒度，
         * 既不会撑爆 localStorage，也不至于让「按天」只有一两天数据。
         */
        history[b.provider] = pruneHistory(appended, now);
      }
    }

    writeLS(LS_SNAPSHOT, snapshots);
    writeLS(LS_HISTORY, history);
    set({ snapshots, history });
  },

  applyBalances: (list) => {
    for (const b of list) get().applyProvider(b);
  },

  clear: () => {
    writeLS(LS_SNAPSHOT, {});
    writeLS(LS_HISTORY, {});
    set({ snapshots: {}, history: {} });
  },
}));
