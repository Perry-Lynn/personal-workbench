/*
 * 目录树构建（纯函数，进 logic-test）
 * ------------------------------------------------------------------
 * 把一堆「带路径的条目」折成目录树，供两处复用：
 *   · 变更列表（条目 = ChangeFile，路径取 path）
 *   · 提交详情的文件树（条目 = FileDiff，路径取 newPath ?? oldPath）
 * 所以核心是泛型的 buildPathTree<T>，取路径的规则由调用方传进来。
 *
 * 规则：
 *   · 目录优先、再文件；同级按自然序（file2 排在 file10 前面）
 *   · **单链目录压缩**：`src/main/java/com/ziyun/medical` 这种「一路只有一个子目录」
 *     的链折成一个节点显示，否则 Java 项目的树会有七八层全是单个目录，文件被推到很右边
 *     （IDEA 的 Compact Middle Packages 就是这个行为）
 *
 * 每个节点都带上自己范围内的全部条目 —— 目录级操作（整目录暂存等）
 * 直接取 node.files，不必再去递归组件树。
 * @Author: fu
 */
import type { ChangeFile } from '../types';

export interface TreeNode<T> {
  kind: 'dir' | 'file';
  /** 展示名（目录可能是被压缩过的链，如 "main/java/com/ziyun"） */
  label: string;
  /** 完整路径：文件为文件路径，目录为其完整目录路径 */
  path: string;
  children: TreeNode<T>[];
  /** 本节点范围内的全部条目（目录 = 所有后代；文件 = 自身） */
  files: T[];
}

/** 变更列表用的那棵树 */
export type FileTreeNode = TreeNode<ChangeFile>;

/** 构建期的中间结构 */
interface DirBuilder<T> {
  dirs: Map<string, DirBuilder<T>>;
  files: T[];
}

function lastSegment(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

/** 同级排序：目录在前、文件在后，各自按自然序 */
function compareNodes<T>(a: TreeNode<T>, b: TreeNode<T>): number {
  if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
  return a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' });
}

function toNodes<T>(builder: DirBuilder<T>, prefix: string, pathOf: (t: T) => string): TreeNode<T>[] {
  const dirs: TreeNode<T>[] = [];
  for (const [name, child] of builder.dirs) {
    const path = prefix ? `${prefix}/${name}` : name;
    dirs.push({
      kind: 'dir',
      label: name,
      path,
      children: toNodes(child, path, pathOf),
      files: [],
    });
  }
  const files: TreeNode<T>[] = builder.files.map((f) => ({
    kind: 'file' as const,
    label: lastSegment(pathOf(f)),
    path: pathOf(f),
    children: [],
    files: [f],
  }));
  return [...dirs, ...files].sort(compareNodes);
}

/*
 * 单链目录压缩：一个目录如果**只有一个子目录、且自己不含文件**，
 * 就把子目录折进自己（label 用 "/" 连起来），直到不再满足条件。
 *
 * ⚠️ 只对目录节点递归 —— 曾经把 compact 无差别套到所有子节点上，
 * 文件节点会被当成目录处理（变成 files 为空的 dir），
 * 结果文件名被并进目录名、条目列表直接消失。测试钉住了这条。
 *
 * 也刻意不存「层级/深度」字段：压缩会让子树的层级整体上移，
 * 预先算好的 depth 会失真；渲染时按递归层级缩进才是恒对的。
 */
function compact<T>(node: TreeNode<T>): TreeNode<T> {
  let label = node.label;
  let path = node.path;
  let children = node.children.map((c) => (c.kind === 'dir' ? compact(c) : c));
  while (children.length === 1 && children[0].kind === 'dir') {
    const only = children[0];
    label = `${label}/${only.label}`;
    path = only.path;
    children = only.children;
  }
  return { kind: 'dir', label, path, children, files: collectFiles(children) };
}

/** 递归汇总子节点里的全部条目 */
function collectFiles<T>(nodes: TreeNode<T>[]): T[] {
  return nodes.flatMap((n) => n.files);
}

/** 任意条目列表 → 目录树（取路径的规则由 pathOf 决定） */
export function buildPathTree<T>(items: T[], pathOf: (t: T) => string): TreeNode<T>[] {
  const root: DirBuilder<T> = { dirs: new Map(), files: [] };
  for (const item of items) {
    const p = pathOf(item);
    if (!p) continue;
    const parts = p.split('/');
    parts.pop(); // 末尾是文件名
    let cur = root;
    for (const seg of parts) {
      let next = cur.dirs.get(seg);
      if (!next) {
        next = { dirs: new Map(), files: [] };
        cur.dirs.set(seg, next);
      }
      cur = next;
    }
    cur.files.push(item);
  }
  return toNodes(root, '', pathOf).map((n) => (n.kind === 'dir' ? compact(n) : n));
}

/** 变更文件列表 → 目录树 */
export function buildFileTree(files: ChangeFile[]): FileTreeNode[] {
  return buildPathTree(files, (f) => f.path);
}

/** 该节点下所有文件的路径（目录级暂存/取消暂存用） */
export function pathsOf(node: TreeNode<ChangeFile>): string[] {
  return node.files.map((f) => f.path);
}

/** 节点内条目数（目录上显示计数） */
export function fileCount<T>(node: TreeNode<T>): number {
  return node.files.length;
}

/** 递归收集所有目录节点的路径（「一键全部折叠」要按这份清单一次折完） */
export function dirPaths<T>(nodes: TreeNode<T>[]): string[] {
  const out: string[] = [];
  const walk = (list: TreeNode<T>[]) => {
    for (const n of list) {
      if (n.kind !== 'dir') continue;
      out.push(n.path);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}
