/*
 * 工作台级主密钥能力
 * ------------------------------------------------------------------
 * 主密钥是所有模块加密本地敏感数据（SSH 密码、私钥等）的根密钥，
 * 一个工作台只有一把。后端存储策略是「系统钥匙串优先，本地数据目录兜底」，
 * 所以这里除了密钥本身，还要把「存在哪儿」和「有没有降级告警」带回前端。
 *
 * 这里只做 IPC 封装；**状态放在 useWorkbenchStore**，不要放进模块内部，
 * 因为它是工作台级能力：模块切换/重挂载后依然要能用同一把密钥。
 * @Author: fu
 */
import { call } from '@/core/ipc';

/* 密钥实际存放位置：keychain = 系统钥匙串（首选）；local = 本地数据目录（降级） */
export type MasterKeySource = 'keychain' | 'local';

export interface MasterKeyInfo {
  key: string;
  source: MasterKeySource;
  /* 非致命告警，例如降级到本地存储的原因 */
  warning: string | null;
}

/** 取得主密钥；本地无历史数据时会自动生成并落盘 */
export const fetchOrCreateMasterKey = (): Promise<MasterKeyInfo> =>
  call<MasterKeyInfo>('workbench_get_or_create_master_password');

/** 用户确认钥匙串无法恢复后重建主密钥；旧密文将无法解开，需要重新录入凭据 */
export const resetMasterKey = (): Promise<MasterKeyInfo> =>
  call<MasterKeyInfo>('workbench_reset_master_password');

/** 用主密钥把密文解成明文（密码 / 私钥等） */
export const decryptSecret = (cipherB64: string, masterPassword: string): Promise<string> =>
  call<string>('workbench_decrypt_secret', { cipherB64, masterPassword });
