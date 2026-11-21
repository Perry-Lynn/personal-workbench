/*
 * 智能体余额 → AI-Passport 集成桥
 * ------------------------------------------------------------------
 * 余额模块需要「连上蓝牙时把摘要推到徽章」。按工作台约定，模块之间不互相
 * 引用内部实现（store / 组件），只通过**公开的 IPC 契约**（命令名 / 事件名）交互。
 * 这里把这层耦合收拢在一个文件里，将来若改为 core 级通知抽象，只需替换本文件。
 *
 * 依赖的 AI-Passport 公开契约（见 modules/aipassport/commands.rs）：
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

/** 向 AI-Passport 徽章推送一条消息（category 用 MSG） */
export function pushToBadge(source: string, body: string): Promise<void> {
  return pushRaw('MSG', source, body);
}

/**
 * 推送一条「提醒」（category=REMIND）。
 *
 * 为什么和普通消息分开：额度跌破阈值是「需要你注意」的事，固件对 REMIND
 * 有独立样式；混进 MSG 里会跟余额摘要长得一模一样，用户分不出哪条是警告。
 */
export function pushReminder(source: string, body: string): Promise<void> {
  return pushRaw('REMIND', source, body);
}

/**
 * 推送若干条**原始行**到徽章（固件按行首标签自行分流，如 BAL / BALT 进余额图表页）。
 *
 * 为什么不能复用 pushToBadge：那条路走的是固件的**通知存储**，正文上限 95 字节，
 * 而余额图表行天生更长（平台名 + 主指标 + 两个环形指标，中文一个字 3 字节）。
 * 行的语义由 features/balances/device.ts 负责，这里只管传输。
 */
export async function pushLines(lines: string[]): Promise<void> {
  if (lines.length === 0) return;
  const resp = (await invoke('aipassport_push_lines', { lines })) as ApiResponse<unknown>;
  if (!resp || !resp.success) {
    throw new Error(resp?.error || '推送图表数据到 AI-Passport 失败');
  }
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
