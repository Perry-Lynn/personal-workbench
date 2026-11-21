/*
 * 双栏 Diff 的行配对（纯函数，进 logic-test）
 * ------------------------------------------------------------------
 * 把单栏 unified diff 的 hunk 配成「左右同高」的行对 ——
 * 左右放在**同一个列表**里渲染，滚动同步零成本（不存在两个滚动容器）。
 *
 * 配对规则（IDEA 风格）：
 *   · 上下文行 → 左右同文一对
 *   · 连续的「删除段 + 新增段」逐行配对成「修改行」（左红右绿，mod）
 *   · 配不上的多余删除行 → 右列补空（纯删除）
 *   · 配不上的多余新增行 → 左列补空（纯新增）
 * @Author: fu
 */
import type { DiffLine, Hunk, SideCell, SideRow } from '../types';

const EMPTY: SideCell = { no: null, text: null, kind: 'empty' };

/** 一个 hunk → 双栏行 */
export function hunkToRows(hunk: Hunk): SideRow[] {
  const rows: SideRow[] = [];
  const L = hunk.lines;
  let i = 0;
  while (i < L.length) {
    const line = L[i];
    if (line.kind === 'ctx') {
      rows.push({
        left: { no: line.oldNo, text: line.text, kind: 'ctx' },
        right: { no: line.newNo, text: line.text, kind: 'ctx' },
      });
      i += 1;
      continue;
    }
    /* 统一 diff 的形状永远是「先删后增」：收齐一个 del 段 + 紧随的 add 段 */
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < L.length && L[i].kind === 'del') dels.push(L[i++]);
    while (i < L.length && L[i].kind === 'add') adds.push(L[i++]);
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k += 1) {
      const d = dels[k];
      const a = adds[k];
      if (d && a) {
        /* 配对成功 = 修改行：左红右绿（都是 mod，靠左右列区分颜色） */
        rows.push({
          left: { no: d.oldNo, text: d.text, kind: 'mod' },
          right: { no: a.newNo, text: a.text, kind: 'mod' },
        });
      } else if (d) {
        rows.push({
          left: { no: d.oldNo, text: d.text, kind: 'del' },
          right: { ...EMPTY },
        });
      } else if (a) {
        rows.push({
          left: { ...EMPTY },
          right: { no: a.newNo, text: a.text, kind: 'add' },
        });
      }
    }
  }
  return rows;
}
