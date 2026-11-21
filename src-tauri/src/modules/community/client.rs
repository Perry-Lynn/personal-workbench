/*
 * Trae 社区 · HTTP 客户端与内存缓存
 * ------------------------------------------------------------------
 * 只依赖社区公开的 JSON 接口（forum.trae.cn 是标准 Discourse，匿名可读）。
 *
 * 做三件事：
 *   1. 统一超时：15 秒。社区在晚高峰偶尔会慢，但不该把整个前端拖住。
 *   2. 错误分类：网络 / 超时 / 404 / 需要登录 / HTTP 状态 / 解析。
 *      前端据此显示不同文案，而不是把 reqwest 的原文丢给用户。
 *   3. 内存缓存：按完整 URL 缓存响应体，TTL 由调用方指定。
 *      列表 60 秒、分类 6 小时、主题 3 分钟、用户 10 分钟 ——
 *      切来切去不该每次都打社区接口。
 *
 * 缓存**只放成功响应**：失败时旧缓存继续有效，前端可以「先展示缓存再报同步失败」。
 * @Author: fu
 */
use std::collections::HashMap;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::de::DeserializeOwned;
use url::Url;

use super::models::{
    ChatChannel, ChatChannelsResponse, ChatMessage, ChatMessageSummary, ChatMessageUser,
    ChatMessagesResponse, CsrfResponse, CurrentUser, NotificationsResponse,
    SessionCurrentResponse, TopicResponse, UserMessagesResponse,
};

const BASE: &str = "https://forum.trae.cn";

/* 各接口的缓存时长：热点列表短、分类几乎不变、用户资料中等 */
pub const TTL_LATEST: Duration = Duration::from_secs(60);
pub const TTL_CATEGORIES: Duration = Duration::from_secs(6 * 3600);
pub const TTL_TOPIC: Duration = Duration::from_secs(3 * 60);
pub const TTL_USER: Duration = Duration::from_secs(10 * 60);
/* 登录后的接口先留 TTL，接入时直接复用 */
#[allow(dead_code)]
pub const TTL_NOTIFICATIONS: Duration = Duration::from_secs(60);
#[allow(dead_code)]
pub const TTL_CHAT: Duration = Duration::from_secs(60);

/** 请求失败的原因。`message()` 是给用户看的中文，原始错误只附加在括号里。 */
#[derive(Debug)]
pub enum CommunityError {
    Timeout,
    Network(String),
    NotFound(String),
    LoginRequired,
    Upstream(u16, String),
    Parse(String),
}

impl CommunityError {
    pub fn message(&self) -> String {
        match self {
            Self::Timeout => "访问社区超时，请稍后重试".to_string(),
            Self::Network(detail) => format!("无法连接社区（{detail}）"),
            Self::NotFound(what) => format!("{what}不存在或已被删除（404）"),
            Self::LoginRequired => "该内容需要登录后才能查看".to_string(),
            Self::Upstream(429, _) => "社区请求过于频繁，请稍后再试（429）".to_string(),
            Self::Upstream(status, detail) => {
                if detail.trim().is_empty() {
                    format!("社区接口返回异常状态（{status}）")
                } else {
                    format!("社区接口返回异常状态（{status}）：{detail}")
                }
            }
            Self::Parse(detail) => format!("社区返回的数据格式异常（{detail}）"),
        }
    }
}

struct CacheEntry {
    at: Instant,
    body: String,
}

static CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .connect_timeout(Duration::from_secs(8))
        // 社区对默认 UA 有时会返回一段 HTML 验证页；带一个明确的应用标识更稳。
        .user_agent("Workbench-Community/1.0 (macOS; Tauri)")
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
});

static CACHE: Lazy<Mutex<HashMap<String, CacheEntry>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn cache_get(url: &str, ttl: Duration) -> Option<String> {
    let cache = CACHE.lock();
    let entry = cache.get(url)?;
    if entry.at.elapsed() < ttl {
        Some(entry.body.clone())
    } else {
        None
    }
}

fn cache_put(url: String, body: String) {
    let mut cache = CACHE.lock();
    /* 缓存条目只增不减会一直占内存（主题页 id 无限多），超过上限就整体清一次。
       列表/分类几秒后就会重新拉，清掉不影响体验。 */
    if cache.len() > 256 {
        cache.clear();
    }
    cache.insert(url, CacheEntry { at: Instant::now(), body });
}

fn classify_reqwest(err: reqwest::Error) -> CommunityError {
    if err.is_timeout() {
        CommunityError::Timeout
    } else if err.is_connect() {
        CommunityError::Network("连接 forum.trae.cn 失败".to_string())
    } else if err.is_decode() {
        CommunityError::Parse(err.to_string())
    } else {
        CommunityError::Network(err.to_string())
    }
}

fn classify_status(status: u16) -> CommunityError {
    match status {
        404 => CommunityError::NotFound("请求的内容".to_string()),
        /* 401/403 在 Discourse 语境里基本都是「匿名态无权访问」 */
        401 | 403 => CommunityError::LoginRequired,
        429 => CommunityError::Upstream(429, String::new()),
        _ => CommunityError::Upstream(status, String::new()),
    }
}

/// 取一个 JSON 接口。`path` 是不含域名的路径（如 `/latest.json`）。
pub async fn fetch_json<T: DeserializeOwned>(
    path: &str,
    ttl: Duration,
    force: bool,
) -> Result<T, CommunityError> {
    let url = Url::parse(&format!("{BASE}{path}"))
        .map_err(|e| CommunityError::Parse(format!("URL 构造失败：{e}")))?;
    fetch_url(url, ttl, force).await
}

/// 取一个完整 URL（`/t/{id}/posts.json?post_ids[]=…` 这类带查询串的走这里）。
pub async fn fetch_url<T: DeserializeOwned>(
    url: Url,
    ttl: Duration,
    force: bool,
) -> Result<T, CommunityError> {
    let key = url.as_str().to_string();

    if !force {
        if let Some(body) = cache_get(&key, ttl) {
            if let Ok(data) = serde_json::from_str::<T>(&body) {
                return Ok(data);
            }
            /* 缓存里的旧结构解析不了（比如升级后字段变了）：当没有缓存，重新请求。 */
        }
    }

    let resp = CLIENT
        .get(url.clone())
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(classify_reqwest)?;

    let status = resp.status();
    if !status.is_success() {
        return Err(classify_status(status.as_u16()));
    }

    let body = resp.text().await.map_err(classify_reqwest)?;
    let data = serde_json::from_str::<T>(&body).map_err(|e| {
        /* 响应体可能是 HTML（限流页 / Cloudflare 挑战页），截一小段帮助定位，
           但不要把整页塞进错误消息。 */
        let snippet = body.chars().take(80).collect::<String>().replace('\n', " ");
        CommunityError::Parse(format!("{e}；响应开头：{snippet}"))
    })?;

    cache_put(key, body);
    Ok(data)
}

/// 用户主页路径。用户名可能包含中文 / 空格，必须交给 Url 的 path 段做百分号编码。
pub fn user_url(username: &str, summary: bool) -> Result<Url, CommunityError> {
    let mut url = Url::parse(BASE)
        .map_err(|e| CommunityError::Parse(format!("URL 构造失败：{e}")))?;
    {
        let name = username.trim();
        let mut seg = url
            .path_segments_mut()
            .map_err(|_| CommunityError::Parse("URL 不支持路径段".to_string()))?;
        seg.push("u");
        if summary {
            seg.push(name).push("summary.json");
        } else {
            /* 真实路径是 `/u/{username}.json`，点号属于最后一段，不能单独 push */
            seg.push(&format!("{name}.json"));
        }
    }
    Ok(url)
}

/// 最新主题分页。Discourse 首页是第 1 页（不带参数），`page=1` 才是**下一批**。
pub fn latest_path(page: u32) -> String {
    if page == 0 {
        "/latest.json".to_string()
    } else {
        format!("/latest.json?no_definitions=true&page={page}")
    }
}

/// 分类主题页：`/latest.json?category={id}`。必须用数字 id —— 这个分类的
/// `slug` 是空串（`/c//38.json` 拿不到数据），按 id 过滤才是服务端真实结果。
pub fn category_path(category_id: u32, page: u32) -> String {
    if page == 0 {
        format!("/latest.json?category={category_id}")
    } else {
        format!("/latest.json?category={category_id}&no_definitions=true&page={page}")
    }
}

/// 标签主题页：`/tag/{标签名}.json`。必须用**标签名**而不是 slug
/// （`/tag/16-tag.json` 是另一个同名标签，不是 id 16 的别名）。
pub fn tag_url(tag: &str, page: u32) -> Result<Url, CommunityError> {
    let name = tag.trim();
    if name.is_empty() {
        return Err(CommunityError::Parse("标签名不能为空".to_string()));
    }
    let mut url = Url::parse(BASE)
        .map_err(|e| CommunityError::Parse(format!("URL 构造失败：{e}")))?;
    {
        let mut seg = url
            .path_segments_mut()
            .map_err(|_| CommunityError::Parse("URL 不支持路径段".to_string()))?;
        seg.push("tag");
        seg.push(&format!("{name}.json"));
    }
    if page > 0 {
        url.query_pairs_mut().append_pair("page", &page.to_string());
    }
    Ok(url)
}

/// 主题回复分页：`/t/{id}/posts.json?post_ids[]=…`。
pub fn posts_url(topic_id: i64, post_ids: &[i64]) -> Result<Url, CommunityError> {
    let mut url = Url::parse(&format!("{BASE}/t/{topic_id}/posts.json"))
        .map_err(|e| CommunityError::Parse(format!("URL 构造失败：{e}")))?;
    {
        let mut qp = url.query_pairs_mut();
        for id in post_ids {
            qp.append_pair("post_ids[]", &id.to_string());
        }
    }
    Ok(url)
}

/* =============================================
   ====== 登录态：Cookie 复用 ======
   =============================================
   登录窗口由 commands.rs 打开（forum.trae.cn/session/sso → www.trae.cn 统一登录），
   关闭后从 WKWebView 的 cookie store 读出 `_t`，交给这里做请求头注入。
   业务代码只调下面的函数，不关心是 Cookie 还是别的方式。
*/

fn cookie_headers(cookie: &str) -> Result<reqwest::header::HeaderMap, CommunityError> {
    use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, COOKIE};

    let cookie = cookie.trim();
    if cookie.is_empty() {
        return Err(CommunityError::LoginRequired);
    }
    let mut headers = HeaderMap::new();
    headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
    headers.insert(
        COOKIE,
        HeaderValue::from_str(cookie)
            .map_err(|_| CommunityError::Network("登录态格式无效".to_string()))?,
    );
    Ok(headers)
}

/// 带登录 cookie 的客户端。所有登录后接口都从这里发，避免各处手拼请求头。
pub fn authed_client(cookie: &str) -> Result<reqwest::Client, CommunityError> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .connect_timeout(Duration::from_secs(8))
        .user_agent("Workbench-Community/1.0 (macOS; Tauri)")
        .default_headers(cookie_headers(cookie)?)
        .build()
        .map_err(classify_reqwest)
}

/* 登录后接口的缓存按用户隔离：key 里带用户名，绝不跨账号复用 */
async fn authed_fetch<T: DeserializeOwned>(
    cookie: &str,
    cache_ns: &str,
    path: &str,
    ttl: Duration,
    force: bool,
) -> Result<T, CommunityError> {
    let url = Url::parse(&format!("{BASE}{path}"))
        .map_err(|e| CommunityError::Parse(format!("URL 构造失败：{e}")))?;
    authed_fetch_url(cookie, cache_ns, url, ttl, force).await
}

async fn authed_fetch_url<T: DeserializeOwned>(
    cookie: &str,
    cache_ns: &str,
    url: Url,
    ttl: Duration,
    force: bool,
) -> Result<T, CommunityError> {
    let key = format!("auth|{cache_ns}|{}", url.as_str());

    if !force {
        if let Some(body) = cache_get(&key, ttl) {
            if let Ok(data) = serde_json::from_str::<T>(&body) {
                return Ok(data);
            }
        }
    }

    let client = authed_client(cookie)?;
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(classify_reqwest)?;

    let status = resp.status();
    if !status.is_success() {
        return Err(classify_status(status.as_u16()));
    }

    let body = resp.text().await.map_err(classify_reqwest)?;
    let data = serde_json::from_str::<T>(&body).map_err(|e| {
        let snippet = body.chars().take(80).collect::<String>().replace('\n', " ");
        CommunityError::Parse(format!("{e}；响应开头：{snippet}"))
    })?;
    cache_put(key, body);
    Ok(data)
}

/// 校验登录态并取当前用户。`/session/current.json` 匿名返回 404，登录后返回 `current_user`。
pub async fn fetch_current_user(cookie: &str) -> Result<CurrentUser, CommunityError> {
    let url = Url::parse(&format!("{BASE}/session/current.json"))
        .map_err(|e| CommunityError::Parse(format!("URL 构造失败：{e}")))?;
    let client = authed_client(cookie)?;
    let resp = client.get(url).send().await.map_err(classify_reqwest)?;
    let status = resp.status();
    if status.as_u16() == 404 || status.as_u16() == 403 {
        return Err(CommunityError::LoginRequired);
    }
    if !status.is_success() {
        return Err(classify_status(status.as_u16()));
    }
    let body = resp.text().await.map_err(classify_reqwest)?;
    let parsed: SessionCurrentResponse = serde_json::from_str(&body).map_err(|e| {
        let snippet = body.chars().take(80).collect::<String>().replace('\n', " ");
        CommunityError::Parse(format!("{e}；响应开头：{snippet}"))
    })?;
    parsed.current_user.ok_or(CommunityError::LoginRequired)
}

/// 通知列表（登录后）。按 60 秒缓存，切页不重复打接口。
pub async fn fetch_notifications_authed(
    cookie: &str,
    username: &str,
    force: bool,
) -> Result<NotificationsResponse, CommunityError> {
    authed_fetch(
        cookie,
        username,
        "/notifications.json",
        TTL_NOTIFICATIONS,
        force,
    )
    .await
}

/// 全部标记已读。需要先取 CSRF token，再 POST。
pub async fn mark_notifications_read(cookie: &str, username: &str) -> Result<(), CommunityError> {
    let csrf: CsrfResponse = authed_fetch(cookie, username, "/session/csrf.json", Duration::ZERO, true)
        .await?;
    if csrf.csrf.trim().is_empty() {
        return Err(CommunityError::Parse("未取到 CSRF token".to_string()));
    }

    let client = authed_client(cookie)?;
    let resp = client
        .post(format!("{BASE}/notifications/mark-read"))
        .header("X-CSRF-Token", csrf.csrf)
        .header(reqwest::header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body("")
        .send()
        .await
        .map_err(classify_reqwest)?;

    let status = resp.status();
    if status.is_success() {
        Ok(())
    } else {
        Err(classify_status(status.as_u16()))
    }
}

/// 私信/聊天频道。先试 Chat 插件；插件不可用（404）时退回 `/u/{username}/messages.json`。
pub async fn fetch_chat_channels_authed(
    cookie: &str,
    username: &str,
    force: bool,
) -> Result<ChatChannelsResponse, CommunityError> {
    match authed_fetch::<ChatChannelsResponse>(
        cookie,
        username,
        "/chat/api/channels",
        TTL_CHAT,
        force,
    )
    .await
    {
        Ok(mut data) => {
            data.source = Some("chat".to_string());
            Ok(data)
        }
        Err(CommunityError::NotFound(_)) => {
            let url = user_url(username, false)?
                .join(&format!("messages.json"))
                .map_err(|e| CommunityError::Parse(format!("URL 构造失败：{e}")))?;
            let pm: UserMessagesResponse =
                authed_fetch_url(cookie, username, url, TTL_CHAT, force).await?;
            let mut direct = Vec::new();
            for topic in pm.topic_list.topics {
                direct.push(ChatChannel {
                    id: topic.id,
                    title: Some(
                        topic
                            .fancy_title
                            .clone()
                            .filter(|s| !s.trim().is_empty())
                            .unwrap_or_else(|| topic.title.clone()),
                    ),
                    slug: topic.slug.clone(),
                    chatable_id: None,
                    chatable_type: Some("Topic".to_string()),
                    unread_count: None,
                    last_message: Some(ChatMessageSummary {
                        id: 0,
                        message: topic.excerpt.clone(),
                        created_at: topic.bumped_at.clone().or(topic.last_posted_at.clone()),
                        username: topic.last_poster_username.clone(),
                    }),
                    membership: None,
                });
            }
            Ok(ChatChannelsResponse {
                public_channels: Vec::new(),
                direct_message_channels: direct,
                tracking: None,
                source: Some("pm".to_string()),
            })
        }
        Err(e) => Err(e),
    }
}

/// 频道消息。Chat 插件可用时走 `/chat/api/channels/{id}/messages.json`；
/// 404 说明该 id 是私信主题，退回 `/t/{id}.json` 把楼层映射成消息。
pub async fn fetch_chat_messages_authed(
    cookie: &str,
    username: &str,
    channel_id: i64,
) -> Result<ChatMessagesResponse, CommunityError> {
    if channel_id <= 0 {
        return Err(CommunityError::Parse("频道 id 无效".to_string()));
    }
    let path = format!("/chat/api/channels/{channel_id}/messages.json?page_size=30");
    match authed_fetch::<ChatMessagesResponse>(
        cookie,
        username,
        &path,
        Duration::from_secs(30),
        true,
    )
    .await
    {
        Ok(mut data) => {
            for message in &mut data.messages {
                if message.chat_channel_id.is_none() {
                    message.chat_channel_id = Some(channel_id);
                }
            }
            Ok(data)
        }
        Err(CommunityError::NotFound(_)) => {
            let topic: TopicResponse =
                authed_fetch(cookie, username, &format!("/t/{channel_id}.json"), TTL_TOPIC, true)
                    .await?;
            let messages = topic
                .post_stream
                .posts
                .into_iter()
                .map(|post| ChatMessage {
                    id: post.id,
                    message: None,
                    cooked: Some(post.cooked),
                    created_at: post.created_at,
                    chat_channel_id: Some(channel_id),
                    user: Some(ChatMessageUser {
                        username: Some(post.username),
                        name: post.name,
                        avatar_template: post.avatar_template,
                    }),
                    post_number: post.post_number,
                })
                .collect();
            Ok(ChatMessagesResponse {
                messages,
                meta: None,
            })
        }
        Err(e) => Err(e),
    }
}

/// 登录态占位类型已由 `authed_client` 取代，保留别名方便平滑迁移。
#[allow(dead_code)]
pub type AuthPlaceholder = ();


#[cfg(test)]
mod tests {
    use super::{category_path, latest_path, posts_url, tag_url, user_url};

    /* 中文用户名必须按路径段编码，且 `.json` 属于最后一段 ——
       拆成两段会变成 `/u/迟迟/.json`，真实接口直接 404。 */
    #[test]
    fn user_url_encodes_chinese_username() {
        let url = user_url("迟迟", false).expect("user url");
        assert_eq!(url.as_str(), "https://forum.trae.cn/u/%E8%BF%9F%E8%BF%9F.json");
    }

    #[test]
    fn user_summary_url_keeps_username_as_one_segment() {
        let url = user_url("迟迟", true).expect("summary url");
        assert_eq!(
            url.as_str(),
            "https://forum.trae.cn/u/%E8%BF%9F%E8%BF%9F/summary.json"
        );
    }

    /* 标签名是中文时必须按路径段编码；`featured` 这类英文名保持原样。 */
    #[test]
    fn tag_url_encodes_chinese_name_and_page() {
        let url = tag_url("活动回顾", 0).expect("tag url");
        assert_eq!(
            url.as_str(),
            "https://forum.trae.cn/tag/%E6%B4%BB%E5%8A%A8%E5%9B%9E%E9%A1%BE.json"
        );
        let url = tag_url("featured", 2).expect("tag url page");
        assert_eq!(
            url.as_str(),
            "https://forum.trae.cn/tag/featured.json?page=2"
        );
    }

    /* 首页不带 page；`page=1` 是下一批（Discourse 的 page 从 1 开始表示第二页）。 */
    #[test]
    fn latest_path_starts_at_zero() {
        assert_eq!(latest_path(0), "/latest.json");
        assert_eq!(latest_path(1), "/latest.json?no_definitions=true&page=1");
    }

    /* 分类必须按数字 id 请求；该分类 slug 为空，不能拿 slug 拼路径。 */
    #[test]
    fn category_path_uses_numeric_id_and_page() {
        assert_eq!(category_path(38, 0), "/latest.json?category=38");
        assert_eq!(
            category_path(38, 2),
            "/latest.json?category=38&no_definitions=true&page=2"
        );
    }

    /* 一次加载多个楼层：`post_ids[]` 要重复出现，不能拼成逗号分隔。 */
    #[test]
    fn posts_url_repeats_post_ids_query() {
        let url = posts_url(465141, &[1, 2]).expect("posts url");
        assert_eq!(
            url.as_str(),
            "https://forum.trae.cn/t/465141/posts.json?post_ids%5B%5D=1&post_ids%5B%5D=2"
        );
    }

    /*
     * 联网冒烟：默认 `cargo test` 不会跑（#[ignore]），
     * 需要手动确认「真实字段是否都能进结构体」时执行：
     *   cargo test --manifest-path src-tauri/Cargo.toml real_forum -- --ignored
     * 它不校验业务值，只保证五个接口的响应能被 serde 解析、不因缺字段 panic。
     */
    #[tokio::test]
    #[ignore = "联网校验真实接口结构，手动运行"]
    async fn real_forum_payloads_deserialize() {
        use super::{fetch_json, fetch_url, posts_url, user_url, TTL_CATEGORIES, TTL_LATEST, TTL_TOPIC, TTL_USER};
        use crate::modules::community::models::{
            CategoriesResponse, LatestResponse, PostsResponse, TopicResponse, UserResponse,
            UserSummaryResponse,
        };

        let latest: LatestResponse = fetch_json("/latest.json", TTL_LATEST, true)
            .await
            .expect("latest.json 应能解析");
        assert!(!latest.topic_list.topics.is_empty(), "latest 应至少有一个主题");

        let categories: CategoriesResponse = fetch_json("/categories.json", TTL_CATEGORIES, true)
            .await
            .expect("categories.json 应能解析");
        assert!(!categories.category_list.categories.is_empty(), "应至少有一个分类");

        let first = &latest.topic_list.topics[0];
        assert!(first.id > 0);
        let topic: TopicResponse = fetch_json(&format!("/t/{}.json", first.id), TTL_TOPIC, true)
            .await
            .expect("主题详情应能解析");
        assert!(!topic.post_stream.stream.is_empty(), "主题应有楼层顺序");

        let first_posts = &topic.post_stream.stream[..topic.post_stream.stream.len().min(2)];
        let posts: PostsResponse = fetch_url(
            posts_url(topic.id, first_posts).expect("posts url"),
            TTL_TOPIC,
            true,
        )
        .await
        .expect("楼层分页应能解析");
        assert!(!posts.post_stream.posts.is_empty(), "分页应返回楼层");

        let username = latest
            .users
            .iter()
            .find(|u| !u.username.is_empty())
            .map(|u| u.username.clone())
            .expect("latest 应带用户表");
        let user: UserResponse = fetch_url(
            user_url(&username, false).expect("user url"),
            TTL_USER,
            true,
        )
        .await
        .expect("用户资料应能解析");
        assert_eq!(user.user.username, username);

        let _summary: UserSummaryResponse = fetch_url(
            user_url(&username, true).expect("summary url"),
            TTL_USER,
            true,
        )
        .await
        .expect("用户摘要应能解析");
    }
}
