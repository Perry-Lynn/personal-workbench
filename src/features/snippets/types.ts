/*
 * 片段库 · 类型
 * 字段与 src-tauri/src/modules/snippets/models.rs 的 Snippet 一一对应（serde camelCase）。
 */

export interface Snippet {
  id: string;
  title: string;
  body: string;
  /** 语言 / 类型标记，仅用于展示与图标（不做语法高亮）；无则为 null */
  lang: string | null;
  tags: string[];
  pinned: boolean;
  /** 以下都是 Unix 毫秒 */
  createdAt: number;
  updatedAt: number;
  usedAt: number | null;
  useCount: number;
}

/** 保存一条片段要传的字段（id 为空 = 新建） */
export interface SnippetDraft {
  id?: string;
  title: string;
  body: string;
  lang: string | null;
  tags: string[];
}
