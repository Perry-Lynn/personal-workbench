/*
 * 工作台模块契约
 * ------------------------------------------------------------------
 * 一个「功能」= 一个模块。模块只要实现 WorkbenchModule 接口，
 * 在 core/modules.ts 里注册，就会自动出现在侧栏导航里。
 * 模块之间不直接互相引用，只通过 core 层通信。
 * @Author: fu
 */
import type { ComponentType, ReactNode } from 'react';

/* 模块分组：决定侧栏导航的分区顺序 */
export type ModuleGroup = '总览' | '运维' | '效率' | '内容' | '设备' | '系统';

/* 侧栏分组的展示顺序 */
export const MODULE_GROUP_ORDER: ModuleGroup[] = ['总览', '运维', '效率', '内容', '设备', '系统'];

/* 传给模块组件的 props（模块自身不需要用，保留扩展余地） */
export interface ModuleProps {
  /** 当前模块 id */
  moduleId: string;
}

/*
 * 模块元信息：只描述「是什么」，不含实现
 */
export interface ModuleMeta {
  /** 全局唯一 id，同时作为持久化 key（改动会导致本地偏好丢失） */
  id: string;
  /** 侧栏与卡片上显示的名称 */
  name: string;
  /** 一句话说明，首页卡片与设置页会展示 */
  description?: string;
  /** 侧栏图标 */
  icon: ReactNode;
  /** 所属分组，默认「效率」 */
  group?: ModuleGroup;
  /** 同组内排序，越小越靠前，默认 100 */
  order?: number;
  /** 侧栏搜索用的额外关键词 */
  keywords?: string[];
  /** 是否在侧栏隐藏（仍可通过首页卡片进入） */
  hiddenInSidebar?: boolean;
  /** 版本号，展示在设置页 */
  version?: string;
}

/**
 * 侧栏角标的语义色调。
 *
 * 模块只声明「有多严重」，**具体配色归外壳** —— 换主题或调整配色不必改模块，
 * 而且能保证所有模块的「严重」长得一样。
 */
export type BadgeTone = 'info' | 'warn' | 'danger';

/**
 * 带语义的角标。
 * `text` 为空串或 null 时按「不显示」处理（模块可以借此表达「暂时没有可显示的值」）。
 */
export interface ModuleBadge {
  text: string | number;
  /** 省略等价于 'info' */
  tone?: BadgeTone;
}

/*
 * 完整模块定义：元信息 + 实现
 */
export interface WorkbenchModule extends ModuleMeta {
  /**
   * 模块主体组件，由 ModuleHost 挂载。
   *
   * 根节点的**高度**决定滚动归谁管（外壳不替模块做决定，见 ModuleHost 的 ModulePane）：
   *   · 不写高度（文档式：jvm / jarrunner / maven / spring / snippets / aipassport / balances）
   *     → 内容可以高过面板，由**面板**统一纵向滚动；
   *   · 写 `h-full`（整屏式：home / settings / logsight）
   *     → 面板永不溢出，滚动自己管（内部再放 `overflow-y-auto` 的子容器）。
   *
   * 两种都不会出现双层滚动条。**别在文档式模块的根节点上加 `overflow-y-auto`** ——
   * 那才会真的滚两层。
   */
  component: ComponentType<ModuleProps>;
  /**
   * 是否常驻内存：为 true 时切走不卸载，保留滚动位置与内部状态。
   * 适合有长连接 / 大量本地状态的模块（如 LogSight 的日志流）。
   */
  keepAlive?: boolean;
  /**
   * 侧栏角标，返回 null 表示不显示。
   * 只是「取值函数」，不会自己触发重渲染；需要实时更新请同时提供 badgeSubscribe。
   *
   * 返回原始值 = 等价于 tone:'info'（老模块不用改）；返回 ModuleBadge 可以带上语义色调。
   */
  badge?: () => string | number | ModuleBadge | null;
  /**
   * 角标数据源变化通知。提供后侧栏会在回调触发时重新读取 badge()。
   * 例：badgeSubscribe: (onChange) => useMyStore.subscribe(onChange)
   */
  badgeSubscribe?: (onChange: () => void) => () => void;
  /** 模块被切入时调用（首次挂载之后每次切回都会调用） */
  onActivate?: () => void;
  /** 模块被切走时调用 */
  onDeactivate?: () => void;
}

/* 模块运行态，由 registry 维护 */
/**
 * 模块运行时状态（是否挂载过 / 是否激活）。
 * 零引用（scan:dead 会报）：当前 shell 用 useWorkbenchStore 的 `mountedIds` 集合表达同一件事。
 * 保留为契约形状 —— 日后若把「挂载/激活」抽成一个对象传给模块，用它比散装布尔清晰。
 */
export interface ModuleRuntimeState {
  /** 是否已至少挂载过一次 */
  mounted: boolean;
  /** 是否处于激活状态 */
  active: boolean;
}
