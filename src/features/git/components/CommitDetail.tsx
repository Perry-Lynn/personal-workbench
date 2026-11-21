/*
 * 提交详情（点提交图某行时在 Diff 区展示）
 * ------------------------------------------------------------------
 * 左树右 diff（对齐 IDEA 的提交详情阅读方式）：
 *   · 左：该提交改动的文件**目录树**。**默认全部展开**（打开就能看到文件在哪），
 *        点击目录可单独折叠/展开，表头还有「一键全部打开 / 一键全部合并」；
 *        点击文件在右侧看它的 diff
 *   · 右：当前选中文件的差异（合并提交展示相对第一父的变更）
 *
 * 目录树复用变更列表同一套构建逻辑（utils/buildFileTree.buildPathTree），
 * 路径取 newPath ?? oldPath —— 删除的文件只有 oldPath，改名以新路径为准。
 * 折叠/选中状态由外层按提交 hash 加 key 重置，切换提交不会带着上一份的状态。
 * @Author: fu
 */
import { CaretDownOutlined, CaretRightOutlined, FolderOpenOutlined, FolderOutlined, NodeCollapseOutlined, NodeExpandOutlined } from '@ant-design/icons';
import { Tag, Tooltip } from 'antd';
import dayjs from 'dayjs';
import { useMemo, useState } from 'react';
import { buildPathTree, dirPaths } from '../utils/buildFileTree';
import type { TreeNode } from '../utils/buildFileTree';
import { DiffViewer } from './DiffViewer';
import { useGitStore } from '../store/useGitStore';
import type { FileDiff } from '../types';

/** 提交里单个文件的变更标记与配色（与变更列表同一套语义） */
function diffMark(f: FileDiff): { mark: string; color: string } {
  if (f.newFile) return { mark: 'A', color: 'text-wb-success' };
  if (f.deletedFile) return { mark: 'D', color: 'text-wb-error' };
  if (f.renamed) return { mark: 'R', color: 'text-wb-info' };
  return { mark: 'M', color: 'text-wb-warning' };
}

/** 该文件在树里的路径（删除的文件只有旧路径） */
function pathOfDiff(f: FileDiff): string {
  return f.newPath ?? f.oldPath ?? '(未知路径)';
}

function DiffTreeRow({
  node,
  level,
  collapsed,
  toggle,
  selectedPath,
  onSelect,
}: {
  node: TreeNode<FileDiff>;
  level: number;
  /** 折叠的目录路径集合（空 = 全部展开，符合「默认打开」） */
  collapsed: Set<string>;
  toggle: (path: string) => void;
  selectedPath: string | null;
  onSelect: (f: FileDiff) => void;
}) {
  const indent = 6 + level * 14;

  if (node.kind === 'dir') {
    const isOpen = !collapsed.has(node.path);
    return (
      <>
        <div
          className="git-row flex items-center gap-1 pr-2 py-[3px] cursor-pointer select-none"
          style={{ paddingLeft: indent }}
          onClick={() => toggle(node.path)}
          title={node.path}
        >
          <span className="git-caret text-wb-text-tertiary">
            {isOpen ? <CaretDownOutlined /> : <CaretRightOutlined />}
          </span>
          <span className="text-wb-text-tertiary git-fs-sm">
            {isOpen ? <FolderOpenOutlined /> : <FolderOutlined />}
          </span>
          <span className="text-wb-text-secondary git-fs-sm truncate">{node.label}</span>
          <span className="git-count ml-auto">{node.files.length}</span>
        </div>
        {isOpen &&
          node.children.map((c) => (
            <DiffTreeRow
              key={`${c.kind}:${c.path}`}
              node={c}
              level={level + 1}
              collapsed={collapsed}
              toggle={toggle}
              selectedPath={selectedPath}
              onSelect={onSelect}
            />
          ))}
      </>
    );
  }

  const file = node.files[0];
  const { mark, color } = diffMark(file);
  const selected = selectedPath === node.path;
  return (
    <div
      className={`git-row flex items-center gap-1.5 pr-2 py-[3px] cursor-pointer ${selected ? 'is-selected' : ''}`}
      style={{ paddingLeft: indent }}
      onClick={() => onSelect(file)}
      title={file.oldPath && file.oldPath !== file.newPath ? `${file.oldPath} → ${file.newPath}` : node.path}
    >
      <span className={`git-fs-xs font-mono w-[0.9em] shrink-0 ${color}`}>{mark}</span>
      <span className={`git-fs-md truncate ${color}`}>{node.label}</span>
      {file.binary && <span className="text-wb-text-tertiary git-fs-xs shrink-0 ml-auto">二进制</span>}
    </div>
  );
}

export function CommitDetail({
  treeWidth,
  onTreeDividerDown,
}: {
  /**
   * 文件树栏宽度 —— 由 GitModule 持有。
   * 本组件换提交就重挂（key = hash），宽度状态放这里会在每次点击提交时复位。
   */
  treeWidth: number;
  onTreeDividerDown: (e: React.MouseEvent) => void;
}) {
  const commitDetail = useGitStore((s) => s.commitDetail);
  /** 折叠的目录路径集合（空 = 全部展开 —— 默认就是打开状态） */
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const diff = commitDetail?.diff ?? [];
  const tree = useMemo(() => buildPathTree(diff, pathOfDiff), [diff]);
  const selected = useMemo(
    () => (selectedPath ? diff.find((f) => pathOfDiff(f) === selectedPath) ?? null : null),
    [diff, selectedPath],
  );

  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  /* 一键全部打开（展开所有目录）/ 一键全部合并（折叠所有目录） */
  const expandAll = () => setCollapsed(new Set());
  const collapseAll = () => setCollapsed(new Set(dirPaths(tree)));

  if (!commitDetail) return null;
  const { meta, loading } = commitDetail;

  if (loading) {
    return <div className="p-4 text-wb-text-secondary git-fs-md">加载提交详情…</div>;
  }
  if (!meta) {
    return <div className="p-4 text-wb-text-secondary git-fs-md">无法读取该提交</div>;
  }

  /* %(D) 形如 "HEAD -> main, tag: v1.0"：按逗号拆成标签 */
  const refTags = meta.refs
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* 提交元信息 */}
      <div className="px-3 py-2 border-b border-wb-border-l1 shrink-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-wb-text-brand git-fs-xs">{meta.shortHash}</span>
          {refTags.map((t) => (
            <Tag key={t} color={t.startsWith('HEAD') ? 'green' : 'blue'} className="mr-0">
              {t}
            </Tag>
          ))}
          {meta.parents.length > 1 && <Tag className="mr-0">合并提交</Tag>}
        </div>
        <div className="text-wb-text-primary git-fs-md mt-1">{meta.subject}</div>
        <div className="text-wb-text-tertiary git-fs-xs mt-0.5">
          {meta.author} · {dayjs.unix(meta.date).format('YYYY-MM-DD HH:mm')}
          <span className="ml-2">
            改动 {diff.length} 个文件
          </span>
          {meta.parents.length > 0 && (
            <span className="ml-2 font-mono">父提交 {meta.parents.map((p) => p.slice(0, 7)).join(' ')}</span>
          )}
        </div>
      </div>

      {/* 左树右 diff */}
      <div className="flex-1 flex min-h-0">
        <div className="shrink-0 flex flex-col min-h-0" style={{ width: treeWidth }}>
          {/* 文件树表头：数量 + 一键全部打开 / 一键全部合并 */}
          <div className="h-7 shrink-0 flex items-center gap-1 px-2 border-b border-wb-border-l1">
            <span className="git-fs-sm font-medium text-wb-text-secondary">文件</span>
            <span className="git-count">{diff.length}</span>
            <div className="flex-1" />
            <Tooltip title="一键全部打开（展开所有目录）">
              <button type="button" className="git-icon-btn" onClick={expandAll}>
                <NodeExpandOutlined />
              </button>
            </Tooltip>
            <Tooltip title="一键全部合并（折叠所有目录）">
              <button type="button" className="git-icon-btn" onClick={collapseAll}>
                <NodeCollapseOutlined />
              </button>
            </Tooltip>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto">
            {tree.map((n) => (
              <DiffTreeRow
                key={`${n.kind}:${n.path}`}
                node={n}
                level={0}
                collapsed={collapsed}
                toggle={toggle}
                selectedPath={selectedPath}
                onSelect={(f) => setSelectedPath(pathOfDiff(f))}
              />
            ))}
            <div className="px-2 py-2 text-wb-text-tertiary git-fs-xs leading-relaxed">
              点击目录折叠 / 展开 · 点击文件查看差异
            </div>
          </div>
        </div>

        {/* 文件树 / 差异 的宽度分隔条 */}
        <div
          className="w-1 cursor-col-resize bg-wb-bg-secondary hover:bg-wb-bg-active shrink-0"
          onMouseDown={onTreeDividerDown}
          title="拖动调整文件树宽度"
        />

        <div className="flex-1 min-w-0 flex flex-col min-h-0">
          <div className="h-7 shrink-0 flex items-center px-3 border-b border-wb-border-l1">
            <span className="git-fs-sm font-mono text-wb-text-secondary truncate">
              {selected
                ? selected.oldPath && selected.oldPath !== selected.newPath
                  ? `${selected.oldPath} → ${selected.newPath}`
                  : pathOfDiff(selected)
                : '未选择文件'}
            </span>
          </div>
          <div className="flex-1 min-h-0">
            {selected ? (
              <DiffViewer files={[selected]} hunkMode={null} />
            ) : (
              <div className="h-full flex items-center justify-center text-wb-text-tertiary git-fs-md">
                在左侧展开目录并点击文件，这里显示它的差异
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default CommitDetail;
