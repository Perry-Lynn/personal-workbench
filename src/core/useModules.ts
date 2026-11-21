/*
 * 模块列表 React Hook
 * ------------------------------------------------------------------
 * 把 registry 的订阅能力包成 hook，模块增删时自动重渲染。
 * 目前模块在启动时一次性注册，订阅主要是为了支持未来的动态装卸。
 * @Author: fu
 */
import { useEffect, useState } from 'react';
import { listModules, subscribeModules } from './registry';
import type { WorkbenchModule } from './types';

/** 订阅全部模块定义 */
export function useModules(): WorkbenchModule[] {
  const [mods, setMods] = useState<WorkbenchModule[]>(() => listModules());
  useEffect(() => subscribeModules(() => setMods(listModules())), []);
  return mods;
}
