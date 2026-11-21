/*
 * Spring Boot 服务台 · 前端状态
 *
 * 快照放 store 而不是组件 state：本模块没有 keepAlive，切走就卸载，
 * 用 local state 的话「点进去看一眼、切到别处、再切回来」列表就空了，
 * 而重扫一次要列全部进程 + 探活，得等一两秒。
 * @Author: fu
 */
import { create } from 'zustand';
import type { SpringSnapshot } from './types';

interface SpringStore {
  snapshot: SpringSnapshot | null;
  loading: boolean;
  /** 正在重探的 pid（只影响那一行的按钮转圈） */
  retryingPid: number | null;
  error: string | null;
  setSnapshot: (v: SpringSnapshot | null) => void;
  setLoading: (v: boolean) => void;
  setRetryingPid: (v: number | null) => void;
  setError: (v: string | null) => void;
  /** 单次重探成功后，把结果并回快照里的那一条 */
  applyProbe: (pid: number, actuator: SpringSnapshot['apps'][number]['actuator'], error: string | null) => void;
}

export const useSpringStore = create<SpringStore>((set, get) => ({
  snapshot: null,
  loading: false,
  retryingPid: null,
  error: null,
  setSnapshot: (snapshot) => set({ snapshot }),
  setLoading: (loading) => set({ loading }),
  setRetryingPid: (retryingPid) => set({ retryingPid }),
  setError: (error) => set({ error }),
  applyProbe: (pid, actuator, error) => {
    const s = get().snapshot;
    if (!s) return;
    const apps = s.apps.map((a) =>
      a.pid === pid
        ? {
            ...a,
            actuator: actuator ?? a.actuator,
            actuatorError: error,
            confirmed: actuator ? true : a.confirmed,
          }
        : a,
    );
    set({ snapshot: { ...s, apps } });
  },
}));
