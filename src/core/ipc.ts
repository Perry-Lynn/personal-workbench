/*
 * 工作台级 IPC 调用工具
 * ------------------------------------------------------------------
 * 所有模块都通过这里和后端说话，统一处理 ApiResponse 的成败判定，
 * 避免每个模块各写一份 invoke 包装、错误消息格式各不一致。
 *
 * 约定：
 *   - 后端命令一律返回 ApiResponse<T>（见 src-tauri/src/core/api.rs）
 *   - 失败时抛出 Error(error)，调用方只需 try/catch 拿 message
 * @Author: fu
 */
import { invoke } from '@tauri-apps/api/core';

/** 后端统一响应结构 */
export interface ApiResponse<T> {
  success: boolean;
  data: T | null;
  error: string | null;
}

/** 调用一个 Tauri 命令：成功返回 data，失败抛出带后端消息的 Error */
export async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const resp = (await invoke(cmd, args)) as ApiResponse<T>;
  if (!resp || typeof resp.success === 'undefined') {
    throw new Error(`后端返回格式异常（${cmd}）`);
  }
  if (!resp.success) {
    throw new Error(resp.error || `调用 ${cmd} 失败`);
  }
  return resp.data as T;
}
