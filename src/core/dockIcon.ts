/*
 * 程序坞图标 · 前端 IPC 封装
 * ------------------------------------------------------------------
 * 设置页选图标 → 调 applyDockIcon(id) → 后端 workbench_set_dock_icon
 * → NSApp.setApplicationIconImage_ 切换 Dock 图。
 *
 * 几个细节：
 *   1. 列表在编译期硬编码（与 src-tauri/src/core/dock.rs 一一对应），
 *      不调后端的 list_dock_icons —— 因为设置页选择器需要 thumbnail 路径，
 *      那一份由前端用静态 import 处理更简单
 *   2. 切换失败（非 macOS 等）抛错给调用方，由 SettingsView 弹 message.error
 *   3. 模块名 dockIcon（不带 workbench 前缀），与设置页归属的工作台级 IPC 命名一致
 * @Author: fu
 */
import { invoke } from '@tauri-apps/api/core';
import type { DockIconId } from '@/store/useWorkbenchStore';

/*
 * 可用图标清单：与 src-tauri/icons/dock/ 下的 PNG 一一对应。
 * thumbnail 走 Vite public 静态资源（/dock-icons/*.png），
 * 运行时切 Dock 用的 PNG 由 Rust 侧 include_bytes! 嵌入，无需前端关心。
 */
export interface DockIconMeta {
  id: DockIconId;
  name: string;
  description: string;
  thumbnail: string;
}

export const DOCK_ICONS: readonly DockIconMeta[] = [
  {
    id: 'brand',
    name: '品牌',
    description: '深底 + 翠绿品牌光晕 + 模块色点',
    thumbnail: '/dock-icons/brand.png',
  },
  {
    id: 'mono',
    name: '极简',
    description: '纯灰阶，低调不抢眼',
    thumbnail: '/dock-icons/mono.png',
  },
  {
    id: 'prism',
    name: '棱镜',
    description: '彩虹渐变 W，活泼有辨识度',
    thumbnail: '/dock-icons/prism.png',
  },
];

/* 切换程序坞图标；非 macOS 平台会抛错（设置页在非 mac 上就不该显示选择器） */
export async function applyDockIcon(id: DockIconId): Promise<void> {
  await invoke('workbench_set_dock_icon', { iconId: id });
}