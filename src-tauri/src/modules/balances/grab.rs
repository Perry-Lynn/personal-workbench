/*
 * 智能体余额模块 · 网页登录态「一键抓取」引擎
 * ------------------------------------------------------------------
 * 有些平台（Trae 就是）的余额只能靠**网页登录态**拿到：带
 * `Authorization: Cloud-IDE-JWT …` + 整段 Cookie 去调它的内部接口。
 * 让用户自己去 F12 里复制两行请求头很反人类，所以这里复刻
 * uTools 插件（ai-balance-utools/scripts/web-session-grab.js）那套做法：
 *
 *   ① 用**一份独立档案**启动本机 Chrome（默认档案从 Chrome 136 起不允许开远程调试端口），
 *      启动前把默认档案里的登录态（Cookies / Local State / Local Storage）复制进去；
 *   ② 打开平台的入口页，用 CDP 截下它自己发出的鉴权请求头 + Cookie；
 *   ③ 拿抓到的值**真调一次取数接口**，2xx 才算有效（否则继续等，最多 6 次）；
 *   ④ 抓不到就回退到**可见窗口**，让用户在弹出的 Chrome 里登录一次
 *      （登录态会留在独立档案里，下次就能无窗口静默抓取）。
 *
 * 引擎本身不认识任何具体平台，全部由 GrabSpec 驱动（见 trae.rs 的 grab_spec）。
 *
 * ⚠️ CDP 端点只监听 127.0.0.1，且这里显式 `no_proxy()` —— 否则系统里的 HTTP 代理
 * 会把对 127.0.0.1:9224 的请求也接管掉，表现为「端口连不上」。
 * @Author: fu
 */
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use anyhow::{anyhow, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::time::{timeout, Instant};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

/* CDP 会话的流类型：本机 ws://，不涉及 TLS */
type Ws = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

/* 无窗口 / 可见窗口两阶段各用一个端口，避免上一阶段残留进程占位 */
const PORT_HEADLESS: u16 = 9224;
const PORT_VISIBLE: u16 = 9225;
/* 无窗口阶段的预算：够启动 + 抓一次；不够就回退可见窗口（用户可能要登录） */
const HEADLESS_BUDGET_SECS: u64 = 45;
/* 同一个平台连续校验失败这么多次就丢弃已抓到的值，等新请求（防止抓到过期的登录态） */
const MAX_VALIDATE_ATTEMPTS: u32 = 6;

/* 自校验：用抓到的凭证真调一次取数接口，2xx 视为有效 */
pub struct ValidateSpec {
    pub url: String,
    pub method: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
}

/* 一个平台的抓取配置 */
pub struct GrabSpec {
    /* 打开这个页面来触发鉴权请求 */
    pub entry_url: &'static str,
    /* 要截取的请求头名（大小写不敏感） */
    pub auth_header: &'static str,
    /* 该请求头值需包含此子串才算命中（如 Cloud-IDE-JWT） */
    pub auth_match: &'static str,
    /* 读哪些域的 Cookie */
    pub cookie_urls: Vec<&'static str>,
    pub validate: Option<ValidateSpec>,
    pub timeout_secs: u64,
    /* 独立档案目录名（放在 profile_root 下） */
    pub profile_dir: &'static str,
}

pub struct GrabResult {
    pub auth: String,
    pub cookie: String,
}

/*
 * 抓取入口。两阶段：先无窗口（静默、不打扰用户），失败再回退可见窗口。
 * profile_root 由调用方给（工作台数据目录下的一个子目录），
 * 保证这份档案只属于工作台，不会污染用户的默认 Chrome 档案。
 */
pub async fn grab_web_session(spec: &GrabSpec, profile_root: &Path) -> Result<GrabResult> {
    let bin = chrome_bin()
        .ok_or_else(|| anyhow!("未找到 Google Chrome / Chromium，请先安装 Chrome（抓取需要借用它的登录态）"))?;
    let profile = profile_root.join(spec.profile_dir);
    std::fs::create_dir_all(&profile)?;

    /* no_proxy：见文件头说明 —— 系统代理会让本机 CDP 端口连不上 */
    let client = reqwest::Client::builder().no_proxy().build()?;

    let started = Instant::now();
    let deadline = started + Duration::from_secs(spec.timeout_secs);
    let headless_deadline = started
        + Duration::from_secs(HEADLESS_BUDGET_SECS.min(spec.timeout_secs));

    kill_profile_chrome(&profile);
    let seeded = seed_profile(&profile);

    if let Some(r) = try_stage(&client, &bin, &profile, spec, false, headless_deadline).await {
        return Ok(r);
    }
    if Instant::now() >= deadline {
        return Err(anyhow!("抓取超时：未检测到有效登录态，请稍后重试"));
    }

    if let Some(r) = try_stage(&client, &bin, &profile, spec, true, deadline).await {
        return Ok(r);
    }

    Err(anyhow!(if seeded {
        "抓取超时：没有拿到有效的登录态。请确认本机 Chrome 已登录该平台，或直接手动粘贴凭证"
    } else {
        "抓取超时：本机 Chrome 里没有可复用的登录态。请重新点击「一键抓取」，在弹出的窗口里登录一次（登录态会被记住，之后可静默抓取）"
    }))
}

/* 一个阶段：起 Chrome → 等调试端口 → 建标签页 → 抓取 → 关掉 Chrome */
async fn try_stage(
    client: &reqwest::Client,
    bin: &Path,
    profile: &Path,
    spec: &GrabSpec,
    visible: bool,
    deadline: Instant,
) -> Option<GrabResult> {
    let port = if visible { PORT_VISIBLE } else { PORT_HEADLESS };
    kill_profile_chrome(profile);
    let mut child = launch_chrome(bin, profile, port, visible).ok()?;

    let result = async {
        let ready_until = deadline.min(Instant::now() + Duration::from_secs(20));
        if !wait_devtools_ready(client, port, ready_until).await {
            return None;
        }
        let ws_url = new_tab(client, port, spec.entry_url).await?;
        grab_in_target(&ws_url, spec, deadline).await
    }
    .await;

    /* 无论成没成都要收干净：留着 Chrome 会占住档案锁，下次抓取起不来 */
    stop_chrome(&mut child).await;
    kill_profile_chrome(profile);
    result
}

/* ---------------- Chrome 启动 / 档案 ---------------- */

fn chrome_bin() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    #[cfg(target_os = "macos")]
    {
        candidates.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome".into());
        candidates.push("/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary".into());
        candidates.push("/Applications/Chromium.app/Contents/MacOS/Chromium".into());
    }
    #[cfg(target_os = "windows")]
    {
        for var in ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"] {
            if let Some(base) = std::env::var_os(var) {
                let mut p = PathBuf::from(base);
                p.push("Google");
                p.push("Chrome");
                p.push("Application");
                p.push("chrome.exe");
                candidates.push(p);
            }
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        candidates.push("/usr/bin/google-chrome".into());
        candidates.push("/usr/bin/chromium".into());
        candidates.push("/usr/bin/chromium-browser".into());
    }
    candidates.into_iter().find(|p| p.exists())
}

/* 用户默认 Chrome 档案目录（登录态的来源） */
fn default_profile_dir() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let home = dirs::home_dir()?;
        Some(home.join("Library/Application Support/Google/Chrome"))
    }
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var_os("LOCALAPPDATA")?;
        let mut p = PathBuf::from(base);
        p.push("Google");
        p.push("Chrome");
        p.push("User Data");
        Some(p)
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let home = dirs::home_dir()?;
        Some(home.join(".config/google-chrome"))
    }
}

/*
 * 把默认档案里的登录态种子复制进独立档案（每次覆盖，保持最新）。
 * 只搬「认人」的那几个文件：Cookie 库、Local State（Cookie 的加密密钥）、
 * Preferences、Local Storage（有些站把 token 放这儿）。
 */
fn seed_profile(dst: &Path) -> bool {
    let Some(src) = default_profile_dir() else {
        return false;
    };
    if !src.is_dir() {
        return false;
    }
    let mut ok = false;
    for rel in [
        "Local State",
        "Default/Preferences",
        "Default/Network/Cookies",
        "Default/Cookies",
    ] {
        ok |= copy_file(&src.join(rel), &dst.join(rel));
    }
    ok |= copy_dir(&src.join("Default/Local Storage"), &dst.join("Default/Local Storage"));
    ok
}

fn copy_file(src: &Path, dst: &Path) -> bool {
    if !src.is_file() {
        return false;
    }
    if let Some(parent) = dst.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return false;
        }
    }
    std::fs::copy(src, dst).is_ok()
}

fn copy_dir(src: &Path, dst: &Path) -> bool {
    if !src.is_dir() {
        return false;
    }
    if std::fs::create_dir_all(dst).is_err() {
        return false;
    }
    let Ok(entries) = std::fs::read_dir(src) else {
        return false;
    };
    let mut ok = false;
    for entry in entries.flatten() {
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            ok |= copy_dir(&from, &to);
        } else {
            ok |= std::fs::copy(&from, &to).is_ok();
        }
    }
    ok
}

/*
 * 关掉「跑在这个独立档案上」的 Chrome 进程并清掉单例锁。
 * 上次抓取若是被强杀（或用户自己关窗失败），档案里会留下 SingletonLock，
 * 下一次启动 Chrome 会直接拒绝启动 —— 表现为「点了抓取毫无反应」。
 */
fn kill_profile_chrome(profile: &Path) {
    #[cfg(unix)]
    {
        let needle = profile.to_string_lossy().to_string();
        let _ = Command::new("pkill")
            .arg("-f")
            .arg(&needle)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    for f in ["SingletonLock", "SingletonCookie", "SingletonSocket"] {
        let _ = std::fs::remove_file(profile.join(f));
    }
}

fn launch_chrome(bin: &Path, profile: &Path, port: u16, visible: bool) -> Result<Child> {
    let mut args: Vec<String> = Vec::new();
    if !visible {
        args.push("--headless=new".into());
    }
    args.extend([
        format!("--remote-debugging-port={port}"),
        format!("--user-data-dir={}", profile.display()),
        "--no-first-run".into(),
        "--no-default-browser-check".into(),
        "--disable-features=Translate".into(),
        "about:blank".into(),
    ]);
    Ok(Command::new(bin)
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?)
}

/* ---------------- CDP：HTTP 侧 ---------------- */

async fn wait_devtools_ready(client: &reqwest::Client, port: u16, until: Instant) -> bool {
    loop {
        if let Ok(r) = client
            .get(format!("http://127.0.0.1:{port}/json/version"))
            .send()
            .await
        {
            if r.status().is_success() {
                return true;
            }
        }
        if Instant::now() >= until {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

/* 新建标签页并返回它的 ws 地址（Chrome 111+ 要求 PUT，老版本只认 GET，两个都试） */
async fn new_tab(client: &reqwest::Client, port: u16, url: &str) -> Option<String> {
    let endpoint = format!("http://127.0.0.1:{port}/json/new?{}", percent_encode(url));
    for attempt in 0..2 {
        let req = if attempt == 0 {
            client.put(&endpoint)
        } else {
            client.get(&endpoint)
        };
        if let Ok(resp) = req.send().await {
            if let Ok(v) = resp.json::<Value>().await {
                if let Some(ws) = v.get("webSocketDebuggerUrl").and_then(|w| w.as_str()) {
                    return Some(ws.to_string());
                }
            }
        }
    }
    None
}

/*
 * 只保留 URL 里必须原样的字符，其余百分号转义。
 * 不引 URL 库：这里只为一个查询串服务，转义错一个 `&` / `#` 就会把 URL 截断成
 * 「多出来的参数」或「片段」—— 属于「不报错但抓错页面」的那类问题，所以显式做掉。
 * 只放行 RFC 3986 的 unreserved 加 `:` `/`（URL 本体必需），其余（含 `?` `&` `#`）一律转义。
 */
fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b':' | b'/' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/*
 * 优雅地停掉我们起的这个 Chrome。
 *
 * ⚠️ **不能直接 `Child::kill()`**（那是 SIGKILL）：Chrome 被强杀时来不及把
 * Cookie / Local Storage 写回档案，于是「用户刚在弹出的窗口里登录过」这件事
 * **不会留下来** —— 下次抓取又得让用户登一次，而界面上的说明明明写着「登录态会被记住」。
 * 所以先发 SIGTERM 并给它最多 2 秒收尾，还不走再 SIGKILL 兜底。
 */
async fn stop_chrome(child: &mut Child) {
    #[cfg(unix)]
    {
        let pid = child.id().to_string();
        let _ = Command::new("kill").arg("-TERM").arg(&pid).status();
        for _ in 0..20 {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

/* ---------------- CDP：WebSocket 侧 ---------------- */
async fn send_msg(ws: &mut Ws, payload: Value) -> Result<()> {
    ws.send(Message::text(payload.to_string()))
        .await
        .map_err(|e| anyhow!("与 Chrome 调试通道通信失败: {e}"))
}

/*
 * 在标签页里导航并抓取登录态。
 *
 * 状态机很小：等 `Network.requestWillBeSent*` 事件 → 命中鉴权头就发一次
 * `Network.getCookies` → 拿到 Cookie 后自校验；不过就丢掉继续等（最多 6 次）。
 * 不做「按 id 等待响应」的通用封装 —— 这里同时还要处理事件，单循环更直白。
 */
async fn grab_in_target(ws_url: &str, spec: &GrabSpec, deadline: Instant) -> Option<GrabResult> {
    let (mut ws, _) = connect_async(ws_url).await.ok()?;
    send_msg(&mut ws, json!({"id": 1, "method": "Network.enable"})).await.ok()?;
    send_msg(&mut ws, json!({"id": 2, "method": "Page.enable"})).await.ok()?;
    send_msg(
        &mut ws,
        json!({"id": 3, "method": "Page.navigate", "params": {"url": spec.entry_url}}),
    )
    .await
    .ok()?;

    let mut auth: Option<String> = None;
    let mut cookie_from_request: Option<String> = None;
    let mut next_id: u64 = 10;
    let mut cookie_request_id: u64 = 0;
    let mut awaiting_cookies = false;
    let mut attempts: u32 = 0;

    loop {
        let now = Instant::now();
        if now >= deadline {
            return None;
        }
        let frame = match timeout(deadline - now, ws.next()).await {
            Ok(Some(Ok(m))) => m,
            Ok(Some(Err(_))) | Ok(None) => return None,
            Err(_) => return None,
        };

        match frame {
            Message::Text(text) => {
                let Ok(v) = serde_json::from_str::<Value>(&text) else {
                    continue;
                };

                /* 响应：只关心我们发出去的 getCookies */
                if let Some(id) = v.get("id").and_then(|i| i.as_u64()) {
                    if awaiting_cookies && id == cookie_request_id {
                        awaiting_cookies = false;
                        let Some(cur_auth) = auth.clone() else { continue };
                        let cookie = cookies_of(&v)
                            .or_else(|| cookie_from_request.clone())
                            .unwrap_or_default();
                        if cookie.is_empty() {
                            continue;
                        }
                        attempts += 1;
                        match &spec.validate {
                            None => return Some(GrabResult { auth: cur_auth, cookie }),
                            Some(rule) => {
                                if validate(rule, spec.auth_header, &cur_auth, &cookie).await {
                                    return Some(GrabResult { auth: cur_auth, cookie });
                                }
                                /* 校验不过：丢掉这次抓到的值，等页面上新发出的请求 */
                                if attempts >= MAX_VALIDATE_ATTEMPTS {
                                    auth = None;
                                    cookie_from_request = None;
                                }
                            }
                        }
                    }
                    continue;
                }

                /* 事件：请求发出（含 ExtraInfo 里的完整请求头） */
                let method = v.get("method").and_then(|m| m.as_str()).unwrap_or("");
                if method != "Network.requestWillBeSent"
                    && method != "Network.requestWillBeSentExtraInfo"
                {
                    continue;
                }
                let Some(headers) = v
                    .get("params")
                    .and_then(|p| p.get("headers"))
                    .or_else(|| {
                        v.get("params")
                            .and_then(|p| p.get("request"))
                            .and_then(|r| r.get("headers"))
                    })
                else {
                    continue;
                };

                if auth.is_none() {
                    if let Some(a) = pick_header(headers, spec.auth_header) {
                        if spec.auth_match.is_empty() || a.contains(spec.auth_match) {
                            auth = Some(a);
                        }
                    }
                }
                if cookie_from_request.is_none() {
                    if let Some(c) = pick_header(headers, "cookie") {
                        if !c.is_empty() {
                            cookie_from_request = Some(c);
                        }
                    }
                }

                if auth.is_some() && !awaiting_cookies {
                    cookie_request_id = next_id;
                    next_id += 1;
                    awaiting_cookies = true;
                    if send_msg(
                        &mut ws,
                        json!({"id": cookie_request_id, "method": "Network.getCookies",
                               "params": {"urls": spec.cookie_urls}}),
                    )
                    .await
                    .is_err()
                    {
                        return None;
                    }
                }
            }
            Message::Ping(payload) => {
                let _ = ws.send(Message::Pong(payload)).await;
            }
            Message::Close(_) => return None,
            _ => {}
        }
    }
}

/* 大小写不敏感地取某个请求头的值 */
fn pick_header(headers: &Value, name: &str) -> Option<String> {
    let obj = headers.as_object()?;
    obj.iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .and_then(|(_, v)| v.as_str().map(|s| s.to_string()))
}

/* 从 Network.getCookies 的响应里拼出整段 Cookie */
fn cookies_of(resp: &Value) -> Option<String> {
    let list = resp.get("result")?.get("cookies")?.as_array()?;
    let parts: Vec<String> = list
        .iter()
        .filter_map(|c| {
            let name = c.get("name")?.as_str()?;
            let value = c.get("value")?.as_str()?;
            Some(format!("{name}={value}"))
        })
        .collect();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("; "))
    }
}

async fn validate(rule: &ValidateSpec, auth_header: &str, auth: &str, cookie: &str) -> bool {
    let Ok(client) = reqwest::Client::builder().no_proxy().build() else {
        return false;
    };
    let mut req = if rule.method.eq_ignore_ascii_case("POST") {
        client.post(&rule.url)
    } else {
        client.get(&rule.url)
    };
    for (k, v) in &rule.headers {
        req = req.header(k, v);
    }
    req = req.header(auth_header, auth).header("Cookie", cookie);
    if let Some(body) = &rule.body {
        req = req.body(body.clone());
    }
    match req.send().await {
        Ok(r) => r.status().is_success(),
        Err(_) => false,
    }
}
