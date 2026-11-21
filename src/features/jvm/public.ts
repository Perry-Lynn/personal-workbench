/*
 * JVM 进程看板模块 · 对外公开契约（状态）
 * ------------------------------------------------------------------
 * 工作台约定：模块之间不互相 import 内部实现。别的模块（目前是首页）
 * 需要读「现在跑着几个 JVM、占了哪些端口」时，**只 import 本文件**。
 *
 * 这里只暴露**只读**派生值，全部来自 store 的内存快照（由常驻服务
 * service.ts 定时扫描写入，见那里的说明）：不触发 IPC、不碰主密钥。
 *
 * ⚠️ 不 import jvm.css：本文件不导出组件，带样式只会把模块样式拖进首页 chunk。
 * ⚠️ 派生值放 useMemo：zustand v5 用 Object.is 比较，选择器里现造对象
 *    会导致无限重渲染。
 * @Author: fu
 */
import { useMemo } from 'react';
import { useJvmStore } from './store';
import { processSummary, sortPorts, worstSeverity } from './format';
import type { Severity } from './types';

export interface JvmStatusSummary {
  /** 运行中的 Java 进程数 */
  count: number;
  /** 这些进程监听的端口（去重升序） */
  ports: number[];
  /** 最严重的那个进程的档位；没有进程时为 null（不是 'ok' —— 两者含义不同） */
  worst: Severity | null;
  /** 最近一次扫描时间（Unix 秒）；0 = 本次会话还没扫过 */
  scannedAt: number;
  /** 一句话摘要，如「3 个 JVM · 8080, 9000」 */
  summary: string;
}

/**
 * 首页用的 JVM 状态。
 * 一个进程都没有时 count 为 0、worst 为 null —— 首页据此显示「空闲」。
 */
export function useJvmStatus(): JvmStatusSummary {
  const processes = useJvmStore((s) => s.processes);
  const scannedAt = useJvmStore((s) => s.scannedAt);

  return useMemo(
    () => ({
      count: processes.length,
      ports: sortPorts(processes.flatMap((p) => p.ports)),
      worst: worstSeverity(processes),
      scannedAt,
      summary: processSummary(processes),
    }),
    [processes, scannedAt],
  );
}
