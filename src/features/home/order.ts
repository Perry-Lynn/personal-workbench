/*
 * 首页 · 排序纯函数
 * ------------------------------------------------------------------
 * 「顺序怎么算」的部分全在这里：不碰 React、不碰 DOM、不读 store。
 * 这样它既能被 HomeView 直接调用，也能被 scripts/logic-test.ts import 做断言 ——
 * HomeView 本身进不了 node 测试（它 import 了 antd 和 home.css）。
 * @Author: fu
 */

/**
 * 按用户记下的顺序重排。
 * 没有记录的分组原样返回；记录里没有的模块（新接入的）统一排在最后，
 * 相对顺序保持 registry 给的原序 —— 这样新模块不会插到用户排好的中间去。
 */
export function applyOrder<T extends { id: string }>(mods: T[], order?: string[]): T[] {
  if (!order || order.length === 0) return mods;
  const idx = new Map(order.map((id, i) => [id, i]));
  return [...mods].sort(
    (a, b) =>
      (idx.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (idx.get(b.id) ?? Number.MAX_SAFE_INTEGER),
  );
}

/**
 * 把 from 位置的一项挪到 to 位置。
 *
 * 泛型而不是只吃 `string[]`：首页模块列表排的是 id，世界时钟排的是整条
 * `ClockEntry` —— 两边共用这一条「怎么挪」的规则，不各写一份。
 */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = list.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * 把「当前可见模块的新顺序」合回「整组模块的完整顺序」。
 *
 * 为什么需要它：首页的拖动只看得见**没被隐藏**的模块，落盘时如果直接写这份
 * 可见列表，被隐藏的模块就从 moduleOrder 里彻底消失了 —— 用户哪天把它重新打开，
 * 它会掉到分组末尾，之前排的位置白排。
 *
 * 合并规则：隐藏项**保留自己的槽位**，可见槽位按新顺序依次填。
 *   full   [a, b, c, d]，b 被隐藏，可见顺序 [c, a, d]
 *   -> 槽 0 给 c、槽 1 留给 b、槽 2 给 a、槽 3 给 d
 *   -> [c, b, a, d]
 */
export function mergeOrder(full: string[], visible: string[]): string[] {
  const vis = new Set(visible);
  const out: string[] = [];
  let i = 0;
  for (const id of full) {
    if (!vis.has(id)) {
      out.push(id);
      continue;
    }
    if (i < visible.length) out.push(visible[i++]);
  }
  /* 可见列表里出现了 full 里没有的 id（理论上不会，防御一下）：补在末尾，别丢 */
  while (i < visible.length) out.push(visible[i++]);
  return out;
}
