/*
 * JVM 进程看板 → AI-Passport 集成桥
 * ------------------------------------------------------------------
 * 与 balances/bridge.ts 同一套做法：模块之间不互相引用内部实现，
 * 只通过 **AI-Passport 的公开 IPC 契约**（命令名 / 事件名）交互。
 * 这里把耦合收拢在一个文件里，将来若改为 core 级通知抽象，只替换本文件。
 *
 * 依赖的公开契约（见 modules/aipassport/commands.rs）：
 *   - 命令 aipassport_push(category, source, body)
 *   - 事件 aipassport:state  { state: 'idle'|'connected'|... }
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

interface ApiResponse<T> {
  success: boolean;
  data: T | null;
  error: string | null;
}

interface BleState {
  state: string;
  device_id?: string | null;
  device_name?: string | null;
  error?: string | null;
}

/** 固件支持的类别：日程 / 提醒 / 消息 */
type PushCategory = 'SCHED' | 'REMIND' | 'MSG';

async function pushRaw(category: PushCategory, source: string, body: string): Promise<void> {
  const resp = (await invoke('aipassport_push', {
    category,
    source,
    body,
  })) as ApiResponse<unknown>;
  if (!resp || !resp.success) {
    throw new Error(resp?.error || '推送到 AI-Passport 失败');
  }
}

/** 推一条普通消息 */
export function pushToBadge(source: string, body: string): Promise<void> {
  return pushRaw('MSG', source, body);
}

/**
 * 推一条**提醒**（category=REMIND）。
 * JVM 告警用它：进程堆快满了是需要立刻处理的事，
 * 混进普通消息里会和「余额摘要」长得一模一样，用户分不出轻重。
 */
export function pushReminder(source: string, body: string): Promise<void> {
  return pushRaw('REMIND', source, body);
}

/** 订阅 AI-Passport 连接状态 */
export function onBleState(cb: (s: BleState) => void): Promise<UnlistenFn> {
  return listen<BleState>('aipassport:state', (e) => cb(e.payload));
}

/** 拉取当前 AI-Passport 连接状态 */
export async function getBleState(): Promise<BleState> {
  const resp = (await invoke('aipassport_state')) as ApiResponse<BleState>;
  if (!resp || !resp.success || !resp.data) {
    throw new Error(resp?.error || '读取蓝牙状态失败');
  }
  return resp.data;
}
