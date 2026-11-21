/*
 * Maven 助手模块 · IPC 封装
 * 命令前缀 maven_，统一走 @/core/ipc 的 call()（自动拆 ApiResponse）。
 * 不涉及主密钥：读的是本地仓库与项目 pom，跑的是本机的 mvn。
 */
import { call } from '@/core/ipc';
import type { MavenInfo, RepoStats, TreeResult } from './types';

/** 探测 mvn 与本地仓库。projectDir 用于优先采用项目自带的 ./mvnw */
export const locate = (projectDir: string | null): Promise<MavenInfo> =>
  call<MavenInfo>('maven_locate', { projectDir });

/** 扫本地仓库；path 为空时用自动探测到的路径 */
export const scanRepo = (path: string | null): Promise<RepoStats> =>
  call<RepoStats>('maven_scan_repo', { path });

/**
 * 解析依赖树。
 * 传的是**目录**而不是 pom 文件路径：mvn 要在项目目录里跑
 * （Maven Wrapper 还要读 .mvn/wrapper），多模块项目也依赖工作目录。
 */
export const dependencyTree = (projectDir: string, offline: boolean): Promise<TreeResult> =>
  call<TreeResult>('maven_dependency_tree', { projectDir, offline });
