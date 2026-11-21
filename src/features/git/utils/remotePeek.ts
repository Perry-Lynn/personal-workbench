/*
 * 远端分支「有新提交」的检测（纯函数 + localStorage，进 logic-test）
 * ------------------------------------------------------------------
 * 判定口径：**和上次确认过的哈希比**，不一样就是「这个远端分支动了」。
 *
 * 为什么不用「本地落后远端几个」当口径：
 *   · 那需要给每个远端分支跑一次 rev-list（你有几十条远端分支 = 几十次调用），
 *     而「引用动没动」是一次纯比对，零调用；
 *   · 而且语义更贴用户的原话 ——「检测到远端有更新之后，在远端的分支上给提示」，
 *     fetch 之后引用一动就该提示，不管本地有没有对应分支。
 *
 * 确认（清掉提示）的时机由调用方决定：**查看该分支历史**、**拉了它**、
 * 或用户显式点「清掉提示」—— 见 store 的 ackRemote。
 *
 * ⚠️ 首次见到某个仓库/引用时不提示（没有「上次」可比）：否则打开仓库瞬间
 * 每条远端分支都挂一个「有新提交」，提示就废了。
 * @Author: fu
 */
import type { BranchInfo } from '../types';

const LS_PEEK = 'workbench:git-remote-peek';
/** 最多记住几个仓库的比对基线（和最近仓库列表同一个量级） */
const REPO_MAX = 8;

/** refname → 上次确认过的 shortHash */
export type PeekMap = Record<string, string>;

/** 一条远端引用「从哪个哈希变到哪个哈希」 */
export interface RemoteUpdate {
  from: string;
  to: string;
}

/*
 * 持久化的形状：{ [仓库根]: PeekMap }。
 * 为什么要跨会话记住：昨天 fetch 出来但没处理的更新，今天打开还应该提示；
 * 只在内存里记的话，重启一次所有提示就没了。
 */
type Store = Record<string, PeekMap>;

function readStore(): Store {
  try {
    const raw = localStorage.getItem(LS_PEEK);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Store;
  } catch {
    /* localStorage 是用户可改的，坏值一律当没有 */
    return {};
  }
}

function writeStore(store: Store): void {
  try {
    /* 只保留最近 REPO_MAX 个仓库（对象键顺序即插入顺序） */
    const keys = Object.keys(store);
    const trimmed: Store = {};
    for (const k of keys.slice(-REPO_MAX)) trimmed[k] = store[k];
    localStorage.setItem(LS_PEEK, JSON.stringify(trimmed));
  } catch {
    /* 隐私模式等场景忽略 */
  }
}

/** 读出某仓库的比对基线 */
export function loadPeek(repoRoot: string): PeekMap {
  const m = readStore()[repoRoot];
  if (!m || typeof m !== 'object' || Array.isArray(m)) return {};
  const out: PeekMap = {};
  for (const [k, v] of Object.entries(m)) {
    if (typeof v === 'string' && v) out[k] = v;
  }
  return out;
}

/** 写入某仓库的比对基线 */
export function savePeek(repoRoot: string, peek: PeekMap): void {
  const store = readStore();
  store[repoRoot] = peek;
  writeStore(store);
}

/**
 * 找出「比上次确认过的哈希变了」的远端引用。
 * 没有基线（首次见到）的引用不算变化 —— 见文件头说明。
 */
export function detectUpdates(
  peek: PeekMap,
  remoteBranches: BranchInfo[],
): Record<string, RemoteUpdate> {
  const out: Record<string, RemoteUpdate> = {};
  for (const b of remoteBranches) {
    const last = peek[b.ref];
    if (last && last !== b.shortHash) {
      out[b.ref] = { from: last, to: b.shortHash };
    }
  }
  return out;
}

/** 确认一条引用（清掉它的提示）：基线推进到当前哈希 */
export function ackRef(peek: PeekMap, ref: string, hash: string): PeekMap {
  return { ...peek, [ref]: hash };
}
