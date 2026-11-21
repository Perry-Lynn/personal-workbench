/*
 * 片段库 · 只读门面
 * ------------------------------------------------------------------
 * 命令面板（src/shell/CommandPalette.tsx）要在**不打开片段库**的前提下
 * 搜到片段、并复制它。按工作台的硬约定，跨模块只能走 public.ts，
 * 所以这里只暴露「读列表 / 触发加载 / 复制一条」三件事，
 * 不把 store 的增删改、编辑器、prefs 漏出去。
 *
 * 为什么要单独 ensureSnippetsLoaded()：片段的 items 只有在模块挂载过之后
 * 才有数据。命令面板可能是应用启动后第一个被用到的东西，所以它得能自己拉一次。
 * @Author: fu
 */
import { copyText } from '@/core/clipboard';
import { useSnippetsStore } from './store';
import type { Snippet } from './types';

export type { Snippet } from './types';
/** 搜索口径与片段库自己的搜索完全一致（标题 / 正文 / 标签 / 语言） */
export { matchesQuery } from './format';

/** 全部片段（store 原序；排序由调用方决定） */
export function useSnippetItems(): Snippet[] {
  return useSnippetsStore((s) => s.items);
}

/**
 * 确保片段已加载。
 * load() 自己是幂等的（loaded 且非 force 直接返回），所以可以随便调。
 * 这里吞掉异常：命令面板是「顺手用一下」的地方，拉不到片段就不显示片段，
 * 不该因为它弹一个错误。
 */
export async function ensureSnippetsLoaded(): Promise<void> {
  try {
    await useSnippetsStore.getState().load();
  } catch {
    /* 忽略：命令面板里不显示片段即可 */
  }
}

/**
 * 复制一条片段，并在成功之后记一次使用。
 * 口径与片段库里的「复制」按钮一致：先复制，成功了才记次数；
 * 记次数失败不影响复制结果。
 */
export async function copySnippet(s: Snippet): Promise<void> {
  await copyText(s.body);
  try {
    await useSnippetsStore.getState().markUsed(s.id);
  } catch {
    /* 统计失败，忽略 */
  }
}
