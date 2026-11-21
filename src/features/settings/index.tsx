/*
 * 设置模块入口
 * 工作台级别偏好设置。
 * @Author: fu
 */
import { lazy } from 'react';
import { SettingOutlined } from '@ant-design/icons';
import type { WorkbenchModule } from '@/core/types';

const SettingsView = lazy(() => import('./SettingsView'));

export const settingsModule: WorkbenchModule = {
  id: 'settings',
  name: '设置',
  description: '主题外观、侧栏行为、模块显示管理、本地数据与版本信息',
  icon: <SettingOutlined />,
  group: '系统',
  order: 900,
  keywords: ['设置', 'settings', '偏好', '主题', '外观', '模块管理'],
  component: SettingsView,
};

export default settingsModule;
