/*
 * Git 管理模块 · 前端类型
 * ------------------------------------------------------------------
 * 与 Rust models.rs 的结构一一对应（camelCase）；
 * 解析产物（StatusResult / FileDiff / Commit / BranchInfo）只存在于前端。
 * @Author: fu
 */

/* ============ IPC 原始结构（Rust models.rs） ============ */

/** git 命令的原始输出 */
export interface GitRaw {
  stdout: string;
  stderr: string;
  code: number | null;
}

/** 仓库打开结果 */
export interface RepoInfo {
  root: string;
  valid: boolean;
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  empty: boolean;
}

/** 写操作结果（ok:false 是业务失败，不是 IPC 失败） */
export interface OpResult {
  ok: boolean;
  message: string;
  hash: string | null;
  conflicts: string[];
  stderr: string;
}

export interface AheadBehind {
  ahead: number;
  behind: number;
}
export interface GitOperationState { kind: 'none' | 'merge' | 'rebase' | 'cherry-pick' | 'revert'; conflicts: string[] }

/* ============ status（porcelain v2 解析产物） ============ */

/** 变更类型（对应 porcelain 的 XY 状态字符） */
export type ChangeKind =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'typeChanged'
  | 'untracked'
  | 'conflicted';

/** 一个变更文件 */
export interface ChangeFile {
  /** 新路径（rename 后的名字） */
  path: string;
  /** rename/copy 的原路径 */
  oldPath?: string;
  kind: ChangeKind;
}

/** 变更分组（IDEA 的 Local Changes 语义：已暂存 / 未暂存 / 未跟踪 / 冲突） */
export type ChangeGroup = 'staged' | 'unstaged' | 'untracked' | 'conflicted';

export interface StatusResult {
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: ChangeFile[];
  unstaged: ChangeFile[];
  untracked: ChangeFile[];
  conflicted: ChangeFile[];
}

/* ============ diff（unified diff 解析产物） ============ */

export type DiffLineKind = 'ctx' | 'add' | 'del';

export interface DiffLine {
  kind: DiffLineKind;
  /** 旧行号（add 行为 null） */
  oldNo: number | null;
  /** 新行号（del 行为 null） */
  newNo: number | null;
  text: string;
}

export interface Hunk {
  /** @@ -a,b +c,d @@ 开头的原始头行 */
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
  /**
   * hunk 的原始文本（头行 + 各差异行 + \ No newline 标记）。
   * 按块暂存时拼进迷你 patch 原样喂给 git apply —— 手工重建容易漏掉
   * 「文件尾无换行」这类标记，所以保留原文。
   */
  raw: string;
}

export interface FileDiff {
  oldPath: string | null;
  newPath: string | null;
  newFile: boolean;
  deletedFile: boolean;
  renamed: boolean;
  binary: boolean;
  hunks: Hunk[];
  /** 超过行数上限被截断 */
  truncated: boolean;
}

/* ============ 双栏 Diff（sideBySide 产物） ============ */

/**
 * 单元格类型：
 *   ctx  上下文行（左右同文）
 *   del  纯删除行（右列补空）
 *   add  纯新增行（左列补空）
 *   mod  「修改行」的左半 / 右半（del+add 配对成功，左红右绿）
 *   empty 对侧占位
 */
export type SideKind = 'ctx' | 'add' | 'del' | 'mod' | 'empty';

export interface SideCell {
  no: number | null;
  text: string | null;
  kind: SideKind;
}

/** 双栏的一行（左右同高，天然滚动同步） */
export interface SideRow {
  left: SideCell;
  right: SideCell;
}

/* ============ log / branch ============ */

export interface Commit {
  hash: string;
  shortHash: string;
  /** 父提交（合并提交有多个；根提交为空） */
  parents: string[];
  author: string;
  email: string;
  /** Unix 秒 */
  date: number;
  /** %(D)：HEAD -> main、tag: v1.0 之类的装饰 */
  refs: string;
  subject: string;
}

export interface BranchInfo {
  /** refs/heads/main */
  ref: string;
  /** main 或 origin/main */
  name: string;
  shortHash: string;
  upstream: string | null;
  current: boolean;
  date: number;
  subject: string;
  remote: boolean;
  /**
   * 与上游的相对位置（后端 %(upstream:track)）。
   * 本地分支才有：ahead = 待推送、behind = 待拉取；远端分支无上游，恒为 0。
   */
  ahead: number;
  behind: number;
  /** 上游分支已不存在（track 报 [gone]，例如远端分支被删了） */
  gone: boolean;
}

/* ============ 提交图（graphLayout 产物） ============ */

/**
 * 从「提交圆点」连向某个父提交 lane 的行底连线。
 * `to` 与提交自身 lane 相同 → 直线下行；不同 → 曲线（合并支线 / 汇合）。
 */
export interface GraphEdge {
  /** 目标 lane（父提交所在、或即将出现的 lane） */
  to: number;
  /** 是否需要画曲线（目标 lane ≠ 提交自身 lane） */
  curve: boolean;
}

export interface GraphRowData {
  /** 提交圆点所在的 lane */
  lane: number;
  /** 从圆点（行中）连到行底的每一笔（每个父提交一笔） */
  edges: GraphEdge[];
  /**
   * 贯穿**整行**的 lane（上一行流下来、本行继续往下的竖线）。
   *
   * ⚠️ 刻意**不含**本提交自身 lane，也不含本行新开的 lane ——
   * 新开的 lane 这一行才第一次出现，它在行顶还不存在；
   * 若一并当贯穿线画（从 y=0 画到 y=h），就会出现一条
   * 「凭空冒出来、超出却没有圆点」的线（这正是曾经踩过的坑）。
   */
  passThrough: number[];
  /** 本提交自身 lane 在行顶就已有线（有子提交从上一行流下来） */
  incoming: boolean;
  /** 是否合并提交（多个父）—— 圆点画成更大的空心环以示区分 */
  merge: boolean;
}
