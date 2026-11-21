/*
 * Maven 助手模块入口
 * ------------------------------------------------------------------
 * 两块能力都不需要常驻：进模块时才探测 mvn、扫仓库，
 * 依赖树更是用户点「分析」才跑（一次几十秒）。
 * 所以这里**不启动任何服务**，只做代码分割。
 * @Author: fu
 */
import { lazy } from 'react';
import { DeploymentUnitOutlined } from '@ant-design/icons';
import type { WorkbenchModule } from '@/core/types';

const MavenView = lazy(() => import('./MavenView'));

export const mavenModule: WorkbenchModule = {
  id: 'maven',
  name: 'Maven 助手',
  description: '本地仓库体积与重复版本分析，以及单个项目的依赖树与版本冲突',
  icon: <DeploymentUnitOutlined />,
  group: '效率',
  order: 30,
  keywords: [
    'maven',
    'mvn',
    '依赖',
    'dependency',
    '冲突',
    'conflict',
    '仲裁',
    '仓库',
    '.m2',
    'repository',
    'snapshot',
    '体积',
    '清理',
  ],
  component: MavenView,
};

export default mavenModule;
