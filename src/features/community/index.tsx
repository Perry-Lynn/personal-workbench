/*
 * Trae 社区模块入口
 * ------------------------------------------------------------------
 * 只做代码分割。模块没有 keepAlive：切走即卸载，避免窗口级快捷键在隐藏
 * 状态下继续劫持 ⌘K；数据状态放在 store 里，回来时不会丢搜索/当前帖子。
 * @Author: fu
 */
import { lazy } from 'react';
import { CommentOutlined } from '@ant-design/icons';
import type { WorkbenchModule } from '@/core/types';

const CommunityView = lazy(() => import('./CommunityView'));

export const communityModule: WorkbenchModule = {
  id: 'community',
  name: 'Trae 社区',
  description: '官方社区的最新讨论、置顶公告、主题阅读与用户资料',
  icon: <CommentOutlined />,
  group: '效率',
  order: 40,
  keywords: [
    '社区',
    '论坛',
    'trae',
    'forum',
    '帖子',
    '讨论',
    '话题',
    '公告',
    '提问',
    '教程',
    'discourse',
  ],
  component: CommunityView,
};

export default communityModule;
