/*
 * LogSight 模块 · 对外公开契约
 * ------------------------------------------------------------------
 * 工作台约定：模块之间不互相 import 内部实现（store / 组件 / 类型细节）。
 * 别的模块要用「日志查看器」这套能力（虚拟滚动、列头、关键字高亮、级别筛选、
 * 堆栈折叠、右键复制）时，**只 import 本文件**。
 * 目前唯一调用方是 JAR 运行器：它把子进程的 stdout / stderr 喂进来，
 * 从而与日志查看器共用同一套渲染与交互，而不是各写一套日志面板。
 *
 * ⚠️ 样式必须在这里带上。`logsight.css` 原本由 LogSightModule.tsx 导入，
 * 而本文件可能在没有打开过 LogSight 模块的情况下就被加载（用户先开了 JAR 运行器）——
 * 不在这里导入的话，日志行的字号、级别配色、关键字高亮、折叠箭头全是裸的，
 * 而且**不会报任何错**，只是「看起来没生效」。
 *
 * ⚠️ 调用方必须**显式传 `height`**。不传时组件走 `window.innerHeight - rect.top`
 * 的绝对算法 —— 那是为 LogSight 的整屏式布局（日志区占满窗口剩余高度）设计的。
 * JAR 运行器是文档式布局，日志区只占页面里的一段，绝对算法会把虚拟列表撑得
 * 比容器高、整页被顶出多余的滚动条。
 *
 * 这里只暴露「渲染与过滤」，不暴露任何 store / IPC：查看器是纯 props 驱动的，
 * 外部模块不需要、也不应该碰到 LogSight 的会话与服务器状态。
 * @Author: fu
 */
import './logsight.css';
import type { ServerConfig } from './types';

/* ===== 渲染组件 ===== */
export { default as LogViewer } from './components/LogViewer';
export { LOG_COLUMNS, getEffectiveColumnWidths, type ColumnDef } from './components/LogViewer';
export { default as LogColumnHeader } from './components/LogColumnHeader';

/* ===== 过滤与归并（纯函数，可单测） ===== */
export {
  applyLogFilter,
  groupLines,
  detectNoisyLoggers,
  buildKeywordMatcher,
  buildExcludeMatcher,
  DEFAULT_SEARCH_FILTER,
  type RenderRow,
  type FilterResult,
  type FacetStat,
} from './utils/logFilter';

/* ===== 结构化字段的展示格式化 ===== */
export { abbreviateLogger, shortTraceId, LEVEL_LABEL, LEVEL_TEXT } from './utils/logFormat';

/*
 * 类型出口。
 * `LogLine` 重命名成 `ViewerLogLine` 再出去：JAR 运行器自己也有一份同名的
 * 「原始流」类型，两个 `LogLine` 在同一个文件里相遇时极容易被写混
 * （它们的字段完全不同，混了 TS 会报错，但报错点在适配层、离真正的错很远）。
 */
export type { SearchFilter, LogLevel, LogLine as ViewerLogLine } from './types';

/** Read only the labels and IDs needed by the project workspace. */
export async function listServersForProjects(): Promise<Array<{ id: string; name: string }>> {
  const { listServers } = await import('./services/tauriApi');
  return (await listServers()).map(({ id, title }) => ({ id, name: title }));
}

/** Open the existing edit dialog without starting an SSH session. */
export async function openServerSettings(id: string): Promise<void> {
  const [{ useLogSightStore }, { listServers }] = await Promise.all([
    import('./store/useLogSightStore'), import('./services/tauriApi'),
  ]);
  const servers = await listServers();
  if (!servers.some((server) => server.id === id)) throw new Error('服务器配置已不存在，请刷新项目关联列表');
  useLogSightStore.getState().setServers(servers);
  useLogSightStore.getState().openConnectionDialog(id);
  const { useWorkbenchStore } = await import('@/store/useWorkbenchStore');
  useWorkbenchStore.getState().setActiveModule('logsight');
}

export async function reloadSavedServerList(): Promise<void> {
  const [{ useLogSightStore }, { listServers }] = await Promise.all([
    import('./store/useLogSightStore'), import('./services/tauriApi'),
  ]);
  useLogSightStore.getState().setServers(await listServers());
}

export async function listSafeBackupServers(): Promise<Array<Pick<ServerConfig, 'id'|'bookmark_category'|'title'|'host'|'port'|'username'|'auth_type'|'private_key_path'|'ssh_config_path'|'use_ssh_agent'|'ssh_agent_path'|'use_mfa'|'created_at'|'updated_at'|'last_connected_at'>>> {
  const { listServers } = await import('./services/tauriApi');
  return (await listServers()).map((s) => ({
    id:s.id, bookmark_category:s.bookmark_category, title:s.title, host:s.host, port:s.port, username:s.username,
    auth_type:s.auth_type, private_key_path:s.private_key_path ?? null, ssh_config_path:s.ssh_config_path ?? null,
    use_ssh_agent:s.use_ssh_agent, ssh_agent_path:s.ssh_agent_path ?? null, use_mfa:s.use_mfa,
    created_at:s.created_at, updated_at:s.updated_at, last_connected_at:s.last_connected_at ?? null,
  }));
}
