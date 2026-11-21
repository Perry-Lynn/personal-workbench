/*
 * 首页 · 「现在」状态面板
 * ------------------------------------------------------------------
 * 首页上半屏原来是 Hero + 三张统计卡（模块数 / 分组数 / 最近使用）加一张
 * 余额图表卡。那三张统计卡是**自指**的：侧栏品牌区已经写着「13 个模块」，
 * 把同一个数字再摆一遍回答不了任何问题。而真正在变的那些 —— 几个日志会话
 * 在跑、几处改动没提交、几个 JVM 占着端口 —— 只以侧栏小角标存在，首页一个字不提。
 *
 * 所以换成这一块：四格，各读一个模块的**实时状态**。
 *   · 数据全部来自各模块的 public 门面（git/public.ts、jvm/public.ts、
 *     logsight/public-status.ts、balances/public.ts），只读内存快照 ——
 *     不触发 IPC、不碰主密钥。首页是落地页，不能一进来就打网络 / 弹钥匙串。
 *   · 整页只保留这一处带边框的容器，其余靠排版与留白分层（见 home.css）。
 *
 * 没数据时显示「—」加一句引导，**不编造 0**：「0 处改动」和「没打开仓库」
 * 是两件事，混在一起等于把「不知道」伪装成「很干净」。
 * @Author: fu
 */
import React, { useMemo } from 'react';
import {
  BranchesOutlined,
  CodeOutlined,
  FileTextOutlined,
  WalletOutlined,
} from '@ant-design/icons';
import {
  bucketHistory,
  exhaustedNote,
  healthColor,
  itemHealth,
  percentOf,
  pickHomeMetric,
  sparkY,
  useBalanceHistory,
  useBalanceSnapshot,
  useHomePinnedName,
  useHomePinnedProvider,
  useTrendGranularity,
  useTrendMetric,
} from '@/features/balances/public';
import { useGitStatus } from '@/features/git/public';
import { useJvmStatus } from '@/features/jvm/public';
import { useOpenTabCount, useRunningSessionCount } from '@/features/logsight/public-status';
import { useWorkbenchStore } from '@/store/useWorkbenchStore';

/* =============================================
   ====== 类型 ======
   ============================================= */

/**
 * 主值的语义档位。`muted` 是「没有数据」，刻意与 `good` 分开 ——
 * 两者都该低调，但只有 `good` 能读作「一切正常」。
 */
export type CellTone = 'muted' | 'good' | 'brand' | 'warn' | 'danger';

export interface StatusCell {
  key: string;
  /** 格子左上角的标签 */
  label: string;
  /** 主值（大数字） */
  value: string;
  /** 副行：一句解释主值是什么 */
  sub: string;
  tone: CellTone;
  /** 显式色值（余额按健康度渐变算出来的），优先于 tone */
  valueColor?: string;
  /** 0~100，非 null 时在数值下方画一条细进度条 */
  percent: number | null;
  /** 进度条颜色，null 时用品牌色 */
  barColor: string | null;
  /** 走势采样点，少于 2 个时不画线 */
  series: number[];
  /**
   * 额度用满时额外显示的一行「什么时候回来」（如「重置 10月27日 08:00」）。
   * 用不满 / 不是用量类指标 / 后端没给重置时间时都没有这一行。
   */
  note?: string;
  /** 点击进入哪个模块 */
  target: string;
}

/* =============================================
   ====== 迷你走势线 ======
   =============================================
   只画线不画面积：格子只有 18px 高，面积渐变在这个尺寸下会糊成一块底色。
   不引图表库，内联 SVG 手绘（与 balances 模块的做法一致，保持包体精简）。
   ============================================= */
const SPARK_W = 240;
const SPARK_H = 18;
const SPARK_PAD = 2;

const Sparkline: React.FC<{ points: number[] }> = ({ points }) => {
  const min = Math.min(...points);
  const max = Math.max(...points);
  const stepX = points.length > 1 ? (SPARK_W - SPARK_PAD * 2) / (points.length - 1) : 0;

  /* 纵向映射走 format.sparkY：全等序列画在正中而不是底部（见那里的注释） */
  const coords = points.map((v, i) => ({
    x: SPARK_PAD + i * stepX,
    y: sparkY(v, min, max, SPARK_H, SPARK_PAD),
  }));

  const line = coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
  const last = coords[coords.length - 1];

  /*
   * viewBox 用 preserveAspectRatio="none" 横向拉伸填满格子，
   * 代价是圆点会被压扁 —— 所以末端点由外层容器按百分比定位
   * （x 用百分比、y 用 px；容器高度与 SPARK_H 一致，纵向 1:1 不会跑偏）。
   */
  return (
    <span className="home-cell-spark">
      <svg viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} preserveAspectRatio="none" aria-label="主指标走势">
        <polyline
          points={line}
          fill="none"
          stroke="var(--wb-brand)"
          strokeWidth="1.6"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <span
        className="home-cell-spark-dot"
        style={{
          left: `${((last.x / SPARK_W) * 100).toFixed(2)}%`,
          top: `${last.y.toFixed(1)}px`,
        }}
      />
    </span>
  );
};

/* =============================================
   ====== 四个格子各自的数据 ======
   ============================================= */

/**
 * 智能体余额。
 * 取「主指标」的当前值：它是百分比就画进度条并按健康度上色，
 * 是金额就只显示数字（没有分母，画条就是编的）。
 * 底下那条走势跟的是同一个指标 —— 不跟同一个的话，数字和曲线会对不上。
 */
function useBalanceCell(): StatusCell {
  /* 健康色要按底色选亮度（深色主题用饱和色，浅色主题要压暗，见 format.healthColor） */
  const theme = useWorkbenchStore((s) => s.theme);
  const pinned = useHomePinnedProvider();
  const pinnedName = useHomePinnedName();
  const snapshot = useBalanceSnapshot(pinned);
  const history = useBalanceHistory(pinned);
  const granularity = useTrendGranularity();
  /* 用户在余额面板里选过「跟哪个指标」，这里沿用同一个选择；null = 自动挑 */
  const trendMetric = useTrendMetric();

  return useMemo<StatusCell>(() => {
    const base = {
      key: 'balances',
      label: '智能体余额',
      target: 'balances',
      percent: null,
      barColor: null,
      series: [] as number[],
    } as const;

    if (!pinned) {
      return { ...base, value: '—', sub: '还没固定平台', tone: 'muted' };
    }
    if (!snapshot || snapshot.items.length === 0) {
      return {
        ...base,
        value: '—',
        sub: `${snapshot?.name ?? pinnedName ?? pinned} 还没有数据`,
        tone: 'muted',
      };
    }

    const primary = pickHomeMetric(snapshot.items, trendMetric);
    if (!primary) {
      return { ...base, value: '—', sub: '这个平台没返回指标', tone: 'muted' };
    }

    const health = itemHealth(primary);
    const pct = percentOf(primary.value);

    /*
     * 三档与余额模块的告警阈值同向：健康度 < 20 才是真的该紧张，
     * 20~50 提示一下，50 以上不上色（一片绿等于没有信号）。
     */
    const tone: CellTone =
      health === null ? 'brand' : health >= 50 ? 'good' : health >= 20 ? 'warn' : 'danger';

    /*
     * history 是按平台存的一维点流，每个点带自己的 label。老点（剩余额度）
     * 和新点（本时段已用）会混在同一份里，不先按 label 切就整条画，
     * 会出现「984 跳到 66」那种断崖。所以这里只取**当前展示的那个指标**那条时间线。
     *
     * ⚠️ 必须与上面取大数字的是同一个指标（`pickHomeMetric` 已经保证），
     * 否则数字和曲线说的不是一回事。
     */
    const points = history.filter((h) => h.label === primary.label);
    const series = bucketHistory(points, granularity).map((p) => p.v);

    return {
      ...base,
      value: primary.value,
      sub: [snapshot.name ?? pinnedName ?? pinned, primary.label].filter(Boolean).join(' · '),
      tone,
      valueColor: health === null ? undefined : healthColor(health, theme),
      percent: pct,
      barColor: health === null ? null : healthColor(health, theme),
      series,
      /* 用满了才多这一行；没有重置时间就什么都不加（判据见 balances/format.exhaustedNote） */
      note: exhaustedNote(primary) ?? undefined,
    };
  }, [pinned, pinnedName, snapshot, history, granularity, trendMetric, theme]);
}

/** 日志会话：只数 Streaming / Connected（口径见 logsight/public-status.ts） */
function useLogsightCell(): StatusCell {
  const running = useRunningSessionCount();
  const tabs = useOpenTabCount();

  return useMemo<StatusCell>(
    () => ({
      key: 'logsight',
      label: '日志会话',
      target: 'logsight',
      value: String(running),
      /* 「有标签但都断了」和「一个都没开」是两种处境，分开说 */
      sub:
        running > 0
          ? `运行中 · 共 ${tabs} 个标签`
          : tabs > 0
            ? `${tabs} 个标签都已断开`
            : '没有打开的会话',
      tone: running > 0 ? 'good' : 'muted',
      percent: null,
      barColor: null,
      series: [],
    }),
    [running, tabs],
  );
}

/** Git：没打开过仓库时 hasRepo 为 false，显示「—」而不是 0 */
function useGitCell(): StatusCell {
  const git = useGitStatus();

  return useMemo<StatusCell>(() => {
    if (!git.hasRepo) {
      return {
        key: 'git',
        label: 'Git 仓库',
        target: 'git',
        value: '—',
        sub: '还没打开仓库',
        tone: 'muted',
        percent: null,
        barColor: null,
        series: [],
      };
    }
    /* ahead / behind 只在非零时出现，避免每格都挂着「↑0 ↓0」 */
    const track = [
      git.ahead > 0 ? `↑${git.ahead}` : '',
      git.behind > 0 ? `↓${git.behind}` : '',
    ]
      .filter(Boolean)
      .join(' ');

    return {
      key: 'git',
      label: 'Git 仓库',
      target: 'git',
      value: String(git.changed),
      sub: [git.branch ?? 'detached HEAD', track].filter(Boolean).join(' '),
      tone: git.changed > 0 ? 'warn' : 'good',
      percent: null,
      barColor: null,
      series: [],
    };
  }, [git]);
}

/** JVM：worst 为 null 表示一个进程都没有，与 'ok'（有进程但都健康）不同 */
function useJvmCell(): StatusCell {
  const jvm = useJvmStatus();

  return useMemo<StatusCell>(() => {
    if (jvm.count === 0) {
      return {
        key: 'jvm',
        label: 'JVM 进程',
        target: 'jvm',
        value: '0',
        sub: '没有 Java 进程',
        tone: 'muted',
        percent: null,
        barColor: null,
        series: [],
      };
    }
    /* 端口最多列 3 个：格子里放不下更多，完整列表在模块里 */
    const ports = jvm.ports.slice(0, 3).join(' / ');

    return {
      key: 'jvm',
      label: 'JVM 进程',
      target: 'jvm',
      value: String(jvm.count),
      sub: ports ? `端口 ${ports}${jvm.ports.length > 3 ? ' …' : ''}` : '没有监听端口',
      tone: jvm.worst === 'danger' ? 'danger' : jvm.worst === 'warn' ? 'warn' : 'good',
      percent: null,
      barColor: null,
      series: [],
    };
  }, [jvm]);
}

/* =============================================
   ====== 面板 ======
   ============================================= */

/** 每个格子左上角的小图标。用组件引用而不是元素，省一层 JSX */
const CELL_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  balances: WalletOutlined,
  logsight: FileTextOutlined,
  git: BranchesOutlined,
  jvm: CodeOutlined,
};

const HomeStatusPanel: React.FC = () => {
  const setActiveModule = useWorkbenchStore((s) => s.setActiveModule);
  const balances = useBalanceCell();
  const logsight = useLogsightCell();
  const git = useGitCell();
  const jvm = useJvmCell();

  const cells = useMemo(() => [balances, logsight, git, jvm], [balances, logsight, git, jvm]);

  return (
    <section className="home-now">
      <div className="home-now-head">
        <span className="home-now-title">现在</span>
        <span className="home-now-hint">点击任一格进入对应模块</span>
      </div>

      <div className="home-now-grid">
        {cells.map((cell) => {
          const Icon = CELL_ICON[cell.key];
          return (
            <button
              key={cell.key}
              type="button"
              className="home-cell"
              onClick={() => setActiveModule(cell.target)}
            >
              <span className="home-cell-label">
                {Icon && <Icon className="home-cell-icon" />}
                {cell.label}
              </span>

              <span
                className={`home-cell-value is-${cell.tone}`}
                style={cell.valueColor ? { color: cell.valueColor } : undefined}
              >
                {cell.value}
              </span>

              {cell.percent !== null && (
                <span className="home-cell-bar">
                  <span
                    style={{
                      width: `${Math.max(0, Math.min(100, cell.percent))}%`,
                      backgroundColor: cell.barColor ?? 'var(--wb-brand)',
                    }}
                  />
                </span>
              )}

              <span className="home-cell-sub">{cell.sub}</span>

              {cell.note && <span className="home-cell-note">{cell.note}</span>}

              {cell.series.length >= 2 && <Sparkline points={cell.series} />}
            </button>
          );
        })}
      </div>
    </section>
  );
};

/*
 * 用 memo 包一层：拖拽重排时首页每帧都会重渲染（setLiveOrder），
 * 而这一块要算额度条、sparkline 路径点和四格文案，跟重排毫无关系。
 * 它自己没有 props，memo 之后只会在内部订阅的 store 变化时重渲染。
 */
export default React.memo(HomeStatusPanel);
