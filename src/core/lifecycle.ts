/*
 * 窗口生命周期 · 前端 IPC 封装
 * ------------------------------------------------------------------
 * 对应后端 src-tauri/src/core/lifecycle.rs：关窗后是否转入后台运行。
 *
 * 与 dockIcon.ts / tray.ts 的定位一致 —— 只做「拆包 + 抛错」，
 * 业务判断留在调用方（设置页 / store）。
 * @Author: fu
 */
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { call } from '@/core/ipc';

/** 与后端 `core/lifecycle.rs` 的 `EVENT_BACKGROUND_CHANGED` 对应 */
const EVENT_BACKGROUND_CHANGED = 'workbench:background-changed';

/**
 * 读取「关闭窗口后转入后台」设置。
 *
 * 后端只读内存里的原子量（启动时已从 sled 读入），所以这个调用很快。
 */
export async function getBackgroundOnClose(): Promise<boolean> {
  return call<boolean>('workbench_get_background_on_close');
}

/**
 * 修改「关闭窗口后转入后台」设置，返回落盘后的值。
 *
 * 失败会抛错 —— 这个设置必须让用户知道有没有生效，
 * 否则他关窗之后才发现应用被杀了、或者反过来以为不会退出却退出了。
 */
export async function setBackgroundOnClose(enabled: boolean): Promise<boolean> {
  return call<boolean>('workbench_set_background_on_close', { enabled });
}

/**
 * 订阅「窗口转入后台 / 回到前台」，回调参数 `true` = 已转入后台。
 *
 * ⚠️ 与 `workbench:app-closing` 不是一回事：转后台时**刻意不发**那个事件
 * （SSH 日志流要继续跑），所以判断「窗口还在不在」只能用这个。
 *
 * 用途：停掉那些**只在窗口可见时才有意义**的定时任务。系统确实会对隐藏页面的
 * 定时器做节流，但那是尽力而为 —— 而且节流期间倒计时会停在过期值上，
 * 显式停 / 恢复比依赖节流可预测（见 `features/jvm/service.ts` 的自动扫描）。
 *
 * 返回取消订阅函数。拿不到事件总线时（纯浏览器 `npm run dev`）静默返回空函数，
 * 让界面照常能调试。
 */
export async function onBackgroundChanged(
  cb: (inBackground: boolean) => void,
): Promise<UnlistenFn> {
  try {
    return await listen<boolean>(EVENT_BACKGROUND_CHANGED, (e) => cb(e.payload === true));
  } catch {
    return () => {};
  }
}
