/*
 * 提交历史面板（底部，IDEA 新 UI 的 Log 窗）
 * ------------------------------------------------------------------
 * 虚拟滚动（react-window）：几千条提交只渲染可视区；
 * 滚到底自动加载下一批（git log --skip/-n 分页，见 useGitStore.loadLog）。
 * lane 布局是纯函数（graphLayout.ts），这里只把结果画出来。
 * @Author: fu
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from 'antd';
import { VariableSizeList as List } from 'react-window';
import { getPalette } from '@/core/theme';
import { useWorkbenchStore } from '@/store/useWorkbenchStore';
import { layoutGraph, maxLanes } from '../utils/graphLayout';
import { useGitStore } from '../store/useGitStore';
import { GraphRow, GRAPH_ROW_H } from './GraphRow';
import type { GraphRowDataPack } from './GraphRow';

/** lane 配色循环（取主题色板里区分度高的 8 色） */
function laneColors(theme: 'dark' | 'light'): string[] {
  const p = getPalette(theme);
  return [p.brand, p.cyan, p.blue, p.warning, p.error, p.success, p.info, p.brandHover];
}

export function CommitGraph() {
  const commits = useGitStore((s) => s.commits);
  const logLoading = useGitStore((s) => s.logLoading);
  const logHasMore = useGitStore((s) => s.logHasMore);
  const loadLog = useGitStore((s) => s.loadLog);
  const viewBranch = useGitStore((s) => s.viewBranch);
  const viewBranchLog = useGitStore((s) => s.viewBranchLog);
  const theme = useWorkbenchStore((s) => s.theme);
  const [listH, setListH] = useState(200);
  const wrapRef = useRef<HTMLDivElement>(null);

  /* 面板高度由外层布局给（上下分区的比例），内部列表高度按实际容器量（ResizeObserver） */
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    /* 32 = 表头高度（h-8），列表高度必须减掉它，否则列表会溢出面板被裁掉 */
    const measure = () => setListH(Math.max(80, el.clientHeight - 32));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rows = useMemo(() => layoutGraph(commits), [commits]);
  const lanes = useMemo(() => maxLanes(rows), [rows]);
  const colors = useMemo(() => laneColors(theme), [theme]);
  const itemData = useMemo<GraphRowDataPack>(() => ({ rows, maxLanes: lanes, colors }), [rows, lanes, colors]);

  const onScroll = useCallback(
    ({ scrollOffset, scrollDirection }: { scrollOffset: number; scrollDirection: 'forward' | 'backward' }) => {
      if (scrollDirection !== 'forward' || !logHasMore || logLoading) return;
      /* 距底部不足 8 行时预取下一批 */
      const totalH = commits.length * GRAPH_ROW_H;
      if (totalH - scrollOffset - listH < GRAPH_ROW_H * 8) void loadLog(false);
    },
    [commits.length, logHasMore, logLoading, listH, loadLog],
  );

  return (
    <div ref={wrapRef} className="h-full flex flex-col min-h-0">
      <div className="h-8 flex items-center gap-2 px-3 border-b border-wb-border-l1 shrink-0">
        <span className="text-wb-text-secondary git-fs-sm font-medium">提交历史</span>
        {viewBranch ? (
          <>
            {/* 正在看别的分支：明确标出，并给一条回当前分支的路 */}
            <span className="git-chip is-hot">{viewBranch.label}</span>
            <span className="text-wb-text-tertiary git-fs-xs">正在查看该分支（未切换）</span>
            <Button size="small" type="text" className="git-fs-xs px-1 h-5" onClick={() => viewBranchLog(null)}>
              返回当前分支
            </Button>
          </>
        ) : (
          <span className="text-wb-text-tertiary git-fs-xs">跟随当前分支</span>
        )}
        <div className="flex-1" />
        <span className="text-wb-text-tertiary git-fs-xs">
          {commits.length}
          {logHasMore ? '+' : ''} 条
        </span>
        {logLoading && <span className="text-wb-text-tertiary git-fs-xs">加载中…</span>}
      </div>
      {commits.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-wb-text-tertiary git-fs-md">
          {logLoading ? '加载中…' : '暂无提交'}
        </div>
      ) : (
        <List
          height={listH}
          width="100%"
          itemCount={commits.length}
          /* 行高恒定：VariableSizeList 与 FixedSizeList 同 API，用函数返回即可 */
          itemSize={() => GRAPH_ROW_H}
          onScroll={onScroll}
        >
          {({ index, style }) => <GraphRow index={index} style={style} data={itemData} />}
        </List>
      )}
    </div>
  );
}

export default CommitGraph;
