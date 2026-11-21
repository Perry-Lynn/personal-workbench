/*
 * 工作台模块清单 —— 唯一的扩展点
 * ------------------------------------------------------------------
 * 新增一个功能模块只需要两步：
 *   1. 在 src/features/<你的模块>/ 下实现组件，并导出 WorkbenchModule 定义
 *      （参考 src/features/logsight/index.tsx）
 *   2. 在本文件里 import 并加入 MODULES 数组
 *
 * 不需要改侧栏、首页、设置页、ModuleHost —— 它们都从注册表读数据。
 * 模块的 group / order 决定侧栏位置，icon 决定侧栏与首页卡片图标。
 *
 * 模块加载顺序即注册顺序，同 order 时按此顺序排列。
 * @Author: fu
 */
import { registerModules } from './registry';
import type { WorkbenchModule } from './types';

import homeModule from '@/features/home';
import logsightModule from '@/features/logsight';
import settingsModule from '@/features/settings';
import aipassportModule from '@/features/aipassport';
import balancesModule from '@/features/balances';
import jvmModule from '@/features/jvm';
import jarrunnerModule from '@/features/jarrunner';
import mavenModule from '@/features/maven';
import snippetsModule from '@/features/snippets';
import timezoneModule from '@/features/timezone';
import gitModule from '@/features/git';
import projectsModule from '@/features/projects';
import communityModule from '@/features/community';

/* 工作台内置模块（总览 / 系统分区） */
const CORE_MODULES: WorkbenchModule[] = [homeModule, settingsModule];

/* 功能模块：后续扩展加在这里 */
const FEATURE_MODULES: WorkbenchModule[] = [
  logsightModule,
  jvmModule,
  jarrunnerModule,
  mavenModule,
  snippetsModule,
  timezoneModule,
  aipassportModule,
  balancesModule,
  gitModule,
  projectsModule,
  communityModule,
];

/* 全部模块 */
export const MODULES: WorkbenchModule[] = [...CORE_MODULES, ...FEATURE_MODULES];

/* 默认落地模块 id */
export const DEFAULT_MODULE_ID = 'home';

/* 已注册的模块 id 列表，便于调试 */
export function bootstrapModules(): string[] {
  registerModules(MODULES);
  return MODULES.map((m) => m.id);
}
