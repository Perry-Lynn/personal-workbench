/*
 * 时区对比 · 偏好存储
 * ------------------------------------------------------------------
 * 存「选了哪两个时区」以及「每一侧是否跟随夏令时」。
 * **不存时刻** —— 每次进来都从「现在」开始：一个昨天下午固定的时刻，
 * 第二天打开时只会让人以为界面坏了。
 *
 * 存 localStorage 而不是 sled：这是纯展示偏好，没有跨设备/跨进程的必要，
 * 和首页的 `workbench:home-clocks` 同一档。
 * @Author: fu
 */

import { isKnownZone, localZoneId } from '@/core/timezones';

/* 键名沿用 `timezone-zones`：改键就要写迁移，而这里只多两个字段，
   旧数据缺字段时按「跟随夏令时」补上即可（见 readComparePrefs） */
const KEY = 'workbench:timezone-zones';

export interface ComparePrefs {
  /** 左边（基准） */
  a: string;
  /** 右边（对照） */
  b: string;
  /** 左侧是否跟随夏令时；false = 全年按标准时算 */
  dstA: boolean;
  /** 右侧是否跟随夏令时 */
  dstB: boolean;
}

/**
 * 默认：本地 + 洛杉矶。
 * 选洛杉矶是因为这个工具最常被问的就是「美国那边几点 / 是不是夏令时」，
 * 而它正好有 PST/PDT 两种状态，一进来就能看到缩写会变。
 */
export function readComparePrefs(): ComparePrefs {
  const fallback: ComparePrefs = {
    a: localZoneId(),
    b: 'America/Los_Angeles',
    dstA: true,
    dstB: true,
  };
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch (_) {
    return fallback;
  }
  if (!raw) return fallback;

  try {
    const parsed = JSON.parse(raw) as Partial<ComparePrefs> | null;
    const ok = (v: unknown): v is string =>
      typeof v === 'string' && (isKnownZone(v) || v === localZoneId());
    return {
      a: ok(parsed?.a) ? parsed.a : fallback.a,
      b: ok(parsed?.b) ? parsed.b : fallback.b,
      /*
       * 老数据（2026-10-28 之前）没有这两个字段 —— 缺失按 true 处理，
       * 也就是「保持原来的行为」。
       * ⚠️ 不能把缺失当成 false，否则升级后所有用户的洛杉矶会突然变成 PST。
       */
      dstA: typeof parsed?.dstA === 'boolean' ? parsed.dstA : true,
      dstB: typeof parsed?.dstB === 'boolean' ? parsed.dstB : true,
    };
  } catch (_) {
    /* 存坏了（手改 / 半截写入）→ 回默认值，不要把坏数据当成空 */
    return fallback;
  }
}

export function writeComparePrefs(p: ComparePrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ a: p.a, b: p.b, dstA: p.dstA, dstB: p.dstB }));
  } catch (_) {
    /* 写不进去只影响下次启动 */
  }
}
