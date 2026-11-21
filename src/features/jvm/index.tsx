/*
 * JVM 进程看板模块入口
 * ------------------------------------------------------------------
 * 主体组件用 React.lazy 做代码分割，进入模块时才加载。
 *
 * 常驻服务在 import 时启动（见 service.ts 顶部说明）：
 * 侧栏角标上的进程数、以及「堆快满了推徽章」都不该等用户点开模块才开始工作。
 * @Author: fu
 */
import { lazy } from 'react';
import { CoffeeOutlined } from '@ant-design/icons';
import type { WorkbenchModule } from '@/core/types';
import { jvmBadge, startJvmService, subscribeJvmBadge } from './service';

const JvmModuleView = lazy(() => import('./JvmModuleView'));

startJvmService();

export const jvmModule: WorkbenchModule = {
  id: 'jvm',
  name: 'JVM 与 Spring',
  description:
    '本机 Java 进程看板：端口、CPU 与堆占用、线程栈 / 堆转储 / 结束进程；Spring 标签页里是服务健康、profile 与 actuator 入口',
  icon: <CoffeeOutlined />,
  group: '运维',
  order: 20,
  keywords: [
    'java',
    'jvm',
    'jps',
    'jstack',
    'jmap',
    '端口',
    'port',
    '8080',
    '进程',
    '线程栈',
    'thread dump',
    '堆',
    'heap',
    '内存',
    'cpu',
    /* 原 spring 模块的关键词并进来：命令面板里搜「actuator」也要能找到这里 */
    'spring',
    'springboot',
    'boot',
    'actuator',
    '健康',
    'health',
    'profile',
    '微服务',
  ],
  /*
   * 常驻：面板里有线程栈弹窗、端口查询结果这类状态，
   * 切走再回来不该被清空（刷新是秒级的，列表本身反而无所谓）。
   */
  keepAlive: true,
  /** 侧栏角标：运行中的 Java 进程数，色调按最紧张的那个进程 */
  badge: () => jvmBadge(),
  badgeSubscribe: (onChange) => subscribeJvmBadge(onChange),
  component: JvmModuleView,
};

export default jvmModule;
