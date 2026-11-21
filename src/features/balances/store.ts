/*
 * 智能体余额模块 · 前端状态
 * 平台列表、各平台余额、连接状态（用于「连蓝牙时推摘要」）。
 */
import { create } from 'zustand';
import type { AgentBalance, ProviderMeta } from './types';

interface BalancesStore {
  providers: ProviderMeta[];
  balances: AgentBalance[];
  loading: boolean;
  lastError: string | null;
  /** 是否已尝试过自动检测 Codex CLI */
  codexChecked: boolean;
  codexAvailable: boolean;
  setProviders: (p: ProviderMeta[]) => void;
  setBalances: (b: AgentBalance[]) => void;
  /** 只更新某一个平台的余额（其余保持不变）—— 单平台定时刷新用 */
  upsertBalance: (b: AgentBalance) => void;
  setLoading: (v: boolean) => void;
  setLastError: (e: string | null) => void;
  setCodex: (available: boolean) => void;
}

export const useBalancesStore = create<BalancesStore>((set) => ({
  providers: [],
  balances: [],
  loading: false,
  lastError: null,
  codexChecked: false,
  codexAvailable: false,
  setProviders: (providers) => set({ providers }),
  setBalances: (balances) => set({ balances }),
  upsertBalance: (b) =>
    set((s) => {
      const idx = s.balances.findIndex((x) => x.provider === b.provider);
      const balances =
        idx >= 0
          ? s.balances.map((x) => (x.provider === b.provider ? b : x))
          : [...s.balances, b];
      return { balances };
    }),
  setLoading: (loading) => set({ loading }),
  setLastError: (lastError) => set({ lastError }),
  setCodex: (codexAvailable) => set({ codexAvailable, codexChecked: true }),
}));
