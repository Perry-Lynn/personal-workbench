/*
 * Git 管理模块 · IPC 封装
 * ------------------------------------------------------------------
 * 一律走 core/ipc 的 call<T>（统一 ApiResponse 成败判定）。
 * 参数名是 camelCase —— Tauri 会自动映射到 Rust 的 snake_case 参数。
 * @Author: fu
 */
import { call } from '@/core/ipc';
import type { AheadBehind, GitOperationState, GitRaw, OpResult, RepoInfo } from './types';

/** 打开仓库（可以选子目录，后端收敛到仓库根） */
export function openRepo(path: string): Promise<RepoInfo> {
  return call<RepoInfo>('git_open_repo', { path });
}
export const gitOperationState = (repo: string): Promise<GitOperationState> => call('git_operation_state', { repo });
export const gitMarkResolved = (repo: string, path: string, confirmBinary: boolean): Promise<OpResult> => call('git_mark_resolved', { repo, path, confirmBinary });
export const gitOpenConflictFile = (repo: string, path: string): Promise<OpResult> => call('git_open_conflict_file', { repo, path });
export const gitContinueOperation = (repo: string, expectedKind: string): Promise<OpResult> => call('git_continue_operation', { repo, expectedKind });
export const gitAbortOperation = (repo: string, expectedKind: string): Promise<OpResult> => call('git_abort_operation', { repo, expectedKind });

export function gitStatus(repo: string): Promise<GitRaw> {
  return call<GitRaw>('git_status', { repo });
}

/** kind: unstaged | staged | untracked */
export function gitDiff(repo: string, kind: string, path?: string): Promise<GitRaw> {
  return call<GitRaw>('git_diff', { repo, kind, path: path ?? null });
}

/** 某提交的元信息 + 差异（元信息在前，用 \x1e 分隔） */
export function gitShow(repo: string, rev: string): Promise<GitRaw> {
  return call<GitRaw>('git_show', { repo, rev });
}

/**
 * 提交历史。
 * rev 省略 = 当前 HEAD；传完整 refname 可看任意分支（含远端分支）的历史，
 * 只读引用、不切换分支、不联网。
 */
export function gitLog(repo: string, skip: number, count: number, rev?: string): Promise<GitRaw> {
  return call<GitRaw>('git_log', { repo, skip, count, rev: rev ?? null });
}

export function gitBranches(repo: string): Promise<GitRaw> {
  return call<GitRaw>('git_branches', { repo });
}

/** 远端列表（`remote -v` 原文；URL → 平台的判定在前端 utils/remotes.ts） */
export function gitRemotes(repo: string): Promise<GitRaw> {
  return call<GitRaw>('git_remotes', { repo });
}

export function gitAheadBehind(repo: string): Promise<AheadBehind> {
  return call<AheadBehind>('git_ahead_behind', { repo });
}

export function gitStage(repo: string, paths: string[]): Promise<OpResult> {
  return call<OpResult>('git_stage', { repo, paths });
}

export function gitUnstage(repo: string, paths: string[]): Promise<OpResult> {
  return call<OpResult>('git_unstage', { repo, paths });
}

/** 按块暂存 / 反向取消暂存（patch 是单 hunk 的迷你 patch） */
export function gitStageHunk(
  repo: string,
  path: string,
  patch: string,
  reverse: boolean,
): Promise<OpResult> {
  return call<OpResult>('git_stage_hunk', { repo, path, patch, reverse });
}

export function gitCommit(repo: string, message: string, amend: boolean): Promise<OpResult> {
  return call<OpResult>('git_commit', { repo, message, amend });
}

export function gitCheckout(repo: string, refName: string, newBranch?: string): Promise<OpResult> {
  return call<OpResult>('git_checkout', { repo, refName, newBranch: newBranch ?? null });
}

export function gitDeleteBranch(repo: string, refName: string, force: boolean): Promise<OpResult> {
  return call<OpResult>('git_delete_branch', { repo, refName, force });
}

export function gitMerge(repo: string, refName: string): Promise<OpResult> {
  return call<OpResult>('git_merge', { repo, refName });
}

export function gitFetch(repo: string): Promise<OpResult> {
  return call<OpResult>('git_fetch', { repo });
}

/**
 * 拉取**一个分支**：把远端最新带回来，并按所选分支的性质决定要不要更新本地引用。
 *
 * updateLocal = false → 只更新 remote-tracking 引用（看远端最新用）；
 * updateLocal = true  → 把所选那条**本地分支快进**到远端最新。
 * 无论哪种：**不产生合并提交**、不碰别的分支、不切换分支
 * （若所选分支正是当前检出分支，会走 `merge --ff-only` 并同步工作区）。
 * 要在当前分支上产生真正的合并提交，用 gitMerge（分支右键 → 合并到当前分支）。
 */
export function gitPullBranch(
  repo: string,
  remote: string,
  branch: string,
  updateLocal: boolean,
): Promise<OpResult> {
  return call<OpResult>('git_pull_branch', { repo, remote, branch, updateLocal });
}

/** `<from>..<to>` 之间的提交数（远端分支新提交计数） */
export function gitCountBetween(repo: string, from: string, to: string): Promise<number> {
  return call<number>('git_count_between', { repo, from, to });
}

export function gitPush(repo: string): Promise<OpResult> {
  return call<OpResult>('git_push', { repo });
}
