/*
 * AI-Passport 蓝牙模块入口
 * ------------------------------------------------------------------
 * 把「蓝牙连接 AI-Passport」暴露成工作台标准模块，自动出现在侧栏与首页。
 * 主体组件用 React.lazy 做代码分割，只有进入模块时才加载。
 * @Author: fu
 */
import { lazy } from 'react';
import { ApiOutlined } from '@ant-design/icons';
import type { WorkbenchModule } from '@/core/types';

const AiPassportView = lazy(() => import('./AiPassportView'));

export const aipassportModule: WorkbenchModule = {
  id: 'aipassport',
  name: 'AI Passport',
  description: '蓝牙连接 AI-Passport 徽章，推送通知 / 提醒 / 日程，或清空设备列表',
  icon: <ApiOutlined />,
  group: '设备',
  order: 10,
  keywords: ['蓝牙', 'bluetooth', 'ble', 'ai-passport', '徽章', '通知', '提醒', '日程'],
  /* 蓝牙是长连接，切走时保活，否则回来连接就断了 */
  keepAlive: true,
  component: AiPassportView,
};

export default aipassportModule;
