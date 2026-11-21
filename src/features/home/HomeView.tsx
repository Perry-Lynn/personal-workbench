/*
 * 首页模块
 * ------------------------------------------------------------------
 * 工作台的默认落地页。结构是「抬头 + 两栏主体 + 页脚」：
 *
 *   抬头 —— 日期 + 问候 + 搜索（纯文字排版，不带边框）
 *
 *   主体（≥1360px 两栏，窄窗口回到单列，见 home.css）：
 *     主栏  ① 「现在」面板 —— 四格实时状态，见 HomeStatusPanel.tsx
 *           ② 模块目录 —— 按分组排的**扁平列表**，一行一个模块
 *     右栏  ③ 世界时钟 —— 几个地区此刻几点，可增删，见 HomeClock.tsx
 *           ④ 最近动态 —— 跨模块时间线（谁做了什么），见 HomeActivityFeed.tsx
 *
 *   为什么右栏放这两块：它们回答的都是「此刻 / 刚才」，本来就是侧栏内容；
 *   而且**都只读本地状态**（内存快照 + localStorage），不需要为了填满横向空间
 *   去新增 IPC 数据源 —— 首页不触发 IPC、不碰主密钥这条约束不能破。
 *
 * 为什么目录是列表而不是卡片网格：
 *   13 个模块铺成卡片时，一张卡上同时有图标底块、版本标签、常驻标签、
 *   两个关键词药丸、hover 箭头、左侧竖条、泛光，四种颜色并存；13 张卡加起来
 *   是 26 个药丸和 11 个重复的「v0.1.0」。信息密度低、视觉噪声高。
 *   换成列表后一行只有「图标 / 名称 / 描述 / 实时状态」，靠行高与留白分隔，
 *   整页只剩「现在」面板一处带边框的容器。
 *
 * 这里额外承担两件事：
 *   1. 过滤：用户在「设置 · 模块管理」里关掉的模块（modulePrefs[].hidden）
 *      在首页也不出现，与侧栏用的是同一条判据（见 core/registry.ts 的说明）。
 *   2. 排序：行支持按住拖动，在**分组内**上下重排，结果存 store.moduleOrder。
 *
 * 视觉细节见同级 home.css。
 * @Author: fu
 */
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Input } from 'antd';
import { InboxOutlined, SearchOutlined } from '@ant-design/icons';
import { groupModules, searchModules } from '@/core/registry';
import { useModules } from '@/core/useModules';
import type { ModuleGroup, WorkbenchModule } from '@/core/types';
import { useWorkbenchStore } from '@/store/useWorkbenchStore';
import type { HomeLayout } from '@/store/useWorkbenchStore';
import { useGitStatus } from '@/features/git/public';
import { useJvmStatus } from '@/features/jvm/public';
import { useRunningSessionCount } from '@/features/logsight/public-status';
import HomeStatusPanel from './HomeStatusPanel';
import HomeClock from './HomeClock';
import HomeActivityFeed from './HomeActivityFeed';
import { applyOrder, mergeOrder, moveItem } from './order';

import './home.css';

/* 按当前时间给出问候语 */
function greeting(): string {
  const h = new Date().getHours();
  if (h < 6) return '夜深了';
  if (h < 11) return '早上好';
  if (h < 14) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
}

/* 中文日期，例如「9月17日 星期四」 */
const DATE_FMT = new Intl.DateTimeFormat('zh-CN', {
  month: 'long',
  day: 'numeric',
  weekday: 'long',
});

/* =============================================
   ====== 拖拽参数 ======
   ============================================= */
/** 拖拽超过这个像素才算「拖」而不是「点」，避免手抖把点击变成拖动 */
const DRAG_THRESHOLD_PX = 6;

/*
 * 重排动画参数。
 * 拖拽中的重排是「跟手」动作：新位置必须在下一帧就滑到位，所以时长压到 170ms；
 * 再长就会明显感觉元素在追手指。
 */
const FLIP_MS = 170;
const FLIP_EASE = 'cubic-bezier(.2,.8,.2,1)';
/** 松手后把跟随位移滑回槽位的时长 */
const SETTLE_MS = 160;

/*
 * 给自己播的位移动画打一个标记。
 *
 * 重排前必须取消上一轮还没跑完的动画 —— 否则 getBoundingClientRect() 量到的是
 * 「动画中途」的位置（transform 会算进 rect），delta 就偏了，行会来回抖；
 * 而且旧动画跑完后会把新位移顶掉，末尾再跳一下。
 * 但只能取消**自己的**动画：el.getAnimations() 里同时有 CSS 过渡（背景色、颜色），
 * 误伤它们会让高亮瞬间消失。所以靠 id 区分。
 */
const FLIP_ID = 'wb-flip';

interface DragSession {
  id: string;
  group: ModuleGroup;
  pointerId: number;
  startX: number;
  startY: number;
  /** 是否已越过阈值。没越过时松手 = 一次普通点击（打开模块） */
  moved: boolean;
  /** 按下时的顺序。松手后顺序没变就不用写库（避免「抖一下」也留下一条排序记录） */
  origin: string[];
  /** 该分组在拖拽过程中的临时顺序，松手时才落盘 */
  order: string[];
  /** 越过阈值那一刻被拖元素的视觉位置（此时还没有任何位移） */
  startLeft: number;
  startTop: number;
  /** 当前施加在元素上的跟随位移，用来反算「纯布局位置」 */
  tx: number;
  ty: number;
  /** 被拖元素本体，避免每帧去 map 里查 */
  el: HTMLButtonElement | null;
  /** 最近一次指针位置（用 rAF 合并后处理） */
  px: number;
  py: number;
  /** 已排队的 rAF 句柄，0 表示没有 */
  raf: number;
}

/* =============================================
   ====== 行内实时状态 ======
   ============================================= */
/**
 * 列表行右侧那句短状态。
 *
 * 只给「真的会变」的模块返回文案，其余返回空串 —— 一行上挂着「—」或「正常」
 * 只是噪声。口径与「现在」面板一致，改的时候两处要一起看。
 */
function useRowStatus(): Record<string, string> {
  const running = useRunningSessionCount();
  const git = useGitStatus();
  const jvm = useJvmStatus();

  return useMemo(() => {
    const out: Record<string, string> = {};

    if (running > 0) out.logsight = `${running} 个运行中`;
    if (git.hasRepo) out.git = git.changed > 0 ? `${git.changed} 处待提交` : '工作区干净';
    if (jvm.count > 0) out.jvm = `${jvm.count} 个进程`;

    return out;
  }, [running, git, jvm]);
}

/* =============================================
   ====== 首页 ======
   ============================================= */
const HomeModule: React.FC = () => {
  const allModules = useModules();
  const setActiveModule = useWorkbenchStore((s) => s.setActiveModule);
  const recentModuleIds = useWorkbenchStore((s) => s.recentModuleIds);
  const theme = useWorkbenchStore((s) => s.theme);
  const modulePrefs = useWorkbenchStore((s) => s.modulePrefs);
  const moduleOrder = useWorkbenchStore((s) => s.moduleOrder);
  const setGroupModuleOrder = useWorkbenchStore((s) => s.setGroupModuleOrder);
  const homeLayout = useWorkbenchStore((s) => s.homeLayout);
  const setHomeLayout = useWorkbenchStore((s) => s.setHomeLayout);

  const [keyword, setKeyword] = useState('');
  const today = useMemo(() => DATE_FMT.format(new Date()), []);
  const rowStatus = useRowStatus();

  /* 最近用过的模块，用行尾一个小圆点标记，不再单独占一块版面 */
  const recentSet = useMemo(() => new Set(recentModuleIds), [recentModuleIds]);

  /* 用户关掉的模块（hidden）首页也不显示，与侧栏同一条判据 */
  const visibleModules = useMemo(
    () => allModules.filter((m) => !modulePrefs[m.id]?.hidden),
    [allModules, modulePrefs],
  );

  const filtered = useMemo(
    () => searchModules(keyword, visibleModules),
    [keyword, visibleModules],
  );

  /* ===== 拖拽状态 ===== */
  /* 行的 DOM 引用：FLIP 动画与「指针落在第几行」都要读 getBoundingClientRect */
  const rowEls = useRef(new Map<string, HTMLButtonElement>());
  /*
   * 每个 id 一个**稳定**的 ref 回调。
   * 如果每次渲染都新建箭头函数，React 会先以 null 调一次旧的、再以节点调一次新的，
   * 13 行就是 26 次 map 增删 —— 重排时每帧都来一遍，纯属白抖。
   */
  const refCache = useRef(new Map<string, (el: HTMLButtonElement | null) => void>());
  /*
   * 提交之后的**纯布局**矩形（不含 FLIP 动画的 transform）。
   *
   * 为什么不能直接用 getBoundingClientRect 做命中判定：重排后其它行正从旧位置
   * 滑向新位置，170ms 内它们会「路过」指针所在的位置 —— 用实时 rect 判定就会
   * 命中一个正在路过的行，再触发一次换位，于是来回抖。
   * 这里在「提交完成、动画还没开播」的那一刻量一次，存的是最终位置。
   * 坐标记成滚动坐标系（加上滚动量），拖拽期间万一页面滚了也不会整体偏。
   */
  const layoutRects = useRef(
    new Map<string, { left: number; top: number; right: number; bottom: number }>(),
  );
  /*
   * 拖拽坐标的参照滚动容器 —— 必须挂在**模块列表自己**的滚动节点上。
   * 2026-10-26 起首页改成分区滚动：外层 .home-root 不再滚，滚的是 .home-list。
   * 如果这里还指向外层，scrollTop 恒为 0，列表滚过之后命中判定会整体偏。
   */
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** 窄屏（≤1359px）时列表不滚，滚的是整个主体；命中判定要跟着换参照 */
  const bodyRef = useRef<HTMLDivElement | null>(null);

  /**
   * 此刻真正在滚的那个容器。
   *
   * 宽屏：模块列表自己（右栏另有自己的滚动区，与拖拽无关）。
   * 窄屏：列表 overflow 被放开，整块 .home-body 统一滚。
   * 列表内容装得下时两个都不滚，返回谁都一样（scrollTop 都是 0）。
   */
  const scrollerEl = (): HTMLElement | null => {
    const list = scrollRef.current;
    if (list && list.scrollHeight > list.clientHeight + 1) return list;
    return bodyRef.current;
  };
  const session = useRef<DragSession | null>(null);
  /* 拖动过的那一次松手会紧接着补一个 click，这里记一下把它吞掉 */
  const suppressClick = useRef(false);
  const [dragging, setDragging] = useState<{ id: string; group: ModuleGroup } | null>(null);
  /* 拖拽中的临时顺序；为 null 时用落盘的 moduleOrder */
  const [liveOrder, setLiveOrder] = useState<string[] | null>(null);

  const groups = useMemo(() => {
    const raw = groupModules(filtered);
    return raw.map(({ group, modules }) => ({
      group,
      modules: applyOrder(
        modules,
        liveOrder && dragging?.group === group ? liveOrder : moduleOrder[group],
      ),
    }));
  }, [filtered, moduleOrder, liveOrder, dragging]);

  /*
   * 每个分组的**全部**模块 id（含被隐藏的）。
   * 落盘时用它把隐藏项补回原位 —— 首页只看得见没被隐藏的模块，直接写可见列表
   * 会把隐藏模块从 moduleOrder 里抹掉，重新打开时它就只能掉到分组末尾。
   */
  const fullGroupIds = useMemo(() => {
    const map = new Map<ModuleGroup, string[]>();
    for (const { group, modules } of groupModules(allModules)) {
      map.set(group, modules.map((m) => m.id));
    }
    return map;
  }, [allModules]);

  /*
   * 重排 = 取消在飞的动画 → 量旧位置 → 同步提交 DOM → 量新位置并播回去。
   *
   * 为什么必须 flushSync：React 18 里 pointermove 属于**连续事件**，setState 走
   * ContinuousEventPriority，渲染被排进一个宏任务；而 rAF 回调在这一帧绘制前跑。
   * 两者谁先谁后没有保证 —— 一旦 rAF 先跑，量到的还是旧位置，delta=0 就不播动画，
   * 随后 React 才提交，元素「啪」地跳过去。之前那种「总是闪一下」主要来自这里。
   * flushSync 把提交拉成同步，量的位置与画面一致，动画就不会被漏掉。
   */
  const flip = useCallback((skipId: string | null, mutate: () => void) => {
    const entries = Array.from(rowEls.current.entries());
    /*
     * 顺序很讲究：
     *   1. 先量「此刻画面上的位置」—— 含正在跑的动画偏移。快速拖动时上一轮动画
     *      往往还没播完，从画面位置接着滑才不会「跳回槽位再走」。
     *   2. 再取消自己的动画。必须在量完之后：提前取消会让元素瞬间回落到布局位置，
     *      量到的基准就丢了那一截偏移。
     */
    const before = new Map<string, DOMRect>();
    for (const [id, el] of entries) before.set(id, el.getBoundingClientRect());
    for (const [, el] of entries) {
      /* 老 WebView 可能没有 getAnimations：没有就当没有动画要取消 */
      for (const a of el.getAnimations?.() ?? []) if (a.id === FLIP_ID) a.cancel();
    }

    flushSync(mutate);

    const scroller = scrollerEl();
    const sx = scroller?.scrollLeft ?? 0;
    const sy = scroller?.scrollTop ?? 0;

    for (const [id, el] of entries) {
      /*
       * 此刻 DOM 已提交、动画还没开播 —— 量到的 rect 就是「最终布局位置」，
       * 存下来给 slotAt 做命中判定（它不能看动画中途的位置，见 layoutRects 的说明）。
       * 被拖的那一项不进表：它的 rect 含跟随位移，存进去会污染下一次拖拽的判定。
       */
      const r = el.getBoundingClientRect();
      if (id === skipId) continue;
      layoutRects.current.set(id, {
        left: r.left + sx,
        top: r.top + sy,
        right: r.right + sx,
        bottom: r.bottom + sy,
      });

      const b = before.get(id);
      if (!b) continue;
      const dx = b.left - r.left;
      const dy = b.top - r.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      const anim = el.animate(
        [{ transform: `translate3d(${dx}px, ${dy}px, 0)` }, { transform: 'translate3d(0, 0, 0)' }],
        { duration: FLIP_MS, easing: FLIP_EASE },
      );
      anim.id = FLIP_ID;
    }
  }, []);

  /**
   * 让被拖的元素贴住指针。
   *
   * 元素仍在文档流里（占着自己的槽位），布局位置会随重排变化，所以不能简单地写
   * 「指针位移」—— 必须把它相对布局位置的那一段抵消掉，否则重排的一瞬间会跳一下。
   * 反算方式：纯布局位置 = rect - 当前已施加的位移。
   */
  const follow = (s: DragSession) => {
    const el = s.el;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const layoutLeft = r.left - s.tx;
    const layoutTop = r.top - s.ty;
    s.tx = s.startLeft + (s.px - s.startX) - layoutLeft;
    s.ty = s.startTop + (s.py - s.startY) - layoutTop;
    el.style.transform = `translate3d(${s.tx}px, ${s.ty}px, 0)`;
  };

  /**
   * 指针落在哪一项的矩形里。
   *
   * 判据用「命中矩形」而不是「离谁的中心最近」：后者在两项的中线附近会来回判成
   * 两边，每次 pointermove 都触发一次换位，看起来就是高频抖动。命中矩形只在真正
   * 进入相邻项的范围时才换位。指针落在行间缝隙或分组外时返回 -1（本次不换位），
   * 比强行吸附稳定得多。
   */
  const slotAt = (s: DragSession, x: number, y: number): number => {
    const scroller = scrollerEl();
    const px = x + (scroller?.scrollLeft ?? 0);
    const py = y + (scroller?.scrollTop ?? 0);
    for (let i = 0; i < s.order.length; i++) {
      const id = s.order[i];
      if (id === s.id) continue;
      const box = layoutRects.current.get(id);
      if (box) {
        if (px >= box.left && px <= box.right && py >= box.top && py <= box.bottom) return i;
        continue;
      }
      /* 还没重排过：此刻没有动画在跑，实时 rect 就是布局位置 */
      const el = rowEls.current.get(id);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return i;
    }
    return -1;
  };

  /** 一帧只处理一次指针：pointermove 在高刷屏 / 触控板上会以 120~240Hz 触发 */
  const processMove = () => {
    const s = session.current;
    if (!s || !s.moved) return;
    const from = s.order.indexOf(s.id);
    const to = slotAt(s, s.px, s.py);
    if (to >= 0 && to !== from) {
      const next = moveItem(s.order, from, to);
      s.order = next;
      flip(s.id, () => setLiveOrder(next));
    }
    follow(s);
  };

  const onRowPointerDown = (
    e: React.PointerEvent<HTMLButtonElement>,
    m: WorkbenchModule,
    group: ModuleGroup,
    ids: string[],
  ) => {
    if (e.button !== 0 || session.current) return;
    /*
     * 搜索过滤中不允许拖动：此刻渲染的是**过滤后的子集**，松手落盘会把这个
     * 子集当成整组顺序写进 moduleOrder，没匹配上的模块就从顺序里丢了。
     * 与其记一个残缺顺序，不如这个状态下干脆不排。
     */
    if (keyword) return;
    suppressClick.current = false;
    /* 指针捕获：这样 move/up 都会回到这一行上，不必往 window 上挂监听 */
    e.currentTarget.setPointerCapture(e.pointerId);
    session.current = {
      id: m.id,
      group,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      origin: ids.slice(),
      order: ids,
      startLeft: 0,
      startTop: 0,
      tx: 0,
      ty: 0,
      el: null,
      px: e.clientX,
      py: e.clientY,
      raf: 0,
    };
  };

  const onRowPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const s = session.current;
    if (!s || e.pointerId !== s.pointerId) return;
    s.px = e.clientX;
    s.py = e.clientY;

    if (!s.moved) {
      if (Math.hypot(s.px - s.startX, s.py - s.startY) < DRAG_THRESHOLD_PX) return;
      const el = rowEls.current.get(s.id) ?? null;
      /* 清掉可能残留的收尾位移，否则量出来的起点是偏的 */
      if (el) el.style.transform = '';
      const r = el?.getBoundingClientRect();
      s.el = el;
      s.startLeft = r?.left ?? 0;
      s.startTop = r?.top ?? 0;
      s.moved = true;
      /* 上一轮留下的布局快照作废：布局可能已经变了（换过视图、改过窗口宽度） */
      layoutRects.current.clear();
      /* 抬起样式与临时顺序放进同一次提交，避免「先亮一下、再重排」两帧 */
      flushSync(() => {
        setDragging({ id: s.id, group: s.group });
        setLiveOrder(s.order);
      });
    }

    if (!s.raf) {
      s.raf = requestAnimationFrame(() => {
        s.raf = 0;
        processMove();
      });
    }
  };

  const onRowPointerEnd = (e: React.PointerEvent<HTMLButtonElement>) => {
    const s = session.current;
    session.current = null;
    if (!s) return;
    if (s.raf) {
      cancelAnimationFrame(s.raf);
      s.raf = 0;
    }
    if (e.currentTarget.hasPointerCapture?.(s.pointerId)) {
      e.currentTarget.releasePointerCapture(s.pointerId);
    }
    /* 没越过阈值 = 用户只是想点开它，交给 onClick */
    if (!s.moved) return;

    suppressClick.current = true;
    /* 拖了但最终没换位（手抖、又拖回来了）：收场即可，别写库 */
    const reordered = s.order.some((id, i) => id !== s.origin[i]);

    /*
     * 先落盘、再清临时顺序。两件事在同一个 handler 里，React 会合成一次提交 ——
     * 反过来的话会有一帧「先回到旧顺序、再跳到新顺序」，正是松手时那一下闪。
     * 落盘时用 mergeOrder 把隐藏模块补回原位：首页只看得见没被隐藏的模块。
     */
    if (reordered) {
      const full = fullGroupIds.get(s.group) ?? s.order;
      setGroupModuleOrder(s.group, mergeOrder(full, s.order));
    }
    flushSync(() => {
      setDragging(null);
      setLiveOrder(null);
    });

    /*
     * 收尾：把跟随位移滑回自己的槽位。松手时元素可能离槽位还有几十像素，
     * 直接清 transform 会「啪」地归位；滑一下才自然。
     * 动画带 fill: 'forwards'，结束时先清 inline transform 再 cancel，
     * 中间不会出现「回跳到旧位移」的一帧。
     */
    const el = s.el;
    if (!el) return;
    if (Math.abs(s.tx) > 0.5 || Math.abs(s.ty) > 0.5) {
      const anim = el.animate(
        [
          { transform: `translate3d(${s.tx}px, ${s.ty}px, 0)` },
          { transform: 'translate3d(0, 0, 0)' },
        ],
        { duration: SETTLE_MS, easing: FLIP_EASE, fill: 'forwards' },
      );
      anim.id = FLIP_ID;
      anim.onfinish = () => {
        el.style.transform = '';
        anim.cancel();
      };
    } else {
      el.style.transform = '';
    }
  };

  const onRowClick = (m: WorkbenchModule) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    setActiveModule(m.id);
  };

  /** 取某个模块的稳定 ref 回调（同 id 永远返回同一个函数，见 refCache 的说明） */
  const refFor = (id: string) => {
    let fn = refCache.current.get(id);
    if (!fn) {
      fn = (el: HTMLButtonElement | null) => {
        if (el) rowEls.current.set(id, el);
        else rowEls.current.delete(id);
      };
      refCache.current.set(id, fn);
    }
    return fn;
  };

  /*
   * 列表行与卡片共用同一批 props —— 两种视图只差排版，
   * 数据、拖拽、最近标记、DOM 注册全都是同一份。改行为时只要改这里。
   */
  const itemProps = (
    m: WorkbenchModule,
    group: ModuleGroup,
    ids: string[],
  ): ModuleItemProps => ({
    module: m,
    status: rowStatus[m.id] ?? '',
    recent: recentSet.has(m.id),
    dragging: dragging?.id === m.id,
    onOpen: () => onRowClick(m),
    onPointerDown: (e) => onRowPointerDown(e, m, group, ids),
    onPointerMove: onRowPointerMove,
    onPointerEnd: onRowPointerEnd,
    registerEl: refFor(m.id),
  });

  /* 全被隐藏了和「搜索没命中」要分开说，否则文案会自相矛盾 */
  const allHidden = visibleModules.length === 0;

  return (
    <div
      className={`home-root h-full w-full${dragging ? ' home-dragging' : ''}`}
    >
      <div className="home-page">
        {/* ===== 抬头 ===== */}
        <header className="home-head">
          <div className="home-head-copy">
            <div className="home-head-date">{today}</div>
            <h1 className="home-head-title">{greeting()}，欢迎回来</h1>
          </div>

          <div className="home-search">
            <Input
              allowClear
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="搜索模块"
              prefix={<SearchOutlined className="home-search-icon" />}
              variant="borderless"
            />
          </div>
        </header>

        {/* ===== 主体：主栏（状态 + 模块目录）+ 右栏（时钟 + 动态） ===== */}
        <div className="home-body" ref={bodyRef}>
          {/* ===== 现在 ===== */}
          <HomeStatusPanel />

          {/* ===== 模块目录（自己的滚动容器，与右栏分开滑） ===== */}
          <div className="home-list" ref={scrollRef}>
            <div className="home-list-head">
              <span className="home-list-title">模块</span>
              <div className="home-list-actions">
                <span className="home-list-meta">
                  {keyword
                    ? `匹配 ${filtered.length} / ${visibleModules.length}`
                    : `${visibleModules.length} 个`}
                </span>
                <LayoutSwitch value={homeLayout} onChange={setHomeLayout} />
              </div>
            </div>

            {groups.length === 0 ? (
              <div className="home-empty">
                <InboxOutlined className="home-empty-icon" />
                <div className="home-empty-title">
                  {allHidden ? '所有模块都被隐藏了' : `没有找到匹配「${keyword}」的模块`}
                </div>
                <div className="home-empty-hint">
                  {allHidden
                    ? '到「设置 · 模块管理」把想用的模块重新打开'
                    : '换个关键词，或到「设置」里检查模块是否被隐藏'}
                </div>
              </div>
            ) : (
              groups.map(({ group, modules }) => {
                /* 拖拽时用的顺序就是此刻渲染出来的顺序 */
                const ids = modules.map((m) => m.id);
                return (
                  <section key={group} className="home-group">
                    <div className="home-group-title">
                      {group}
                      <span className="home-group-count">{modules.length}</span>
                    </div>

                    {homeLayout === 'list' ? (
                      modules.map((m) => <ModuleRow key={m.id} {...itemProps(m, group, ids)} />)
                    ) : (
                      <div className="home-grid">
                        {modules.map((m) => <ModuleCard key={m.id} {...itemProps(m, group, ids)} />)}
                      </div>
                    )}
                  </section>
                );
              })
            )}
          </div>

          {/* ===== 右栏：世界时钟 + 最近动态 ===== */}
          <div className="home-rail">
            <HomeClock />
            <HomeActivityFeed />
          </div>
        </div>

        {/* ===== 底部 ===== */}
        <footer className="home-foot">
          <span>个人工作台</span>
          <span className="home-foot-sep">·</span>
          <span>v{__APP_VERSION__}</span>
          <span className="home-foot-sep">·</span>
          <span>{theme === 'dark' ? '深色' : '浅色'}主题</span>
          <span className="home-foot-sep">·</span>
          <span>按住一行可上下拖动排序；模块显隐在右上角「设置」里调整</span>
        </footer>
      </div>
    </div>
  );
};

/* =============================================
   ====== 列表行 ======
   ============================================= */
interface ModuleItemProps {
  module: WorkbenchModule;
  /** 行右侧的实时状态；空串表示这个模块没有会变的东西，不显示 */
  status: string;
  /** 最近使用过 */
  recent: boolean;
  /** 是否是正在被拖动的那一行 */
  dragging: boolean;
  onOpen: () => void;
  onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLButtonElement>) => void;
  onPointerEnd: (e: React.PointerEvent<HTMLButtonElement>) => void;
  /** 注册 DOM 节点，供 FLIP 动画与落点计算使用 */
  registerEl: (el: HTMLButtonElement | null) => void;
}

const ModuleRow: React.FC<ModuleItemProps> = ({
  module,
  status,
  recent,
  dragging,
  onOpen,
  onPointerDown,
  onPointerMove,
  onPointerEnd,
  registerEl,
}) => (
  <button
    ref={registerEl}
    type="button"
    onClick={onOpen}
    onPointerDown={onPointerDown}
    onPointerMove={onPointerMove}
    onPointerUp={onPointerEnd}
    onPointerCancel={onPointerEnd}
    className={`home-row${dragging ? ' home-row-dragging' : ''}`}
  >
    <span className="home-row-icon">{module.icon}</span>
    <span className="home-row-name">{module.name}</span>
    <span className="home-row-desc">{module.description || '暂无说明'}</span>
    <span className="home-row-status">{status}</span>
    {recent && <span className="home-row-recent" aria-label="最近使用" />}
  </button>
);

/* =============================================
   ====== 模块卡片（卡片视图） ======
   ============================================= */
/*
 * 与列表行同源，只是排版不同：图标 + 名称一行，描述最多两行，底部一行状态。
 * 刻意不带版本号、「常驻」标记和关键词药丸 —— 那些是元信息和搜索索引，
 * 摆到卡片上只会变成噪声（旧版首页 13 张卡里塞了 26 个药丸、11 个 v0.1.0）。
 */
const ModuleCard: React.FC<ModuleItemProps> = ({
  module,
  status,
  recent,
  dragging,
  onOpen,
  onPointerDown,
  onPointerMove,
  onPointerEnd,
  registerEl,
}) => (
  <button
    ref={registerEl}
    type="button"
    onClick={onOpen}
    onPointerDown={onPointerDown}
    onPointerMove={onPointerMove}
    onPointerUp={onPointerEnd}
    onPointerCancel={onPointerEnd}
    className={`home-card${dragging ? ' home-card-dragging' : ''}`}
  >
    <span className="home-card-head">
      <span className="home-card-icon">{module.icon}</span>
      <span className="home-card-name">{module.name}</span>
      {recent && <span className="home-card-recent" aria-label="最近使用" />}
    </span>
    <span className="home-card-desc">{module.description || '暂无说明'}</span>
    {status && <span className="home-card-status">{status}</span>}
  </button>
);

/* =============================================
   ====== 排布切换（列表 / 卡片） ======
   ============================================= */
/*
 * 刻意不用 AntD 的 Segmented：为了两个按钮，它会连带动画与触发器一起进主包
 * （实测 index chunk 从 222KB 涨到 309KB）。这里两个 button + 二十行 CSS 就够。
 */
const LAYOUT_OPTIONS: Array<{ value: HomeLayout; label: string }> = [
  { value: 'list', label: '列表' },
  { value: 'grid', label: '卡片' },
];

const LayoutSwitch: React.FC<{ value: HomeLayout; onChange: (v: HomeLayout) => void }> = ({
  value,
  onChange,
}) => (
  <div className="home-layout-switch" role="group" aria-label="模块排布方式">
    {LAYOUT_OPTIONS.map((opt) => (
      <button
        key={opt.value}
        type="button"
        className={`home-layout-btn${value === opt.value ? ' is-active' : ''}`}
        aria-pressed={value === opt.value}
        onClick={() => onChange(opt.value)}
      >
        {opt.label}
      </button>
    ))}
  </div>
);

export default HomeModule;
