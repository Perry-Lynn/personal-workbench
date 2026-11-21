/*
 * Spring 服务台 · 组件门面
 * ------------------------------------------------------------------
 * 2026-10-20 起，spring 不再是独立的导航模块，而是「JVM 与 Spring」里的
 * 第二个标签页。理由：两者回答的是同一个问题（本机有哪些 Java 进程、占哪个端口、
 * 健不健康），分成两个模块只会逼用户在两个列表之间对 PID。
 *
 * 这里只暴露一个视图组件（和 logsight/public.ts 暴露 LogViewer 是同一手法），
 * jvm 通过它复用，**不 import spring 的 store / ipc / 组件内部**。
 * 后端命令（spring_scan / spring_probe / spring_open）保持原样，没有动 Rust。
 * @Author: fu
 */
export { default as SpringPanel } from './SpringView';
export type { SpringApp } from './types';
