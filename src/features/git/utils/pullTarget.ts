/*
 * 「Pull 要拉哪个分支、要不要更新本地」的解析（纯函数，进 logic-test）
 * ------------------------------------------------------------------
 * Pull 的语义是「把所选分支更新到远端最新，且**只快进**（不产生合并提交）」。
 * 动手前必须先确定目标，而它取决于用户当前在分支列表里选了哪一条：
 *
 *   · 选中远端分支 origin/feature/x
 *       → { origin, feature/x, updateLocal:false }：只更新这一个 remote-tracking 引用，
 *         任何本地分支都不动（看远端最新用的就是这个）
 *   · 选中本地分支 feature/x（有上游 origin/feature/x）
 *       → { origin, feature/x, updateLocal:true }：把**这条**本地分支快进到远端最新
 *   · 没选（跟随 HEAD）→ 用当前分支的上游，updateLocal:true（快进当前分支）
 *   · 以上都拿不到（没有上游 / 分离头指针 / 只选了 origin/HEAD 这个别名）
 *     → 明确报出原因，**不猜**：猜错就是「拉错分支」，比不拉更糟
 *
 * ⚠️ 早先这里把「不要合并」理解成了「一个本地分支都别动」，于是 Pull 只做了 fetch，
 * 结果「落后远端 4 个提交」点完 Pull 还是落后 4 个 —— 用户要的是「拉 B 时别动我正在做的 A」，
 * 而 B 自己得更新到最新。updateLocal 就是用来区分这两件事的。
 *
 * 拆法：按**第一个**斜杠切（remote 名里不可能有斜杠，而分支名里很常见，
 * 例如 origin/demo/blufi-provisioning）。
 * @Author: fu
 */
import type { BranchInfo } from '../types';

export interface PullTarget {
  remote: string;
  branch: string;
  /**
   * true = 要把**本地分支**快进到远端最新（不产生合并提交、不碰别的分支）；
   * false = 只更新 remote-tracking 引用，任何本地分支都不动。
   */
  updateLocal: boolean;
}

export type PullResolution = { ok: true; target: PullTarget } | { ok: false; reason: string };

/** `origin/feature/x` → { remote: 'origin', branch: 'feature/x' } */
export function splitRemoteRef(name: string): { remote: string; branch: string } | null {
  const i = name.indexOf('/');
  if (i <= 0 || i === name.length - 1) return null;
  return { remote: name.slice(0, i), branch: name.slice(i + 1) };
}

export function resolvePullTarget(input: {
  /** 历史图正在查看的分支（分支列表里选中的那条）；null = 跟随 HEAD */
  viewBranch: { ref: string; label: string } | null;
  branches: { local: BranchInfo[]; remote: BranchInfo[] } | null;
  /** 当前分支的上游（来自 status / repoInfo，如 origin/main） */
  currentUpstream: string | null;
}): PullResolution {
  const { viewBranch, branches, currentUpstream } = input;
  let upstream: string | null = null;
  /* 选中本地分支（或退回到当前分支）都要更新本地；只有选远端分支时不动本地 */
  let updateLocal = true;

  if (viewBranch) {
    if (viewBranch.ref.startsWith('refs/remotes/')) {
      upstream = viewBranch.ref.slice('refs/remotes/'.length);
      updateLocal = false;
    } else if (viewBranch.ref.startsWith('refs/heads/')) {
      const b = branches?.local.find((x) => x.ref === viewBranch.ref);
      if (!b) {
        return { ok: false, reason: `找不到本地分支 ${viewBranch.label}` };
      }
      if (!b.upstream) {
        return {
          ok: false,
          reason: `分支 ${b.name} 没有上游分支 —— 先给它设置上游（git branch -u），再拉取`,
        };
      }
      upstream = b.upstream;
    } else {
      return { ok: false, reason: `看不懂的引用 ${viewBranch.ref}` };
    }
  } else {
    upstream = currentUpstream;
    if (!upstream) {
      return {
        ok: false,
        reason: '当前分支没有上游分支 —— 请在分支列表里选一条具体分支再拉取',
      };
    }
  }

  const t = splitRemoteRef(upstream);
  if (!t) {
    return { ok: false, reason: `无法从「${upstream}」解析出远端与分支名` };
  }
  /* origin/HEAD 是「远端默认分支」的别名，fetch 它不会更新任何 remote-tracking 引用 */
  if (t.branch === 'HEAD') {
    return {
      ok: false,
      reason: `${upstream} 是远端默认分支的别名（HEAD），请选择具体分支`,
    };
  }
  return { ok: true, target: { ...t, updateLocal } };
}
