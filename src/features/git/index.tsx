/*
 * Git 管理模块入口
 * ------------------------------------------------------------------
 * 把轻量 Git 客户端暴露成工作台标准模块（IDEA 新 UI 风格）：
 * 仓库管理 / 修改列表 / 双栏 Diff / 提交 / 分支历史图 / 分支操作 / 拉取推送。
 *
 * 主体组件 React.lazy 按需加载；keepAlive 常驻 —— 切走再回来时
 * 选中的文件、diff、提交图滚动位置都还在（IDEA 的面板也是这个体验）。
 * @Author: fu
 */
import { lazy } from 'react';
import { BranchesOutlined } from '@ant-design/icons';
import { gitBadgeCount, useGitStore } from './store/useGitStore';
import { GIT_VERSION } from './version';
import type { WorkbenchModule } from '@/core/types';

const GitModule = lazy(() => import('./GitModule'));

export const gitModule: WorkbenchModule = {
  id: 'git',
  name: 'Git 管理',
  description: '轻量 Git 客户端：修改与双栏 Diff、提交、分支历史图、分支管理、拉取推送',
  icon: <BranchesOutlined />,
  group: '效率',
  order: 20,
  version: GIT_VERSION,
  keywords: ['git', '版本', '提交', 'commit', 'diff', '分支', 'branch', '推送', 'push', '拉取', 'pull', '历史'],
  /* 提交图 / diff / 都是重状态，切走保活免得回来全丢 */
  keepAlive: true,
  badge: () => {
    const n = gitBadgeCount();
    return n > 0 ? n : null;
  },
  badgeSubscribe: (onChange) => useGitStore.subscribe(onChange),
  /*
   * 切回模块时先刷一次（「去 IDE 改完再切回来」是最常见的场景，不该等下一轮轮询），
   * 同时把「在前台」告诉 store —— 定时轮询只在有人看着时跑（见 prefs.shouldPoll）。
   */
  onActivate: () => {
    const s = useGitStore.getState();
    s.setActive(true);
    void s.refresh();
  },
  onDeactivate: () => useGitStore.getState().setActive(false),
  component: GitModule,
};

export default gitModule;
