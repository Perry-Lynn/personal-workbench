/*
 * 智能体余额模块 · 额度阈值提醒
 * ------------------------------------------------------------------
 * 需求：某个百分比跌破 50 / 30 / 20 / 10 / 5 时，各向徽章推一条提醒。
 *
 * 四个关键决定（都是踩过之后才想清楚的）：
 *
 *   1. **判断建在「健康度」轴上**（100=充足，0=耗尽，见 format.healthPercentOf）。
 *      于是「已用 95%」和「剩余 5%」触发同一档，方向不会反 ——
 *      接口给的是 used_percent，而人关心的是「还剩多少」，两者必须归一。
 *
 *   2. **同一指标同时跌破多档时只发最深那档**。数值都已经比所有档都低了，
 *      连发五条内容几乎一样的通知纯属噪音；但五档都要记成「已提醒」，
 *      否则下一轮评估还会挨个补发。
 *
 *   3. **健康度回升即重新武装**（额度窗口重置 → 已用回到 0%）。
 *      少了这条就变成「一辈子只提醒一次」。
 *
 *   4. **状态持久化**，否则每次重启应用都会被同一档位重新轰炸一遍。
 *
 * 本模块是纯逻辑（只依赖 localStorage），不碰 React、不碰 IPC，
 * 便于单独跑脚本验证。
 * @Author: fu
 */
import { healthPercentOf } from './format';
import type { BadgeSummaryInput } from './format';

/** 触发提醒的档位，从宽到严 */
export const ALERT_THRESHOLDS = [50, 30, 20, 10, 5] as const;

const LS_KEY = 'balances:alerts';

/** key = `${provider}::${label}`，value = 已经提醒过的档位 */
type AlertState = Record<string, number[]>;

export interface QuotaAlert {
  provider: string;
  /** 平台展示名，用于通知正文 */
  name: string;
  /** 指标名（如「本周已用」） */
  label: string;
  /** 当前健康度（剩余百分比），已取整，用于通知正文 */
  health: number;
  /** 这次真正触发的那一档（最深的一档） */
  threshold: number;
  /** 本次一并记成「已提醒」的所有档位（推送失败回滚时用） */
  marked: number[];
}

function load(): AlertState {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

    const out: AlertState = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(v)) {
        out[k] = v.filter((x): x is number => typeof x === 'number');
      }
    }
    return out;
  } catch {
    return {};
  }
}

function persist(next: AlertState): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(next));
  } catch {
    /* 隐私模式等场景下忽略 */
  }
}

let state: AlertState = load();

/** 清空「已提醒」记录（设置里的「重置提醒记录」） */
export function resetAlerts(): void {
  state = {};
  persist(state);
}

/** 当前已提醒的档位快照（只读，调试 / 界面展示用） */
export function alertSnapshot(): AlertState {
  return JSON.parse(JSON.stringify(state)) as AlertState;
}

/**
 * 已提醒档位的「界面友好」视图：把 `provider::label` 拆开。
 *
 * 为什么单独开一个函数而不是让界面自己去解析 key：key 的拼法属于本模块的内部约定，
 * 界面不该知道 `::` 这个分隔符。按**第一个** `::` 拆，因为标签里理论上可能出现它。
 */
export function alertStatus(): { provider: string; label: string; notified: number[] }[] {
  return Object.entries(state).map(([key, thresholds]) => {
    const i = key.indexOf('::');
    return {
      provider: i < 0 ? key : key.slice(0, i),
      label: i < 0 ? '' : key.slice(i + 2),
      /* 从宽到严：先跌破的档位在前，读起来跟额度消耗的顺序一致 */
      notified: [...thresholds].sort((a, b) => b - a),
    };
  });
}

const keyOf = (provider: string, label: string) => `${provider}::${label}`;

function writeKey(key: string, notified: Set<number>): void {
  if (notified.size > 0) state[key] = [...notified].sort((a, b) => b - a);
  else delete state[key];
}

/**
 * 评估一轮数据，返回**这次应该发出去**的提醒。
 *
 * 副作用：更新并持久化「已提醒」状态。所以调用方要保证「已连接」时才调用 ——
 * 离线时评估会把提醒记成已发，用户就永远收不到了。
 */
export function evaluateAlerts(list: (BadgeSummaryInput & { provider: string })[]): QuotaAlert[] {
  const out: QuotaAlert[] = [];
  let dirty = false;

  for (const b of list) {
    if (b.error) continue;

    for (const it of b.items) {
      const health = healthPercentOf(it.label, it.value);
      if (health === null) continue;

      const key = keyOf(b.provider, it.label);
      const notified = new Set(state[key] ?? []);

      /* 回升 → 重新武装：额度窗口重置后，下一轮消耗才能再提醒一次 */
      for (const t of ALERT_THRESHOLDS) {
        if (health > t && notified.delete(t)) dirty = true;
      }

      const fresh = ALERT_THRESHOLDS.filter((t) => health <= t && !notified.has(t));
      if (fresh.length > 0) {
        for (const t of fresh) notified.add(t);
        out.push({
          provider: b.provider,
          name: b.name,
          label: it.label,
          health: Math.round(health),
          threshold: Math.min(...fresh),
          marked: [...fresh],
        });
        dirty = true;
      }

      writeKey(key, notified);
    }
  }

  if (dirty) persist(state);
  return out;
}

/**
 * 推送失败时回滚：撤销这次记下的档位，下次评估会重试。
 * 不这么做的话，一次蓝牙抖动就会把一条「额度快用完了」的提醒永久吞掉。
 */
export function unmarkAlert(a: QuotaAlert): void {
  const key = keyOf(a.provider, a.label);
  const notified = new Set(state[key] ?? []);
  for (const t of a.marked) notified.delete(t);
  writeKey(key, notified);
  persist(state);
}

/**
 * 通知正文，如 `ChatGPT 本周剩余 5%`。
 *
 * 标签可能写成「本周已用」这种「越高越糟」的形式，而通知要传达的是
 * 「还剩多少」，所以把方向词摘掉再统一拼「剩余」；标签本来就不含方向词
 * （如「本周」）时直接用。固件正文上限 95 字节，这里的文案远低于该值。
 */
export function alertBody(a: QuotaAlert): string {
  const where = a.label
    .replace(/已用|用量|使用|消耗|used|usage|剩余|余量|可用|额度|remaining|left|credit/gi, '')
    .trim();
  return `${a.name} ${where}剩余 ${a.health}%`;
}
