/*
 * 智能体余额模块 · 前端类型
 * 与后端 src-tauri/src/modules/balances/models.rs 一一对应。
 */

/** 余额展示形态 */
export type BalanceKind = 'usagepercent' | 'currency' | 'manual';

/** 一条归一化展示项 */
export interface BalanceItem {
  label: string;
  value: string;
  sub?: string | null;
  /*
   * 已用百分比（0~100）。**只在「value 不是百分比、但上限已知」时**才有值，
   * 典型是 Qoder 的个人额度（团队账号里被降级成绝对值展示，但仍带百分比供染色）。
   * ⚠️ 只用于染色，不进告警轴：侧栏角标仍只看 value 本身就是百分比的项。
   */
  usedPercent?: number | null;
  /*
   * 这条指标所属窗口的**重置时刻**（Unix 秒）。只有按窗口限流的指标才有
   * （ChatGPT 的「本时段已用」「本周已用」），其余留空。
   * ⚠️ 与 `sub` 里的「重置 10月30日 14:23」不是同一份东西：那是给人看的文本，
   * 这是给徽章算相对时间用的机器值（设备有自己的 NTP）。
   */
  resetAt?: number | null;
}

/** 单个平台余额快照 */
export interface AgentBalance {
  provider: string;
  name: string;
  kind: BalanceKind;
  items: BalanceItem[];
  raw?: string | null;
  refreshed_at: number;
  error?: string | null;
}

/** 凭证输入框类型：text 明文 / password 掩码 / textarea 长文本（如整段 Cookie） */
export type CredFieldType = 'text' | 'password' | 'textarea';

/**
 * 一个平台要用户填的一段凭证。
 * 由后端 ProviderMeta 声明（见 models.rs 的 CredField），「配置」弹窗照着渲染 ——
 * ChatGPT 只有一条 access_token，Trae 要 authorization + cookie 两条。
 */
export interface CredField {
  key: string;
  label: string;
  type: CredFieldType;
  required: boolean;
  placeholder?: string | null;
}

/** 平台元信息 */
export interface ProviderMeta {
  id: string;
  name: string;
  kind: BalanceKind;
  description: string;
  requires_token: boolean;
  has_credential: boolean;
  /** 是否已录入手动余额（决定是否显示「清除」）。与 has_credential 相互独立。 */
  has_manual: boolean;
  token_hint?: string | null;
  /** 「配置」弹窗要渲染的凭证字段；空数组 = 不需要凭证（免配置平台） */
  credential_fields: CredField[];
  /** 是否支持「一键抓取网页登录态」（自动读本机 Chrome 登录态并回填）。目前仅 Trae。 */
  has_grab: boolean;
  /** 抓取按钮旁的说明；无抓取能力时为空 */
  grab_hint?: string | null;
  doc_url?: string | null;
}

/** 蓝牙推送类别（与 aipassport 固件协议一致） */
export type PushCategory = 'SCHED' | 'REMIND' | 'MSG';
