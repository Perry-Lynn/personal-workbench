/*
 * Trae 社区 · 数据模型
 * ------------------------------------------------------------------
 * 全部按 forum.trae.cn（Discourse）真实返回字段建结构体。
 *
 * 两条硬约定：
 *   1. 每个结构体都挂 `#[serde(default)]`：社区接口随时可能少给字段
 *      （匿名态尤其明显，比如 `like_count` 在部分帖子里根本不出现），
 *      缺字段一律落到默认值，**不允许反序列化失败**。
 *   2. 只建前端真正用到的字段。没用的字段不建，避免以后社区改字段
 *      时这里跟着报「未知字段」—— serde 默认忽略未知字段，多建只会是负担。
 *
 * `/notifications.json` 与 chat 接口的形状在这里同样先定义好，
 * 这一版不登录、拿不到数据，但类型和命令入口要留出来（见 commands.rs）。
 * @Author: fu
 */
use serde::{Deserialize, Serialize};

/* =============================================
   ====== /latest.json ======
   ============================================= */

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct LatestResponse {
    pub users: Vec<LatestUser>,
    pub topic_list: TopicList,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct LatestUser {
    pub id: i64,
    pub username: String,
    pub name: Option<String>,
    pub avatar_template: Option<String>,
    pub trust_level: Option<i64>,
    pub moderator: Option<bool>,
    pub admin: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct TopicList {
    pub topics: Vec<TopicListItem>,
    pub more_topics_url: Option<String>,
    pub per_page: Option<i64>,
    /** 匿名态为 false；列表接口用它判断「还能不能继续发帖」，分页判断靠 more_topics_url */
    pub can_create_topic: Option<bool>,
    /** 标签页的 topic_list 会附带该标签自身的统计（活动回顾等），普通列表为空 */
    pub tags: Vec<TagItem>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct TopicListItem {
    pub id: i64,
    pub title: String,
    pub fancy_title: Option<String>,
    pub slug: Option<String>,
    pub excerpt: Option<String>,
    pub posts_count: Option<i64>,
    pub reply_count: Option<i64>,
    pub views: Option<i64>,
    pub like_count: Option<i64>,
    pub created_at: Option<String>,
    pub last_posted_at: Option<String>,
    pub bumped_at: Option<String>,
    pub category_id: Option<i64>,
    pub pinned: Option<bool>,
    pub pinned_globally: Option<bool>,
    pub closed: Option<bool>,
    pub archived: Option<bool>,
    pub has_accepted_answer: Option<bool>,
    pub image_url: Option<String>,
    pub last_poster_username: Option<String>,
    pub tags: Vec<TagItem>,
    pub posters: Vec<Poster>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct TagItem {
    pub id: Option<i64>,
    /** /tags.json 里 text 与 name 通常相同，个别标签 name 是 slug，前端优先取 text */
    pub text: Option<String>,
    pub name: String,
    pub slug: Option<String>,
    pub description: Option<String>,
    pub count: Option<i64>,
    pub pm_only: Option<bool>,
    /** 标签页 topic_list.tags 里的主题数（与 /tags.json 的 count 同义） */
    pub topic_count: Option<i64>,
}

/* =============================================
   ====== /tags.json ======
   ============================================= */

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct TagsResponse {
    /** 站点热门标签（65 个左右），按主题数排序 */
    pub tags: Vec<TagItem>,
    pub extras: TagExtras,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct TagExtras {
    /** 后台配置的标签分组；组内 tag 与顶层 tags 是两批不同的标签，前端需要合并 */
    pub tag_groups: Vec<TagGroup>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct TagGroup {
    pub id: i64,
    pub name: String,
    pub tags: Vec<TagItem>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Poster {
    pub user_id: i64,
    pub description: Option<String>,
    pub extras: Option<String>,
}

/* =============================================
   ====== /categories.json ======
   ============================================= */

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct CategoriesResponse {
    pub category_list: CategoryList,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct CategoryList {
    pub categories: Vec<CategoryItem>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct CategoryItem {
    pub id: i64,
    pub name: String,
    pub slug: Option<String>,
    pub color: Option<String>,
    pub text_color: Option<String>,
    pub description: Option<String>,
    pub description_text: Option<String>,
    pub topic_count: Option<i64>,
    pub post_count: Option<i64>,
    pub parent_category_id: Option<i64>,
    pub read_restricted: Option<bool>,
    pub subcategory_ids: Vec<i64>,
}

/* =============================================
   ====== /t/{id}.json 与 /t/{id}/posts.json ======
   ============================================= */

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct TopicResponse {
    pub id: i64,
    pub title: String,
    pub fancy_title: Option<String>,
    pub slug: Option<String>,
    pub posts_count: Option<i64>,
    pub reply_count: Option<i64>,
    pub views: Option<i64>,
    pub like_count: Option<i64>,
    pub created_at: Option<String>,
    pub last_posted_at: Option<String>,
    pub category_id: Option<i64>,
    pub pinned: Option<bool>,
    pub closed: Option<bool>,
    pub archived: Option<bool>,
    pub has_accepted_answer: Option<bool>,
    pub image_url: Option<String>,
    pub tags: Vec<TagItem>,
    pub post_stream: PostStream,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct PostsResponse {
    pub id: Option<i64>,
    pub post_stream: PostStream,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct PostStream {
    pub posts: Vec<Post>,
    /** 整帖的楼层 id 顺序；首屏只给前 ~20 楼，其余靠这里的 id 分批拉 */
    pub stream: Vec<i64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Post {
    pub id: i64,
    pub username: String,
    pub name: Option<String>,
    pub display_username: Option<String>,
    pub avatar_template: Option<String>,
    pub created_at: Option<String>,
    pub cooked: String,
    pub post_number: Option<i64>,
    pub reply_to_post_number: Option<i64>,
    pub reaction_users_count: Option<i64>,
    pub like_count: Option<i64>,
    pub reads: Option<i64>,
    pub readers_count: Option<i64>,
    pub user_title: Option<String>,
    pub moderator: Option<bool>,
    pub admin: Option<bool>,
    pub staff: Option<bool>,
    pub user_id: Option<i64>,
    pub accepted_answer: Option<bool>,
    pub topic_accepted_answer: Option<bool>,
    pub bookmarked: Option<bool>,
    pub hidden: Option<bool>,
    pub deleted_at: Option<String>,
}

/* =============================================
   ====== /u/{username}.json 与 /summary.json ======
   ============================================= */

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct UserResponse {
    pub user: UserInfo,
    pub badges: Vec<BadgeItem>,
    pub user_badges: Vec<UserBadge>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct UserInfo {
    pub id: i64,
    pub username: String,
    pub name: Option<String>,
    pub avatar_template: Option<String>,
    pub trust_level: Option<i64>,
    pub moderator: Option<bool>,
    pub admin: Option<bool>,
    pub title: Option<String>,
    pub badge_count: Option<i64>,
    pub time_read: Option<i64>,
    pub recent_time_read: Option<i64>,
    pub profile_view_count: Option<i64>,
    pub gamification_score: Option<i64>,
    pub accepted_answers: Option<i64>,
    pub created_at: Option<String>,
    pub last_seen_at: Option<String>,
    pub last_posted_at: Option<String>,
    pub bio_raw: Option<String>,
    pub bio_cooked: Option<String>,
    pub location: Option<String>,
    pub website: Option<String>,
    pub primary_group_name: Option<String>,
    pub flair_name: Option<String>,
    pub can_send_private_messages: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct BadgeItem {
    pub id: i64,
    pub name: String,
    pub description: Option<String>,
    pub icon: Option<String>,
    pub image_url: Option<String>,
    pub badge_type_id: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct UserBadge {
    pub id: i64,
    pub badge_id: i64,
    pub granted_at: Option<String>,
    pub count: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct UserSummaryResponse {
    pub user_summary: UserSummary,
    pub topics: Vec<SummaryTopic>,
    pub badges: Vec<BadgeItem>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct UserSummary {
    pub likes_given: Option<i64>,
    pub likes_received: Option<i64>,
    pub topics_entered: Option<i64>,
    pub posts_read_count: Option<i64>,
    pub days_visited: Option<i64>,
    pub topic_count: Option<i64>,
    pub post_count: Option<i64>,
    pub time_read: Option<i64>,
    pub solved_count: Option<i64>,
    pub top_categories: Vec<TopCategory>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct SummaryTopic {
    pub id: i64,
    pub title: String,
    pub fancy_title: Option<String>,
    pub slug: Option<String>,
    pub posts_count: Option<i64>,
    pub like_count: Option<i64>,
    pub category_id: Option<i64>,
    pub created_at: Option<String>,
    pub has_accepted_answer: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct TopCategory {
    pub id: Option<i64>,
    pub name: String,
    pub color: Option<String>,
    pub topic_count: Option<i64>,
}

/* =============================================
   ====== /notifications.json（登录后才可读）
   =============================================
   匿名请求该接口固定 403。这里先把真实结构定义好，命令入口在
   commands.rs 里以 LoginRequired 返回；接入登录后只需换掉取数那一行。
   字段参考 Discourse NotificationSerializer。
*/

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct NotificationsResponse {
    pub notifications: Vec<NotificationItem>,
    pub total_rows_notifications: Option<i64>,
    pub seen_notification_id: Option<i64>,
    pub load_more_notifications: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct NotificationItem {
    pub id: i64,
    pub notification_type: Option<i64>,
    pub read: Option<bool>,
    pub created_at: Option<String>,
    pub post_number: Option<i64>,
    pub topic_id: Option<i64>,
    pub fancy_title: Option<String>,
    pub slug: Option<String>,
    pub acting_user_avatar_template: Option<String>,
    pub data: NotificationData,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct NotificationData {
    pub topic_title: Option<String>,
    pub original_post_id: Option<i64>,
    pub original_post_type: Option<i64>,
    pub original_username: Option<String>,
    pub display_username: Option<String>,
    pub badge_name: Option<String>,
    pub group_name: Option<String>,
    pub username: Option<String>,
    pub count: Option<i64>,
    pub message: Option<String>,
}

/* =============================================
   ====== chat 频道（登录后才可读）
   =============================================
   匿名访问 `/chat/api/channels` 固定 403。结构按 Discourse Chat 插件：
   公开频道与私信频道分开返回，不保证一定有字段，因此全部 Option。
*/

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ChatChannelsResponse {
    pub public_channels: Vec<ChatChannel>,
    pub direct_message_channels: Vec<ChatChannel>,
    pub tracking: Option<serde_json::Value>,
    /* chat = Chat 插件接口；pm = 退回 /u/{username}/messages.json */
    pub source: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ChatChannel {
    pub id: i64,
    pub title: Option<String>,
    pub slug: Option<String>,
    pub chatable_id: Option<i64>,
    pub chatable_type: Option<String>,
    pub unread_count: Option<i64>,
    pub last_message: Option<ChatMessageSummary>,
    pub membership: Option<ChatMembership>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ChatMessageSummary {
    pub id: i64,
    pub message: Option<String>,
    pub created_at: Option<String>,
    pub username: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ChatMembership {
    pub following: Option<bool>,
    pub muted: Option<bool>,
    pub last_read_message_id: Option<i64>,
}

/* =============================================
   ====== 登录态：/session/current.json ======
   =============================================
   匿名访问是 404；带上 `_t` cookie 才返回 current_user。
*/
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct SessionCurrentResponse {
    pub current_user: Option<CurrentUser>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct CurrentUser {
    pub id: i64,
    pub username: String,
    pub name: Option<String>,
    pub avatar_template: Option<String>,
    pub trust_level: Option<i64>,
    pub admin: Option<bool>,
    pub moderator: Option<bool>,
    pub unread_notifications: Option<i64>,
    pub unread_private_messages: Option<i64>,
    pub unread_high_priority_notifications: Option<i64>,
}

/* /session/csrf.json：写操作（标记已读）需要 X-CSRF-Token */
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct CsrfResponse {
    pub csrf: String,
}

/* chat 频道消息：/chat/api/channels/{id}/messages.json 或主题楼层回退 */
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ChatMessagesResponse {
    pub messages: Vec<ChatMessage>,
    pub meta: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ChatMessage {
    pub id: i64,
    pub message: Option<String>,
    pub cooked: Option<String>,
    pub created_at: Option<String>,
    pub chat_channel_id: Option<i64>,
    pub user: Option<ChatMessageUser>,
    /* 私信主题回退时的楼层号 */
    pub post_number: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ChatMessageUser {
    pub username: Option<String>,
    pub name: Option<String>,
    pub avatar_template: Option<String>,
}

/* /u/{username}/messages.json：chat 插件不可用时的私信回退 */
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct UserMessagesResponse {
    pub user: UserInfo,
    pub topic_list: TopicList,
}
