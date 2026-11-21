/*
 * 工作台全局状态（zustand）
 * ------------------------------------------------------------------
 * 只放「工作台级别」的状态：主题、当前模块、侧栏、最近访问、模块偏好。
 * 各功能模块自己的状态请放在模块目录内（如 features/logsight/store/），
 * 不要往这里塞，否则模块一多就变成全局垃圾桶。
 * @Author: fu
 */
import { create } from 'zustand';
import type { ThemeMode } from '@/core/theme';
import {
  FONT_DEFAULT_SIZE,
  FONT_MAX_SIZE,
  FONT_MIN_SIZE,
  clampFontSize,
  parseStoredFontSize,
} from '@/core/theme';
import { fetchOrCreateMasterKey, resetMasterKey } from '@/core/masterKey';
import type { MasterKeyInfo, MasterKeySource } from '@/core/masterKey';
import { applyDockIcon } from '@/core/dockIcon';
import {
  getBackgroundOnClose as fetchBackgroundOnClose,
  setBackgroundOnClose as persistBackgroundOnClose,
} from '@/core/lifecycle';

const LS_THEME = 'workbench:theme';
const LS_ACTIVE_MODULE = 'workbench:active-module';
const LS_SIDER_COLLAPSED = 'workbench:sider-collapsed';
const LS_RECENT = 'workbench:recent-modules';
const LS_MODULE_PREFS = 'workbench:module-prefs';
const LS_MODULE_ORDER = 'workbench:module-order';
const LS_SIDER_WIDTH = 'workbench:sider-width';
const LS_FONT_SIZE = 'workbench:font-size';
const LS_DOCK_ICON = 'workbench:dock-icon';
const LS_HOME_LAYOUT = 'workbench:home-layout';

/*
 * 首页模块目录的排布方式。
 *   list —— 扁平列表（默认）：一行一个模块，靠行距分层，整页只有一处边框
 *   grid —— 卡片网格：一屏能扫到更多模块，代价是每张卡都带一个边框
 * 两种视图共用同一份数据、同一个拖拽排序，切换只影响排版。
 */
export type HomeLayout = 'list' | 'grid';

/*
 * 程序坞图标的 id 集合。
 * 必须与 src-tauri/src/core/dock.rs 里的 ICON_* 常量一一对应；
 * 新增图标后两边同时改，否则选择器选中后切换会失败。
 */
export type DockIconId = 'brand' | 'mono' | 'prism';
const VALID_DOCK_ICONS: readonly DockIconId[] = ['brand', 'mono', 'prism'];

/* 侧栏宽度可调范围 */
export const SIDER_MIN_WIDTH = 180;
export const SIDER_MAX_WIDTH = 360;
export const SIDER_DEFAULT_WIDTH = 216;

/*
 * 字号范围常量定义在 core/theme.ts（buildAntdConfig 要用它派生 token，
 * 而 theme 不能反过来 import store），这里转出一份供设置页与模块使用。
 */
export { FONT_MIN_SIZE, FONT_MAX_SIZE, FONT_DEFAULT_SIZE };

/*
 * 模块级用户偏好。
 *
 * hidden —— 用户把这个模块整个收起来：**首页卡片与侧栏导航都不再出现**。
 * 注意与模块自己声明的 `hiddenInSidebar`（WorkbenchModule）区分：那个是模块
 * 作者说「我不适合放侧栏，但可以走首页卡片进」，用户改不了，也不影响首页。
 */
export interface ModulePref {
  hidden?: boolean;
}

/** 首页卡片的分组内排序：group -> 模块 id 顺序。没记到的分组按 registry 默认顺序 */
export type ModuleOrder = Record<string, string[]>;

/*
 * 主密钥恢复状态。
 * idle    —— 还没试过（刚启动）
 * loading —— 正在向系统钥匙串要密钥
 * ready   —— 已拿到，masterKey 可用
 * error   —— 拿不到，masterKeyError 里是给用户看的原因
 */
export type MasterKeyStatus = 'idle' | 'loading' | 'ready' | 'error';

/*
 * 同一个进程内只允许一个主密钥请求在飞。
 * React 严格模式下 effect 会跑两次、模块也可能重挂载，
 * 没有这个闸门就会并发初始化同一个钥匙串条目。
 */
let masterKeyInflight: Promise<string> | null = null;

/* 真正执行加载：统一维护 status / error 两个状态位 */
async function loadMasterKey(
  fetcher: () => Promise<MasterKeyInfo>,
  set: (partial: Partial<WorkbenchState>) => void,
): Promise<string> {
  set({ masterKeyStatus: 'loading', masterKeyError: null });
  try {
    const info = await fetcher();
    set({
      masterKey: info.key,
      masterKeySource: info.source,
      masterKeyWarning: info.warning,
      masterKeyStatus: 'ready',
      masterKeyError: null,
    });
    return info.key;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    set({ masterKey: null, masterKeyStatus: 'error', masterKeyError: msg });
    throw new Error(msg);
  }
}

interface WorkbenchState {
  /* ===== 主题 ===== */
  theme: ThemeMode;
  setTheme: (t: ThemeMode) => void;
  toggleTheme: () => void;

  /* ===== 当前模块 ===== */
  activeModuleId: string;
  setActiveModule: (id: string) => void;

  /* ===== 最近访问（最新在前，最多 6 条） ===== */
  recentModuleIds: string[];
  pushRecentModule: (id: string) => void;

  /* ===== 侧栏 ===== */
  siderCollapsed: boolean;
  toggleSider: () => void;
  setSiderCollapsed: (v: boolean) => void;
  siderWidth: number;
  setSiderWidth: (w: number) => void;

  /* ===== 全局基准字号（px） ===== */
  fontSize: number;
  setFontSize: (n: number) => void;

  /* ===== 程序坞图标（macOS 运行时切换 Dock 图标） ===== */
  dockIcon: DockIconId;
  setDockIcon: (id: DockIconId) => void;

  /* ===== 窗口与后台 =====
   * 这份偏好的**权威副本在后端 sled 里**（关窗回调跑在 Rust 侧，
   * 它必须在没有前端参与的情况下也能读到）。前端这里只是镜像：
   * 进设置页时读一次，改动时写回后端。**不要**改成 localStorage ——
   * 两份存储必然漂移，而漂移的表现是「设置页显示的」和「关窗时真正生效的」不一致。
   */
  backgroundOnClose: boolean;
  /* 是否已从后端读到过真实值。false 时开关处于 loading，避免把默认值当成用户的设置 */
  backgroundOnCloseLoaded: boolean;
  loadBackgroundOnClose: () => Promise<void>;
  setBackgroundOnClose: (enabled: boolean) => Promise<void>;

  /* ===== 模块偏好（设置页可改） ===== */
  modulePrefs: Record<string, ModulePref>;
  setModulePref: (id: string, pref: ModulePref) => void;
  resetModulePrefs: () => void;
  /* 首页卡片的分组内排序（首页拖拽产生） */
  moduleOrder: ModuleOrder;
  setGroupModuleOrder: (group: string, ids: string[]) => void;
  resetModuleOrder: () => void;
  /* 首页模块目录用列表还是卡片（用户手动切，记住选择） */
  homeLayout: HomeLayout;
  setHomeLayout: (v: HomeLayout) => void;

  /* ===== 本地主密钥（工作台级能力，各模块共用一把） ===== */
  masterKey: string | null;
  masterKeyStatus: MasterKeyStatus;
  masterKeyError: string | null;
  /* 密钥实际存放位置：keychain 首选，local 为降级兜底 */
  masterKeySource: MasterKeySource | null;
  /* 非致命告警（例如降级到本地存储的原因） */
  masterKeyWarning: string | null;
  /** 取主密钥；已在飞或已拿到时直接复用，force=true 时强制重取 */
  ensureMasterKey: (force?: boolean) => Promise<string>;
  /** 用户确认钥匙串不可恢复后重建主密钥 */
  rebuildMasterKey: () => Promise<string>;
}

/* ---------- localStorage 读写小工具（全部 try/catch，隐私模式下不炸） ---------- */
function readLS(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch (_) {
    return null;
  }
}

function writeLS(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch (_) {
    /* 忽略写入失败 */
  }
}

function readJSON<T>(key: string, fallback: T): T {
  const raw = readLS(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch (_) {
    return fallback;
  }
}

/*
 * 读模块偏好，顺带把旧版本写在 localStorage 里的 `hiddenInSidebar` 迁移成 `hidden`。
 *
 * 为什么必须迁移而不是直接改读新字段：这个偏好是用户手动设过的东西，
 * 老版本存下去的键名是 hiddenInSidebar（当时语义只到侧栏）。不认旧键的话，
 * 升级一次用户之前隐藏的模块就会全部重新冒出来。
 * 迁移只做「读时归一」，不主动回写 —— 下一次用户改动设置时自然写成新格式。
 */
function readModulePrefs(): Record<string, ModulePref> {
  const raw = readJSON<Record<string, Partial<ModulePref> & { hiddenInSidebar?: boolean }>>(
    LS_MODULE_PREFS,
    {},
  );
  const out: Record<string, ModulePref> = {};
  for (const [id, p] of Object.entries(raw)) {
    if (!p || typeof p !== 'object') continue;
    const hidden = typeof p.hidden === 'boolean' ? p.hidden : p.hiddenInSidebar === true;
    out[id] = hidden ? { hidden: true } : {};
  }
  return out;
}

/* 读卡片排序：只认「字符串数组」形状的值，脏数据直接丢掉该分组 */
function readModuleOrder(): ModuleOrder {
  const raw = readJSON<ModuleOrder>(LS_MODULE_ORDER, {});
  const out: ModuleOrder = {};
  for (const [group, ids] of Object.entries(raw)) {
    if (Array.isArray(ids) && ids.every((x) => typeof x === 'string')) out[group] = ids;
  }
  return out;
}

/* 初始主题：本地记录优先，否则跟随系统偏好 */
function loadInitialTheme(): ThemeMode {
  const saved = readLS(LS_THEME);
  if (saved === 'light' || saved === 'dark') return saved;
  try {
    if (window.matchMedia?.('(prefers-color-scheme: light)').matches) return 'light';
  } catch (_) {
    /* 忽略 */
  }
  return 'dark';
}

/* 把主题写到 html/body 的 class 上，CSS 变量与 Tailwind darkMode:'class' 都依赖它 */
function applyThemeClass(t: ThemeMode): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const body = document.body;
  const on = t === 'dark' ? 'dark' : 'light';
  const off = t === 'dark' ? 'light' : 'dark';
  root.classList.add(on);
  root.classList.remove(off);
  if (body) {
    body.classList.add(on);
    body.classList.remove(off);
  }
}

/*
 * 同步**原生窗口**外观。
 *
 * 为什么必须做：macOS 磨砂玻璃的材质（NSVisualEffectView）跟随的是**窗口**的
 * 浅色/深色外观，而不是网页的 class。若应用主题是深色、而 macOS 处于浅色模式，
 * 材质会是浅灰 —— 深色侧栏配浅灰底会明显违和。
 *
 * 用动态 import：这个 API 只在 Tauri 里存在，没必要进首屏 chunk；
 * 失败一律静默 —— 它只影响观感，不该阻塞主题切换。
 */
function applyNativeWindowTheme(t: ThemeMode): void {
  void (async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().setTheme(t);
    } catch {
      /* 非 Tauri 环境 / 无权限：忽略 */
    }
  })();
}

/*
 * 把基准字号写到 :root 的 CSS 变量上。
 *
 * AntD 组件走 ConfigProvider token（见 core/theme.ts），但模块 CSS 里那些
 * 写死的 px 字号不受 token 管辖 —— 它们改读 var(--wb-font-base) 才能跟着一起变。
 * 这里同时导出 --wb-font-base（基准）与 --wb-font-sm/lg（派生档），
 * 模块 CSS 用 calc(var(--wb-font-base) - 2px) 之类的写法即可成比例缩放。
 */
function applyFontSizeVar(px: number): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.style.setProperty('--wb-font-base', `${px}px`);
  root.style.setProperty('--wb-font-sm', `${Math.max(11, px - 2)}px`);
  root.style.setProperty('--wb-font-lg', `${px + 2}px`);
}

/*
 * 读初始字号：本地记录优先，没有记录就用默认值。
 *
 * 解析逻辑（含「首次运行必须是默认值、不能被夹到下限」这个坑）收在
 * `core/theme.ts::parseStoredFontSize` —— 那里是纯函数，逻辑测试能直接钉住。
 */
function loadInitialFontSize(): number {
  return parseStoredFontSize(readLS(LS_FONT_SIZE));
}

/* 读初始程序坞图标：只认三个合法 id，其它一律回落默认 */
function loadInitialDockIcon(): DockIconId {
  const raw = readLS(LS_DOCK_ICON);
  if (raw && (VALID_DOCK_ICONS as readonly string[]).includes(raw)) {
    return raw as DockIconId;
  }
  return 'brand';
}

export const useWorkbenchStore = create<WorkbenchState>((set, get) => ({
  /* ===== 主题 ===== */
  theme: loadInitialTheme(),
  setTheme: (t) => {
    set({ theme: t });
    writeLS(LS_THEME, t);
    applyThemeClass(t);
    /* 磨砂玻璃材质要跟着切，否则深色主题配浅色材质 */
    applyNativeWindowTheme(t);
  },
  toggleTheme: () => {
    get().setTheme(get().theme === 'dark' ? 'light' : 'dark');
  },

  /* ===== 当前模块 ===== */
  activeModuleId: readLS(LS_ACTIVE_MODULE) || 'home',
  setActiveModule: (id) => {
    set({ activeModuleId: id });
    writeLS(LS_ACTIVE_MODULE, id);
    get().pushRecentModule(id);
  },

  /* ===== 最近访问 ===== */
  recentModuleIds: readJSON<string[]>(LS_RECENT, []),
  pushRecentModule: (id) =>
    set((state) => {
      const next = [id, ...state.recentModuleIds.filter((x) => x !== id)].slice(0, 6);
      writeLS(LS_RECENT, JSON.stringify(next));
      return { recentModuleIds: next };
    }),

  /* ===== 侧栏 ===== */
  siderCollapsed: readLS(LS_SIDER_COLLAPSED) === '1',
  toggleSider: () =>
    set((state) => {
      const next = !state.siderCollapsed;
      writeLS(LS_SIDER_COLLAPSED, next ? '1' : '0');
      return { siderCollapsed: next };
    }),
  setSiderCollapsed: (v) => {
    writeLS(LS_SIDER_COLLAPSED, v ? '1' : '0');
    set({ siderCollapsed: v });
  },
  siderWidth: (() => {
    const raw = Number(readLS(LS_SIDER_WIDTH));
    if (!Number.isFinite(raw) || raw <= 0) return SIDER_DEFAULT_WIDTH;
    return Math.min(SIDER_MAX_WIDTH, Math.max(SIDER_MIN_WIDTH, raw));
  })(),
  setSiderWidth: (w) => {
    const clamped = Math.min(SIDER_MAX_WIDTH, Math.max(SIDER_MIN_WIDTH, Math.round(w)));
    writeLS(LS_SIDER_WIDTH, String(clamped));
    set({ siderWidth: clamped });
  },

  /* ===== 全局基准字号 ===== */
  fontSize: loadInitialFontSize(),
  setFontSize: (n) => {
    const clamped = clampFontSize(n);
    writeLS(LS_FONT_SIZE, String(clamped));
    applyFontSizeVar(clamped);
    set({ fontSize: clamped });
  },

  /* ===== 程序坞图标 ===== */
  dockIcon: loadInitialDockIcon(),
  setDockIcon: (id) => {
    if (!VALID_DOCK_ICONS.includes(id)) return;
    writeLS(LS_DOCK_ICON, id);
    set({ dockIcon: id });
    /*
     * 异步切 Dock 图标 —— 失败（非 macOS / 权限等）用 try/catch 静默吞掉。
     * 设置页调用方会自己用 message 反馈给用户，不依赖 store 抛错（避免 React
     * 事件处理函数捕获到未处理的 rejection 触发 ErrorBoundary）。
     */
    void applyDockIcon(id).catch(() => {});
  },

  /* ===== 窗口与后台 =====
   * 初值必须与后端 `core/lifecycle.rs::DEFAULT_BACKGROUND_ON_CLOSE` 一致。
   * 因为开关在 `backgroundOnCloseLoaded` 为 false 时处于 loading 态，
   * 这个占位值不会以「用户的设置」的面貌出现，只是首帧的过渡。
   */
  backgroundOnClose: true,
  backgroundOnCloseLoaded: false,
  loadBackgroundOnClose: async () => {
    /* 已经读到过就不再请求：设置页每次进入都会调它，重复请求没有意义 */
    if (get().backgroundOnCloseLoaded) return;
    try {
      const v = await fetchBackgroundOnClose();
      set({ backgroundOnClose: v, backgroundOnCloseLoaded: true });
    } catch (e) {
      /*
       * 读失败也要**结束 loading** —— 否则设置页那个开关会一直转圈，
       * 用户既看不到值、也点不动。留着默认值让他至少能操作，错误由调用方提示。
       */
      set({ backgroundOnCloseLoaded: true });
      throw e;
    }
  },
  setBackgroundOnClose: async (enabled) => {
    /*
     * 先写后端、成功了再改本地镜像 —— 反过来会出现「界面已切、实际没生效」。
     * 写失败就抛给调用方，由设置页用 message 告诉用户。
     */
    const saved = await persistBackgroundOnClose(enabled);
    set({ backgroundOnClose: saved, backgroundOnCloseLoaded: true });
  },

  /* ===== 模块偏好 ===== */
  modulePrefs: readModulePrefs(),
  setModulePref: (id, pref) =>
    set((state) => {
      const next = { ...state.modulePrefs, [id]: { ...state.modulePrefs[id], ...pref } };
      writeLS(LS_MODULE_PREFS, JSON.stringify(next));
      return { modulePrefs: next };
    }),
  resetModulePrefs: () => {
    writeLS(LS_MODULE_PREFS, '{}');
    set({ modulePrefs: {} });
  },

  moduleOrder: readModuleOrder(),
  setGroupModuleOrder: (group, ids) =>
    set((state) => {
      const next = { ...state.moduleOrder, [group]: ids };
      writeLS(LS_MODULE_ORDER, JSON.stringify(next));
      return { moduleOrder: next };
    }),
  resetModuleOrder: () => {
    writeLS(LS_MODULE_ORDER, '{}');
    set({ moduleOrder: {} });
  },

  /*
   * 只有明确的 'grid' 才进卡片视图：旧版本没有这个键、或者值被写坏时，
   * 一律回落到列表（列表是当前的主方案，不该因为一条脏记录被顶掉）。
   */
  homeLayout: readLS(LS_HOME_LAYOUT) === 'grid' ? 'grid' : 'list',
  setHomeLayout: (v) => {
    writeLS(LS_HOME_LAYOUT, v);
    set({ homeLayout: v });
  },

  /* ===== 本地主密钥 ===== */
  masterKey: null,
  masterKeyStatus: 'idle',
  masterKeyError: null,
  masterKeySource: null,
  masterKeyWarning: null,
  ensureMasterKey: (force = false) => {
    if (!force && masterKeyInflight) return masterKeyInflight;
    const p = loadMasterKey(fetchOrCreateMasterKey, set);
    masterKeyInflight = p;
    /* 失败不缓存，下次调用可以重试（成功则一直复用同一把密钥） */
    p.catch(() => {
      if (masterKeyInflight === p) masterKeyInflight = null;
    });
    return p;
  },
  rebuildMasterKey: () => {
    const p = loadMasterKey(resetMasterKey, set);
    masterKeyInflight = p;
    p.catch(() => {
      if (masterKeyInflight === p) masterKeyInflight = null;
    });
    return p;
  },
}));

/* 应用启动时把主题 class 与字号同步到 DOM，避免首帧闪烁 */
export function bootstrapWorkbench(): void {
  const t = useWorkbenchStore.getState().theme;
  applyThemeClass(t);
  /* 原生窗口外观也要在首帧前对齐，否则启动瞬间会闪一下另一种材质的玻璃 */
  applyNativeWindowTheme(t);
  /* 字号同理：模块 CSS 读的是 --wb-font-base，不同步会先按默认值渲染再跳变 */
  applyFontSizeVar(useWorkbenchStore.getState().fontSize);
  /* 启动恢复 Dock 图标 —— 上次选的若不是默认 brand，应用一开就要替换 */
  void applyDockIcon(useWorkbenchStore.getState().dockIcon).catch(() => {});
}
