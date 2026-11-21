/*
 * 智能体余额模块 · 对外公开契约
 * ------------------------------------------------------------------
 * 工作台约定：模块之间不互相 import 内部实现（store / 组件 / 类型细节）。
 * 别的模块（目前是首页）需要读余额数据时，**只 import 本文件**。
 *
 * 这里只暴露「只读」能力，且全部走前端缓存，不会触发任何 IPC：
 * 首页因此既不需要主密钥，也不会在进入时打网络请求。
 * 唯一的例外是 refreshBalances —— 那是用户点「刷新」才调用的显式动作。
 *
 * 如果将来要换数据源（例如改成 core 级统一快照），只需替换本文件。
 * @Author: fu
 */
import { useBalancesPrefs } from './prefs';
import type { TrendGranularity } from './format';
import { useBalancesSnapshot } from './snapshot';
import type { BalanceSnapshot, HistoryPoint } from './snapshot';
import type { AgentBalance, BalanceItem } from './types';

export type { BalanceSnapshot, HistoryPoint, BalanceItem, AgentBalance };

/**
 * 刷新余额。实现放在 service.ts（常驻服务），这里只做转发，
 * 保证「面板 / 首页 / 后台自动刷新」用的是同一条链路。
 */
export { refreshBalances } from './service';

/** 稳定引用，避免选择器每次返回新数组导致无限重渲染 */
const EMPTY: HistoryPoint[] = [];

/** 首页被指定展示哪个平台的余额；null = 未配置 */
export function useHomePinnedProvider(): string | null {
  return useBalancesPrefs((s) => s.homePinnedProvider);
}

/** 被固定平台的展示名（可能为 null —— 例如偏好是旧版本写的） */
export function useHomePinnedName(): string | null {
  return useBalancesPrefs((s) => s.homePinnedName);
}

/** 指定平台的最近一次余额快照；没有则 null */
export function useBalanceSnapshot(provider: string | null): BalanceSnapshot | null {
  return useBalancesSnapshot((s) => (provider ? s.snapshots[provider] ?? null : null));
}

/** 首页趋势图跟踪哪个指标；null = 自动 */
export function useTrendMetric(): string | null {
  return useBalancesPrefs((s) => s.trendMetric);
}

/** 切换趋势跟踪的指标（传 null 恢复自动） */
export function setTrendMetric(label: string | null): void {
  useBalancesPrefs.getState().setTrendMetric(label);
}

/** 首页趋势图的聚合粒度 */
export function useTrendGranularity(): TrendGranularity {
  return useBalancesPrefs((s) => s.trendGranularity);
}

/** 切换趋势粒度。首页直接调，不必层层传 props */
export function setTrendGranularity(g: TrendGranularity): void {
  useBalancesPrefs.getState().setTrendGranularity(g);
}

export { bucketHistory, TREND_GRANULARITY_OPTIONS } from './format';
export type { TrendGranularity } from './format';

/** 指定平台的主指标历史（用于趋势图） */
export function useBalanceHistory(provider: string | null): HistoryPoint[] {
  return useBalancesSnapshot((s) => (provider ? s.history[provider] ?? EMPTY : EMPTY));
}

export { pickHomeMetric, pickPrimaryMetric } from './snapshot';
export { parseNumeric, pickTrendMetric } from './format';

/*
 * 展示层纯函数。首页要画环形进度和「刷新于 …」，这些规则必须与余额面板
 * 完全一致（尤其是「已用 / 剩余」的方向归一），所以从这里统一出口，
 * 而不是让首页去猜 —— 否则两处的颜色和文案迟早会分叉。
 */
export {
  formatRefreshedAt,
  healthColor,
  healthPercentOf,
  itemHealth,
  exhaustedNote,
  sparkY,
  isUsageLabel,
  percentOf,
} from './format';
