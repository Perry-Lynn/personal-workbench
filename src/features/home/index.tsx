/*
 * 首页模块入口
 * 工作台默认落地页，列出所有可用模块入口。
 * @Author: fu
 */
import { lazy } from 'react';
import { HomeOutlined } from '@ant-design/icons';
import type { WorkbenchModule } from '@/core/types';

const HomeView = lazy(() => import('./HomeView'));

export const homeModule: WorkbenchModule = {
  id: 'home',
  name: '工作台首页',
  description: '所有功能模块的入口总览，显示最近使用与模块分组',
  icon: <HomeOutlined />,
  group: '总览',
  order: 0,
  keywords: ['首页', 'home', '总览', '入口', 'dashboard'],
  /* 首页是纯展示页，切走就卸载，不需要保活 */
  component: HomeView,
};

export default homeModule;
