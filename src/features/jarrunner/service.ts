/*
 * JAR 运行器模块 · 常驻服务
 * ------------------------------------------------------------------
 * 与 jvm / balances 的 service.ts 同一套理由：**进程与日志不依赖用户是否打开过模块**。
 * 用户拖一个 jar 进来 → 服务把它填进表单；服务在跑着 → 侧栏角标就能显示
 * 「现在有几个 jar 在跑」；切走再回来，日志由这里持续喂给 store，不会断档。
 *
 * 三条刻意的设计：
 *   1. **事件监听挂在服务里**，不挂在组件里。组件会卸载，而子进程不会停 ——
 *      监听跟着组件走的话，切走期间的日志就全丢了。
 *   2. **拖放是全局的**：Tauri 把拖进窗口的文件以 `tauri://drag-drop` 发出来
 *      （Rust 侧 manager/webview.rs，事件名固定）。分流规则在
 *      `format.ts::pickDropTargets`（**纯函数 + 单测**）：`.jar` 填进 jar 那一格，
 *      `.yml` / `.yaml` / `.properties` 填进配置文件那一格，两类**可以同时命中**
 *      （一次拖多个文件是常事，见那个函数的注释）。其余后缀一律不理 ——
 *      在别的模块拖个 txt 进来不该有任何动静。
 *      拖到就切到本模块并把路径填进表单：用户拖进来的意图就是「用它跑」，
 *      让他再自己找一遍入口没有意义。
 *   3. 角标优先显示**失败**数：跑挂了是需要立刻知道的事，
 *      而「正在跑」平时是预期内的状态。
 * @Author: fu
 */
import { listen } from '@tauri-apps/api/event';
import type { ModuleBadge } from '@/core/types';
import { useWorkbenchStore } from '@/store/useWorkbenchStore';
import { pickDropTargets } from './format';
import { useJarRunnerStore } from './store';
import type { LogBatchEvent, RunStatusEvent } from './types';

/* 与后端 modules/jarrunner/mod.rs 的两个常量逐字对应 */
const EVENT_LOG_LINES = 'jarrunner:log-lines';
const EVENT_RUN_STATUS = 'jarrunner:run-status';
/** Tauri 自带的窗口拖放事件（Rust 侧发出，事件名是框架内部常量） */
const EVENT_DRAG_DROP = 'tauri://drag-drop';

/* =============================================
   ====== 侧栏角标 ======
   ============================================= */

export function jarrunnerBadge(): ModuleBadge | null {
  const runs = useJarRunnerStore.getState().runs;
  let failed = 0;
  let running = 0;
  for (const r of runs) {
    if (r.status === 'failed') failed += 1;
    if (r.status === 'running') running += 1;
  }
  if (failed > 0) return { text: failed, tone: 'danger' };
  if (running > 0) return { text: running, tone: 'info' };
  return null;
}

/** 角标数据源订阅：运行列表变化就要重算 */
export function subscribeJarRunnerBadge(onChange: () => void): () => void {
  return useJarRunnerStore.subscribe(onChange);
}

/* =============================================
   ====== 启动 ======
   ============================================= */

let started = false;

/** 启动常驻服务。重复调用无副作用。由模块入口在 import 时调用。 */
export function startJarRunnerService(): void {
  if (started) return;
  started = true;

  void listen<LogBatchEvent>(EVENT_LOG_LINES, (e) => {
    const { runId, lines } = e.payload ?? ({} as LogBatchEvent);
    if (!runId || !Array.isArray(lines)) return;
    useJarRunnerStore.getState().ingestLines(runId, lines);
  });

  void listen<RunStatusEvent>(EVENT_RUN_STATUS, (e) => {
    const p = e.payload;
    if (!p?.runId || !p.status) return;
    useJarRunnerStore.getState().ingestStatus(p.runId, p.status, p.exitCode, p.endedAt, p.error);
  });

  void listen<{ paths?: string[] }>(EVENT_DRAG_DROP, (e) => {
    const hit = pickDropTargets(e.payload?.paths ?? []);
    if (!hit.jar && !hit.config) return;

    const store = useJarRunnerStore.getState();
    if (hit.jar) store.pickJar(hit.jar);
    if (hit.config) store.pickConfigFile(hit.config);
    store.markDropped(hit);

    /* 拖进来的意图就是用它：直接切到本模块，别让用户再找一遍 */
    const wb = useWorkbenchStore.getState();
    if (wb.activeModuleId !== 'jarrunner') {
      wb.setActiveModule('jarrunner');
    }
  });
}
