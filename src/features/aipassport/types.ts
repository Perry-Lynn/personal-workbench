/* AI-Passport 蓝牙模块 · 前后端共享类型 */

export interface DiscoveredDevice {
  id: string;
  name: string;
  rssi?: number;
}

export interface PushResult {
  bytes: number;
  text: string;
}

export type ConnState = 'idle' | 'scanning' | 'connecting' | 'connected' | 'error';

export interface ConnectionState {
  state: ConnState;
  device_id: string | null;
  device_name: string | null;
  error: string | null;
}

/* 推送类别：与固件 notif_ble 协议一致 */
export type PushCategory = 'SCHED' | 'REMIND' | 'MSG';

export const CATEGORY_OPTIONS: { value: PushCategory; label: string }[] = [
  { value: 'SCHED', label: '日程' },
  { value: 'REMIND', label: '提醒' },
  { value: 'MSG', label: '消息' },
];
