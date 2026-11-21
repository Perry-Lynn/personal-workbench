/*
 * 工作台级「导出成文件」入口
 * ------------------------------------------------------------------
 * ⚠️ **不要用 `Blob` + `a[download]`。**
 * 在浏览器里那一定落盘，在本应用的 WKWebView 里**什么都不会发生、也不报错** ——
 * wry 的导航代理在「该下载」且应用没注册 `on_download` 时直接 `Cancel` 掉这次
 * 下载，而本应用的主窗口是配置文件声明的，挂不上 `on_download`。
 * 完整取证写在 src-tauri/src/core/export.rs 的文件头。
 *
 * 正确路径是两步：系统保存对话框选路径 → 交给后端写盘。模块只管调这里。
 * @Author: fu
 */
import { save } from '@tauri-apps/plugin-dialog';
import { call } from './ipc';

/** 保存对话框里的文件类型：给用户一个合适的后缀与筛选 */
export interface ExportType {
  /** 类型名，如「日志文件」 */
  label: string;
  /** 扩展名，不带点，如 log */
  ext: string;
}

/**
 * 弹系统保存对话框并写入文本。
 *
 * 返回写入的完整路径；**用户取消时返回 null** —— 那不是错误，
 * 调用方不要弹红条，直接 return 就行。
 */
export async function exportTextFile(
  defaultName: string,
  content: string,
  type: ExportType,
): Promise<string | null> {
  const path = await save({
    defaultPath: defaultName,
    filters: [{ name: type.label, extensions: [type.ext] }],
  });
  if (!path) return null;
  await call<void>('workbench_write_text_file', { path, content });
  return path;
}

/** 文件名清洗：把不适合进文件名的字符换掉（导出默认名用） */
export function safeFileName(name: string, fallback = 'export'): string {
  const base = name.replace(/[^\w\u4e00-\u9fa5.-]/g, '_').replace(/^[._-]+$/, '');
  return base || fallback;
}
