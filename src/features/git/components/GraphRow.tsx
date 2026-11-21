/*
 * 提交图的一行（react-window 的行渲染器）
 * ------------------------------------------------------------------
 * 左侧 SVG 条只画三种笔（见 graphLayout.ts 文件头）：
 *   · passThrough 竖线：贯穿整行
 *   · incoming    上半截：行顶 → 圆点
 *   · edges       下半截：圆点 → 行底（跨 lane 走贝塞尔曲线）
 * 行与行首尾相接、线端圆头，相邻行的线天然接成一条连续曲线。
 * 右侧按 IDEA 新 UI 的顺序排：hash → 提交说明 → 分支标签 → 作者 → 时间。
 * @Author: fu
 */
import type { CSSProperties } from 'react';
import dayjs from 'dayjs';
import { useGitStore } from '../store/useGitStore';
import type { GraphRowData } from '../types';

/** 行高（固定值，曲线控制点按这个高度取） */
export const GRAPH_ROW_H = 26;
/** lane 间距 */
const LANE_W = 13;
const PAD = 9;
/** 竖线/曲线粗细与圆点半径 */
const LINE_W = 1.4;
const DOT_R = 3.6;
const MERGE_R = 4.6;

export interface GraphRowDataPack {
  rows: GraphRowData[];
  maxLanes: number;
  colors: string[];
}

/**
 * 相对时间（对齐 IDEA 的显示习惯）。
 * 今天/昨天用词，更早用 MM-DD —— 比裸时间戳更容易一眼判断新旧。
 */
function relTime(unix: number): string {
  const d = dayjs.unix(unix);
  const now = dayjs();
  const day = d.format('YYYY-MM-DD');
  if (day === now.format('YYYY-MM-DD')) return `今天 ${d.format('HH:mm')}`;
  if (day === now.subtract(1, 'day').format('YYYY-MM-DD')) return `昨天 ${d.format('HH:mm')}`;
  if (d.year() === now.year()) return d.format('MM-DD HH:mm');
  return d.format('YYYY-MM-DD');
}

/** %(D) 形如 "HEAD -> main, tag: v1.0, origin/main" → 逐个标签 */
function refChips(refs: string): { text: string; hot: boolean }[] {
  return refs
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((t) => {
      const hot = t.startsWith('HEAD');
      /* "HEAD -> main" 只展示 main；"tag: v1.0" 保留原名 */
      const text = t.includes('->') ? t.split('->').pop()!.trim() : t;
      return { text, hot };
    });
}

export function GraphRow({ index, style, data }: { index: number; style: CSSProperties; data: GraphRowDataPack }) {
  const { rows, maxLanes, colors } = data;
  const row = rows[index];
  const commits = useGitStore((s) => s.commits);
  const selectedCommit = useGitStore((s) => s.selectedCommit);
  const selectCommit = useGitStore((s) => s.selectCommit);
  const c = commits[index];
  if (!row || !c) return null;

  const w = PAD * 2 + maxLanes * LANE_W;
  const h = GRAPH_ROW_H;
  const mid = h / 2;
  const x = (lane: number) => PAD + lane * LANE_W;
  const color = (lane: number) => colors[lane % colors.length];
  const selected = selectedCommit === c.hash;

  return (
    <div
      style={style}
      className={`git-graph-row flex items-center cursor-pointer pr-3 ${selected ? 'is-selected' : ''}`}
      onClick={() => void selectCommit(c.hash)}
      title={`${c.subject}\n${c.author} · ${dayjs.unix(c.date).format('YYYY-MM-DD HH:mm')}`}
    >
      <svg width={w} height={h} className="shrink-0">
        {/* 贯穿整行的竖线（来自上一行） */}
        {row.passThrough.map((lane) => (
          <line
            key={`t${lane}`}
            x1={x(lane)}
            y1={0}
            x2={x(lane)}
            y2={h}
            stroke={color(lane)}
            strokeWidth={LINE_W}
            strokeLinecap="round"
            opacity={0.75}
          />
        ))}
        {/* 本提交 lane 的上半截（行顶 → 圆点） */}
        {row.incoming && (
          <line
            x1={x(row.lane)}
            y1={0}
            x2={x(row.lane)}
            y2={mid}
            stroke={color(row.lane)}
            strokeWidth={LINE_W}
            strokeLinecap="round"
            opacity={0.75}
          />
        )}
        {/* 圆点 → 行底：直线下行 / 跨 lane 曲线 */}
        {row.edges.map((e, i) =>
          e.curve ? (
            <path
              key={`e${i}`}
              d={`M ${x(row.lane)},${mid} C ${x(row.lane)},${mid + (h - mid) * 0.62} ${x(e.to)},${
                h - (h - mid) * 0.42
              } ${x(e.to)},${h}`}
              stroke={color(row.lane)}
              strokeWidth={LINE_W}
              strokeLinecap="round"
              fill="none"
              opacity={0.75}
            />
          ) : (
            <line
              key={`e${i}`}
              x1={x(row.lane)}
              y1={mid}
              x2={x(row.lane)}
              y2={h}
              stroke={color(row.lane)}
              strokeWidth={LINE_W}
              strokeLinecap="round"
              opacity={0.75}
            />
          ),
        )}
        {/* 提交圆点：普通实心 + 底色描边；合并提交画成空心环；选中/HEAD 加亮 */}
        {row.merge ? (
          <circle
            cx={x(row.lane)}
            cy={mid}
            r={MERGE_R}
            fill="var(--wb-bg-base)"
            stroke={color(row.lane)}
            strokeWidth={2}
          />
        ) : (
          <circle
            cx={x(row.lane)}
            cy={mid}
            r={DOT_R}
            fill={color(row.lane)}
            stroke="var(--wb-bg-base)"
            strokeWidth={1.6}
          />
        )}
        {selected && (
          <circle cx={x(row.lane)} cy={mid} r={MERGE_R + 3} fill="none" stroke={color(row.lane)} strokeWidth={1} opacity={0.5} />
        )}
      </svg>

      {/* 文本：hash → 说明 → 分支标签 → 作者 → 时间 */}
      <span className="git-hash shrink-0 truncate">{c.shortHash}</span>
      <span className="git-subject flex-1 truncate">{c.subject}</span>
      {refChips(c.refs).map((chip) => (
        <span key={chip.text} className={`git-chip shrink-0 ${chip.hot ? 'is-hot' : ''}`}>
          {chip.text}
        </span>
      ))}
      <span className="git-meta shrink-0 truncate">{c.author}</span>
      <span className="git-meta shrink-0">{relTime(c.date)}</span>
    </div>
  );
}

export default GraphRow;
