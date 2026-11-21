/*
 * JAR 运行器模块入口
 * ------------------------------------------------------------------
 * 主体组件用 React.lazy 做代码分割，进入模块时才加载。
 *
 * 常驻服务在 import 时启动（见 service.ts 顶部说明）：
 * 日志事件与「拖 jar 进窗口」都不能等用户先点开模块 ——
 * 一个跑着的服务在别的模块里时，日志也必须继续收，否则切回来只看到后半段。
 * @Author: fu
 */
import { lazy } from 'react';
import { RocketOutlined } from '@ant-design/icons';
import type { WorkbenchModule } from '@/core/types';
import { jarrunnerBadge, startJarRunnerService, subscribeJarRunnerBadge } from './service';

const JarRunnerView = lazy(() => import('./JarRunnerView'));

startJarRunnerService();

export const jarrunnerModule: WorkbenchModule = {
  id: 'jarrunner',
  name: 'JAR 运行器',
  description: '把 jar 拖进来就能跑：选 JDK、配 JVM 与程序参数，实时看 stdout / stderr',
  icon: <RocketOutlined />,
  group: '运维',
  /* 排在 JVM 进程看板之后：先看有没有在跑的，再决定要不要自己起一个 */
  order: 25,
  keywords: [
    'jar',
    'java',
    'spring',
    'boot',
    '运行',
    '启动',
    'run',
    '日志',
    'log',
    'console',
    'stdout',
    'stderr',
    'jvm 参数',
    'xmx',
  ],
  /*
   * 常驻：跑起来的进程与攒下的日志不该因为切走而丢。
   * 组件级 keepAlive 只管卸载，管不了「事件监听要一直在」——
   * 监听在常驻服务里（service.ts），两者缺一不可。
   */
  keepAlive: true,
  /** 侧栏角标：优先显示失败数，其次是在跑的数量 */
  badge: () => jarrunnerBadge(),
  badgeSubscribe: (onChange) => subscribeJarRunnerBadge(onChange),
  component: JarRunnerView,
};

export default jarrunnerModule;
