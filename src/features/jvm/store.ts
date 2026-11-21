/*
 * JVM 进程看板模块 · 前端状态
 * 只存「最近一次扫描的结果」，不做任何加工 —— 加工在 format.ts。
 */
import { create } from 'zustand';
import type { JavaProcess, JdkInfo, JvmSnapshot } from './types';

interface JvmStore {
  processes: JavaProcess[];
  jdks: JdkInfo[];
  /** 实际用来跑 jps 的 JDK；null = 一台能用的都没找到 */
  toolHome: string | null;
  /** 后端给的降级说明，界面原样展示 */
  warnings: string[];
  scannedAt: number;
  elapsedMs: number;
  loading: boolean;
  lastError: string | null;
  setSnapshot: (s: JvmSnapshot) => void;
  setLoading: (v: boolean) => void;
  setLastError: (e: string | null) => void;
}

export const useJvmStore = create<JvmStore>((set) => ({
  processes: [],
  jdks: [],
  toolHome: null,
  warnings: [],
  scannedAt: 0,
  elapsedMs: 0,
  loading: false,
  lastError: null,
  setSnapshot: (s) =>
    set({
      processes: s.processes,
      jdks: s.jdks,
      toolHome: s.toolHome,
      warnings: s.warnings,
      scannedAt: s.scannedAt,
      elapsedMs: s.elapsedMs,
    }),
  setLoading: (loading) => set({ loading }),
  setLastError: (lastError) => set({ lastError }),
}));
