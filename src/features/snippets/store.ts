/*
 * 片段库 · 前端状态
 * ------------------------------------------------------------------
 * 列表放 store 而不是组件内 useState，有两个具体原因：
 *   1. 本模块没有 keepAlive，切走就卸载。用 local state 的话，
 *      「搜到一半、点进别的模块看一眼、再切回来」搜索词就没了。
 *   2. 增删改之后只需要把**那一条**并回列表，不必整表重拉 ——
 *      重拉会让整个列表重新排序、滚动位置跳掉。
 *
 * items 保持**无序**（后端给的顺序不依赖）：排序在视图里按用户选的
 * 排序方式现算（format.sortSnippets），这样切换排序方式不用回后端。
 * @Author: fu
 */
import { create } from 'zustand';
import * as ipc from './ipc';
import type { Snippet, SnippetDraft } from './types';

interface SnippetsStore {
  items: Snippet[];
  /** 是否成功加载过一次：切回模块时不再重拉，避免列表闪一下 */
  loaded: boolean;
  loading: boolean;
  /** 加载失败的原因（只在「拉列表」这条路径上写；增删改的失败由调用方自己提示） */
  error: string | null;
  /** 搜索词与标签筛选都留在 store 里，切走再回来不丢 */
  query: string;
  activeTag: string | null;

  load: (force?: boolean) => Promise<void>;
  setQuery: (v: string) => void;
  setActiveTag: (v: string | null) => void;
  save: (draft: SnippetDraft) => Promise<Snippet>;
  remove: (id: string) => Promise<void>;
  togglePin: (id: string) => Promise<void>;
  /** 复制成功后记一次使用 */
  markUsed: (id: string) => Promise<void>;
}

/* 把一条片段并回列表（不存在就放最前） */
function upsert(items: Snippet[], s: Snippet): Snippet[] {
  const i = items.findIndex((x) => x.id === s.id);
  if (i < 0) return [s, ...items];
  const out = [...items];
  out[i] = s;
  return out;
}

export const useSnippetsStore = create<SnippetsStore>((set, get) => ({
  items: [],
  loaded: false,
  loading: false,
  error: null,
  query: '',
  activeTag: null,

  load: async (force = false) => {
    if (get().loading) return;
    if (get().loaded && !force) return;
    set({ loading: true, error: null });
    try {
      const items = await ipc.list();
      set({ items, loaded: true, loading: false });
    } catch (e) {
      /* 这里不抛：调用点（组件挂载 effect）没有 catch 的位置，
         抛出去只会变成一条未处理的 Promise 拒绝。失败状态写进 error 由界面展示。 */
      set({ loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  },

  setQuery: (query) => set({ query }),
  setActiveTag: (activeTag) => set({ activeTag }),

  save: async (draft) => {
    const s = await ipc.save(draft);
    set({ items: upsert(get().items, s) });
    return s;
  },

  remove: async (id) => {
    /*
     * 不管后端说「原本存在」还是「本来就没有」，本地都把这行摘掉 ——
     * 要的结果是「界面上不再出现它」。existed 只是给调用方做提示用的，
     * 所以这里不需要分支。
     */
    await ipc.remove(id);
    set({ items: get().items.filter((x) => x.id !== id) });
  },

  togglePin: async (id) => {
    const s = await ipc.togglePin(id);
    set({ items: upsert(get().items, s) });
  },

  markUsed: async (id) => {
    const s = await ipc.touch(id);
    set({ items: upsert(get().items, s) });
  },
}));
