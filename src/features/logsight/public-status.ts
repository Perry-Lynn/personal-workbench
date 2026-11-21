/*
 * LogSight 模块 · 对外公开契约（状态）
 * ------------------------------------------------------------------
 * 工作台约定：模块之间不互相 import 内部实现。别的模块（目前是首页）
 * 需要读「现在有几个日志会话在跑」时，**只 import 本文件**。
 *
 * ⚠️ 为什么状态门面要跟 `public.ts` 分成两个文件（与 git/jvm 不同）：
 * `public.ts` 是**组件**门面，它静态导出 LogViewer，而 LogViewer 依赖
 * react-window + dayjs，并 `import './logsight.css'`。首页是**默认落地页**，
 * 一进来就要渲染；如果首页从 public.ts 取一个整数，会把整个日志查看器
 * 和它的样式一起拖进首页 chunk（实测 LogSightModule 分包 230KB）。
 *
 * 所以这里按**职责**切，而不是按模块切：
 *   public.ts         组件门面 —— JAR 运行器复用日志查看器用
 *   public-status.ts  状态门面 —— 首页读运行中会话数用（本文件，零组件依赖）
 *
 * 两个文件都不暴露 store / IPC 写操作。
 * @Author: fu
 */
import { useLogSightStore } from './store/useLogSightStore';

/**
 * 正在流式 / 已连接的会话数。
 *
 * 口径与侧栏角标一致（见 index.tsx 的 runningSessionCount）：
 * 只数 Streaming / Connected —— Connecting 还没连上、Error 已经失败，
 * 两者都不该算「在跑」。改口径时两处要一起改。
 */
export function useRunningSessionCount(): number {
  /*
   * 选择器返回**数字**而不是过滤后的数组：zustand v5 用 Object.is 比较，
   * 返回新数组每次都是新引用 → 无限重渲染。
   */
  return useLogSightStore((s) =>
    s.tabs.reduce(
      (n, t) => (t.status === 'Streaming' || t.status === 'Connected' ? n + 1 : n),
      0,
    ),
  );
}

/** 打开的标签页总数（区分「没有会话」和「有标签但都断了」） */
export function useOpenTabCount(): number {
  return useLogSightStore((s) => s.tabs.length);
}
