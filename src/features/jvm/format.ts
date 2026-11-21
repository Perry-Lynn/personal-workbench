/*
 * JVM 进程看板模块 · 纯逻辑
 * ------------------------------------------------------------------
 * 归类、格式化、严重程度、角标口径都在这里，**不 import 任何运行时依赖**
 * （不碰 zustand / react / localStorage），这样它能被 scripts/logic-test.ts
 * 直接 import 进 node 跑断言（见项目约定）。
 *
 * 需要持久化的状态在 prefs.ts / alerts.ts，需要发网络/命令的在 ipc.ts。
 * @Author: fu
 */
import type { JavaProcess, ProcessKind, Severity } from './types';

/* =============================================
   ====== 阈值 ======
   ============================================= */

/**
 * CPU 告警阈值（百分比）。
 *
 * ps 的 %cpu 在多核机器上可以超过 100（macOS 上限 = 100 × 核数），
 * 所以「100%」并不代表满负荷 —— 一个跑满 8 核的进程会显示到 800。
 * 阈值定在 150 / 400：前者是「确实在烧 CPU」，后者是「基本可以确定出问题了」。
 *
 * 另外 ps %cpu 是**进程生命周期内的平均值**，不是瞬时值：
 * 刚启动的进程会偏高（启动时类加载+JIT），跑了几天的进程再怎么忙也压得很低。
 * 所以这两个阈值只用来「提示值得看一眼」，不作为判定依据。
 */
export const CPU_WARN_AT = 150;
export const CPU_DANGER_AT = 400;

/** 堆占用率告警阈值（百分比） */
export const HEAP_WARN_AT = 75;
export const HEAP_DANGER_AT = 90;

/* =============================================
   ====== 归类 ======
   ============================================= */

/**
 * 判定进程属于哪一类。
 *
 * 顺序有讲究：**越具体的越靠前**。
 * IDEA 启动的 Maven 服务器（`org.jetbrains.idea.maven.server.*`）同时命中
 * 「idea」和「maven」两条规则 —— 它挂在 IDEA 名下，用户看到它时想的是
 * 「IDEA 又起了个后台进程」，不是「我在跑 Maven 构建」，所以 idea 优先。
 */
export function classifyProcess(p: Pick<JavaProcess, 'mainClass' | 'command'>): ProcessKind {
  const main = p.mainClass || '';
  const cmd = p.command || '';
  const hay = `${main} ${cmd}`;

  if (/org\.jetbrains\.idea|com\.intellij|idea\.maven\.server/i.test(hay)) return 'idea';
  if (/org\.gradle|gradlew|gradle-daemon|GradleDaemon/i.test(hay)) return 'gradle';
  if (/org\.apache\.maven|plexus\.classworlds|maven\.wrapper/i.test(hay)) return 'maven';
  if (/surefire|junit|org\.junit|testcontainers/i.test(hay)) return 'test';
  /*
   * Spring Boot 没有统一的类名特征，靠启动参数认：
   * 打包成 fat jar 时命令行里是 `-jar xxx.jar`，后缀的 profile / port 参数才是证据。
   * 只认 `Application` 结尾的类名是不够的（很多项目的启动类就叫 Main）。
   */
  if (/--spring\.profiles\.active|--server\.port|spring-boot|SpringBootServletInitializer/i.test(hay)) {
    return 'spring-boot';
  }
  return 'other';
}

/** 归类 → 中文名（界面标签用） */
export const KIND_LABEL: Record<ProcessKind, string> = {
  'spring-boot': 'Spring Boot',
  maven: 'Maven',
  gradle: 'Gradle',
  idea: 'IDEA',
  test: '测试',
  other: '其它',
};

/* =============================================
   ====== 显示名 ======
   ============================================= */

/**
 * 列表上显示的名字。
 *
 * jar 路径要**剥掉版本号**：`order-service-2.3.1.jar` 显示成 `order-service`，
 * 否则每次发版界面上就是另一个名字，用户没法把它和上次看到的对上是同一个服务。
 * 只剥尾部形如 `-2.3.1` / `-1.0-SNAPSHOT` 的这一段。
 */
export function displayName(p: Pick<JavaProcess, 'mainClass' | 'jarPath' | 'pid'>): string {
  const raw = p.jarPath || p.mainClass || '';
  if (!raw) return `PID ${p.pid}`;

  const base = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw.slice(raw.lastIndexOf('.') + 1);
  const noExt = base.replace(/\.jar$/i, '');
  const trimmed = noExt.replace(/-(\d+)(?:\.[\w-]+)*$/, '');
  return trimmed || noExt || `PID ${p.pid}`;
}

/* =============================================
   ====== 格式化 ======
   ============================================= */

/** 端口去重 + 升序。Rust 侧已排好，这里是防御（数据可能来自快照） */
export function sortPorts(ports: number[]): number[] {
  const uniq = Array.from(new Set(ports.filter((p) => Number.isFinite(p) && p > 0)));
  uniq.sort((a, b) => a - b);
  return uniq;
}

/** 端口列表 → "8080, 9000"；没有端口时给一个明确的占位 */
export function formatPorts(ports: number[]): string {
  const list = sortPorts(ports);
  return list.length > 0 ? list.join(', ') : '无监听端口';
}

/** 秒 → "3 分钟" / "2 小时 5 分" / "1 天 3 小时" */
export function formatUptime(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || sec < 0) return '—';
  if (sec < 60) return `${Math.round(sec)} 秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟`;
  const hour = Math.floor(min / 60);
  if (hour < 24) {
    const rest = min % 60;
    return rest === 0 ? `${hour} 小时` : `${hour} 小时 ${rest} 分`;
  }
  const day = Math.floor(hour / 24);
  const restHour = hour % 24;
  return restHour === 0 ? `${day} 天` : `${day} 天 ${restHour} 小时`;
}

/** MB → "512 MB" / "1.2 GB" */
export function formatMem(mb: number | null | undefined): string {
  if (mb === null || mb === undefined || mb <= 0) return '—';
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

/** 已用 / 容量 → "512 / 1024 MB"；任一侧缺失都是「—」而不是「0 / 0」 */
export function formatHeap(usedMb: number | null, maxMb: number | null): string {
  if (usedMb === null || maxMb === null || maxMb <= 0) return '—';
  return `${Math.round(usedMb)} / ${Math.round(maxMb)} MB`;
}

/* =============================================
   ====== 严重程度 ======
   ============================================= */

/** 堆占用百分比；拿不到就 null（「未知」和「0%」是两件事） */
export function heapPercent(p: Pick<JavaProcess, 'heapUsedMb' | 'heapMaxMb'>): number | null {
  const { heapUsedMb, heapMaxMb } = p;
  if (heapUsedMb === null || heapMaxMb === null || heapMaxMb <= 0) return null;
  const v = (heapUsedMb / heapMaxMb) * 100;
  return Math.max(0, Math.min(100, Math.round(v)));
}

/** 单个进程的严重程度 */
export function severityOf(p: JavaProcess): Severity {
  const heap = heapPercent(p);
  if ((heap !== null && heap >= HEAP_DANGER_AT) || p.cpuPercent >= CPU_DANGER_AT) return 'danger';
  if ((heap !== null && heap >= HEAP_WARN_AT) || p.cpuPercent >= CPU_WARN_AT) return 'warn';
  return 'ok';
}

/**
 * 一批进程里最严重的那个。
 *
 * 空列表返回 null 而不是 'ok' —— 调用方（角标）要靠它区分
 * 「一切正常」和「根本没有数据」，后者不该出角标。
 */
export function worstSeverity(list: JavaProcess[]): Severity | null {
  if (list.length === 0) return null;
  let worst: Severity = 'ok';
  for (const p of list) {
    const s = severityOf(p);
    if (s === 'danger') return 'danger';
    if (s === 'warn') worst = 'warn';
  }
  return worst;
}

/* =============================================
   ====== 侧栏角标 ======
   ============================================= */

/**
 * 角标文案：进程数。
 *
 * 为什么是进程数而不是告警数：一个常驻的告警角标会立刻变成噪音，
 * 而「现在跑着几个 JVM」是 Java 开发随时想知道的事（内存不够、
 * 端口冲突时第一个问题就是它）。音调仍按最严重的那个进程走 ——
 * 于是「3」这个数字在什么情况下值得点进去看，一眼就知道了。
 *
 * 一个进程都没有时返回 null（没有可比数据，不出角标）。
 */
export function badgeText(list: JavaProcess[]): string | null {
  if (list.length === 0) return null;
  return String(list.length);
}

/** 严重程度 → 角标色调文案 */
export function severityTone(s: Severity): 'info' | 'warn' | 'danger' {
  if (s === 'danger') return 'danger';
  if (s === 'warn') return 'warn';
  return 'info';
}

/* =============================================
   ====== 摘要（推送徽章 / 首页卡片用） ======
   ============================================= */

/**
 * 一句话摘要，例："3 个 JVM · 8080, 9000"。
 *
 * 端口要排重：同一台机器上跑两个微服务监听同一个端口是不可能的，
 * 但一个进程占多个端口很常见，直接 join 会列出重复项。
 */
export function processSummary(list: JavaProcess[]): string {
  if (list.length === 0) return '没有运行中的 Java 进程';
  const ports = sortPorts(list.flatMap((p) => p.ports));
  const head = `${list.length} 个 JVM`;
  return ports.length > 0 ? `${head} · ${ports.join(', ')}` : `${head} · 无监听端口`;
}

/**
 * 值得提醒的进程（堆或 CPU 到 warn 档及以上）。
 *
 * 只返回**最严重的那一个**：徽章屏幕窄，一次推三条用户只会全划掉。
 * 下次刷新如果它还在，去重键没变就不会重推（见 alerts.ts）。
 */
export function pickAlertTarget(list: JavaProcess[]): JavaProcess | null {
  let best: JavaProcess | null = null;
  let bestScore = -1;
  for (const p of list) {
    const s = severityOf(p);
    if (s === 'ok') continue;
    const score = (heapPercent(p) ?? 0) + p.cpuPercent / 10;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}

/** 提醒正文，例："order-service 堆占用 92%" */
export function alertBody(p: JavaProcess): string {
  const name = displayName(p);
  const heap = heapPercent(p);
  if (heap !== null && heap >= HEAP_WARN_AT) return `${name} 堆占用 ${heap}%`;
  return `${name} CPU ${Math.round(p.cpuPercent)}%`;
}
