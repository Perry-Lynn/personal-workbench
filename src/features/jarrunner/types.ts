/*
 * JAR 运行器模块 · 类型
 * ------------------------------------------------------------------
 * 字段名与后端 models.rs 的 serde（rename_all = camelCase）逐字对应，
 * 改一处必须改另一处 —— 不一致不会报错，只会静默变成 undefined。
 * @Author: fu
 */

/** 运行状态的取值串。与后端 RunStatus 的 serde 保持一致 */
export type RunStatus = 'running' | 'exited' | 'failed' | 'stopped';

/** 一行日志来自哪 */
export type LogStream = 'stdout' | 'stderr' | 'system';

/** 一台已安装的 JDK（来自 core/jdk.rs） */
export interface JdkInfo {
  id: string;
  version: string;
  vendor: string;
  home: string;
  source: 'sdkman' | 'system' | 'brew' | 'env';
  isDefault: boolean;
  hasTools: boolean;
  tools: string[];
}

/** 一条环境变量 */
export interface EnvPair {
  key: string;
  value: string;
}

/** 一份运行配置 */
export interface JarConfig {
  /** 空串 = 新建 */
  id: string;
  name: string;
  jarPath: string;
  /** 空串 = 自动（用默认那台 JDK） */
  jdkHome: string;
  jvmArgs: string;
  programArgs: string;
  /**
   * Spring 的配置文件（application.yml / application.properties）绝对路径；
   * 空串 = 不传。非空时会拼成 `--spring.config.location=file:<路径>`。
   * 自定义命令模式下不生效（那时整条命令由用户自己写）。
   */
  configFile: string;
  /** 空串 = jar 所在目录 */
  workDir: string;
  env: EnvPair[];
  /** 非空时整条按它跑，支持 {java} / {jar} 占位符 */
  customCommand: string;
  updatedAt: number;
}

/** 一次运行的状态 */
export interface RunInfo {
  id: string;
  configId: string;
  name: string;
  jarPath: string;
  javaBin: string;
  jdkLabel: string;
  /** 拼好的完整命令行（可复制） */
  command: string;
  workDir: string;
  status: RunStatus;
  pid: number | null;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  error: string | null;
}

/** 一行日志 */
export interface LogLine {
  seq: number;
  ts: number;
  stream: LogStream;
  text: string;
}

/** 事件 jarrunner:log-lines 的负载 */
export interface LogBatchEvent {
  runId: string;
  lines: LogLine[];
}

/** 事件 jarrunner:run-status 的负载 */
export interface RunStatusEvent {
  runId: string;
  status: RunStatus;
  exitCode: number | null;
  endedAt: number | null;
  error: string | null;
}

/** 一份空白配置（新建时的初值；jar 路径由选择的那一刻填） */
export function emptyConfig(): JarConfig {
  return {
    id: '',
    name: '',
    jarPath: '',
    jdkHome: '',
    jvmArgs: '',
    programArgs: '',
    configFile: '',
    workDir: '',
    env: [],
    customCommand: '',
    updatedAt: 0,
  };
}
