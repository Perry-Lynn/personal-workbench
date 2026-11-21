/*
 * 系统菜单栏 · 前端 IPC 封装
 * ------------------------------------------------------------------
 * 工作台级共用能力：把若干格内容挂到系统菜单栏上（见 src-tauri/src/core/tray.rs）。
 * 本文件不认识「余额」—— 内容由调用方算好传进来，与 core 里其它能力的定位一致。
 *
 * 与 dockIcon.ts 的差别：那边后端返回 `Result<(), String>`，所以直接用 invoke；
 * 这边后端返回统一的 ApiResponse<T>，走 @/core/ipc 的 call()（自动拆包 + 抛错）。
 *
 * ⚠️ **主项（关窗转后台的兜底入口）不在这里管** —— 它的可见性只由 Rust 侧的
 * `core::lifecycle` 决定。这里只声明「每个智能体那一格」。
 * 两边混在一起曾经导致过一个致命故障：余额模块关掉菜单栏显示时把唯一入口
 * 一起藏掉，用户既没有 Dock 图标也没有菜单栏项，只能去活动监视器杀进程。
 * @Author: fu
 */
import { call } from '@/core/ipc';

/** 一个状态项的图标位图：边长 size 的正方形，RGBA 逐像素 */
export interface TrayIconPayload {
  size: number;
  /** ⚠️ 必须是**普通数组**。`getImageData().data` 是 Uint8ClampedArray，
   *  JSON 序列化后会变成 `{"0":..}` 这种对象，Rust 的 Vec<u8> 收不了。
   *  见 features/balances/icons.ts 里那段说明。 */
  rgba: number[];
}

/** 一个状态项的内容 */
export interface TrayItemPayload {
  /** 稳定标识（用后端 provider id）。Rust 用它拼状态项 id */
  key: string;
  /** 状态项上的文字 */
  title: string;
  /** 悬停提示，可多行；null = 不设提示 */
  tooltip: string | null;
  /** false 时该项被移除（配置留在后端 attrs 里，再开原样恢复） */
  visible: boolean;
  /** 图标；null = 这一格只有文字 */
  icon: TrayIconPayload | null;
  /**
   * 右键菜单里这一格下面的只读明细行（空数组 = 不额外挂明细）。
   * Rust 侧把它们渲染成普通菜单项（非禁用态，否则浅色外观下是浅灰看不清），
   * 并在前面加一条分组标题（detailTitle）。
   */
  details: string[];
  /** 明细的分组标题；null = 没有标题，明细直接列出 */
  detailTitle: string | null;
}

/**
 * 同步菜单栏上的智能体状态项。**语义是全量声明**：
 * `items` 就是「此刻应该存在的全部项」，上一轮建过、这一轮没声明的会被自动藏掉，
 * 所以调用方不需要自己记「上次发了什么」。
 *
 * 返回**可见的项数** —— 调用方把它写进诊断键，于是不看菜单栏也能确认
 * 「到底推上去了几格」。传空数组 = 全部移除。
 *
 * 失败（非 macOS、系统不允许）会抛错，调用方应当**静默降级**：
 * 菜单栏不可用不该影响余额功能本身。
 *
 * ## 关于负载大小（已知且接受）
 *   每个图标是 36×36 RGBA = 5184 个字节，JSON 成数字数组约 20KB；
 *   十来个平台一次同步约 200KB。听起来不小，但：① 只在**内容真的变了**时才发
 *   （调用方按内容去重）；② 本地 IPC，实测毫秒级。
 *   真到了要优化的那天，正确做法是给图标加一个「按 key 缓存」的旁路命令，
 *   而不是把图标做小（18pt 是 macOS 菜单栏的硬尺寸，做小只会糊）。
 */
export async function syncTrayItems(items: TrayItemPayload[]): Promise<number> {
  return await call<number>('workbench_tray_sync', { items });
}
