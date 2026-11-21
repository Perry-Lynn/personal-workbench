/*
 * 片段库模块入口
 * ------------------------------------------------------------------
 * 不需要常驻服务、不需要 keepAlive：
 *   - 没有后台副作用（不订阅蓝牙、不跑定时器、不连远端）
 *   - 列表是本机 sled 里的几十条记录，重进模块时 store 里已有数据，
 *     连 IPC 都不会发（见 store.load 的 loaded 判定）
 * 所以这里只做代码分割。
 * @Author: fu
 */
import { lazy } from 'react';
import { SnippetsOutlined } from '@ant-design/icons';
import type { WorkbenchModule } from '@/core/types';

const SnippetsView = lazy(() => import('./SnippetsView'));

export const snippetsModule: WorkbenchModule = {
  id: 'snippets',
  name: '片段库',
  description: '本地可复用的命令与代码片段：标签分类、搜索、一键复制',
  icon: <SnippetsOutlined />,
  group: '效率',
  order: 35,
  keywords: [
    '片段',
    'snippet',
    'snippets',
    '代码',
    '命令',
    '常用',
    '模板',
    '收藏',
    '剪贴板',
    'clipboard',
    '备忘',
    '速查',
  ],
  component: SnippetsView,
};

export default snippetsModule;
