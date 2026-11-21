/*
 * 剪贴板
 * ------------------------------------------------------------------
 * 复制一段文本。先走 Tauri 插件（权限已在 capabilities 里开：
 * clipboard-manager:allow-write-text），失败再退回 Web 的 navigator.clipboard。
 *
 * 为什么要留这条退路：插件这条路要过 IPC 再到系统剪贴板，而 WKWebView 里
 * navigator.clipboard 也是可用的。两条同时坏的概率远低于单独一条，
 * 而「点了复制没反应」是用户完全无法自查的一类问题 —— 宁可多试一条路。
 *
 * 失败时抛出 Error，文案可直接展示给用户；提示方式（message / 静默）由调用方决定。
 * @Author: fu
 */
import { writeText } from '@tauri-apps/plugin-clipboard-manager';

/** 复制文本到剪贴板；失败抛错 */
export async function copyText(text: string): Promise<void> {
  let pluginErr: unknown = null;
  try {
    await writeText(text);
    return;
  } catch (e) {
    pluginErr = e;
  }

  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    /*
     * 两条都失败。报**插件那条**错误：它更能说明问题（权限没开、IPC 挂了），
     * 而 navigator.clipboard 失败通常只是「不是安全上下文」这种噪音。
     */
    const reason = pluginErr instanceof Error ? pluginErr.message : String(pluginErr ?? '未知原因');
    throw new Error(`复制失败：${reason}（可手动选中后复制）`);
  }
}
