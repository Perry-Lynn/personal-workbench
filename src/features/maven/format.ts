/*
 * Maven 助手模块 · 纯逻辑
 * ------------------------------------------------------------------
 * 不 import 任何运行时依赖（不碰 zustand / react / localStorage），
 * 以便被 scripts/logic-test.ts 直接 import 进 node 跑断言。
 * @Author: fu
 */
import type { Conflict, DepLine, DuplicateEntry, OmitReason, SizeEntry } from './types';

/* =============================================
   ====== 格式化 ======
   ============================================= */

/**
 * 字节 → 人类可读。
 *
 * 用 1024 进制但**只在跨档时**换算：仓库体积动辄几百 MB 到几 GB，
 * 显示成 "238.4 MB" 比 "249123456 字节" 有用得多；
 * 而小于 1 KB 的情况（.sha1 / _remote.repositories）直接给字节。
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  const gb = mb / 1024;
  return `${gb < 10 ? gb.toFixed(2) : gb.toFixed(1)} GB`;
}

/** 占总量的百分比（1 位小数）；总量为 0 时返回 0 而不是 NaN */
export function percentOf(part: number, total: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.round((part / total) * 1000) / 10;
}

/* =============================================
   ====== 重复版本 ======
   ============================================= */

/**
 * 清掉旧版本能释放多少字节 = 总占用 - 保留下来的那个版本。
 *
 * 「保留哪个」取**最大的那个版本**：体积最大的通常就是实际在用的那个
 * （或者至少是删起来最不划算的），按它来算才不会高估收益。
 * 用 `bytes - largestBytes` 而不是按版本数平分 —— 一个 SNAPSHOT 往往比
 * 其它版本大一个数量级，平分会算出离谱的数字。
 */
export function reclaimableBytes(dup: Pick<DuplicateEntry, 'bytes' | 'largestBytes'>): number {
  const v = dup.bytes - dup.largestBytes;
  return v > 0 ? v : 0;
}

/** 全部重复项加起来能释放多少 */
export function totalReclaimable(dups: DuplicateEntry[]): number {
  return dups.reduce((sum, d) => sum + reclaimableBytes(d), 0);
}

/** 重复项的摘要文案 */
export function dupSummary(dups: DuplicateEntry[]): string {
  if (dups.length === 0) return '没有存了多个版本的包';
  return `${dups.length} 个包存了多个版本 · 约可释放 ${formatBytes(totalReclaimable(dups))}`;
}

/* =============================================
   ====== 冲突 ======
   ============================================= */

/** 冲突摘要 */
export function conflictSummary(conflicts: Conflict[]): string {
  if (conflicts.length === 0) return '没有版本冲突';
  const n = conflicts.reduce((s, c) => s + c.losers.length, 0);
  return `${conflicts.length} 个包存在版本冲突（共 ${n} 个版本被仲裁掉）`;
}

/** 冲突的坐标（界面上显示用） */
export function conflictKey(c: Pick<Conflict, 'group' | 'artifact'>): string {
  return `${c.group}:${c.artifact}`;
}

/* =============================================
   ====== 依赖树 ======
   ============================================= */

/** 被丢弃原因 → 中文说明 */
export const OMIT_LABEL: Record<OmitReason, string> = {
  conflict: '版本冲突（仲裁输了）',
  duplicate: '重复',
  managed: '版本被 dependencyManagement 改写',
  excluded: '被排除',
  other: '其它',
};

/**
 * 依赖树里「真正被引入」的行数。
 * 用来在界面上给个直觉：树里画了很多行，但其中一部分是被划掉的。
 */
export function effectiveCount(lines: DepLine[]): number {
  return lines.filter((l) => l.omitReason === null).length;
}

/** 一行在界面上的缩进层级（depth 0 是项目自己） */
export function indentPx(depth: number): number {
  return Math.max(0, depth) * 20;
}

/** 排行条的相对宽度（0~100），用于画体积条 */
export function barWidth(entry: SizeEntry, top: SizeEntry | undefined): number {
  if (!top || top.bytes <= 0) return 0;
  return percentOf(entry.bytes, top.bytes);
}
