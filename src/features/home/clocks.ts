/*
 * 首页世界时钟 · 地区列表的增删与归一
 * ------------------------------------------------------------------
 * 这里只剩**首页自己的**那点东西：默认展示哪几个、存进去的条目怎么收敛。
 * 时区目录、城市别名与换算都在 `@/core/timezones`（时区对比模块也要用，
 * 模块之间不许互相引用，共享能力只能放 core）。
 *
 * 纯逻辑、不碰 React 也不碰 localStorage —— 这样 `npm run test:logic` 能直接跑。
 *
 * ⚠️ 条目是 `{ id, city }` 而不是裸的时区 id：
 *   北京和上海共用 `Asia/Shanghai`，用户搜的是北京，格子上就该写北京。
 *   裸 id 做不到这一点（`zoneLabel` 只能给出该时区的**主城**）。
 *
 * ⚠️ **同一个时区允许出现多条**（2026-10-26 改）：
 *   北京和上海是同一个钟，但用户想同时看见两个城市名。
 *   所以去重键是 `id + city`，不是 id —— 之前按 id 去重会把后加的那个
 *   变成「改显示名」，也就是把先加的替换掉，用户明确说不要这个行为。
 * @Author: fu
 */

import { CLOCK_MAX, cityBelongsTo, isKnownZone, localZoneId, zoneLabel } from '@/core/timezones';

/** 一个时钟格子 */
export interface ClockEntry {
  /** IANA 时区 id */
  id: string;
  /**
   * 用户当时选的城市名。缺省时用 `zoneLabel(id)` 兜底。
   * 存的是**展示名**，不参与任何换算。
   */
  city?: string;
}

/** 默认展示的地区：本地 + 三个最常被问到的（东京 / 纽约 / 伦敦） */
const DEFAULT_EXTRA = ['Asia/Tokyo', 'America/New_York', 'Europe/London'];

/** 城市名的长度上限：防手改存储塞进来一个几千字的串把格子撑破 */
const CITY_MAX_LEN = 24;

/**
 * 条目的稳定键。
 *
 * 同一个时区可以有多条（北京 / 上海），所以**不能拿 id 当 key**：
 * React 列表、删除、判重全都靠它。
 */
export function entryKey(e: ClockEntry): string {
  return `${e.id}|${e.city ?? ''}`;
}

export function defaultClockEntries(): ClockEntry[] {
  /*
   * 本地时区直接进列表，**不管它在不在目录里**（见 core/timezones 的 cityFromZoneId）：
   * 第一格必须是「你自己的时间」，否则这个面板对用户就没有锚点。
   */
  const out: ClockEntry[] = [];
  for (const id of [localZoneId(), ...DEFAULT_EXTRA]) {
    if (!out.some((e) => e.id === id)) out.push({ id });
  }
  return out;
}

/**
 * 把存储里读到的任意值收敛成合法的条目列表。
 *
 * 认三种输入：
 *   · 不是数组（含 null）→ 默认值；
 *   · `string[]` —— **旧格式**，迁移成 `{ id }`（2026-10-26 之前存的就是这个）；
 *   · `{ id, city? }[]` —— 现格式。
 *
 * **「没有存过」和「用户删空了」是两件事**（与 core/theme.ts::parseStoredFontSize
 * 同一条判据）：前者要给默认值，后者必须尊重「就是空的」。所以只有「不是数组」
 * 才回默认；空数组原样返回。
 */
export function normalizeClockEntries(raw: unknown): ClockEntry[] {
  if (!Array.isArray(raw)) return defaultClockEntries();

  /*
   * 本机时区是白名单的**唯一例外**（见 core/timezones 的 cityFromZoneId）：
   * 它可能不在目录里，但必须能留在列表里，否则下次启动「本地」那一格就消失了。
   */
  const local = localZoneId();
  const out: ClockEntry[] = [];

  for (const v of raw) {
    const entry = toEntry(v);
    if (!entry) continue;
    if (!isKnownZone(entry.id) && entry.id !== local) continue;
    /* 按 id + city 去重：同一个城市不该出现两次，但同区的不同城市要留两条 */
    const k = entryKey(entry);
    if (out.some((e) => entryKey(e) === k)) continue;
    out.push(entry);
    if (out.length >= CLOCK_MAX) break;
  }
  return out;
}

/** 单条归一。认旧格式的裸字符串，也认新格式的对象 */
function toEntry(v: unknown): ClockEntry | null {
  if (typeof v === 'string') return v ? { id: v } : null;
  if (!v || typeof v !== 'object') return null;

  const rec = v as Record<string, unknown>;
  const id = typeof rec.id === 'string' ? rec.id : '';
  if (!id) return null;

  const city = typeof rec.city === 'string' ? rec.city.trim() : '';
  /*
   * 城市名必须是**这个时区真的有的城市**（主城或别名）。
   * 手改存储写一个 `{ id: 'Asia/Tokyo', city: '北京' }` 进来时，宁可丢掉城市名，
   * 也不要让格子上出现「东京时间，写着北京」这种谎话。
   */
  if (!city || city.length > CITY_MAX_LEN || !cityBelongsTo(id, city)) return { id };
  /* 与主城同名就存成缺省值：省一份冗余数据，也少一种「两条同义条目」的可能 */
  if (city === zoneLabel(id)) return { id };
  return { id, city };
}

/**
 * 添加一个地区。
 * 已存在（同 id 同城市）/ 已满 / 未知时区时**返回原数组**（调用方可据此跳过写盘）。
 */
export function addClockEntry(
  list: readonly ClockEntry[],
  id: string,
  city?: string,
): ClockEntry[] {
  if (!isKnownZone(id) || list.length >= CLOCK_MAX) return list as ClockEntry[];

  const next = toEntry({ id, city }) ?? { id };
  const k = entryKey(next);
  if (list.some((e) => entryKey(e) === k)) return list as ClockEntry[];
  return [...list, next];
}

/** 按 key 删一条（同区的另一个城市不受影响） */
export function removeClockEntry(list: readonly ClockEntry[], key: string): ClockEntry[] {
  return list.filter((e) => entryKey(e) !== key);
}
