/*
 * 智能体余额模块 · Trae 额度拉取
 * ------------------------------------------------------------------
 * Trae 没有公开的余额 API，但**网页控制台自己**在调一个内部接口：
 *   POST https://api.trae.cn/trae/api/v2/pay/user_current_entitlement_list
 *   Authorization: Cloud-IDE-JWT eyJ...      ← 网页登录态的整段请求头
 *   Cookie: d_ticket=...; sessionid=...
 *   body: {}
 * 所以取数路径与「网页登录态型」平台一致：拿两段登录态去调这个接口，
 * 再把响应归一化成余额项。**不需要任何官方 Key**，用户登录一次网页就够。
 *
 * 响应字段（实测）：
 *   usage_summary.total_amount / consumed_amount / consumption_ratio(0~1)
 *   user_entitlement_pack_list[]  各权益包（免费/登录赠送/签到奖励…）的 credits_limit
 * 解析对缺字段降级：宁可少出一项，也不因某个字段缺失整块失败。
 *
 * 与 uTools 插件（ai-balance-utools/adapters/trae.js）是同一套接口与口径，
 * 差别只在这边同时把「总额 / 已用 / 比例」都摆出来（插件只摆了部分）。
 * @Author: fu
 */
use serde_json::Value;

use crate::core::api::ApiResponse;
use crate::modules::balances::grab::{GrabSpec, ValidateSpec};
use crate::modules::balances::models::{AgentBalance, BalanceItem, BalanceKind, CredField};

const API: &str = "https://api.trae.cn/trae/api/v2/pay/user_current_entitlement_list";
const PAGE: &str = "https://www.trae.cn/";
const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/* 凭证字段名：commands 取数、grab 抓取、前端表单三处都用这两个常量，避免拼错 */
pub const FIELD_AUTHORIZATION: &str = "authorization";
pub const FIELD_COOKIE: &str = "cookie";

/* 「配置」弹窗要渲染的两个输入框（两段都必须有，缺一取不到数） */
pub fn credential_fields() -> Vec<CredField> {
    vec![
        CredField {
            key: FIELD_AUTHORIZATION.into(),
            label: "Authorization（整段，含 Cloud-IDE-JWT 前缀）".into(),
            input_type: "password".into(),
            required: true,
            placeholder: Some("Cloud-IDE-JWT eyJ...".into()),
        },
        CredField {
            key: FIELD_COOKIE.into(),
            label: "Cookie（整段）".into(),
            input_type: "textarea".into(),
            required: true,
            placeholder: Some("d_ticket=...; sessionid=...".into()),
        },
    ]
}

/*
 * 「一键抓取」配置：交给通用引擎（grab.rs）执行 ——
 * 打开 trae.cn 触发鉴权请求 → 截下 authorization 请求头与整段 Cookie →
 * 用抓到的值真调一次取数接口（2xx 才算有效）→ 回填到上面两个字段。
 */
pub fn grab_spec() -> GrabSpec {
    GrabSpec {
        entry_url: PAGE,
        auth_header: "authorization",
        auth_match: "Cloud-IDE-JWT",
        cookie_urls: vec![PAGE, "https://api.trae.cn/"],
        validate: Some(ValidateSpec {
            url: API.into(),
            method: "POST".into(),
            headers: vec![
                ("Content-Type".into(), "application/json".into()),
                ("Accept".into(), "application/json, text/plain, */*".into()),
                ("Origin".into(), "https://www.trae.cn".into()),
                ("Referer".into(), PAGE.into()),
            ],
            body: Some("{}".into()),
        }),
        timeout_secs: 120,
        profile_dir: "trae",
    }
}

/* 数字字段：接口给的是 number 或字符串数字都有，统一收成 f64 */
fn num_at(v: Option<&Value>) -> Option<f64> {
    match v? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse::<f64>().ok(),
        _ => None,
    }
}

fn round2(n: f64) -> f64 {
    (n * 100.0).round() / 100.0
}

/* 整数量不补小数位：「1200」比「1200.00」干净；小数保留两位 */
fn fmt_amount(n: f64) -> String {
    if (n.fract()).abs() < 1e-9 {
        format!("{}", n.round() as i64)
    } else {
        format!("{:.2}", round2(n))
    }
}

fn clamp_percent(v: f64) -> i64 {
    v.round().clamp(0.0, 100.0) as i64
}

/*
 * consumption_ratio → 百分比。
 * 实测是 **0~1** 的比值（插件里也是 ×100），所以 `<=1` 一律当比值看；
 * 更大的值说明接口换了量纲（直接给百分比），那就原样用 —— 不要静默乘 100 再夹到 100，
 * 那会把「接口换了单位」这件事实伪装成一个看起来挺正常的「100%」。
 */
fn ratio_to_percent(r: f64) -> i64 {
    let pct = if r <= 1.0 { r * 100.0 } else { r };
    clamp_percent(pct)
}

/*
 * 权益包额度：逐包取 credits_limit 后求和。
 * 路径有三种写法（订阅包 / 加量包 / 基础字段），任一命中即可 ——
 * 这与插件里的取值顺序一致；取不到就整体跳过这一项，不算失败。
 */
fn pack_limit(pack: &Value) -> Option<f64> {
    let base = pack.get("entitlement_base_info");
    let extra = base
        .and_then(|b| b.get("product_extra"))
        .and_then(|p| p.get("subscription_extra").or_else(|| p.get("package_extra")));
    let paths = [
        extra
            .and_then(|e| e.get("quota"))
            .and_then(|q| q.get("credits_limit")),
        base.and_then(|b| b.get("quota"))
            .and_then(|q| q.get("credits_limit")),
    ];
    paths.into_iter().flatten().find_map(|v| num_at(Some(v)))
}

/* 把接口响应归一化成展示项；一项都没有时返回空数组（由调用方判为失败） */
fn build_items(res: &Value) -> Vec<BalanceItem> {
    let summary = res.get("usage_summary");
    let total = num_at(summary.and_then(|s| s.get("total_amount")));
    let consumed = num_at(summary.and_then(|s| s.get("consumed_amount")));
    let ratio = num_at(summary.and_then(|s| s.get("consumption_ratio")));

    let mut items: Vec<BalanceItem> = Vec::new();
    if let Some(t) = total {
        items.push(BalanceItem {
            label: "本周期总额".into(),
            value: fmt_amount(t),
            sub: Some("credits".into()),
            used_percent: None,
            reset_at: None,
        });
    }
    if let Some(c) = consumed {
        items.push(BalanceItem {
            label: "本周期已用".into(),
            value: fmt_amount(c),
            sub: Some("credits".into()),
            used_percent: None,
            reset_at: None,
        });
    }
    if let (Some(t), Some(c)) = (total, consumed) {
        items.push(BalanceItem {
            label: "本周期剩余".into(),
            value: fmt_amount(round2(t - c)),
            sub: Some("credits".into()),
            used_percent: None,
            reset_at: None,
        });
    }
    if let Some(r) = ratio {
        items.push(BalanceItem {
            label: "已用比例".into(),
            value: format!("{}%", ratio_to_percent(r)),
            sub: None,
            used_percent: None,
            reset_at: None,
        });
    }

    let packs = res
        .get("user_entitlement_pack_list")
        .and_then(|p| p.as_array());
    if let Some(list) = packs {
        let sum: f64 = list.iter().filter_map(pack_limit).filter(|v| *v > 0.0).sum();
        if sum > 0.0 {
            items.push(BalanceItem {
                label: "权益包额度".into(),
                value: fmt_amount(round2(sum)),
                sub: Some("credits".into()),
                used_percent: None,
                reset_at: None,
            });
        }
    }

    items
}

/*
 * 用网页登录态拉取 Trae 额度。
 * 返回 ApiResponse<AgentBalance>：失败时 error 带中文原因（不 panic、不回显凭证）。
 */
pub async fn fetch_trae(authorization: &str, cookie: &str) -> ApiResponse<AgentBalance> {
    let client = match reqwest::Client::builder().user_agent(USER_AGENT).build() {
        Ok(c) => c,
        Err(e) => return ApiResponse::err(format!("初始化 HTTP 客户端失败: {e}")),
    };

    let resp = match client
        .post(API)
        .header("Authorization", authorization.trim())
        .header("Cookie", cookie.trim())
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/plain, */*")
        .header("Origin", "https://www.trae.cn")
        .header("Referer", PAGE)
        .body("{}")
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return ApiResponse::err(format!("请求 Trae 额度接口失败: {e}")),
    };

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let msg = match status {
            401 | 403 => "Trae 登录态已失效（接口返回 401/403），请重新「一键抓取」或重新粘贴 authorization 与 cookie".to_string(),
            _ => format!("Trae 额度接口返回 HTTP {status}"),
        };
        return ApiResponse::err(msg);
    }

    let data: Value = match resp.json().await {
        Ok(v) => v,
        Err(e) => return ApiResponse::err(format!("解析 Trae 额度响应失败: {e}")),
    };

    let items = build_items(&data);
    let has_usage = data.get("usage_summary").is_some();

    ApiResponse::ok(AgentBalance {
        provider: "trae".into(),
        name: "Trae".into(),
        kind: BalanceKind::UsagePercent,
        items,
        raw: Some(PAGE.into()),
        refreshed_at: now_secs(),
        error: if has_usage {
            None
        } else {
            Some("Trae 响应里没有 usage_summary —— 登录态可能有效但接口已变更".into())
        },
    })
}

fn now_secs() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /* 完整的 usage_summary：总额/已用/剩余/比例四项都要出，且剩余由两者相减 */
    #[test]
    fn items_cover_summary() {
        let res = json!({
            "usage_summary": {
                "total_amount": 2000,
                "consumed_amount": 500.5,
                "consumption_ratio": 0.25025
            },
            "user_entitlement_pack_list": []
        });
        let items = build_items(&res);
        let labels: Vec<&str> = items.iter().map(|i| i.label.as_str()).collect();
        assert_eq!(labels, vec!["本周期总额", "本周期已用", "本周期剩余", "已用比例"]);
        assert_eq!(items[0].value, "2000");
        assert_eq!(items[1].value, "500.50");
        assert_eq!(items[2].value, "1499.50");
        assert_eq!(items[3].value, "25%");
    }

    /* 字符串数字与缺字段都要能降级：只有 total 时只出「总额」，不报错也不出假数据 */
    #[test]
    fn degrades_on_missing_fields() {
        let res = json!({ "usage_summary": { "total_amount": "1200" } });
        let items = build_items(&res);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].label, "本周期总额");
        assert_eq!(items[0].value, "1200");
    }

    /* 权益包三种路径任一命中即计入；非正数（0 / 负数）不进合计 */
    #[test]
    fn sums_pack_limits_from_either_path() {
        let res = json!({
            "usage_summary": { "total_amount": 100, "consumed_amount": 10 },
            "user_entitlement_pack_list": [
                { "entitlement_base_info": { "product_extra": { "subscription_extra": { "quota": { "credits_limit": 300 } } } } },
                { "entitlement_base_info": { "product_extra": { "package_extra": { "quota": { "credits_limit": "200" } } } } },
                { "entitlement_base_info": { "quota": { "credits_limit": 50 } } },
                { "entitlement_base_info": { "quota": { "credits_limit": 0 } } }
            ]
        });
        let items = build_items(&res);
        let pack = items.iter().find(|i| i.label == "权益包额度").expect("应出权益包额度");
        assert_eq!(pack.value, "550");
    }

    /* 比例值：0~1 当比值（×100），>1 当已经是百分比；两者都要夹到 0~100 */
    #[test]
    fn ratio_handles_both_units() {
        assert_eq!(ratio_to_percent(0.25025), 25);
        assert_eq!(ratio_to_percent(45.0), 45);
        assert_eq!(ratio_to_percent(140.0), 100);
    }
}
