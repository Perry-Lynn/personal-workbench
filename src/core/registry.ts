/*
 * 工作台模块注册表
 * ------------------------------------------------------------------
 * 极简注册中心：模块在 core/modules.ts 里声明，启动时注册一次。
 * 提供查询能力给侧栏导航、首页卡片、设置页模块管理使用。
 *
 * 注意：注册表本身不持有 React 状态，模块的运行态（是否挂载/激活）
 * 由 ModuleHost 用本地 state 维护，避免全局 store 频繁重渲染。
 * @Author: fu
 */
import type { ModuleGroup, ModuleMeta, WorkbenchModule } from './types';
import { MODULE_GROUP_ORDER } from './types';

/* id -> 模块定义 */
const registry = new Map<string, WorkbenchModule>();
/* 注册顺序，用于同 order 时的稳定排序 */
const registeredOrder: string[] = [];

/* 已注册模块数变化时的订阅者（设置页 / 侧栏需要感知） */
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((fn) => {
    try {
      fn();
    } catch (_) {
      /* 单个订阅者异常不影响其它订阅者 */
    }
  });
}

/**
 * 注册一个模块。重复注册同一 id 会覆盖旧定义并告警。
 * 只能在 core/modules.ts 中调用，避免模块散落注册导致顺序不确定。
 */
export function registerModule(mod: WorkbenchModule): void {
  if (!mod?.id) {
    console.warn('[workbench] 忽略无 id 的模块注册');
    return;
  }
  if (registry.has(mod.id)) {
    console.warn(`[workbench] 模块 ${mod.id} 重复注册，已用新定义覆盖`);
  } else {
    registeredOrder.push(mod.id);
  }
  registry.set(mod.id, mod);
  notify();
}

/** 批量注册 */
export function registerModules(mods: WorkbenchModule[]): void {
  mods.forEach(registerModule);
}

/** 按 id 取模块定义 */
export function getModule(id: string | null | undefined): WorkbenchModule | undefined {
  if (!id) return undefined;
  return registry.get(id);
}

/** 全部模块（按 分组顺序 -> order -> 注册顺序 排序） */
export function listModules(): WorkbenchModule[] {
  return [...registry.values()].sort(compareModule);
}

/*
 * 注意：这里**故意没有** listSidebarModules()。
 * 侧栏要的过滤条件是 `!m.hiddenInSidebar && !用户偏好.hidden`：
 *   · `m.hiddenInSidebar` 是模块自己声明的（模块作者说「我不适合放侧栏」）；
 *   · `用户偏好.hidden` 是用户在设置页逐个关掉的，语义是「整个收起来」——
 *     首页卡片与侧栏同时消失，所以首页也得套同一层过滤（见 features/home/HomeView.tsx）。
 * 只按 m.hiddenInSidebar 过滤会漏掉用户偏好 —— 想加回这个函数前，先确认调用方不需要那一层。
 */

/** 按分组聚合，供侧栏分区渲染；空分组会被剔除 */
export function groupModules(
  mods: WorkbenchModule[] = listModules(),
): Array<{ group: ModuleGroup; modules: WorkbenchModule[] }> {
  const buckets = new Map<ModuleGroup, WorkbenchModule[]>();
  mods.forEach((m) => {
    const g = (m.group ?? '效率') as ModuleGroup;
    const arr = buckets.get(g);
    if (arr) arr.push(m);
    else buckets.set(g, [m]);
  });

  return MODULE_GROUP_ORDER.filter((g) => (buckets.get(g)?.length ?? 0) > 0).map((g) => ({
    group: g,
    modules: buckets.get(g)!.slice().sort(compareModule),
  }));
}

/** 侧栏搜索：匹配名称 / 描述 / 关键词 */
export function searchModules(keyword: string, mods: WorkbenchModule[] = listModules()): WorkbenchModule[] {
  const kw = keyword.trim().toLowerCase();
  if (!kw) return mods;
  return mods.filter((m) => {
    const hay = [m.name, m.description ?? '', m.id, ...(m.keywords ?? [])]
      .join(' ')
      .toLowerCase();
    return hay.includes(kw);
  });
}

/** 订阅注册表变化，返回取消订阅函数 */
export function subscribeModules(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * 清空注册表。仅测试/热更新场景使用。
 * 零引用（scan:dead 会报）：当前没有测试用到它 —— 保留，它是注册表唯一的「反向操作」，
 * 去掉之后热更新想重新注册就没了入口。
 */
export function clearModules(): void {
  registry.clear();
  registeredOrder.length = 0;
  notify();
}

/* 排序规则：分组顺序优先，其次 order，最后注册顺序 */
function compareModule(a: ModuleMeta, b: ModuleMeta): number {
  const ga = MODULE_GROUP_ORDER.indexOf((a.group ?? '效率') as ModuleGroup);
  const gb = MODULE_GROUP_ORDER.indexOf((b.group ?? '效率') as ModuleGroup);
  if (ga !== gb) return ga - gb;
  const oa = a.order ?? 100;
  const ob = b.order ?? 100;
  if (oa !== ob) return oa - ob;
  return registeredOrder.indexOf(a.id) - registeredOrder.indexOf(b.id);
}
