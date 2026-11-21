/*
 * Git 模块主体
 * ------------------------------------------------------------------
 * 初始布局对齐 IDEA 的 Git 工具窗（用户给的排版图）：
 *
 *   ┌────────────── 顶栏 44px ──────────────┐
 *   │ 提交面板 + 变更列表 │      Diff        │
 *   ├─────────────────────┼─────────────────┤  ← 两条**各自独立**的分界线，
 *   │  分支面板           │   提交历史       │     初始落在同一 Y（默认底部各占 45%）
 *   └─────────────────────┴─────────────────┘
 *                    ↑ 一条全高的竖线（拖左右宽度）
 *
 * 上下为什么要按键切分、而不是共用一个高度：
 *   「初始两边一样高」只是**初始**要求，之后左边（变更/分支）和右边（Diff/历史）
 *   必须能**各自独立**拖 —— 共用一个状态的话，拖一边另一边跟着动，就做不到。
 *   所以两侧各存一个「底部面板占主区高度的比例」，都给 0.45：
 *   两边分界线 = 主区高度 × (1 - 0.45) = 55%，**初始自然对齐**。
 *
 * 为什么用「底部比例」而不是「上区高度」：
 *   左列顶部还压着提交面板，若按「上区高度」算，左列的分界线 = 提交面板高 + 上区高，
 *   与右侧永远差一个提交面板的高度（这正是最初左右对不齐的根因）。
 *   改成从**底边**倒推：底部占 45% → 分界线自然落在 55% 处，与提交面板多高无关。
 *
 * 比例而不是固定 px：窗口一缩放，上下配比应保持；写死 px 会让上区越缩越小。
 * 分隔条共三条：两个横向分界线（各自独立）+ 一条全高竖线（左栏宽度）。
 *
 * 快捷键对齐 IDEA：Cmd+K 聚焦提交框、Cmd+Shift+K 推送、Cmd+Shift+P 拉取。
 * @Author: fu
 */
import { Alert } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import './git.css';
import { BranchPanel } from './components/BranchPanel';
import { ChangesTree } from './components/ChangesTree';
import { CommitDetail } from './components/CommitDetail';
import { CommitGraph } from './components/CommitGraph';
import { CommitPanel } from './components/CommitPanel';
import { DiffViewer } from './components/DiffViewer';
import { GitToolbar } from './components/GitToolbar';
import { RepoPicker } from './components/RepoPicker';
import { ConflictPanel } from './components/ConflictPanel';
import { useGitOps } from './hooks/useGitOps';
import { shouldPoll, useGitPrefs } from './prefs';
import { useGitStore } from './store/useGitStore';
import type { HunkMode } from './components/DiffViewer';

/** 左栏宽度 / Diff 里文件树宽度：默认、下限、上限 */
const LEFT_DEFAULT_W = 300;
const LEFT_MIN_W = 200;
const LEFT_MAX_W = 640;
const TREE_DEFAULT_W = 300;
const TREE_MIN_W = 160;
const TREE_MAX_W = 560;

/**
 * 底部面板（左：分支；右：提交历史）各占主区**高度**的比例。
 * 0.45 → 两侧分界线都在主区的 55% 处（「上区占二分之一多一点」），但两边各存各的值，
 * 所以拖任意一侧都只影响它自己 —— 初始对齐、之后独立。
 */
const BOTTOM_RATIO_DEFAULT = 0.45;
const BOTTOM_RATIO_MIN = 0.15;
const BOTTOM_RATIO_MAX = 0.65;

/**
 * 拖拽调宽度（向左拖 = 目标面板变宽）。
 * 上下分区不用它 —— 那里调的是比例，见下面的 useDragRatio。
 */
function useDragWidth(size: number, min: number, max: number, set: (v: number) => void) {
  return useCallback(
    (e: React.MouseEvent) => {
      const startX = e.clientX;
      const startW = size;
      const onMove = (ev: MouseEvent) => {
        set(Math.min(max, Math.max(min, startW + (ev.clientX - startX))));
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [size, min, max, set],
  );
}

/**
 * 拖拽调「底部面板占主区高度的比例」。
 *
 * 为什么不用 px：上下配比是「二分之一多一点」这种相对量，写死 px 后窗口一缩放就偏了。
 * 为什么是减去位移：分界线**往下**拖 = 底部面板变小，比值该变小。
 * 容器高度在按下那一刻量一次就够 —— 拖动过程中窗口不会同时改变尺寸。
 */
function useDragRatio(
  ratio: number,
  min: number,
  max: number,
  container: React.RefObject<HTMLDivElement>,
  set: (v: number) => void,
) {
  return useCallback(
    (e: React.MouseEvent) => {
      const h = container.current?.clientHeight ?? 0;
      if (h <= 0) return;
      const startY = e.clientY;
      const start = ratio;
      const onMove = (ev: MouseEvent) => {
        set(Math.min(max, Math.max(min, start - (ev.clientY - startY) / h)));
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [ratio, min, max, container, set],
  );
}

/*
 * 顶部提示条。
 *
 * ⚠️ **不要再加 `action={<CloseOutlined …/>}`** —— `closable` 本身就会渲染一个关闭按钮，
 * 再塞一个进去就是两个叉号（曾经就这样重叠渲染过，用户第 4 秒就发现了）。
 * 要改关闭按钮的样子就调 AntD 的 token，不要另起一个图标。
 */
function NoticeBar() {
  const notice = useGitStore((s) => s.notice);
  const clearNotice = useGitStore((s) => s.clearNotice);
  if (!notice) return null;
  return (
    <Alert
      type={notice.type === 'warning' ? 'warning' : notice.type === 'success' ? 'success' : 'error'}
      showIcon
      closable
      onClose={clearNotice}
      className="mx-2 mt-2 shrink-0"
      message={
        <span className="git-fs-md">
          {notice.text}
          {notice.conflicts && notice.conflicts.length > 0 && (
            <span className="block git-fs-xs mt-1">
              冲突文件（可在下方冲突面板打开并标记解决）：
              {notice.conflicts.slice(0, 8).map((f) => (
                <span key={f} className="block font-mono">
                  {f}
                </span>
              ))}
            </span>
          )}
        </span>
      }
    />
  );
}

export default function GitModule() {
  const repoRoot = useGitStore((s) => s.repoRoot);
  const selection = useGitStore((s) => s.selection);
  const fileDiff = useGitStore((s) => s.fileDiff);
  const diffLoading = useGitStore((s) => s.diffLoading);
  const commitDetail = useGitStore((s) => s.commitDetail);
  const stageHunk = useGitStore((s) => s.stageHunk);

  const [leftW, setLeftW] = useState(LEFT_DEFAULT_W);
  const [treeW, setTreeW] = useState(TREE_DEFAULT_W);
  /**
   * 两侧底部面板各占主区高度的比例（初始都给同一个值 → 两条分界线初始对齐），
   * 但**各存各的**，所以拖动任意一侧只影响它自己。
   */
  const [leftBottom, setLeftBottom] = useState(BOTTOM_RATIO_DEFAULT);
  const [rightBottom, setRightBottom] = useState(BOTTOM_RATIO_DEFAULT);
  /** 主区容器：两条横向分界线都按它的高度换算比例 */
  const mainRef = useRef<HTMLDivElement>(null);

  const onLeftDividerDown = useDragWidth(leftW, LEFT_MIN_W, LEFT_MAX_W, setLeftW);
  const onTreeDividerDown = useDragWidth(treeW, TREE_MIN_W, TREE_MAX_W, setTreeW);
  const onLeftRowDown = useDragRatio(leftBottom, BOTTOM_RATIO_MIN, BOTTOM_RATIO_MAX, mainRef, setLeftBottom);
  const onRightRowDown = useDragRatio(rightBottom, BOTTOM_RATIO_MIN, BOTTOM_RATIO_MAX, mainRef, setRightBottom);

  /*
   * 快捷键也走统一确认入口 —— 否则 Cmd+Shift+K/P 就成了绕过确认的后门。
   * 键盘监听只注册一次（空依赖），所以用 ref 拿「最新一版」的操作对象，
   * 免得到对话框文案里引用到打开仓库那一刻的陈旧 ahead/分支名。
   */
  const gitOps = useGitOps();
  const opsRef = useRef(gitOps);
  useEffect(() => {
    opsRef.current = gitOps;
  }, [gitOps]);

  /* 快捷键 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        document.getElementById('git-commit-input')?.focus();
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        opsRef.current.askPush();
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        opsRef.current.askPull();
      } else if (!mod && !typing && e.key.toLowerCase() === 'r') {
        e.preventDefault();
        void useGitStore.getState().refresh();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /*
   * 定时轮询工作区状态（变更列表自动更新）。
   *
   * 定时器只在「有仓库 + 模块在前台 + 开着自动刷新」时才存在 ——
   * 切走就清掉，不在没人看的时候白跑 git。窗口被藏起来（关窗转后台）
   * 这一类运行期变化没法让 effect 重跑，所以放到每一跳里判（见 shouldPoll）。
   */
  const active = useGitStore((s) => s.active);
  const autoRefresh = useGitPrefs((s) => s.autoRefresh);
  const refreshIntervalSec = useGitPrefs((s) => s.refreshIntervalSec);

  useEffect(() => {
    /* 兜底：模块被挂载本身就意味着被访问过（ModuleHost 懒挂载） */
    useGitStore.getState().setActive(true);
    return () => useGitStore.getState().setActive(false);
  }, []);

  useEffect(() => {
    if (!repoRoot) return;
    const id = window.setInterval(() => {
      const s = useGitStore.getState();
      const busy = s.repoLoading || Object.values(s.ops).some(Boolean);
      if (
        !shouldPoll({
          autoRefresh,
          active,
          hasRepo: Boolean(s.repoRoot),
          busy,
          hidden: document.visibilityState !== 'visible',
        })
      ) {
        return;
      }
      /* 轮询发起的刷新失败不弹提示，否则读不到仓库时会每 5 秒刷一个红条 */
      void s.refresh({ silent: true });
    }, refreshIntervalSec * 1000);
    return () => window.clearInterval(id);
  }, [repoRoot, autoRefresh, active, refreshIntervalSec]);

  if (!repoRoot) return <RepoPicker />;

  /* 已暂存视角 = 可按块撤销；未暂存/未跟踪 = 可按块暂存 */
  const hunkMode: HunkMode = selection?.group === 'staged' ? 'unstage' : selection ? 'stage' : null;

  return (
    <div className="h-full flex flex-col min-h-0">
      <GitToolbar />
      <NoticeBar />
      <ConflictPanel />

      {/* 主区：左列（提交 + 变更 + 分支）| 全高竖线 | 右列（Diff + 提交历史）
          两侧底部面板各按「主区高度 × 比例」定高，初始比例相同 → 两条分界线初始对齐 */}
      <div ref={mainRef} className="flex-1 flex min-h-0">
        {/* 左列 */}
        <div className="shrink-0 flex flex-col min-h-0" style={{ width: leftW }}>
          <CommitPanel />
          <ChangesTree />

          {/* 左列专属的横向分界线（拖它只动左列） */}
          <div
            className="h-1 cursor-row-resize bg-wb-bg-secondary hover:bg-wb-bg-active shrink-0"
            onMouseDown={onLeftRowDown}
            title="拖动调整「变更 / 分支」高度（只影响左栏）"
          />
          <div className="shrink-0 flex flex-col min-h-0" style={{ flex: `0 0 ${leftBottom * 100}%` }}>
            <BranchPanel />
          </div>
        </div>

        {/* 全高竖线：拖左右宽度 */}
        <div
          className="w-1 cursor-col-resize bg-wb-bg-secondary hover:bg-wb-bg-active shrink-0"
          onMouseDown={onLeftDividerDown}
          title="拖动调整左栏宽度"
        />

        {/* 右列 */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          <div className="flex-1 min-h-0">
            {diffLoading ? (
              <div className="p-4 text-wb-text-secondary git-fs-md">加载差异…</div>
            ) : commitDetail ? (
              /* key 用提交 hash：换一个提交就重置「展开的目录 / 选中的文件」 */
              <CommitDetail
                key={commitDetail.meta?.hash ?? 'detail'}
                treeWidth={treeW}
                onTreeDividerDown={onTreeDividerDown}
              />
            ) : selection ? (
              selection.group === 'conflicted' ? (
                <div className="p-4 text-wb-text-secondary git-fs-md">
                  该文件处于冲突状态。请在冲突面板用外部应用解决，再标记为已解决。
                </div>
              ) : (
                <DiffViewer
                  files={fileDiff ?? []}
                  hunkMode={hunkMode}
                  onStageHunk={(path, patch, reverse) => void stageHunk(path, patch, reverse)}
                />
              )
            ) : (
              <DiffViewer files={[]} hunkMode={null} />
            )}
          </div>

          {/* 右列专属的横向分界线（拖它只动右列；初始与左边落在同一 Y） */}
          <div
            className="h-1 cursor-row-resize bg-wb-bg-secondary hover:bg-wb-bg-active shrink-0"
            onMouseDown={onRightRowDown}
            title="拖动调整「Diff / 提交历史」高度（只影响右侧）"
          />
          <div className="shrink-0 flex flex-col min-h-0" style={{ flex: `0 0 ${rightBottom * 100}%` }}>
            <CommitGraph />
          </div>
        </div>
      </div>
    </div>
  );
}
