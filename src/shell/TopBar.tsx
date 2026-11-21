/*
 * 工作台顶部栏
 * ------------------------------------------------------------------
 * 左侧：侧栏折叠按钮 + 当前位置（工作台 / 模块名）
 * 右侧：主题切换 + 设置入口
 * 模块自己的操作按钮不放这里（模块在自己内部渲染工具栏），
 * 这样新增模块不用改工作台外壳。
 * @Author: fu
 */
import React from 'react';
import { Button, Tag, Tooltip } from 'antd';
import {
  MenuFoldOutlined,
  MoonOutlined,
  SearchOutlined,
  SettingOutlined,
  SunOutlined,
} from '@ant-design/icons';
import { getModule } from '@/core/registry';
import { useWorkbenchStore } from '@/store/useWorkbenchStore';
import { openCommandPalette } from './CommandPalette';
import { onTitlebarMouseDown } from './titlebarDrag';

const TopBar: React.FC = () => {
  const theme = useWorkbenchStore((s) => s.theme);
  const toggleTheme = useWorkbenchStore((s) => s.toggleTheme);
  const siderCollapsed = useWorkbenchStore((s) => s.siderCollapsed);
  const toggleSider = useWorkbenchStore((s) => s.toggleSider);
  const activeModuleId = useWorkbenchStore((s) => s.activeModuleId);
  const setActiveModule = useWorkbenchStore((s) => s.setActiveModule);

  const active = getModule(activeModuleId);

  return (
    <header
      className="mac-titlebar-drag flex items-center gap-2 px-3 h-12 flex-shrink-0 border-b"
      /*
       * 拖动交给 onTitlebarMouseDown（见 titlebarDrag.ts）。
       * 不能靠 CSS：`-webkit-app-region` 是 Electron 的，WKWebView 不认。
       */
      onMouseDown={onTitlebarMouseDown}
      style={{
        backgroundColor: 'var(--wb-glass-chrome)',
        borderColor: 'var(--wb-border-l1)',
        /*
         * Overlay 标题栏下交通灯浮在窗口左上 ~78px 处，留出空间避免内容重叠。
         * 用 CSS 变量 `--wb-traffic-light-w` 集中管理，非 macOS 平台为 0 不影响布局。
         */
        paddingLeft: 'max(0.75rem, var(--wb-traffic-light-w, 0px))',
      }}
    >
      {/* 侧栏折叠 */}
      <Tooltip title={siderCollapsed ? '展开侧栏' : '收起侧栏'}>
        <Button
          size="small"
          onClick={toggleSider}
          className="mac-titlebar-nd rounded-lg sider-toggle-btn"
          icon={
            <span
              className="sider-toggle-icon"
              style={{ transform: siderCollapsed ? 'rotate(180deg)' : 'rotate(0deg)' }}
            >
              <MenuFoldOutlined />
            </span>
          }
        />
      </Tooltip>

      {/* 当前位置 */}
      <div className="flex items-center gap-2 ml-1 min-w-0">
        <span className="" style={{ color: 'var(--wb-text-tertiary)', fontSize: 'calc(var(--wb-font-base) - 2.5px)' }}>
          工作台
        </span>
        <span style={{ color: 'var(--wb-text-quaternary, var(--wb-text-tertiary))' }}>/</span>
        <span
          className=" font-semibold truncate"
          style={{ color: 'var(--wb-text-primary)', fontSize: 'calc(var(--wb-font-base) - 1.5px)' }}
        >
          {active?.name ?? '未知模块'}
        </span>
        {active?.version && (
          <Tag
            color="processing"
            className=" !m-0 !py-0 !px-1.5 !h-4 flex items-center rounded-full" style={{ fontSize: 'calc(var(--wb-font-base) - 5px)' }}>
            v{active.version}
          </Tag>
        )}
      </div>

      <div className="flex-1" />

      {/* 主题切换 */}
      <div className="mac-titlebar-nd flex items-center gap-2">
        {/* 命令面板入口：⌘K 是给熟手的，这个按钮是给「不知道有 ⌘K」的人看的 */}
        <Tooltip title="搜索模块与片段（⌘K）">
          <Button
            size="small"
            className="flex items-center gap-1.5 rounded-lg"
            icon={<SearchOutlined />}
            onClick={openCommandPalette}
          >
            <span style={{ color: 'var(--wb-text-tertiary)', fontSize: 'calc(var(--wb-font-base) - 4px)' }}>
              ⌘K
            </span>
          </Button>
        </Tooltip>
        <Tooltip title={theme === 'dark' ? '切到浅色主题' : '切到深色主题'}>
          <Button
            type="default"
            size="small"
            onClick={toggleTheme}
            className="flex items-center gap-1.5 rounded-lg"
            icon={
              theme === 'dark' ? (
                <MoonOutlined style={{ color: 'var(--wb-brand-cyan)' }} />
              ) : (
                <SunOutlined style={{ color: '#F59E0B' }} />
              )
            }
          >
            <span className="" style={{ fontSize: 'calc(var(--wb-font-base) - 4px)' }}>{theme === 'dark' ? '深色' : '浅色'}</span>
          </Button>
        </Tooltip>

        <Tooltip title="工作台设置">
          <Button
            size="small"
            icon={<SettingOutlined />}
            className="rounded-lg"
            onClick={() => setActiveModule('settings')}
          />
        </Tooltip>
      </div>
    </header>
  );
};

export default TopBar;
