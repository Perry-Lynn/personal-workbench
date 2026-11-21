/*
 * 侧栏模块导航
 * ------------------------------------------------------------------
 * 按分组列出所有模块，支持搜索、角标、当前项高亮、拖拽调宽。
 * 数据来源只有 registry，新增模块不需要改本文件。
 * @Author: fu
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Input, Tooltip } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { groupModules, searchModules } from '@/core/registry';
import { useModules } from '@/core/useModules';
import { MODULE_GROUP_ORDER } from '@/core/types';
import type { BadgeTone, ModuleBadge, WorkbenchModule } from '@/core/types';
import {
  SIDER_MAX_WIDTH,
  SIDER_MIN_WIDTH,
  useWorkbenchStore,
} from '@/store/useWorkbenchStore';
import { onTitlebarMouseDown } from './titlebarDrag';

interface SidebarNavProps {
  onNavigate?: () => void;
}

const SidebarNav: React.FC<SidebarNavProps> = ({ onNavigate }) => {
  const allModules = useModules();
  const activeModuleId = useWorkbenchStore((s) => s.activeModuleId);
  const setActiveModule = useWorkbenchStore((s) => s.setActiveModule);
  const siderWidth = useWorkbenchStore((s) => s.siderWidth);
  const setSiderWidth = useWorkbenchStore((s) => s.setSiderWidth);
  const modulePrefs = useWorkbenchStore((s) => s.modulePrefs);

  const [keyword, setKeyword] = useState('');
  const [dragging, setDragging] = useState(false);
  const dragStartXRef = useRef(0);
  const dragStartWidthRef = useRef(0);

  /* 应用「模块管理」里的隐藏偏好，再叠加搜索过滤 */
  const visibleModules = useMemo(
    () =>
      allModules.filter((m) => {
        /* 用户偏好 hidden 是「整个收起来」，首页与侧栏都不显示 */
        const userHidden = modulePrefs[m.id]?.hidden;
        return !m.hiddenInSidebar && !userHidden;
      }),
    [allModules, modulePrefs],
  );

  const filtered = useMemo(
    () => searchModules(keyword, visibleModules),
    [keyword, visibleModules],
  );

  const groups = useMemo(() => groupModules(filtered), [filtered]);

  /* 模块数超过 8 个才显示搜索框，避免模块少时界面啰嗦 */
  const showSearch = visibleModules.length > 8;

  /* ===== 拖拽调宽 ===== */
  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragStartXRef.current = e.clientX;
      dragStartWidthRef.current = siderWidth;
      setDragging(true);
    },
    [siderWidth],
  );

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const delta = e.clientX - dragStartXRef.current;
      setSiderWidth(dragStartWidthRef.current + delta);
    };
    const onUp = () => setDragging(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    /* 拖拽期间禁止选中文字，避免整页被选蓝 */
    const prevSelect = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = prevSelect;
    };
  }, [dragging, setSiderWidth]);

  const handleClick = useCallback(
    (m: WorkbenchModule) => {
      setActiveModule(m.id);
      onNavigate?.();
    },
    [setActiveModule, onNavigate],
  );

  return (
    <div className="relative h-full flex flex-col" style={{ width: siderWidth }}>
      {/* ===== 顶部：品牌 ===== */}
      {/* 这一块和顶栏连成一条完整的拖动带（见 titlebarDrag.ts） */}
      <div
        className="mac-titlebar-drag flex items-center gap-2.5 px-3 h-12 flex-shrink-0"
        onMouseDown={onTitlebarMouseDown}
      >
        <div
          className="w-7 h-7 rounded-lg flex items-center justify-center text-white font-bold flex-shrink-0"
          style={{ background: 'linear-gradient(135deg, #064E3B 0%, #047857 50%, #34D399 100%)',
            boxShadow: 'var(--wb-shadow-btn)', fontSize: 'calc(var(--wb-font-base) - 3px)' }}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3" y="3" width="7.5" height="7.5" rx="2" />
            <rect x="13.5" y="3" width="7.5" height="7.5" rx="2" />
            <rect x="3" y="13.5" width="7.5" height="7.5" rx="2" />
            <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2" />
          </svg>
        </div>
        <div className="min-w-0">
          <div
            className=" font-semibold leading-tight truncate"
            style={{ color: 'var(--wb-text-primary)', fontSize: 'calc(var(--wb-font-base) - 1px)' }}
          >
            个人工作台
          </div>
          <div className=" leading-tight" style={{ color: 'var(--wb-text-tertiary)', fontSize: 'calc(var(--wb-font-base) - 5px)' }}>
            {/* 数「当前启用的」而不是注册总数：用户隐藏模块后这里跟着少，
                否则会跟侧栏里实际列出的条数对不上 */}
            {visibleModules.length} 个模块
          </div>
        </div>
      </div>

      {/* ===== 搜索 ===== */}
      {showSearch && (
        <div className="mac-titlebar-nd px-3 pb-2 flex-shrink-0">
          <Input
            size="small"
            allowClear
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索模块"
            prefix={<SearchOutlined style={{ color: 'var(--wb-text-tertiary)', fontSize: 12 }} />}
            className="rounded-lg"
          />
        </div>
      )}

      {/* ===== 模块列表 ===== */}
      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-3">
        {groups.length === 0 && (
          <div
            className=" text-center py-6"
            style={{ color: 'var(--wb-text-tertiary)', fontSize: 'calc(var(--wb-font-base) - 3px)' }}
          >
            没有匹配的模块
          </div>
        )}

        {groups.map(({ group, modules }) => (
          <div key={group} className="mb-2">
            {/* 分组标题：搜索时也保留，便于定位 */}
            <div
              className="px-2 pt-3 pb-1 font-medium tracking-wider select-none"
              style={{ color: 'var(--wb-text-tertiary)', fontSize: 'calc(var(--wb-font-base) - 4.5px)' }}
            >
              {group}
            </div>
            {modules.map((m) => (
              <ModuleNavItem
                key={m.id}
                module={m}
                active={m.id === activeModuleId}
                onClick={() => handleClick(m)}
              />
            ))}
          </div>
        ))}

        {/* 搜索无结果时提示可用的分组名，避免用户以为模块丢了 */}
        {keyword && groups.length > 0 && (
          <div className="px-2 pt-1" style={{ color: 'var(--wb-text-tertiary)', fontSize: 'calc(var(--wb-font-base) - 4.5px)' }}>
            共 {filtered.length} 个结果
          </div>
        )}
      </div>

      {/* ===== 底部分组提示（模块多时提示分组维度） ===== */}
      <div
        className="flex-shrink-0 px-3 py-2 border-t"
        style={{ borderColor: 'var(--wb-border-l1)', color: 'var(--wb-text-tertiary)', fontSize: 'calc(var(--wb-font-base) - 5px)' }}
      >
        {MODULE_GROUP_ORDER.filter((g) => groups.some((x) => x.group === g)).join(' · ')}
      </div>

      {/* ===== 右侧拖拽调宽手柄 ===== */}
      <div
        role="separator"
        aria-orientation="vertical"
        onMouseDown={handleResizeStart}
        className="absolute top-0 bottom-0 right-0 w-[5px] cursor-col-resize z-10 transition-colors"
        style={{
          backgroundColor: dragging ? 'var(--wb-border-brand)' : 'transparent',
        }}
        title="拖拽调整侧栏宽度"
      />
      {/* 宽度提示：拖拽时浮出当前像素值 */}
      {dragging && (
        <div
          className="absolute top-14 right-2 z-20 px-2 py-0.5 rounded pointer-events-none"
          style={{ backgroundColor: 'var(--wb-bg-elevated)',
            color: 'var(--wb-text-secondary)',
            border: '1px solid var(--wb-border-l2)', fontSize: 'calc(var(--wb-font-base) - 5px)' }}
        >
          {siderWidth}px
        </div>
      )}
      {/* 拖拽范围提示（隐藏，仅给无障碍读屏） */}
      <span className="sr-only">
        侧栏宽度范围 {SIDER_MIN_WIDTH} 到 {SIDER_MAX_WIDTH} 像素
      </span>
    </div>
  );
};

/* =============================================
   ====== 单个模块导航项 ======
   ============================================= */
interface ModuleNavItemProps {
  module: WorkbenchModule;
  active: boolean;
  onClick: () => void;
}

/**
 * 把模块返回的角标归一成 ModuleBadge。
 * 返回原始值（string/number）的模块一律当作 tone:'info' —— 老模块行为完全不变。
 */
function normalizeBadge(raw: string | number | ModuleBadge | null | undefined): ModuleBadge | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'object') {
    /* 空文案视为「不显示」，模块可以借此表达「暂时没有可显示的值」 */
    if (raw.text === null || raw.text === undefined || raw.text === '') return null;
    return { text: raw.text, tone: raw.tone ?? 'info' };
  }
  return { text: raw, tone: 'info' };
}

/**
 * 角标配色。
 *
 * info 沿用原来的「淡底 + 品牌色文字」；warn / danger 用状态色**填充** ——
 * 10px 的小角标上，「淡底 + 状态色文字」的差别几乎看不出来，等于没传达。
 *
 * 填充之所以能一个反色令牌覆盖两种主题：状态色在深色主题里是亮色（#FBBF24/#F87171）、
 * 在浅色主题里是暗色（#B45309/#DC2626），而 --wb-text-inverse 在深色主题里是深色
 * （#06281D）、浅色主题里是白色（#FFFFFF）—— 天然配对，不需要按主题分支。
 * （warning 从 #D97706 压到 #B45309，白字对比度随之从 3.2:1 升到 4.7:1）
 */
function badgeStyle(tone: BadgeTone): React.CSSProperties {
  switch (tone) {
    case 'danger':
      return { backgroundColor: 'var(--wb-error)', color: 'var(--wb-text-inverse)' };
    case 'warn':
      return { backgroundColor: 'var(--wb-warning)', color: 'var(--wb-text-inverse)' };
    default:
      return { backgroundColor: 'var(--wb-bg-active)', color: 'var(--wb-text-brand)' };
  }
}

/**
 * 读取模块角标，并在模块声明的数据源变化时刷新。
 * 模块没提供 badgeSubscribe 时退化为「随侧栏重渲染更新」。
 */
function useModuleBadge(m: WorkbenchModule): ModuleBadge | null {
  const [, force] = useState(0);

  useEffect(() => {
    if (!m.badgeSubscribe) return;
    try {
      return m.badgeSubscribe(() => force((n) => n + 1));
    } catch (e) {
      console.warn(`[workbench] 模块 ${m.id} 的 badgeSubscribe 异常`, e);
      return;
    }
  }, [m]);

  if (!m.badge) return null;
  try {
    return normalizeBadge(m.badge());
  } catch (_) {
    return null;
  }
}

const ModuleNavItem: React.FC<ModuleNavItemProps> = ({ module, active, onClick }) => {
  const badge = useModuleBadge(module);

  return (
    <Tooltip title={module.description} placement="right" mouseEnterDelay={0.6}>
      <button
        type="button"
        onClick={onClick}
        className="relative w-full flex items-center gap-2.5 px-2.5 py-[7px] rounded-lg text-left transition-colors"
        style={{
          backgroundColor: active ? 'var(--wb-bg-selected)' : 'transparent',
          color: active ? 'var(--wb-text-brand)' : 'var(--wb-text-secondary)',
        }}
        onMouseEnter={(e) => {
          if (!active) e.currentTarget.style.backgroundColor = 'var(--wb-bg-hover)';
        }}
        onMouseLeave={(e) => {
          if (!active) e.currentTarget.style.backgroundColor = 'transparent';
        }}
      >
        {/* 激活态左侧强调条 */}
        {active && (
          <span
            className="absolute left-0 top-1/2 -translate-y-1/2 w-[2.5px] h-[16px] rounded-full"
            style={{ backgroundColor: 'var(--wb-brand)' }}
          />
        )}
        <span className=" flex-shrink-0 leading-none" style={{ fontSize: 'calc(var(--wb-font-base) - 1px)' }}>{module.icon}</span>
        <span className="flex-1 min-w-0 truncate" style={{ fontSize: 'calc(var(--wb-font-base) - 2.5px)' }}>{module.name}</span>
        {badge !== null && (
          <span
            className="flex-shrink-0 px-1.5 rounded-full leading-[16px] font-medium"
            style={{ ...badgeStyle(badge.tone ?? 'info'), fontSize: 'calc(var(--wb-font-base) - 5px)' }}>
            {badge.text}
          </span>
        )}
      </button>
    </Tooltip>
  );
};

export default SidebarNav;
