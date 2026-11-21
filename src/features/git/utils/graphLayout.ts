/*
 * 提交图的 lane 布局（纯函数，进 logic-test）
 * ------------------------------------------------------------------
 * 不解析 `git log --graph` 的 ASCII 画（换个 git 版本/宽度就对不上），
 * 而是拿 topo 序提交的 parent 链接**自己算 lane**，渲染层只管画。
 *
 * 输入顺序要求：`git log --topo-order`（子先于父）。
 *
 * 每行的画法由三段构成，缺一段就会画出「断头线」：
 *   passThrough  上一行流下来、本行继续往下的竖线（贯穿整行 y=0→h）
 *   incoming     本提交自身 lane 从行顶到圆点的上半截（y=0→h/2，仅当有子提交在上一行）
 *   edges        从圆点连到行底的每一笔（y=h/2→h，每个父提交一笔；跨 lane 走曲线）
 *
 * ⚠️ 两条「不要」是踩过坑才写下的：
 *   · 新开的 lane **不进 passThrough** —— 它这一行才第一次出现，行顶还没有它；
 *     当成贯穿线画就会出现一条凭空冒出来、超出且没有圆点的线；
 *   · 本提交自身 lane **不进 passThrough** —— 它的上半截由 incoming 单独负责，
 *     否则合并提交那行会在圆点上方多出一截。
 * @Author: fu
 */
import type { GraphEdge, GraphRowData } from '../types';

export interface LayoutCommit {
  hash: string;
  parents: string[];
}

/** 布局一行需要的最小输入 */
export function layoutGraph(commits: LayoutCommit[]): GraphRowData[] {
  /** 每条 lane 当前追踪的提交 hash；null = 空闲 */
  const lanes: (string | null)[] = [];
  const rows: GraphRowData[] = [];

  /** 占一条最小空闲 lane（没有就往后加） */
  const allocLane = (): number => {
    const free = lanes.indexOf(null);
    if (free !== -1) return free;
    lanes.push(null);
    return lanes.length - 1;
  };

  for (const c of commits) {
    let lane = lanes.indexOf(c.hash);
    /* 找到 = 有子提交在上一行把线交给了它，行顶已经有线 */
    const incoming = lane !== -1;
    if (lane === -1) lane = allocLane();

    /*
     * 贯穿线要在「处理本提交之前」取快照，并排除本提交自身 lane ——
     * 见文件头的两条「不要」。
     */
    const passThrough: number[] = [];
    lanes.forEach((h, idx) => {
      if (idx !== lane && h !== null) passThrough.push(idx);
    });

    /* 本 lane 腾空，下面按父提交重新布线 */
    lanes[lane] = null;

    const edges: GraphEdge[] = [];
    const [first, ...rest] = c.parents;
    if (first !== undefined) {
      const tracked = lanes.indexOf(first);
      if (tracked === -1) {
        lanes[lane] = first; // 主线延续
        edges.push({ to: lane, curve: false });
      } else {
        edges.push({ to: tracked, curve: tracked !== lane }); // 两线在父提交汇合
      }
    }
    for (const p of rest) {
      const m = lanes.indexOf(p);
      if (m === -1) {
        const nl = allocLane();
        lanes[nl] = p;
        edges.push({ to: nl, curve: true }); // 合并引出的支线
      } else if (m !== lane) {
        edges.push({ to: m, curve: true }); // 支线汇合到已有 lane
      }
    }

    rows.push({ lane, edges, passThrough, incoming, merge: c.parents.length > 1 });
  }
  return rows;
}

/** 图的最大 lane 数（SVG 宽度用） */
export function maxLanes(rows: GraphRowData[]): number {
  let n = 1;
  for (const r of rows) {
    n = Math.max(n, r.lane + 1);
    for (const l of r.passThrough) n = Math.max(n, l + 1);
    for (const e of r.edges) n = Math.max(n, e.to + 1);
  }
  return n;
}
