/*
 * Spring Boot 服务台 · 类型
 * 字段与 src-tauri/src/modules/spring/models.rs 一一对应（serde camelCase）。
 */

export interface SpringApp {
  pid: number;
  /** 展示名：jar 文件名（去版本号）或 main class 简名 */
  name: string;
  mainClass: string | null;
  jar: string | null;
  ports: number[];
  /** 从命令行推断的 profile */
  profiles: string[];
  command: string;
  cpuPercent: number;
  memMb: number;
  uptimeSec: number | null;
  /** 强特征判定依据（空 = 命令行上看不出是 Spring Boot） */
  evidence: string[];
  /** 弱提示，单独不足以判定 */
  hint: string | null;
  /** actuator 探活成功 —— 最可靠的确认 */
  confirmed: boolean;
  actuator: ActuatorInfo | null;
  actuatorError: string | null;
}

export interface ActuatorInfo {
  baseUrl: string;
  appName: string | null;
  appVersion: string | null;
  /** UP / DOWN / OUT_OF_SERVICE / UNKNOWN */
  status: string | null;
  components: HealthComponent[];
}

export interface HealthComponent {
  name: string;
  status: string;
  detail: string | null;
}

export interface SpringSnapshot {
  apps: SpringApp[];
  /** 扫到的 Java 进程总数 */
  javaProcesses: number;
  elapsedMs: number;
  warnings: string[];
}
