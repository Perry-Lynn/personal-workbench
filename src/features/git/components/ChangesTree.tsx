/*
 * 本地变更列表
 * ------------------------------------------------------------------
 * 四个分组（IDEA 的 Local Changes 语义）：
 *   冲突      → 单独一组，由 ConflictPanel 提供外部编辑、标记解决和 merge 收尾
 *   已暂存     → 勾选框默认勾上，取消 = unstage
 *   未暂存     → 勾选框默认空，勾上 = stage
 *   未跟踪     → 勾上 = git add
 *
 * 两种展示（右上角按钮切换）：
 *   目录树（默认）：按目录折叠成树，单链目录被压缩（src/main/java/com/... 一行）；
 *                   目录行可展开/折叠，目录级勾选 = 整个目录一起暂存/取消暂存
 *   平铺          ：一行一个文件（原来的行为）
 *
 * ⚠️ 根节点始终带 flex-1：空态若不自吸收剩余高度，左栏底部就会留下一块空白。
 * ⚠️ 折叠状态按「分组 + 目录路径」记：同名目录在不同分组里各自独立展开。
 * @Author: fu
 */
import { CaretDownOutlined, CaretRightOutlined, FolderOpenOutlined, FolderOutlined, UnorderedListOutlined } from '@ant-design/icons';
import { Checkbox, Tooltip } from 'antd';
import { useMemo, useState } from 'react';
import { buildFileTree, pathsOf } from '../utils/buildFileTree';
import type { FileTreeNode } from '../utils/buildFileTree';
import { useGitStore } from '../store/useGitStore';
import type { ChangeFile, ChangeGroup } from '../types';

const KIND_COLOR: Record<string, string> = {
  modified: 'text-wb-warning',
  added: 'text-wb-success',
  deleted: 'text-wb-error',
  renamed: 'text-wb-info',
  copied: 'text-wb-info',
  typeChanged: 'text-wb-warning',
  untracked: 'text-wb-cyan',
  conflicted: 'text-wb-error',
};

const KIND_MARK: Record<string, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  typeChanged: 'T',
  untracked: 'U',
  conflicted: '!',
};

const GROUPS: Array<{ key: ChangeGroup; title: string }> = [
  { key: 'conflicted', title: '冲突' },
  { key: 'staged', title: '已暂存' },
  { key: 'unstaged', title: '未暂存' },
  { key: 'untracked', title: '未跟踪' },
];

/**
 * 该分组里「勾上」的含义：已暂存组是反的（勾着 = 已暂存，取消即 unstage）。
 * 每个分组用的是**自己那份文件列表**建的树，所以同组内勾选态天然一致 ——
 * 目录行直接沿用这个值即可，不需要半选（indeterminate）态。
 */
function checkedByDefault(group: ChangeGroup): boolean {
  return group === 'staged';
}

/* ============== 目录树一行 ============== */

interface NodeRowProps {
  node: FileTreeNode;
  group: ChangeGroup;
  level: number;
  collapsedKey: (path: string) => string;
  collapsed: Set<string>;
  toggle: (key: string) => void;
}

function NodeRow({ node, group, level, collapsedKey, collapsed, toggle }: NodeRowProps) {
  const selection = useGitStore((s) => s.selection);
  const selectFile = useGitStore((s) => s.selectFile);
  const stage = useGitStore((s) => s.stage);
  const unstage = useGitStore((s) => s.unstage);

  const indent = 6 + level * 14;
  const key = collapsedKey(node.path);
  const isOpen = !collapsed.has(key);

  if (node.kind === 'dir') {
    const onToggleCheck = (next: boolean) => {
      /* 目录级勾选 = 整个目录一起暂存 / 取消暂存（node.files 已含全部后代） */
      const paths = pathsOf(node);
      if (next) void stage(paths);
      else void unstage(paths);
    };
    return (
      <>
        <div
          className="git-row flex items-center gap-1 pr-3 py-[3px] cursor-pointer select-none"
          style={{ paddingLeft: indent }}
          onClick={() => toggle(key)}
          title={node.path}
        >
          {/* 冲突目录不给勾选（暂存/取消暂存都解决不了冲突） */}
          {group !== 'conflicted' && (
            <Checkbox
              checked={checkedByDefault(group)}
              onChange={(e) => onToggleCheck(e.target.checked)}
              onClick={(e) => e.stopPropagation()}
            />
          )}
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
            <NodeRow
              key={`${c.kind}:${c.path}`}
              node={c}
              group={group}
              level={level + 1}
              collapsedKey={collapsedKey}
              collapsed={collapsed}
              toggle={toggle}
            />
          ))}
      </>
    );
  }

  /* 文件行 */
  const file: ChangeFile = node.files[0];
  const selected = selection?.group === group && selection.file.path === file.path;
  return (
    <div
      className={`git-row flex items-center gap-1.5 pr-3 py-[3px] cursor-pointer ${selected ? 'is-selected' : ''}`}
      style={{ paddingLeft: indent }}
      onClick={() => void selectFile(group, file)}
      title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
    >
      {group === 'conflicted' ? (
        <span className="w-[16px] text-center text-wb-error git-fs-xs font-bold">!</span>
      ) : (
        <Checkbox
          checked={checkedByDefault(group)}
          onChange={(e) => {
            if (e.target.checked) void stage([file.path]);
            else void unstage([file.path]);
          }}
          onClick={(e) => e.stopPropagation()}
        />
      )}
      <span className={`git-fs-xs font-mono w-[0.9em] shrink-0 ${KIND_COLOR[file.kind]}`}>{KIND_MARK[file.kind]}</span>
      <span className={`git-fs-md truncate ${KIND_COLOR[file.kind]}`}>{node.label}</span>
    </div>
  );
}

/* ============== 平铺一行（原行为） ============== */

function FlatRow({ group, file }: { group: ChangeGroup; file: ChangeFile }) {
  const selection = useGitStore((s) => s.selection);
  const selectFile = useGitStore((s) => s.selectFile);
  const stage = useGitStore((s) => s.stage);
  const unstage = useGitStore((s) => s.unstage);

  const selected = selection?.group === group && selection.file.path === file.path;
  const i = file.path.lastIndexOf('/');
  const dir = i === -1 ? '' : file.path.slice(0, i + 1);
  const name = i === -1 ? file.path : file.path.slice(i + 1);

  return (
    <div
      className={`git-row flex items-center gap-1.5 pl-2 pr-3 py-[3px] cursor-pointer ${selected ? 'is-selected' : ''}`}
      onClick={() => void selectFile(group, file)}
      title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
    >
      {group === 'conflicted' ? (
        <span className="w-[16px] text-center text-wb-error git-fs-xs font-bold">!</span>
      ) : (
        <Checkbox
          checked={checkedByDefault(group)}
          onChange={(e) => {
            if (e.target.checked) void stage([file.path]);
            else void unstage([file.path]);
          }}
          onClick={(e) => e.stopPropagation()}
        />
      )}
      <span className={`git-fs-xs font-mono w-[0.9em] shrink-0 ${KIND_COLOR[file.kind]}`}>{KIND_MARK[file.kind]}</span>
      <span className="text-wb-text-tertiary git-fs-xs truncate shrink-0 max-w-[80px]">{dir}</span>
      <span className={`git-fs-md truncate ${KIND_COLOR[file.kind]}`}>{name}</span>
    </div>
  );
}

/* ============== 主体 ============== */

export function ChangesTree() {
  const status = useGitStore((s) => s.status);
  /** 目录视图（默认）还是平铺视图 */
  const [asTree, setAsTree] = useState(true);
  /** 折叠的目录，key = 分组:目录路径 */
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const total = status
    ? status.staged.length + status.unstaged.length + status.untracked.length + status.conflicted.length
    : 0;

  /* 各分组的目录树：只在 files 变化时重建 */
  const trees = useMemo(() => {
    const out: Partial<Record<ChangeGroup, FileTreeNode[]>> = {};
    if (status && asTree) {
      for (const { key } of GROUPS) out[key] = buildFileTree(status[key]);
    }
    return out;
  }, [status, asTree]);

  return (
    <div className="flex-1 min-h-0 flex flex-col border-b border-wb-border-l1">
      {/* 区域头：总数 + 视图切换 */}
      <div className="flex items-center gap-1 px-2 py-1 shrink-0 border-b border-wb-border-l1">
        <span className="text-wb-text-secondary git-fs-sm font-medium flex-1">变更</span>
        <span className="git-count">{total}</span>
        <Tooltip title={asTree ? '切换为平铺视图（一行一个文件）' : '切换为目录视图（按目录折叠）'}>
          <button type="button" className="git-icon-btn" onClick={() => setAsTree((v) => !v)}>
            {asTree ? <UnorderedListOutlined /> : <FolderOutlined />}
          </button>
        </Tooltip>
      </div>

      {!status || total === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-1 text-wb-text-tertiary">
          <span className="git-fs-lg">工作区干净</span>
          <span className="git-fs-xs">没有未提交的变更</span>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto">
          {GROUPS.map(({ key, title }) => {
            const files = status[key];
            if (files.length === 0) return null;
            const nodes = trees[key] ?? [];
            return (
              <div key={key}>
                <div className="git-section-head">
                  {title}
                  <span className="git-count">{files.length}</span>
                </div>
                {asTree
                  ? nodes.map((n) => (
                      <NodeRow
                        key={`${n.kind}:${n.path}`}
                        node={n}
                        group={key}
                        level={0}
                        collapsedKey={(p) => `${key}:${p}`}
                        collapsed={collapsed}
                        toggle={toggle}
                      />
                    ))
                  : files.map((f) => <FlatRow key={`${key}:${f.path}`} group={key} file={f} />)}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default ChangesTree;
