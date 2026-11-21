/*
 * 智能体余额模块 · Qoder CN 用量（走本机 qoderclicn CLI）
 * ------------------------------------------------------------------
 * 为什么走 CLI 而不是 HTTP：Qoder 有**两套**接口，而两套的凭证都拿不到 ——
 *   · IDE 内部接口（qoder.rs 走的那条）认 Bearer，token 存在 Electron safeStorage
 *     加密的 auth.v1.dat 里，**已实测解不开**；
 *   · 网页控制台（qoder.cn/api/...）认 Cookie + X-CSRF-TOKEN，而账号密码登录带
 *     阿里云验证码（`captchaScene.create_sessions` 就是登录场景），**无法自动化**。
 * 但 qoderclicn **自己已经登录**（~/.qoder-cn/.auth/user，同样是加密的，取不出来）。
 * 于是「让 CLI 去问、我们读它的回答」是唯一**不需要任何凭证**的路径。
 *
 * 协议（从 CLI bundle 反推 + 本机实测跑通）：
 *   qoderclicn -p --input-format stream-json --output-format stream-json
 *     --no-session-persistence --strict-mcp-config --setting-sources ""
 *   stdin 逐行写：
 *     {"type":"control_request","request_id":"r1","request":{"subtype":"initialize"}}
 *     {"type":"control_request","request_id":"r2","request":{"subtype":"get_usage_info"}}
 *     {"type":"control_request","request_id":"r3","request":{"subtype":"end_session"}}
 *   stdout 逐行回：
 *     {"type":"control_response","response":{"subtype":"success","request_id":"r2",
 *      "response":{"usage":{…}}}}
 *
 * 五个必须记住的点：
 *   1. **必须先 initialize**。CLI 里有个白名单
 *      `new Set(["initialize","get_models","end_session","interrupt"])` ——
 *      只有这些能在「会话尚未初始化」时发。`get_usage_info` 不在其中，
 *      单独发会回一条 error。
 *   2. **一律用原生二进制**（`~/.qoder-cn/bin/qoderclicn/qoderclicn-<版本>`）。
 *      Homebrew / npm 上那个 `qoderclicn` 是 `#!/usr/bin/env node` 的包装脚本：
 *      实测同一请求 **20.3 秒 vs 2.0 秒**（node 要先加载 34MB 的 bundle），
 *      而且 GUI 应用的 PATH 里通常没有 node —— 直接用必然失败（同 jvm / maven 的坑）。
 *   3. 耗时几乎全在 `initialize`（等模型目录），`get_usage_info` 本身约 1 秒。
 *   4. **不要试 `-p "/usage"`**：实测回
 *      `Exiting due to command result that is not supported in non-interactive mode`
 *      —— 斜杠命令这条路在非交互模式下是被明确关掉的。
 *   5. **未登录时不发 control_response**，而是发一条
 *      `{"type":"result","is_error":true,"result":"Not logged in · Please run /login"}`
 *      并以退出码 1 结束。所以「找不到 r2 的响应」要顺着 result 行去解释原因，
 *      不能只说一句「没拿到数据」。
 *
 * 字段语义（CLI 自己的口径，见 bundle 里的 xcA / jAA）：
 *   total_remaining = userQuota.remaining + addOnQuota.remaining + orgResourcePackage.remaining
 *   quota_exceeded  = isQuotaExceeded || total_remaining <= 0
 *
 * 两个和 IDE 那条路**不一样**的地方，写解析时最容易搞混：
 *   · 这条路由的 `percentage` 是 **0~100**（IDE 那条是 0~1 的小数）；
 *   · `orgResourcePackage.cap` 为 **-1 表示「不限量」**（不是「总量为 -1」），
 *     此时服务端给的 `percentage` 恒为 0，**没有任何百分比可言** ——
 *     所以只能出绝对值，也就不会参与健康度与侧栏角标。
 * @Author: fu
 */
use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::{Local, NaiveDate, TimeZone};
use serde::Deserialize;
use tauri::AppHandle;

use crate::core::api::ApiResponse;
use crate::core::proc::run_timeout_stdin_in;
use crate::modules::balances::models::{AgentBalance, BalanceItem, BalanceKind, DayMark};
use crate::modules::balances::qoder::{fmt_num, format_name};
use crate::modules::balances::storage;

/* 控制协议的三个请求 id。响应靠它认领，不能只看「第一条」—— initialize 的响应有 70KB */
const REQ_INIT: &str = "r1";
const REQ_USAGE: &str = "r2";
const REQ_END: &str = "r3";

/*
 * CLI 参数。逐个都有理由：
 *   --input-format stream-json   控制协议的前提（也是 -p 能读 stdin 的唯一方式）
 *   --output-format stream-json  否则吐的是给人看的表格，没法解析
 *   --no-session-persistence     每次刷新都会起一个进程，不能往会话列表里灌垃圾
 *   --strict-mcp-config          不加载用户的 MCP 服务器（每台机器都不同，且要连网）
 *   --setting-sources ""         不加载用户设置 —— 实测这会把 SessionStart 钩子一并关掉，
 *                                否则每 15 分钟刷新一次就要跑一遍用户自己的钩子（含安全扫描）
 */
const CLI_ARGS: [&str; 9] = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--setting-sources",
    "",
];

/*
 * 超时。实测原生二进制约 2 秒；留 45 秒是为了兼容「用户用 Homebrew 那个包装脚本」
 * （20 秒起）以及机器冷启动时的模型目录拉取。
 * 超时必须 kill —— 不加超时的话 CLI 卡住会让 IPC 永远不回、界面永远转圈。
 */
const CLI_TIMEOUT: Duration = Duration::from_secs(45);

/* stderr 尾巴的限长：CLI 的诊断信息可能很长，只取末尾一段 */
const STDERR_TAIL: usize = 160;

/*
 * 「今日已用」条目的标签。
 * ⚠️ 改这里必须同步改前端 `format.ts` 的 SHORT_LABEL（否则进蓝牙摘要时
 *    会退回全称、把 95 字节预算吃掉）—— `npm run check:labels` 会挡一道。
 */
const LABEL_TODAY: &str = "今日已用";

/* sled 里基线键的指标名：组织资源包（本人当月从共享池取用） */
const METRIC_ORG: &str = "org_used";
/* 个人额度：只在没有组织资源包可跟时才用（个人版账号） */
const METRIC_USER: &str = "user_used";

/* ============================ 协议报文 ============================ */

/*
 * stdout 的一行。三种形态都要能接住：
 *   · control_response（正常）
 *   · result（未登录 / 会话级错误，带 is_error）
 *   · system / assistant / stream_event（其余噪音，忽略）
 */
#[derive(Debug, Default, Deserialize)]
struct Envelope {
    #[serde(rename = "type", default)]
    kind: Option<String>,
    #[serde(default)]
    response: Option<EnvelopeInner>,
    /* result 行才有 */
    #[serde(default)]
    result: Option<String>,
    #[serde(default, rename = "is_error")]
    is_error: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
struct EnvelopeInner {
    #[serde(default)]
    subtype: Option<String>,
    #[serde(default, rename = "request_id")]
    request_id: Option<String>,
    #[serde(default)]
    response: Option<UsagePayload>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct UsagePayload {
    #[serde(default)]
    usage: Option<CliUsage>,
}

/* ============================ 用量数据 ============================ */

/*
 * `get_usage_info` 的响应体。字段全部可选 —— 服务端增删字段不该让整条解析失败
 * （与 chatgpt.rs / qoder.rs 同一原则：缺字段降级，不整体报错）。
 *
 * 接口还会回 `userId` / `totalUsagePercentage` / `isHighestTier` / `isPlanQuotaProrated`，
 * **故意不解析**：前两个与 `userQuota` 重复，后两个是展示无关的计费开关。
 * 只留「拿得准、且真的会显示」的字段 —— 多解析一个含义存疑的字段，
 * 就多一次把界面上的数字搞错的机会。
 */
#[derive(Debug, Default, Clone, Deserialize)]
struct CliUsage {
    #[serde(default, rename = "userType")]
    user_type: Option<String>,
    #[serde(default, rename = "isQuotaExceeded")]
    is_quota_exceeded: Option<bool>,
    /* 毫秒。实测 = 本周期结束时刻（2026-09-30 00:00 +08:00） */
    #[serde(default, rename = "expiresAt")]
    expires_at: Option<i64>,
    #[serde(default, rename = "upgradeUrl")]
    upgrade_url: Option<String>,
    #[serde(default, rename = "userQuota")]
    user_quota: Option<CliQuota>,
    #[serde(default, rename = "addOnQuota")]
    add_on_quota: Option<CliQuota>,
    #[serde(default, rename = "orgResourcePackage")]
    org_resource_package: Option<CliOrgPackage>,
}

#[derive(Debug, Default, Clone, Deserialize)]
struct CliQuota {
    #[serde(default)]
    used: Option<f64>,
    #[serde(default)]
    total: Option<f64>,
    #[serde(default)]
    remaining: Option<f64>,
    #[serde(default)]
    unit: Option<String>,
}

/*
 * 组织资源包。注意 `cap` 与 `total` **不是一回事**：
 * `total` 是「这个池有多少」，`cap` 是「上限」，-1 表示不限量。
 * 实测该账号是 `{used: 4042, cap: -1, remaining: 26076, percentage: 0}` ——
 * used + remaining ≠ cap，所以**不能拿 cap 当分母**，也不能拿它当总量。
 * 这里的 `percentage` 同理不用（cap = -1 时它恒为 0，照抄会显示「已用 0%」）。
 */
#[derive(Debug, Default, Clone, Deserialize)]
struct CliOrgPackage {
    #[serde(default)]
    used: Option<f64>,
    #[serde(default)]
    cap: Option<f64>,
    #[serde(default)]
    remaining: Option<f64>,
    /* 服务端明确说这个包能不能用；为 false 时不该拿 remaining 去显示 */
    #[serde(default)]
    available: Option<bool>,
    #[serde(default)]
    unit: Option<String>,
}

/* ============================ 纯逻辑 ============================ */

/** 三个请求拼成一段 stdin 文本（末尾必须有换行，否则最后一行不算写完） */
fn build_requests() -> String {
    format!(
        concat!(
            r#"{{"type":"control_request","request_id":"{}","request":{{"subtype":"initialize"}}}}"#,
            "\n",
            r#"{{"type":"control_request","request_id":"{}","request":{{"subtype":"get_usage_info"}}}}"#,
            "\n",
            r#"{{"type":"control_request","request_id":"{}","request":{{"subtype":"end_session"}}}}"#,
            "\n"
        ),
        REQ_INIT, REQ_USAGE, REQ_END
    )
}

/*
 * 从 stdout 里挑出 `get_usage_info` 的答案。
 *
 * 按 `request_id` 认领而不是「取最后一条」：一次会话里 control_response 有好几条，
 * initialize 那条有 70KB，误取它只会得到一堆命令清单。
 *
 * 失败时把 CLI 自己的说法带出来 —— 「未登录」和「协议变了」要能分开：
 * 前者让用户去登录，后者是我们该改代码，糊成一句「没拿到数据」等于没说。
 */
fn parse_usage_response(stdout: &str) -> Result<CliUsage, String> {
    let mut cli_error: Option<String> = None;

    for line in stdout.lines() {
        let line = line.trim();
        /* stderr 可能被混进来（或被调用方拼在末尾），只认 JSON 对象行 */
        if line.is_empty() || !line.starts_with('{') {
            continue;
        }
        let Ok(env) = serde_json::from_str::<Envelope>(line) else {
            continue;
        };

        match env.kind.as_deref() {
            Some("control_response") => {
                let Some(inner) = env.response else { continue };
                if inner.request_id.as_deref() != Some(REQ_USAGE) {
                    continue;
                }
                match inner.subtype.as_deref() {
                    Some("success") => {
                        return match inner.response.and_then(|p| p.usage) {
                            Some(u) => Ok(u),
                            None => Err(
                                "Qoder CLI 返回了成功，但用量字段是空的（账号可能刚切换，\
                                 或该账号没有额度池）"
                                    .to_string(),
                            ),
                        };
                    }
                    Some("error") => {
                        return Err(format!(
                            "Qoder CLI 拒绝查询用量：{}",
                            inner.error.unwrap_or_else(|| "未给出原因".into())
                        ));
                    }
                    _ => continue,
                }
            }
            /* 未登录等场景：CLI 不发 control_response，只发一条 is_error 的 result */
            Some("result") => {
                if env.is_error.unwrap_or(false) {
                    if let Some(r) = env.result.filter(|s| !s.trim().is_empty()) {
                        cli_error = Some(r);
                    }
                }
            }
            _ => {}
        }
    }

    Err(match cli_error {
        Some(r) => format!(
            "Qoder CLI 未返回用量：{r}\
             （若提示未登录，先在终端执行一次 `qoderclicn` 完成登录）"
        ),
        None => "Qoder CLI 没有返回用量数据（CLI 版本可能已变更，控制协议不再兼容）".to_string(),
    })
}

/* 取 stderr 末尾若干字符，用来补充失败原因 */
fn tail_of(s: &str, max: usize) -> String {
    let t = s.trim();
    if t.is_empty() {
        return String::new();
    }
    let chars: Vec<char> = t.chars().collect();
    if chars.len() <= max {
        return t.to_string();
    }
    let tail: String = chars[chars.len() - max..].iter().collect();
    format!("…{tail}")
}

/* `qoderclicn-1.1.8` → (1, 1, 8)。不认识的形态一律返回 None，不猜 */
fn parse_semver(s: &str) -> Option<(u64, u64, u64)> {
    let mut it = s.split('.');
    let a = it.next()?.parse::<u64>().ok()?;
    let b = it.next()?.parse::<u64>().ok()?;
    let c = it.next()?.parse::<u64>().ok()?;
    if it.next().is_some() {
        return None;
    }
    Some((a, b, c))
}

/*
 * 从一堆文件名里挑出**版本最高**的原生二进制。
 *
 * 为什么挑最高版本而不是「第一个」：~/.qoder-cn/bin/qoderclicn/ 下会同时留着
 * 多个版本（实测有 1.1.7 与 1.1.8），目录顺序不保证，挑错会用到旧协议。
 */
fn pick_latest_from_names<I, S>(names: I) -> Option<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut best: Option<((u64, u64, u64), String)> = None;
    for n in names {
        let n = n.as_ref();
        let Some(rest) = n.strip_prefix("qoderclicn-") else {
            continue;
        };
        let Some(v) = parse_semver(rest) else { continue };
        if best.as_ref().map_or(true, |(bv, _)| v > *bv) {
            best = Some((v, n.to_string()));
        }
    }
    best.map(|(_, n)| n)
}

fn pick_latest_native(dir: &Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    let names: Vec<String> = entries
        .flatten()
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();
    pick_latest_from_names(names).map(|n| dir.join(n))
}

/*
 * CLI 候选路径，**原生二进制优先**。
 *
 * 顺序即优先级，理由见文件头第 2 点：包装脚本在 GUI 环境里根本起不来。
 * 最后两个系统路径留着，是为了兼容用户自己 `npm i -g` 或 brew 装的场景 ——
 * 能用就用，不行会在下一步退化成明确的提示。
 */
fn cli_candidates() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();

    /* 用户显式指定优先（测试与排障用） */
    if let Ok(p) = std::env::var("QODER_CLI") {
        let p = p.trim();
        if !p.is_empty() {
            out.push(PathBuf::from(p));
        }
    }

    if let Ok(home) = std::env::var("HOME") {
        let home = PathBuf::from(home);
        if let Some(p) = pick_latest_native(&home.join(".qoder-cn").join("bin").join("qoderclicn")) {
            out.push(p);
        }
        out.push(home.join(".local").join("bin").join("qoderclicn"));
    }

    out.push(PathBuf::from("/opt/homebrew/bin/qoderclicn"));
    out.push(PathBuf::from("/usr/local/bin/qoderclicn"));

    /* 去重（HOME 与系统路径可能指向同一处） */
    let mut uniq: Vec<PathBuf> = Vec::new();
    for p in out {
        if !uniq.contains(&p) {
            uniq.push(p);
        }
    }
    uniq
}

/** 第一个真实存在的候选；都没有则 None */
fn find_cli() -> Option<PathBuf> {
    cli_candidates().into_iter().find(|p| p.is_file())
}

/* ============================ 今日用量（本地差分） ============================ */

/*
 * 为什么必须本地算：`get_usage_info` 只给**当月累计**的 used，接口里
 * **根本没有「今日」这一维**（2026-09-23 抓真实响应确认，见文件头的字段清单）。
 * 所以今日用量 = 当前累计 − 今日起始累计，而「今日起始」只能我们自己记。
 */

/** "2026-09-23" → 日期；格式不对返回 None（不猜、不 panic） */
fn parse_day(s: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()
}

/** 两个日期相差几天（今天 − 那天）。任一边解析不出来返回 None */
fn day_gap(today: &str, prev: &str) -> Option<i64> {
    Some(parse_day(today)?.signed_duration_since(parse_day(prev)?).num_days())
}

/*
 * 推进今日基线，返回 (今日增量, 新基线)。**纯函数** —— 不碰 sled、不读时钟，
 * 好让每种边界都能在单测里直接喂数据断言（见 tests::advance_day_*）。
 *
 * 四种情况，每一种都对应一个「否则界面就会说谎」的坑：
 *
 *   ① 首次观测（prev = None）：**返回 None 而不是 0**。
 *      「今日 0」是假数据 —— 用户今天很可能已经用了不少，只是我们第一次见它。
 *      宁可这一档不显示，也不能报一个让人以为「今天还没动」的 0。
 *
 *   ② 跨天 1 天（gap == 1）：**拿前一天最后观测值做新基线**。
 *      这样今天第一次刷新就能算出完整的今日用量（含凌晨到现在的部分）。
 *      若改用「今天首次观测值」当基线，那一段就永远漏掉了。
 *
 *   ③ 跨天 > 1 天（gap > 1，比如隔了三天没开电脑）：**返回 None**。
 *      中间的用量无从得知，现有基线也不代表「今天开始时」——
 *      硬算出来的是「这三天一共用了多少」，标成「今日」就是撒谎。
 *      同时把基线挪到当前值，从今天重新开始记。
 *
 *   ④ 同天（gap == 0）：基线不动，增量 = 当前 − 基线。
 *
 * 另有一条贯穿的判据：used 是**当月累计**，每月会重置归零，
 * 于是周期翻页时当前值 < 上次观测值，差分会出负数。
 * 这时判定为「周期已重置」，把基线挪到当前值、今日归零 ——
 * 不能让「今日 −4135 credits」出现在界面上。
 */
fn advance_day(prev: Option<&DayMark>, today: &str, used: f64) -> (Option<f64>, DayMark) {
    /* 脏数据（NaN / 负数）不推进：它只会把基线带歪 */
    if !used.is_finite() || used < 0.0 {
        return match prev {
            Some(p) => (None, p.clone()),
            None => (None, DayMark { day: today.into(), base: used, last: used }),
        };
    }

    let Some(p) = prev else {
        /* ① 首次：只记锚点，不算增量 */
        return (
            None,
            DayMark {
                day: today.into(),
                base: used,
                last: used,
            },
        );
    };

    let gap = day_gap(today, &p.day);

    /* 周期重置（或服务端回退了数字）：当前值不该小于上次观测 */
    let reset = used < p.last;

    let (delta, base) = match gap {
        /* ④ 同天 */
        Some(0) => {
            if reset {
                (Some(0.0), used)
            } else {
                (Some(used - p.base), p.base)
            }
        }
        /* ② 昨天 → 用它最后观测值做今天的基线 */
        Some(1) => {
            if reset {
                (Some(0.0), used)
            } else {
                (Some(used - p.last), p.last)
            }
        }
        /* ③ 断档超过一天（或日期算不出来）：今日无从得知，从今天重新开始记 */
        _ => (None, used),
    };

    let delta = delta.map(|d| if d < 0.0 { 0.0 } else { d });

    (
        delta,
        DayMark {
            day: today.into(),
            base,
            last: used,
        },
    )
}

/*
 * 选一个「值得跟踪今日增量」的池。
 *
 * 优先组织资源包（orgResourcePackage.used = 本人当月从共享池取用），
 * 因为团队账号里**个人额度常常已用尽**（实测 3000/3000），真正持续变化的
 * 是共享池这一路；没有组织包时（个人版账号）才退回个人额度。
 *
 * 返回 (指标名, 当前累计值, 单位)。三个池口径各不相同，**只跟一个** ——
 * 混着减就又掉进「组织级和本人级合并」那个坑了。
 */
fn tracked_used(u: &CliUsage) -> Option<(&'static str, f64, String)> {
    let org = u.org_resource_package.as_ref();
    let org_usable = org.map_or(false, |o| o.available != Some(false));
    if let Some(o) = org.filter(|_| org_usable) {
        if let Some(v) = o.used.filter(|v| v.is_finite()) {
            return Some((METRIC_ORG, v, unit_or(&o.unit)));
        }
    }
    let user = u.user_quota.as_ref()?;
    let v = user.used.filter(|v| v.is_finite())?;
    Some((METRIC_USER, v, unit_or(&user.unit)))
}

/* ============================ 映射为展示项 ============================ */

fn unit_or(u: &Option<String>) -> String {
    u.as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("credits")
        .to_string()
}

/* 剩余量：接口直接给了就用它，否则用 总量 − 已用 现算 */
fn remaining_of(used: Option<f64>, total: Option<f64>, remaining: Option<f64>) -> Option<f64> {
    if let Some(r) = remaining.filter(|v| v.is_finite()) {
        return Some(r);
    }
    match (total, used) {
        (Some(t), Some(u)) if t.is_finite() && u.is_finite() => Some(t - u),
        _ => None,
    }
}

/* 有上限的池 → 「已用 X%」；上限拿不到或算不出百分比 → None */
fn pct_item(
    label: &str,
    used: Option<f64>,
    cap: f64,
    remaining: Option<f64>,
    unit: &str,
) -> Option<BalanceItem> {
    let used = match (used.filter(|v| v.is_finite()), remaining) {
        (Some(u), _) => u,
        (None, Some(r)) if r.is_finite() => (cap - r).max(0.0),
        _ => return None,
    };
    let pct = (used / cap * 100.0).clamp(0.0, 100.0);
    let rem = remaining
        .filter(|v| v.is_finite())
        .unwrap_or((cap - used).max(0.0));
    Some(BalanceItem {
        label: label.into(),
        value: format!("{}%", pct.round() as i64),
        sub: Some(format!(
            "剩余 {} / {} {}",
            fmt_num(rem),
            fmt_num(cap),
            unit
        )),
        /* value 已经是百分比，颜色那条路已经覆盖它 —— 别再给第二个来源 */
        used_percent: None,
        reset_at: None,
    })
}

/*
 * 控制台地址：拿接口回的 upgradeUrl 换掉路径。
 *
 * 为什么不写死域名：这个账号在 qoder.com.cn，但产品线里有 qoder.cn ——
 * 与其赌一个，不如沿用服务端自己给的域名（upgradeUrl 一定是当前账号能用的那个），
 * 只把 /pricing 换成 /account/usage。取不到再回落。
 */
fn console_url(upgrade_url: Option<&str>) -> String {
    const FALLBACK: &str = "https://qoder.cn/account/usage";
    let Some(u) = upgrade_url.map(str::trim).filter(|s| !s.is_empty()) else {
        return FALLBACK.into();
    };
    match u.split_once("://") {
        Some((scheme, rest)) => match rest.split_once('/') {
            Some((host, _)) if !host.is_empty() => format!("{scheme}://{host}/account/usage"),
            _ => FALLBACK.into(),
        },
        None => FALLBACK.into(),
    }
}

/*
 * 额度到期日。接口给的是**毫秒**，按本地时区显示 —— 实测这个值正好是
 * 本月最后一天 00:00（+08:00），也就是「本周期结束」，用 UTC 会差一天。
 * 超出 chrono 可表示范围时返回 None（不编造日期）。
 */
fn expiry_date(ms: i64) -> Option<String> {
    let dt = Local.timestamp_opt(ms / 1000, 0).single()?;
    Some(dt.format("%Y-%m-%d").to_string())
}

/*
 * 把 CLI 的用量归一化成余额快照。纯函数（只多一个 now），可以在单测里直接喂数据断言。
 *
 * 展示规则（每一条都对应一个真实会读错的地方）：
 *   · **只有「有上限」的池才出百分比**。组织资源包 cap = -1 是不限量，
 *     服务端给的 percentage 恒为 0 —— 照抄会显示「已用 0%」，看着像额度全新。
 *   · **个人额度在有别的池兜底时降级为绝对值**。团队账号里「个人额度用尽、
 *     组织资源包还有余额」是常态，此时个人额度出百分比会让侧栏角标永远报 0%
 *     （实测该账号正是 3000/3000 用尽 + 组织包 26076 可用）。
 *   · **「合计」只在真的有 2 个以上有余额的池时才出**，否则它和上一条数字相同，
 *     看着像界面出了 bug；但**额度耗尽时一定要出** —— 那时它是唯一的警报。
 *
 * `today` 是「今日已用」的增量（由 advance_day 本地差分算出，**首次观测为 None**），
 * 传 None 时这一条整条不出 —— 没有基线就报「今日 0」是在骗人。
 */
fn build_balance(u: &CliUsage, now: i64, today: Option<(f64, String)>) -> AgentBalance {
    let name = format_name(u.user_type.as_deref());
    let mut items: Vec<BalanceItem> = Vec::new();

    let user = u.user_quota.clone().unwrap_or_default();
    let addon = u.add_on_quota.clone().unwrap_or_default();
    let org = u.org_resource_package.clone().unwrap_or_default();

    let user_unit = unit_or(&user.unit);
    let addon_unit = unit_or(&addon.unit);
    let org_unit = unit_or(&org.unit);

    let user_rem = remaining_of(user.used, user.total, user.remaining);
    let addon_rem = remaining_of(addon.used, addon.total, addon.remaining);
    /* 组织资源包的 cap 不是总量，所以只能用它自己给的 remaining */
    let org_rem = remaining_of(org.used, None, org.remaining);

    /*
     * 1) 组织资源包：网页控制台的主角，放最前（itemPriority 同档时按顺序取主指标）。
     *    服务端明确说这个包不可用时（available = false），它的 remaining 没有意义 ——
     *    整条不出，免得把「不可用」显示成「还剩很多」。
     */
    let org_usable = org.available != Some(false);
    let org_cap = org.cap.filter(|c| c.is_finite() && *c > 0.0);
    if org_usable && (org.used.is_some() || org_rem.is_some()) {
        match (org_cap, org.used, org_rem) {
            (Some(cap), used, rem) => {
                if let Some(it) = pct_item("资源包已用", used, cap, rem, &org_unit) {
                    items.push(it);
                }
            }
            (None, used, Some(rem)) => {
                /*
                 * cap = -1（本人无限额）时，`remaining` 仍然有意义，但它**不是本人的剩余** ——
                 * 它是**整个组织池的剩余**。2026-09-22 对照网页控制台的原始响应确认：
                 *   organization_pool.limit_value − used_value = 46000 − 19901 = 26099
                 * 与 shared_quota.quota_summary.remaining_value = 26099 **精确相等**。
                 *
                 * ⚠️ 而 `used` 是**本人当月**从共享池的取用（控制台卡片「当月周期已用量」，
                 * 截图时 4039 / CLI 实测 4042）。组织自己的总用量是 19901，量级完全不同。
                 *
                 * **两者口径不同，绝不能塞进同一行当「剩余 / 已用」** —— 那会被读成
                 * 「我的额度剩 26071、我只用了 4042」，而事实是组织已用掉 19901。
                 * 控制台自己就是把两者分开展示的（「当月周期已用量 4039」+「可用限额 —」），
                 * 这里照做，并且**把口径写进 label / sub**，不留歧义。
                 */
                items.push(BalanceItem {
                    label: "组织池剩余".into(),
                    value: format!("{} {}", fmt_num(rem), org_unit),
                    sub: Some("全组织共享".into()),
                    /* 组织池没有已知上限（cap = -1 是不限量），算不出百分比 */
                    used_percent: None,
                    reset_at: None,
                });
                if let Some(v) = used.filter(|v| v.is_finite()) {
                    items.push(BalanceItem {
                        label: "资源包已用".into(),
                        value: format!("{} {}", fmt_num(v), org_unit),
                        sub: Some("本人当月".into()),
                        /* 组织池不限量 → 没有分母，不能出百分比 */
                        used_percent: None,
                        reset_at: None,
                    });
                }
            }
            _ => {}
        }
    }

    /*
     * 2) 加量包。
     *    ⚠️ 与组织包同构，所以**同样要确认 `remaining` 的口径**（组织级还是本人级）——
     *    实测响应里根本没有 addOnQuota 字段，无法判断，所以这里**不猜**：
     *    等它真的出现时，先抓一份原始响应，按上面组织包的做法定夺。
     */
    let addon_cap = addon.total.filter(|c| c.is_finite() && *c > 0.0);
    if addon.used.is_some() || addon_rem.is_some() {
        match (addon_cap, addon.used, addon_rem) {
            (Some(cap), used, rem) => {
                if let Some(it) = pct_item("加量包已用", used, cap, rem, &addon_unit) {
                    items.push(it);
                }
            }
            (None, used, Some(rem)) => items.push(BalanceItem {
                label: "加量包剩余".into(),
                value: format!("{} {}", fmt_num(rem), addon_unit),
                sub: used
                    .filter(|v| v.is_finite())
                    .map(|v| format!("已用 {} {}", fmt_num(v), addon_unit)),
                /* 加量包的 total 拿不到 → 没有分母 */
                used_percent: None,
                reset_at: None,
            }),
            _ => {}
        }
    }

    /* 3) 个人额度 */
    let covered = org_rem.unwrap_or(0.0).max(0.0) + addon_rem.unwrap_or(0.0).max(0.0) > 0.0;
    let user_cap = user.total.filter(|c| c.is_finite() && *c > 0.0);
    if user.used.is_some() || user_cap.is_some() {
        let pct = if covered {
            None
        } else {
            user_cap.and_then(|cap| pct_item("个人额度已用", user.used, cap, user_rem, &user_unit))
        };
        match pct {
            Some(it) => items.push(it),
            None => {
                if let Some(used) = user.used.filter(|v| v.is_finite()) {
                    /*
                     * 被别的池兜底 → 降级成绝对值展示（见 build_balance 的文档），
                     * 但**把已用百分比一起带上**（`used_percent`）。
                     *
                     * 为什么不能只靠 value 里的百分比来染色：个人额度是**每月固定的**
                     * （本账号 total = 3000），用完时它只剩「3000 credits」这个数字，
                     * 前端按「非百分比 = 数量」染成中性蓝，**「用完」这件事在界面上
                     * 没有任何信号** —— 而这正是用户要的红色告警。
                     *
                     * ⚠️ 带上它**不会**让侧栏角标开始误报：告警轴（`worstHealth`）
                     * 只看 value 本身是百分比的项，`used_percent` 不参与。
                     * 颜色问「这个池自己满不满」，告警问「还有没有得用」—— 两个问题。
                     */
                    let used_pct = user_cap
                        .map(|cap| (used / cap * 100.0).clamp(0.0, 100.0))
                        .filter(|v| v.is_finite());
                    items.push(BalanceItem {
                        label: "个人额度已用".into(),
                        value: format!("{} {}", fmt_num(used), user_unit),
                        sub: user_cap
                            .map(|c| format!("共 {} {}", fmt_num(c), user_unit))
                            .or_else(|| user_rem.map(|r| format!("剩余 {} {}", fmt_num(r), user_unit))),
                        used_percent: used_pct,
                        reset_at: None,
                    });
                }
            }
        }
    }

    /*
     * 4) 今日已用。
     *
     * 放在「个人额度」之后、合计之前：它是对上面那条当月累计的**细化**，
     * 紧跟被细化的对象才读得懂（「资源包已用 4135」→「今日已用 93」）。
     *
     * sub 里写口径而不是留空：这个数是**本人**当日从共享池的取用，
     * 与「组织池剩余」（全组织）不是一个层级 —— 沿用上面两条的规矩，
     * 凡是口径有歧义的，就把口径写进 sub，别让人自己猜。
     */
    if let Some((v, unit)) = today {
        items.push(BalanceItem {
            label: LABEL_TODAY.into(),
            value: format!("{} {}", fmt_num(v), unit),
            sub: Some("本人当日".into()),
            /* 单日增量没有上限，算不出「用了百分之几」 */
            used_percent: None,
            reset_at: None,
        });
    }

    /* 5) 合计 */
    let pools = [user_rem, addon_rem, org_rem]
        .into_iter()
        .flatten()
        .filter(|v| v.is_finite() && *v > 0.0)
        .count();
    let total_rem: f64 = [user_rem, addon_rem, org_rem]
        .into_iter()
        .flatten()
        .filter(|v| v.is_finite())
        .map(|v| v.max(0.0))
        .sum();
    /*
     * 「额度耗尽」只有在**真的有额度池**时才成立。
     * 字段全缺时 total_rem 同样是 0，但那只是「没数据」而不是「用完了」——
     * 不区分的话，一个空响应会显示成「0 credits · 额度已用尽」，比不显示更糟。
     */
    let has_pool = user_rem.is_some() || addon_rem.is_some() || org_rem.is_some();
    let exhausted =
        u.is_quota_exceeded.unwrap_or(false) || (has_pool && total_rem <= 0.0);
    if exhausted || pools >= 2 {
        items.push(BalanceItem {
            label: "可用总额".into(),
            value: format!("{} {}", fmt_num(total_rem), user_unit),
            sub: Some(if exhausted {
                "额度已用尽".into()
            } else {
                "个人额度 + 加量包 + 资源包".into()
            }),
            /* 跨池合计，没有单一分母 */
            used_percent: None,
            reset_at: None,
        });
    }

    /* 6) 额度到期日：放最后。它不是「余额」，但 credits 制下「什么时候清零」同样关键 */
    if let Some(d) = u.expires_at.and_then(expiry_date) {
        items.push(BalanceItem {
            label: "额度到期".into(),
            value: d,
            sub: None,
            /* 日期不是量 */
            used_percent: None,
            reset_at: None,
        });
    }

    AgentBalance {
        provider: "qoder".into(),
        name,
        kind: BalanceKind::UsagePercent,
        items,
        raw: Some(console_url(u.upgrade_url.as_deref())),
        refreshed_at: now,
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

/** 今天的本地日期（YYYY-MM-DD）。今日基线的「天」按本地时区算 —— 与到期日同一口径 */
fn today_str() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

/*
 * 算今日增量并把新基线写回 sled。
 *
 * `app` 为 None 时（单测里构造不出 AppHandle）**直接不记也不算** ——
 * 今日用量是锦上添花，它算不出来不该影响本次刷新出数，
 * 更不该让整条 Qoder 挂掉。sled 打不开同理。
 */
fn today_delta(app: Option<&AppHandle>, u: &CliUsage) -> Option<(f64, String)> {
    let app = app?;
    let (metric, used, unit) = tracked_used(u)?;
    let today = today_str();
    let prev = storage::load_day_mark(app, "qoder", metric);
    let (delta, next) = advance_day(prev.as_ref(), &today, used);
    storage::save_day_mark(app, "qoder", metric, &next);
    delta.map(|d| (d, unit))
}

/* ============================ 执行 ============================ */

/*
 * 调 CLI 拉一次用量。
 *
 * 阻塞部分丢 spawn_blocking：CLI 冷启动要几秒，绝不能占住异步 Runtime 的线程
 * （模块约定：任何可能阻塞的逻辑都不跑在 UI 线程上）。
 *
 * 工作目录刻意用临时目录：CLI 会按 cwd 去找项目上下文，用用户的项目目录会让
 * 每次刷新都去扫一遍代码库（而且每个项目结果都不同）。
 */
pub async fn fetch_via_cli(app: Option<&AppHandle>) -> ApiResponse<AgentBalance> {
    let Some(cli) = find_cli() else {
        return ApiResponse::err(
            "未找到 qoderclicn：请安装 Qoder CLI 并在终端登录一次\
             （也可改用粘贴个人版 PAT 作为兜底）",
        );
    };

    let program = cli.to_string_lossy().to_string();
    let input = build_requests();
    let cwd = std::env::temp_dir();

    let joined = tokio::task::spawn_blocking(move || {
        let args: Vec<&str> = CLI_ARGS.to_vec();
        run_timeout_stdin_in(&program, &args, &input, CLI_TIMEOUT, Some(&cwd))
    })
    .await;

    let out = match joined {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return ApiResponse::err(format!("调用 Qoder CLI 失败：{e}")),
        Err(e) => return ApiResponse::err(format!("调用 Qoder CLI 的任务异常：{e}")),
    };

    match parse_usage_response(&out.stdout) {
        Ok(u) => {
            /* 今日增量要在**保存基线之后**算：先推进、再出数，顺序不能反 */
            let today = today_delta(app, &u);
            ApiResponse::ok(build_balance(&u, now_secs(), today))
        }
        Err(e) => {
            /* 失败时带上 stderr 的尾巴：CLI 把诊断信息都写在那里 */
            let tail = tail_of(&out.stderr, STDERR_TAIL);
            let mut msg = e;
            if !tail.is_empty() {
                msg.push_str(&format!("（CLI 输出：{tail}）"));
            }
            if out.code.unwrap_or(0) != 0 {
                msg.push_str(&format!("（退出码 {:?}）", out.code));
            }
            ApiResponse::err(msg)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /* 本机实测抓下来的真实响应（2026-09-22，团队账号） */
    const REAL_USAGE: &str = r#"{
        "userId": "019fac7f-827a-707f-add0-f6713612dbdb",
        "userType": "teams",
        "totalUsagePercentage": 100,
        "isHighestTier": false,
        "expiresAt": 1790697600000,
        "upgradeUrl": "https://qoder.com.cn/pricing?client=qoder",
        "userQuota": {"total": 3000, "used": 3000, "remaining": 0, "percentage": 100, "unit": "credits"},
        "isQuotaExceeded": false,
        "isPlanQuotaProrated": false,
        "orgResourcePackage": {"used": 4042, "cap": -1, "remaining": 26076, "percentage": 0, "available": true, "unit": "credits"}
    }"#;

    fn usage_of(json: &str) -> CliUsage {
        serde_json::from_str(json).expect("fixture 必须能解析")
    }

    /* ---------- 报文 ---------- */

    #[test]
    fn requests_cover_init_usage_and_end() {
        let s = build_requests();
        assert!(s.contains(r#""subtype":"initialize""#));
        assert!(s.contains(r#""subtype":"get_usage_info""#));
        assert!(s.contains(r#""subtype":"end_session""#));
        /* 三条请求三行，末尾必须有换行 —— 否则最后一条会被 CLI 当成没写完 */
        assert_eq!(s.lines().count(), 3);
        assert!(s.ends_with('\n'));
        /* 每行都得是合法 JSON（拼接最容易多一个括号） */
        for line in s.lines() {
            serde_json::from_str::<serde_json::Value>(line).expect("每行都必须是合法 JSON");
        }
    }

    #[test]
    fn parse_picks_r2_not_the_huge_init_response() {
        let stdout = concat!(
            r#"{"type":"system","subtype":"init","tools":["Bash"]}"#,
            "\n",
            r#"{"type":"control_response","response":{"subtype":"success","request_id":"r1","response":{"commands":[{"name":"about"}]}}}"#,
            "\n",
            r#"{"type":"control_response","response":{"subtype":"success","request_id":"r2","response":{"usage":{"userType":"teams","userQuota":{"used":1,"total":2}}}}}"#,
            "\n",
            r#"{"type":"control_response","response":{"subtype":"success","request_id":"r3","response":null}}"#,
        );
        let u = parse_usage_response(stdout).expect("应当取到 r2");
        assert_eq!(u.user_type.as_deref(), Some("teams"));
        assert_eq!(u.user_quota.unwrap().total, Some(2.0));
    }

    #[test]
    fn parse_ignores_non_json_noise_lines() {
        let stdout = concat!(
            "some plain log line\n",
            "[warn] not json at all\n",
            r#"{"type":"control_response","response":{"subtype":"success","request_id":"r2","response":{"usage":{"userType":"personal"}}}}"#,
        );
        assert_eq!(
            parse_usage_response(stdout).unwrap().user_type.as_deref(),
            Some("personal")
        );
    }

    #[test]
    fn parse_reports_cli_error_subtype() {
        let stdout = r#"{"type":"control_response","response":{"subtype":"error","request_id":"r2","error":"get_usage_info failed"}}"#;
        let e = parse_usage_response(stdout).unwrap_err();
        assert!(e.contains("拒绝查询用量"), "{e}");
        assert!(e.contains("get_usage_info failed"), "{e}");
    }

    /* 未登录：CLI 不发 control_response，只发一条 is_error 的 result */
    #[test]
    fn parse_explains_not_logged_in() {
        let stdout = concat!(
            r#"{"type":"system","subtype":"init","apiKeySource":"none"}"#,
            "\n",
            r#"{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login"}"#,
        );
        let e = parse_usage_response(stdout).unwrap_err();
        assert!(e.contains("Not logged in"), "{e}");
        /* 必须给出「怎么办」，否则用户只知道失败了 */
        assert!(e.contains("qoderclicn"), "{e}");
    }

    /* 成功但 usage 为 null：不能报成「协议不兼容」，那是两回事 */
    #[test]
    fn parse_distinguishes_empty_usage_from_broken_protocol() {
        let stdout =
            r#"{"type":"control_response","response":{"subtype":"success","request_id":"r2","response":{"usage":null}}}"#;
        let e = parse_usage_response(stdout).unwrap_err();
        assert!(e.contains("用量字段是空的"), "{e}");

        let e2 = parse_usage_response("{}").unwrap_err();
        assert!(e2.contains("控制协议不再兼容"), "{e2}");
    }

    /* ---------- 二进制发现 ---------- */

    #[test]
    fn picks_highest_native_version() {
        let names = vec![
            "qoderclicn-1.1.7".to_string(),
            "qoderclicn-1.1.8".to_string(),
            "qoderclicn-1.1.10".to_string(),
            "version.txt".to_string(),
            "qoderclicn".to_string(),
            "qoderclicn-latest".to_string(),
        ];
        assert_eq!(pick_latest_from_names(names).as_deref(), Some("qoderclicn-1.1.10"));
    }

    #[test]
    fn native_pick_tolerates_junk_and_empty() {
        assert_eq!(pick_latest_from_names(Vec::<String>::new()), None);
        assert_eq!(
            pick_latest_from_names(vec!["qoderclicn-1.2", "qoderclicn-1.2.3.4", ".DS_Store"]),
            None
        );
    }

    #[test]
    fn candidates_put_native_binary_before_wrappers() {
        let list = cli_candidates();
        let native = list
            .iter()
            .position(|p| p.to_string_lossy().contains(".qoder-cn/bin/qoderclicn/qoderclicn-"));
        let brew = list
            .iter()
            .position(|p| p.to_string_lossy() == "/opt/homebrew/bin/qoderclicn");
        if let (Some(n), Some(b)) = (native, brew) {
            assert!(n < b, "原生二进制必须排在包装脚本之前：{list:?}");
        }
        /* 候选不能有重复项 */
        let mut sorted = list.clone();
        sorted.dedup();
        assert_eq!(sorted.len(), list.len(), "候选路径出现重复：{list:?}");
    }

    /* ---------- 映射 ---------- */

    /* 团队账号实测数据：个人额度用尽 + 组织资源包不限量 */
    #[test]
    fn real_teams_account_maps_to_absolute_not_fake_zero_percent() {
        let b = build_balance(&usage_of(REAL_USAGE), 1_700_000_000, None);

        /*
         * 组织资源包 cap = -1 是不限量，服务端 percentage = 0 是「没有百分比」而不是「没用量」。
         * ⚠️ 这里出的是**两条**，不是一条 —— `remaining`（组织池剩余 26076）与
         * `used`（本人当月取用 4042）**口径不同**，合在一行会被读成同一个池的两侧。
         */
        let org = b.items.iter().find(|i| i.label == "组织池剩余").expect("要有组织池剩余");
        assert_eq!(org.value, "26076 credits");
        assert_eq!(org.sub.as_deref(), Some("全组织共享"), "必须标明是组织级口径");

        let mine = b.items.iter().find(|i| i.label == "资源包已用").expect("要有本人已用量");
        assert_eq!(mine.value, "4042 credits");
        assert_eq!(mine.sub.as_deref(), Some("本人当月"), "必须标明是本人级口径");

        /* 旧口径的合并标签必须彻底消失，不能被顺手留着 */
        assert!(
            !b.items.iter().any(|i| i.label == "资源包剩余"),
            "「资源包剩余」把组织级 remaining 说成本人剩余，已废弃：{:?}",
            b.items
        );

        /* 个人额度用尽但有兜底 → 出绝对值，不出 100% */
        let user = b.items.iter().find(|i| i.label == "个人额度已用").unwrap();
        assert_eq!(user.value, "3000 credits");
        assert_eq!(user.sub.as_deref(), Some("共 3000 credits"));
        assert!(
            !b.items.iter().any(|i| i.value.ends_with('%')),
            "该账号不该有任何百分比条目（否则角标会误报 0%）：{:?}",
            b.items
        );

        /* 只有一个池有余额 → 不出「合计」（出了就和上一条数字一样） */
        assert!(!b.items.iter().any(|i| i.label == "可用总额"), "{:?}", b.items);

        /* 到期日：1790697600000 = 本周期结束（2026-09-30 00:00 +08:00） */
        let exp = b.items.iter().find(|i| i.label == "额度到期").expect("要有到期日");
        assert!(exp.value.starts_with("2026-"), "{}", exp.value);
        assert_eq!(exp.value.len(), 10, "{}", exp.value);

        assert_eq!(b.name, "Qoder CN · teams");
        assert_eq!(b.raw.as_deref(), Some("https://qoder.com.cn/account/usage"));
        assert_eq!(b.refreshed_at, 1_700_000_000);
        assert!(b.error.is_none());
    }

    /* 到期日按本地时区取日期；超出可表示范围时返回 None，不编造 */
    #[test]
    fn expiry_date_is_bounded_and_well_formed() {
        let s = expiry_date(1_790_697_600_000).expect("正常时间戳要能格式化");
        assert_eq!(s.len(), 10);
        assert_eq!(s.chars().nth(4), Some('-'));
        assert_eq!(s.chars().nth(7), Some('-'));
        /*
         * 刻意不写死日期：这个函数用的是**本地时区**，写死会让断言跟着跑测机器的时区变。
         * 该时间戳是 UTC 09-29 16:00，在 UTC+8 是 09-30 —— 两者都要能通过。
         */
        assert!(s.starts_with("2026-09-") || s.starts_with("2026-10-"), "{s}");

        assert!(expiry_date(i64::MAX).is_none(), "越界不该编出一个日期");
        assert!(expiry_date(i64::MIN).is_none());
    }

    /* 服务端说资源包不可用时，不能拿 remaining 去显示「还剩很多」 */
    #[test]
    fn unavailable_org_package_is_skipped() {
        let b = build_balance(
            &usage_of(
                r#"{"orgResourcePackage":{"used":0,"remaining":99999,"available":false,"unit":"credits"}}"#,
            ),
            0,
            None,
        );
        assert!(b.items.is_empty(), "不可用的包不该出条目：{:?}", b.items);
    }

    /* 个人版：有上限 → 出百分比；没有别的池兜底 → 参与健康度 */
    #[test]
    fn personal_account_keeps_percentage() {
        let u = usage_of(
            r#"{"userType":"personal",
                "userQuota":{"used":250,"total":1000,"remaining":750,"percentage":25,"unit":"credits"}}"#,
        );
        let b = build_balance(&u, 0, None);
        let it = b.items.iter().find(|i| i.label == "个人额度已用").unwrap();
        assert_eq!(it.value, "25%");
        assert_eq!(it.sub.as_deref(), Some("剩余 750 / 1000 credits"));
        /* 只有个人池 → 无合计 */
        assert!(!b.items.iter().any(|i| i.label == "可用总额"));
    }

    /* 两个池都有余额 → 出合计；且合计 = 两者之和 */
    #[test]
    fn total_appears_only_when_two_pools_have_balance() {
        let u = usage_of(
            r#"{"userType":"personal",
                "userQuota":{"used":250,"total":1000,"remaining":750,"unit":"credits"},
                "addOnQuota":{"used":100,"total":500,"remaining":400,"unit":"credits"}}"#,
        );
        let b = build_balance(&u, 0, None);
        let total = b.items.iter().find(|i| i.label == "可用总额").expect("两个池要出合计");
        assert_eq!(total.value, "1150 credits");
        assert_eq!(total.sub.as_deref(), Some("个人额度 + 加量包 + 资源包"));
    }

    /* 额度耗尽：即使只有一个池也要出合计，并且要明说 */
    #[test]
    fn exhausted_account_still_reports_total() {
        let u = usage_of(
            r#"{"userType":"personal","isQuotaExceeded":true,
                "userQuota":{"used":1000,"total":1000,"remaining":0,"unit":"credits"}}"#,
        );
        let b = build_balance(&u, 0, None);
        let total = b.items.iter().find(|i| i.label == "可用总额").expect("耗尽时必须有合计");
        assert_eq!(total.value, "0 credits");
        assert_eq!(total.sub.as_deref(), Some("额度已用尽"));
    }

    /* 字段缺失只降级对应那条，不整体报错 */
    #[test]
    fn partial_payload_degrades_gracefully() {
        let b = build_balance(&usage_of("{}"), 0, None);
        assert!(
            b.items.is_empty(),
            "空响应不该被显示成「0 credits · 额度已用尽」：{:?}",
            b.items
        );
        assert!(b.error.is_none(), "字段缺失不该被当成错误");
        assert_eq!(b.name, "Qoder CN");
        assert_eq!(b.raw.as_deref(), Some("https://qoder.cn/account/usage"));

        /* 只有组织资源包、且只给了 remaining → 只出「组织池剩余」，不凭空造一条本人已用 */
        let b2 = build_balance(&usage_of(r#"{"orgResourcePackage":{"remaining":10}}"#), 0, None);
        assert_eq!(b2.items.len(), 1, "缺 used 时不该凭空造一条：{:?}", b2.items);
        assert_eq!(b2.items[0].label, "组织池剩余");
        assert_eq!(b2.items[0].value, "10 credits");
        assert_eq!(b2.items[0].sub.as_deref(), Some("全组织共享"));
    }

    /*
     * 单位跟着接口走，不写死 credits；且**两个口径各成一条**。
     * 这条同时守着「组织池剩余 ≠ 本人已用」的拆分：合成一条会被读成同一个池的两侧。
     */
    #[test]
    fn unit_follows_payload() {
        let b = build_balance(
            &usage_of(r#"{"orgResourcePackage":{"remaining":5,"used":1,"unit":"points"}}"#),
            0,
            None,
        );
        assert_eq!(b.items.len(), 2, "组织池剩余 + 本人已用：{:?}", b.items);

        let org = b.items.iter().find(|i| i.label == "组织池剩余").expect("组织池剩余");
        assert_eq!(org.value, "5 points");
        assert_eq!(org.sub.as_deref(), Some("全组织共享"));

        let mine = b.items.iter().find(|i| i.label == "资源包已用").expect("本人已用");
        assert_eq!(mine.value, "1 points");
        assert_eq!(mine.sub.as_deref(), Some("本人当月"));
    }

    /* 有上限的组织资源包 → 百分比形态，且用 used/cap 现算（比服务端字段可信） */
    #[test]
    fn capped_org_package_uses_percent() {
        let u = usage_of(
            r#"{"orgResourcePackage":{"used":3000,"cap":6000,"remaining":3000,"percentage":0,"unit":"credits"}}"#,
        );
        let b = build_balance(&u, 0, None);
        let it = b.items.iter().find(|i| i.label == "资源包已用").unwrap();
        assert_eq!(it.value, "50%", "服务端 percentage 是 0，但 used/cap 才是真相");
        assert_eq!(it.sub.as_deref(), Some("剩余 3000 / 6000 credits"));
    }

    #[test]
    fn console_url_reuses_server_host() {
        assert_eq!(
            console_url(Some("https://qoder.com.cn/pricing?client=qoder")),
            "https://qoder.com.cn/account/usage"
        );
        assert_eq!(console_url(None), "https://qoder.cn/account/usage");
        assert_eq!(console_url(Some("   ")), "https://qoder.cn/account/usage");
        assert_eq!(console_url(Some("not a url")), "https://qoder.cn/account/usage");
    }

    #[test]
    fn stderr_tail_is_capped_and_keeps_the_end() {
        assert_eq!(tail_of("   ", 10), "");
        assert_eq!(tail_of("short", 10), "short");
        let long: String = "abcdefghij".repeat(10);
        let t = tail_of(&long, 5);
        assert!(t.starts_with('…'));
        assert_eq!(t.chars().count(), 6);
        assert!(t.ends_with("ghij"));
    }

    /* ============================================================
       ====== 今日用量（本地差分）—— 逐条边界 ======
       ============================================================ */

    /* ① 首次观测：只有当前值、没有基线 → 不出数，绝不能报「今日 0」 */
    #[test]
    fn advance_day_first_sight_yields_no_delta() {
        let (d, m) = advance_day(None, "2026-09-23", 4135.0);
        assert_eq!(d, None, "首次观测没有基线，不能编一个 0 出来");
        assert_eq!(m.day, "2026-09-23");
        assert_eq!((m.base, m.last), (4135.0, 4135.0), "两端都锚在当前值");
    }

    /* ④ 同天：基线不动，增量 = 当前 − 基线（多次刷新要稳定累加） */
    #[test]
    fn advance_day_same_day_accumulates() {
        let p = DayMark { day: "2026-09-23".into(), base: 4000.0, last: 4000.0 };
        let (d1, m1) = advance_day(Some(&p), "2026-09-23", 4050.0);
        assert_eq!(d1, Some(50.0));
        assert_eq!(m1.base, 4000.0, "同天时基线必须不动 —— 动了就不是「今日累计」了");

        let (d2, _) = advance_day(Some(&m1), "2026-09-23", 4135.0);
        assert_eq!(d2, Some(135.0), "第二次刷新要覆盖全天的量，不是只算这一段的 85");
    }

    /*
     * ② 跨天 1 天：**用昨天最后观测值做今天的基线**。
     * 这是「今天下午才第一次打开工作台也能算出完整今日用量」的关键 ——
     * 若拿「今天首次观测值」当基线，凌晨到打开前的那一段就被漏掉了。
     */
    #[test]
    fn advance_day_crosses_day_using_yesterday_last_as_base() {
        let p = DayMark { day: "2026-09-22".into(), base: 3000.0, last: 4042.0 };
        let (d, m) = advance_day(Some(&p), "2026-09-23", 4135.0);
        assert_eq!(d, Some(93.0), "应为 4135 − 4042（昨天最后值）");
        assert_eq!(m.base, 4042.0, "新基线要接昨天最后观测值");
        assert_eq!(m.day, "2026-09-23");
    }

    /*
     * ③ 断档超过一天（隔了三天没开电脑）：今日无从得知 → 不出数，并从今天重新开始记。
     * 硬算出来的是「这三天一共用了多少」，标成「今日」就是撒谎。
     */
    #[test]
    fn advance_day_gap_over_one_day_resets_instead_of_lying() {
        let p = DayMark { day: "2026-09-20".into(), base: 3000.0, last: 3500.0 };
        let (d, m) = advance_day(Some(&p), "2026-09-23", 4135.0);
        assert_eq!(d, None, "断档三天不该报「今日 635」");
        assert_eq!((m.base, m.last), (4135.0, 4135.0), "从今天重新开始记");
        assert_eq!(m.day, "2026-09-23");
    }

    /*
     * 周期重置：used 是**当月累计**，每月归零，于是当前值会小于上次观测。
     * 差分出负数时判为「周期已翻页」，基线挪到当前值、今日归零 ——
     * 绝不能让「今日 −4135 credits」出现在界面上。
     */
    #[test]
    fn advance_day_month_rollover_never_goes_negative() {
        /* 同天内重置 */
        let p = DayMark { day: "2026-10-01".into(), base: 4135.0, last: 4135.0 };
        let (d, m) = advance_day(Some(&p), "2026-10-01", 12.0);
        assert_eq!(d, Some(0.0), "周期重置后今日从 0 重新计");
        assert_eq!((m.base, m.last), (12.0, 12.0));

        /* 跨天时恰好撞上重置 */
        let p2 = DayMark { day: "2026-09-30".into(), base: 4000.0, last: 4135.0 };
        let (d2, m2) = advance_day(Some(&p2), "2026-10-01", 8.0);
        assert_eq!(d2, Some(0.0), "跨天 + 重置：不能出负数");
        assert_eq!((m2.base, m2.last), (8.0, 8.0));
    }

    /* 脏数据（NaN / 负数）不推进基线 —— 否则基线被带歪，后面几天全错 */
    #[test]
    fn advance_day_ignores_nonsense_values() {
        let p = DayMark { day: "2026-09-23".into(), base: 4000.0, last: 4100.0 };
        let (d, m) = advance_day(Some(&p), "2026-09-23", f64::NAN);
        assert_eq!(d, None);
        assert_eq!((m.base, m.last), (4000.0, 4100.0), "基线必须原样保住");

        let (d2, m2) = advance_day(Some(&p), "2026-09-23", -5.0);
        assert_eq!(d2, None);
        assert_eq!((m2.base, m2.last), (4000.0, 4100.0));
    }

    /*
     * 真 sled 往返（临时目录，不经 AppHandle）。
     *
     * 单测构造不出 AppHandle，而「基线存进去再读出来」正是今日用量唯一的
     * 持久化路径 —— 这条不验，前面所有差分逻辑都可能建立在读不回来的基础上。
     * 同时顺带钉住一件容易想当然的事：daymark 的键不能和凭证键撞上
     * （两者前缀都是 `balances:`），撞了就等于把用量数字写进凭证槽位。
     */
    #[test]
    fn day_mark_roundtrips_through_real_sled() {
        use crate::core::storage::StorageService;

        let dir = std::env::temp_dir().join(format!("wb-daymark-{}", now_secs()));
        let st = StorageService::init(dir.clone()).expect("临时 sled 要能打开");

        /* 凭证键与基线键必须互不可见 */
        let cred = "balances:qoder";
        let mark = "balances:daymark:qoder:org_used";
        st.set_setting(cred, "{\"token_cipher\":\"AAA\"}")
            .expect("写凭证");
        let m = DayMark {
            day: "2026-09-23".into(),
            base: 4042.5,
            last: 4135.0,
        };
        st.set_setting(mark, &serde_json::to_string(&m).expect("序列化"))
            .expect("写基线");

        assert_eq!(
            st.get_setting(cred).ok().flatten().as_deref(),
            Some("{\"token_cipher\":\"AAA\"}"),
            "写基线不能污染凭证槽位"
        );
        let back: DayMark =
            serde_json::from_str(&st.get_setting(mark).ok().flatten().expect("读回基线"))
                .expect("反序列化");
        assert_eq!((back.day.as_str(), back.base, back.last), ("2026-09-23", 4042.5, 4135.0));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /*
     * 基线要落 sled，所以 JSON 往返必须无损 ——
     * 存进去再读出来要是变了（比如 base 被写成整数丢掉小数），
     * 跨天时就会算出一个差几 credits 的今日用量，这种偏差没人会去查。
     */
    #[test]
    fn day_mark_survives_json_roundtrip() {
        let m = DayMark {
            day: "2026-09-23".into(),
            base: 4042.5,
            last: 4135.0,
        };
        let json = serde_json::to_string(&m).expect("要能序列化");
        let back: DayMark = serde_json::from_str(&json).expect("要能反序列化");
        assert_eq!(back.day, m.day);
        assert_eq!(back.base, m.base, "小数不能丢");
        assert_eq!(back.last, m.last);
    }

    /* 日期格式坏了（手改过 sled / 老版本）→ 不出数，而不是 panic 或算错 */
    #[test]
    fn advance_day_survives_corrupt_day_string() {
        let p = DayMark { day: "not-a-date".into(), base: 1.0, last: 2.0 };
        let (d, m) = advance_day(Some(&p), "2026-09-23", 4135.0);
        assert_eq!(d, None, "日期算不出来时不该猜");
        assert_eq!(m.day, "2026-09-23");
    }

    /* 选跟踪对象：团队账号跟组织资源包（个人额度常已用尽），个人版退回个人额度 */
    #[test]
    fn tracked_used_prefers_org_package_then_falls_back_to_user() {
        let teams = usage_of(REAL_USAGE);
        let (metric, v, unit) = tracked_used(&teams).expect("团队账号有组织包");
        assert_eq!(metric, METRIC_ORG);
        assert_eq!(v, 4042.0);
        assert_eq!(unit, "credits");

        let personal = usage_of(
            r#"{"userQuota":{"used":250,"total":1000,"remaining":750,"unit":"credits"}}"#,
        );
        let (metric2, v2, _) = tracked_used(&personal).expect("个人版有个人额度");
        assert_eq!(metric2, METRIC_USER);
        assert_eq!(v2, 250.0);

        /* 组织包被服务端标记不可用时，不能拿它去算今日 */
        let off = usage_of(
            r#"{"orgResourcePackage":{"used":100,"remaining":5,"available":false},
                "userQuota":{"used":7,"total":10,"unit":"credits"}}"#,
        );
        assert_eq!(tracked_used(&off).map(|(m, _, _)| m), Some(METRIC_USER));
    }

    /* 今日条目：有增量才出；首次（None）整条不出，不制造假数据 */
    #[test]
    fn today_item_appears_only_when_there_is_a_baseline() {
        /* 首次观测 → 没有「今日已用」这一条 */
        let b = build_balance(&usage_of(REAL_USAGE), 0, None);
        assert!(
            !b.items.iter().any(|i| i.label == LABEL_TODAY),
            "没有基线时不该出今日条目：{:?}",
            b.items
        );

        /* 有增量 → 出，且 sub 写明口径（本人当日，与「组织池剩余」的全组织口径区分） */
        let b2 = build_balance(&usage_of(REAL_USAGE), 0, Some((93.0, "credits".into())));
        let it = b2
            .items
            .iter()
            .find(|i| i.label == LABEL_TODAY)
            .expect("有增量时要出今日条目");
        assert_eq!(it.value, "93 credits");
        assert_eq!(it.sub.as_deref(), Some("本人当日"));

        /*
         * 排序：今日条目要排在「资源包已用」之后、合计之前 ——
         * 它是对当月累计的细化，紧跟被细化的对象才读得懂。
         */
        let labels: Vec<&str> = b2.items.iter().map(|i| i.label.as_str()).collect();
        let at_org = labels.iter().position(|l| *l == "资源包已用");
        let at_today = labels.iter().position(|l| *l == LABEL_TODAY);
        assert!(
            at_org < at_today,
            "今日条目要跟在当月累计后面，实际顺序：{labels:?}"
        );
    }

    /*
     * 个人额度：每月固定上限，降级成绝对值展示时也要带上已用百分比，供染色用。
     *
     * 这是用户要的那条红线：团队账号里「个人额度用尽、组织池还有余额」是常态，
     * 那时个人额度只显示「3000 credits」，前端按数量染成中性蓝，看不出「用完」——
     * 带上 used_percent=100 后，前端按健康度色（100 绿 → 0 红）把它染成红。
     *
     * ⚠️ 只染色、不进告警轴：告警轴仍只看 value 本身是百分比的项。
     */
    #[test]
    fn 个人额度耗尽时染色信号拉满() {
        let b = build_balance(&usage_of(REAL_USAGE), 0, None);
        let it = b
            .items
            .iter()
            .find(|i| i.label == "个人额度已用")
            .expect("应有个人额度条目");
        assert_eq!(it.value, "3000 credits", "被兜底 → 降级为绝对值展示");
        assert_eq!(it.sub.as_deref(), Some("共 3000 credits"));
        assert_eq!(
            it.used_percent,
            Some(100.0),
            "每月固定上限 3000 / 已用 3000 → 已用 100%，染色应到红"
        );
    }

    /* 没被兜底 → 直接出百分比；used_percent 留 None（value 已能染色，不重复给第二个来源） */
    #[test]
    fn 个人额度无兜底时百分比已自带_used_percent为none() {
        let u = usage_of(
            r#"{"userQuota":{"total":3000,"used":1500,"remaining":1500,"unit":"credits"}}"#,
        );
        let b = build_balance(&u, 0, None);
        let it = b
            .items
            .iter()
            .find(|i| i.label == "个人额度已用")
            .expect("应有个人额度条目");
        assert!(it.value.contains('%'), "无兜底 → 出百分比");
        assert_eq!(
            it.used_percent, None,
            "value 已是百分比，不再重复给 used_percent"
        );
    }

    /*
     * 真机冒烟：CLI 在位时跑一遍完整链路（发现 → 起进程 → 控制协议 → 解析 → 映射）。
     *
     * 与 spring 的 smoke_real_scan 同一口径：**环境不具备条件时跳过而不是失败** ——
     * 没装 CLI / 没登录 / 断网都不是代码问题，本地一跑就红只会把真问题淹没。
     *
     * 但有一条**必须红**：CLI 在位、进程也跑起来了，却解析不出用量 ——
     * 那是 Qoder 改了控制协议（我们依赖的是反推出来的内部协议），
     * 正是这个测试存在的意义。所以「协议不再兼容」不进跳过分支。
     */
    #[test]
    fn smoke_real_cli_if_present() {
        let Some(cli) = find_cli() else {
            println!("跳过真机冒烟：本机没有 qoderclicn");
            return;
        };
        println!("使用 CLI：{}", cli.display());

        let rt = tokio::runtime::Runtime::new().expect("建 tokio 运行时失败");
        /* 传 None：单测构造不出 AppHandle，今日增量这一路不参与冒烟 */
        let resp = rt.block_on(fetch_via_cli(None));

        let Some(b) = resp.data else {
            let e = resp.error.unwrap_or_default();
            assert!(
                !e.contains("控制协议不再兼容"),
                "Qoder CLI 的控制协议已变更，需要重新从 bundle 里取证：{e}"
            );
            println!("跳过真机冒烟：{e}");
            return;
        };

        assert!(b.error.is_none(), "余额快照不该带 error：{:?}", b.error);
        assert!(!b.items.is_empty(), "CLI 在位却一条额度项都没有");
        println!("{} 的用量：", b.name);
        for it in &b.items {
            println!("  {} = {} ({:?})", it.label, it.value, it.sub);
        }
        println!("  控制台：{}", b.raw.as_deref().unwrap_or("—"));
    }
}
