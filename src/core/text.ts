/*
 * 通用文本处理
 * ------------------------------------------------------------------
 * 放「跨模块共用」的纯文本能力。模块之间不互相引用，共用逻辑一律上收到 core。
 *
 * 现在有四件事：
 *   · splitByRanges  按区间把文本切成段（供界面染色）
 *   · findRanges     找出一个关键词在文本里的全部出现位置（大小写不敏感）
 *   · highlightQuery 上面两个的组合：直接给「关键词 → 可渲染的段」
 *   · truncateText   过长文本截断加省略号（显示用）
 *   · truncateStrict 精确截断到 N 个字符，不加省略号（归一化 / 落库用）
 *
 * 约束：本文件是**纯函数**，不 import 任何运行时依赖（不碰 react / zustand / Tauri），
 * 以便 scripts/logic-test.ts 直接 import 进 node 跑断言。
 * @Author: fu
 */

/* =============================================
   ====== 截断 ======
   ============================================= */

/**
 * 过长文本截断并补省略号 —— **给显示用**。
 *
 * 注意省略号本身**不计入** max：调用方给 4 是想要「4 个字符 + 省略号」。
 * 这是给「列表里一行」用的，完整内容仍然留在数据里（复制按钮拿的是原值）。
 */
export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

/**
 * 精确截断到 max 个字符，**不加省略号** —— 给「归一化/落库」用。
 *
 * 和 truncateText 分成两个函数是有具体教训的：片段库的标题归一原本用了带省略号的版本，
 * 于是前端算出 121 个字符、后端按 120 截断，落盘时把省略号也切掉了 ——
 * 界面上显示的和真正存下来的差一个字符，而且只在超长时才出现。
 * 归一化的语义是「值就是这么多」，省略号是「这里被我省略了」的展示语义，两者不能混。
 *
 * 与 Rust 侧 models.rs::truncate_chars 逐字符对齐（那边按 char 数，不是字节数）。
 */
export function truncateStrict(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}


/* =============================================
   ====== 按区间切段 ======
   ============================================= */

export interface TextSegment {
  text: string;
  hit: boolean;
}

/**
 * 把一行按命中区间切成若干段（供界面染色）。
 *
 * 区间可能重叠或乱序（正则的多个匹配、后端并发汇总），所以先排序；
 * 越界的区间直接裁掉而不是抛错 —— 一行文本显示不全比整个结果列表崩掉好。
 */
export function splitByRanges(line: string, ranges: [number, number][]): TextSegment[] {
  if (ranges.length === 0) return [{ text: line, hit: false }];

  const sorted = ranges
    .map(([s, e]) => [Math.max(0, s), Math.min(line.length, e)] as [number, number])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);

  const out: TextSegment[] = [];
  let cursor = 0;
  for (const [start, end] of sorted) {
    if (start < cursor) continue; /* 与已处理区间重叠，跳过 */
    if (start > cursor) out.push({ text: line.slice(cursor, start), hit: false });
    out.push({ text: line.slice(start, end), hit: true });
    cursor = end;
  }
  if (cursor < line.length) out.push({ text: line.slice(cursor), hit: false });
  return out.length > 0 ? out : [{ text: line, hit: false }];
}

/* =============================================
   ====== 找关键词位置 ======
   ============================================= */

/*
 * 高亮段数上限。
 *
 * 不是为了省性能，而是为了**不让界面融化**：查询词短（比如 "a"）而正文长时，
 * 一次能匹配出上千段，切完就是上千个 <span> —— React 渲染这些节点比匹配本身贵得多，
 * 而且到了这个密度，高亮已经糊成一片、根本看不出命中在哪。
 * 超过上限就只保留前 N 段。
 */
export const MAX_HIGHLIGHTS = 200;

/* 把字符串里的正则元字符转义掉：用户搜 "List<String>" 时不该被当成正则 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 找出关键词在文本里的全部出现位置（大小写不敏感，非重叠）。
 *
 * 用正则 + `gi` 而不是 `toLowerCase().indexOf()`：后者在**大小写折叠会改变长度**的
 * 字符上（如 'İ'.toLowerCase() 长度为 2）算出的下标会整体错位，切出来的高亮会串位。
 * 正则是对**原文**匹配的，`m.index` 天然就是原文下标，不存在这个问题。
 */
export function findRanges(text: string, query: string, limit = MAX_HIGHLIGHTS): [number, number][] {
  const q = query.trim();
  if (!q || limit <= 0) return [];

  const re = new RegExp(escapeRegExp(q), 'gi');
  const out: [number, number][] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push([m.index, m.index + m[0].length]);
    if (out.length >= limit) break;
    /*
     * 零宽匹配会永远停在原地，必须手动推进 lastIndex，否则死循环。
     * 当前 query 已 trim 且非空，理论上匹配不到空串，但这条兜底的成本是零。
     */
    if (m[0].length === 0) re.lastIndex += 1;
  }
  return out;
}

/** 关键词高亮：一步得到可直接渲染的段列表 */
export function highlightQuery(text: string, query: string, limit = MAX_HIGHLIGHTS): TextSegment[] {
  return splitByRanges(text, findRanges(text, query, limit));
}
