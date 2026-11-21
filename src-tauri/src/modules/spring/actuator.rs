/*
 * Spring Boot 服务台 · Actuator 探活
 * ------------------------------------------------------------------
 * 只打两个端点，都是本机 127.0.0.1：
 *   GET /actuator/health  → status + components（db / diskSpace / redis …）
 *   GET /actuator/info    → app.name / app.version（可选，失败不影响整体）
 *
 * **为什么不打 /actuator/env**：它的响应里带着全部配置项（含数据库密码、密钥），
 * 这里只是为了显示「当前 profile」，为此把整份配置读进内存再传一遍给前端，
 * 收益和风险完全不成比例。profile 从命令行取就够了（见 detect::parse_profiles）。
 *
 * **错误要分得清**：连不上 / 超时 / 404（没暴露）/ 401（要认证）/ 不是 JSON，
 * 这几种的处置完全不同 —— 404 说明服务是好的只是没开 actuator，
 * 而「连不上」说明端口上根本不是 HTTP 服务。糊成一句「探活失败」等于没说。
 *
 * 解析部分是纯函数，在文件底部配单测。
 * @Author: fu
 */
use std::time::Duration;

use reqwest::Client;
use serde_json::Value;

use crate::modules::spring::detect::human_bytes;
use crate::modules::spring::models::{ActuatorInfo, HealthComponent};

/** 本机探活 3 秒足够；更慢说明那个端口上跑的根本不是 HTTP 服务 */
pub const ACTUATOR_TIMEOUT: Duration = Duration::from_secs(3);

pub fn base_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

pub fn client() -> Result<Client, String> {
    Client::builder()
        .timeout(ACTUATOR_TIMEOUT)
        /*
         * 不跟重定向：有些服务会把 /actuator/health 重定向到登录页，
         * 跟过去只会拿到一坨 HTML，然后报「不是 JSON」——比直接报 302 更难懂。
         */
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("HTTP 客户端初始化失败：{e}"))
}

/** 取一个 JSON 端点。失败时返回**具体原因**，不要糊成一句话。 */
async fn get_json(client: &Client, url: &str) -> Result<Value, String> {
    let resp = client
        .get(url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                "超时".to_string()
            } else if e.is_connect() {
                "端口没有响应".to_string()
            } else {
                format!("请求失败：{e}")
            }
        })?;

    let code = resp.status().as_u16();
    if code == 404 {
        return Err("404 没暴露这个端点".to_string());
    }
    if code == 401 || code == 403 {
        return Err(format!("{code} 需要认证"));
    }
    if code == 302 || code == 301 {
        return Err(format!("{code} 被重定向（多半是登录页）"));
    }
    if !resp.status().is_success() {
        return Err(format!("HTTP {code}"));
    }

    let text = resp.text().await.map_err(|e| format!("读响应失败：{e}"))?;
    serde_json::from_str::<Value>(&text).map_err(|_| "返回的不是 JSON".to_string())
}

/** 探一个端口。拿不到就返回可读原因，调用方决定是显示成错误还是忽略。 */
pub async fn probe(client: &Client, port: u16) -> Result<ActuatorInfo, String> {
    let base = base_url(port);
    let health = get_json(client, &format!("{base}/actuator/health"))
        .await
        .map_err(|e| format!("{e}（/actuator/health）"))?;

    let status = health
        .get("status")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let components = parse_components(&health);

    /* info 是可选的：没开不该让整次探活失败，只是少两个字段 */
    let (app_name, app_version) = match get_json(client, &format!("{base}/actuator/info")).await {
        Ok(info) => parse_info(&info),
        Err(_) => (None, None),
    };

    Ok(ActuatorInfo {
        base_url: base,
        app_name,
        app_version,
        status,
        components,
    })
}

/** health 的 components 字段 → 列表（按名字排序，界面顺序才稳定） */
pub fn parse_components(health: &Value) -> Vec<HealthComponent> {
    let map = match health.get("components").and_then(|v| v.as_object()) {
        Some(m) => m,
        None => return Vec::new(),
    };
    let mut out: Vec<HealthComponent> = map
        .iter()
        .map(|(name, v)| HealthComponent {
            name: name.clone(),
            status: v
                .get("status")
                .and_then(|s| s.as_str())
                .unwrap_or("UNKNOWN")
                .to_string(),
            detail: component_detail(v),
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/**
 * 组件自身的补充信息。
 *
 * 优先给 `error`（DOWN 的组件才有，是排查的关键信息），
 * 其次数据库名，最后磁盘给「剩余 / 总量」——
 * 直接显示 `free: 123456789` 这种原始字节数没人读得懂。
 */
pub fn component_detail(v: &Value) -> Option<String> {
    let d = v.get("details")?;
    if let Some(e) = d.get("error").and_then(|x| x.as_str()) {
        return Some(e.to_string());
    }
    if let Some(db) = d.get("database").and_then(|x| x.as_str()) {
        return Some(db.to_string());
    }
    let free = d.get("free").and_then(|x| x.as_f64());
    let total = d.get("total").and_then(|x| x.as_f64());
    if let (Some(f), Some(t)) = (free, total) {
        return Some(format!("剩余 {} / {}", human_bytes(f), human_bytes(t)));
    }
    if let Some(p) = d.get("path").and_then(|x| x.as_str()) {
        return Some(p.to_string());
    }
    None
}

/** /actuator/info → (name, version)。app 优先，其次 build（maven 插件生成的 build-info）。 */
pub fn parse_info(info: &Value) -> (Option<String>, Option<String>) {
    let pick = |root: &str, key: &str| -> Option<String> {
        info.get(root)
            .and_then(|a| a.get(key))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    };
    let name = pick("app", "name");
    let version = pick("app", "version");
    if name.is_some() || version.is_some() {
        return (name, version);
    }
    (pick("build", "artifact"), pick("build", "version"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn 基础_url_固定走本机() {
        assert_eq!(base_url(8080), "http://127.0.0.1:8080");
    }

    /* ---- components ---- */
    #[test]
    fn 解析组件并按名字排序() {
        let h = json!({
            "status": "UP",
            "components": {
                "redis": { "status": "UP" },
                "db": { "status": "UP", "details": { "database": "MySQL" } },
                "diskSpace": { "status": "UP" }
            }
        });
        let c = parse_components(&h);
        assert_eq!(c.iter().map(|x| x.name.as_str()).collect::<Vec<_>>(), vec!["db", "diskSpace", "redis"]);
        assert_eq!(c[0].detail.as_deref(), Some("MySQL"));
        assert_eq!(c[2].detail, None);
    }

    #[test]
    fn 没有_components_就是空列表() {
        assert!(parse_components(&json!({ "status": "UP" })).is_empty());
        assert!(parse_components(&json!({})).is_empty());
    }

    /* 组件没写 status 时给 UNKNOWN，不要编一个 UP 出来 */
    #[test]
    fn 组件缺_status_给_UNKNOWN() {
        let c = parse_components(&json!({ "components": { "x": {} } }));
        assert_eq!(c[0].status, "UNKNOWN");
    }

    /* ---- detail ---- */
    #[test]
    fn 组件详情优先给错误原因() {
        let v = json!({ "status": "DOWN", "details": { "error": "connection refused", "database": "MySQL" } });
        assert_eq!(component_detail(&v).as_deref(), Some("connection refused"));
    }

    #[test]
    fn 磁盘组件换算成可读单位() {
        let v = json!({
            "status": "UP",
            "details": { "total": 1073741824.0, "free": 536870912.0, "threshold": 10485760.0 }
        });
        assert_eq!(component_detail(&v).as_deref(), Some("剩余 512.0 MB / 1.0 GB"));
    }

    #[test]
    fn 没有可展示的详情就返回_None() {
        assert_eq!(component_detail(&json!({ "status": "UP" })), None);
        assert_eq!(component_detail(&json!({ "status": "UP", "details": {} })), None);
    }

    /* ---- info ---- */
    #[test]
    fn info_优先用_app_段() {
        let v = json!({ "app": { "name": "order-service", "version": "1.2.0" }, "build": { "artifact": "x" } });
        assert_eq!(parse_info(&v), (Some("order-service".into()), Some("1.2.0".into())));
    }

    /* 很多项目只在 build 段有信息（maven 的 build-info 插件） */
    #[test]
    fn info_退回_build_段() {
        let v = json!({ "build": { "artifact": "order-service", "version": "2.0.1" } });
        assert_eq!(parse_info(&v), (Some("order-service".into()), Some("2.0.1".into())));
    }

    #[test]
    fn info_两段都没有就是_None() {
        assert_eq!(parse_info(&json!({})), (None, None));
        assert_eq!(parse_info(&json!({ "app": {} })), (None, None));
    }
}
