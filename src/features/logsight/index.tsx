/*
 * LogSight 模块入口
 * ------------------------------------------------------------------
 * 把 LogSight 暴露成工作台标准模块。工作台侧栏会自动出现「日志查看」。
 *
 * 主体组件用 React.lazy 做代码分割：只有真正进入这个模块时才加载它的代码，
 * 后续模块变多也不会拖慢工作台启动。
 * 模块样式在主体组件里 import，随模块代码一起按需加载。
 * @Author: fu
 */
import { lazy } from 'react';
import { FileTextOutlined } from '@ant-design/icons';
import { useLogSightStore } from './store/useLogSightStore';
import { LOGSIGHT_VERSION } from './version';
import type { WorkbenchModule } from '@/core/types';


const LogSightModule = lazy(() => import('./LogSightModule'));

/* 正在流式/已连接会话数，作为侧栏角标 */
function runningSessionCount(): number {
  return useLogSightStore
    .getState()
    .tabs.filter((t) => t.status === 'Streaming' || t.status === 'Connected').length;
}

export const logsightModule: WorkbenchModule = {
  id: 'logsight',
  name: '日志查看',
  description:
    'SSH 连接远程服务器查看日志：实时 tail、历史查询、关键字与级别过滤、traceId 链路追踪',
  icon: <FileTextOutlined />,
  group: '运维',
  order: 10,
  version: LOGSIGHT_VERSION,
  keywords: ['日志', 'log', 'ssh', '服务器', 'tail', 'trace', '运维', '排查'],
  /* 日志流是长连接，切走时必须保活，否则回来连接就断了 */
  keepAlive: true,
  badge: () => {
    const n = runningSessionCount();
    return n > 0 ? n : null;
  },
  badgeSubscribe: (onChange) => useLogSightStore.subscribe(onChange),
  component: LogSightModule,
};

export default logsightModule;
