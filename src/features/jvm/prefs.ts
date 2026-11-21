/*
 * JVM 进程看板模块 · 用户偏好
 * ------------------------------------------------------------------
 * 全部持久化到 localStorage（纯前端，不涉及密钥、不涉及 IPC）。
 *
 * 与余额模块不同，这里的刷新间隔是**秒级**：JVM 进程列表是本机数据、
 * 采集一次通常不到 300ms，而用户看这个面板的场景（「我刚起了个服务，
 * 端口起来了没」）需要的是秒级反馈，分钟级等于没有。
 *
 * 推送徽章默认关：进程起落比余额变动频繁得多，默认开的话徽章会被刷屏。
 * @Author: fu
 */
import { create } from 'zustand';

export interface JvmPrefs {
  /** 是否定时自动刷新 */
  autoRefresh: boolean;
  /** 自动刷新间隔（秒） */
  refreshIntervalSec: number;
  /** 用哪台 JDK 跑诊断工具；null = 后端自动挑 */
  toolHome: string | null;
  /** 徽章连上时是否推送 JVM 告警（堆/CPU 到阈值） */
  pushToBadge: boolean;
}

/** 间隔预设（秒） */
export const REFRESH_OPTIONS_SEC = [5, 10, 30, 60] as const;
/** 默认间隔（秒） */
export const DEFAULT_REFRESH_SEC = 10;
/**
 * 上下限（秒）。
 * 下限 3 秒：扫描要 fork 若干子进程，再快就是在给自己制造负载，
 * 而「进程刚起、端口还没监听」这件事本来也要几百毫秒才有答案。
 * 上限 3600 秒（1 小时）：再长还不如手动点刷新。
 */
export const MIN_REFRESH_SEC = 3;
export const MAX_REFRESH_SEC = 3600;

const LS_KEY = 'workbench:jvm-prefs';

const DEFAULTS: JvmPrefs = {
  autoRefresh: true,
  refreshIntervalSec: DEFAULT_REFRESH_SEC,
  toolHome: null,
  pushToBadge: false,
};

/**
 * 间隔收敛。localStorage 是用户可改的，0 / 负数 / 字符串都属于**损坏值**，
 * 一律回默认 —— 夹成 3 秒会变成「每秒 fork 一堆子进程」，比默认值危险得多。
 *
 * 导出是为了让 scripts/logic-test.ts 能直接断言边界。
 */
export function validIntervalSec(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_REFRESH_SEC;
  const n = Math.round(v);
  if (n < MIN_REFRESH_SEC) return DEFAULT_REFRESH_SEC;
  return n > MAX_REFRESH_SEC ? MAX_REFRESH_SEC : n;
}

/**
 * 该不该给「自动扫描」排定时器。
 *
 * 两条**互相独立**的理由各自都能否决：
 *   1. 用户关了自动刷新；
 *   2. 窗口在后台（关窗转后台）—— 那时没有观察者，扫描纯属白扫。
 *      注意不能靠「系统会节流隐藏页面的定时器」来省这一步：节流是尽力而为，
 *      而且节流期间 `nextScanAt` 会停在一个已经过去的时刻，界面上的倒计时是错的。
 *
 * 导出成纯函数是为了让「后台不排」这条规则能被自测钉住 ——
 * 它写错了不会报任何错，只会让应用在后台悄悄继续扫盘。
 */
export function shouldArmAutoScan(autoRefresh: boolean, inBackground: boolean): boolean {
  return autoRefresh && !inBackground;
}

function load(): JvmPrefs {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<JvmPrefs>;
    return {
      autoRefresh:
        typeof parsed.autoRefresh === 'boolean' ? parsed.autoRefresh : DEFAULTS.autoRefresh,
      refreshIntervalSec: validIntervalSec(parsed.refreshIntervalSec),
      toolHome: typeof parsed.toolHome === 'string' && parsed.toolHome ? parsed.toolHome : null,
      pushToBadge: typeof parsed.pushToBadge === 'boolean' ? parsed.pushToBadge : DEFAULTS.pushToBadge,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function persist(p: JvmPrefs): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(p));
  } catch {
    /* 隐私模式等场景下忽略 */
  }
}

interface PrefsState extends JvmPrefs {
  setAutoRefresh: (v: boolean) => void;
  setRefreshInterval: (sec: number) => void;
  setToolHome: (home: string | null) => void;
  setPushToBadge: (v: boolean) => void;
}

export const useJvmPrefs = create<PrefsState>((set, get) => ({
  ...load(),
  setAutoRefresh: (v) => {
    persist({ ...get(), autoRefresh: v });
    set({ autoRefresh: v });
  },
  setRefreshInterval: (sec) => {
    const refreshIntervalSec = validIntervalSec(sec);
    persist({ ...get(), refreshIntervalSec });
    set({ refreshIntervalSec });
  },
  setToolHome: (home) => {
    const toolHome = home && home.trim() ? home.trim() : null;
    persist({ ...get(), toolHome });
    set({ toolHome });
  },
  setPushToBadge: (v) => {
    persist({ ...get(), pushToBadge: v });
    set({ pushToBadge: v });
  },
}));

export type { PrefsState };
