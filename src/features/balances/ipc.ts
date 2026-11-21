/*
 * 智能体余额模块 · IPC 封装
 * 命令前缀 balances_，统一走 @/core/ipc 的 call()（自动拆 ApiResponse）。
 * master_key 由调用方从 useWorkbenchStore 取后传入（与 decryptSecret 同一约定）。
 */
import { call } from '@/core/ipc';
import type { AgentBalance, ProviderMeta } from './types';

/**
 * 把自动刷新排期下发给后端调度器（启动 / 偏好变化时调用）。
 * 后端据此持有各平台的 next_at，并在后台定时器里真正发起取数。
 * 返回各平台「下次刷新时刻」地图，前端用来显示倒计时。
 */
export const setRefreshPlan = (
  enabled: boolean,
  globalMin: number,
  overrides: Record<string, number>,
  masterKey: string | null,
): Promise<Record<string, number>> =>
  call<Record<string, number>>('balances_set_refresh_plan', {
    enabled,
    globalMin,
    overrides,
    masterKey: masterKey ?? null,
  });

/**
 * 手动刷新后调用：把指定平台（或全平台，传 null）的 next_at 往后拨，
 * 后端返回最新排期地图供前端显示倒计时。
 */
export const reschedule = (provider: string | null): Promise<Record<string, number>> =>
  call<Record<string, number>>('balances_reschedule', { provider: provider ?? null });

/** 列出全部平台元信息 */
export const listProviders = (): Promise<ProviderMeta[]> =>
  call<ProviderMeta[]>('balances_list_providers');

/**
 * 保存某平台凭证（整张字段表加密落 sled）。
 * fields 的键来自 ProviderMeta.credential_fields —— 单字段平台是 { access_token }，
 * Trae 是 { authorization, cookie }。
 */
export const saveCredential = (
  provider: string,
  fields: Record<string, string>,
  accountId: string | null,
  masterKey: string,
): Promise<void> =>
  call<void>('balances_save_credential', {
    provider,
    fields,
    accountId,
    masterKey,
  });

/**
 * 一键抓取某平台的网页登录态（目前仅 Trae）：借本机 Chrome 的登录态，
 * 抓到后后端会先用它真调一次取数接口自校验，通过才返回。
 * 返回的就是该平台字段表的键 → 值，可直接回填到「配置」弹窗。
 * ⚠️ 最长约 2 分钟（会临时起一个 Chrome；无窗口抓不到时会弹可见窗口让用户登录）。
 */
export const grabSession = (provider: string): Promise<Record<string, string>> =>
  call<Record<string, string>>('balances_grab_session', { provider });

/** 删除某平台凭证 */
export const deleteCredential = (provider: string): Promise<void> =>
  call<void>('balances_delete_credential', { provider });

/**
 * 拉取所有已配置平台余额。
 * masterKey 可为 null —— 后端会跳过密文解密、改用 ~/.codex/auth.json，
 * 这样打开面板不会触发系统钥匙串授权框（工作台约定：只有 LogSight 需要密钥）。
 */
export const refresh = (masterKey: string | null): Promise<AgentBalance[]> =>
  call<AgentBalance[]>('balances_refresh', { masterKey: masterKey ?? null });

/** 只拉取某一个平台的余额（单平台独立刷新用） */
export const refreshOne = (
  provider: string,
  masterKey: string | null,
): Promise<AgentBalance> =>
  call<AgentBalance>('balances_refresh_one', {
    provider,
    masterKey: masterKey ?? null,
  });

/** 探测 Codex CLI 是否已登录 */
export const autodetectCodex = (): Promise<boolean> =>
  call<boolean>('balances_autodetect_codex');

/** 手动录入某平台余额（无公开接口的平台，如 Trae / WorkBuddy） */
export const saveManual = (provider: string, label: string, value: string): Promise<void> =>
  call<void>('balances_save_manual', { provider, label, value });

/**
 * 清除某平台的手动录入余额。
 * 入口在余额卡片的「清除」按钮（仅当 `ProviderMeta.has_manual` 为真时出现）——
 * 手动录入与凭证是两条独立的存储，所以「删除凭证」删不掉手动值，必须单给一个入口。
 */
export const clearManual = (provider: string): Promise<void> =>
  call<void>('balances_clear_manual', { provider });
