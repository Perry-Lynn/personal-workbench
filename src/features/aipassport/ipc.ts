/*
 * AI-Passport 蓝牙模块 · Tauri IPC 调用封装
 * 集中本模块所有 invoke() 调用，统一走 @/core/ipc 的 call()（自动拆 ApiResponse）。
 * 命令命名与 src-tauri/src/modules/aipassport/commands.rs 一一对应。
 */
import { call } from '@/core/ipc';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { ConnectionState, DiscoveredDevice, PushResult } from './types';

/** 扫描周围 AI-Passport 设备（默认 8 秒） */
export const scan = (timeoutMs?: number): Promise<DiscoveredDevice[]> =>
  call<DiscoveredDevice[]>('aipassport_scan', { timeoutMs });

/** 连接指定设备 */
export const connect = (deviceId: string): Promise<DiscoveredDevice> =>
  call<DiscoveredDevice>('aipassport_connect', { deviceId });

/** 断开当前连接 */
export const disconnect = (): Promise<void> => call<void>('aipassport_disconnect');

/** 推送一条通知 / 提醒 / 日程 */
export const push = (
  category: string,
  source: string,
  body: string,
): Promise<PushResult> => call<PushResult>('aipassport_push', { category, source, body });

/** 清空设备上的通知列表 */
export const clearDevice = (): Promise<PushResult> => call<PushResult>('aipassport_clear');

/** 读取当前连接状态 */
export const getState = (): Promise<ConnectionState> =>
  call<ConnectionState>('aipassport_state');

/** 订阅扫描到的设备列表 */
export const onDevices = (
  cb: (devices: DiscoveredDevice[]) => void,
): Promise<UnlistenFn> =>
  listen<DiscoveredDevice[]>('aipassport:devices', (e) => cb(e.payload));

/** 订阅连接状态变化 */
export const onState = (cb: (s: ConnectionState) => void): Promise<UnlistenFn> =>
  listen<ConnectionState>('aipassport:state', (e) => cb(e.payload));
