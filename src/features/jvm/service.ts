/*
 * JVM 进程看板模块 · 常驻服务
 * ------------------------------------------------------------------
 * 为什么要有这个文件（与 balances/service.ts 同一套理由）：
 *   侧栏角标上的「现在跑着几个 JVM」、以及「堆快满了推徽章」都是**副作用**，
 *   不该依赖用户是否点开过这个模块。模块入口 index.tsx 在 import 时把它启动，
 *   而 index.tsx 被 core/modules.ts 静态引用 —— 于是应用一启动服务就在跑。
 *   （组件级 keepAlive 只解决「切走不卸载」，解决不了「从没打开过」。）
 *
 * 三条刻意的设计：
 *   1. **诊断痕迹写 localStorage**。扫描是秒级且发生在后台，
 *      「定时器到底有没有跑」看界面既不方便也不可信，必须留一份可查的实况。
 *      尝试 / 成功 / 失败原因分开记 —— 只看成功次数的话，
 *      「定时器没跑」和「跑了但每次都失败」读出来一模一样。
 *   2. **告警只在「徽章已连接 + 用户开了推送」时才评估**。评估会推进「已提醒」状态，
 *      离线时评估等于把提醒记成已发，用户永远收不到（balances 踩过这个坑）。
 *   3. **同一进程同一档位只提醒一次**，档位升级（warn → danger）才再发。
 *      进程消失了就把记录清掉，下次再出现可以重新提醒。
 * @Author: fu
 */
import { create } from 'zustand';
import * as bridge from './bridge';
import * as ipc from './ipc';
import { alertBody, badgeText, pickAlertTarget, severityOf, severityTone } from './format';
import { shouldArmAutoScan, useJvmPrefs } from './prefs';
import { useJvmStore } from './store';
import type { JavaProcess, Severity } from './types';
import { onBackgroundChanged } from '@/core/lifecycle';
import type { ModuleBadge } from '@/core/types';

/* =============================================
   ====== 运行时状态（供面板显示） ======
   ============================================= */
interface RuntimeState {
  /** 徽章是否已连接（服务级，面板只读） */
  bleConnected: boolean;
  /** 最近一次成功扫描时间（Unix 秒）；0 = 本次会话还没扫过 */
  lastScanAt: number;
  /** 下一次自动扫描的时间（Unix 秒）；0 = 自动扫描已关闭 */
  nextScanAt: number;
}

export const useJvmRuntime = create<RuntimeState>(() => ({
  bleConnected: false,
  lastScanAt: 0,
  nextScanAt: 0,
}));

/* =============================================
   ====== 扫描 ======
   ============================================= */

let scanning = false;

/**
 * 扫一次本机 Java 进程，结果写进模块状态。
 * 面板的「刷新」与后台定时扫描都走这一个入口。
 */
export async function scanJvm(): Promise<JavaProcess[]> {
  const toolHome = useJvmPrefs.getState().toolHome;
  const snap = await ipc.scan(toolHome);
  useJvmStore.getState().setSnapshot(snap);
  useJvmRuntime.setState({ lastScanAt: Math.floor(Date.now() / 1000) });
  return snap.processes;
}

/**
 * 后台扫描：互斥（上一次没回来就不叠加请求）。
 * 刷新成功后状态变化会自动触发角标重算与告警评估（见文末的订阅）。
 */
function scanInBackground(): void {
  if (scanning) return;
  scanning = true;
  const t0 = Date.now();
  scanJvm()
    .then(() => markScan(undefined, Date.now() - t0))
    .catch((e) => markScan(e, Date.now() - t0))
    .finally(() => {
      scanning = false;
    });
}

/* =============================================
   ====== 定时自动扫描 ======
   ============================================= */

let scanTimer: number | null = null;
/** 上次生效的「开关|间隔」，用来判断是否需要重建定时器 */
let autoScanKey = '';
/**
 * 窗口是否在后台（「关窗转后台」状态）。
 *
 * 由 core 的 `workbench:background-changed` 事件维护（订阅挂在 `startJvmService`）。
 * 判据**不能**自己用 `document.hidden` 推：窗口是被 `hide()` 藏起来的，
 * 而且 macOS 下窗口隐藏与页面可见性并不保证同步 —— 后端知道确切时刻，问它。
 */
let inBackground = false;

function syncAutoScan(): void {
  if (scanTimer !== null) {
    window.clearInterval(scanTimer);
    scanTimer = null;
  }

  const { autoRefresh, refreshIntervalSec } = useJvmPrefs.getState();
  if (!shouldArmAutoScan(autoRefresh, inBackground)) {
    /*
     * 两种原因都落到「不排定时器」，但倒计时都必须清零：
     *   - 关掉开关：留一个「下次扫描」会显示成一个永远不会到来的时刻；
     *   - 转后台：会显示成一个**已经过去**的时刻（隐藏页面的定时器被系统节流，
     *     不会按点触发），用户回到窗口时看到的是一句明显不对的提示。
     */
    useJvmRuntime.setState({ nextScanAt: 0 });
    return;
  }

  const periodMs = refreshIntervalSec * 1000;
  /* 每次重新排期都要把下次时间推给界面，倒计时才会往前走 */
  const arm = () =>
    useJvmRuntime.setState({ nextScanAt: Math.floor((Date.now() + periodMs) / 1000) });

  scanTimer = window.setInterval(() => {
    scanInBackground();
    arm();
  }, periodMs);
  arm();
}

/**
 * 只在「开关或间隔」真的变了时才重建定时器。
 * 否则用户每改一次别的偏好，倒计时都会被重置 —— 间隔越长越明显。
 */
function syncAutoScanIfNeeded(): void {
  const { autoRefresh, refreshIntervalSec } = useJvmPrefs.getState();
  const key = `${autoRefresh}|${refreshIntervalSec}`;
  if (key === autoScanKey) return;
  autoScanKey = key;
  syncAutoScan();
}

/* =============================================
   ====== 侧栏角标 ======
   ============================================= */

/**
 * 角标：进程数，色调按最严重的那个进程。
 * 没有进程时返回 null（没有可比数据，不出角标）。
 */
export function jvmBadge(): ModuleBadge | null {
  const list = useJvmStore.getState().processes;
  const text = badgeText(list);
  if (text === null) return null;
  const worst = worstOf(list);
  return { text, tone: worst ? severityTone(worst) : 'info' };
}

/** 角标数据源订阅：进程列表变化就要重算 */
export function subscribeJvmBadge(onChange: () => void): () => void {
  return useJvmStore.subscribe(onChange);
}

function worstOf(list: JavaProcess[]): Severity | null {
  /* 放在这里是为了不把 format 的 worstSeverity 语义（空列表 → null）重复实现一遍 */
  if (list.length === 0) return null;
  let worst: Severity = 'ok';
  for (const p of list) {
    const s = severityOf(p);
    if (s === 'danger') return 'danger';
    if (s === 'warn') worst = 'warn';
  }
  return worst;
}

/* =============================================
   ====== 告警（推徽章） ======
   ============================================= */

/** 已经提醒过的进程：pid → 当时那档严重程度 */
const alerted = new Map<number, Severity>();

/**
 * 评估要不要推一条告警。
 *
 * 只推**最严重的那一个**：徽章屏幕窄，一次推三条用户只会全划掉。
 * 同进程同档位不重推；进程消失即清除记录（下次再起可以重新提醒）。
 */
function maybeAlert(): void {
  const prefs = useJvmPrefs.getState();
  if (!useJvmRuntime.getState().bleConnected) return;
  if (!prefs.pushToBadge) return;

  const list = useJvmStore.getState().processes;

  /* 清掉已经不存在的进程，否则 pid 会被复用、误判成「提醒过了」 */
  const alive = new Set(list.map((p) => p.pid));
  for (const pid of Array.from(alerted.keys())) {
    if (!alive.has(pid)) alerted.delete(pid);
  }

  const target = pickAlertTarget(list);
  if (!target) return;

  const sev = severityOf(target);
  if (alerted.get(target.pid) === sev) return;

  alerted.set(target.pid, sev);
  bridge
    .pushReminder('JVM', alertBody(target))
    .catch(() => {
      /* 发失败就撤销记账，下一轮扫描会重试 */
      alerted.delete(target.pid);
    })
    .then(() => {
      markAlert();
    });
}

/* =============================================
   ====== 连接状态 ======
   ============================================= */

function setConnected(v: boolean): void {
  const prev = useJvmRuntime.getState().bleConnected;
  useJvmRuntime.setState({ bleConnected: v });
  if (v === prev) return;
  if (!v) return;
  /* 徽章刚连上：用当前已有数据立刻评估一次 */
  maybeAlert();
}

/* =============================================
   ====== 诊断痕迹 ======
   ============================================= */

const DIAG_KEY = 'workbench:jvm-service';

interface ServiceDiag {
  /** 常驻服务启动时间（Unix 秒） */
  bootAt: number;
  /** 是否成功订阅到蓝牙状态事件 */
  bleSubscribed: boolean;
  /** 后台扫描**尝试**累计次数（含失败） */
  scanTried: number;
  /** 后台扫描**成功**累计次数 */
  scanOk: number;
  /** 最近一次后台扫描的时间（Unix 秒） */
  lastScanAt: number;
  /** 最近一次扫描耗时（毫秒）—— 用于判断该不该降频 */
  lastScanMs: number;
  /** 最近一次失败原因；成功时清空 */
  lastError: string;
  /** 本次会话已推送的告警条数 */
  alertsPushed: number;
  /**
   * 本次会话收到的「后台状态变化」事件数。
   * 为 0 说明后端没发、或订阅没挂上 —— 那「后台停扫」就没生效，
   * 而这件事在界面上**看不出来**（扫描本来就在后台悄悄跑）。
   */
  bgEvents: number;
  /** 最近一次后台状态；true = 当前在后台，自动扫描处于停止状态 */
  lastBg: boolean;
}

function readDiag(): Partial<ServiceDiag> {
  try {
    const raw = localStorage.getItem(DIAG_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Partial<ServiceDiag>)
      : {};
  } catch {
    return {};
  }
}

function writeDiag(next: Partial<ServiceDiag>): void {
  try {
    localStorage.setItem(DIAG_KEY, JSON.stringify({ ...readDiag(), ...next }));
  } catch {
    /* 隐私模式等场景下忽略 */
  }
}

/** 计数按会话重置：这个键要回答的是「**本次会话**的定时器有没有跑」 */
function markBoot(bleSubscribed: boolean): void {
  writeDiag({
    bootAt: Math.floor(Date.now() / 1000),
    bleSubscribed,
    scanTried: 0,
    scanOk: 0,
    lastScanAt: 0,
    lastScanMs: 0,
    lastError: '',
    alertsPushed: 0,
    bgEvents: 0,
    lastBg: false,
  });
}

/** 记一次后台状态变化。`bgEvents` 是「订阅真的通了吗」的唯一证据。 */
function markBackground(inBackgroundNow: boolean): void {
  writeDiag({
    bgEvents: Number(readDiag().bgEvents ?? 0) + 1,
    lastBg: inBackgroundNow,
  });
}

function markScan(error?: unknown, ms?: number): void {
  const prev = readDiag();
  writeDiag({
    scanTried: Number(prev.scanTried ?? 0) + 1,
    lastScanAt: Math.floor(Date.now() / 1000),
    lastScanMs: ms ?? 0,
    ...(error === undefined
      ? { scanOk: Number(prev.scanOk ?? 0) + 1, lastError: '' }
      : { lastError: (error as Error)?.message || String(error) }),
  });
}

function markAlert(): void {
  writeDiag({ alertsPushed: Number(readDiag().alertsPushed ?? 0) + 1 });
}

/* =============================================
   ====== 启动 ======
   ============================================= */

let started = false;

/** 启动常驻服务。重复调用无副作用。由模块入口在 import 时调用。 */
export function startJvmService(): void {
  if (started) return;
  started = true;

  /* 订阅 AI-Passport 连接状态（模块级订阅，与界面无关） */
  bridge
    .onBleState((s) => setConnected(s.state === 'connected'))
    .then(() => markBoot(true))
    .catch(() => markBoot(false));
  /* 事件可能在本服务启动前就发过了，主动拉一次当前状态兜底 */
  bridge
    .getBleState()
    .then((s) => setConnected(s.state === 'connected'))
    .catch(() => {});

  /* 进程列表变化 → 重新评估告警（角标由外壳订阅驱动，不需要这里管） */
  useJvmStore.subscribe(() => maybeAlert());

  /* 偏好变化 → 视情况重建定时器（换 JDK 也顺手重扫一次） */
  useJvmPrefs.subscribe(() => syncAutoScanIfNeeded());

  /*
   * 窗口转入后台 → 停掉自动扫描；回到前台 → 重新排期**并立刻补扫一次**。
   *
   * 补扫是必要的：后台期间可能已经越过好几个周期，而角标（外壳订阅着进程列表）
   * 会一直停在「进后台之前」那一份数据上；只重新排期的话，用户回到窗口还得再等
   * 一整个周期才看到当前状态。
   */
  onBackgroundChanged((v) => {
    if (v === inBackground) return;
    inBackground = v;
    markBackground(v);
    syncAutoScan();
    if (!v) scanInBackground();
  }).catch(() => {
    /* 订阅不上不影响主流程：退化成「后台也照常扫」，与本改造之前的行为一致 */
  });

  syncAutoScanIfNeeded();
  /* 启动即扫一次：角标要在用户还没点开模块时就出得来 */
  scanInBackground();
}
