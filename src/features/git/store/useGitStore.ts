/*
 * Git 管理模块 · 状态与动作
 * ------------------------------------------------------------------
 * 所有 git 操作的编排都在这里：IPC → 解析 → 状态刷新。
 * 组件只读状态、调动作，不直接 invoke。
 *
 * 刷新纪律：任何写操作成功后走 refresh()（status + branches + ahead/behind），
 * 保证「提交完左侧列表消失、分支面板同步」这类一致性不留窗口期。
 * @Author: fu
 */
import { create } from 'zustand';
import { pushEvent } from '@/core/events';
import * as api from '../ipc';
import { parseBranches, splitBranches } from '../utils/parseBranches';
import { parseDiff } from '../utils/parseDiff';
import { parseLog } from '../utils/parseLog';
import { parseStatus, totalChanged } from '../utils/parseStatus';
import { resolvePullTarget } from '../utils/pullTarget';
import { parseRemotes } from '../utils/remotes';
import type { RemoteInfo } from '../utils/remotes';
import { ackRef, detectUpdates, loadPeek, savePeek } from '../utils/remotePeek';
import type { PeekMap } from '../utils/remotePeek';
import type {
  BranchInfo,
  ChangeFile,
  ChangeGroup,
  Commit,
  FileDiff,
  GitOperationState,
  OpResult,
  RepoInfo,
  StatusResult,
} from '../types';

/** 每批加载的提交数 */
export const LOG_PAGE = 200;

const LS_RECENT = 'workbench:git-recent-repos';
const RECENT_MAX = 8;

/** 最近仓库列表：localStorage 是用户可改的，坏值一律丢掉 */
function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(LS_RECENT);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === 'string' && s.trim() !== '').slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

function persistRecent(list: string[]): void {
  try {
    localStorage.setItem(LS_RECENT, JSON.stringify(list.slice(0, RECENT_MAX)));
  } catch {
    /* 隐私模式等场景忽略 */
  }
}

/**
 * 往工作台事件流记一条。
 *
 * 只记**成功的写操作**（提交 / 推送 / 拉取 / 切换 / 合并 / 删分支）：
 * 失败已经在模块内的 notice 条上说明白了，再往时间线记一条
 * 会把首页变成错误列表。tone 只区分「正常」和「有冲突」两档。
 *
 * 抽成函数而不是每处直接 pushEvent：模块 id 与 detail 的口径要一致，
 * 否则时间线里同一件事三种写法。
 */
function noteGit(title: string, detail: string, tone: 'ok' | 'warn' = 'ok'): void {
  pushEvent({ module: 'git', tone, title, detail });
}

/** 当前选中的文件（决定 Diff 区显示什么） */
export interface FileSelection {
  group: ChangeGroup;
  file: ChangeFile;
}

/** 提交详情（点提交图某行时展示） */
export interface CommitDetail {
  meta: Commit | null;
  diff: FileDiff[];
  loading: boolean;
}

export interface Notice {
  type: 'success' | 'error' | 'warning';
  text: string;
  /** 冲突文件清单（merge/pull 遇冲突时） */
  conflicts?: string[];
}

/** 一条「未确认」的远端更新（分支面板上亮标记用） */
export interface RemoteUpdateMark {
  /** 多出来的提交数；null = 算不出来（旧引用已被回收） */
  count: number | null;
  to: string;
}

export interface GitState {
  /* 仓库 */
  recentRepos: string[];
  repoRoot: string | null;
  repoInfo: RepoInfo | null;
  repoLoading: boolean;

  /* 变更 */
  status: StatusResult | null;
  operationState: GitOperationState;

  /* 选择与 diff */
  selection: FileSelection | null;
  fileDiff: FileDiff[] | null;
  diffLoading: boolean;

  /* 提交 */
  message: string;

  /* 提交历史 */
  commits: Commit[];
  logLoading: boolean;
  logHasMore: boolean;
  selectedCommit: string | null;
  commitDetail: CommitDetail | null;
  /**
   * 历史图当前查看的是哪个分支。
   * null = 跟随当前 HEAD；非 null = 正在看某个分支（含远端分支）的历史，
   * **只是看，不会切换分支**（纯本地读引用，不联网、不动工作区）。
   */
  viewBranch: { ref: string; label: string } | null;

  /* 分支 */
  branches: { local: BranchInfo[]; remote: BranchInfo[] } | null;
  /**
   * 远端列表（含「托管在哪」的平台判定）。
   * null = 这个仓库还没读过；[] = 读过了但一个远端都没配（纯本地仓库）。
   * 与 branches 不同：远端配置基本不变，所以只在换仓库后的第一次 refresh 读一次。
   */
  remotes: RemoteInfo[] | null;
  /**
   * 远端引用「上次确认过的哈希」比对基线（持久化到 localStorage）。
   * 超出基线 = 这个远端分支有新提交 → remoteUpdates 里亮标记。
   */
  peek: PeekMap;
  /** 当前未确认的远端更新（refname → 标记） */
  remoteUpdates: Record<string, RemoteUpdateMark>;

  /* 进行中的远端/写操作 */
  ops: { fetch: boolean; pull: boolean; push: boolean; commit: boolean; checkout: boolean; conflict: boolean };

  /**
   * 模块是否在前台。由 index.tsx 的 onActivate/onDeactivate 维护 ——
   * 轮询只在「有人看着」时跑（见 prefs.ts 的 shouldPoll）。
   */
  active: boolean;
  setActive: (v: boolean) => void;

  notice: Notice | null;

  /* ===== 动作 ===== */
  openRepo: (path: string) => Promise<void>;
  forgetRepo: (path: string) => void;
  /** silent = 后台轮询发起的刷新：失败不弹提示，免得每 5 秒刷一个红条 */
  refresh: (opts?: { silent?: boolean }) => Promise<void>;
  setMessage: (msg: string) => void;
  selectFile: (group: ChangeGroup, file: ChangeFile) => Promise<void>;
  clearSelection: () => void;
  stage: (paths: string[]) => Promise<void>;
  unstage: (paths: string[]) => Promise<void>;
  stageHunk: (path: string, patch: string, reverse: boolean) => Promise<void>;
  commit: (opts?: { amend?: boolean; push?: boolean }) => Promise<void>;
  fetch: () => Promise<void>;
  /**
   * 拉取**所选分支**：把它更新到远端最新。
   * 选中的是本地分支 → 把那条本地分支**快进**到远端（不产生合并提交）；
   * 选中的是远端分支 → 只更新 remote-tracking 引用。
   * 具体走 fetch / refspec fetch / merge --ff-only 由后端按 HEAD 实际状态定。
   */
  pullSelectedBranch: () => Promise<void>;
  /**
   * 比对远端引用与上次确认的哈希，标出「有新提交」的分支。
   * 只读、不改任何东西；首次见到某引用不标记（没基线可比）。
   */
  detectRemoteChanges: (remote: BranchInfo[]) => Promise<void>;
  /** 确认一条远端分支的更新（清掉它的标记）：基线推进到当前哈希 */
  ackRemote: (ref: string) => void;
  /** 确认所有远端分支的更新标记 */
  clearRemoteUpdates: () => void;
  push: () => Promise<void>;
  loadLog: (reset: boolean) => Promise<void>;
  /** 切换历史图查看的分支；传 null 回到当前 HEAD。不切换分支、不联网 */
  viewBranchLog: (branch: { ref: string; label: string } | null) => void;
  selectCommit: (hash: string) => Promise<void>;
  checkout: (refName: string, newBranch?: string) => Promise<void>;
  deleteBranch: (refName: string, force: boolean) => Promise<void>;
  mergeBranch: (refName: string) => Promise<void>;
  runConflictAction: (expectedRoot: string, kind: 'open' | 'resolve' | 'resolve-binary' | 'continue' | 'abort', path?: string) => Promise<OpResult>;
  clearNotice: () => void;
}

/**
 * refresh 是否正在进行中。
 * 刻意做成模块级变量而不是 state：它只是重入锁，让它进 state 会白触发一轮重渲染。
 */
const refreshingRoots = new Set<string>();
let logRequest = 0;
let openRepoRequest = 0;
let criticalWriteBusy = false;

export const useGitStore = create<GitState>((set, get) => ({
  recentRepos: loadRecent(),
  repoRoot: null,
  repoInfo: null,
  repoLoading: false,
  status: null,
  operationState: { kind: 'none', conflicts: [] },
  selection: null,
  fileDiff: null,
  diffLoading: false,
  message: '',
  commits: [],
  logLoading: false,
  logHasMore: true,
  selectedCommit: null,
  commitDetail: null,
  viewBranch: null,
  branches: null,
  remotes: null,
  peek: {},
  remoteUpdates: {},
  ops: { fetch: false, pull: false, push: false, commit: false, checkout: false, conflict: false },
  active: false,
  notice: null,

  openRepo: async (path) => {
    if (criticalWriteBusy) { set({ notice: { type: 'warning', text: 'Git 正在切换分支或合并，请完成后再打开其他仓库。' } }); return; }
    const request = ++openRepoRequest;
    set({ repoLoading: true });
    try {
      const info = await api.openRepo(path);
      if (request !== openRepoRequest) return;
      const recent = [info.root, ...get().recentRepos.filter((r) => r !== info.root)].slice(0, RECENT_MAX);
      persistRecent(recent);
      set({
        repoRoot: info.root,
        repoInfo: info,
        status: null,
        branches: null,
        /* 换仓库 = 换一套远端配置；第一次 refresh 会重新读（见 refresh 里的 needRemotes） */
        remotes: null,
        operationState: { kind: 'none', conflicts: [] },
        recentRepos: recent,
        selection: null,
        fileDiff: null,
        commits: [],
        logLoading: false,
        logHasMore: true,
        selectedCommit: null,
        commitDetail: null,
        viewBranch: null,
        notice: null,
        /* 换仓库 = 换一套比对基线；未确认的标记也不该跟过来 */
        peek: loadPeek(info.root),
        remoteUpdates: {},
      });
      await get().refresh();
      if (request !== openRepoRequest) return;
      await get().loadLog(true);
    } catch (e) {
      if (request === openRepoRequest) set({ notice: { type: 'error', text: e instanceof Error ? e.message : String(e) } });
    } finally {
      if (request === openRepoRequest) set({ repoLoading: false });
    }
  },

  forgetRepo: (path) => {
    const recent = get().recentRepos.filter((r) => r !== path);
    persistRecent(recent);
    set({ recentRepos: recent });
  },

  setActive: (v) => set({ active: v }),

  refresh: async (opts) => {
    const root = get().repoRoot;
    if (!root) return;
    /*
     * 重入保护：轮询和用户手动刷新可能撞在一起（一次 refresh 是三条并发 IPC），
     * 两个刷新交错会让先发的旧结果后到、把新数据盖掉。
     * 后到的那次直接跳过 —— 在飞的那次跑完照样会把状态刷新。
     */
    if (refreshingRoots.has(root)) return;
    refreshingRoots.add(root);
    try {
      /*
       * 三件套一起刷：状态 / 分支 / 领先落后。
       * 工具栏的 ↑↓ 要跟着动 —— push/pull/checkout 后如果不刷 repoInfo，
       * 箭头会永远停在「打开仓库那一刻」的数字上（静默的陈旧数据）。
       *
       * 远端列表只在**换仓库后的第一次**顺手读：它来自 .git/config，不随工作区变化，
       * 每 5 秒轮询都跑一次纯属白花一个进程（失败也不该拖垮整轮刷新，故 catch 成 null）。
       */
      const needRemotes = get().remotes === null;
      const [raw, brRaw, ab, operationState, remRaw] = await Promise.all([
        api.gitStatus(root),
        api.gitBranches(root),
        api.gitAheadBehind(root),
        api.gitOperationState(root),
        needRemotes ? api.gitRemotes(root).catch(() => null) : Promise.resolve(null),
      ]);
      if (get().repoRoot !== root) return;
      const status = parseStatus(raw.stdout);
      const branches = splitBranches(parseBranches(brRaw.stdout));
      const prev = get().repoInfo;
      if (prev) {
        set({
          repoInfo: {
            ...prev,
            branch: status.branch,
            detached: status.detached,
            upstream: status.upstream,
            ahead: ab.ahead,
            behind: ab.behind,
          },
        });
      }
      /* 选中的文件没了（已提交/撤销）就清掉 diff，别对着旧 diff 发呆 */
      const sel = get().selection;
      let selection = sel;
      if (sel) {
        const stillThere = status[sel.group].some((f) => f.path === sel.file.path);
        if (!stillThere) selection = null;
      }
      set({ status, branches, selection, fileDiff: selection ? get().fileDiff : null, operationState });
      if (remRaw) set({ remotes: parseRemotes(remRaw.stdout) });
      /* 远端引用有没有动（纯比对，失败与否都不影响这次刷新的结果） */
      await get().detectRemoteChanges(branches.remote);
    } catch (e) {
      /* 轮询发起的刷新失败只吞掉：否则仓库一旦读不到，每 5 秒就弹一个红条 */
      if (!opts?.silent) {
        set({ notice: { type: 'error', text: e instanceof Error ? e.message : String(e) } });
      }
    } finally {
      refreshingRoots.delete(root);
    }
  },

  setMessage: (msg) => set({ message: msg }),

  selectFile: async (group, file) => {
    const root = get().repoRoot;
    if (!root) return;
    set({ selection: { group, file }, diffLoading: true, selectedCommit: null, commitDetail: null });
    try {
      /* 冲突文件不给 diff（v1 不做冲突合并工具），提示去外部解决 */
      if (group === 'conflicted') {
        set({ fileDiff: null, diffLoading: false });
        return;
      }
      const kind = group === 'staged' ? 'staged' : group === 'untracked' ? 'untracked' : 'unstaged';
      const raw = await api.gitDiff(root, kind, file.path);
      set({ fileDiff: parseDiff(raw.stdout), diffLoading: false });
    } catch (e) {
      set({
        diffLoading: false,
        notice: { type: 'error', text: e instanceof Error ? e.message : String(e) },
      });
    }
  },

  clearSelection: () => set({ selection: null, fileDiff: null }),

  stage: async (paths) => {
    const root = get().repoRoot;
    if (!root || paths.length === 0) return;
    if (criticalWriteBusy || get().ops.conflict) { set({ notice: { type: 'warning', text: '另一个 Git 写操作正在进行。' } }); return; }
    try {
      const r = await api.gitStage(root, paths);
      if (!r.ok) set({ notice: { type: 'error', text: r.message } });
      await get().refresh();
    } catch (e) {
      set({ notice: { type: 'error', text: e instanceof Error ? e.message : String(e) } });
    }
  },

  unstage: async (paths) => {
    const root = get().repoRoot;
    if (!root || paths.length === 0) return;
    if (criticalWriteBusy || get().ops.conflict) { set({ notice: { type: 'warning', text: '另一个 Git 写操作正在进行。' } }); return; }
    try {
      const r = await api.gitUnstage(root, paths);
      if (!r.ok) set({ notice: { type: 'error', text: r.message } });
      await get().refresh();
    } catch (e) {
      set({ notice: { type: 'error', text: e instanceof Error ? e.message : String(e) } });
    }
  },

  stageHunk: async (path, patch, reverse) => {
    const root = get().repoRoot;
    if (!root) return;
    if (criticalWriteBusy || get().ops.conflict) { set({ notice: { type: 'warning', text: '另一个 Git 写操作正在进行。' } }); return; }
    try {
      const r = await api.gitStageHunk(root, path, patch, reverse);
      if (!r.ok) set({ notice: { type: 'error', text: r.message } });
      await get().refresh();
      /* 暂存状态变了，当前文件的 diff 也变了（staged/unstaged 视角切换）——重取 */
      const sel = get().selection;
      if (sel && sel.file.path === path) await get().selectFile(sel.group, sel.file);
    } catch (e) {
      set({ notice: { type: 'error', text: e instanceof Error ? e.message : String(e) } });
    }
  },

  commit: async (opts) => {
    const root = get().repoRoot;
    if (!root) return;
    if (criticalWriteBusy || get().ops.conflict) { set({ notice: { type: 'warning', text: '另一个 Git 写操作正在进行。' } }); return; }
    if (get().operationState.kind === 'merge') {
      set({ notice: { type: 'warning', text: '当前 merge 尚未结束，请在冲突面板解决冲突后使用“继续合并”完成提交。' } });
      return;
    }
    if (opts?.amend && get().operationState.kind !== 'none') {
      set({ notice: { type: 'warning', text: `当前有 ${get().operationState.kind} 操作，无法修补提交。` } });
      return;
    }
    const message = get().message;
    set((s) => ({ ops: { ...s.ops, commit: true } }));
    try {
      const r = await api.gitCommit(root, message, opts?.amend ?? false);
      if (!r.ok) {
        set({ notice: { type: 'error', text: r.message } });
        return;
      }
      set({ message: '', notice: { type: 'success', text: '已提交' } });
      noteGit(opts?.amend ? '已修补提交' : '已提交', message.trim());
      await get().refresh();
      await get().loadLog(true);
      if (opts?.push) await get().push();
    } catch (e) {
      set({ notice: { type: 'error', text: e instanceof Error ? e.message : String(e) } });
    } finally {
      set((s) => ({ ops: { ...s.ops, commit: false } }));
    }
  },

  fetch: async () => {
    const root = get().repoRoot;
    if (!root) return;
    if (criticalWriteBusy || get().ops.conflict) { set({ notice: { type: 'warning', text: '另一个 Git 写操作正在进行。' } }); return; }
    set((s) => ({ ops: { ...s.ops, fetch: true } }));
    try {
      const r = await api.gitFetch(root);
      set({
        notice: r.ok
          ? { type: 'success', text: r.message }
          : { type: 'error', text: r.message },
      });
      await get().refresh();
      await get().loadLog(true);
    } catch (e) {
      set({ notice: { type: 'error', text: e instanceof Error ? e.message : String(e) } });
    } finally {
      set((s) => ({ ops: { ...s.ops, fetch: false } }));
    }
  },

  detectRemoteChanges: async (remoteBranches) => {
    const root = get().repoRoot;
    if (!root) return;
    const changed = detectUpdates(get().peek, remoteBranches);
    const changedRefs = new Set(Object.keys(changed));
    /* 只留下仍然「未确认」的标记：用户看过/拉过的那条，基线已推进，自然消失 */
    const kept: Record<string, RemoteUpdateMark> = {};
    for (const [ref, mark] of Object.entries(get().remoteUpdates)) {
      if (changedRefs.has(ref)) kept[ref] = mark;
    }
    /*
     * 只有「新出现的」或「哈希又变了」的才需要算个数 ——
     * 正常一轮 0~2 条，所以这个 rev-list 不会每 5 秒都跑。
     */
    const needCount = Object.entries(changed).filter(([ref, u]) => kept[ref]?.to !== u.to);
    if (needCount.length === 0) {
      set({ remoteUpdates: kept });
      return;
    }
    const counted = await Promise.all(
      needCount.map(async ([ref, u]) => {
        let count: number | null = null;
        try {
          count = await api.gitCountBetween(root, u.from, u.to);
        } catch {
          /* 旧引用已被回收（force push / gc）：只提示「有更新」，不给个数 */
        }
        return [ref, { count, to: u.to }] as const;
      }),
    );
    set({ remoteUpdates: { ...kept, ...Object.fromEntries(counted) } });
  },

  ackRemote: (ref) => {
    const root = get().repoRoot;
    if (!root) return;
    const b = get().branches?.remote.find((x) => x.ref === ref);
    /* 引用已经不在了（被 prune 掉）：没有基线可推进，只把标记去掉 */
    const peek = b ? ackRef(get().peek, ref, b.shortHash) : get().peek;
    if (b) savePeek(root, peek);
    const rest = { ...get().remoteUpdates };
    delete rest[ref];
    set({ peek, remoteUpdates: rest });
  },

  clearRemoteUpdates: () => {
    for (const ref of Object.keys(get().remoteUpdates)) get().ackRemote(ref);
  },

  pullSelectedBranch: async () => {
    const root = get().repoRoot;
    if (!root) return;
    if (criticalWriteBusy || get().ops.conflict) { set({ notice: { type: 'warning', text: '另一个 Git 写操作正在进行。' } }); return; }
    /*
     * 先把「要拉哪个远端分支」定下来 —— 定不下来就**不猜**，只说明原因。
     * 猜错的代价是「你以为拉了 A，实际动了 B」，比不拉严重得多。
     */
    const r = resolvePullTarget({
      viewBranch: get().viewBranch,
      branches: get().branches,
      currentUpstream: get().status?.upstream ?? get().repoInfo?.upstream ?? null,
    });
    if (!r.ok) {
      set({ notice: { type: 'warning', text: r.reason } });
      return;
    }
    const ref = `refs/remotes/${r.target.remote}/${r.target.branch}`;
    set((s) => ({ ops: { ...s.ops, pull: true } }));
    try {
      const res = await api.gitPullBranch(
        root,
        r.target.remote,
        r.target.branch,
        r.target.updateLocal,
      );
      set({
        notice: res.ok ? { type: 'success', text: res.message } : { type: 'error', text: res.message },
      });
      if (res.ok) noteGit('已拉取', `${r.target.remote}/${r.target.branch}`);
      await get().refresh();
      /* 这条引用是我们刚拉的：直接确认掉，免得它立刻又亮起「有新提交」 */
      if (res.ok) get().ackRemote(ref);
      await get().loadLog(true);
    } catch (e) {
      set({ notice: { type: 'error', text: e instanceof Error ? e.message : String(e) } });
    } finally {
      set((s) => ({ ops: { ...s.ops, pull: false } }));
    }
  },

  push: async () => {
    const root = get().repoRoot;
    if (!root) return;
    if (criticalWriteBusy || get().ops.conflict) { set({ notice: { type: 'warning', text: '另一个 Git 写操作正在进行。' } }); return; }
    set((s) => ({ ops: { ...s.ops, push: true } }));
    try {
      const r = await api.gitPush(root);
      set({
        notice: r.ok
          ? { type: 'success', text: r.message }
          : { type: 'error', text: r.message },
      });
      if (r.ok) noteGit('已推送', r.message);
      await get().refresh();
    } catch (e) {
      set({ notice: { type: 'error', text: e instanceof Error ? e.message : String(e) } });
    } finally {
      set((s) => ({ ops: { ...s.ops, push: false } }));
    }
  },

  loadLog: async (reset) => {
    const root = get().repoRoot;
    if (!root || get().logLoading) return;
    if (!reset && !get().logHasMore) return;
    const request = ++logRequest;
    /* 查看中的分支（完整 refname）—— 传了就取它的历史，没传就是 HEAD */
    const scope = get().viewBranch;
    set({ logLoading: true });
    try {
      const skip = reset ? 0 : get().commits.length;
      const raw = await api.gitLog(root, skip, LOG_PAGE, scope?.ref);
      const page = parseLog(raw.stdout);
      if (get().repoRoot !== root || request !== logRequest) return;
      set((s) => ({
        commits: reset ? page : [...s.commits, ...page],
        logHasMore: page.length === LOG_PAGE,
        logLoading: false,
      }));
    } catch (e) {
      if (get().repoRoot !== root || request !== logRequest) return;
      /* 空仓库的 git log 会报「没有任何提交」——按空历史处理，不弹错 */
      set({ logLoading: false, logHasMore: false });
      if (reset) set({ commits: [] });
      if (scope) {
        /*
         * 指定引用的历史读不出来（最常见：远端分支还没有本地的 remote-tracking ref）。
         * 退回当前分支并把原因说清楚，而不是停在一个空图上。
         */
        set({
          viewBranch: null,
          notice: { type: 'warning', text: e instanceof Error ? e.message : String(e) },
        });
        await get().loadLog(true);
      }
    }
  },

  viewBranchLog: (branch) => {
    if (!get().repoRoot) return;
    /* 只改「看哪个分支」，不动工作区、不切换分支 */
    set({ viewBranch: branch, selectedCommit: null, commitDetail: null });
    /* 看了它的历史 = 这些新提交已经过眼了，把标记清掉 */
    if (branch?.ref.startsWith('refs/remotes/')) get().ackRemote(branch.ref);
    void get().loadLog(true);
  },

  selectCommit: async (hash) => {
    const root = get().repoRoot;
    if (!root) return;
    set({
      selectedCommit: hash,
      selection: null,
      fileDiff: null,
      commitDetail: { meta: null, diff: [], loading: true },
    });
    try {
      const raw = await api.gitShow(root, hash);
      /* git_show 拼接：元信息段在前（以 \x1e 结尾），后面是 diff */
      const rs = raw.stdout.indexOf('\x1e');
      const metaRaw = rs === -1 ? raw.stdout : raw.stdout.slice(0, rs + 1);
      const diffRaw = rs === -1 ? '' : raw.stdout.slice(rs + 1);
      const [meta] = parseLog(metaRaw);
      set({ commitDetail: { meta: meta ?? null, diff: parseDiff(diffRaw), loading: false } });
    } catch (e) {
      set({
        commitDetail: { meta: null, diff: [], loading: false },
        notice: { type: 'error', text: e instanceof Error ? e.message : String(e) },
      });
    }
  },

  checkout: async (refName, newBranch) => {
    const root = get().repoRoot;
    if (!root) return;
    if (get().repoLoading) { set({ notice: { type: 'warning', text: '仓库状态正在加载，请稍后再切换分支。' } }); return; }
    if (criticalWriteBusy) { set({ notice: { type: 'warning', text: '另一个 Git 分支操作正在进行。' } }); return; }
    if (get().operationState.kind !== 'none') { set({ notice: { type: 'warning', text: `当前 ${get().operationState.kind} 操作未结束，请先完成或在支持时中止。` } }); return; }
    criticalWriteBusy = true;
    set((s) => ({ ops: { ...s.ops, checkout: true } }));
    try {
      const r = await api.gitCheckout(root, refName, newBranch);
      if (get().repoRoot !== root) return;
      set({
        notice: r.ok
          ? { type: 'success', text: r.message }
          : { type: 'warning', text: r.message },
      });
      /* 切走了 HEAD：历史图回到「跟随当前分支」，否则会停在旧分支的图上 */
      if (r.ok) {
        set({ viewBranch: null });
        noteGit(newBranch ? '新建并切换到分支' : '切换到分支', newBranch || refName);
      }
      await get().refresh();
      await get().loadLog(true);
    } catch (e) {
      set({ notice: { type: 'error', text: e instanceof Error ? e.message : String(e) } });
    } finally {
      set((s) => ({ ops: { ...s.ops, checkout: false } }));
      criticalWriteBusy = false;
    }
  },

  deleteBranch: async (refName, force) => {
    const root = get().repoRoot;
    if (!root) return;
    try {
      const r = await api.gitDeleteBranch(root, refName, force);
      set({
        notice: r.ok
          ? { type: 'success', text: r.message }
          : { type: 'warning', text: r.message },
      });
      /* 删掉的正是正在查看的那条分支：历史图退回当前分支 */
      if (r.ok && get().viewBranch?.ref === refName) {
        set({ viewBranch: null });
        await get().loadLog(true);
      }
      if (r.ok) noteGit('删除了分支', refName);
      await get().refresh();
    } catch (e) {
      set({ notice: { type: 'error', text: e instanceof Error ? e.message : String(e) } });
    }
  },

  mergeBranch: async (refName) => {
    const root = get().repoRoot;
    if (!root) return;
    if (criticalWriteBusy) { set({ notice: { type: 'warning', text: '另一个 Git 分支操作正在进行。' } }); return; }
    if (get().operationState.kind !== 'none') { set({ notice: { type: 'warning', text: `当前 ${get().operationState.kind} 操作未结束，请先完成或在支持时中止。` } }); return; }
    criticalWriteBusy = true;
    try {
      const r = await api.gitMerge(root, refName);
      if (get().repoRoot !== root) return;
      if (r.ok) {
        set({ notice: { type: 'success', text: r.message } });
        noteGit('已合并', refName);
      } else {
        set({
          notice: {
            type: r.conflicts.length > 0 ? 'warning' : 'error',
            text: r.message,
            conflicts: r.conflicts.length > 0 ? r.conflicts : undefined,
          },
        });
      }
      await get().refresh();
      await get().loadLog(true);
    } catch (e) {
      if (get().repoRoot === root) set({ notice: { type: 'error', text: e instanceof Error ? e.message : String(e) } });
    } finally {
      criticalWriteBusy = false;
    }
  },

  runConflictAction: async (expectedRoot, kind, path) => {
    const busy = get().ops;
    if (get().repoRoot !== expectedRoot) return { ok: false, message: '当前仓库已切换，请刷新后重试。', hash: null, conflicts: [], stderr: '' };
    if (criticalWriteBusy || busy.fetch || busy.pull || busy.push || busy.commit || busy.checkout || busy.conflict) {
      return { ok: false, message: '另一个 Git 操作正在进行，请完成后重试。', hash: null, conflicts: [], stderr: '' };
    }
    criticalWriteBusy = true;
    set((s) => ({ ops: { ...s.ops, conflict: true } }));
    try {
      const result = kind === 'open' && path ? await api.gitOpenConflictFile(expectedRoot, path)
        : kind === 'resolve' && path ? await api.gitMarkResolved(expectedRoot, path, false)
          : kind === 'resolve-binary' && path ? await api.gitMarkResolved(expectedRoot, path, true)
            : kind === 'continue' ? await api.gitContinueOperation(expectedRoot, 'merge')
              : kind === 'abort' ? await api.gitAbortOperation(expectedRoot, 'merge')
                : { ok: false, message: '冲突操作参数不完整。', hash: null, conflicts: [], stderr: '' };
      if (get().repoRoot === expectedRoot) await get().refresh();
      return result;
    } catch (e) {
      const result = { ok: false, message: e instanceof Error ? e.message : String(e), hash: null, conflicts: [], stderr: '' };
      if (get().repoRoot === expectedRoot) { set({ notice: { type: 'error', text: result.message } }); await get().refresh(); }
      return result;
    } finally {
      set((s) => ({ ops: { ...s.ops, conflict: false } }));
      criticalWriteBusy = false;
    }
  },

  clearNotice: () => set({ notice: null }),
}));

/** 侧栏角标：变更文件数（badge 是取值函数，不触发重渲染） */
export function gitBadgeCount(): number {
  return totalChanged(useGitStore.getState().status);
}
