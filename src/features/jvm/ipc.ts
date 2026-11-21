/*
 * JVM 进程看板模块 · IPC 封装
 * 命令前缀 jvm_，统一走 @/core/ipc 的 call()（自动拆 ApiResponse）。
 *
 * 不涉及主密钥：这里执行的全是本机的只读诊断命令（jps / ps / lsof / jstat），
 * 按工作台约定不碰钥匙串、也不弹授权框。
 */
import { call } from '@/core/ipc';
import type {
  HeapDumpResult,
  JvmSnapshot,
  PortOwner,
  ThreadDumpResult,
} from './types';

/**
 * 扫一次本机 Java 进程。
 * toolHome 为 null 时由后端自动挑一台带 jps 的 JDK。
 *
 * 返回的 JvmSnapshot 里**已经带着** JDK 列表（`jdks`）—— 界面的「换一台 JDK 采集」
 * 下拉直接用快照里的这份，不要再单开一个「只列 JDK」的命令（会重复扫一遍磁盘）。
 */
export const scan = (toolHome: string | null): Promise<JvmSnapshot> =>
  call<JvmSnapshot>('jvm_scan', { toolHome });

/**
 * 验证某台 JDK 是否真的能跑：执行 `java -version` 并回显输出。
 * 扫目录只能证明「有 bin/java」，证明不了它能执行（sdkman current 指向已卸载的
 * 版本、架构不匹配等）—— 让用户按一下就看到结果，比设成默认再失败好得多。
 */
export const jdkVersion = (home: string): Promise<string> =>
  call<string>('jvm_jdk_version', { home });

/** 抓线程栈（jstack，无 jstack 时退到 jcmd Thread.print） */
export const threadDump = (pid: number, toolHome: string | null): Promise<ThreadDumpResult> =>
  call<ThreadDumpResult>('jvm_thread_dump', { pid, toolHome });

/** 堆转储，产物落在应用数据目录下的 jvm-dumps/ */
export const heapDump = (pid: number, toolHome: string | null): Promise<HeapDumpResult> =>
  call<HeapDumpResult>('jvm_heap_dump', { pid, toolHome });

/** 结束进程。force=false 发 SIGTERM，true 发 SIGKILL */
export const kill = (pid: number, force: boolean): Promise<void> =>
  call<void>('jvm_kill', { pid, force });

/** 查某个端口被谁占着 */
export const portOwner = (port: number): Promise<PortOwner> =>
  call<PortOwner>('jvm_port_owner', { port });
