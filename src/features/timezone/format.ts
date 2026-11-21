/*
 * 时区对比 · 界面侧的纯逻辑
 * ------------------------------------------------------------------
 * 时区换算、夏令时档案（`dstProfile` / `tierTimes` / `abbrPair`）都在
 * `@/core/timezones` —— 首页世界时钟也要用同一套，而**模块之间不许互相引用**。
 * 这里只放**这个界面**特有的东西：输入框与瞬间的互转、跳变的中文说法、缩写的降级。
 *
 * 不碰 React、不碰 localStorage —— 全部能进 `npm run test:logic`。
 * @Author: fu
 */

import {
  formatUtcOffset,
  offsetAt,
  pad2,
  zoneAbbr,
  type Transition,
  type WallParts,
} from '@/core/timezones';

/**
 * 墙上时间 → `<input type="date">` 的 value。
 *
 * 参数是**已经算好的墙上时间**，不是一个时区 id —— 因为时区对比允许把某个时区
 * 固定成标准时（此时它和 `instantParts(ms, zone)` 给的不是同一个东西）。
 * 由调用方决定「用哪一份墙上时间」，这里只负责排版。
 */
export function toDateInput(p: WallParts | null): string {
  if (!p) return '';
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** 墙上时间 → `<input type="time">` 的 value */
export function toTimeInput(p: WallParts | null): string {
  if (!p) return '';
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

/**
 * 解析 `<input type="date">` 的值。
 *
 * 空串 / 半截输入（浏览器在用户还没输完时也会触发 change）一律返回 null，
 * 让调用方**忽略这一次变化**而不是当成 1970 年。
 */
export function parseDateInput(value: string): { year: number; month: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  /* 用 UTC 回读校验，挡掉 2 月 30 日这种「格式对、日期不存在」的输入 */
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return { year, month, day };
}

/** 解析 `<input type="time">` 的值（`HH:mm`，容忍 `HH:mm:ss`） */
export function parseTimeInput(value: string): { hour: number; minute: number } | null {
  const m = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(value.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/**
 * 缩写展示：优先字母缩写（`PDT`），没有就退回 `UTC-7`。
 *
 * 为什么不能两个都显示：`GMT+8` 和 `UTC+8` 是同一件事的两种写法，
 * 并排出现只是噪声。
 */
export function offsetBadge(ms: number, timeZone: string): string {
  const abbr = zoneAbbr(new Date(ms), timeZone);
  if (abbr) return abbr;
  const off = offsetAt(ms, timeZone);
  return off === null ? '' : formatUtcOffset(off);
}

/**
 * 把一次跳变说成人话。
 *
 * 跳变点用**跳变前**的墙上时间表述（美国是「凌晨 2 点」）：夏令时开始的那一刻
 * 02:00 并不存在，但所有人都是这么说的。所以用 `tr.ms + fromOffset` 反算，
 * 而不是取跳变后的时间（那会得到 03:00 / 01:00）。
 */
export function transitionText(timeZone: string, tr: Transition | null): string {
  if (!tr) return '不实行夏令时';

  const wall = new Date(tr.ms + tr.fromOffset * 60_000);
  const md = `${wall.getUTCMonth() + 1}月${wall.getUTCDate()}日`;
  const hm = `${pad2(wall.getUTCHours())}:${pad2(wall.getUTCMinutes())}`;
  const after = offsetBadge(tr.ms + 1, timeZone) || formatUtcOffset(tr.toOffset);

  /* 偏移变大 = 开始（少睡一小时）；变小 = 结束（多睡一小时） */
  return tr.toOffset > tr.fromOffset
    ? `夏令时 ${md} ${hm} 开始，之后转为 ${after}`
    : `夏令时 ${md} ${hm} 结束，之后回到 ${after}`;
}
