/*
 * 片段库 · 用户偏好
 * ------------------------------------------------------------------
 * 只持久化「排序方式」。
 *
 * 标签筛选**刻意不持久化**：下次打开模块时看到一个被筛过的列表、
 * 却想不起来自己筛过什么，是最容易让人以为「我的片段丢了」的一种状态。
 * 筛选是当下这一刻的动作，每次进来都从「全部」开始。
 * @Author: fu
 */
import { create } from 'zustand';
import { SORT_MODES, type SortMode } from './format';

const LS_KEY = 'workbench:snippets-prefs';

interface PrefsState {
  sort: SortMode;
  setSort: (v: SortMode) => void;
}

function isSortMode(v: unknown): v is SortMode {
  return typeof v === 'string' && SORT_MODES.some((m) => m.value === v);
}

function loadSort(): SortMode {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return 'updated';
    const p = JSON.parse(raw) as { sort?: unknown };
    return isSortMode(p.sort) ? p.sort : 'updated';
  } catch {
    return 'updated';
  }
}

export const useSnippetsPrefs = create<PrefsState>((set) => ({
  sort: loadSort(),
  setSort: (sort) => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ sort }));
    } catch {
      /* 隐私模式等场景下忽略 */
    }
    set({ sort });
  },
}));
