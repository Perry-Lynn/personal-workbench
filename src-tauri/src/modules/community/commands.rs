/*
 * Trae 社区 · Tauri 命令
 * ------------------------------------------------------------------
 * 命令前缀统一 `community_`，返回 ApiResponse，失败只给中文可读消息。
 *
 * 登录路线：内嵌 WebviewWindow 打开 forum.trae.cn/session/sso
 * （302 到 www.trae.cn 统一登录，回跳 forum.trae.cn/session/sso_login），
 * 登录完关闭窗口后从 WKWebView cookie store 里读 `_t`，校验 /session/current.json
 * 并持久化。之后的请求都由 client::authed_client 统一注入 Cookie 头。
 *
 * cookie 值不允许出现在日志、错误文案里。
 * @Author: fu
 */
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use url::Url;

use crate::core::api::ApiResponse;

use super::client::{self, CommunityError, TTL_CATEGORIES, TTL_LATEST, TTL_TOPIC, TTL_USER};
use super::models::{
    CategoriesResponse, ChatChannelsResponse, ChatMessagesResponse, LatestResponse,
    NotificationsResponse, PostsResponse, TagsResponse, TopicResponse, UserResponse,
    UserSummaryResponse,
};
use super::session::{self, Session, SessionState};

const LOGIN_LABEL: &str = "community-login";
const FORUM_HOME: &str = "https://forum.trae.cn";
const SSO_URL: &str = "https://forum.trae.cn/session/sso";

/* 登录窗口的 UA。WKWebView 默认 UA 不带 Version/Safari 字样（形如
   `Mozilla/5.0 (Macintosh; …) AppleWebKit/605.1.15 (KHTML, like Gecko)`），
   和用户浏览器里能登录成功的 Chrome 不同；这里对齐 Chrome 的同款 UA 做对照。 */
const LOGIN_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.8103.38 Safari/537.36";

/* 打开登录窗口时窗口里残留的 `_t`。用来兜底：如果 cookie 没删干净，
   check 也不能把旧 cookie 当成「刚刚登录成功」。 */
static LOGIN_BASELINE: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/* =============================================
   ====== 登录链路诊断（只记结构，不记任何 cookie 值） ======
   ============================================= */

static LAST_DIAG: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/* 回跳参数 `sso` 是 base64 的 key=value 串。这里只解码出**字段名与值长度**，
   不写任何字段值 —— 用来判断回跳带的是用户资料还是最初的请求载荷。 */
fn sso_field_names(url: &Url) -> String {
    use base64::Engine;

    let Some((_, sso)) = url.query_pairs().find(|(k, _)| k == "sso") else {
        return "-".to_string();
    };
    let normalized = sso.replace(' ', "+");
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(normalized.as_bytes()) else {
        return "decode-fail".to_string();
    };
    let Ok(text) = String::from_utf8(bytes) else {
        return "utf8-fail".to_string();
    };
    let fields: Vec<String> = text
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .map(|(k, v)| format!("{}:{}", k, v.len()))
        .collect();
    if fields.is_empty() {
        "-".to_string()
    } else {
        fields.join(",")
    }
}

fn log_nav(app: &AppHandle, url: &Url) {
    use std::io::Write;

    let mut query = String::new();
    for (key, value) in url.query_pairs() {
        if !query.is_empty() {
            query.push(',');
        }
        query.push_str(&format!("{}:{}", key, value.len()));
    }
    let line = format!(
        "{} | nav | {}{} | q=[{}] | sso=[{}]",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
        url.host_str().unwrap_or("-"),
        url.path(),
        query,
        sso_field_names(url)
    );
    let file = crate::core::storage::app_data_dir(app).join("community-login-diag.log");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(file) {
        let _ = writeln!(f, "{}", line);
    }
}

fn login_diag(app: &AppHandle, window: &tauri::WebviewWindow, note: &str) {
    use std::io::Write;

    let Ok(url) = window.url() else { return };
    let mut query = String::new();
    for (key, value) in url.query_pairs() {
        if !query.is_empty() {
            query.push(',');
        }
        query.push_str(&format!("{}:{}", key, value.len()));
    }
    let cookie_names = |raw: &str| -> String {
        let Ok(target) = Url::parse(raw) else {
            return "-".to_string();
        };
        match window.cookies_for_url(target) {
            Ok(cookies) => {
                let names: Vec<String> = cookies.iter().map(|c| c.name().to_string()).collect();
                if names.is_empty() {
                    "-".to_string()
                } else {
                    names.join(",")
                }
            }
            Err(_) => "?".to_string(),
        }
    };

    let line = format!(
        "{} | {} | {}{} | q=[{}] | sso=[{}] | forum=[{}] | www=[{}]",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
        note,
        url.host_str().unwrap_or("-"),
        url.path(),
        query,
        sso_field_names(&url),
        cookie_names(FORUM_HOME),
        cookie_names("https://www.trae.cn/")
    );
    let key = line.split_once(" | ").map(|(_, rest)| rest.to_string()).unwrap_or_default();
    {
        let mut last = match LAST_DIAG.lock() {
            Ok(last) => last,
            Err(_) => return,
        };
        if last.as_deref() == Some(key.as_str()) {
            return;
        }
        *last = Some(key);
    }

    let file = crate::core::storage::app_data_dir(app).join("community-login-diag.log");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(file) {
        let _ = writeln!(f, "{}", line);
    }
}

fn wrap<T>(result: Result<T, CommunityError>) -> ApiResponse<T> {
    match result {
        Ok(data) => ApiResponse::ok(data),
        Err(err) => ApiResponse::err(err.message()),
    }
}

fn login_state(app: &AppHandle) -> SessionState {
    let mut state = session::load(app)
        .map(|s| s.state())
        .unwrap_or_default();
    state.window_open = app.get_webview_window(LOGIN_LABEL).is_some();
    state
}

/* 从登录窗口的 WKWebView cookie store 里读论坛 cookie。
   `_t` 是 Discourse 的长期登录 cookie（HttpOnly），Tauri 的 cookies_for_url 能读到。 */
fn forum_cookie(app: &AppHandle, label: &str) -> Option<String> {
    let window = app.get_webview_window(label)?;
    let url = Url::parse(FORUM_HOME).ok()?;
    let cookies = window.cookies_for_url(url).ok()?;

    let mut parts = Vec::new();
    for cookie in cookies {
        parts.push(format!("{}={}", cookie.name(), cookie.value()));
    }
    if parts.is_empty() || !parts.iter().any(|c| c.starts_with("_t=")) {
        return None;
    }
    Some(parts.join("; "))
}

/* 只取 `_t` 的值，用于和打开窗口时的基线比对（不参与日志/文案）。 */
fn forum_token(app: &AppHandle, label: &str) -> Option<String> {
    let window = app.get_webview_window(label)?;
    let url = Url::parse(FORUM_HOME).ok()?;
    window
        .cookies_for_url(url)
        .ok()?
        .into_iter()
        .find(|c| c.name() == "_t")
        .map(|c| c.value().to_string())
}

/* 清掉登录窗口里论坛域的登录 cookie。
   WKWebView 的 cookie store 是进程级共享的：上一次登录留下的 `_t` 会让
   /session/sso 立刻回跳成已登录，窗口开出来一秒就自动关闭 ——
   用户既看不到登录页，也没机会换账号。所以每次打开登录窗口都先清干净。 */
fn clear_forum_cookies(window: &tauri::WebviewWindow) -> usize {
    let Ok(url) = Url::parse(FORUM_HOME) else {
        return 0;
    };
    let Ok(cookies) = window.cookies_for_url(url) else {
        return 0;
    };
    let mut removed = 0;
    for cookie in cookies {
        if !matches!(cookie.name(), "_t" | "_forum_session" | "_secure_session") {
            continue;
        }
        if window.delete_cookie(cookie).is_ok() {
            removed += 1;
        }
    }
    removed
}

/* =============================================
   ====== 登录态 ======
   ============================================= */

/// 当前登录态（不含 cookie）。
#[tauri::command]
pub async fn community_session(app: AppHandle) -> ApiResponse<SessionState> {
    ApiResponse::ok(login_state(&app))
}

/// 打开内嵌登录窗口（论坛 SSO → www.trae.cn 统一登录）。
#[tauri::command]
pub async fn community_login_open(app: AppHandle) -> ApiResponse<SessionState> {
    if let Some(window) = app.get_webview_window(LOGIN_LABEL) {
        /* 复用旧窗口也要先清 cookie，否则窗口会直接回跳到已登录态 */
        let removed = clear_forum_cookies(&window);
        *LOGIN_BASELINE.lock().unwrap_or_else(|e| e.into_inner()) =
            forum_token(&app, LOGIN_LABEL);
        if let Ok(url) = Url::parse(SSO_URL) {
            let _ = window.navigate(url);
        }
        let _ = window.show();
        let _ = window.set_focus();
        login_diag(&app, &window, &format!("open-existing/clear:{removed}"));
        return ApiResponse::ok(login_state(&app));
    }

    let url = match Url::parse(SSO_URL) {
        Ok(url) => url,
        Err(e) => return ApiResponse::err(format!("登录地址无效：{e}")),
    };

    /* 先用论坛首页建窗口，等真正的 webview 就绪后再删 cookie、再跳 SSO：
       如果在构造时直接指向 SSO，旧 cookie 可能在我们来得及删之前就完成回跳。 */
    let home = match Url::parse(FORUM_HOME) {
        Ok(url) => url,
        Err(e) => return ApiResponse::err(format!("登录地址无效：{e}")),
    };

    let nav_handle = app.clone();
    match WebviewWindowBuilder::new(&app, LOGIN_LABEL, WebviewUrl::External(home))
        .title("登录 Trae 社区")
        .inner_size(600.0, 780.0)
        .center()
        .user_agent(LOGIN_UA)
        .on_navigation(move |url| {
            log_nav(&nav_handle, url);
            true
        })
        .build()
    {
        Ok(window) => {
            let removed = clear_forum_cookies(&window);
            *LOGIN_BASELINE.lock().unwrap_or_else(|e| e.into_inner()) =
                forum_token(&app, LOGIN_LABEL);
            let _ = window.navigate(url);
            login_diag(&app, &window, &format!("open-new/clear:{removed}"));
            ApiResponse::ok(login_state(&app))
        }
        Err(e) => ApiResponse::err(format!("无法打开登录窗口：{e}")),
    }
}

/// 校验登录窗口里的 cookie：成功则持久化并关闭窗口，失败保持未登录。
#[tauri::command]
pub async fn community_login_check(app: AppHandle) -> ApiResponse<SessionState> {
    if let Some(window) = app.get_webview_window(LOGIN_LABEL) {
        login_diag(&app, &window, "check");
    }
    let Some(cookie) = forum_cookie(&app, LOGIN_LABEL) else {
        return ApiResponse::ok(login_state(&app));
    };

    /* 打开窗口时残留的 `_t` 不算「刚登录成功」，否则窗口会被立刻关掉 */
    let token = forum_token(&app, LOGIN_LABEL);
    let baseline = LOGIN_BASELINE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    if token.is_some() && token == baseline {
        return ApiResponse::ok(login_state(&app));
    }
    /* 一旦出现新 cookie，基线就失效，避免后续轮询继续用它拦截 */
    *LOGIN_BASELINE.lock().unwrap_or_else(|e| e.into_inner()) = None;

    match client::fetch_current_user(&cookie).await {
        Ok(user) => {
            if user.username.trim().is_empty() {
                return ApiResponse::err("登录响应里没有用户名");
            }
            let _ = session::save(
                &app,
                Session {
                    cookie,
                    username: user.username.clone(),
                    name: user.name.clone(),
                    avatar_template: user.avatar_template.clone(),
                    user_id: user.id,
                    unread_notifications: user.unread_notifications.unwrap_or(0),
                    unread_private_messages: user.unread_private_messages.unwrap_or(0),
                    stored: String::new(),
                },
            );

            if let Some(window) = app.get_webview_window(LOGIN_LABEL) {
                let _ = window.close();
            }
            ApiResponse::ok(login_state(&app))
        }
        Err(err) => ApiResponse::err(err.message()),
    }
}

/// 退出登录：清掉本地凭证（钥匙串 + 0600 文件），界面回到未登录态。
#[tauri::command]
pub async fn community_logout(app: AppHandle) -> ApiResponse<SessionState> {
    session::clear(&app);
    if let Some(window) = app.get_webview_window(LOGIN_LABEL) {
        let _ = window.close();
    }
    ApiResponse::ok(login_state(&app))
}

/* =============================================
   ====== 匿名可读：真实取数 ======
   ============================================= */

/// 社区最新主题（含置顶与作者映射）。`page` 从 0 开始：0 是首页，1 是下一批。
/// 是否还有下一页由响应里的 `topic_list.more_topics_url` 决定，不要用 page 试错。
#[tauri::command]
pub async fn community_latest(
    force: Option<bool>,
    page: Option<u32>,
) -> ApiResponse<LatestResponse> {
    let path = client::latest_path(page.unwrap_or(0));
    wrap(client::fetch_json(&path, TTL_LATEST, force.unwrap_or(false)).await)
}

/// 某分类下的主题。必须走服务端 `category={id}` 过滤：首页「最新」只返回 30 条，
/// 在客户端从这 30 条里筛分类会得到空列表（而左侧计数是分类的全量 topic_count）。
#[tauri::command]
pub async fn community_category_topics(
    category_id: u32,
    page: Option<u32>,
    force: Option<bool>,
) -> ApiResponse<LatestResponse> {
    let path = client::category_path(category_id, page.unwrap_or(0));
    wrap(client::fetch_json(&path, TTL_LATEST, force.unwrap_or(false)).await)
}

/// 全站标签目录：热门标签 + 后台配置的分组（`extras.tag_groups`）。
#[tauri::command]
pub async fn community_tags(force: Option<bool>) -> ApiResponse<TagsResponse> {
    wrap(client::fetch_json(
        "/tags.json",
        TTL_CATEGORIES,
        force.unwrap_or(false),
    )
    .await)
}

/// 某个标签下的主题（服务端过滤 + 分页）。`page` 从 0 开始。
#[tauri::command]
pub async fn community_tag_topics(
    tag: String,
    page: Option<u32>,
    force: Option<bool>,
) -> ApiResponse<LatestResponse> {
    let name = tag.trim();
    if name.is_empty() {
        return ApiResponse::err("标签名不能为空");
    }
    let url = match client::tag_url(name, page.unwrap_or(0)) {
        Ok(url) => url,
        Err(e) => return ApiResponse::err(e.message()),
    };
    wrap(client::fetch_url(url, TTL_LATEST, force.unwrap_or(false)).await)
}

/// 官方首页「社区置顶」来自标签 `featured`（不是 topic_list 的 pinned 字段）。
#[tauri::command]
pub async fn community_featured(force: Option<bool>) -> ApiResponse<LatestResponse> {
    let url = match client::tag_url("featured", 0) {
        Ok(url) => url,
        Err(e) => return ApiResponse::err(e.message()),
    };
    wrap(client::fetch_url(url, TTL_LATEST, force.unwrap_or(false)).await)
}

/// 全部分类（Discourse 只返回一级分类，子分类在 `subcategory_ids` 里）。
#[tauri::command]
pub async fn community_categories(force: Option<bool>) -> ApiResponse<CategoriesResponse> {
    wrap(client::fetch_json(
        "/categories.json",
        TTL_CATEGORIES,
        force.unwrap_or(false),
    )
    .await)
}

/// 主题详情。首屏包含前 ~20 楼，剩余楼层 id 在 `post_stream.stream` 里。
#[tauri::command]
pub async fn community_topic(topic_id: i64, force: Option<bool>) -> ApiResponse<TopicResponse> {
    if topic_id <= 0 {
        return ApiResponse::err("主题 id 无效");
    }
    let path = format!("/t/{topic_id}.json");
    wrap(client::fetch_json(&path, TTL_TOPIC, force.unwrap_or(false)).await)
}

/// 主题剩余楼层。一次最多 40 个 id，避免被社区当成异常请求。
#[tauri::command]
pub async fn community_topic_posts(
    topic_id: i64,
    post_ids: Vec<i64>,
) -> ApiResponse<PostsResponse> {
    if topic_id <= 0 {
        return ApiResponse::err("主题 id 无效");
    }
    if post_ids.is_empty() {
        return ApiResponse::err("没有需要加载的楼层");
    }
    if post_ids.len() > 40 {
        return ApiResponse::err("一次最多加载 40 个楼层");
    }
    let url = match client::posts_url(topic_id, &post_ids) {
        Ok(url) => url,
        Err(e) => return ApiResponse::err(e.message()),
    };
    wrap(client::fetch_url(url, TTL_TOPIC, true).await)
}

/// 用户公开资料。
#[tauri::command]
pub async fn community_user(username: String) -> ApiResponse<UserResponse> {
    let name = username.trim();
    if name.is_empty() {
        return ApiResponse::err("用户名不能为空");
    }
    let url = match client::user_url(name, false) {
        Ok(url) => url,
        Err(e) => return ApiResponse::err(e.message()),
    };
    wrap(client::fetch_url(url, TTL_USER, false).await)
}

/// 用户公开资料摘要（发帖数、获赞、最近主题等）。
#[tauri::command]
pub async fn community_user_summary(username: String) -> ApiResponse<UserSummaryResponse> {
    let name = username.trim();
    if name.is_empty() {
        return ApiResponse::err("用户名不能为空");
    }
    let url = match client::user_url(name, true) {
        Ok(url) => url,
        Err(e) => return ApiResponse::err(e.message()),
    };
    wrap(client::fetch_url(url, TTL_USER, false).await)
}

/* =============================================
   ====== 需要登录：通知 / 私信 ======
   ============================================= */

/// 通知列表。成功后用「未读条数」回写登录态，顶栏红点用同一份数据。
#[tauri::command]
pub async fn community_notifications(
    app: AppHandle,
    force: Option<bool>,
) -> ApiResponse<NotificationsResponse> {
    let Some(current) = session::load(&app) else {
        return ApiResponse::err(CommunityError::LoginRequired.message());
    };

    let result =
        client::fetch_notifications_authed(&current.cookie, &current.username, force.unwrap_or(false))
            .await;

    if let Ok(data) = &result {
        let unread = data
            .notifications
            .iter()
            .filter(|item| !item.read.unwrap_or(false))
            .count() as i64;
        let summary = session::load(&app);
        if let Some(latest) = summary {
            session::update_unread(&app, unread, latest.unread_private_messages);
        }
    }

    wrap(result)
}

/// 通知全部标记已读（POST /notifications/mark-read，带 CSRF token）。
#[tauri::command]
pub async fn community_notifications_mark_read(app: AppHandle) -> ApiResponse<()> {
    let Some(current) = session::load(&app) else {
        return ApiResponse::err(CommunityError::LoginRequired.message());
    };

    match client::mark_notifications_read(&current.cookie, &current.username).await {
        Ok(()) => {
            session::update_unread(&app, 0, current.unread_private_messages);
            ApiResponse::ok(())
        }
        Err(err) => ApiResponse::err(err.message()),
    }
}

/// 私信/聊天频道。优先 Chat 插件，404 时退回 `/u/{username}/messages.json`。
#[tauri::command]
pub async fn community_chat_channels(
    app: AppHandle,
    force: Option<bool>,
) -> ApiResponse<ChatChannelsResponse> {
    let Some(current) = session::load(&app) else {
        return ApiResponse::err(CommunityError::LoginRequired.message());
    };

    wrap(
        client::fetch_chat_channels_authed(
            &current.cookie,
            &current.username,
            force.unwrap_or(false),
        )
        .await,
    )
}

/// 频道消息。Chat 插件可用时走 Chat 接口，否则按私信主题楼层回退。
#[tauri::command]
pub async fn community_chat_messages(
    app: AppHandle,
    channel_id: i64,
) -> ApiResponse<ChatMessagesResponse> {
    let Some(current) = session::load(&app) else {
        return ApiResponse::err(CommunityError::LoginRequired.message());
    };

    wrap(client::fetch_chat_messages_authed(&current.cookie, &current.username, channel_id).await)
}
