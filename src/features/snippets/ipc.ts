/*
 * 片段库 · IPC 封装
 * 命令前缀 snippets_，统一走 @/core/ipc 的 call()（自动拆 ApiResponse）。
 * 不涉及主密钥：片段是明文存的用户自己的内容。
 */
import { call } from '@/core/ipc';
import type { Snippet, SnippetDraft } from './types';

/** 列出全部片段（后端已按「置顶 → 最近更新」排序） */
export const list = (): Promise<Snippet[]> => call<Snippet[]>('snippets_list');

/**
 * 新建或更新一条。
 * `draft.id` 为空 = 新建（id 由后端生成）；给了 id 但后端找不到会直接报错，
 * 不会悄悄新建一条。
 */
export const save = (draft: SnippetDraft): Promise<Snippet> =>
  call<Snippet>('snippets_save', {
    id: draft.id ?? null,
    title: draft.title,
    body: draft.body,
    lang: draft.lang,
    tags: draft.tags,
  });

/** 删除一条，返回它是否原本存在 */
export const remove = (id: string): Promise<boolean> => call<boolean>('snippets_delete', { id });

/** 置顶 / 取消置顶，返回更新后的整条 */
export const togglePin = (id: string): Promise<Snippet> =>
  call<Snippet>('snippets_toggle_pin', { id });

/** 记一次使用（复制成功后调用），返回更新后的整条 */
export const touch = (id: string): Promise<Snippet> => call<Snippet>('snippets_touch', { id });
