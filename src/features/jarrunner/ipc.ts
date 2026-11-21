/*
 * JAR 运行器模块 · IPC 封装
 * ------------------------------------------------------------------
 * 命令前缀 jarrunner_，统一走 @/core/ipc 的 call()（自动拆 ApiResponse）。
 * 不涉及主密钥：跑的是本机 java，配置里只有路径与参数。
 * @Author: fu
 */
import { call } from '@/core/ipc';
import type { JarConfig, JdkInfo, LogLine, RunInfo } from './types';

/** 本机装了哪些 JDK */
export const listJdks = (): Promise<JdkInfo[]> => call<JdkInfo[]>('jarrunner_list_jdks');

/** 保存过的运行配置 */
export const listConfigs = (): Promise<JarConfig[]> => call<JarConfig[]>('jarrunner_list_configs');

/** 生成命令预览（与实际启动用的是同一套拼装逻辑） */
export const preview = (config: JarConfig): Promise<string> =>
  call<string>('jarrunner_preview', { config });

/** 新建或更新一份配置（id 为空 = 新建） */
export const saveConfig = (config: JarConfig): Promise<JarConfig> =>
  call<JarConfig>('jarrunner_save_config', { config });

export const deleteConfig = (id: string): Promise<boolean> =>
  call<boolean>('jarrunner_delete_config', { id });

/** 启动一次运行。传的是表单里的配置，不要求先保存 */
export const start = (config: JarConfig): Promise<RunInfo> =>
  call<RunInfo>('jarrunner_start', { config });

export const stop = (runId: string): Promise<boolean> => call<boolean>('jarrunner_stop', { runId });

/** 停止并丢掉这条运行记录 */
export const remove = (runId: string): Promise<boolean> =>
  call<boolean>('jarrunner_remove', { runId });

/** 全部运行记录（含已结束的） */
export const listRuns = (): Promise<RunInfo[]> => call<RunInfo[]>('jarrunner_list_runs');

/** 后端缓存的日志（最多 2000 行） */
export const logs = (runId: string): Promise<LogLine[]> =>
  call<LogLine[]>('jarrunner_logs', { runId });

/** 清掉后端缓存的日志 */
export const clearLogs = (runId: string): Promise<boolean> =>
  call<boolean>('jarrunner_clear_logs', { runId });
