/*
 * 智能体余额模块 · ChatGPT 用量/额度拉取
 * ------------------------------------------------------------------
 * 参考开源实现（codex-card / codexU 等 Rust+Tauri 项目）确认的稳定内部接口：
 *   GET https://chatgpt.com/backend-api/wham/usage
 *   Authorization: Bearer <access_token>
 *   ChatGPT-Account-Id: <account_id>   （可选）
 *
 * 这是 ChatGPT 网页端的内部接口，对 ChatGPT Plus / Pro 都生效。实测（Plus）返回：
 *   {
 *     "plan_type": "plus",
 *     "rate_limit": { "allowed": bool, "limit_reached": bool,
 *       "primary_window":   { "used_percent": 100, "limit_window_seconds": 18000, "reset_at": <unix> }, // 本时段(~5h)
 *       "secondary_window": { "used_percent": 29,  "limit_window_seconds": 604800, "reset_at": <unix> }  // 本周
 *     },
 *     "credits": { "has_credits": true, "unlimited": false, "balance": "984.3062227500",
 *                  "approx_local_messages": [246,1280], "approx_cloud_messages": [39,246] },
 *     "rate_limit_reset_credits": { "available_count": 2, "applicable_available_count": 2 },
 *     "additional_rate_limits": [ { "limit_name": "gpt-reserve", "rate_limit": { "primary_window": {...} } } ]
 *   }
 * 因此既能给出「用量百分比」，也能给出**剩余额度 / 约可用消息 / 可用重置次数**。
 *
 * 注意：这不是公开计费的 API，OpenAI 可能在任意版本改动字段名或路径；
 * 解析对缺字段做了降级（用 0 / 未知 plan 兜底），不会因某字段缺失而整体失败。
 * @Author: fu
 */
use chrono::{DateTime, Local, TimeZone};
use serde::Deserialize;

use crate::core::api::ApiResponse;
use crate::modules::balances::models::{AgentBalance, BalanceItem, BalanceKind};

const USAGE_ENDPOINT: &str = "https://chatgpt.com/backend-api/wham/usage";

/* OpenAI 网页端接口需要带一个 User-Agent，否则可能被拒 */
const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

#[derive(Debug, Default, Deserialize)]
struct UsageResponse {
    #[serde(default)]
    plan_type: Option<String>,
    #[serde(default)]
    rate_limit: Option<RateLimit>,
    #[serde(default)]
    credits: Option<Credits>,
    #[serde(default)]
    rate_limit_reset_credits: Option<ResetCredits>,
    #[serde(default)]
    additional_rate_limits: Option<Vec<AdditionalLimit>>,
}

#[derive(Debug, Default, Deserialize)]
struct RateLimit {
    #[serde(default)]
    limit_reached: Option<bool>,
    #[serde(default)]
    primary_window: Option<UsageWindow>,
    #[serde(default)]
    secondary_window: Option<UsageWindow>,
}

#[derive(Debug, Default, Deserialize)]
struct Credits {
    #[serde(default)]
    has_credits: bool,
    #[serde(default)]
    balance: Option<String>,
    #[serde(default)]
    approx_local_messages: Option<Vec<i64>>,
    #[serde(default)]
    approx_cloud_messages: Option<Vec<i64>>,
}

#[derive(Debug, Default, Deserialize)]
struct ResetCredits {
    #[serde(default)]
    available_count: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct AdditionalLimit {
    #[serde(default)]
    limit_name: Option<String>,
    #[serde(default)]
    rate_limit: Option<RateLimit>,
}

#[derive(Debug, Deserialize)]
struct UsageWindow {
    /* 0~100 的百分比（不是 0~1） */
    used_percent: f64,
    #[serde(default)]
    reset_at: Option<i64>,
}

fn parse_percent(v: f64) -> i64 {
    v.round().clamp(0.0, 100.0) as i64
}

fn format_plan(plan_type: Option<String>) -> String {
    let plan = plan_type.unwrap_or_else(|| "unknown".to_owned());
    format!("ChatGPT {}", plan.to_uppercase())
}

/*
 * 把 Unix 秒格式化成「MM月DD日 HH:mm」本地时间，失败返回 None。
 *
 * 必须带小时分钟：卡片与首页备注上只写日期（`11-14`）时，用户分不清
 * 「今天 16:42 重置」和「明天 06:46 重置」，而这正是额度耗尽后最想知道的事。
 * 月日带上「月 / 日」两个字，跨年看也不会把 `12-01` 误读成 12 月 1 日以外的意思。
 */
fn fmt_reset(ts: Option<i64>) -> Option<String> {
    ts.and_then(|t| {
        let dt: DateTime<Local> = Local.timestamp_opt(t, 0).single()?;
        Some(dt.format("%m月%d日 %H:%M").to_string())
    })
}

/* 区间 [a,b] → "a~b" */
fn fmt_range(r: &[i64]) -> Option<String> {
    if r.len() >= 2 {
        Some(format!("{}~{}", r[0], r[1]))
    } else {
        None
    }
}

/*
 * 解析 /wham/usage 响应为归一化余额。
 * Plus 有两个窗口：primary=本时段、secondary=本周；只有一个 primary 时当作周窗口。
 * 另附 credits（剩余额度/约可用消息）、可用重置次数、其它模型限额。
 */
fn build_balance(usage: UsageResponse) -> AgentBalance {
    let rate_limit = usage.rate_limit.unwrap_or_default();
    let limit_reached = rate_limit.limit_reached.unwrap_or(false);
    let (session_win, weekly_win) = if rate_limit.secondary_window.is_some() {
        (rate_limit.primary_window, rate_limit.secondary_window)
    } else {
        (None, rate_limit.primary_window)
    };

    let mut items: Vec<BalanceItem> = Vec::new();

    if let Some(w) = session_win {
        let mut sub = fmt_reset(w.reset_at).map(|s| format!("重置 {s}"));
        if limit_reached {
            sub = Some(match sub {
                Some(s) => format!("已达上限 · {s}"),
                None => "已达上限".into(),
            });
        }
        items.push(BalanceItem {
            label: "本时段已用".into(),
            value: format!("{}%", parse_percent(w.used_percent)),
            sub,
            used_percent: None,
            /* 窗口重置时刻给**机器值**，徽章拿它算「2 小时后重置」；
               上面那个 sub 是给人看的现成文本，两者不能互相替代 */
            reset_at: w.reset_at,
        });
    }
    if let Some(w) = weekly_win {
        items.push(BalanceItem {
            label: "本周已用".into(),
            value: format!("{}%", parse_percent(w.used_percent)),
            sub: fmt_reset(w.reset_at).map(|s| format!("重置 {s}")),
            used_percent: None,
            reset_at: w.reset_at,
        });
    }

    /* 剩余额度（credits.balance，字符串数字）与约可用消息 */
    if let Some(c) = &usage.credits {
        if c.has_credits {
            if let Some(b) = c.balance.as_deref().and_then(|s| s.parse::<f64>().ok()) {
                items.push(BalanceItem {
                    label: "剩余额度".into(),
                    value: format!("{b:.2}"),
                    sub: Some("credits".into()),
                    used_percent: None,
                    reset_at: None,
                });
            }
            if let Some(r) = c.approx_local_messages.as_deref().and_then(fmt_range) {
                let sub = c
                    .approx_cloud_messages
                    .as_deref()
                    .and_then(fmt_range)
                    .map(|cr| format!("云端 {cr}"));
                items.push(BalanceItem {
                    label: "约可用消息".into(),
                    value: r,
                    sub,
                    used_percent: None,
                    reset_at: None,
                });
            }
        }
    }

    /* 可用额度重置次数 */
    if let Some(n) = usage
        .rate_limit_reset_credits
        .as_ref()
        .and_then(|r| r.available_count)
    {
        if n > 0 {
            items.push(BalanceItem {
                label: "可用重置次数".into(),
                value: n.to_string(),
                sub: None,
                used_percent: None,
                reset_at: None,
            });
        }
    }

    /* 其它模型限额（如 gpt-reserve） */
    if let Some(extra) = &usage.additional_rate_limits {
        for l in extra {
            if let (Some(name), Some(rl)) = (l.limit_name.as_deref(), l.rate_limit.as_ref()) {
                if let Some(w) = rl.primary_window.as_ref() {
                    items.push(BalanceItem {
                        label: name.to_string(),
                        value: format!("{}%", parse_percent(w.used_percent)),
                        sub: fmt_reset(w.reset_at).map(|s| format!("重置 {s}")),
                        used_percent: None,
                        reset_at: w.reset_at,
                    });
                }
            }
        }
    }

    AgentBalance {
        provider: "chatgpt".into(),
        name: format_plan(usage.plan_type),
        kind: BalanceKind::UsagePercent,
        items,
        raw: Some("https://chatgpt.com".into()),
        refreshed_at: now_secs(),
        error: None,
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
 * 用 access_token 拉取 ChatGPT 用量。
 * 返回 ApiResponse<AgentBalance>：失败时 error 带中文原因（不 panic）。
 */
pub async fn fetch_chatgpt(
    access_token: &str,
    account_id: Option<&str>,
) -> ApiResponse<AgentBalance> {
    let client = match reqwest::Client::builder().user_agent(USER_AGENT).build() {
        Ok(c) => c,
        Err(e) => return ApiResponse::err(format!("初始化 HTTP 客户端失败: {e}")),
    };

    let mut req = client
        .get(USAGE_ENDPOINT)
        .bearer_auth(access_token)
        .header("Accept", "application/json");
    if let Some(aid) = account_id {
        req = req.header("ChatGPT-Account-Id", aid);
    }

    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => return ApiResponse::err(format!("请求 ChatGPT 用量接口失败: {e}")),
    };

    if !resp.status().is_success() {
        // 401 通常是 token 失效 / 被登出
        let status = resp.status().as_u16();
        let msg = if status == 401 {
            "ChatGPT 访问被拒绝（401）：access_token 可能已失效，请重新获取或在浏览器重新登录 ChatGPT".to_string()
        } else {
            format!("ChatGPT 用量接口返回 HTTP {status}")
        };
        return ApiResponse::err(msg);
    }

    match resp.json::<UsageResponse>().await {
        Ok(usage) => ApiResponse::ok(build_balance(usage)),
        Err(e) => ApiResponse::err(format!("解析 ChatGPT 用量响应失败: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn percent_is_rounded_and_clamped() {
        assert_eq!(parse_percent(24.4), 24);
        assert_eq!(parse_percent(42.6), 43);
        assert_eq!(parse_percent(120.0), 100);
        assert_eq!(parse_percent(-5.0), 0);
    }

    #[test]
    fn plan_has_readable_fallback() {
        assert_eq!(format_plan(Some("plus".into())), "ChatGPT PLUS");
        assert_eq!(format_plan(None), "ChatGPT UNKNOWN");
    }

    #[test]
    fn plus_windows_map_to_session_and_weekly() {
        let usage: UsageResponse = serde_json::from_value(json!({
            "plan_type": "plus",
            "rate_limit": {
                "primary_window":   { "used_percent": 24.4, "reset_at": 1_750_000_000 },
                "secondary_window": { "used_percent": 42.6, "reset_at": 1_750_100_000 }
            }
        }))
        .expect("parse usage");

        let b = build_balance(usage);
        assert_eq!(b.name, "ChatGPT PLUS");
        assert_eq!(b.items[0].label, "本时段已用");
        assert_eq!(b.items[0].value, "24%");
        assert_eq!(b.items[1].label, "本周已用");
        assert_eq!(b.items[1].value, "43%");
        /* 窗口的重置时刻必须作为**机器值**带出来：徽章要拿它算「2 小时后重置」，
           而 sub 里那句「重置 10-30 14:23」是给人看的文本，换算不出相对时间 */
        assert_eq!(b.items[0].reset_at, Some(1_750_000_000));
        assert_eq!(b.items[1].reset_at, Some(1_750_100_000));
        /* sub 必须精确到分钟，且带「月 / 日」——只给日期时用户判断不了还剩多久 */
        let sub = b.items[0].sub.as_deref().expect("reset sub");
        assert!(sub.starts_with("重置 "), "sub = {sub}");
        assert!(sub.contains('月') && sub.contains('日'), "sub = {sub}");
        assert!(sub.contains(':'), "sub = {sub}");
        assert!(b.error.is_none());
    }

    #[test]
    fn single_window_is_treated_as_weekly() {
        let usage: UsageResponse = serde_json::from_value(json!({
            "plan_type": "pro",
            "rate_limit": { "primary_window": { "used_percent": 10.0 } }
        }))
        .expect("parse usage");

        let b = build_balance(usage);
        assert_eq!(b.name, "ChatGPT PRO");
        assert_eq!(b.items.len(), 1);
        assert_eq!(b.items[0].label, "本周已用");
        /* 接口没给 reset_at 时留 None —— 徽章据此隐藏「N 小时后重置」那行，
           而不是编一个假时刻 */
        assert_eq!(b.items[0].reset_at, None);
    }

    #[test]
    fn limit_reached_annotates_session_window() {
        let usage: UsageResponse = serde_json::from_value(json!({
            "plan_type": "plus",
            "rate_limit": {
                "limit_reached": true,
                "primary_window":   { "used_percent": 100.0, "reset_at": 1_750_000_000 },
                "secondary_window": { "used_percent": 29.0, "reset_at": 1_750_100_000 }
            }
        }))
        .expect("parse usage");

        let b = build_balance(usage);
        assert_eq!(b.items[0].value, "100%");
        assert!(b.items[0].sub.as_deref().unwrap().contains("已达上限"));
    }

    #[test]
    fn credits_and_reset_credits_are_surfaced() {
        let usage: UsageResponse = serde_json::from_value(json!({
            "plan_type": "plus",
            "rate_limit": { "primary_window": { "used_percent": 100.0 } },
            "credits": { "has_credits": true, "balance": "984.3062227500",
                         "approx_local_messages": [246, 1280], "approx_cloud_messages": [39, 246] },
            "rate_limit_reset_credits": { "available_count": 2 }
        }))
        .expect("parse usage");

        let b = build_balance(usage);
        let labels: Vec<&str> = b.items.iter().map(|i| i.label.as_str()).collect();
        assert!(labels.contains(&"剩余额度"));
        assert!(labels.contains(&"约可用消息"));
        assert!(labels.contains(&"可用重置次数"));

        let bal = b.items.iter().find(|i| i.label == "剩余额度").unwrap();
        assert_eq!(bal.value, "984.31");
        let msg = b.items.iter().find(|i| i.label == "约可用消息").unwrap();
        assert_eq!(msg.value, "246~1280");
    }

    #[test]
    fn additional_rate_limits_become_items() {
        let usage: UsageResponse = serde_json::from_value(json!({
            "plan_type": "plus",
            "rate_limit": { "primary_window": { "used_percent": 1.0 } },
            "additional_rate_limits": [
                { "limit_name": "gpt-reserve",
                  "rate_limit": { "primary_window": { "used_percent": 0.0, "reset_at": 1_790_312_274 } } }
            ]
        }))
        .expect("parse usage");

        let b = build_balance(usage);
        let it = b.items.iter().find(|i| i.label == "gpt-reserve").unwrap();
        assert_eq!(it.value, "0%");
    }

    #[test]
    fn missing_fields_degrade_gracefully() {
        let usage: UsageResponse = serde_json::from_value(json!({})).expect("parse empty");
        let b = build_balance(usage);
        assert_eq!(b.name, "ChatGPT UNKNOWN");
        assert!(b.items.is_empty());
    }
}
