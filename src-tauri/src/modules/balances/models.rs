/*
 * 智能体余额模块 · 数据模型
 * ------------------------------------------------------------------
 * 各平台的「余额/用量」形态差异很大：ChatGPT 是用量百分比 + 重置时间，
 * OpenAI API 是美元额度，Claude 是用量/信用额……因此这里用「归一化的键值项」
 * 而非固定字段，便于将来接入任意平台而不改结构。
 *
 * 前端对应：src/features/balances/types.ts
 * @Author: fu
 */
use serde::{Deserialize, Serialize};

/* 余额/用量的一种展示形态 */
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BalanceKind {
    /* 用量百分比（如 ChatGPT Plus 的时段/周窗口已用%） */
    UsagePercent,
    /* 货币额度（如 OpenAI API 的美元剩余） */
    Currency,
    /* 手动录入 / 待配置（无接口可拉） */
    Manual,
}

/* 一条归一化的展示项，例如「本时段已用 / 24% / 重置 14:30」 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BalanceItem {
    pub label: String,
    pub value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sub: Option<String>,
    /*
     * 已用百分比（0~100）。**只在「value 不是百分比、但上限已知」时才给** ——
     * 典型是 Qoder 的个人额度：团队账号里个人额度用完、组织池还有余额是常态，
     * 那时它被降级成绝对值展示（`3000 credits`），于是「用完」这件事在界面上
     * 只剩一个数字，没有任何颜色信号。
     *
     * ⚠️ 它的用途**只有一个：染色**（见前端 format.ts 的 itemHealth）。
     * 它**不进告警轴** —— `worstHealth` 仍只认 value 本身就是百分比的项，
     * 否则侧栏角标会在「组织池还有两万 credits」时报 0%。
     * 两件事要分开，是因为它们问的不是同一个问题：颜色问「这个池自己满不满」，
     * 告警问「还有没有得用」。
     *
     * value 本身已经是百分比的项（ChatGPT 的「本时段已用 24%」等）**留 None** ——
     * 那条路早就被 healthPercentOf 覆盖了，再填一遍只是同一事实的第二个来源。
     */
    #[serde(skip_serializing_if = "Option::is_none")]
    pub used_percent: Option<f64>,
    /*
     * 这条指标所属窗口的**重置时刻**（Unix 秒）。只有「按窗口限流」的指标才有
     * （ChatGPT 的「本时段已用」「本周已用」），其余平台/指标留 None。
     *
     * ⚠️ 与 `sub` 里的「重置 10-30 14:23」是同一事实的两种形态，**不能互相替代**：
     *   sub   是给人看的现成文本，随界面渲染；
     *   resetAt 是机器值，专供徽章自己算「2 小时后重置」。
     * 徽章有独立 NTP，推文本过去在断连后会永久停在错误的时刻上
     * （与「刷新时刻推 Unix 秒而不是短语」同一条理由，见 device.ts 文件头）。
     */
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reset_at: Option<i64>,
}

/* 单个平台的余额快照 */
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentBalance {
    /* 平台 id，如 chatgpt / openai / claude */
    pub provider: String,
    /* 展示名，如 ChatGPT Plus */
    pub name: String,
    pub kind: BalanceKind,
    pub items: Vec<BalanceItem>,
    /* 原始链接或备注（如对应控制台地址） */
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw: Option<String>,
    /* 刷新时间（Unix 秒） */
    pub refreshed_at: i64,
    /* 拉取失败原因（有则本平台降级展示错误） */
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/*
 * 凭证字段声明：驱动前端「配置」弹窗渲染成几个输入框。
 * ------------------------------------------------------------------
 * 平台之间需要的凭证**条数并不一样**：ChatGPT / Qoder / OpenAI 只要一条
 * access_token（或 apiKey），而 Trae 网页登录态是**两段**
 * （authorization 与 cookie，缺一不可）。
 * 所以字段表由后端声明、前端照着渲染 —— 前端不再写死「access_token」，
 * 新增平台时只改后端一处，界面自动出现对应输入框（与 uTools 插件里
 * adapter 的 credentialFields 是同一套思路）。
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CredField {
    /* 提交时的键名，如 authorization / cookie / access_token */
    pub key: String,
    /* 输入框标签 */
    pub label: String,
    /* 输入框类型：text（明文）/ password（掩码）/ textarea（长文本，Cookie 用） */
    #[serde(rename = "type")]
    pub input_type: String,
    /* 是否必填（保存前校验） */
    pub required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
}

/* 平台元信息（前端用来渲染录入框/状态，不携带密钥） */
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderMeta {
    pub id: String,
    pub name: String,
    pub kind: BalanceKind,
    /* 一句话说明，如「ChatGPT Plus 用量百分比」 */
    pub description: String,
    /* 是否需要用户提供 access_token / API Key */
    pub requires_token: bool,
    /* 是否已存有凭证（决定前端显示「已配置」） */
    pub has_credential: bool,
    /*
     * 是否已录入「手动余额」（决定前端显示「清除」）。
     *
     * 与 has_credential 是**两条独立的存储**：凭证是密文（`balances:<id>`），
     * 手动值是明文（`balances:manual:<id>`）。所以同一个平台可能两者都有
     * （例如 chatgpt 配了 token、又补了一条手动兜底值），前端要能分别
     * 「删除凭证」与「清除手动余额」—— 少一个入口就会出现「只能覆盖、删不掉」。
     */
    pub has_manual: bool,
    /* 凭证录入提示 */
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_hint: Option<String>,
    /*
     * 「配置」弹窗要渲染的凭证字段。空数组 = 不需要凭证（如免配置的本机 CLI 平台）。
     * 前端据此渲染输入框；提交时以 key → value 的表喂回 balances_save_credential。
     */
    pub credential_fields: Vec<CredField>,
    /* 是否支持「一键抓取网页登录态」（自动读取本机 Chrome 登录态并回填凭证） */
    pub has_grab: bool,
    /* 抓取按钮旁的补充说明；无抓取能力时为 None */
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grab_hint: Option<String>,
    /* 对应控制台/文档链接 */
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doc_url: Option<String>,
}

/* 一份已存凭证（加密后落 sled；这里仅描述结构） */
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredCredential {
    /* 加密后的凭证**字段表 JSON**（Base64）。
     * 老数据里解出来是裸 token —— 读取时按「JSON 对象 / 裸 token」两条路兼容，见 storage.rs。 */
    pub token_cipher: String,
    /* 可选 account_id（非敏感，明文存） */
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
}

/* 自动检测到的 Codex CLI 凭证（来自 ~/.codex/auth.json，不落盘） */
#[derive(Debug, Clone)]
pub struct DetectedCodexCredential {
    pub access_token: String,
    pub account_id: Option<String>,
}

/* 手动录入的余额条目（无公开接口的平台用，如 Trae / WorkBuddy） */
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManualEntry {
    pub label: String,
    pub value: String,
}

/*
 * 「今日用量」的本地基线（差分累计用）。
 * ------------------------------------------------------------------
 * Qoder 这类平台只给**当月累计**的 used，**接口里没有「今日」这一维**
 * （2026-09-23 抓真实 get_usage_info 响应确认：只有 userQuota / addOnQuota /
 * orgResourcePackage 三个池，全是周期累计值，没有任何当日字段）。
 * 所以「今天用了多少」只能由我们本地差分：记住「今天开始时是多少」，
 * 当前值减它就是今天的增量 —— 本结构就是那个被记住的锚点。
 *
 * 三个字段各有分工，缺一不可：
 *   day  —— 基线所属的自然日（本地时区 YYYY-MM-DD）。跨天判据。
 *   base —— **今日**的起始值。同天多次刷新时它不动，增量 = 当前 − base。
 *   last —— 最近一次观测到的值。**跨天时它成为新一天的 base**：
 *           这样今天第一次刷新就能算出完整的今日用量（含凌晨到现在的部分），
 *           若改用「今天首次观测值」做 base，那一段会被漏掉。
 *
 * 非敏感数据（只是几个用量数字），明文落 sled，不加密。
 * 放在 models 而不是 qoder_cli：将来别的平台（ChatGPT 周窗口等）
 * 要算「今日」时复用同一套结构，不必再发明一次。
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DayMark {
    pub day: String,
    pub base: f64,
    pub last: f64,
}

