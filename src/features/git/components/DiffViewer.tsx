/*
 * 双栏 Diff 查看器
 * ------------------------------------------------------------------
 * 左右两栏放**同一个网格行**里（46px 行号 | 左文 | 46px 行号 | 右文），
 * 不存在两个滚动容器 —— 滚动同步零成本。
 * 左列 = 旧版本（删除红），右列 = 新版本（新增绿）；
 * del+add 配对成功的「修改行」左右各按本侧颜色渲染（见 sideBySide.ts）。
 *
 * hunk 头行带「暂存此块 / 取消暂存此块」（未暂存视角可按块暂存，
 * 已暂存视角可按块撤销）—— 对齐 IDEA 的逐块提交体验。
 * @Author: fu
 */
import { Button, Empty } from 'antd';
import { hunkToRows } from '../utils/sideBySide';
import { buildHunkPatch } from '../utils/parseDiff';
import type { FileDiff, SideCell } from '../types';

export type HunkMode = 'stage' | 'unstage' | null;

interface DiffViewerProps {
  files: FileDiff[];
  /** stage = 未暂存视角；unstage = 已暂存视角；null = 只读（提交详情） */
  hunkMode: HunkMode;
  onStageHunk?: (path: string, patch: string, reverse: boolean) => void;
}

/** 单元格 → 底色类（左列 mod/del 都是红系，右列 mod/add 都是绿系） */
function cellClass(side: 'left' | 'right', c: SideCell): string {
  if (c.kind === 'empty') return 'git-diff-empty';
  if (c.kind === 'ctx') return '';
  if (side === 'left') return c.kind === 'del' || c.kind === 'mod' ? 'git-diff-del' : '';
  return c.kind === 'add' || c.kind === 'mod' ? 'git-diff-add' : '';
}

function Row({ left, right }: { left: SideCell; right: SideCell }) {
  return (
    <div className="grid" style={{ gridTemplateColumns: '52px minmax(0,1fr) 52px minmax(0,1fr)' }}>
      <div className={`git-line-no px-1.5 border-r border-wb-border-l1 ${cellClass('left', left)}`}>{left.no ?? ''}</div>
      <div className={`git-diff-text px-2 border-r border-wb-border-l1 ${cellClass('left', left)}`}>
        {left.text ?? ''}
      </div>
      <div className={`git-line-no px-1.5 border-r border-wb-border-l1 ${cellClass('right', right)}`}>{right.no ?? ''}</div>
      <div className={`git-diff-text px-2 ${cellClass('right', right)}`}>{right.text ?? ''}</div>
    </div>
  );
}

function FileDiffView({ file, hunkMode, onStageHunk }: { file: FileDiff } & Omit<DiffViewerProps, 'files'>) {
  const filePath = file.newPath ?? file.oldPath ?? '(未知路径)';

  if (file.binary) {
    return (
      <div className="p-4 text-wb-text-secondary git-fs-md">
        <div className="font-mono text-wb-text-primary git-fs-md mb-2">{filePath}</div>
        二进制文件，无法显示文本差异
      </div>
    );
  }

  if (file.renamed && file.hunks.length === 0) {
    return (
      <div className="p-4 text-wb-text-secondary git-fs-md">
        <div className="font-mono text-wb-text-primary git-fs-md mb-2">{filePath}</div>
        仅改名（{file.oldPath} → {file.newPath}），无内容变化
      </div>
    );
  }

  return (
    <div>
      {file.hunks.map((hunk, hi) => (
        <div key={hi}>
          {/* hunk 头 + 按块暂存 */}
          <div className="git-hunk-head git-diff-text flex items-center gap-2 px-2">
            <span className="flex-1 truncate">{hunk.header}</span>
            {hunkMode && onStageHunk && (
              <Button
                size="small"
                type="text"
                className="text-wb-text-secondary"
                onClick={() => {
                  const path = file.newPath ?? file.oldPath ?? '';
                  /* 已暂存视角 = 反向应用（把这块从索引里撤出来） */
                  onStageHunk(path, buildHunkPatch(file, hunk), hunkMode === 'unstage');
                }}
              >
                {hunkMode === 'unstage' ? '取消暂存此块' : '暂存此块'}
              </Button>
            )}
          </div>
          {hunkToRows(hunk).map((r, ri) => (
            <Row key={ri} left={r.left} right={r.right} />
          ))}
        </div>
      ))}
      {file.truncated && (
        <div className="px-3 py-2 text-wb-warning git-fs-xs">差异过大，已截断显示（完整差异请在命令行查看）</div>
      )}
    </div>
  );
}

export function DiffViewer({ files, hunkMode, onStageHunk }: DiffViewerProps) {
  if (files.length === 0) {
    return (
      <div className="h-full flex items-center justify-center">
        <Empty description="选择左侧的文件或下方的提交查看差异" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      </div>
    );
  }
  return (
    <div className="h-full overflow-auto">
      {files.map((f, i) => (
        <div key={i}>
          {files.length > 1 && (
            <div className="px-3 py-1.5 text-wb-text-primary git-fs-sm font-mono bg-wb-bg-secondary border-y border-wb-border-l1 sticky top-0">
              {f.oldPath && f.oldPath !== f.newPath ? `${f.oldPath} → ${f.newPath}` : (f.newPath ?? f.oldPath)}
            </div>
          )}
          <FileDiffView file={f} hunkMode={hunkMode} onStageHunk={onStageHunk} />
        </div>
      ))}
    </div>
  );
}

export default DiffViewer;
