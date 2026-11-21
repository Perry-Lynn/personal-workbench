/*
 * JAR 运行器模块 · 对外公开契约
 * ------------------------------------------------------------------
 * 工作台约定：模块之间不互相 import 内部实现，跨模块只走 public.ts。
 *
 * 这个门面存在的唯一理由是**把「端口 / 进程」和「日志」接上**：
 * JVM 看板里看到一个 pid 占着 8080，用户想知道「这是我刚起的那个 jar 吗、
 * 它现在在打什么日志」。这两件事分别属于 JVM 模块和 JAR 运行器模块，
 * 唯一正确的接法是这里给两个只读/跳转能力，JVM 模块只认这两个函数。
 *
 * 刻意只暴露：
 *   - useRunPidMap()  只读，pid → runId
 *   - openRunLogs()   跳转 + 选中，不返回任何内部状态
 * 不暴露 store、不暴露 IPC —— 别的模块没有理由去启停进程。
 *
 * ⚠️ 本文件不 import 任何组件与样式：JVM 看板会引它，
 *    一旦带上 LogPane / logsight.css，JVM 分包就会凭空胖一圈。
 * @Author: fu
 */
import { useMemo } from 'react';
import { useJarRunnerStore } from './store';
import { useWorkbenchStore } from '@/store/useWorkbenchStore';

/** JAR 运行器在工作台里的模块 id（与 features/jarrunner/index.tsx 一致） */
const MODULE_ID = 'jarrunner';

/**
 * pid → 运行记录 id 的映射。
 *
 * 只收 `pid != null` 的记录：已退出的运行在 store 里还留着（供翻日志），
 * 但它们的 pid 已经不属于任何活进程 —— 收进来会让「同一个 pid 被系统复用
 * 给新进程」时认错人。
 *
 * 返回 Map 而不是「查找函数」：函数每次渲染都是新引用，
 * 挂在 useMemo 依赖里会无限重算。
 */
export function useRunPidMap(): Map<number, string> {
  const runs = useJarRunnerStore((s) => s.runs);
  return useMemo(() => {
    const m = new Map<number, string>();
    for (const r of runs) {
      if (r.pid != null) m.set(r.pid, r.id);
    }
    return m;
  }, [runs]);
}

/**
 * 跳到 JAR 运行器并选中这条运行记录。
 *
 * 先选中再切模块：模块是 keepAlive 的，切过去时组件已经挂载，
 * 选中态必须在切换**之前**写好，否则会先闪一下上一条的日志。
 */
export function openRunLogs(runId: string): void {
  useJarRunnerStore.getState().setActiveRun(runId);
  useWorkbenchStore.getState().setActiveModule(MODULE_ID);
}

/** Load a saved configuration into the form without starting a process. */
export async function openProjectConfig(configId: string): Promise<void> {
  const { listConfigs } = await import('./ipc');
  const configs = await listConfigs();
  if (!configs.some((config) => config.id === configId)) throw new Error('JAR 配置已不存在，请刷新项目关联列表');
  useJarRunnerStore.setState({ configs });
  useJarRunnerStore.getState().loadConfig(configId);
  useJarRunnerStore.getState().setActiveRun(null);
  useJarRunnerStore.getState().requestConfigView();
  useWorkbenchStore.getState().setActiveModule(MODULE_ID);
}

/** Minimal project picker data; never initializes runs or JDK discovery. */
export async function listProjectConfigs(): Promise<Array<{ id: string; name: string }>> {
  const { listConfigs } = await import('./ipc');
  return (await listConfigs()).map(({ id, name }) => ({ id, name }));
}

export async function reloadSavedConfigs(): Promise<void> {
  const { listConfigs } = await import('./ipc');
  const configs = await listConfigs();
  const state = useJarRunnerStore.getState();
  const restoredDraft = state.draft.id ? configs.find((config) => config.id === state.draft.id) : undefined;
  useJarRunnerStore.setState({
    configs,
    ...(restoredDraft ? state.draftDirty
      ? { pendingConfigReload: restoredDraft }
      : { draft: { ...restoredDraft }, draftDirty: false, pendingConfigReload: null }
      : {}),
  });
}

export async function listSafeBackupConfigs(): Promise<Array<{id:string;name:string;jarPath:string;jdkHome:string;configFile:string;workDir:string;updatedAt:number}>> {
  const { listConfigs } = await import('./ipc');
  return (await listConfigs()).map(({id,name,jarPath,jdkHome,configFile,workDir,updatedAt}) => ({id,name,jarPath,jdkHome,configFile,workDir,updatedAt}));
}
