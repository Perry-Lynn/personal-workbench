/*
 * JAR 运行器模块 · 前端状态
 * ------------------------------------------------------------------
 * 两块状态刻意分开：
 *   1. **表单与列表**（draft / configs / jdks）—— 用户填的东西，切走不该丢；
 *   2. **运行与日志**（runs / logsByRun）—— 进程还在跑时切走再回来必须还在，
 *      所以模块 keepAlive 之外，这里自己也留一份（service.ts 的常驻监听会持续喂它）。
 *
 * 日志为什么放 store 而不是组件 state：非 keepAlive 模块切走就卸载，
 * 组件里的日志会丢，而服务是长跑的、日志不可再生。
 * @Author: fu
 */
import { create } from 'zustand';
import { pushEvent, type EventTone } from '@/core/events';
import * as ipc from './ipc';
import { appendLines, jarDisplayName, parentDirOf } from './format';
import {
  clearArgs,
  loadArgHistory,
  recordArg,
  saveArgHistory,
  type ArgHistory,
  type ArgKind,
} from './argHistory';
import {
  emptyConfig,
  type JarConfig,
  type JdkInfo,
  type LogLine,
  type RunInfo,
  type RunStatus,
} from './types';

/**
 * 一次拖入命中的东西。
 *
 * 为什么是**并集**而不是「一个路径 + 一个类别」：一次拖放可以带多个文件，
 * 把 `order-service.jar` 和它的 `application.yml` 一起拖进来是常事。
 * 早先那版只存得下一个路径，于是「两个都拖进来」根本表达不出来 ——
 * 分流时配置文件被静默丢掉，用户以为配置带上了、实际没有。
 */
export interface DropHit {
  jar: string | null;
  config: string | null;
}

interface JarRunnerStore {
  /* ===== 静态数据 ===== */
  jdks: JdkInfo[];
  configs: JarConfig[];
  /** 首次读取是否完成（读失败也要置 true，否则界面永远转圈） */
  loaded: boolean;
  loading: boolean;
  error: string | null;

  /* ===== 表单 ===== */
  draft: JarConfig;
  /** 命令预览（后端算的，与实际启动同源） */
  preview: string;
  previewError: string | null;
  draftDirty: boolean;
  pendingConfigReload: JarConfig | null;
  retainedConfigReload: JarConfig | null;
  configViewRequest: number;
  /**
   * JVM / 程序参数的输入历史（按 jar 分别记）。
   * 存在 localStorage（见 argHistory.ts 的取舍说明），不进后端配置 ——
   * 它只是输入框的候选值，不参与运行。
   */
  argHistory: ArgHistory;

  /* ===== 运行 ===== */
  runs: RunInfo[];
  activeRunId: string | null;
  logsByRun: Record<string, LogLine[]>;
  starting: boolean;
  /**
   * 最近一次「拖进来了什么」与它的时间戳。
   * 常驻服务只负责记，提示由界面发（服务层没有 message 可用）——
   * 单独给个时间戳是因为拖同一批文件两次也要再提示一次。
   */
  lastDropped: DropHit | null;
  lastDroppedAt: number;

  /* ===== 动作 ===== */
  loadAll: () => Promise<void>;
  loadRuns: () => Promise<void>;
  setDraft: (patch: Partial<JarConfig>) => void;
  /** 选好了 jar（拖入或文件选择器）：顺手填好名字与默认工作目录 */
  pickJar: (path: string) => void;
  /**
   * 选好了配置文件（Spring 的 application.yml 这类）。
   *
   * 与 `pickJar` 的区别是**只动这一格**：名字与工作目录是从 jar 推出来的，
   * 换个配置文件不该把它们一起改掉 —— 同一份配置换环境是常态。
   */
  pickConfigFile: (path: string) => void;
  refreshPreview: () => Promise<void>;
  startRun: () => Promise<RunInfo>;
  stopRun: (id: string) => Promise<void>;
  removeRun: (id: string) => Promise<void>;
  saveDraft: () => Promise<JarConfig>;
  removeConfig: (id: string) => Promise<void>;
  loadConfig: (id: string) => void;
  reloadPendingConfig: () => void;
  keepDraftAfterConfigReload: () => void;
  requestConfigView: () => void;
  clearLogs: (runId: string) => Promise<void>;
  setActiveRun: (id: string | null) => void;
  /** 记一次「拖进来了这些文件」（由常驻服务调用） */
  markDropped: (hit: DropHit) => void;
  /** 把一串参数记进这个 jar 的历史（启动成功后调，空串自动忽略） */
  recordArgs: (jarPath: string, kind: ArgKind, args: string) => void;
  /** 清掉某个 jar 某一类的参数历史 */
  clearArgHistory: (jarPath: string, kind: ArgKind) => void;

  /* ===== 供常驻服务调用 ===== */
  ingestLines: (runId: string, lines: LogLine[]) => void;
  ingestStatus: (
    runId: string,
    status: RunStatus,
    exitCode: number | null,
    endedAt: number | null,
    error: string | null,
  ) => void;
}

export const useJarRunnerStore = create<JarRunnerStore>((set, get) => ({
  jdks: [],
  configs: [],
  loaded: false,
  loading: false,
  error: null,

  draft: emptyConfig(),
  preview: '',
  previewError: null,
  draftDirty: false,
  pendingConfigReload: null,
  retainedConfigReload: null,
  configViewRequest: 0,
  argHistory: loadArgHistory(),

  runs: [],
  activeRunId: null,
  logsByRun: {},
  starting: false,
  lastDropped: null,
  lastDroppedAt: 0,

  loadAll: async () => {
    set({ loading: true, error: null });
    try {
      const [jdks, configs, runs] = await Promise.all([
        ipc.listJdks(),
        ipc.listConfigs(),
        ipc.listRuns(),
      ]);
      set({
        jdks,
        configs,
        runs,
        loading: false,
        loaded: true,
        /* 之前跑着的进程还在：把最新的那个设为当前，日志区不至于空着 */
        activeRunId: get().activeRunId ?? (runs[0]?.id ?? null),
      });
    } catch (e) {
      /* 读失败也要结束 loading：否则界面一直转圈、既看不到值也点不动 */
      set({
        loading: false,
        loaded: true,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  },

  loadRuns: async () => {
    const runs = await ipc.listRuns();
    set({ runs });
  },

  setDraft: (patch) => set({ draft: { ...get().draft, ...patch }, draftDirty: true }),

  pickJar: (path) => {
    const d = get().draft;
    set({
      draft: {
        ...d,
        jarPath: path,
        /* 名字只在还没起过的时候自动填：用户改过就不动，免得手一抖被覆盖 */
        name: d.name.trim() ? d.name : jarDisplayName(path),
        workDir: d.workDir.trim() ? d.workDir : parentDirOf(path),
      },
      draftDirty: true,
    });
  },

  pickConfigFile: (path) => set({ draft: { ...get().draft, configFile: path }, draftDirty: true }),

  refreshPreview: async () => {
    try {
      const p = await ipc.preview(get().draft);
      set({ preview: p, previewError: null });
    } catch (e) {
      set({ previewError: e instanceof Error ? e.message : String(e) });
    }
  },

  startRun: async () => {
    set({ starting: true });
    try {
      const run = await ipc.start(get().draft);
      set({
        runs: [run, ...get().runs.filter((r) => r.id !== run.id)],
        activeRunId: run.id,
        starting: false,
      });
      /* 事件流：只在**启动成功**时记一条。启动失败由调用方弹错，不重复记 */
      pushEvent({
        module: 'jarrunner',
        tone: 'ok',
        title: `启动了 ${run.name}`,
        detail: run.pid ? `pid ${run.pid}` : run.jdkLabel,
      });
      /*
       * 启动成功了才把参数记进历史：手打一半的、试错的、一启动就报错的
       * 都不该进候选列表 —— 否则下拉里很快全是「跑不起来的那一套」。
       * 键用 draft 里的路径（不是 run.jarPath）：pickJar 填进去的就是它，
       * 下次载入同一份配置时才对得上同一格历史。
       */
      get().recordArgs(get().draft.jarPath, 'jvm', get().draft.jvmArgs);
      get().recordArgs(get().draft.jarPath, 'program', get().draft.programArgs);
      /*
       * 紧接着对一次账，专治「进程瞬间退出」：
       * 状态事件可能在 start 返回之前就到了，那时 runs 里还没有这条，
       * ingestStatus 会把它丢掉；而上面刚 set 进去的 run 是 start 的返回值 ——
       * 一份「刚 spawn」的死快照（后端 runner.rs 里 status 硬编码 Running），
       * 它不会自己变成「已结束」，界面于是永远停在运行中。
       * 后端 emit_status 的 payload 就是从 handle.info 里读的（同一个来源），
       * 所以事件携带的状态**不可能比 list_runs 读到的更新**：
       * 只要事件发过，这里重拉必然拿到真状态；
       * 若还没发，事件稍后到达时 run 已经在 store 里，能正常应用。两头都不漏。
       */
      try {
        await get().loadRuns();
      } catch {
        /* 对账失败不影响已经启动的进程，状态还有事件流兜底 */
      }
      /*
       * 启动后立刻拉一次后端日志：事件流可能在 start 返回之前就推了头几行
       * （例如「已启动 pid=…」），那时 run 还没进 store，那些行会被丢掉。
       * 按 seq 合并，重复拉不会出重影。
       */
      try {
        get().ingestLines(run.id, await ipc.logs(run.id));
      } catch {
        /* 拉不到就等事件流，不影响已经启动的进程 */
      }
      return run;
    } catch (e) {
      set({ starting: false });
      throw e;
    }
  },

  stopRun: async (id) => {
    await ipc.stop(id);
    get().ingestStatus(id, 'stopped', null, Date.now(), null);
    await get().loadRuns();
  },

  removeRun: async (id) => {
    await ipc.remove(id);
    const { runs, logsByRun, activeRunId } = get();
    const nextLogs = { ...logsByRun };
    delete nextLogs[id];
    const nextRuns = runs.filter((r) => r.id !== id);
    set({
      runs: nextRuns,
      logsByRun: nextLogs,
      activeRunId: activeRunId === id ? (nextRuns[0]?.id ?? null) : activeRunId,
    });
  },

  saveDraft: async () => {
    const saved = await ipc.saveConfig(get().draft);
    set({
      draft: saved,
      configs: [saved, ...get().configs.filter((c) => c.id !== saved.id)],
      draftDirty: false,
      pendingConfigReload: null,
      retainedConfigReload: null,
    });
    return saved;
  },

  removeConfig: async (id) => {
    await ipc.deleteConfig(id);
    set({
      configs: get().configs.filter((c) => c.id !== id),
      /* 删掉的正是正在编辑的那份 → 表单回到新建态，否则 id 会指向一条已删除的配置 */
      draft: get().draft.id === id ? { ...get().draft, id: '' } : get().draft,
      draftDirty: get().draft.id === id,
      pendingConfigReload: get().draft.id === id ? null : get().pendingConfigReload,
      retainedConfigReload: get().draft.id === id ? null : get().retainedConfigReload,
    });
  },

  loadConfig: (id) => {
    const c = get().configs.find((x) => x.id === id);
    if (c) set({ draft: { ...c }, draftDirty: false, pendingConfigReload: null, retainedConfigReload: null });
  },

  reloadPendingConfig: () => {
    const pending = get().pendingConfigReload ?? get().retainedConfigReload;
    if (pending) set({ draft: { ...pending }, draftDirty: false, pendingConfigReload: null, retainedConfigReload: null });
  },

  keepDraftAfterConfigReload: () => set((s) => ({ pendingConfigReload: null, retainedConfigReload: s.pendingConfigReload })),

  requestConfigView: () => set((s) => ({ configViewRequest: s.configViewRequest + 1 })),

  clearLogs: async (runId) => {
    await ipc.clearLogs(runId);
    set({ logsByRun: { ...get().logsByRun, [runId]: [] } });
  },

  setActiveRun: (id) => set({ activeRunId: id }),

  markDropped: (hit) => set({ lastDropped: hit, lastDroppedAt: Date.now() }),

  recordArgs: (jarPath, kind, args) => {
    const next = recordArg(get().argHistory, jarPath, kind, args);
    /* 空串等无效输入时 recordArg 会原样返回同一个引用 —— 那就别写盘了 */
    if (next === get().argHistory) return;
    set({ argHistory: next });
    saveArgHistory(next);
  },

  clearArgHistory: (jarPath, kind) => {
    const next = clearArgs(get().argHistory, jarPath, kind);
    if (next === get().argHistory) return;
    set({ argHistory: next });
    saveArgHistory(next);
  },

  ingestLines: (runId, lines) => {
    if (lines.length === 0) return;
    const cur = get().logsByRun;
    set({ logsByRun: { ...cur, [runId]: appendLines(cur[runId] ?? [], lines) } });
  },

  ingestStatus: (runId, status, exitCode, endedAt, error) => {
    /*
     * 事件可能早于 start 的返回值到达（进程瞬间退出时）：那时 runs 里还没有这条，
     * map 不会凭空建，这次更新就被丢掉了。
     * **丢掉本身不算错，错的是没人再补一次** —— start 返回的 RunInfo 是「刚 spawn」
     * 的快照（status 硬编码 Running），不会自己变成「已结束」，光靠它会永远显示运行中。
     * 所以 startRun 里 set 完必须紧跟着 loadRuns() 对账 —— 改这里时别把那一段删了。
     */
    const prev = get().runs.find((r) => r.id === runId);
    const runs = get().runs.map((r) =>
      r.id === runId ? { ...r, status, exitCode, endedAt, error } : r,
    );
    set({ runs });

    /*
     * 事件流挂在这里，而不是散在各个调用方 —— 这里是状态变化的**唯一汇聚点**
     * （后端推事件、stopRun 手动补、启动后对账全走它）。
     *
     * 但必须判「状态真的变了」：同一次退出常常先由事件推一次、stopRun 再补一次，
     * 不判重就会出现两条一模一样的「已停止」。也没必要记 running ——
     * 「启动了」那条已经由 startRun 发过了。
     */
    if (prev && prev.status !== status && status !== 'running') {
      let tone: EventTone = 'ok';
      let title = `${prev.name} 已退出`;
      if (status === 'failed') {
        tone = 'error';
        title = `${prev.name} 运行失败`;
      } else if (status === 'stopped') {
        tone = 'info';
        title = `${prev.name} 已停止`;
      } else if (exitCode !== null && exitCode !== 0) {
        tone = 'warn';
        title = `${prev.name} 异常退出`;
      } else {
        title = `${prev.name} 正常退出`;
      }
      pushEvent({
        module: 'jarrunner',
        tone,
        title,
        detail: error ?? (exitCode !== null ? `退出码 ${exitCode}` : ''),
      });
    }
  },
}));
