/*
 * Spring Boot 服务台 · 纯逻辑
 * ------------------------------------------------------------------
 * 不 import 任何运行时依赖（不碰 zustand / react / localStorage），
 * 以便被 scripts/logic-test.ts 直接 import 进 node 跑断言。
 * @Author: fu
 */
import type { SpringApp, SpringSnapshot } from './types';

/* =============================================
   ====== 健康状态 ======
   ============================================= */

/**
 * 状态排序权重，**越小越糟**。
 *
 * 写成表而不是一串 if：Spring 的 status 取值是开放集合（`UP` / `DOWN` /
 * `OUT_OF_SERVICE` / `UNKNOWN`，自定义 HealthIndicator 还能返回别的），
 * 认不出来的一律按「未知」处理，不要当正常。
 */
const HEALTH_RANK: Record<string, number> = {
  DOWN: 0,
  OUT_OF_SERVICE: 1,
  UNKNOWN: 2,
  UP: 3,
};

export function healthRank(status: string | null | undefined): number {
  if (!status) return 2;
  return HEALTH_RANK[status.toUpperCase()] ?? 2;
}

export type HealthTone = 'success' | 'warning' | 'error' | 'default';

export function healthTone(status: string | null | undefined): HealthTone {
  const r = healthRank(status);
  if (r >= 3) return 'success';
  if (r === 2) return 'default';
  if (r === 1) return 'warning';
  return 'error';
}

export function healthLabel(status: string | null | undefined): string {
  if (!status) return '未探测';
  const s = status.toUpperCase();
  if (s === 'UP') return '正常';
  if (s === 'DOWN') return '异常';
  if (s === 'OUT_OF_SERVICE') return '已停止服务';
  if (s === 'UNKNOWN') return '未知';
  /* 自定义状态原样显示，别硬翻译成已知的四种 */
  return status;
}

/** 取最糟的那个状态（一屏里要能一眼看到「有东西挂了」） */
export function worstHealth(list: (string | null | undefined)[]): string {
  let worst: string | null = null;
  let rank = Number.POSITIVE_INFINITY;
  for (const s of list) {
    const r = healthRank(s);
    if (r < rank) {
      rank = r;
      worst = s ? s.toUpperCase() : 'UNKNOWN';
    }
  }
  return worst ?? 'UNKNOWN';
}

/** 一个应用的健康状态：优先用 actuator 的，没探到就是 null */
export function appStatus(app: SpringApp): string | null {
  return app.actuator?.status ?? null;
}

export interface StatusCounts {
  up: number;
  bad: number;
  unknown: number;
}

export function statusCounts(apps: SpringApp[]): StatusCounts {
  const out: StatusCounts = { up: 0, bad: 0, unknown: 0 };
  for (const a of apps) {
    const r = healthRank(appStatus(a));
    if (r >= 3) out.up++;
    else if (r === 2) out.unknown++;
    else out.bad++;
  }
  return out;
}

/* =============================================
   ====== 端口 ======
   ============================================= */

/**
 * 已知的「不是业务端口」。
 *   35729  spring-boot-devtools 的 livereload
 *   5005+  JVM 远程调试（IDEA 默认 5005，多开时往后排）
 * 这些显示成主端口会误导 —— 用户点开 35729 只会看到一个 JSON。
 */
export const NON_APP_PORTS = [35729, 5005, 5006, 5007];

export function isNonAppPort(p: number): boolean {
  return NON_APP_PORTS.includes(p);
}

/** 从 actuator 的 baseUrl 里取出端口（探活成功的那个端口一定是对的） */
export function portOfBaseUrl(baseUrl: string | null | undefined): number | null {
  if (!baseUrl) return null;
  const m = /:(\d+)\s*$/.exec(baseUrl.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
}

/**
 * 挑一个「主端口」显示。
 *
 * 优先级：actuator 探活成功的那个 > 最小的业务端口 > 最小的端口。
 * 中间那一步排除 livereload / 调试端口 —— 一个服务同时监听 8080 与 35729 时，
 * 界面上显示 35729 就完全错了。
 */
export function primaryPort(ports: number[], confirmedBaseUrl?: string | null): number | null {
  if (ports.length === 0) return null;
  const confirmed = portOfBaseUrl(confirmedBaseUrl);
  if (confirmed !== null && ports.includes(confirmed)) return confirmed;
  const app = ports.filter((p) => !isNonAppPort(p));
  const pool = app.length > 0 ? app : ports;
  return [...pool].sort((a, b) => a - b)[0];
}

/* =============================================
   ====== 展示 ======
   ============================================= */

/** 运行时长。null 显示「—」而不是 0 秒 —— 前者诚实 */
export function formatUptime(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec) || sec < 0) return '—';
  if (sec < 60) return `${Math.floor(sec)} 秒`;
  const m = Math.floor(sec / 60);
  if (sec < 3600) return `${m} 分`;
  const h = Math.floor(sec / 3600);
  if (sec < 86400) return m % 60 > 0 ? `${h} 小时 ${m % 60} 分` : `${h} 小时`;
  const d = Math.floor(sec / 86400);
  return `${d} 天 ${h % 24} 小时`;
}

/** profile 文案。空 = 没指定，Spring 会走 default，所以显示「默认」而不是空白 */
export function profileText(profiles: string[]): string {
  return profiles.length > 0 ? profiles.join(', ') : '默认';
}

/** 判定依据 + 弱提示，合并成界面上要列的几行 */
export function evidenceLines(app: SpringApp): string[] {
  const out = [...app.evidence];
  if (app.hint) out.push(app.hint);
  return out;
}

/** 一个应用最简短的说明：靠什么认出来的 */
export function detectText(app: SpringApp): string {
  if (app.confirmed) {
    return app.evidence.length > 0 ? 'actuator 确认 · 命令行也有特征' : 'actuator 确认';
  }
  return '仅命令行特征';
}

export function summaryText(s: SpringSnapshot | null): string {
  if (!s) return '';
  if (s.apps.length === 0) {
    return `没发现 Spring Boot 服务（扫到 ${s.javaProcesses} 个 Java 进程）`;
  }
  const c = statusCounts(s.apps);
  const parts = [`${s.apps.length} 个服务`, `${c.up} 正常`];
  if (c.bad > 0) parts.push(`${c.bad} 异常`);
  if (c.unknown > 0) parts.push(`${c.unknown} 未探测`);
  return parts.join(' · ');
}

/** 毫秒 → "820 ms" / "1.2 秒" */
export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} 秒`;
}
