/*
 * AI-Passport 蓝牙模块 · 前端状态
 * ------------------------------------------------------------------
 * 设备列表、连接状态、最近一次推送结果。模块 keepAlive，跨切换保留连接。
 */
import { create } from 'zustand';
import type { ConnectionState, DiscoveredDevice } from './types';

interface AiPassportStore {
  devices: DiscoveredDevice[];
  conn: ConnectionState;
  /** 最近一次推送/清空的原始文本，用于结果区展示 */
  lastResult: string | null;
  setDevices: (devices: DiscoveredDevice[]) => void;
  setConn: (conn: ConnectionState) => void;
  setLastResult: (text: string | null) => void;
}

export const useAiPassportStore = create<AiPassportStore>((set) => ({
  devices: [],
  conn: { state: 'idle', device_id: null, device_name: null, error: null },
  lastResult: null,
  setDevices: (devices) => set({ devices }),
  setConn: (conn) => set({ conn }),
  setLastResult: (lastResult) => set({ lastResult }),
}));
