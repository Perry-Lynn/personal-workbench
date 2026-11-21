/*
 * 片段库 · 纯逻辑
 * ------------------------------------------------------------------
 * 不 import 任何运行时依赖（不碰 zustand / react / localStorage），
 * 以便被 scripts/logic-test.ts 直接 import 进 node 跑断言。
 *
 * ⚠️ 引 core 只能走**相对路径**：`test:logic` 是用 esbuild 裸打包的，
 * 没有配 `@/` 别名（见 package.json 的 test:logic 脚本）。写 `@/core/text`
 * 在 vite 里没事，但一跑断言就报解析失败。
 * @Author: fu
 */
import { findRanges, truncateStrict, truncateText } from '../../core/text';
import type { Snippet } from './types';

/* 与后端 models.rs 的常量保持一致：前端先截一次是为了**输入时即时反馈**，
   真正的兜底在后端（数据侧只认后端归一后的结果） */
export const MAX_TITLE_CHARS = 120;
export const MAX_TAG_CHARS = 24;
export const MAX_TAGS = 12;

/* 卡片预览：最多几行、每行最多几个字 */
export const PREVIEW_LINES = 3;
export const PREVIEW_LINE_CHARS = 110;

/*
 * 正文体积上限，必须与后端 models.rs::MAX_BODY_BYTES 一致。
 * 前端先拦一道是为了在编辑框下面直接给出提示，而不是等用户点了保存才报错；
 * 真正的上限判定仍然在后端（数据侧只认后端）。
 */
export const MAX_BODY_BYTES = 256 * 1024;

/**
 * 正文的**字节数**。
 *
 * 用 TextEncoder 而不是 `body.length`：后者数的是 UTF-16 码元，
 * 一个汉字算 1 —— 而落盘时算的是 UTF-8 字节，一个汉字 3 个。
 * 两个数字对不上，会出现「界面上显示 80 KB、后端说超了 256 KB」这种怪事。
 */
export function bodyBytes(body: string): number {
  return new TextEncoder().encode(body).length;
}

/** 正文是否超过上限（与后端同一判据：**严格大于**才算超） */
export function bodyTooLarge(body: string): boolean {
  return bodyBytes(body) > MAX_BODY_BYTES;
}

/** 体积文案，例 "12.3 KB" */
export function formatKb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/** 语言/类型预设（允许自由输入，这只是常用项） */
export const LANG_PRESETS: string[] = [
  'java',
  'sql',
  'bash',
  'xml',
  'yaml',
  'json',
  'properties',
  'ts',
  'text',
];

/* =============================================
   ====== 归一化 ======
   ============================================= */

/**
 * 标题归一：折叠所有空白为单个空格后 trim。
 *
 * 与后端同一套规则：用户在弹窗里按回车会把换行带进标题，
 * 不折叠的话列表里会出现「看起来一行、实际藏着换行」的卡片。
 */
export function normalizeTitle(raw: string): string {
  return truncateStrict(raw.split(/\s+/).filter(Boolean).join(' '), MAX_TITLE_CHARS);
}

/**
 * 标签归一：按「逗号 / 中文逗号 / 空白」切开，去空、去重（大小写不敏感，保留首次写法）、
 * 单标签截断、总数封顶。
 *
 * 容错做到这个程度是有原因的：标签在界面上就是一个输入框，用户会写 `maven, 命令`、
 * 也会写 `maven，命令`（中文逗号）。原样存下去的话，界面上看起来有标签、
 * 按标签筛选却筛不出来 —— 这是最难自查的一类问题。
 */
export function normalizeTags(input: string): string[] {
  const out: string[] = [];
  for (const piece of input.split(/[,，\s]+/)) {
    const tag = truncateStrict(piece.trim(), MAX_TAG_CHARS);
    if (!tag) continue;
    if (out.some((e) => e.toLowerCase() === tag.toLowerCase())) continue;
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** 标签数组 → 输入框里的字符串（编辑时回填） */
export function tagsToInput(tags: string[]): string {
  return tags.join(', ');
}

/* =============================================
   ====== 搜索与筛选 ======
   ============================================= */

/*
 * 查询串按空白切成多个词，**每个词都要命中**（AND）。
 *
 * 单关键词的子串匹配不够用：「maven 版本」这种两段式查询在片段库里很常见
 * （一个词命中的是标题、另一个命中正文），拆开后任一顺序都能搜到。
 */
export function queryTokens(query: string): string[] {
  return query
    .split(/\s+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

/** 一条片段是否命中查询（标题 / 正文 / 标签 / 语言标记都算） */
export function matchesQuery(s: Snippet, query: string): boolean {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return true;
  const hay = `${s.title}\n${s.body}\n${s.tags.join(' ')}\n${s.lang ?? ''}`.toLowerCase();
  return tokens.every((t) => hay.includes(t));
}

/**
 * 按查询串 + 标签筛选。
 * `tag` 为 null = 不按标签筛；比较大小写不敏感（后端存的写法可能被用户改过大小写）。
 */
export function filterSnippets(list: Snippet[], query: string, tag: string | null): Snippet[] {
  const want = tag?.trim().toLowerCase() ?? '';
  return list.filter((s) => {
    if (want && !s.tags.some((t) => t.toLowerCase() === want)) return false;
    return matchesQuery(s, query);
  });
}

/** 标签统计（用于筛选栏），按出现次数倒序、同次数按名字排 */
export function tagCounts(list: Snippet[]): { tag: string; count: number }[] {
  const map = new Map<string, { tag: string; count: number }>();
  for (const s of list) {
    for (const t of s.tags) {
      const key = t.toLowerCase();
      const hit = map.get(key);
      if (hit) hit.count += 1;
      else map.set(key, { tag: t, count: 1 });
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/**
 * 高亮用的区间：**逐个查询词**各算一遍再合并。
 *
 * 不能拿整个查询串当一个短语去匹配 —— 筛选是「每个词都要命中」（见 matchesQuery），
 * 而「maven 版本」这两个词在正文里几乎不会连在一起，按整串找会一处都标不出来，
 * 界面上就成了「筛出来了但看不出为什么命中」。
 *
 * 重叠与乱序由 core/text 的 splitByRanges 处理。
 */
export function queryRanges(text: string, query: string): [number, number][] {
  const out: [number, number][] = [];
  for (const token of queryTokens(query)) out.push(...findRanges(text, token));
  return out;
}

/* =============================================
   ====== 排序 ======
   ============================================= */

export type SortMode = 'updated' | 'created' | 'used' | 'title';

export const SORT_MODES: { value: SortMode; label: string }[] = [
  { value: 'updated', label: '最近更新' },
  { value: 'created', label: '最近创建' },
  { value: 'used', label: '最近使用' },
  { value: 'title', label: '按标题' },
];

/**
 * 排序。**置顶永远在最前**，与后端 list() 的口径一致 ——
 * 用户点了置顶却发现换个排序方式就沉下去了，会以为置顶坏了。
 *
 * 每种排序都以 id 兜底：时间戳是毫秒，同一秒内连建两条会撞在同一毫秒上，
 * 没有兜底键时顺序取决于底层遍历顺序，刷新一次可能就变，看着像「乱跳」。
 */
export function sortSnippets(list: Snippet[], mode: SortMode): Snippet[] {
  const out = [...list];
  out.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    let d = 0;
    switch (mode) {
      case 'created':
        d = b.createdAt - a.createdAt;
        break;
      case 'used':
        d = (b.usedAt ?? 0) - (a.usedAt ?? 0);
        break;
      case 'title':
        d = a.title.localeCompare(b.title);
        break;
      default:
        d = b.updatedAt - a.updatedAt;
    }
    if (d !== 0) return d;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return out;
}

/* =============================================
   ====== 展示 ======
   ============================================= */

/**
 * 正文预览：最多 maxLines 行、每行最多 maxChars 字。
 *
 * 会先去掉开头的空行：从别处粘贴的片段经常带一两个前导换行，
 * 不去掉的话卡片预览是一片空白，看着像「这条是空的」。
 * `more` 表示后面还有内容没显示（界面上补一个「…」）。
 */
export function previewLines(
  body: string,
  maxLines = PREVIEW_LINES,
  maxChars = PREVIEW_LINE_CHARS,
): { lines: string[]; more: boolean } {
  const all = body.split(/\r?\n/);
  let start = 0;
  while (start < all.length && !all[start].trim()) start += 1;
  const rest = all.slice(start);
  const lines = rest.slice(0, Math.max(0, maxLines)).map((l) => truncateText(l.trimEnd(), maxChars));
  return { lines, more: rest.length > lines.length };
}

/** 行数（用于卡片上的「N 行」；空正文算 0 行） */
export function lineCount(body: string): number {
  const t = body.replace(/\r?\n$/, '');
  if (!t.trim()) return 0;
  return t.split(/\r?\n/).length;
}

/** 语言标记的展示文案 */
export function langLabel(lang: string | null): string {
  return lang && lang.trim() ? lang.trim().toUpperCase() : '文本';
}

/**
 * 相对时间。`now` 显式传入而不是内部取 Date.now() —— 否则这个函数没法断言。
 *
 * 未来时间（时钟回拨、别的机器写的时间戳）一律显示「刚刚」，
 * 不显示「-3 分钟前」这种一看就是 bug 的文案。
 */
export function formatRelative(ms: number | null, now: number): string {
  if (ms === null || !Number.isFinite(ms)) return '';
  const diff = now - ms;
  if (diff < 60_000) return '刚刚';
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 7) return `${day} 天前`;
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 卡片底部的一行摘要 */
export function summaryText(s: Snippet, now: number): string {
  const parts = [`${lineCount(s.body)} 行`, `更新于 ${formatRelative(s.updatedAt, now)}`];
  if (s.useCount > 0) parts.push(`用过 ${s.useCount} 次`);
  return parts.join(' · ');
}

/** 顶部统计文案 */
export function totalText(total: number, shown: number): string {
  if (total === 0) return '还没有片段';
  if (shown === total) return `共 ${total} 条`;
  return `筛出 ${shown} / ${total} 条`;
}
