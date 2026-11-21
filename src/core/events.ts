/*
 * 工作台事件流
 * ------------------------------------------------------------------
 * 首页原来只有「现在」——四个数字告诉你此刻有几个会话、几个进程，
 * 但回答不了「刚才发生了什么」：10:02 起了 order-service.jar，
 * 10:05 它 OOM 挂了，10:06 你重启了它。这些事实散在三个地方
 * （JAR 运行记录 / Git 操作提示 / 日志会话标签），得挨个翻。
 *
 * 这里做一条**跨模块的时间线**：谁做了什么事、什么时候、结果如何。
 *
 * 三条设计约束：
 *
 *   1. **不引第三方状态库**。事件是「只追加的日志」，不是需要 selector、
 *      中间件、不可变更新的一套状态。用 useSyncExternalStore + 一个数组
 *      就够了，也免得为了一个时间线把 zustand 的 store 再拆一层。
 *   2. **pushEvent 绝不抛错**。它被各模块的业务路径调用（提交成功后、
 *      进程退出时），任何异常都不该让「提交成功」变成「提交失败」。
 *      所以持久化失败、localStorage 不可用一律静默降级为内存态。
 *   3. **事件是给人看的一句话，不是结构化审计日志**。title 已经是
 *      可直接渲染的中文句子，detail 只放补充（退出码、分支名、提交信息）。
 *      不要把原始 payload 塞进来 —— 那会把首页变成日志查看器。
 *
 * 与各模块的关系：core 不 import features，features 单向 import 这里。
 * @Author: fu
 */
import { useSyncExternalStore } from 'react';

/* =============================================
   ====== 类型 ======
   ============================================= */

/** 事件的情绪。只用来染色一个圆点，不改变文字颜色（文字始终读得清） */
export type EventTone = 'ok' | 'warn' | 'error' | 'info';

export interface WorkbenchEvent {
  /** 单调递增的内部 id，只当 React key 用；重启后会重新编号 */
  id: number;
  /** 毫秒时间戳 */
  ts: number;
  /** 来源模块 id（与 core/types.ts 的模块 id 一致，用来取图标） */
  module: string;
  tone: EventTone;
  /** 一句话，已经是可直接渲染的中文 */
  title: string;
  /** 补充信息，空串表示没有 */
  detail: string;
  /**
   * 连续重复次数。
   * 同一件事在 4 秒内又来一次（重连失败、批量状态推送）时不新起一行，
   * 只把次数 +1 —— 否则一次网络抖动能刷满整屏。
   */
  repeat: number;
}

/** pushEvent 的入参（id / repeat 由内部生成） */
export interface EventInput {
  module: string;
  title: string;
  detail?: string;
  tone?: EventTone;
  /** 指定时间戳，默认 Date.now()；测试与补录用 */
  ts?: number;
}

/* =============================================
   ====== 参数 ======
   ============================================= */

/** 环形缓冲上限。首页最多显示十来条，留 200 条是为了抽屉里能往回翻几天 */
const MAX_EVENTS = 200;

/** 同一件事在这个窗口内重复出现 → 合并计数，不新起一行 */
const REPEAT_WINDOW_MS = 4000;

/** 超过这个年龄的持久化事件在启动时丢弃（一周前的「刚刚」没有意义） */
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

const STORAGE_KEY = 'workbench:events:v1';

/* =============================================
   ====== 内部状态 ======
   ============================================= */

/*
 * events 是**不可变的**：每次变化都整体换一个新数组。
 * useSyncExternalStore 靠 Object.is 比较快照，原地 push 会让界面不更新。
 * 顺序固定为「最新在前」，UI 直接渲染，不用再排一次。
 */
let events: WorkbenchEvent[] = [];
let seq = 1;

const listeners = new Set<() => void>();
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function normalizeTone(v: unknown): EventTone {
  return v === 'ok' || v === 'warn' || v === 'error' ? v : 'info';
}

/** localStorage 在某些环境（无 DOM 的测试、隐私模式）会直接抛，一律当没有 */
function storage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

function readStored(): WorkbenchEvent[] {
  const ls = storage();
  if (!ls) return [];
  try {
    const raw = ls.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const cutoff = Date.now() - MAX_AGE_MS;
    const out: WorkbenchEvent[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const e = item as Partial<WorkbenchEvent>;
      /* 三个必填字段缺一个就整条丢掉：渲染时会直接取它们，没有默认值可给 */
      if (typeof e.ts !== 'number' || typeof e.title !== 'string' || typeof e.module !== 'string') {
        continue;
      }
      if (e.ts < cutoff) continue;
      out.push({
        id: 0,
        ts: e.ts,
        module: e.module,
        tone: normalizeTone(e.tone),
        title: e.title,
        detail: typeof e.detail === 'string' ? e.detail : '',
        repeat: typeof e.repeat === 'number' && e.repeat > 0 ? Math.floor(e.repeat) : 1,
      });
    }
    out.sort((a, b) => b.ts - a.ts);
    /* id 重新编号：磁盘上的 id 可能重复或缺失（旧版本写坏的），
       而它是 React key —— 撞车会让整行错位。 */
    return out.slice(0, MAX_EVENTS).map((e, i) => ({ ...e, id: i + 1 }));
  } catch {
    /* JSON 坏了就当没有历史，不要因为一条坏记录让首页白屏 */
    return [];
  }
}

function notify(): void {
  for (const fn of listeners) fn();
}

/*
 * 落盘做 400ms 合并：一次操作往往连着推两三条（提交 + 推送），
 * 每条都 JSON.stringify(200 条) 是白费。
 */
function schedulePersist(): void {
  if (persistTimer !== null) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const ls = storage();
    if (!ls) return;
    try {
      ls.setItem(STORAGE_KEY, JSON.stringify(events));
    } catch {
      /* 配额满 / 隐私模式：事件流退化成「只在本次运行里可见」，不影响功能 */
    }
  }, 400);
}

/* 模块加载即恢复历史，这样重启应用后时间线不会从零开始 */
events = readStored();
seq = events.length + 1;

/* =============================================
   ====== 写入 ======
   ============================================= */

/**
 * 追加一条事件。
 *
 * 返回真正落进去的那条（合并重复时返回的是合并后的那条，ts 已刷新）。
 * **不会抛错** —— 调用方不需要 try/catch。
 */
export function pushEvent(input: EventInput): WorkbenchEvent {
  const ts = input.ts ?? Date.now();
  const tone = normalizeTone(input.tone);
  const detail = input.detail ?? '';
  const head = events[0];

  /* 同签名且时间相近 → 合并。要求 ts 不倒退，否则补录历史时会误并到最新一条上 */
  if (
    head &&
    ts >= head.ts &&
    ts - head.ts <= REPEAT_WINDOW_MS &&
    head.module === input.module &&
    head.tone === tone &&
    head.title === input.title &&
    head.detail === detail
  ) {
    const merged: WorkbenchEvent = { ...head, ts, repeat: head.repeat + 1 };
    events = [merged, ...events.slice(1)];
    notify();
    schedulePersist();
    return merged;
  }

  const ev: WorkbenchEvent = {
    id: seq++,
    ts,
    module: input.module,
    tone,
    title: input.title,
    detail,
    repeat: 1,
  };
  events = [ev, ...events].slice(0, MAX_EVENTS);
  notify();
  schedulePersist();
  return ev;
}

/** 清空时间线（首页「清空」按钮）。只清本地，不影响任何模块的运行状态 */
export function clearEvents(): void {
  if (events.length === 0) return;
  events = [];
  notify();
  schedulePersist();
}

/* =============================================
   ====== 读取 ======
   ============================================= */

export function getEvents(): WorkbenchEvent[] {
  return events;
}

export function subscribeEvents(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * React 侧读取入口。
 *
 * 返回的是**同一个数组引用**（变化时才换新），所以可以直接当 useMemo 依赖；
 * 不要对它做原地 sort / splice。
 */
export function useEvents(): WorkbenchEvent[] {
  return useSyncExternalStore(subscribeEvents, getEvents, getEvents);
}

/* =============================================
   ====== 时间显示（纯函数，可单测） ======
   ============================================= */

function two(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * 把时间戳渲染成一句人话。
 *
 * 刻度不是均匀的，而是跟着「人关心什么」走：
 *   1 分钟内   → 「刚刚」        （不需要更精确）
 *   1 小时内   → 「N 分钟前」    （还处在「刚才」的语境里）
 *   今天       → 「14:02」       （绝对时刻比「5 小时前」好读）
 *   昨天       → 「昨天 14:02」
 *   更早       → 「10月18日 14:02」
 *
 * now 显式传入而不是内部取 Date.now()，这样它是纯函数，测试能钉住边界。
 */
export function formatAgo(ts: number, now: number): string {
  const diff = now - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;

  const d = new Date(ts);
  const today = new Date(now);
  const clock = `${two(d.getHours())}:${two(d.getMinutes())}`;
  if (sameDay(d, today)) return clock;

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sameDay(d, yesterday)) return `昨天 ${clock}`;

  return `${d.getMonth() + 1}月${d.getDate()}日 ${clock}`;
}
