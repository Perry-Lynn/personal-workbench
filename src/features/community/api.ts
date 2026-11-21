/*
 * Trae 社区 · IPC 封装
 * ------------------------------------------------------------------
 * 命令前缀 community_，统一走 @/core/ipc 的 call()（自动拆 ApiResponse）。
 * 这里只负责「发请求」，字段兜底在 format.ts。
 * @Author: fu
 */
import { call } from '@/core/ipc';
import type {
  RawCategories,
  RawChatChannels,
  RawChatMessages,
  RawLatest,
  RawNotifications,
  RawPostsResponse,
  RawSessionState,
  RawTags,
  RawTopic,
  RawUser,
  RawUserSummary,
} from './types';

/** 最新主题 + 作者映射。page 从 0 开始（0=首页，1=下一批）。force=true 跳过后端内存缓存 */
export const fetchLatest = (force = false, page = 0): Promise<RawLatest> =>
  call<RawLatest>('community_latest', { force, page });

/** 某分类下的主题（服务端 `category={id}` 过滤，含分页） */
export const fetchCategoryTopics = (
  categoryId: number,
  page = 0,
  force = false,
): Promise<RawLatest> =>
  call<RawLatest>('community_category_topics', { categoryId, page, force });

/** 全站标签目录（热门标签 + extras.tag_groups 分组） */
export const fetchTags = (force = false): Promise<RawTags> =>
  call<RawTags>('community_tags', { force });

/** 标签下的主题（服务端过滤 + 分页） */
export const fetchTagTopics = (tag: string, page = 0, force = false): Promise<RawLatest> =>
  call<RawLatest>('community_tag_topics', { tag, page, force });

/** 官方首页「社区置顶」：来自 featured 标签的 4 条主题 */
export const fetchFeatured = (force = false): Promise<RawLatest> =>
  call<RawLatest>('community_featured', { force });

/** 一级分类列表 */
export const fetchCategories = (force = false): Promise<RawCategories> =>
  call<RawCategories>('community_categories', { force });

/** 主题详情（首屏楼层 + 剩余楼层 id） */
export const fetchTopic = (topicId: number, force = false): Promise<RawTopic> =>
  call<RawTopic>('community_topic', { topicId, force });

/** 按楼层 id 批量加载剩余回复（一次最多 40 个） */
export const fetchTopicPosts = (topicId: number, postIds: number[]): Promise<RawPostsResponse> =>
  call<RawPostsResponse>('community_topic_posts', { topicId, postIds });

/** 用户公开资料 */
export const fetchUser = (username: string): Promise<RawUser> =>
  call<RawUser>('community_user', { username });

/** 用户公开资料摘要（发帖 / 获赞 / 最近主题） */
export const fetchUserSummary = (username: string): Promise<RawUserSummary> =>
  call<RawUserSummary>('community_user_summary', { username });

/*
 * =============================================
 * 登录（内嵌 WebviewWindow + SSO cookie 复用）
 * =============================================
 * 打开登录窗口 → 用户完成 Trae 统一登录 → 轮询 community_login_check
 * 读取论坛 cookie 并校验 /session/current.json，成功后自动关闭窗口。
 */

/** 当前登录态（cookie 不经过 IPC，只回用户名/未读数） */
export const fetchSession = (): Promise<RawSessionState> =>
  call<RawSessionState>('community_session');

/** 打开论坛登录窗口（跳 www.trae.cn 统一登录） */
export const openLoginWindow = (): Promise<RawSessionState> =>
  call<RawSessionState>('community_login_open');

/** 轮询校验：登录成功后窗口自动关闭 */
export const checkLogin = (): Promise<RawSessionState> =>
  call<RawSessionState>('community_login_check');

/** 退出登录：清掉本地凭证 */
export const logout = (): Promise<RawSessionState> =>
  call<RawSessionState>('community_logout');

/** 通知列表 */
export const fetchNotifications = (force = false): Promise<RawNotifications> =>
  call<RawNotifications>('community_notifications', { force });

/** 全部标记已读 */
export const markNotificationsRead = (): Promise<void> =>
  call<void>('community_notifications_mark_read');

/** 私信/聊天频道（Chat 插件，404 时后端自动退回私信主题） */
export const fetchChatChannels = (force = false): Promise<RawChatChannels> =>
  call<RawChatChannels>('community_chat_channels', { force });

/** 单个频道/私信的消息 */
export const fetchChatMessages = (channelId: number): Promise<RawChatMessages> =>
  call<RawChatMessages>('community_chat_messages', { channelId });
