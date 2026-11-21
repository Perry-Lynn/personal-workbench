/*
 * 首页 · 世界时钟
 * ------------------------------------------------------------------
 * 「现在」面板下面的第二条横向信息带：几个地区此刻几点。
 *
 * 三个决定：
 *
 *   1. **不套边框、不做卡片**。首页的硬约束是「整页只有 .home-now 一处带边框容器」
 *      （见 home.css 文件头）。所以每个地区是一块**软底 chip**（--wb-bg-overlay），
 *      与列表/卡片切换器同款处理 —— 靠底色差和留白分层，不靠线。
 *
 *   2. **秒要动，但只动这一块**。时间靠组件内的 1Hz state 推进，不放进全局 store：
 *      每秒让整个首页重渲染，会白白带着 13 行模块目录和拖拽用的 rect 快照一起算。
 *      外面再包一层 React.memo（无 props），拖拽重排时的每帧重渲染也进不来。
 *
 *   3. **时区选择是「白名单 + 城市别名 + 搜索」**，不是自由输入。理由见
 *      core/timezones.ts 文件头：存进一个 Intl 不认识的 id，下次启动渲染就抛
 *      RangeError，整页进 ErrorBoundary。
 *
 * ⚠️ 条目存的是 `{ id, city }` 而不是裸 id：北京和上海共用 `Asia/Shanghai`，
 *    用户搜的是北京，格子上就该写北京（见 clocks.ts 的说明）。
 * ⚠️ 面板顶部**固定显示「当前定位」**：让用户看得见系统认的是哪个城市，
 *    而且它是唯一能把「不在目录里的本机时区」加回来的入口。
 *
 * 存储：localStorage `workbench:home-clocks`。
 * 不写进工作台 store —— 它是首页自己的展示偏好，和主题/侧栏不是一类东西，
 * 塞进全局 store 只会让那个「工作台级状态」的边界越来越糊。
 * @Author: fu
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { App as AntApp, Input } from 'antd';
import {
  AimOutlined,
  CloseOutlined,
  PlusOutlined,
  SearchOutlined,
  SwapOutlined,
} from '@ant-design/icons';
import { useWorkbenchStore } from '@/store/useWorkbenchStore';
import {
  CLOCK_MAX,
  dayDeltaLabel,
  dstProfile,
  formatClock,
  groupZones,
  localZoneId,
  nextTransition,
  offsetAt,
  offsetLabel,
  searchCities,
  tierTimes,
  zoneLabel,
  type DstProfile,
} from '@/core/timezones';
import {
  addClockEntry,
  entryKey,
  normalizeClockEntries,
  removeClockEntry,
  type ClockEntry,
} from './clocks';
import { moveItem } from './order';

const LS_CLOCKS = 'workbench:home-clocks';

/** 读存储。没存过 → 默认四个地区；存过就尊重用户的选择（包括「全删了」） */
function readEntries(): ClockEntry[] {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(LS_CLOCKS);
  } catch (_) {
    /* 隐私模式下读不到，按没存过处理 */
  }
  if (raw === null) return normalizeClockEntries(null);
  try {
    return normalizeClockEntries(JSON.parse(raw));
  } catch (_) {
    /* 存坏了（手改 / 半截写入）—— 回默认值，不要把坏数据当成空列表 */
    return normalizeClockEntries(null);
  }
}

function writeEntries(entries: ClockEntry[]): void {
  try {
    localStorage.setItem(LS_CLOCKS, JSON.stringify(entries));
  } catch (_) {
    /* 写不进去就只影响下次启动，当前会话照常 */
  }
}

/* =============================================
   ====== 添加地区面板 ======
   =============================================
   单独抽成 memo 组件：外层每秒 tick 一次，如果面板跟着重渲染，
   一百多个候选每秒钟 diff 一遍纯属浪费。这里 props 全部稳定（entries 只在增删改时变），
   所以 tick 进不来。
   ============================================= */
interface ClockPickerProps {
  entries: ClockEntry[];
  /** 本机时区 id，用来做顶部「当前定位」 */
  local: string;
  keyword: string;
  onKeyword: (v: string) => void;
  /** 添加一个时区；city 只在「用户选的城市不是该时区主城」时才传 */
  onAdd: (zone: string, city?: string) => void;
}

const ClockPicker = React.memo<ClockPickerProps>(
  ({ entries, local, keyword, onKeyword, onAdd }) => {
    const groups = useMemo(() => groupZones(searchCities(keyword)), [keyword]);
    const full = entries.length >= CLOCK_MAX;

    const localCity = zoneLabel(local);
    const localAdded = entries.some((e) => e.id === local && !e.city);

    const addLocal = () => {
      if (localAdded || full) return;
      onAdd(local, undefined);
    };

    return (
      <div className="home-clock-panel" role="dialog" aria-label="添加地区">
        {/* 定位行常驻：它不参与搜索，是「系统认为你在哪」的答案 */}
        <div className="home-clock-pin">
          <span className="home-clock-pin-label">
            <AimOutlined />
            当前定位
          </span>
          <span className="home-clock-pin-city" title={local}>
            {localCity}
          </span>
          <button
            type="button"
            className="home-clock-pin-add"
            disabled={localAdded || full}
            onClick={addLocal}
          >
            {localAdded ? '已添加' : full ? '已满' : '添加'}
          </button>
        </div>

        <Input
          size="small"
          allowClear
          autoFocus
          value={keyword}
          onChange={(e) => onKeyword(e.target.value)}
          placeholder="搜索城市 / 国家 / 缩写"
          prefix={<SearchOutlined className="home-clock-panel-icon" />}
        />

        <div className="home-clock-panel-list">
          {groups.length === 0 && <div className="home-clock-panel-empty">没有匹配的城市</div>}

          {groups.map(({ region, zones }) => (
            <div key={region}>
              <div className="home-clock-panel-region">{region}</div>
              {zones.map((z) => {
                /*
                 * 同一个时区可以有多条（北京 / 上海都是 Asia/Shanghai），
                 * 所以判重与 React key 都必须带上城市 —— **同区不同城市要能并存**，
                 * 不能像以前那样「再点一个就把上一个改名」。
                 */
                const cityArg = z.city === zoneLabel(z.id) ? undefined : z.city;
                const isAdded = entries.some((e) => entryKey(e) === entryKey({ id: z.id, city: cityArg }));
                const note = isAdded ? '已添加' : full ? '已满' : '';

                return (
                  <button
                    key={`${z.id}|${z.city}`}
                    type="button"
                    className="home-clock-opt"
                    disabled={isAdded || full}
                    onClick={() => onAdd(z.id, cityArg)}
                    title={z.id}
                  >
                    <span className="home-clock-opt-name">{z.city}</span>
                    {/*
                     * 「定位」只打在**该时区的主城**那一行。北京与上海共用
                     * Asia/Shanghai，但系统认的是「上海」这一格；给北京也挂个
                     * 定位标记会让人以为定位到了北京。
                     */}
                    {z.id === local && z.city === localCity && (
                      <span className="home-clock-opt-pin">定位</span>
                    )}
                    <span className="home-clock-opt-note">{note}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        <div className="home-clock-panel-foot">最多同时展示 {CLOCK_MAX} 个地区</div>
      </div>
    );
  },
);
ClockPicker.displayName = 'ClockPicker';

/* =============================================
   ====== 单个地区 ======
   ============================================= */
interface ClockChipProps {
  entry: ClockEntry;
  now: Date;
  /** 该时区的夏令时档案；不实行夏令时或不可用时为 null */
  profile: DstProfile | null;
  /**
   * 是不是「本地」那一格。
   * 由上层算好传进来，而不是在这里比 `id === local` —— 同一个时区可以有多格
   * （上海 / 北京），比 id 会让两格都挂上「本地」标签。
   */
  isLocal: boolean;
  /** 本地此刻的日期，用于算「昨天 / 明天」 */
  localDayKey: string;
  /** 本地相对 UTC 的偏移（分钟），用于算时差文案 */
  localOffset: number;
  /** 按条目的稳定键删除（同区的另一个城市不受影响） */
  onRemove: (key: string) => void;
  /** 拖动排序：三个指针事件直接挂到卡片上 */
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
  /** 正在被拖动的那一张（抬起来、加阴影） */
  dragging: boolean;
  /** 注册 DOM 节点，供 FLIP 动画与落点计算使用 */
  registerEl: (el: HTMLDivElement | null) => void;
}

const ClockChip: React.FC<ClockChipProps> = ({
  entry,
  now,
  profile,
  isLocal,
  localDayKey,
  localOffset,
  onRemove,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  dragging,
  registerEl,
}) => {
  const { id } = entry;
  /* 用户选的城市优先；没选过就是该时区的主城 */
  const city = entry.city ?? zoneLabel(id);
  const info = formatClock(now, id);

  /*
   * 时区不合法时 formatClock 返回 null。理论上进不来（写盘前已白名单校验，
   * 唯一的例外是本机时区，而它一定合法），但真进来了也只是这一格显示「—」，
   * 不要让异常冒到 ErrorBoundary 去。
   */
  if (!info) {
    return (
      <div className="home-clock-item" ref={registerEl}>
        <span className="home-clock-top">
          <span className="home-clock-city">{city}</span>
        </span>
        <span className="home-clock-time">—</span>
        <span className="home-clock-sub">时区不可用</span>
      </div>
    );
  }

  const dayTag = dayDeltaLabel(info.dayKey, localDayKey);
  const sub = isLocal ? '当前时区' : offsetLabel(info.offsetMinutes - localOffset);
  /*
   * 两档钟点：同一个瞬间按标准时 / 夏令时各写一次，**标准时在前**（基准）。
   * 只有实行夏令时的时区才有这一行 —— 其余时区两档本来就是一回事。
   */
  const tiers = profile?.usesDst ? tierTimes(now.getTime(), profile) : null;

  return (
    <div
      ref={registerEl}
      className={`home-clock-item${dragging ? ' is-dragging' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      /* 悬停补全信息：日期、完整时区名。chip 里放不下这些，但排查时有用 */
      title={`${city} · ${info.dateLabel} · ${id}`}
    >
      <span className="home-clock-top">
        <span className="home-clock-city">{city}</span>
        {isLocal && <span className="home-clock-tag is-local">本地</span>}
        {dayTag && <span className="home-clock-tag is-day">{dayTag}</span>}
      </span>

      <span className="home-clock-time">
        {info.time}
        <span className="home-clock-sec">:{info.second}</span>
      </span>

      {tiers && (
        <span className="home-clock-tiers">
          <span className="is-standard">标准时 {tiers.standard}</span>
          <span className="home-clock-tier-sep"> · </span>
          <span className="is-daylight">夏令时 {tiers.daylight}</span>
        </span>
      )}

      <span className="home-clock-sub">{sub}</span>

      <button
        type="button"
        className="home-clock-remove"
        aria-label={`移除 ${city}`}
        onClick={() => onRemove(entryKey(entry))}
      >
        <CloseOutlined />
      </button>
    </div>
  );
};

/* =============================================
   ====== 拖动排序的常量与状态 ======
   =============================================
   与首页模块列表（HomeView）同一套约定，四条都不能省：
     ① 顺序与「抬起来」的样式放进**同一次 flushSync** —— 否则会先亮一下再重排；
     ② FLIP 顺序 = 先量画面位置 → 取消自己的动画 → 提交 → 再量纯布局位置；
     ③ 命中判定用「提交后、动画开播前」的快照，**不能用实时 rect**
        （重排后其它卡片正从旧位置滑向新位置，用实时 rect 会命中正在路过的那个）；
     ④ 拖拽期间 `transition: none`，**绝不给 transform 加 `!important` 或 transition**。
   ============================================= */
const DRAG_THRESHOLD_PX = 4;
const FLIP_MS = 160;
const FLIP_EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
const FLIP_ID = 'clock-flip';

interface ClockDrag {
  /** 被拖那一格的稳定键 */
  key: string;
  pointerId: number;
  startX: number;
  startY: number;
  px: number;
  py: number;
  /** 是否已越过阈值（没越过就是一次普通点击，不能当成拖动） */
  moved: boolean;
  el: HTMLDivElement | null;
  startLeft: number;
  startTop: number;
  /** 当前施加的位移（相对布局位置） */
  tx: number;
  ty: number;
  raf: number;
  /** 拖动过程中的完整顺序；松手时按它落盘 */
  order: ClockEntry[];
}

/* =============================================
   ====== 世界时钟 ======
   ============================================= */
const HomeClock: React.FC = () => {
  const [entries, setEntries] = useState<ClockEntry[]>(readEntries);
  const [now, setNow] = useState<Date>(() => new Date());
  const [picking, setPicking] = useState(false);
  const [keyword, setKeyword] = useState('');
  const wrapRef = useRef<HTMLDivElement | null>(null);

  /* ===== 拖动排序的 DOM 侧状态（全部用 ref，不触发渲染） ===== */
  /** 稳定键 → 卡片节点 */
  const chipEls = useRef(new Map<string, HTMLDivElement>());
  /** 稳定键 → 稳定的 ref 回调。每次渲染都新建箭头函数会让 React 先以 null 调旧的、
   *  再以节点调新的，1Hz 走秒时每秒就是十几次 map 增删 —— 白抖 */
  const refCache = useRef(new Map<string, (el: HTMLDivElement | null) => void>());
  /** 提交后、动画开播前的纯布局矩形（命中判定只能用这一份） */
  const layoutRects = useRef(
    new Map<string, { left: number; top: number; right: number; bottom: number }>(),
  );
  const dragRef = useRef<ClockDrag | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);

  const { message } = AntApp.useApp();
  const setActiveModule = useWorkbenchStore((s) => s.setActiveModule);
  /*
   * 时区对比模块被用户关掉时，这里不能再往那边跳 —— 跳过去会落在一个
   * 侧栏里根本看不见的模块上（没有高亮项，用户不知道自己在哪）。
   */
  const compareHidden = useWorkbenchStore((s) => Boolean(s.modulePrefs.timezone?.hidden));

  /* 本地时区在会话内不会变，算一次就够 */
  const local = useMemo(() => localZoneId(), []);

  /*
   * 秒针：**对齐到整秒**再排下一次，而不是 setInterval(1000)。
   * 后者的误差会累积（每次回调晚几毫秒，跑一小时就差出一两秒），
   * 表现是秒数偶尔「跳一格」。
   */
  useEffect(() => {
    let timer = 0;
    const tick = () => {
      setNow(new Date());
      timer = window.setTimeout(tick, 1000 - (Date.now() % 1000));
    };
    timer = window.setTimeout(tick, 1000 - (Date.now() % 1000));
    return () => window.clearTimeout(timer);
  }, []);

  /* 面板开着时：点外面 / 按 Esc 收起 */
  useEffect(() => {
    if (!picking) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setPicking(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPicking(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [picking]);

  /*
   * 增删改都走函数式更新：两个按钮的 onClick 在同一个事件循环里连续触发时
   * （快速连点），闭包里的 entries 会是旧值。
   * 写盘放在 updater 里 —— writeEntries 是幂等的（同一个数组写出同一串 JSON），
   * 所以 StrictMode 双调用 updater 不会写出两份不同的东西。
   */
  const add = useCallback((zone: string, city?: string) => {
    setEntries((prev) => {
      const next = addClockEntry(prev, zone, city);
      if (next === prev) return prev;
      writeEntries(next);
      return next;
    });
  }, []);

  const remove = useCallback((key: string) => {
    setEntries((prev) => {
      const next = removeClockEntry(prev, key);
      writeEntries(next);
      return next;
    });
  }, []);

  /* =============================================
     ====== 拖动排序 ======
     ============================================= */

  /** 取某个稳定键的 ref 回调（同 key 永远返回同一个函数，见 refCache 的说明） */
  const refFor = (key: string) => {
    let fn = refCache.current.get(key);
    if (!fn) {
      fn = (el: HTMLDivElement | null) => {
        if (el) chipEls.current.set(key, el);
        else chipEls.current.delete(key);
      };
      refCache.current.set(key, fn);
    }
    return fn;
  };

  /**
   * 提交一次顺序变化，并给「没被拖的那几格」补 FLIP 动画。
   * 被拖的那一格不动画 —— 它有自己的跟随位移，两套 transform 会打架。
   */
  const flip = (skipKey: string, mutate: () => void) => {
    const before = new Map<string, DOMRect>();
    for (const [k, el] of chipEls.current) before.set(k, el.getBoundingClientRect());
    for (const [k, el] of chipEls.current) {
      const anims = el.getAnimations?.() ?? [];
      const mine = anims.filter((a) => a.id === FLIP_ID);
      if (mine.length === 0) continue;
      for (const a of mine) a.cancel();
      /*
       * 收尾动画（松手后滑回槽位）用的是 fill:'forwards' + inline transform，
       * 取消它并不会把 inline transform 清掉 —— 不清的话这一格会永久停在旧位移上。
       * 被拖的那一格例外：它的位移由 follow() 每帧写。
       */
      if (k !== skipKey) el.style.transform = '';
    }

    flushSync(mutate);

    for (const [k, el] of chipEls.current) {
      const r = el.getBoundingClientRect();
      if (k !== skipKey) {
        layoutRects.current.set(k, {
          left: r.left,
          top: r.top,
          right: r.right,
          bottom: r.bottom,
        });
        const b = before.get(k);
        if (!b) continue;
        const dx = b.left - r.left;
        const dy = b.top - r.top;
        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
        const anim = el.animate(
          [
            { transform: `translate3d(${dx}px, ${dy}px, 0)` },
            { transform: 'translate3d(0, 0, 0)' },
          ],
          { duration: FLIP_MS, easing: FLIP_EASE },
        );
        anim.id = FLIP_ID;
      }
    }
  };

  /**
   * 让被拖的卡片贴住指针。
   * 卡片仍在网格里占着自己的槽位，重排后布局位置会变，所以不能只写「指针位移」——
   * 必须把它相对布局位置的那一段抵消掉，否则重排瞬间会跳一下。
   */
  const follow = (s: ClockDrag) => {
    const el = s.el;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const layoutLeft = r.left - s.tx;
    const layoutTop = r.top - s.ty;
    s.tx = s.startLeft + (s.px - s.startX) - layoutLeft;
    s.ty = s.startTop + (s.py - s.startY) - layoutTop;
    el.style.transform = `translate3d(${s.tx}px, ${s.ty}px, 0)`;
  };

  /** 指针落在第几格的矩形里；落在缝隙里返回 -1（本次不换位，比强行吸附稳） */
  const slotAt = (s: ClockDrag, x: number, y: number): number => {
    for (let i = 0; i < s.order.length; i++) {
      const k = entryKey(s.order[i]);
      if (k === s.key) continue;
      const box = layoutRects.current.get(k);
      if (box) {
        if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) return i;
        continue;
      }
      /* 还没重排过：此刻没有动画在跑，实时 rect 就是布局位置 */
      const el = chipEls.current.get(k);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return i;
    }
    return -1;
  };

  /** 一帧只处理一次指针：pointermove 在高刷屏 / 触控板上会以 120~240Hz 触发 */
  const processMove = () => {
    const s = dragRef.current;
    if (!s || !s.moved) return;
    const from = s.order.findIndex((e) => entryKey(e) === s.key);
    const to = slotAt(s, s.px, s.py);
    if (from >= 0 && to >= 0 && to !== from) {
      const next = moveItem(s.order, from, to);
      s.order = next;
      flip(s.key, () => setEntries(next));
    }
    follow(s);
  };

  const onChipPointerDown = (e: React.PointerEvent<HTMLDivElement>, key: string) => {
    if (e.button !== 0 || dragRef.current) return;
    /* 删除按钮上按下不是拖动，是点击 */
    if ((e.target as HTMLElement).closest('.home-clock-remove')) return;
    /*
     * 指针捕获：move / up 都会回到这一格上，不必往 window 上挂监听。
     * 包 try：节点在按下后被移除、或环境里没有真实指针（自动化测试）时会抛，
     * 抛了也只是失去捕获，拖动本身还能靠元素上的事件走完。
     */
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch (_) {
      /* 忽略 */
    }
    dragRef.current = {
      key,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      px: e.clientX,
      py: e.clientY,
      moved: false,
      el: null,
      startLeft: 0,
      startTop: 0,
      tx: 0,
      ty: 0,
      raf: 0,
      order: entries.slice(),
    };
  };

  const onChipPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const s = dragRef.current;
    if (!s || e.pointerId !== s.pointerId) return;
    s.px = e.clientX;
    s.py = e.clientY;

    if (!s.moved) {
      if (Math.hypot(s.px - s.startX, s.py - s.startY) < DRAG_THRESHOLD_PX) return;
      const el = chipEls.current.get(s.key) ?? null;
      /* 清掉可能残留的收尾位移，否则量出来的起点是偏的 */
      if (el) el.style.transform = '';
      const r = el?.getBoundingClientRect();
      s.el = el;
      s.startLeft = r?.left ?? 0;
      s.startTop = r?.top ?? 0;
      s.moved = true;
      /* 上一轮留下的布局快照作废：窗口宽度变了网格列数就变了 */
      layoutRects.current.clear();
      /* 抬起样式放进同一次提交，避免「先亮一下、再重排」两帧 */
      flushSync(() => setDragKey(s.key));
    }

    if (!s.raf) {
      s.raf = requestAnimationFrame(() => {
        s.raf = 0;
        processMove();
      });
    }
  };

  const onChipPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const s = dragRef.current;
    if (!s) return;
    if (s.raf) {
      cancelAnimationFrame(s.raf);
      s.raf = 0;
    }
    if (e.currentTarget.hasPointerCapture?.(s.pointerId)) {
      try {
        e.currentTarget.releasePointerCapture(s.pointerId);
      } catch (_) {
        /* 忽略：同上 */
      }
    }
    /* 没越过阈值 = 一次普通点击，什么都没变 */
    if (!s.moved) {
      dragRef.current = null;
      return;
    }

    /*
     * 松手前再算一次落点，**用松手那一刻的坐标**。
     *
     * pointermove 是节流到 rAF 里跑的，最后一帧很可能还没执行用户就松手了 ——
     * 那样落盘的是上一次的落点，看起来就是「拖到位了但顺序没变」。
     * ⚠️ 这一句必须在 `dragRef.current = null` **之前**：processMove 从 ref 里取会话。
     */
    s.px = e.clientX;
    s.py = e.clientY;
    processMove();
    dragRef.current = null;

    /* 收尾：把跟随位移滑回自己的槽位，再清 inline transform */
    const el = s.el;
    if (el && (Math.abs(s.tx) > 0.5 || Math.abs(s.ty) > 0.5)) {
      const anim = el.animate(
        [
          { transform: `translate3d(${s.tx}px, ${s.ty}px, 0)` },
          { transform: 'translate3d(0, 0, 0)' },
        ],
        { duration: FLIP_MS, easing: FLIP_EASE, fill: 'forwards' },
      );
      anim.id = FLIP_ID;
      /*
       * 清位移走两条路：动画的 onfinish，以及一个超时兜底。
       * 只靠 onfinish 不够 —— 动画被别处取消、或环境里根本没有合成器时它不会触发，
       * 而 inline transform 一旦留在旧位移上，这一格就永久偏了（实测踩到过）。
       */
      const clear = () => {
        el.style.transform = '';
        anim.cancel();
      };
      anim.onfinish = clear;
      window.setTimeout(clear, FLIP_MS + 60);
    } else if (el) {
      el.style.transform = '';
    }

    /* 先落盘、再清「正在拖」—— 顺序反了会有一帧「先回到旧顺序、再跳到新顺序」 */
    writeEntries(s.order);
    flushSync(() => setDragKey(null));
  };

  /*
   * 跳到时区对比模块。
   * 这里只传一个字符串 id，不 import 那个模块 —— 首页与模块之间不能有依赖
   * （见 core/modules.ts 的约定），模块被改名/删除时最坏情况是点过去显示
   * 「模块不存在」，而不是首页整个编译不过。
   */
  const openCompare = useCallback(() => {
    if (compareHidden) {
      message.info('「时区对比」模块被隐藏了，可在「设置 › 模块」里重新打开');
      return;
    }
    setActiveModule('timezone');
  }, [compareHidden, message, setActiveModule]);

  /* 本地的时间每帧都要用：算一次给所有 chip 共用 */
  const localInfo = useMemo(() => formatClock(now, local), [now, local]);
  const localDayKey = localInfo?.dayKey ?? '';
  const localOffset = localInfo?.offsetMinutes ?? 0;

  /*
   * 每个时区的夏令时档案，按**天**缓存。
   * `nextTransition` 要逐日扫最多 400 天；四个地区每秒重算就是每秒上千次
   * `formatToParts`，纯属白烧 CPU。`standardOffset` / `shift` 一天内不会变，
   * `inDst` 则由 chip 用实时偏移现算（跳变当天才不会滞后）。
   */
  const dayIndex = Math.floor(now.getTime() / 86_400_000);
  const profiles = useMemo(() => {
    const at = Date.now();
    const m = new Map<string, DstProfile>();
    for (const e of entries) {
      const p = dstProfile(offsetAt(at, e.id), nextTransition(e.id, at));
      if (p) m.set(e.id, p);
    }
    return m;
  }, [entries, dayIndex]);

  /*
   * 「本地」只挂在**本机时区的第一格**上。
   * 同一时区可以有多格（上海 / 北京），逐格比 `id === local` 会让它们都标上本地 ——
   * 用户明明只在一个地方。
   */
  const localKey = useMemo(() => {
    const first = entries.find((e) => e.id === local);
    return first ? entryKey(first) : '';
  }, [entries, local]);

  return (
    <section className="home-clock" aria-label="世界时钟">
      <div className="home-clock-head">
        <span className="home-clock-title">世界时钟</span>

        <div className="home-clock-actions">
          {/*
           * 只写 `4 / 8`，不写「个地区」：右栏 19.5em 里还要放下「对比」和
           * 「添加地区」两个按钮，完整措辞在 18px 基准字号下会被压成省略号。
           * 上限的含义由选择面板底部那行承担，这里靠 title 补全。
           */}
          {entries.length > 0 && (
            <span
              className="home-clock-meta"
              title={`已添加 ${entries.length} 个地区，最多 ${CLOCK_MAX} 个`}
            >
              {entries.length} / {CLOCK_MAX}
            </span>
          )}

          <button
            type="button"
            className="home-clock-add"
            onClick={openCompare}
            title="并排对比两个时区（含夏令时与 PST / PDT 缩写）"
          >
            <SwapOutlined />
            对比
          </button>

          <div className="home-clock-picker-wrap" ref={wrapRef}>
            <button
              type="button"
              className={`home-clock-add${picking ? ' is-open' : ''}`}
              aria-expanded={picking}
              aria-haspopup="dialog"
              onClick={() => setPicking((v) => !v)}
            >
              <PlusOutlined />
              添加地区
            </button>

            {picking && (
              <ClockPicker
                entries={entries}
                local={local}
                keyword={keyword}
                onKeyword={setKeyword}
                onAdd={add}
              />
            )}
          </div>
        </div>
      </div>

      {entries.length === 0 ? (
        <div className="home-clock-empty">还没有地区，点右上角「添加地区」挑几个常联系的地方</div>
      ) : (
        <div className="home-clock-list">
          {entries.map((entry) => {
            const k = entryKey(entry);
            return (
              <ClockChip
                key={k}
                entry={entry}
                now={now}
                profile={profiles.get(entry.id) ?? null}
                isLocal={k === localKey}
                localDayKey={localDayKey}
                localOffset={localOffset}
                onRemove={remove}
                onPointerDown={(e) => onChipPointerDown(e, k)}
                onPointerMove={onChipPointerMove}
                onPointerUp={onChipPointerUp}
                dragging={dragKey === k}
                registerEl={refFor(k)}
              />
            );
          })}
        </div>
      )}
    </section>
  );
};

/*
 * 无 props 的 memo：首页在拖拽重排时每帧都会重渲染（setLiveOrder），
 * 而时钟只跟自己的 1Hz state 有关，没理由跟着重排跑。
 */
export default React.memo(HomeClock);
