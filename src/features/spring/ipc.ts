/*
 * Spring Boot 服务台 · IPC 封装
 * 命令前缀 spring_，统一走 @/core/ipc 的 call()（自动拆 ApiResponse）。
 * 不涉及主密钥：只读进程信息 + 打本机 HTTP。
 */
import { call } from '@/core/ipc';
import type { ActuatorInfo, SpringSnapshot } from './types';

/** 扫描本机 Java 进程并识别 Spring Boot；probe 为 true 时顺带探活 actuator */
export const scan = (probe: boolean): Promise<SpringSnapshot> =>
  call<SpringSnapshot>('spring_scan', { probe });

/** 对单个端口重试探活（用户点「重试」） */
export const probeOne = (port: number): Promise<ActuatorInfo> =>
  call<ActuatorInfo>('spring_probe', { port });

/**
 * 在浏览器里打开某个端口的页面。
 * 只传 port + path，主机部分由后端固定成本机回环地址。
 */
export const openPage = (port: number, path: string): Promise<void> =>
  call<void>('spring_open', { port, path });
