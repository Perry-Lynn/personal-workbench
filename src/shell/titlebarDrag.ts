/*
 * 窗口拖动（macOS 上就是「抓住顶栏把窗口挪走」）
 * ------------------------------------------------------------------
 * 为什么需要这个文件：
 *   之前顶栏挂的 `.mac-titlebar-drag` 用的是 **`-webkit-app-region: drag`** ——
 *   那是 **Electron / Chromium 专有**的属性。本应用的 WebView 是 WKWebView，
 *   **不认它**，所以那个类从来没生效过（名字来自一份 Electron 味的模板）。
 *   结果：顶栏在系统眼里就是普通网页内容，唯一能拖的地方只剩
 *   `titleBarStyle: "Overlay"` 留下的那条原生标题栏（约 28px，被顶栏盖住看不见）；
 *   而窗口最上沿几像素又是**缩放边框**，于是「点顶栏」拿到的是竖向缩放光标，
 *   拖动只会改高度、不会移动窗口。
 *
 * 为什么不用官方的 `data-tauri-drag-region`：
 *   它**只作用于直接挂属性的那个元素，子元素不继承**（官方文档明确写了），
 *   顶栏里的文字、弹性占位、侧栏品牌块都得各挂一遍，且 `.mac-titlebar-nd`
 *   那套「这块别拖」的标记会全部失效。这里改用等价的手写实现，一个处理函数管住整条栏。
 *
 * ⚠️ 这里用**静态** import，与 store 里 setTheme 的动态 import 不同：
 *   `startDragging()` 必须在 mousedown 的**同一个同步栈**里调用 ——
 *   先 `await` 一个动态 import 会插进一个任务边界，手势已经结束，
 *   窗口不会动、而且**不报任何错**（最难查的那种失败）。
 *   这个模块是外壳的核心交互，进首屏 chunk 是应该的；它依赖的
 *   `@tauri-apps/api/core` 本来就已经被 `core/ipc.ts` 静态引进了。
 * @Author: fu
 */
import React from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';

/**
 * 落在这些元素上时**不**开始拖动（否则按钮点不动、输入框选不了字）。
 *
 * `.mac-titlebar-nd` 是历史标记（原本给 Electron 的 `no-drag` 用），
 * 现在改由这个选择器解释 —— 所以它仍然有效，只是执行者从 CSS 换成了 JS。
 */
const NO_DRAG =
  'button, a, input, textarea, select, [role="button"], [role="switch"], .mac-titlebar-nd';

/**
 * 顶栏 / 侧栏品牌区的 mousedown 处理。
 *
 * 双击 = 最大化：这是 macOS 标题栏的既有习惯。原生标题栏被 Overlay 盖住之后
 * 得由我们补上，否则用户会以为这窗口不能最大化。
 * （能力文件里 `allow-start-dragging` / `allow-toggle-maximize` 本来就已经授权了。）
 */
export function onTitlebarMouseDown(e: React.MouseEvent): void {
  if (e.button !== 0) return; // 只认左键

  const target = e.target as HTMLElement | null;
  if (target?.closest(NO_DRAG)) return; // 控件上放行，让按钮/输入框正常工作

  try {
    const win = getCurrentWindow();
    if (e.detail === 2) {
      void win.toggleMaximize().catch(() => {});
      return;
    }
    /*
     * 拦掉默认行为，免得浏览器自己起一个「拖选文本」的手势把这次 mousedown 吃掉。
     * 这里已经排除了输入框，所以不会影响聚焦。
     */
    e.preventDefault();
    void win.startDragging().catch(() => {});
  } catch {
    /* 非 Tauri 环境（例如浏览器里跑 vite dev）：没有窗口可拖，忽略 */
  }
}
