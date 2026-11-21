/*
 * 智能体余额模块 · Qoder CN 用量拉取
 * ------------------------------------------------------------------
 * Qoder CN（个人版）没有公开文档接口。下面这条路由是从客户端 app.asar 里反推出来的
 * （取证过程见 .workbuddy-ai/memory/NOTES-deep-dives.md 第七节），**已实测路由存在**
 * （无 token 打过去 → 401 TOKEN_INVALID）：
 *
 *   GET https://openapi.qoder.com.cn/sash/api/v2/me/usage
 *   Accept: application/json
 *   Authorization: Bearer <token>        // 登录 access_token 或 PAT
 *   Cosy-ClientType: 10                  // IDE 侧 KD() 原样
 *   User-Agent: Qoder
 *
 * 响应（从客户端校验函数 KZe() 反推）：
 *   { "displayMode": "qoder",                                   // 或 "enterprise"
 *     "qoderUsage": {
 *       "userType": "…",
 *       "userQuota":  { "used": n, "total": n, "percentage": 0..1 },   // total 必填
 *       "addOnQuota": { "used": n, "total": n, "percentage": 0..1 },   // 资源包
 *       "orgResourcePackage": { "used": n },                           // 只有 used
 *       "dedicatedResourcePackages": [ … ]
 *     } }
 *
 * 三个必须记住的点：
 *   1. `percentage` 是 **0~1 的小数**，不是 0~100 —— 客户端校验里写死「> 1 即非法」。
 *      本模块优先用 used/total 现算，只有 ratio 不可用时才回落到这个字段。
 *   2. `displayMode === "enterprise"` 时**只回 {openMode, detailUrl}、没有任何数字**。
 *      企业版必须走官方 OpenAPI，这条内部接口天然只服务个人版。此时要给明确提示，
 *      不能静默出一个空面板。
 *   3. 语义上 Credits 是**计量单位**（不是货币），所以映射到 `BalanceKind::UsagePercent`；
 *      标签一律带「已用」—— 前端 `format.ts::isUsageLabel` 正是靠这个词判定方向，
 *      健康度 = 100 − 已用%。**标签改名就等于把颜色和告警的方向改反。**
 *
 * 凭证只认「用户粘贴的 PAT / access_token」：客户端登录态 `auth.v1.dat` 是 Electron
 * safeStorage 加密（密钥在钥匙串 `Qoder CN Safe Storage`），**已实测解不开**，
 * 不要再往那条路上耗时间。
 * @Author: fu
 */
use serde::Deserialize;

use crate::core::api::ApiResponse;
use crate::modules::balances::models::{AgentBalance, BalanceItem, BalanceKind};

const USAGE_ENDPOINT: &str = "https://openapi.qoder.com.cn/sash/api/v2/me/usage";
const USER_AGENT: &str = "Qoder";
const CLIENT_TYPE: &str = "10";

#[derive(Debug, Default, Deserialize)]
struct UsageResponse {
    #[serde(default, rename = "displayMode")]
    display_mode: Option<String>,
    #[serde(default, rename = "qoderUsage")]
    qoder_usage: Option<QoderUsage>,
    /* enterprise 模式才有：跳转地址 */
    #[serde(default, rename = "detailUrl")]
    detail_url: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct QoderUsage {
    #[serde(default, rename = "userType")]
    user_type: Option<String>,
    #[serde(default, rename = "userQuota")]
    user_quota: Option<Quota>,
    #[serde(default, rename = "addOnQuota")]
    add_on_quota: Option<Quota>,
    #[serde(default, rename = "orgResourcePackage")]
    org_resource_package: Option<OrgPackage>,
    #[serde(default, rename = "dedicatedResourcePackages")]
    dedicated_resource_packages: Option<Vec<Quota>>,
}

/*
 * 一个额度池。字段全部可选 —— 接口在任意版本增删字段都不该让整个解析失败
 * （与 chatgpt.rs 同一原则：缺字段降级，不整体报错）。
 */
#[derive(Debug, Default, Deserialize)]
struct Quota {
    #[serde(default)]
    used: Option<f64>,
    #[serde(default)]
    total: Option<f64>,
    #[serde(default)]
    percentage: Option<f64>,
}

/* 组织资源包只有 used，没有 total */
#[derive(Debug, Default, Deserialize)]
struct OrgPackage {
    #[serde(default)]
    used: Option<f64>,
}

/*
 * 失败响应信封。实测无 token 打过去是：
 *   HTTP 401  {"code":"TOKEN_INVALID","message":"missing authorization token","timestamp":"…"}
 * 服务端的 `message` 比状态码更能说明问题（是没带 token、还是 token 过期），
 * 所以失败时要把这层原因透出来 —— 否则用户只知道「401」，不知道该改什么。
 */
#[derive(Debug, Default, Deserialize)]
struct ErrorEnvelope {
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    message: Option<String>,
}

/*
 * 从失败响应体里抠出「服务端说明」。拿不到就返回 None（不编造）。
 * 限长 —— 万一返回的是 HTML 错误页，不能整段塞进界面。
 */
fn parse_error_envelope(body: &str) -> Option<String> {
    const MAX: usize = 120;
    let env: ErrorEnvelope = serde_json::from_str(body).ok()?;
    let code = env.code.unwrap_or_default();
    let message = env.message.unwrap_or_default();
    let joined = match (code.trim().is_empty(), message.trim().is_empty()) {
        (false, false) => format!("{}: {}", code.trim(), message.trim()),
        (false, true) => code.trim().to_string(),
        (true, false) => message.trim().to_string(),
        (true, true) => return None,
    };
    if joined.chars().count() > MAX {
        let mut s: String = joined.chars().take(MAX).collect();
        s.push('…');
        return Some(s);
    }
    Some(joined)
}

/*
 * 把「状态码 + 响应体」翻译成给用户看的中文原因。
 * 按状态码给「该去改什么」的指引，再附上服务端原话 —— 两者都要有：
 * 只有状态码则用户无从下手，只有服务端原话则英文术语看不懂。
 */
fn describe_http_error(status: u16, body: &str) -> String {
    let hint = match status {
        401 | 403 => {
            "token 无效或已过期。请确认用的是个人版 PAT（CLI 的 QODER_PERSONAL_ACCESS_TOKEN）；\
             企业 / 团队版账号本模块不支持"
        }
        404 => "接口路径不存在，Qoder 可能已改版 —— 需要重新从客户端 app.asar 里摸接口",
        s if s >= 500 => "Qoder 服务端错误，稍后重试",
        _ => "请求被拒绝",
    };
    match parse_error_envelope(body) {
        Some(d) => format!("Qoder 用量接口返回 HTTP {status}：{hint}（服务端：{d}）"),
        None => format!("Qoder 用量接口返回 HTTP {status}：{hint}"),
    }
}

/*
 * 取「已用百分比」（0~100）。
 * 优先用 used/total 现算（比接口自报的 percentage 可信）；ratio 不可用时才回落到
 * percentage 字段（**它是 0~1 的小数**，超过 1 视为非法直接丢弃）。
 * 两者都拿不到、或算出非有限值 → None。
 */
fn used_percent(q: &Quota) -> Option<f64> {
    let from_ratio = match (q.used, q.total) {
        (Some(u), Some(t)) if t > 0.0 && u.is_finite() && t.is_finite() => Some(u / t * 100.0),
        _ => None,
    };
    let from_field = q
        .percentage
        .filter(|p| p.is_finite() && (0.0..=1.0).contains(p))
        .map(|p| p * 100.0);
    let v = from_ratio.or(from_field)?;
    if !v.is_finite() {
        return None;
    }
    Some(v.clamp(0.0, 100.0))
}

/* 数字展示：整数不拖 `.0`，非有限值给占位符 */
/* pub(super)：qoder_cli（同一条路由的 CLI 形态）复用同一套数字口径，不各写一份 */
pub(super) fn fmt_num(v: f64) -> String {
    if !v.is_finite() {
        return "—".into();
    }
    if v.fract().abs() < f64::EPSILON && v.abs() < 1e15 {
        format!("{}", v as i64)
    } else {
        format!("{v:.2}")
    }
}

/* 「剩余 a / b」，只有 ratio 齐全时才给 */
fn quota_sub(q: &Quota) -> Option<String> {
    match (q.used, q.total) {
        (Some(u), Some(t)) if t > 0.0 && u.is_finite() && t.is_finite() => Some(format!(
            "剩余 {} / {}",
            fmt_num((t - u).max(0.0)),
            fmt_num(t)
        )),
        _ => None,
    }
}

/*
 * 展示名。`userType` 是接口自报的账号类型（如 personal），带上便于区分，
 * 但要限长 —— 它来自服务端，不能直接铺进卡片标题。
 * pub(super)：qoder_cli 用同一套命名（两条路由的 `userType` 字段同名同义）。
 */
pub(super) fn format_name(user_type: Option<&str>) -> String {
    const BASE: &str = "Qoder CN";
    const MAX: usize = 20;
    match user_type.map(str::trim).filter(|s| !s.is_empty()) {
        Some(ut) => {
            let mut t: String = ut.chars().take(MAX).collect();
            if ut.chars().count() > MAX {
                t.push('…');
            }
            format!("{BASE} · {t}")
        }
        None => BASE.to_string(),
    }
}

/* 把带百分比的额度池推成一条展示项 */
fn push_quota(items: &mut Vec<BalanceItem>, label: &str, q: &Quota) {
    if let Some(p) = used_percent(q) {
        items.push(BalanceItem {
            label: label.into(),
            value: format!("{}%", p.round() as i64),
            sub: quota_sub(q),
            /* value 已经是百分比 */
            used_percent: None,
            reset_at: None,
        });
    }
}

/*
 * 把响应归一化成余额快照。
 * 纯函数（不碰网络、不看时钟以外的东西），因此可以在单测里直接喂 JSON 断言。
 */
fn build_balance(resp: UsageResponse) -> AgentBalance {
    let mode = resp
        .display_mode
        .as_deref()
        .unwrap_or("qoder")
        .trim()
        .to_ascii_lowercase();
    let usage = resp.qoder_usage.unwrap_or_default();
    let name = format_name(usage.user_type.as_deref());

    let mut items: Vec<BalanceItem> = Vec::new();

    /* 主额度 + 资源包 */
    if let Some(q) = &usage.user_quota {
        push_quota(&mut items, "额度已用", q);
    }
    if let Some(q) = &usage.add_on_quota {
        push_quota(&mut items, "资源包已用", q);
    }

    /* 组织资源包：只有 used，算不出百分比 → 作为绝对值展示（不会被当成健康度） */
    if let Some(p) = &usage.org_resource_package {
        if let Some(u) = p.used.filter(|v| v.is_finite()) {
            items.push(BalanceItem {
                label: "组织资源包".into(),
                value: fmt_num(u),
                sub: Some("仅已用量".into()),
                /* 只有 used，没有上限 → 不能出百分比 */
                used_percent: None,
                reset_at: None,
            });
        }
    }

    /*
     * 专用资源包：具体结构尚未确认，`Quota` 全字段可选正好用来容错 ——
     * 认不出来就一条都不产出，不会报错也不会显示垃圾数据。
     */
    if let Some(list) = &usage.dedicated_resource_packages {
        for (i, q) in list.iter().enumerate() {
            if let Some(p) = used_percent(q) {
                items.push(BalanceItem {
                    label: format!("专用资源包 {}", i + 1),
                    value: format!("{}%", p.round() as i64),
                    sub: quota_sub(q),
                    /* value 已经是百分比 */
                    used_percent: None,
                    reset_at: None,
                });
            }
        }
    }

    let enterprise = mode == "enterprise";
    let error = if enterprise {
        Some(
            "Qoder 当前账号是企业 / 团队版：内部接口只返回跳转信息、不含用量数字。\
             企业版需用组织 API Key 走官方 OpenAPI，本模块暂不支持。"
                .to_string(),
        )
    } else if items.is_empty() {
        Some("Qoder 用量接口没有返回可展示的数字（账号无额度，或接口字段已变更）".to_string())
    } else {
        None
    };

    AgentBalance {
        provider: "qoder".into(),
        name,
        kind: BalanceKind::UsagePercent,
        items,
        /* 企业版优先给出接口回的跳转地址，否则给官网 */
        raw: Some(
            resp.detail_url
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| "https://qoder.com.cn".to_string()),
        ),
        refreshed_at: now_secs(),
        error,
    }
}

fn now_secs() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/*
 * 用 access_token / PAT 拉取 Qoder CN 用量。
 * 失败返回带中文原因的 ApiResponse::err（不 panic）。
 *
 * ⚠️ 端到端未验证：本机没有可用的 Qoder token，所以「PAT 能否通过这条 IDE 内部接口
 * 鉴权」只有真机能确认。解析逻辑（build_balance / used_percent）已由单测覆盖。
 */
pub async fn fetch_qoder(access_token: &str) -> ApiResponse<AgentBalance> {
    let client = match reqwest::Client::builder().user_agent(USER_AGENT).build() {
        Ok(c) => c,
        Err(e) => return ApiResponse::err(format!("初始化 HTTP 客户端失败: {e}")),
    };

    let resp = match client
        .get(USAGE_ENDPOINT)
        .bearer_auth(access_token)
        .header("Accept", "application/json")
        .header("Cosy-ClientType", CLIENT_TYPE)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return ApiResponse::err(format!("请求 Qoder 用量接口失败: {e}")),
    };

    let status = resp.status();
    if !status.is_success() {
        /* 失败时把 body 也读出来：服务端的原因（如 TOKEN_INVALID）比状态码有用得多 */
        let body = resp.text().await.unwrap_or_default();
        return ApiResponse::err(describe_http_error(status.as_u16(), &body));
    }

    match resp.json::<UsageResponse>().await {
        Ok(v) => ApiResponse::ok(build_balance(v)),
        Err(e) => ApiResponse::err(format!("解析 Qoder 用量响应失败: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse(v: serde_json::Value) -> AgentBalance {
        let resp: UsageResponse = serde_json::from_value(v).expect("parse usage");
        build_balance(resp)
    }

    fn item<'a>(b: &'a AgentBalance, label: &str) -> &'a BalanceItem {
        b.items
            .iter()
            .find(|i| i.label == label)
            .unwrap_or_else(|| panic!("缺少指标 {label}"))
    }

    #[test]
    fn percent_prefers_ratio_over_reported_field() {
        /* 接口自报 0.10，但 used/total = 0.25 → 以现算的为准 */
        let q = Quota {
            used: Some(250.0),
            total: Some(1000.0),
            percentage: Some(0.10),
        };
        assert_eq!(used_percent(&q), Some(25.0));
    }

    #[test]
    fn percent_falls_back_to_fraction_field() {
        /* 没有 total，只能信 percentage（0~1 的小数 → ×100） */
        let q = Quota {
            used: Some(5.0),
            total: None,
            percentage: Some(0.42),
        };
        assert_eq!(used_percent(&q), Some(42.0));
    }

    #[test]
    fn percent_rejects_out_of_range_fraction() {
        /* 客户端校验写死 >1 即非法；这里同样丢弃，而不是当成 42% 之外的怪值 */
        let q = Quota {
            used: None,
            total: None,
            percentage: Some(1.5),
        };
        assert_eq!(used_percent(&q), None);
    }

    #[test]
    fn percent_handles_zero_total_and_non_finite() {
        /* total=0 → ratio 不可用，且没有 percentage → None */
        let zero = Quota {
            used: Some(10.0),
            total: Some(0.0),
            percentage: None,
        };
        assert_eq!(used_percent(&zero), None);

        let inf = Quota {
            used: Some(f64::INFINITY),
            total: Some(100.0),
            percentage: None,
        };
        assert_eq!(used_percent(&inf), None);

        let nan = Quota {
            used: Some(1.0),
            total: Some(100.0),
            percentage: None,
        };
        assert_eq!(used_percent(&nan), Some(1.0));
    }

    #[test]
    fn percent_is_clamped_to_0_100() {
        /* used > total（超支）不该算出 >100 */
        let q = Quota {
            used: Some(150.0),
            total: Some(100.0),
            percentage: None,
        };
        assert_eq!(used_percent(&q), Some(100.0));
    }

    #[test]
    fn personal_mode_builds_usage_items() {
        let b = parse(json!({
            "displayMode": "qoder",
            "qoderUsage": {
                "userType": "personal",
                "userQuota":  { "used": 250.0, "total": 1000.0, "percentage": 0.25 },
                "addOnQuota": { "used": 10.0,  "total": 500.0,  "percentage": 0.02 }
            }
        }));

        assert_eq!(b.provider, "qoder");
        assert_eq!(b.kind, BalanceKind::UsagePercent);
        assert!(b.error.is_none());
        assert_eq!(item(&b, "额度已用").value, "25%");
        assert_eq!(
            item(&b, "额度已用").sub.as_deref(),
            Some("剩余 750 / 1000")
        );
        assert_eq!(item(&b, "资源包已用").value, "2%");
    }

    /*
     * 跨语言契约断言：标签必须含「已用」。
     * 前端 `format.ts::isUsageLabel` 靠这个词判定方向（已用 → 健康度 = 100 − v），
     * 一旦有人把标签改成「剩余」语义，颜色与阈值提醒会整体反向 —— 这里钉死它。
     */
    #[test]
    fn usage_labels_carry_the_word_used() {
        let b = parse(json!({
            "qoderUsage": {
                "userQuota":  { "used": 1.0, "total": 10.0 },
                "addOnQuota": { "used": 2.0, "total": 10.0 }
            }
        }));
        for it in &b.items {
            assert!(
                it.label.contains("已用"),
                "标签「{}」缺少「已用」，前端会把方向判反",
                it.label
            );
            assert!(it.value.ends_with('%'), "值「{}」不是百分比格式", it.value);
        }
    }

    #[test]
    fn org_package_shows_absolute_used_only() {
        let b = parse(json!({
            "qoderUsage": {
                "userQuota": { "used": 1.0, "total": 10.0 },
                "orgResourcePackage": { "used": 1234.0 }
            }
        }));
        let it = item(&b, "组织资源包");
        assert_eq!(it.value, "1234");
        /* 不带 % → 前端 percentOf 返回 null，不会把它当成健康度参与告警 */
        assert!(!it.value.ends_with('%'));
    }

    #[test]
    fn dedicated_packages_only_emitted_when_measurable() {
        let b = parse(json!({
            "qoderUsage": {
                "dedicatedResourcePackages": [
                    { "used": 1.0, "total": 4.0 },
                    { "used": 7.0 },
                    { "unexpected": "shape" }
                ]
            }
        }));
        /* 第一条能算 25%；后两条算不出百分比 → 一条都不产出 */
        assert_eq!(item(&b, "专用资源包 1").value, "25%");
        assert!(b.items.iter().all(|i| i.label != "专用资源包 2"));
        assert!(b.items.iter().all(|i| i.label != "专用资源包 3"));
    }

    #[test]
    fn enterprise_mode_reports_why_instead_of_empty_panel() {
        let b = parse(json!({
            "displayMode": "enterprise",
            "openMode": "enterprise",
            "detailUrl": "https://qoder.com.cn/org/usage"
        }));
        assert!(b.items.is_empty());
        let err = b.error.expect("enterprise 必须有明确提示");
        assert!(err.contains("企业"));
        /* 跳转地址要透出来，用户才知道去哪儿看 */
        assert_eq!(b.raw.as_deref(), Some("https://qoder.com.cn/org/usage"));
    }

    #[test]
    fn empty_response_degrades_without_panic() {
        let b = parse(json!({}));
        assert_eq!(b.name, "Qoder CN");
        assert!(b.items.is_empty());
        assert!(b.error.is_some());
        assert_eq!(b.raw.as_deref(), Some("https://qoder.com.cn"));
    }

    #[test]
    fn name_includes_capped_user_type() {
        assert_eq!(format_name(None), "Qoder CN");
        assert_eq!(format_name(Some("  ")), "Qoder CN");
        assert_eq!(format_name(Some("personal")), "Qoder CN · personal");

        let long = "x".repeat(40);
        let n = format_name(Some(&long));
        assert!(n.ends_with('…'));
        /* 「Qoder CN · 」+ 20 字符 + 省略号 */
        assert_eq!(n.chars().count(), 11 + 20 + 1);
    }

    #[test]
    fn fmt_num_is_readable() {
        assert_eq!(fmt_num(750.0), "750");
        assert_eq!(fmt_num(12.345), "12.35");
        assert_eq!(fmt_num(f64::NAN), "—");
    }

    /*
     * 下面这条 body 是**实测抓下来的原文**（无 token 打 /sash/api/v2/me/usage），
     * 不是编的 —— 真实失败响应就长这样。
     */
    const REAL_401_BODY: &str = r#"{
		"code": "TOKEN_INVALID",
		"message": "missing authorization token",
		"timestamp": "1790073116397"
	}"#;

    #[test]
    fn error_envelope_reads_real_server_body() {
        assert_eq!(
            parse_error_envelope(REAL_401_BODY).as_deref(),
            Some("TOKEN_INVALID: missing authorization token")
        );
    }

    #[test]
    fn error_envelope_tolerates_partial_and_non_json() {
        /* 只有 code */
        assert_eq!(
            parse_error_envelope(r#"{"code":"RATE_LIMITED"}"#).as_deref(),
            Some("RATE_LIMITED")
        );
        /* 只有 message */
        assert_eq!(
            parse_error_envelope(r#"{"message":"token expired"}"#).as_deref(),
            Some("token expired")
        );
        /* 空信封 → 不编造 */
        assert_eq!(parse_error_envelope("{}"), None);
        /* 非 JSON（如 HTML 错误页）→ 不编造 */
        assert_eq!(parse_error_envelope("<html>502</html>"), None);
        assert_eq!(parse_error_envelope(""), None);
    }

    #[test]
    fn error_envelope_is_length_capped() {
        let long = format!(r#"{{"message":"{}"}}"#, "x".repeat(500));
        let got = parse_error_envelope(&long).expect("应能取出");
        assert_eq!(got.chars().count(), 121); /* 120 + 省略号 */
        assert!(got.ends_with('…'));
    }

    /*
     * 失败提示必须同时给「状态码指引」和「服务端原话」：
     * 只有状态码用户无从下手，只有服务端原话（英文术语）又看不懂。
     */
    #[test]
    fn http_error_message_pairs_hint_with_server_detail() {
        let m = describe_http_error(401, REAL_401_BODY);
        assert!(m.contains("401"), "缺状态码：{m}");
        assert!(m.contains("PAT"), "缺「该去改什么」的指引：{m}");
        assert!(m.contains("TOKEN_INVALID"), "缺服务端原因：{m}");
    }

    #[test]
    fn http_error_message_survives_empty_body() {
        let m = describe_http_error(500, "");
        assert!(m.contains("500"));
        assert!(m.contains("服务端错误"));
        /* 没有 body 时不能出现空的「（服务端：）」 */
        assert!(!m.contains("（服务端"), "不该凭空拼出服务端说明：{m}");
    }

    #[test]
    fn http_error_404_points_at_app_asar() {
        /* 404 意味着 Qoder 改版了，提示要指向重新摸接口的方法，而不是让用户改 token */
        let m = describe_http_error(404, "");
        assert!(m.contains("app.asar"), "404 应指向重新摸接口：{m}");
    }
}
