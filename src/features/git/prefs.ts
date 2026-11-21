/*
 * Git 管理模块 · 用户偏好
 * ------------------------------------------------------------------
 * 目前只有自动刷新两项，全部持久化到 localStorage（纯前端、不涉密钥）。
 *
 * 为什么是秒级轮询而不是文件监听：
 *   git status 是本地命令、一次通常几十毫秒，5 秒一轮的开销可以忽略；
 *   而文件系统监听要引 Rust 侧依赖、过滤 .git 目录的事件噪音、再做防抖，
 *   为一个「列表自动更新」付这些复杂度不划算。真嫌费可以关掉自动刷新。
 *
 * 间隔下限 3 秒的取舍同 JVM 模块：再快就是在给自己制造 fork 子进程的负载，
 * 而「刚改完文件、列表要跟着变」这件事本来就有一两百毫秒的延迟。
 * @Author: fu
 */
import { create } from 'zustand';

export interface GitPrefs {
  /** 是否定时轮询工作区状态 */
  autoRefresh: boolean;
  /** 轮询间隔（秒） */
  refreshIntervalSec: number;
}

export const MIN_REFRESH_SEC = 3;
export const MAX_REFRESH_SEC = 3600;
export const DEFAULT_REFRESH_SEC = 5;

const LS_KEY = 'workbench:git-prefs';

const DEFAULTS: GitPrefs = {
  autoRefresh: true,
  refreshIntervalSec: DEFAULT_REFRESH_SEC,
};

/**
 * 间隔收敛。localStorage 是用户可改的，0 / 负数 / 字符串都属于**损坏值**，
 * 一律回默认 —— 夹成下限 3 秒会变成「每 3 秒 fork 一堆 git 进程」，比默认值危险。
 * 导出是为了让 scripts/logic-test.ts 能直接断言边界。
 */
export function validIntervalSec(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_REFRESH_SEC;
  const n = Math.round(v);
  if (n < MIN_REFRESH_SEC) return DEFAULT_REFRESH_SEC;
  return n > MAX_REFRESH_SEC ? MAX_REFRESH_SEC : n;
}

/**
 * 这一轮该不该跑轮询。**四个条件各自独立都能否决**：
 *   1. 用户关了自动刷新；
 *   2. Git 模块不在前台（切走了）—— 没人看的时候扫盘纯属白扫；
 *   3. 还没打开仓库，没什么可刷；
 *   4. 有写操作在跑（push/pull 最长能到 120 秒）或仓库正在加载 ——
 *      这时插一脚只会让 git 进程打架、报错盖掉真正的操作结果；
 *   5. 窗口被藏起来了（关窗转后台），webview 不可见。
 *
 * 抽成纯函数是为了让这条「什么时候不该刷」的规则能被自测钉住：
 * 它写错了不会报任何错，只会让应用在后台悄悄继续跑 git。
 */
export function shouldPoll(o: {
  autoRefresh: boolean;
  active: boolean;
  hasRepo: boolean;
  busy: boolean;
  hidden: boolean;
}): boolean {
  return o.autoRefresh && o.active && o.hasRepo && !o.busy && !o.hidden;
}

function load(): GitPrefs {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<GitPrefs>;
    return {
      autoRefresh: typeof parsed.autoRefresh === 'boolean' ? parsed.autoRefresh : DEFAULTS.autoRefresh,
      refreshIntervalSec: validIntervalSec(parsed.refreshIntervalSec),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function persist(p: GitPrefs): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(p));
  } catch {
    /* 隐私模式等场景下忽略 */
  }
}

interface PrefsState extends GitPrefs {
  setAutoRefresh: (v: boolean) => void;
  setRefreshInterval: (sec: number) => void;
}

export const useGitPrefs = create<PrefsState>((set, get) => ({
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
}));
