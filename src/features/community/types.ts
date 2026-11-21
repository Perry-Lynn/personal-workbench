/*
 * Trae 社区 · 类型定义
 * ------------------------------------------------------------------
 * 分两层：
 *   Raw*  —— 与 Rust 结构体逐字段对应（Discourse 原始形状，snake_case，字段可缺）
 *   *     —— 前端归一化后的形状（字段齐全、camelCase，界面只认这一层）
 *
 * 归一化在 format.ts 里完成，**不在组件里散着写兜底**：
 * 同一个 id 在列表、详情、用户主页三处都要兜底，写三遍迟早漏一处。
 * @Author: fu
 */

/* =============================================
   ====== 原始响应（Rust 侧 Serialize 的形状） ======
   ============================================= */

export interface RawPoster {
  user_id?: number | null;
  description?: string | null;
  extras?: string | null;
}

export interface RawTag {
  id?: number | null;
  text?: string | null;
  name?: string | null;
  slug?: string | null;
  description?: string | null;
  count?: number | null;
  pm_only?: boolean | null;
  topic_count?: number | null;
}

export interface RawTopicItem {
  id?: number | null;
  title?: string | null;
  fancy_title?: string | null;
  slug?: string | null;
  excerpt?: string | null;
  posts_count?: number | null;
  reply_count?: number | null;
  views?: number | null;
  like_count?: number | null;
  created_at?: string | null;
  last_posted_at?: string | null;
  bumped_at?: string | null;
  category_id?: number | null;
  pinned?: boolean | null;
  pinned_globally?: boolean | null;
  closed?: boolean | null;
  archived?: boolean | null;
  has_accepted_answer?: boolean | null;
  image_url?: string | null;
  last_poster_username?: string | null;
  tags?: RawTag[] | null;
  posters?: RawPoster[] | null;
}

export interface RawLatestUser {
  id?: number | null;
  username?: string | null;
  name?: string | null;
  avatar_template?: string | null;
  trust_level?: number | null;
  moderator?: boolean | null;
  admin?: boolean | null;
}

export interface RawLatest {
  users?: RawLatestUser[] | null;
  topic_list?: {
    topics?: RawTopicItem[] | null;
    more_topics_url?: string | null;
    per_page?: number | null;
    /** 匿名态 false；官方用它控制「发新帖」按钮 */
    can_create_topic?: boolean | null;
    /** /tag/{name}.json 会在这里带该标签自身的统计 */
    tags?: RawTag[] | null;
  } | null;
}

/** /tags.json：热门标签 + 后台配置的分组 */
export interface RawTags {
  tags?: RawTag[] | null;
  extras?: {
    tag_groups?: {
      id?: number | null;
      name?: string | null;
      tags?: RawTag[] | null;
    }[] | null;
  } | null;
}

export interface RawCategoryItem {
  id?: number | null;
  name?: string | null;
  slug?: string | null;
  color?: string | null;
  text_color?: string | null;
  description?: string | null;
  description_text?: string | null;
  topic_count?: number | null;
  post_count?: number | null;
  parent_category_id?: number | null;
  read_restricted?: boolean | null;
  subcategory_ids?: number[] | null;
}

export interface RawCategories {
  category_list?: {
    categories?: RawCategoryItem[] | null;
  } | null;
}

export interface RawPost {
  id?: number | null;
  username?: string | null;
  name?: string | null;
  display_username?: string | null;
  avatar_template?: string | null;
  created_at?: string | null;
  cooked?: string | null;
  post_number?: number | null;
  reply_to_post_number?: number | null;
  reaction_users_count?: number | null;
  like_count?: number | null;
  reads?: number | null;
  readers_count?: number | null;
  user_title?: string | null;
  moderator?: boolean | null;
  admin?: boolean | null;
  staff?: boolean | null;
  user_id?: number | null;
  accepted_answer?: boolean | null;
  topic_accepted_answer?: boolean | null;
  bookmarked?: boolean | null;
  hidden?: boolean | null;
  deleted_at?: string | null;
}

export interface RawPostStream {
  posts?: RawPost[] | null;
  stream?: number[] | null;
}

export interface RawTopic {
  id?: number | null;
  title?: string | null;
  fancy_title?: string | null;
  slug?: string | null;
  posts_count?: number | null;
  reply_count?: number | null;
  views?: number | null;
  like_count?: number | null;
  created_at?: string | null;
  last_posted_at?: string | null;
  category_id?: number | null;
  pinned?: boolean | null;
  closed?: boolean | null;
  archived?: boolean | null;
  has_accepted_answer?: boolean | null;
  image_url?: string | null;
  tags?: RawTag[] | null;
  post_stream?: RawPostStream | null;
}

export interface RawPostsResponse {
  id?: number | null;
  post_stream?: RawPostStream | null;
}

export interface RawUserInfo {
  id?: number | null;
  username?: string | null;
  name?: string | null;
  avatar_template?: string | null;
  trust_level?: number | null;
  moderator?: boolean | null;
  admin?: boolean | null;
  title?: string | null;
  badge_count?: number | null;
  time_read?: number | null;
  profile_view_count?: number | null;
  gamification_score?: number | null;
  accepted_answers?: number | null;
  created_at?: string | null;
  last_seen_at?: string | null;
  last_posted_at?: string | null;
  bio_raw?: string | null;
  bio_cooked?: string | null;
  location?: string | null;
  website?: string | null;
  primary_group_name?: string | null;
  flair_name?: string | null;
}

export interface RawBadge {
  id?: number | null;
  name?: string | null;
  description?: string | null;
  icon?: string | null;
  image_url?: string | null;
  badge_type_id?: number | null;
}

export interface RawUserBadge {
  id?: number | null;
  badge_id?: number | null;
  granted_at?: string | null;
  count?: number | null;
}

export interface RawUser {
  user?: RawUserInfo | null;
  badges?: RawBadge[] | null;
  user_badges?: RawUserBadge[] | null;
}

export interface RawSummaryTopic {
  id?: number | null;
  title?: string | null;
  fancy_title?: string | null;
  slug?: string | null;
  posts_count?: number | null;
  like_count?: number | null;
  category_id?: number | null;
  created_at?: string | null;
}

export interface RawUserSummary {
  user_summary?: {
    likes_given?: number | null;
    likes_received?: number | null;
    topics_entered?: number | null;
    posts_read_count?: number | null;
    days_visited?: number | null;
    topic_count?: number | null;
    post_count?: number | null;
    time_read?: number | null;
    solved_count?: number | null;
    top_categories?: { id?: number | null; name?: string | null; color?: string | null; topic_count?: number | null }[] | null;
  } | null;
  topics?: RawSummaryTopic[] | null;
  badges?: RawBadge[] | null;
}

/* =============================================
   ====== 登录后接口（这一版只定义，不调用）
   ============================================= */

export interface RawNotifications {
  notifications?: {
    id?: number | null;
    notification_type?: number | null;
    read?: boolean | null;
    created_at?: string | null;
    post_number?: number | null;
    topic_id?: number | null;
    fancy_title?: string | null;
    slug?: string | null;
    acting_user_avatar_template?: string | null;
    data?: {
      topic_title?: string | null;
      original_username?: string | null;
      display_username?: string | null;
      badge_name?: string | null;
      group_name?: string | null;
      username?: string | null;
      count?: number | null;
      message?: string | null;
    } | null;
  }[] | null;
  total_rows_notifications?: number | null;
  seen_notification_id?: number | null;
  load_more_notifications?: string | null;
}

export interface RawChatChannels {
  public_channels?: RawChatChannel[] | null;
  direct_message_channels?: RawChatChannel[] | null;
  /** chat = Chat 插件；pm = /u/{username}/messages.json 回退 */
  source?: string | null;
}

export interface RawChatMessages {
  messages?: {
    id?: number | null;
    message?: string | null;
    cooked?: string | null;
    created_at?: string | null;
    chat_channel_id?: number | null;
    post_number?: number | null;
    user?: {
      username?: string | null;
      name?: string | null;
      avatar_template?: string | null;
    } | null;
  }[] | null;
}

/** /session/current.json 校验后的登录态（不含 cookie） */
export interface RawSessionState {
  logged_in?: boolean | null;
  username?: string | null;
  name?: string | null;
  avatar_template?: string | null;
  unread_notifications?: number | null;
  unread_private_messages?: number | null;
  stored?: string | null;
  window_open?: boolean | null;
}

export interface RawChatChannel {
  id?: number | null;
  title?: string | null;
  slug?: string | null;
  unread_count?: number | null;
  last_message?: {
    id?: number | null;
    message?: string | null;
    created_at?: string | null;
    username?: string | null;
  } | null;
}

/* =============================================
   ====== 归一化后的界面模型 ======
   ============================================= */

export interface CommunityAuthor {
  id: number;
  username: string;
  name: string;
  avatar: string | null;
  staff: boolean;
}

export interface CategoryNode {
  id: number;
  name: string;
  slug: string;
  color: string;
  topicCount: number;
  description: string;
  parentId: number | null;
  childIds: number[];
}

export interface TopicSummary {
  id: number;
  title: string;
  excerpt: string;
  categoryId: number | null;
  categoryName: string;
  categoryColor: string;
  author: CommunityAuthor | null;
  posters: CommunityAuthor[];
  postsCount: number;
  replyCount: number;
  views: number;
  likeCount: number;
  tags: string[];
  pinned: boolean;
  /** 全局置顶（不跟随分类），官方列表里排在本分类置顶之前 */
  pinnedGlobally: boolean;
  closed: boolean;
  archived: boolean;
  hasAcceptedAnswer: boolean;
  createdAt: string | null;
  lastPostedAt: string | null;
  bumpedAt: string | null;
  imageUrl: string | null;
}

export interface TopicPost {
  id: number;
  username: string;
  name: string;
  avatar: string | null;
  createdAt: string | null;
  /** 已归一化的 HTML（渲染前仍会过 sanitizeCookedHtml） */
  cooked: string;
  postNumber: number;
  replyToPostNumber: number | null;
  likeCount: number;
  reads: number;
  userTitle: string;
  staff: boolean;
  moderator: boolean;
  admin: boolean;
  acceptedAnswer: boolean;
  deleted: boolean;
  topicId: number;
}

export interface TopicDetail {
  id: number;
  title: string;
  categoryId: number | null;
  categoryName: string;
  categoryColor: string;
  postsCount: number;
  replyCount: number;
  views: number;
  likeCount: number;
  createdAt: string | null;
  lastPostedAt: string | null;
  pinned: boolean;
  closed: boolean;
  archived: boolean;
  hasAcceptedAnswer: boolean;
  imageUrl: string | null;
  tags: string[];
  posts: TopicPost[];
  streamIds: number[];
}

export interface UserStats {
  likesGiven: number;
  likesReceived: number;
  topicsEntered: number;
  postsRead: number;
  daysVisited: number;
  topicCount: number;
  postCount: number;
  solvedCount: number;
  readMinutes: number;
}

export interface UserBadgeView {
  id: number;
  name: string;
  description: string;
  icon: string | null;
}

export interface UserProfile {
  id: number;
  username: string;
  name: string;
  avatar: string | null;
  title: string;
  trustLevel: number;
  admin: boolean;
  moderator: boolean;
  bioHtml: string | null;
  bioText: string;
  location: string;
  website: string;
  groupName: string;
  joinedAt: string | null;
  lastSeenAt: string | null;
  lastPostedAt: string | null;
  gamificationScore: number;
  profileViews: number;
  acceptedAnswers: number;
  stats: UserStats;
  badges: UserBadgeView[];
  recentTopics: { id: number; title: string; likeCount: number; postsCount: number; createdAt: string | null }[];
  topCategories: { id: number | null; name: string; color: string; topicCount: number }[];
}

export type NavMode = 'latest' | 'hot' | 'unread' | 'following';

export type CommunityView =
  | { kind: 'list' }
  | { kind: 'tags' }
  | { kind: 'topic'; topicId: number }
  | { kind: 'profile'; username: string; mine: boolean }
  | { kind: 'me' }
  | { kind: 'locked'; panel: 'notifications' | 'chat' };

/* =============================================
   ====== 标签（/tags.json 归一化） ======
   ============================================= */

export interface TagView {
  id: number;
  name: string;
  slug: string;
  count: number;
  description: string;
}

export interface TagGroupView {
  id: number;
  name: string;
  tags: TagView[];
}

export interface TagCatalog {
  /** 全部标签，按主题数倒序 */
  flat: TagView[];
  /** 后台分组（组内也按主题数倒序） */
  groups: TagGroupView[];
  /** 未进入任何分组的标签，按主题数倒序 */
  ungrouped: TagView[];
  /** 是否真的拿到了分组信息（决定界面展示「分组」还是「平铺」） */
  grouped: boolean;
}

/** 登录相关入口的状态 */
export type LoginGateState = 'login_required' | 'loading' | 'ready' | 'error';

/* =============================================
   ====== 登录、通知、私信 ======
   ============================================= */

export interface CommunitySession {
  loggedIn: boolean;
  username: string | null;
  name: string | null;
  avatar: string | null;
  unreadNotifications: number;
  unreadPrivateMessages: number;
  /** keychain / file / '' */
  stored: string;
  windowOpen: boolean;
}

export interface CommunityNotification {
  id: number;
  type: number;
  typeLabel: string;
  read: boolean;
  createdAt: string | null;
  topicId: number | null;
  postNumber: number | null;
  title: string;
  excerpt: string;
  username: string | null;
  avatar: string | null;
}

export interface ChatChannelView {
  id: number;
  title: string;
  unreadCount: number;
  lastMessage: string;
  lastMessageAt: string | null;
  lastUsername: string | null;
  kind: 'public' | 'direct';
}

export interface ChatMessageView {
  id: number;
  username: string;
  name: string;
  avatar: string | null;
  createdAt: string | null;
  html: string;
  text: string;
  postNumber: number | null;
}
