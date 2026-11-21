/*
 * Maven 助手模块 · 前端状态
 * 两块数据各自独立：仓库扫描（快、可反复扫）与依赖树（慢、按需）。
 */
import { create } from 'zustand';
import type { MavenInfo, RepoStats, TreeResult } from './types';

interface MavenStore {
  info: MavenInfo | null;
  repo: RepoStats | null;
  tree: TreeResult | null;
  /** 正在分析的目录（依赖树可能跑几十秒，界面要显示出来） */
  treeDir: string | null;
  repoLoading: boolean;
  treeLoading: boolean;
  repoError: string | null;
  treeError: string | null;
  setInfo: (v: MavenInfo | null) => void;
  setRepo: (v: RepoStats | null) => void;
  setTree: (v: TreeResult | null, dir: string | null) => void;
  setRepoLoading: (v: boolean) => void;
  setTreeLoading: (v: boolean) => void;
  setRepoError: (v: string | null) => void;
  setTreeError: (v: string | null) => void;
}

export const useMavenStore = create<MavenStore>((set) => ({
  info: null,
  repo: null,
  tree: null,
  treeDir: null,
  repoLoading: false,
  treeLoading: false,
  repoError: null,
  treeError: null,
  setInfo: (info) => set({ info }),
  setRepo: (repo) => set({ repo }),
  setTree: (tree, treeDir) => set({ tree, treeDir }),
  setRepoLoading: (repoLoading) => set({ repoLoading }),
  setTreeLoading: (treeLoading) => set({ treeLoading }),
  setRepoError: (repoError) => set({ repoError }),
  setTreeError: (treeError) => set({ treeError }),
}));
