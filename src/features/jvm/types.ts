/*
 * JVM 进程看板模块 · 类型
 * 字段与 src-tauri/src/modules/jvm/models.rs 一一对应（serde camelCase）。
 */

/** JDK 是从哪儿扫出来的 */
export type JdkSource = 'sdkman' | 'system' | 'brew' | 'env';

export interface JdkInfo {
  id: string;
  /** 版本串，读不出来时为空串 */
  version: string;
  vendor: string;
  home: string;
  source: JdkSource;
  isDefault: boolean;
  /** 是否带诊断工具（bin/jps） */
  hasTools: boolean;
  /** 这台 JDK 实际存在哪些工具：java / javac / jps / jstack / jmap / jstat / jcmd */
  tools: string[];
}

export interface JavaProcess {
  pid: number;
  /** jps -l 的第二列：全限定主类名，或 -jar 时的 jar 路径 */
  mainClass: string;
  jarPath: string | null;
  command: string;
  ports: number[];
  /** 生命周期平均 CPU 占用，多核机器上可超过 100 */
  cpuPercent: number;
  memMb: number;
  uptimeSec: number | null;
  heapUsedMb: number | null;
  heapMaxMb: number | null;
  jdkVersion: string | null;
}

export interface JvmSnapshot {
  processes: JavaProcess[];
  jdks: JdkInfo[];
  toolHome: string | null;
  warnings: string[];
  scannedAt: number;
  elapsedMs: number;
  platform: string;
}

export interface ThreadDumpResult {
  pid: number;
  text: string;
  takenAt: number;
}

export interface HeapDumpResult {
  pid: number;
  path: string;
  sizeMb: number;
}

export interface PortOwner {
  port: number;
  pid: number | null;
  command: string | null;
  found: boolean;
}

/**
 * 进程归类。
 * 只用于**显示分组与配色**，不做任何行为判断 —— 归类错了最多是图标不对，
 * 不会导致误杀进程或误报。
 */
export type ProcessKind =
  | 'spring-boot'
  | 'maven'
  | 'gradle'
  | 'idea'
  | 'test'
  | 'other';

export type Severity = 'ok' | 'warn' | 'danger';
