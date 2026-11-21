/*
 * 工作台外壳
 * ------------------------------------------------------------------
 * 布局：[顶部栏] + [侧栏模块导航 | 模块挂载区]
 * 外壳只负责「容器 + 导航 + 主题」，不含任何具体功能逻辑。
 * 新增功能模块 = 写一个 WorkbenchModule + 在 core/modules.ts 注册，外壳不用改。
 * @Author: fu
 */
import React from 'react';
import SidebarNav from './SidebarNav';
import TopBar from './TopBar';
import ModuleHost from './ModuleHost';
import CommandPalette from './CommandPalette';
import { useWorkbenchStore } from '@/store/useWorkbenchStore';

const AppShell: React.FC = () => {
  const activeModuleId = useWorkbenchStore((s) => s.activeModuleId);
  const siderCollapsed = useWorkbenchStore((s) => s.siderCollapsed);
  const siderWidth = useWorkbenchStore((s) => s.siderWidth);

  return (
    <div
      className="h-screen w-screen overflow-hidden flex flex-col"
      /* 外壳底色透明，好让原生磨砂玻璃透上来（内容区自己在 <main> 里铺不透明底） */
      style={{ backgroundColor: 'transparent', color: 'var(--wb-text-primary)' }}
    >
      <TopBar />

      <div className="flex-1 min-h-0 w-full flex overflow-hidden">
        {/* 侧栏：用 wrapper 控制宽度，CSS transition 实现平滑收起 */}
        <div
          className="shrink-0 h-full overflow-hidden"
          style={{
            width: siderCollapsed ? 0 : siderWidth,
            transition: 'width 0.2s cubic-bezier(.2,.8,.2,1)',
            backgroundColor: 'var(--wb-glass-chrome)',
            borderRight: siderCollapsed ? 'none' : '1px solid var(--wb-border-l1)',
          }}
        >
          {/* 内层固定宽度，避免收起过程中内容被挤压换行 */}
          <div className="h-full" style={{ width: siderWidth }}>
            <SidebarNav />
          </div>
        </div>

        {/* 模块区 */}
        <main
          className="flex-1 min-w-0 h-full overflow-hidden"
          /* 内容区保持不透明：正文不该压在模糊背景上 */
          style={{ backgroundColor: 'var(--wb-bg-base)' }}
        >
          <ModuleHost activeModuleId={activeModuleId} />
        </main>
      </div>

      {/* 全局命令面板：固定定位的浮层，不占布局；⌘K 或顶栏按钮唤起 */}
      <CommandPalette />
    </div>
  );
};

export default AppShell;
