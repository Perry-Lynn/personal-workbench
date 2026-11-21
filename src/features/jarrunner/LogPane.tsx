/*
 * JAR 运行器 · 输出面板
 * ------------------------------------------------------------------
 * 输出区**复用 LogSight 的日志查看器**（走 `logsight/public.ts` 门面），
 * 而不是自己再写一套日志列表。换来的能力：虚拟滚动（几千行也不卡）、
 * 列头与列宽拖拽、列显示隐藏、关键字高亮、正则与大小写开关、级别筛选、
 * 异常堆栈折叠、右键复制选中内容。
 *
 * 五件要紧的事：
 *   1. **原始流要先适配**（logAdapt.ts）：子进程给的是纯文本，查看器要的是
 *      结构化行。适配之后 Spring Boot 的 logback 输出才有级别 / 线程 / logger
 *      可筛；解析不出来的行退化成「整行即消息」。
 *   2. **`height` 必须显式传**。不传时查看器走 `window.innerHeight - rect.top`
 *      的绝对算法 —— 那是给 LogSight 的整屏式布局写的。本模块是文档式布局
 *      （纵向滚动由面板统一负责），绝对算法会把列表撑出容器、整页多出一截滚动条。
 *   3. **查看器是倒序的**（最新一行在最上面）。这是日志查看器本来的行为，
 *      也是复用它的代价之一；好处是跑着的服务永远不用滚就能看到最新输出。
 *      所以「复制」要按行号排回正序 —— 否则贴到别处是倒着的。
 *   4. **清空同时清后端**：只清前端的话，下次拉后端日志旧内容会全回来。
 *   5. **「复制」与「导出」共用同一份正文**（`rowsToText()`）：都按行号排回正序。
 *      各写一遍的话，迟早有一处忘了排序 —— 而「导出的文件是倒着的」不报任何错。
 * @Author: fu
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  App as AntApp,
  Button,
  Checkbox,
  Empty,
  Input,
  Select,
  Space,
  Tooltip,
  Typography,
} from 'antd';
import { ClearOutlined, CopyOutlined, DownloadOutlined } from '@ant-design/icons';
import { copyText } from '@/core/clipboard';
import { exportTextFile, safeFileName } from '@/core/export';
import {
  applyLogFilter,
  DEFAULT_SEARCH_FILTER,
  LogColumnHeader,
  LogViewer,
  type LogLevel,
  type RenderRow,
  type SearchFilter,
} from '@/features/logsight/public';
import { adaptLines, ERROR_LEVELS, LEVEL_OPTIONS } from './logAdapt';
import { logStats } from './format';
import { useJarRunnerStore } from './store';
import type { LogLine, RunInfo } from './types';

const { Text } = Typography;
/* 模块级常量空数组：zustand 选择器每次返回新数组会让订阅方无限重渲染 */
const EMPTY: LogLine[] = [];

/*
 * 级别下拉的候选项：**英文名 + 一个级别色的圆点**。
 *
 * 颜色来自 `log-level-<级别小写>` —— 这正是日志查看器给消息正文上色用的同一套类
 * （logsight.css 里深浅两套都定义好了），圆点用 `::before` 取 `currentColor`，
 * 于是下拉里的颜色与列表里那一行的颜色**永远一致**。不在这里另抄一份色值：
 * 抄一份就迟早会有一处改了、另一处没改。
 */
const LEVEL_SELECT_OPTIONS = LEVEL_OPTIONS.map((o) => ({
  value: o.value,
  label: (
    <span className={`jar-level-opt log-level-${o.value.toLowerCase()}`}>{o.label}</span>
  ),
}));

/**
 * 查看器高度。它是虚拟滚动的，必须给一个确定高度（原因见文件头第 2 条）。
 *
 * 520 这个数是**给人看的行数**换算来的（单行约 22px ≈ 23 行）：
 * 输出是这块屏幕上真正要看的东西，而它右边整列现在只归它一个人。
 * 再往上加就会把配置页顶出屏幕，得靠滚才能看到下面的「已保存的配置」。
 */
const VIEW_HEIGHT = 520;

/**
 * 读工作台当前的日志字号（`--wb-log-font-size`）。
 *
 * 为什么不能不管：查看器的 `fontSize` 是**数值 prop**，它会把自己写成内联的
 * CSS 变量覆盖掉外层 —— 不读这个值的话，用户在「设置 → 基准字号」里调了字号，
 * 这个面板不跟，而 LogSight 那边跟，两处日志字号会不一致。
 */
function readLogFontSize(): number {
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--wb-log-font-size');
    const n = parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? n : 12.5;
  } catch {
    return 12.5;
  }
}

/*
 * 列宽与隐藏列存 localStorage。
 *
 * 为什么不放组件 state：切到「运行记录」页时本组件会**卸载**（两个视图是互斥渲染的），
 * 切回来就回默认列宽了；而且列宽这种「调一次用很久」的设置跨会话保留才有意义。
 * LogSight 那边也是这么存的（同一套思路，键名按模块分开）。
 */
const LS_WIDTHS = 'jarrunner:log-column-widths';
const LS_HIDDEN = 'jarrunner:log-hidden-columns';

function loadColumnWidths(): Record<string, number> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(LS_WIDTHS) ?? '{}');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      /* 存储是用户能改的：只收正数，否则拖出来的列宽可能是 NaN / 负数 */
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function loadHiddenColumns(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(LS_HIDDEN) ?? '[]');
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function saveSetting(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 配额满 / 隐私模式：记不住不影响本次会话 */
  }
}

/*
 * 「复制」与「导出」共用一份正文：按行号排回**正序**再拼。
 *
 * 两处各写一遍的话，迟早有一处忘了排序 —— 而导出的文件是倒着的这件事
 * 不会报任何错，只有贴到别处、或者拿编辑器打开时才发现。
 * （查看器本身是倒序展示的，原因见文件头第 3 条。）
 */
function rowsToText(rows: RenderRow[]): string {
  return [...rows]
    .sort((a, b) => a.line.line_no - b.line.line_no)
    .map((r) => r.line.raw)
    .join('\n');
}

interface LogPaneProps {
  run: RunInfo | null;
}

const LogPane: React.FC<LogPaneProps> = ({ run }) => {
  const { message } = AntApp.useApp();
  const logs = useJarRunnerStore((s) => (run ? (s.logsByRun[run.id] ?? EMPTY) : EMPTY));
  const clearLogs = useJarRunnerStore((s) => s.clearLogs);

  const [keyword, setKeyword] = useState('');
  const [exclude, setExclude] = useState('');
  const [levels, setLevels] = useState<LogLevel[]>([]);
  const [regex, setRegex] = useState(false);
  const [ci, setCi] = useState(true);
  const [collapseStack, setCollapseStack] = useState(true);
  const [autoScroll, setAutoScroll] = useState(true);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(loadColumnWidths);
  const [hiddenColumns, setHiddenColumns] = useState<string[]>(loadHiddenColumns);
  const [logFontSize] = useState(readLogFontSize);

  const stats = useMemo(() => logStats(logs), [logs]);
  /* 原始流 → 查看器行。顺序保持不变：查看器要靠它把堆栈续行归到正确的上一行 */
  const viewerLines = useMemo(() => adaptLines(logs), [logs]);

  /*
   * 过滤条件由几个开关拼出来（而不是存一个 SearchFilter 对象）：
   * 分开存的话「只看错误」和级别多选会变成两份真值，迟早对不上。
   */
  const filter = useMemo<SearchFilter>(
    () => ({
      ...DEFAULT_SEARCH_FILTER,
      keyword: keyword.trim() ? [keyword.trim()] : [],
      keyword_exclude: exclude.trim() ? [exclude.trim()] : [],
      regex,
      case_insensitive: ci,
      levels,
      collapse_stacktrace: collapseStack,
    }),
    [keyword, exclude, regex, ci, levels, collapseStack],
  );

  const filtered = useMemo(() => applyLogFilter(viewerLines, filter), [viewerLines, filter]);

  /*
   * 「只看错误」是级别多选的一个**派生视图**：勾上就等于选中错误 + 致命。
   * 反过来不成立（只选 Warn 时它不该是勾上的），所以是单向派生。
   */
  const onlyError =
    levels.length === ERROR_LEVELS.length && ERROR_LEVELS.every((l) => levels.includes(l));
  const setOnlyError = useCallback((v: boolean) => {
    setLevels(v ? [...ERROR_LEVELS] : []);
  }, []);

  const isFiltered = !!keyword.trim() || !!exclude.trim() || levels.length > 0;

  /* 换了一个 run 就重置过滤条件（上一条的条件留着会让人以为这条没输出） */
  useEffect(() => {
    setKeyword('');
    setExclude('');
    setLevels([]);
  }, [run?.id]);

  const handleColumnWidthChange = useCallback((id: string, width: number) => {
    /* 拖拽时每帧都会调；落盘的是个小 JSON，代价可忽略，而不落盘的话切个视图就白调了 */
    setColumnWidths((prev) => {
      const next = { ...prev, [id]: width };
      saveSetting(LS_WIDTHS, next);
      return next;
    });
  }, []);

  const handleColumnVisibilityChange = useCallback((next: string[]) => {
    setHiddenColumns(next);
    saveSetting(LS_HIDDEN, next);
  }, []);

  const handleCopyRow = useCallback(
    async (text: string) => {
      try {
        await copyText(text);
        message.success('已复制该行');
      } catch (e) {
        message.error(e instanceof Error ? e.message : '复制失败');
      }
    },
    [message],
  );

  const handleCopy = useCallback(async () => {
    const rows = filtered.rows;
    if (rows.length === 0) {
      message.info('没有可复制的日志');
      return;
    }
    try {
      await copyText(rowsToText(rows));
      message.success(`已复制 ${rows.length} 行`);
    } catch (e) {
      message.error(e instanceof Error ? e.message : '复制失败');
    }
  }, [filtered.rows, message]);

  /*
   * 导出成 .log 文件。
   *
   * ⚠️ 走 `@/core/export` 的系统保存对话框，**不是** Blob + `a[download]`：
   * 后者在本应用的 WKWebView 里会被静默取消（点了什么都不发生、也不报错），
   * 取证见 core/export.ts 与 src-tauri/src/core/export.rs 的文件头。
   *
   * 导的是**当前显示的行**：用户先筛出要看的那批再导出，比导全量更符合意图；
   * 没筛的时候两者本来就一样。
   */
  const handleExport = useCallback(async () => {
    const rows = filtered.rows;
    if (rows.length === 0) {
      message.warning('没有可导出的日志');
      return;
    }
    try {
      const path = await exportTextFile(
        `${safeFileName(run?.name ?? '', 'jarrunner')}_${Date.now()}.log`,
        rowsToText(rows),
        { label: '日志文件', ext: 'log' },
      );
      /* 用户点了取消：不是错误，静默返回 */
      if (!path) return;
      message.success(`已导出 ${rows.length} 行`);
    } catch (e) {
      message.error(e instanceof Error ? e.message : '导出失败');
    }
  }, [filtered.rows, message, run]);

  const handleClear = useCallback(async () => {
    if (!run) return;
    try {
      await clearLogs(run.id);
    } catch (e) {
      message.error(e instanceof Error ? e.message : '清空失败');
    }
  }, [clearLogs, message, run]);

  return (
    <div className="jar-log-pane">
      <div className="jar-log-bar">
        <Space size={8} wrap>
          <Text className="jar-log-stat">
            {stats.total} 行
            {stats.errors > 0 && (
              <span className="jar-log-stat-err"> · {stats.errors} 条 stderr</span>
            )}
          </Text>
          {isFiltered ? (
            <Text type="secondary" className="jar-log-stat">
              显示 {filtered.rows.length} 行（已过滤）
            </Text>
          ) : null}
          {viewerLines.length > 0 ? (
            <Text type="secondary" className="jar-log-stat">
              最新在上
            </Text>
          ) : null}
        </Space>
        <Space size={8} wrap>
          <Checkbox
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
            className="jar-log-check"
          >
            自动滚动
          </Checkbox>
          <Button size="small" icon={<CopyOutlined />} onClick={handleCopy}>
            复制
          </Button>
          <Button size="small" icon={<DownloadOutlined />} onClick={handleExport}>
            导出
          </Button>
          <Button size="small" icon={<ClearOutlined />} onClick={handleClear}>
            清空
          </Button>
        </Space>
      </div>

      <div className="jar-log-bar">
        <Space size={8} wrap>
          <Input
            size="small"
            allowClear
            placeholder="搜索日志"
            value={keyword}
            style={{ width: 170 }}
            onChange={(e) => setKeyword(e.target.value)}
          />
          <Input
            size="small"
            allowClear
            placeholder="排除（不含这些）"
            value={exclude}
            style={{ width: 150 }}
            onChange={(e) => setExclude(e.target.value)}
          />
          <Select<LogLevel[]>
            mode="multiple"
            size="small"
            allowClear
            placeholder="全部级别"
            value={levels}
            options={LEVEL_SELECT_OPTIONS}
            style={{ minWidth: 150, maxWidth: 280 }}
            maxTagCount="responsive"
            onChange={(v) => setLevels(v ?? [])}
          />
          <Tooltip title="等价于只选 Error + Fatal">
            <Checkbox
              checked={onlyError}
              onChange={(e) => setOnlyError(e.target.checked)}
              className="jar-log-check"
            >
              只看错误
            </Checkbox>
          </Tooltip>
        </Space>
        <Space size={6} wrap>
          <Tooltip title="按正则匹配（对搜索词与排除词同时生效）">
            <Button
              size="small"
              type={regex ? 'primary' : 'default'}
              onClick={() => setRegex((v) => !v)}
            >
              .*
            </Button>
          </Tooltip>
          <Tooltip title={ci ? '当前忽略大小写，点击改为区分' : '当前区分大小写，点击改为忽略'}>
            <Button
              size="small"
              type={ci ? 'default' : 'primary'}
              onClick={() => setCi((v) => !v)}
            >
              Aa
            </Button>
          </Tooltip>
          <Checkbox
            checked={collapseStack}
            onChange={(e) => setCollapseStack(e.target.checked)}
            className="jar-log-check"
          >
            折叠堆栈
          </Checkbox>
        </Space>
      </div>

      {!run ? (
        <div className="jar-log-empty" style={{ height: VIEW_HEIGHT }}>
          <Empty description="还没有运行记录，先拖个 jar 进来跑一次" />
        </div>
      ) : viewerLines.length === 0 ? (
        <div className="jar-log-empty" style={{ height: VIEW_HEIGHT }}>
          <Empty description="进程还没输出任何内容（也可能刚启动）" />
        </div>
      ) : (
        <div className="jar-log-viewer">
          <LogColumnHeader
            columnWidths={columnWidths}
            hiddenColumns={hiddenColumns}
            onColumnWidthChange={handleColumnWidthChange}
            onColumnVisibilityChange={handleColumnVisibilityChange}
          />
          {filtered.rows.length === 0 ? (
            /* 空结果自己画：查看器自带的空状态文案是给 LogSight 写的
               （「启动实时流或加载历史日志」），放在这里驴唇不对马嘴 */
            <div className="jar-log-empty" style={{ height: VIEW_HEIGHT }}>
              <Empty
                description="没有符合当前过滤条件的行"
                image={Empty.PRESENTED_IMAGE_SIMPLE}
              />
            </div>
          ) : (
            <LogViewer
              /* 换一个 run 就重挂一次：滚动位置与「展开了哪些堆栈」都归零。
                 不重挂的话，切到另一条（行数更少的）记录时，列表会停在上一
                 条的滚动偏移上，看起来像「这条没输出」 */
              key={run?.id ?? 'none'}
              rows={filtered.rows}
              filter={filter}
              height={VIEW_HEIGHT}
              autoScroll={autoScroll}
              fontSize={logFontSize}
              columnWidths={columnWidths}
              hiddenColumns={hiddenColumns}
              onCopy={handleCopyRow}
            />
          )}
        </div>
      )}
    </div>
  );
};

export default LogPane;
