/*
 * 智能体余额模块 · Tauri IPC 命令层
 * ------------------------------------------------------------------
 * 命令前缀 balances_，返回统一 ApiResponse<T>。凭证经 master_key 加解密
 *（与 workbench_decrypt_secret 同一约定：主密钥由前端经 IPC 传入）。
 *
 * 命令清单：
 *   balances_list_providers   列出全部平台元信息（含是否已配置 + 凭证字段声明）
 *   balances_save_credential   保存某平台凭证（字段表加密落 sled）
 *   balances_delete_credential 删除某平台凭证
 *   balances_grab_session      一键抓取网页登录态（借本机 Chrome，目前仅 Trae）
 *   balances_refresh           拉取所有已配置平台的余额/用量（并发）
 *   balances_autodetect_codex  探测 ~/.codex/auth.json 是否存在（仅提示，不落盘）
 * @Author: fu
 */
use std::collections::BTreeMap;

use tauri::{command, AppHandle, Emitter};

use crate::core::api::ApiResponse;
use crate::core::storage::app_data_dir;
use crate::modules::balances::chatgpt;
use crate::modules::balances::grab;
use crate::modules::balances::models::{
    AgentBalance, BalanceItem, BalanceKind, CredField, ProviderMeta,
};
use crate::modules::balances::qoder;
use crate::modules::balances::qoder_cli;
use crate::modules::balances::storage;
use crate::modules::balances::trae;

fn now_secs() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/* 全部已登记平台（新增平台在此追加；只有 chatgpt 当前有可用拉取实现） */
fn all_providers() -> Vec<(&'static str, &'static str, BalanceKind, &'static str, bool, &'static str, &'static str)> {
    vec![
        (
            "chatgpt",
            "ChatGPT",
            BalanceKind::UsagePercent,
            "ChatGPT Plus / Pro 用量百分比（时段 / 周窗口）",
            true,
            "提供 access_token：已装 Codex CLI 可直接用；否则从 chatgpt.com/api/auth/session 取 accessToken 粘贴",
            "https://chatgpt.com",
        ),
        (
            "qoder",
            "Qoder CN",
            BalanceKind::UsagePercent,
            "Qoder CN 额度用量（Credits）—— 免配置，自动读取本机 qoderclicn",
            true,
            "无需凭证：自动调用本机 qoderclicn（需已登录过一次）。\
             机器上没装 CLI 时，可粘贴个人版 PAT 作为兜底（团队 / 企业账号请走 CLI）",
            "https://qoder.cn/account/usage",
        ),
        (
            "openai",
            "OpenAI API",
            BalanceKind::Currency,
            "OpenAI API 平台额度（美元，需 API Key）",
            true,
            "提供 OpenAI API Key（platform.openai.com → API keys）",
            "https://platform.openai.com/account/usage",
        ),
        (
            "claude",
            "Claude",
            BalanceKind::Currency,
            "Anthropic 用量 / 信用额（需 Admin API Key）",
            true,
            "提供 Anthropic Admin API Key（console.anthropic.com）",
            "https://console.anthropic.com/settings/billing",
        ),
        (
            "gemini",
            "Gemini",
            BalanceKind::Currency,
            "Gemini API 预付费额度（需 GCP Cloud Billing）",
            true,
            "提供 Gemini API Key，并绑定 Google Cloud Billing 项目",
            "https://aistudio.google.com/u/1/apikey",
        ),
        (
            "trae",
            "Trae",
            BalanceKind::UsagePercent,
            "Trae 订阅额度（credits 总额 / 已用 / 剩余 + 已用比例，走网页登录态）",
            true,
            "Trae 无公开余额 API：用「一键抓取」读取本机 Chrome 登录态；也可以自己从 F12 的 \
             user_current_entitlement_list 请求里复制 authorization 与 cookie 两行粘贴进来",
            "https://www.trae.cn",
        ),
        (
            "workbuddy",
            "WorkBuddy",
            BalanceKind::Manual,
            "WorkBuddy 余额（端点待确认）",
            false,
            "待确认 WorkBuddy 是否暴露余额 API",
            "https://www.workbuddy.cn",
        ),
    ]
}

/*
 * 某平台「配置」弹窗要渲染的凭证字段。
 * ------------------------------------------------------------------
 * 只有 Trae 需要两段（authorization + cookie）；其余平台一条 token 就够，
 * 键名统一成 access_token —— 与 storage 里老格式的裸 token 落在同一个键上，
 * 所以老凭证在新界面下照旧可用。
 * 不需要凭证的平台（本机 CLI / 手动录入）返回空数组，前端不显示「配置」按钮。
 */
fn credential_fields(id: &str) -> Vec<CredField> {
    match id {
        "trae" => trae::credential_fields(),
        "chatgpt" | "qoder" | "openai" | "claude" | "gemini" => vec![CredField {
            key: "access_token".into(),
            label: "access_token / API Key".into(),
            input_type: "password".into(),
            required: true,
            placeholder: Some("粘贴凭证（仅本地加密保存）".into()),
        }],
        _ => Vec::new(),
    }
}

/* 是否支持「一键抓取网页登录态」 */
fn has_grab(id: &str) -> bool {
    id == "trae"
}

fn grab_hint(id: &str) -> Option<String> {
    if !has_grab(id) {
        return None;
    }
    Some(
        "自动借本机 Chrome 的登录态：无窗口抓一次，抓不到会弹出 Chrome 窗口让你登录一次\
         （登录态会被记住，之后可静默抓取）。整个过程最长约 2 分钟。"
            .into(),
    )
}

/* 列出平台元信息（含是否已配置凭证） */
#[command]
pub fn balances_list_providers(app: AppHandle) -> ApiResponse<Vec<ProviderMeta>> {
    let list: Vec<ProviderMeta> = all_providers()
        .into_iter()
        .map(|(id, name, kind, desc, req, hint, doc)| ProviderMeta {
            id: id.into(),
            name: name.into(),
            kind,
            description: desc.into(),
            requires_token: req,
            has_credential: storage::has_credential(&app, id),
            has_manual: storage::load_manual(&app, id).is_some(),
            token_hint: Some(hint.into()),
            credential_fields: credential_fields(id),
            has_grab: has_grab(id),
            grab_hint: grab_hint(id),
            doc_url: Some(doc.into()),
        })
        .collect();
    ApiResponse::ok(list)
}

/*
 * 保存某平台凭证。**收的是字段表**（key → value）而不是单个 token ——
 * ChatGPT 只传一条 access_token，Trae 传 authorization + cookie，
 * 存进 sled 时整张表一起加密（见 storage.rs）。
 */
#[command]
pub fn balances_save_credential(
    app: AppHandle,
    provider: String,
    fields: BTreeMap<String, String>,
    account_id: Option<String>,
    master_key: String,
) -> ApiResponse<()> {
    /*
     * 必填校验按平台的字段声明走。前端也会校验一遍，这里再兜一层：
     * 「一键抓取」回填、以及将来别的调用方都不该能存下一张残缺的表 ——
     * 缺字段的凭证在刷新时只会得到一句含糊的 401，很难倒查到是保存这一步的问题。
     */
    for f in credential_fields(&provider) {
        let filled = fields.get(&f.key).map(|v| !v.trim().is_empty()).unwrap_or(false);
        if f.required && !filled {
            return ApiResponse::err(format!("{} 不能为空", f.label));
        }
    }
    match storage::save_fields(&app, &provider, &fields, account_id.as_deref(), &master_key) {
        Ok(_) => ApiResponse::ok(()),
        Err(e) => ApiResponse::err(format!("保存凭证失败: {e}")),
    }
}

/*
 * 一键抓取某平台的网页登录态（目前只有 Trae 声明了抓取配置）。
 * 借本机 Chrome 的登录态，抓到后**用抓到的值真调一次取数接口自校验**，
 * 通过才回给前端 —— 免得存进去一段已经失效的登录态，刷新时才发现。
 * 只返回字段表，不落盘：保存仍由前端显式调 balances_save_credential（用户看得见）。
 */
#[command]
pub async fn balances_grab_session(
    app: AppHandle,
    provider: String,
) -> ApiResponse<BTreeMap<String, String>> {
    let spec = if has_grab(&provider) {
        trae::grab_spec()
    } else {
        return ApiResponse::err(format!("{provider} 暂不支持自动抓取登录态，请手动粘贴凭证"));
    };

    /* 独立档案放在工作台数据目录下 —— 不碰用户默认的 Chrome 档案 */
    let root = app_data_dir(&app).join("web-login");
    match grab::grab_web_session(&spec, &root).await {
        Ok(r) => {
            let mut fields = BTreeMap::new();
            /* 键名与 CredField 的 key 一致（authorization / cookie），前端直接回填 */
            fields.insert(spec.auth_header.to_string(), r.auth);
            fields.insert("cookie".to_string(), r.cookie);
            ApiResponse::ok(fields)
        }
        Err(e) => ApiResponse::err(format!("抓取失败：{e}")),
    }
}

/* 删除某平台凭证 */
#[command]
pub fn balances_delete_credential(app: AppHandle, provider: String) -> ApiResponse<()> {
    match storage::delete_credential(&app, &provider) {
        Ok(_) => ApiResponse::ok(()),
        Err(e) => ApiResponse::err(format!("删除凭证失败: {e}")),
    }
}

/* 探测 Codex CLI 是否已登录（仅返回是否存在，不读取/不落盘 token） */
#[command]
pub fn balances_autodetect_codex() -> ApiResponse<bool> {
    ApiResponse::ok(storage::detect_codex_auth().is_some())
}

/*
 * 拉取所有已配置平台的余额/用量。
 * 已有可用拉取实现的平台：chatgpt、qoder；其余平台在对应解析未实现前返回占位提示，
 * 不影响已实现平台正常返回。凭证来源优先级：已存 sled 凭证 > ~/.codex/auth.json（仅 chatgpt）。
 *
 * 单平台刷新走 `balances_refresh_one`（共享 refresh_one），避免两份取数逻辑。
 */
#[command]
pub async fn balances_refresh(
    app: AppHandle,
    master_key: Option<String>,
) -> ApiResponse<Vec<AgentBalance>> {
    let mk = master_key.as_deref().filter(|k| !k.is_empty());
    let mut out: Vec<AgentBalance> = Vec::new();
    for (id, name, kind, _desc, _req, _hint, doc) in all_providers() {
        out.push(refresh_one(&app, mk, id, name, kind, doc).await);
    }
    ApiResponse::ok(out)
}

/*
 * 只拉取某一个平台的余额/用量（前端单平台独立刷新用）。
 * 平台不存在时返回错误，而不是静默空结果。
 */
#[command]
pub async fn balances_refresh_one(
    app: AppHandle,
    provider: String,
    master_key: Option<String>,
) -> ApiResponse<AgentBalance> {
    let mk = master_key.as_deref().filter(|k| !k.is_empty());
    match all_providers()
        .into_iter()
        .find(|(id, ..)| *id == provider.as_str())
    {
        Some((id, name, kind, _desc, _req, _hint, doc)) => {
            ApiResponse::ok(refresh_one(&app, mk, id, name, kind, doc).await)
        }
        None => ApiResponse::err(format!("未知平台：{provider}")),
    }
}

/*
 * 单平台取数：chatgpt 走特殊分支（原本在循环外处理），其余平台走通用分支。
 * 抽成独立函数，让「刷新全部」与「刷新单个」共用同一段逻辑
 * （见 workbench-tauri-dev 技能·坑 22：同一个能力第二次要用就上收 core/模块内）。
 */
async fn refresh_one(
    app: &AppHandle,
    mk: Option<&str>,
    id: &str,
    name: &str,
    kind: BalanceKind,
    doc: &str,
) -> AgentBalance {
    // ---- ChatGPT（特例）----
    if id == "chatgpt" {
        // 主密钥「按需使用」：前端只在内存里已经有主密钥时才传过来。
        // 没有密钥也能正常出数据——直接读 Codex CLI 的登录产物 ~/.codex/auth.json，
        // 全程不碰任何密文，所以打开余额面板**不会**弹系统钥匙串授权框。
        // （工作台约定：只有 LogSight 解密服务器密码/私钥时才需要密钥。）
        let stored = match mk {
            Some(k) => storage::load_credential(app, "chatgpt", k).ok().flatten(),
            None => None,
        };
        // 存了凭证但密钥没解锁：要和「压根没凭证」区分开，否则用户会以为凭证丢了
        let locked = stored.is_none() && storage::has_credential(app, "chatgpt");
        let cred = stored.or_else(storage::detect_codex_auth);
        return match cred {
            Some(c) => {
                let resp = chatgpt::fetch_chatgpt(&c.access_token, c.account_id.as_deref()).await;
                match resp.data {
                    Some(b) => b,
                    None => AgentBalance {
                        provider: "chatgpt".into(),
                        name: "ChatGPT".into(),
                        kind: BalanceKind::UsagePercent,
                        items: vec![],
                        raw: Some("https://chatgpt.com".into()),
                        refreshed_at: now_secs(),
                        error: resp.error,
                    },
                }
            }
            None => AgentBalance {
                provider: "chatgpt".into(),
                name: "ChatGPT".into(),
                kind: BalanceKind::UsagePercent,
                items: vec![],
                raw: Some("https://chatgpt.com".into()),
                refreshed_at: 0,
                error: Some(if locked {
                    "已保存 ChatGPT 凭证，但本地主密钥尚未解锁，暂时无法解密。\
                     可到「设置 → 本地密钥」解锁后重试。"
                        .into()
                } else {
                    "未找到 ChatGPT 凭证：请粘贴 access_token，或安装 Codex CLI 并执行 codex login"
                        .into()
                }),
            },
        };
    }

    // ---- Trae（特例）----
    // 网页登录态两段凭证（authorization + cookie），必须解密才能用 ——
    // 与 ChatGPT 不同，它没有「本机客户端登录产物」可回落，所以没有主密钥时
    // 只能明确报「尚未解锁」或「未配置」，不能拿半张凭证去试。
    if id == "trae" {
        let loaded = mk.and_then(|k| storage::load_fields(app, "trae", k).ok().flatten());
        let locked = loaded.is_none() && storage::has_credential(app, "trae");
        let auth = loaded
            .as_ref()
            .and_then(|l| l.field(trae::FIELD_AUTHORIZATION))
            .unwrap_or("")
            .trim()
            .to_string();
        let cookie = loaded
            .as_ref()
            .and_then(|l| l.field(trae::FIELD_COOKIE))
            .unwrap_or("")
            .trim()
            .to_string();

        let error = if auth.is_empty() || cookie.is_empty() {
            Some(if locked {
                "已保存 Trae 登录态，但本地主密钥尚未解锁，暂时无法解密。\
                 可到「设置 → 本地密钥」解锁后重试。"
                    .to_string()
            } else {
                format!(
                    "未配置 Trae 登录态：点卡片上的「配置」，用「一键抓取」读取本机 Chrome \
                     登录态，或手动粘贴 authorization 与 cookie 两行（{name} 无公开余额 API）"
                )
            })
        } else {
            None
        };

        let mut balance = AgentBalance {
            provider: "trae".into(),
            name: "Trae".into(),
            kind: BalanceKind::UsagePercent,
            items: vec![],
            raw: Some(doc.into()),
            refreshed_at: now_secs(),
            error,
        };
        if balance.error.is_none() {
            let r = trae::fetch_trae(&auth, &cookie).await;
            balance = match r.data {
                Some(b) => b,
                None => AgentBalance {
                    items: vec![],
                    error: Some(r.error.unwrap_or_else(|| "Trae 取数失败".into())),
                    ..balance
                },
            };
            balance.raw = Some(doc.into());
        }
        return append_manual_fallback(app, balance);
    }

    // ---- 其余平台 ----
    // 手动类平台（如 workbuddy）以手动录入为准；其余平台若已有手动值则作为兜底展示。
    let has = storage::has_credential(app, id);
    let manual = storage::load_manual(app, id);
    let mut items: Vec<BalanceItem> = Vec::new();
    let mut error: Option<String> = None;
    /* 平台默认给出官网/控制台地址；个别平台（如 Qoder 企业版）会用接口回的真实跳转地址覆盖 */
    let mut raw = doc.to_string();

    if kind == BalanceKind::Manual {
        match &manual {
            Some(m) => items.push(BalanceItem {
                label: m.label.clone(),
                value: m.value.clone(),
                sub: Some("手动录入".into()),
                used_percent: None,
                reset_at: None,
            }),
            None => error = Some("该平台无公开余额 API，请点「手动录入」填写".into()),
        }
    } else if id == "qoder" {
        /*
         * Qoder CN 有两条路，**CLI 优先**：
         *   ① 本机 qoderclicn —— 免凭证（CLI 自己已登录），实测约 2 秒出数，
         *      团队 / 企业账号同样有效；
         *   ② 已保存的 PAT —— 兜底，给没装 CLI 的机器。
         *
         * 顺序不能反：PAT 那条打的是「只服务个人版」的 IDE 内部接口，
         * 对本机这种 userType = teams 的账号大概率无效 ——
         * 先试它会把「明明拿得到数据」变成一句报错。
         *
         * 注意这一支**放在 `!has` 之前**：CLI 路径根本不需要凭证，
         * 放到后面就永远走不到了。
         */
        let cli_out = qoder_cli::fetch_via_cli(Some(app)).await;
        /* 成功但一条额度项都没有 = 没拿到东西，要和「真的成功」区分开 */
        let cli_balance = cli_out.data.filter(|b| !b.items.is_empty());

        match cli_balance {
            Some(b) => {
                items = b.items;
                error = b.error;
                if let Some(r) = b.raw {
                    raw = r;
                }
            }
            None => {
                let cli_reason = cli_out
                    .error
                    .unwrap_or_else(|| "Qoder CLI 没有返回任何额度项".to_string());
                /* CLI 不可用（没装 / 没登录 / 协议变了）才退到 PAT */
                let cred =
                    mk.and_then(|k| storage::load_credential(app, "qoder", k).ok().flatten());
                match cred {
                    Some(c) => {
                        let resp = qoder::fetch_qoder(&c.access_token).await;
                        match resp.data {
                            Some(b) => {
                                items = b.items;
                                error = b.error;
                                if let Some(r) = b.raw {
                                    raw = r;
                                }
                            }
                            None => error = Some(format!(
                                "{cli_reason}；改用已保存的 PAT 也失败：{}",
                                resp.error.unwrap_or_else(|| "未知原因".to_string())
                            )),
                        }
                    }
                    /* 存了凭证但密钥没解锁：要和「压根没凭证」区分开 */
                    None if has => {
                        error = Some(
                            "已保存 Qoder 凭证，但本地主密钥尚未解锁，暂时无法解密。\
                             可到「设置 → 本地密钥」解锁后重试。"
                                .to_string(),
                        )
                    }
                    None => error = Some(cli_reason),
                }
            }
        }
    } else if !has {
        error = Some(format!("尚未配置 {name} 凭证"));
    } else {
        error = Some(format!("{name} 余额拉取尚未在 v1 实现（架构已就位）"));
    }

    let balance = AgentBalance {
        provider: id.into(),
        name: name.into(),
        kind,
        items,
        raw: Some(raw),
        refreshed_at: now_secs(),
        error,
    };
    if kind == BalanceKind::Manual {
        return balance;
    }
    append_manual_fallback(app, balance)
}

/*
 * 手动录入值作为兜底：非手动类平台若同时录过手动余额，把它附在最末并清掉错误。
 *
 * 为什么要有这一步：手动值与凭证是**两条独立存储**，平台又没有公开接口
 * （Trae 就曾经只能手动录）。接了自动取数之后，用户以前手打的数值不该
 * 因为「这次没配登录态 / 接口没通」就凭空消失 —— 手打的数总比一句
 * 「未配置凭证」有用。
 */
fn append_manual_fallback(app: &AppHandle, mut balance: AgentBalance) -> AgentBalance {
    if let Some(m) = storage::load_manual(app, &balance.provider) {
        balance.items.push(BalanceItem {
            label: m.label.clone(),
            value: m.value.clone(),
            sub: Some("手动".into()),
            used_percent: None,
            reset_at: None,
        });
        balance.error = None;
    }
    balance
}

/*
 * 手动录入某平台的余额（用于无公开接口的平台，如 WorkBuddy），
 * 以及给已接入自动取数的平台补一条兜底数值（如 Trae 未配登录态时）。
 * 手动值不是敏感数据，明文存 sled。
 */
#[command]
pub fn balances_save_manual(
    app: AppHandle,
    provider: String,
    label: String,
    value: String,
) -> ApiResponse<()> {
    if value.trim().is_empty() {
        return ApiResponse::err("余额内容不能为空");
    }
    let label = if label.trim().is_empty() {
        "余额".to_string()
    } else {
        label.trim().to_string()
    };
    match storage::save_manual(&app, &provider, &label, value.trim()) {
        Ok(_) => ApiResponse::ok(()),
        Err(e) => ApiResponse::err(format!("保存手动余额失败: {e}")),
    }
}

/* 清除某平台的手动录入余额 */
#[command]
pub fn balances_clear_manual(app: AppHandle, provider: String) -> ApiResponse<()> {
    match storage::delete_manual(&app, &provider) {
        Ok(_) => ApiResponse::ok(()),
        Err(e) => ApiResponse::err(format!("清除手动余额失败: {e}")),
    }
}

/* ============================================================
 * 自动刷新调度（后台定时器）
 * ------------------------------------------------------------------
 * 为什么放后端：关窗转后台时窗口只是被 `hide()`，webkit 会对隐藏页面的
 * `setInterval` 做后台节流 / App Nap，前端的 30 秒调度定时器在后台几乎不触发，
 * 「自动刷新」于是形同停摆。后端 tokio 运行时独立于 webview、不受页面可见性影响，
 * 由它持有排期、真正发起取数，再把结果用事件推回前端渲染 —— 这样即使窗口被藏起来，
 * 取数与刷新照常发生，前端只负责「收到事件后更新界面」。
 *
 * 排期源：前端把「开关 / 全局间隔 / 单平台覆盖 / 主密钥」通过
 * `balances_set_refresh_plan` 推过来（启动与偏好变化时各一次）；
 * 后端只在本地内存维护 `next_at`。前端关窗后进程仍在、webview 也活着，
 * 所以每次启动都会把计划重新推过来。
 * ============================================================ */

use std::collections::HashMap;
use std::sync::Mutex;

use once_cell::sync::Lazy;

#[derive(Default)]
struct RefreshPlan {
    enabled: bool,
    global_min: u64,
    overrides: HashMap<String, u64>,
    master_key: Option<String>,
    /// 每个平台的下一次刷新时刻（Unix 秒）；缺省 = 该平台当前不在调度里
    next_at: HashMap<String, i64>,
}

impl RefreshPlan {
    fn eff_min(&self, id: &str) -> u64 {
        self.overrides.get(id).copied().unwrap_or(self.global_min)
    }
}

static PLAN: Lazy<Mutex<RefreshPlan>> = Lazy::new(|| Mutex::new(RefreshPlan::default()));

/// 后端推给前端的「某平台刷新完成」事件名
pub const EVENT_BALANCES_UPDATED: &str = "balances:updated";

#[derive(Clone, serde::Serialize)]
struct BalancesUpdated {
    balance: AgentBalance,
    next_at: HashMap<String, i64>,
}

/*
 * 启动后台调度循环。**务必用 `tauri::async_runtime::spawn`** —— 它不要求调用方
 * 处于 tokio 上下文（`setup` 钩子里没有），而裸 `tokio::spawn` 会直接 panic。
 * 15 秒粒度足够：排期是分钟级的，差十几秒无所谓，但足够及时地把「到点」的平台挑出来。
 */
pub fn start_balances_scheduler(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(15)).await;
            run_schedule_tick(&app).await;
        }
    });
}

async fn run_schedule_tick(app: &AppHandle) {
    /*
     * 先锁、算出「到点」的平台并**立刻**把它们的 next_at 后推（防止慢请求被重复触发），
     * 再解锁去做网络请求 —— 锁不跨 await，`std::sync::Mutex` 足够，不必用异步锁。
     */
    let due: Vec<(&'static str, &'static str, BalanceKind, &'static str)> = {
        let mut plan = PLAN.lock().unwrap();
        if !plan.enabled {
            return;
        }
        let now = now_secs();
        let mut d = Vec::new();
        for (id, name, kind, _desc, _req, _hint, doc) in all_providers() {
            let nxt = plan.next_at.get(id).copied().unwrap_or(0);
            if now >= nxt {
                let eff = plan.eff_min(id);
                plan.next_at.insert(id.to_string(), now + eff as i64 * 60);
                d.push((id, name, kind, doc));
            }
        }
        d
    };
    if due.is_empty() {
        return;
    }
    let mk = PLAN.lock().unwrap().master_key.clone();
    for (id, name, kind, doc) in due {
        let b = refresh_one(app, mk.as_deref(), id, name, kind, doc).await;
        /* 把最新排期随结果一起带回，前端据此更新倒计时显示 */
        let next_at = PLAN.lock().unwrap().next_at.clone();
        let _ = app.emit(EVENT_BALANCES_UPDATED, BalancesUpdated { balance: b, next_at });
    }
}

/* 前端在启动 / 偏好变化时调用：下发排期并把各平台 next_at 拨到「现在 + 生效间隔」 */
#[command]
pub async fn balances_set_refresh_plan(
    enabled: bool,
    global_min: u64,
    overrides: HashMap<String, u64>,
    master_key: Option<String>,
) -> ApiResponse<HashMap<String, i64>> {
    let mut plan = PLAN.lock().unwrap();
    plan.enabled = enabled;
    plan.global_min = global_min.max(1);
    plan.overrides = overrides;
    plan.master_key = master_key.filter(|k| !k.is_empty());
    let now = now_secs();
    let mut next_at = HashMap::new();
    if enabled {
        for (id, ..) in all_providers() {
            let eff = plan.eff_min(id);
            next_at.insert(id.to_string(), now + eff as i64 * 60);
        }
    }
    plan.next_at = next_at.clone();
    ApiResponse::ok(next_at)
}

/* 手动刷新后调用：把指定平台（或全平台）的 next_at 往后拨，并把最新排期回传前端 */
#[command]
pub async fn balances_reschedule(
    provider: Option<String>,
) -> ApiResponse<HashMap<String, i64>> {
    let mut plan = PLAN.lock().unwrap();
    let now = now_secs();
    match &provider {
        Some(p) => {
            let eff = plan.eff_min(p);
            plan.next_at.insert(p.clone(), now + eff as i64 * 60);
        }
        None => {
            for (id, ..) in all_providers() {
                let eff = plan.eff_min(id);
                plan.next_at.insert(id.to_string(), now + eff as i64 * 60);
            }
        }
    }
    ApiResponse::ok(plan.next_at.clone())
}
