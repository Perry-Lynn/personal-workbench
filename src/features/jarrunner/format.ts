/*
 * JAR 运行器 · 纯逻辑
 * ------------------------------------------------------------------
 * 只放「不碰 React、不碰 IPC」的展示与取舍规则，配 scripts/logic-test.ts 断言：
 *   路径识别与拖放分流、日志合并（重连时会拉到重复行）、统计、时长、状态文案。
 *
 * 命令行怎么拼**不在这里** —— 那件事后端才是权威（见 ipc.preview 的注释）。
 *
 * ⚠️ 「过滤与裁剪」曾经也在这里（filterLines / tailLines / RENDER_CAP），
 * 现在**没有了**：输出区改成复用 LogSight 的日志查看器之后，关键字搜索、级别筛选、
 * 排除词、正则全都由查看器那套纯逻辑负责（见 logAdapt.ts 与 logsight/public.ts）。
 * 留着旧实现只会让人以为日志面板还是「自绘 + 裁剪 800 行」的老样子。
 * @Author: fu
 */
import type { LogLine, RunStatus } from './types';

/** 前端保留的日志行数上限（与后端 runner.rs 的 MAX_LOG_LINES 一致） */
export const LOG_CAP = 2000;

/** 状态 → 文案与 Tag 色调（色调是 antd Tag 的预设色名） */
export function statusMeta(s: RunStatus): { label: string; tone: string } {
  switch (s) {
    case 'running':
      return { label: '运行中', tone: 'processing' };
    case 'exited':
      return { label: '已结束', tone: 'success' };
    case 'failed':
      return { label: '失败', tone: 'error' };
    case 'stopped':
      return { label: '已停止', tone: 'default' };
    default:
      return { label: s, tone: 'default' };
  }
}

/**
 * JDK 的展示标签（下拉框里的一行）。
 *
 * ⚠️ 与后端 models.rs::jdk_label 是**同一套文案的两份实现**（一个在 Rust、
 * 一个在 TS，没法共用）。改文案时两边都要改 —— 不一致不会报错，
 * 只会变成「下拉框里写 sdkman、运行记录里写 Homebrew」这种对不上的现象。
 */
export function jdkLabel(version: string, source: string): string {
  const v = version.trim() || '未知版本';
  const from =
    source === 'sdkman'
      ? 'sdkman'
      : source === 'brew'
        ? 'Homebrew'
        : source === 'env'
          ? 'JAVA_HOME'
          : '系统';
  return `Java ${v} · ${from}`;
}

/**
 * 已运行时长。
 * `endedAt` 有值时算到那一刻，否则算到 `now` —— 不传 now 就没法单测，
 * 所以调用方（组件）要把当前时间传进来。
 */
export function elapsedText(startedAt: number, endedAt: number | null, now: number): string {
  const end = endedAt ?? now;
  const sec = Math.max(0, Math.floor((end - startedAt) / 1000));
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分 ${sec % 60} 秒`;
  const hour = Math.floor(min / 60);
  return `${hour} 小时 ${min % 60} 分`;
}

/** 是不是一个 jar 文件（只看后缀，拖进来的东西要靠它先滤一遍） */
export function isJarPath(p: string): boolean {
  return /\.jar$/i.test(p.trim());
}

/**
 * 是不是一个 Spring 配置文件（`application.yml` / `.yaml` / `.properties`）。
 *
 * 拖进来的东西按后缀**分流**：`.jar` 填进 jar 那一格，配置文件填进配置文件那一格。
 * 只看后缀、不认文件名：用户完全可以把配置写成 `order-service-dev.yml`。
 */
export function isConfigPath(p: string): boolean {
  return /\.(ya?ml|properties)$/i.test(p.trim());
}

/**
 * 从一次拖放的路径里挑出 jar 与配置文件。
 *
 * ⚠️ 两类要**分别找**，不能「命中一个就收工」：后缀互斥只保证**单个文件**不会
 * 同时算两类，而一次拖放可以带**多个路径** —— 从 Finder 里把 `order-service.jar`
 * 和它的 `application.yml` 一起拖进来是常事。
 * 早先写成「jar 优先、命中就返回」，配置文件被**静默丢掉**：用户以为配置带上了，
 * 实际没有，而那正是 `validate` 想防的「配置没生效但服务起来了」那类问题。
 *
 * 两个都为 null 时，调用方应当什么都不做（拖个 txt 进来不该有动静）。
 */
export function pickDropTargets(paths: string[]): { jar: string | null; config: string | null } {
  return {
    jar: paths.find(isJarPath) ?? null,
    config: paths.find(isConfigPath) ?? null,
  };
}

/** 路径 → 文件名 */
export function baseName(p: string): string {
  const s = p.replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) : s;
}

/** 路径 → 所在目录（用来填默认工作目录） */
export function parentDirOf(p: string): string {
  const s = p.replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i > 0 ? s.slice(0, i) : '';
}

/** jar 文件名 → 展示名（去掉 .jar 后缀） */
export function jarDisplayName(p: string): string {
  const name = baseName(p);
  return name.replace(/\.jar$/i, '') || name;
}

/**
 * 按 seq 去重后合并两批日志，并截断到 cap。
 *
 * 为什么必须以 seq 为键：模块挂载时会拉一次后端缓存的日志，
 * 而事件流此刻也在推 —— 两边必然重叠一段。按 seq 合并能让「重连」不出重影，
 * 而按内容比会误伤（同一行日志打印两次是常有的事）。
 */
export function mergeLines(a: LogLine[], b: LogLine[], cap = LOG_CAP): LogLine[] {
  const map = new Map<number, LogLine>();
  for (const l of a) map.set(l.seq, l);
  for (const l of b) map.set(l.seq, l);
  const out = Array.from(map.values()).sort((x, y) => x.seq - y.seq);
  return out.length > cap ? out.slice(out.length - cap) : out;
}

/** 追加一批日志（内部走 mergeLines，保证上限与去重规则只有一份） */
export function appendLines(existing: LogLine[], incoming: LogLine[], cap = LOG_CAP): LogLine[] {
  if (incoming.length === 0) return existing;
  return mergeLines(existing, incoming, cap);
}

/** 日志统计：总行数与错误行数（界面上的「1234 行 · 5 条 stderr」） */
export function logStats(lines: LogLine[]): { total: number; errors: number } {
  let errors = 0;
  for (const l of lines) if (l.stream === 'stderr') errors += 1;
  return { total: lines.length, errors };
}
