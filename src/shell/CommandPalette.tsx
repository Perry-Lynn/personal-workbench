/*
 * 全局命令面板（⌘K / Ctrl+K）
 * ------------------------------------------------------------------
 * 为什么要有它：工作台已经有十来个模块 + 一个片段库，
 * 找东西全靠侧栏一层层点。命令面板把它们收成**一个输入框**：
 *   · 模块 → 回车直达
 *   · 片段 → 回车复制（这才是片段的常用动作，不是「打开片段库」）
 *
 * 三条设计约束：
 *   1. **不引新依赖、不进 AntD Modal**。Modal 会连带动画与 motion 一起进主包，
 *      而这个面板只有「一个输入框 + 一列结果」，自己写更小也更可控。
 *   2. **跨模块只走 public 门面**：片段来自 features/snippets/public.ts，
 *      不 import 它的 store / 组件（模块之间不许互相依赖）。
 *   3. **空查询也要有内容**：最近用过的模块排前面，否则打开面板是一片空白，
 *      用户还得先想关键词。
 *
 * 键盘：↑↓ 选择 · ↵ 打开/复制 · esc 关闭 · ⌘K 再次打开
 * @Author: fu
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { App as AntApp } from 'antd';
import { CodeOutlined } from '@ant-design/icons';
import { searchModules } from '@/core/registry';
import { useModules } from '@/core/useModules';
import type { WorkbenchModule } from '@/core/types';
import { useWorkbenchStore } from '@/store/useWorkbenchStore';
import {
  copySnippet,
  ensureSnippetsLoaded,
  matchesQuery,
  useSnippetItems,
  type Snippet,
} from '@/features/snippets/public';

import './command-palette.css';

/*
 * 顶栏那个「搜索」按钮也用它唤起。
 * 走自定义事件而不是把 open 状态提到 AppShell：面板的开关只归它自己管，
 * 顶栏不必知道面板在哪、也不需要多一层 props 或 store 字段。
 */
const OPEN_PALETTE_EVENT = 'workbench:open-palette';

/** 从任意地方唤起命令面板（目前只有顶栏按钮用） */
export function openCommandPalette(): void {
  window.dispatchEvent(new Event(OPEN_PALETTE_EVENT));
}

/* 结果上限：面板不高，宁可少列几条也别让它变成一屏滚动的列表 */
const MAX_RECENT = 5;
const MAX_MODULES = 8;
const MAX_SNIPPETS = 6;

interface PaletteItem {
  key: string;
  kind: 'module' | 'snippet';
  /** 分组标题：最近使用 / 模块 / 片段 */
  section: string;
  title: string;
  /** 右侧弱化信息：模块是「分组 · 描述」，片段是「语言 · 标签」 */
  meta: string;
  /** 片段正文首行，模块没有 */
  preview?: string;
  icon?: React.ReactNode;
  run: () => void | Promise<void>;
}

/** 片段正文首行：命令面板里只给一眼上下文，不要多行预览 */
function firstLine(body: string): string {
  const line = body.split('\n').find((l) => l.trim().length > 0) ?? '';
  return line.trim().slice(0, 120);
}

const CommandPalette: React.FC = () => {
  const { message } = AntApp.useApp();
  const allModules = useModules();
  const modulePrefs = useWorkbenchStore((s) => s.modulePrefs);
  const recentIds = useWorkbenchStore((s) => s.recentModuleIds);
  const setActiveModule = useWorkbenchStore((s) => s.setActiveModule);
  const snippets = useSnippetItems();

  const [open, setOpen] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  /*
   * 与侧栏同一层过滤：模块自己声明「不适合放导航」的（hiddenInSidebar）、
   * 以及用户在设置里关掉的（modulePrefs.hidden），都不出现在面板里 ——
   * 否则用户刚关掉的模块会从命令面板里冒出来，等于没关。
   */
  const visibleModules = useMemo(
    () => allModules.filter((m) => !m.hiddenInSidebar && !modulePrefs[m.id]?.hidden),
    [allModules, modulePrefs],
  );

  const items = useMemo<PaletteItem[]>(() => {
    const out: PaletteItem[] = [];
    const q = keyword.trim();

    const modItem = (m: WorkbenchModule, section: string): PaletteItem => ({
      key: `m:${m.id}`,
      kind: 'module',
      section,
      title: m.name,
      meta: [m.group, m.description].filter(Boolean).join(' · '),
      icon: m.icon,
      run: () => setActiveModule(m.id),
    });

    const snipItem = (s: Snippet): PaletteItem => ({
      key: `s:${s.id}`,
      kind: 'snippet',
      section: '片段',
      title: s.title,
      meta: [s.lang, ...s.tags.slice(0, 2)].filter(Boolean).join(' · '),
      preview: firstLine(s.body),
      icon: <CodeOutlined />,
      run: async () => {
        await copySnippet(s);
        message.success(`已复制「${s.title}」`);
      },
    });

    /* 片段排序：置顶优先，其次按最近使用 —— 空查询时这就是「常用片段」 */
    const rankedSnippets = [...snippets].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return (b.usedAt ?? 0) - (a.usedAt ?? 0);
    });

    if (!q) {
      const recent = recentIds
        .map((id) => visibleModules.find((m) => m.id === id))
        .filter((m): m is WorkbenchModule => Boolean(m))
        .slice(0, MAX_RECENT);
      const recentSet = new Set(recent.map((m) => m.id));
      recent.forEach((m) => out.push(modItem(m, '最近使用')));
      visibleModules
        .filter((m) => !recentSet.has(m.id))
        .slice(0, MAX_MODULES)
        .forEach((m) => out.push(modItem(m, '模块')));
      rankedSnippets.slice(0, MAX_SNIPPETS).forEach((s) => out.push(snipItem(s)));
      return out;
    }

    searchModules(q, visibleModules)
      .slice(0, MAX_MODULES)
      .forEach((m) => out.push(modItem(m, '模块')));
    rankedSnippets
      .filter((s) => matchesQuery(s, q))
      .slice(0, MAX_SNIPPETS)
      .forEach((s) => out.push(snipItem(s)));
    return out;
  }, [keyword, visibleModules, recentIds, snippets, setActiveModule, message]);

  /* 结果变了（输入 / 片段异步到位）就把选中项收进有效范围 */
  const safeActive = Math.min(active, Math.max(0, items.length - 1));

  useEffect(() => {
    setActive(0);
  }, [keyword]);

  /* 全局快捷键：⌘K / Ctrl+K 开关。用 window 捕获，任何模块里都生效 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setKeyword('');
        setActive(0);
        setOpen((v) => !v);
      }
    };
    const onOpen = () => {
      setKeyword('');
      setActive(0);
      setOpen(true);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener(OPEN_PALETTE_EVENT, onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(OPEN_PALETTE_EVENT, onOpen);
    };
  }, []);

  /* 打开时聚焦输入框，并顺手拉一次片段（幂等；片段库没打开过也搜得到） */
  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    void ensureSnippetsLoaded();
    return () => cancelAnimationFrame(raf);
  }, [open]);

  /* 键盘移动时把选中项滚进视野（鼠标悬停时它本来就在视野里，是空操作） */
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>('.cmdk-item.is-active');
    el?.scrollIntoView({ block: 'nearest' });
  }, [open, safeActive, items.length]);

  const close = useCallback(() => setOpen(false), []);

  const runItem = useCallback(
    async (it: PaletteItem | undefined) => {
      if (!it) return;
      /* 先关面板再执行：否则「打开模块」之后面板还盖在上面 */
      setOpen(false);
      try {
        await it.run();
      } catch (e) {
        message.error(e instanceof Error ? e.message : '执行失败');
      }
    },
    [message],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    /* Tab 会把焦点甩到面板外，这里直接吞掉（面板只有一个输入框） */
    if (e.key === 'Tab') {
      e.preventDefault();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, Math.max(0, items.length - 1)));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      void runItem(items[safeActive]);
    }
  };

  if (!open) return null;

  const activeItem = items[safeActive];

  return (
    <div
      className="cmdk-scrim"
      /* 点空白处关闭；点在面板内部不关（用 target === currentTarget 判断） */
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="cmdk-panel" role="dialog" aria-modal="true" aria-label="命令面板">
        <div className="cmdk-input-row">
          <input
            ref={inputRef}
            className="cmdk-input"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="搜索模块、片段…"
            spellCheck={false}
            autoComplete="off"
            aria-label="搜索模块或片段"
          />
          <kbd className="cmdk-kbd">esc</kbd>
        </div>

        <div className="cmdk-list" ref={listRef}>
          {items.length === 0 ? (
            <div className="cmdk-empty">没有匹配的模块或片段</div>
          ) : (
            items.map((it, i) => (
              <React.Fragment key={it.key}>
                {(i === 0 || items[i - 1].section !== it.section) && (
                  <div className="cmdk-section">{it.section}</div>
                )}
                <button
                  type="button"
                  className={`cmdk-item${i === safeActive ? ' is-active' : ''}`}
                  onPointerEnter={() => setActive(i)}
                  onClick={() => void runItem(it)}
                >
                  <span className="cmdk-item-icon">{it.icon}</span>
                  <span className="cmdk-item-main">
                    <span className="cmdk-item-title">{it.title}</span>
                    {it.preview && <span className="cmdk-item-preview">{it.preview}</span>}
                  </span>
                  <span className="cmdk-item-meta">{it.meta}</span>
                </button>
              </React.Fragment>
            ))
          )}
        </div>

        <div className="cmdk-foot">
          <span>
            <kbd className="cmdk-kbd">↑</kbd>
            <kbd className="cmdk-kbd">↓</kbd> 选择
          </span>
          <span>
            <kbd className="cmdk-kbd">↵</kbd>
            {activeItem?.kind === 'snippet' ? '复制' : '打开'}
          </span>
          <span className="cmdk-foot-hint">
            <kbd className="cmdk-kbd">⌘K</kbd> 随时唤起
          </span>
        </div>
      </div>
    </div>
  );
};

export default CommandPalette;
