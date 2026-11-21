/*
 * Git 管理模块 · 对外公开契约（状态）
 * ------------------------------------------------------------------
 * 工作台约定：模块之间不互相 import 内部实现。别的模块（目前是首页）
 * 需要读「现在有几个改动、在哪个分支」时，**只 import 本文件**。
 *
 * 这里只暴露**只读**派生值，全部来自 store 的内存快照：
 *   · 不触发 IPC（不跑 git 命令）
 *   · 不碰主密钥
 *   · 没打开过仓库时 hasRepo 为 false，首页据此显示「未打开仓库」而不是编造一个 0
 *
 * ⚠️ 为什么不在本文件里 import git.css：那是**组件**门面的义务
 * （见 logsight/public.ts 的说明）。本文件不导出任何组件，带上样式只会
 * 把 8KB 的模块样式拖进首页 chunk。
 *
 * ⚠️ 为什么用三个基本类型选择器而不是一个对象选择器：
 * zustand v5 用 Object.is 比较选择器结果，选择器里现造对象会导致
 * 每次渲染都是新引用 → 无限重渲染。派生放在 useMemo 里。
 * @Author: fu
 */
import { useMemo } from 'react';
import { useGitStore } from './store/useGitStore';
import { totalChanged } from './utils/parseStatus';
import { useWorkbenchStore } from '@/store/useWorkbenchStore';
import * as api from './ipc';
import { useGitPrefs, type GitPrefs } from './prefs';

export interface GitStatusSummary {
  /** 是否已经打开过某个仓库（否则其余字段都没有意义） */
  hasRepo: boolean;
  /** 仓库目录名（不是完整路径 —— 首页只需要「是哪个项目」） */
  repoName: string | null;
  /** 当前分支；detached HEAD 时为 null */
  branch: string | null;
  /** 变更文件总数（已暂存 + 未暂存 + 未跟踪 + 冲突，按路径去重） */
  changed: number;
  ahead: number;
  behind: number;
}

/** 从仓库绝对路径里取目录名，兼容 / 与 \ 两种分隔符 */
function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
}

/**
 * 首页用的 Git 状态。
 * 没打开过仓库时返回 hasRepo:false —— 而不是「0 处改动」，
 * 那会把「不知道」伪装成「很干净」。
 */
export function useGitStatus(): GitStatusSummary {
  const repoRoot = useGitStore((s) => s.repoRoot);
  const status = useGitStore((s) => s.status);
  const repoInfo = useGitStore((s) => s.repoInfo);

  return useMemo(
    () => ({
      hasRepo: Boolean(repoRoot),
      repoName: repoRoot ? baseName(repoRoot) : null,
      branch: status?.branch ?? repoInfo?.branch ?? null,
      changed: totalChanged(status),
      ahead: status?.ahead ?? repoInfo?.ahead ?? 0,
      behind: status?.behind ?? repoInfo?.behind ?? 0,
    }),
    [repoRoot, status, repoInfo],
  );
}

/** Validate first, then navigate; a failed selection leaves the current repository intact. */
export async function openProjectRepo(path: string): Promise<void> {
  const info = await api.openRepo(path);
  await useGitStore.getState().openRepo(path);
  if (useGitStore.getState().repoRoot !== info.root) throw new Error('Git 模块未能切换到所选仓库');
  useWorkbenchStore.getState().setActiveModule('git');
}

export function readSafeBackupState(): { recentRepos: string[]; prefs: GitPrefs } {
  let recentRepos: string[] = [];
  try { const parsed = JSON.parse(localStorage.getItem('workbench:git-recent-repos') || '[]'); if (Array.isArray(parsed)) recentRepos = parsed.filter((v): v is string => typeof v === 'string').slice(0, 8); } catch { /* invalid local data is ignored */ }
  const p = useGitPrefs.getState();
  return { recentRepos, prefs: { autoRefresh: p.autoRefresh, refreshIntervalSec: p.refreshIntervalSec } };
}

export function applySafeBackupState(state: { recentRepos: string[]; prefs: GitPrefs }): void {
  localStorage.setItem('workbench:git-recent-repos', JSON.stringify(state.recentRepos.slice(0, 8)));
  useGitStore.setState({ recentRepos: state.recentRepos.slice(0, 8) });
  useGitPrefs.getState().setAutoRefresh(state.prefs.autoRefresh);
  useGitPrefs.getState().setRefreshInterval(state.prefs.refreshIntervalSec);
}
