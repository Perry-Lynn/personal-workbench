import { lazy } from 'react';
import { AppstoreOutlined } from '@ant-design/icons';
import type { WorkbenchModule } from '@/core/types';

const ProjectsView = lazy(() => import('./ProjectsView'));

const projectsModule: WorkbenchModule = {
  id: 'projects', name: '项目工作区', description: '集中管理项目仓库、运行配置、服务器与资料入口',
  icon: <AppstoreOutlined />, group: '效率', order: 110, keywords: ['项目', '工作区', 'project'], component: ProjectsView,
};
export default projectsModule;
