/*
 * Trae 社区 · 纯逻辑（可在 node 里单测）
 * ------------------------------------------------------------------
 * 这里只放「不碰 React、不碰 DOM、不碰 IPC」的转换：
 *   - Discourse 原始字段 → 界面模型（所有字段都兜底）
 *   - 时间 / 数字格式化
 *   - 置顶分组 / 分类 / 搜索 / 排序
 *
 * 组件里不要再写 `t.title || '无标题'` 这种兜底 —— 同一份兜底写三遍必漏。
 * @Author: fu
 */
import type {
  CategoryNode,
  ChatChannelView,
  ChatMessageView,
  CommunityAuthor,
  CommunityNotification,
  NavMode,
  RawCategories,
  RawCategoryItem,
  RawChatChannels,
  RawChatMessages,
  RawLatest,
  RawLatestUser,
  RawNotifications,
  RawPost,
  RawPostStream,
  RawTag,
  RawTags,
  RawTopic,
  RawTopicItem,
  RawUser,
  RawUserSummary,
  TagCatalog,
  TagGroupView,
  TagView,
  TopicDetail,
  TopicPost,
  TopicSummary,
  UserProfile,
} from './types';

export const FORUM_BASE = 'https://forum.trae.cn';
export const DEFAULT_CATEGORY_COLOR = '#0D9488';

const FALLBACK_TITLE = '无标题主题';
const FALLBACK_USER = '社区用户';

/* =============================================
   ====== 文本与 URL ======
   ============================================= */

/**
 * Discourse 头像模板：`/user_avatar/forum.trae.cn/名字/{size}/xxx.png`。
 * 必须补全域名 —— 相对路径在 WebView 里会被解析到 tauri://localhost。
 */
export function avatarUrl(template: string | null | undefined, size = 96): string | null {
  if (!template) return null;
  const raw = template.replace('{size}', String(size));
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('/')) return `${FORUM_BASE}${raw}`;
  return `${FORUM_BASE}/${raw}`;
}

/** 分类颜色只接受 #rgb / #rrggbb，其它值（空、rgb()、颜色名）一律回品牌色 */
export function safeCategoryColor(color: string | null | undefined): string {
  const value = (color || '').trim();
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) return value;
  return DEFAULT_CATEGORY_COLOR;
}

const SHORTCODES: Record<string, string> = {
  tada: '🎉',
  loudspeaker: '📢',
  alarm_clock: '⏰',
  date: '📅',
  light_bulb: '💡',
  bulb: '💡',
  sparkles: '✨',
  rocket: '🚀',
  fire: '🔥',
  heart: '❤️',
  white_check_mark: '✅',
  heavy_check_mark: '✔️',
  x: '❌',
  warning: '⚠️',
  star: '⭐',
  star2: '🌟',
  zap: '⚡',
  bug: '🐛',
  wrench: '🔧',
  hammer_and_wrench: '🛠️',
  speech_balloon: '💬',
  question: '❓',
  exclamation: '❗',
  eyes: '👀',
  smile: '😄',
  joy: '😂',
  cry: '😢',
  thinking: '🤔',
  point_up: '☝️',
  clap: '👏',
  trophy: '🏆',
  medal: '🏅',
  gift: '🎁',
  calendar: '📆',
  hourglass: '⌛',
  checkered_flag: '🏁',
  computer: '💻',
  iphone: '📱',
  package: '📦',
  memo: '📝',
  books: '📚',
  book: '📖',
  link: '🔗',
  lock: '🔒',
  key: '🔑',
  mag: '🔍',
  bell: '🔔',
  coffee: '☕',
  sun: '☀️',
  sunny: '☀️',
  moon: '🌙',
  cloud: '☁️',
  rainbow: '🌈',
  robot: '🤖',
  art: '🎨',
  palette: '🎨',
  camera: '📷',
  movie_camera: '🎬',
  music_note: '🎵',
  memo_pencil: '📝',
  pencil: '✏️',
  tools: '🧰',
  shield: '🛡️',
  crown: '👑',
  dart: '🎯',
  confetti_ball: '🎊',
  balloon: '🎈',
};

/**
 * 把 Discourse 的 `:tada:` 短码换成 emoji。
 * 只匹配「字母开头」的短码，避免把 `12:30:45` 这类时间误伤成 `1245`。
 * 不认识的短码直接去掉（原站会渲染成 emoji 图，这里至少别把 `:` 留在标题里）。
 */
export function decodeShortcodes(text: string): string {
  if (!text) return '';
  return text.replace(/:([a-z][a-z0-9_+-]*):/gi, (_m, name: string) => SHORTCODES[name.toLowerCase()] ?? '');
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  copy: '©',
  reg: '®',
  trade: '™',
  middot: '·',
  times: '×',
};

/** 去掉标签、还原常见实体，把摘要压成一行 */
export function stripHtml(html: string | null | undefined, maxLength = 240): string {
  if (!html) return '';
  let text = html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (m, code: string) => {
      if (code.startsWith('#')) {
        const hex = code[1] === 'x' || code[1] === 'X';
        const num = parseInt(hex ? code.slice(2) : code.slice(1), hex ? 16 : 10);
        return Number.isFinite(num) && num > 0 && num < 0x10ffff ? String.fromCodePoint(num) : m;
      }
      return NAMED_ENTITIES[code.toLowerCase()] ?? ' ';
    })
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length > maxLength) text = `${text.slice(0, maxLength).trimEnd()}…`;
  return text;
}

/** 粘贴的用户名/主页链接 → 纯用户名（`@迟迟`、`https://forum.trae.cn/u/迟迟` 都认） */
export function parseUsernameInput(input: string): string {
  let value = (input || '').trim();
  if (!value) return '';
  const fromUrl = value.match(/\/u\/([^/?#]+)(?:\/summary)?(?:\.json)?(?:[/?#]|$)/i);
  if (fromUrl) {
    try {
      return decodeURIComponent(fromUrl[1]).replace(/\.json$/i, '');
    } catch {
      return fromUrl[1].replace(/\.json$/i, '');
    }
  }
  value = value.replace(/^@/, '').replace(/[/?#].*$/, '').replace(/\.json$/i, '');
  return decodeURIComponentSafe(value).trim();
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/* =============================================
   ====== 时间与数字 ======
   ============================================= */

function timeValue(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / 昨天 / N 天前 / M月D日 / YYYY年M月D日 */
export function formatRelativeTime(iso: string | null | undefined, now = Date.now()): string {
  const t = timeValue(iso);
  if (t === null) return '—';
  const diff = now - t;
  if (diff < 60_000) return '刚刚';
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 24 * 60 * 60_000) return `${Math.floor(diff / (60 * 60_000))} 小时前`;

  const days = Math.round((startOfDay(now) - startOfDay(t)) / (24 * 60 * 60_000));
  if (days === 1) return '昨天';
  if (days > 1 && days < 7) return `${days} 天前`;

  const d = new Date(t);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  if (sameYear) return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

/** 详情页的绝对时间：YYYY-MM-DD HH:mm */
export function formatDateTime(iso: string | null | undefined): string {
  const t = timeValue(iso);
  if (t === null) return '—';
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 缓存时间提示：刚同步 / N 分钟前 / N 小时前 / N 天前 */
export function formatCacheAge(savedAt: number | null | undefined, now = Date.now()): string {
  if (!savedAt || !Number.isFinite(savedAt)) return '';
  const diff = Math.max(0, now - savedAt);
  if (diff < 60_000) return '刚刚同步';
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)} 分钟前同步`;
  if (diff < 24 * 60 * 60_000) return `${Math.floor(diff / (60 * 60_000))} 小时前同步`;
  return `${Math.floor(diff / (24 * 60 * 60_000))} 天前同步`;
}

/** 1,228 → 1.2k；12,345 → 1.2 万 */
export function formatCount(n: number | null | undefined): string {
  const value = Number.isFinite(n) ? Math.max(0, Math.floor(n as number)) : 0;
  if (value >= 10_000) {
    const text = (value / 10_000).toFixed(value >= 100_000 ? 0 : 1);
    return `${text.replace(/\.0$/, '')} 万`;
  }
  if (value >= 1_000) {
    const text = (value / 1_000).toFixed(1);
    return `${text.replace(/\.0$/, '')}k`;
  }
  return String(value);
}

/** 阅读时长：秒 → 「x 小时」或「x 分钟」 */
export function formatReadTime(seconds: number | null | undefined): string {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds as number)) : 0;
  if (total >= 3600) {
    const hours = Math.round(total / 3600);
    return `${hours} 小时`;
  }
  if (total >= 60) return `${Math.floor(total / 60)} 分钟`;
  return `${total} 秒`;
}

/* =============================================
   ====== 归一化：分类 ======
   ============================================= */

export function normalizeCategories(raw: RawCategories | null | undefined): CategoryNode[] {
  const items = raw?.category_list?.categories ?? [];
  const nodes: CategoryNode[] = [];
  for (const item of items) {
    const id = Number(item?.id);
    if (!Number.isFinite(id) || id <= 0) continue;
    nodes.push(normalizeCategory(item));
  }
  return nodes;
}

function normalizeCategory(item: RawCategoryItem): CategoryNode {
  const childIds = Array.isArray(item.subcategory_ids)
    ? item.subcategory_ids.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0)
    : [];
  return {
    id: Number(item.id),
    name: (item.name || '').trim() || '未命名分类',
    slug: item.slug || '',
    color: safeCategoryColor(item.color),
    topicCount: Number(item.topic_count) || 0,
    description: stripHtml(item.description_text || item.description || '', 160),
    parentId: Number.isFinite(Number(item.parent_category_id)) && item.parent_category_id !== null
      ? Number(item.parent_category_id)
      : null,
    childIds,
  };
}

/** 只展示一级分类（Discourse 的 categories.json 通常也只给一级） */
export function topLevelCategories(categories: CategoryNode[]): CategoryNode[] {
  return categories.filter((c) => c.parentId === null);
}

/** 分类自身 + 全部后代 id（筛选时父分类要能带出子分类的主题） */
export function categoryScopeIds(categoryId: number | null, categories: CategoryNode[]): number[] | null {
  if (categoryId === null) return null;
  const out = new Set<number>([categoryId]);
  const queue = [categoryId];
  while (queue.length) {
    const current = queue.shift() as number;
    const node = categories.find((c) => c.id === current);
    if (!node) continue;
    for (const child of node.childIds) {
      if (!out.has(child)) {
        out.add(child);
        queue.push(child);
      }
    }
  }
  return [...out];
}

export function categoryOf(categoryId: number | null | undefined, categories: CategoryNode[]): CategoryNode | null {
  if (categoryId === null || categoryId === undefined) return null;
  const direct = categories.find((c) => c.id === categoryId);
  if (direct) return direct;
  return categories.find((c) => c.childIds.includes(categoryId)) ?? null;
}

function categoryName(categoryId: number | null, categories: CategoryNode[]): string {
  return categoryOf(categoryId, categories)?.name ?? '未分类';
}

function categoryColor(categoryId: number | null, categories: CategoryNode[]): string {
  return categoryOf(categoryId, categories)?.color ?? DEFAULT_CATEGORY_COLOR;
}

/* =============================================
   ====== 归一化：作者 / 列表 ======
   ============================================= */

function normalizeAuthor(
  user: RawLatestUser | undefined,
  fallbackUsername?: string | null,
): CommunityAuthor | null {
  const username = (user?.username || fallbackUsername || '').trim();
  if (!username && !user?.id) return null;
  return {
    id: Number(user?.id) || 0,
    username: username || FALLBACK_USER,
    name: (user?.name || '').trim() || username || FALLBACK_USER,
    avatar: avatarUrl(user?.avatar_template),
    staff: Boolean(user?.moderator || user?.admin),
  };
}

function tagsOf(tags: { name?: string | null }[] | null | undefined): string[] {
  return (tags ?? [])
    .map((t) => (t?.name || '').trim())
    .filter(Boolean);
}

export interface NormalizedLatest {
  topics: TopicSummary[];
  users: Record<number, CommunityAuthor>;
  /** 服务端给的「还有下一页」地址；为 null 才是真正到底 */
  moreTopicsUrl: string | null;
  /** 匿名态为 false，仅用于判断能否发帖，与分页无关 */
  canCreateTopic: boolean;
}

export function normalizeLatest(
  raw: RawLatest | null | undefined,
  categories: CategoryNode[] = [],
): NormalizedLatest {
  const userMap: Record<number, CommunityAuthor> = {};
  for (const user of raw?.users ?? []) {
    const id = Number(user?.id);
    const author = normalizeAuthor(user);
    if (Number.isFinite(id) && id > 0 && author) userMap[id] = author;
  }

  const topics: TopicSummary[] = [];
  for (const item of raw?.topic_list?.topics ?? []) {
    const normalized = normalizeTopicSummary(item, userMap, categories);
    if (normalized) topics.push(normalized);
  }
  const more = (raw?.topic_list?.more_topics_url ?? '').trim();
  return {
    topics,
    users: userMap,
    moreTopicsUrl: more || null,
    canCreateTopic: Boolean(raw?.topic_list?.can_create_topic),
  };
}

/**
 * 分页追加：按 id 去重，保留已有顺序，新主题排在后面。
 * Discourse 分页之间偶尔会重叠（置顶帖插队），不去重会出现两张同 id 卡片。
 */
export function appendTopics(current: TopicSummary[], incoming: TopicSummary[]): TopicSummary[] {
  const seen = new Set(current.map((t) => t.id));
  const out = [...current];
  for (const topic of incoming) {
    if (seen.has(topic.id)) continue;
    seen.add(topic.id);
    out.push(topic);
  }
  return out;
}

function normalizeTopicSummary(
  item: Partial<RawTopicItem>,
  userMap: Record<number, CommunityAuthor>,
  categories: CategoryNode[],
): TopicSummary | null {
  const id = Number(item?.id);
  if (!Number.isFinite(id) || id <= 0) return null;

  const posters: CommunityAuthor[] = [];
  for (const poster of item.posters ?? []) {
    const userId = Number(poster?.user_id);
    const user = userMap[userId];
    if (user) {
      posters.push(user);
    } else if (poster?.user_id === -1) {
      posters.push({
        id: -1,
        username: 'system',
        name: '系统',
        avatar: null,
        staff: true,
      });
    }
  }

  const author = posters[0] ?? normalizeAuthor(undefined, item.last_poster_username);
  const categoryId = Number.isFinite(Number(item.category_id)) ? Number(item.category_id) : null;

  return {
    id,
    title: decodeShortcodes((item.fancy_title || item.title || '').trim()) || FALLBACK_TITLE,
    excerpt: stripHtml(item.excerpt),
    categoryId,
    categoryName: categoryName(categoryId, categories),
    categoryColor: categoryColor(categoryId, categories),
    author,
    posters,
    postsCount: Number(item.posts_count) || 0,
    replyCount: Number(item.reply_count) || 0,
    views: Number(item.views) || 0,
    likeCount: Number(item.like_count) || 0,
    tags: tagsOf(item.tags),
    pinned: Boolean(item.pinned || item.pinned_globally),
    pinnedGlobally: Boolean(item.pinned_globally),
    closed: Boolean(item.closed),
    archived: Boolean(item.archived),
    hasAcceptedAnswer: Boolean(item.has_accepted_answer),
    createdAt: item.created_at ?? null,
    lastPostedAt: item.last_posted_at ?? item.created_at ?? null,
    bumpedAt: item.bumped_at ?? item.last_posted_at ?? item.created_at ?? null,
    imageUrl: item.image_url || null,
  };
}

/* =============================================
   ====== 归一化：主题详情与楼层 ======
   ============================================= */

export function normalizePost(raw: RawPost, topicId: number): TopicPost | null {
  const id = Number(raw?.id);
  if (!Number.isFinite(id) || id <= 0) return null;
  return {
    id,
    username: (raw.username || '').trim() || FALLBACK_USER,
    name: (raw.name || raw.display_username || raw.username || '').trim() || FALLBACK_USER,
    avatar: avatarUrl(raw.avatar_template),
    createdAt: raw.created_at ?? null,
    cooked: raw.cooked || '',
    postNumber: Number(raw.post_number) || 0,
    replyToPostNumber: Number.isFinite(Number(raw.reply_to_post_number)) && raw.reply_to_post_number !== null
      ? Number(raw.reply_to_post_number)
      : null,
    likeCount: Number(raw.reaction_users_count ?? raw.like_count) || 0,
    reads: Number(raw.reads ?? raw.readers_count) || 0,
    userTitle: (raw.user_title || '').trim(),
    staff: Boolean(raw.staff),
    moderator: Boolean(raw.moderator),
    admin: Boolean(raw.admin),
    acceptedAnswer: Boolean(raw.accepted_answer),
    deleted: Boolean(raw.deleted_at),
    topicId,
  };
}

export function normalizePosts(raw: RawPostStream | null | undefined, topicId: number): {
  posts: TopicPost[];
  streamIds: number[];
} {
  const posts = (raw?.posts ?? [])
    .map((p) => normalizePost(p as RawPost, topicId))
    .filter((p): p is TopicPost => p !== null);
  const streamIds = (raw?.stream ?? [])
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x) && x > 0);
  return { posts, streamIds };
}

export function normalizeTopic(
  raw: RawTopic | null | undefined,
  categories: CategoryNode[] = [],
): TopicDetail | null {
  const id = Number(raw?.id);
  if (!Number.isFinite(id) || id <= 0) return null;
  const categoryId = Number.isFinite(Number(raw?.category_id)) ? Number(raw?.category_id) : null;
  const normalized = normalizePosts(raw?.post_stream, id);
  return {
    id,
    title: decodeShortcodes((raw?.fancy_title || raw?.title || '').trim()) || FALLBACK_TITLE,
    categoryId,
    categoryName: categoryName(categoryId, categories),
    categoryColor: categoryColor(categoryId, categories),
    postsCount: Number(raw?.posts_count) || normalized.posts.length,
    replyCount: Number(raw?.reply_count) || 0,
    views: Number(raw?.views) || 0,
    likeCount: Number(raw?.like_count) || 0,
    createdAt: raw?.created_at ?? null,
    lastPostedAt: raw?.last_posted_at ?? null,
    pinned: Boolean(raw?.pinned),
    closed: Boolean(raw?.closed),
    archived: Boolean(raw?.archived),
    hasAcceptedAnswer: Boolean(raw?.has_accepted_answer),
    imageUrl: raw?.image_url || null,
    tags: tagsOf(raw?.tags),
    posts: normalized.posts,
    streamIds: normalized.streamIds,
  };
}

export function mergePosts(current: TopicPost[], incoming: TopicPost[]): TopicPost[] {
  const map = new Map<number, TopicPost>();
  for (const post of current) map.set(post.id, post);
  for (const post of incoming) map.set(post.id, post);
  return [...map.values()].sort((a, b) => a.postNumber - b.postNumber);
}

/** 已经加载过的楼层从 stream 里剔掉，剩下的才是「还能加载」的 */
export function remainingStreamIds(streamIds: number[], loaded: TopicPost[]): number[] {
  const loadedIds = new Set(loaded.map((p) => p.id));
  return streamIds.filter((id) => !loadedIds.has(id));
}

export function nextPostBatch(streamIds: number[], size = 20): number[] {
  return streamIds.slice(0, Math.max(1, size));
}

/* =============================================
   ====== 归一化：用户资料 ======
   ============================================= */

export function normalizeUserProfile(
  raw: RawUser | null | undefined,
  summary: RawUserSummary | null | undefined,
): UserProfile | null {
  const user = raw?.user;
  const username = (user?.username || '').trim();
  if (!username) return null;

  const stats = summary?.user_summary;
  const badges = (raw?.badges ?? [])
    .map((b) => ({
      id: Number(b?.id) || 0,
      name: (b?.name || '').trim(),
      description: stripHtml(b?.description, 120),
      icon: b?.icon || null,
    }))
    .filter((b) => b.id > 0 && b.name);

  const recentTopics = (summary?.topics ?? [])
    .map((t) => ({
      id: Number(t?.id) || 0,
      title: decodeShortcodes((t?.fancy_title || t?.title || '').trim()) || FALLBACK_TITLE,
      likeCount: Number(t?.like_count) || 0,
      postsCount: Number(t?.posts_count) || 0,
      createdAt: t?.created_at ?? null,
    }))
    .filter((t) => t.id > 0);

  const topCategories = (stats?.top_categories ?? [])
    .map((c) => ({
      id: Number.isFinite(Number(c?.id)) ? Number(c.id) : null,
      name: (c?.name || '').trim() || '未命名分类',
      color: safeCategoryColor(c?.color),
      topicCount: Number(c?.topic_count) || 0,
    }))
    .filter((c) => c.name);

  const bioHtml = user?.bio_cooked || null;

  return {
    id: Number(user?.id) || 0,
    username,
    name: (user?.name || '').trim() || username,
    avatar: avatarUrl(user?.avatar_template, 180),
    title: (user?.title || user?.flair_name || '').trim(),
    trustLevel: Number(user?.trust_level) || 0,
    admin: Boolean(user?.admin),
    moderator: Boolean(user?.moderator),
    bioHtml,
    bioText: stripHtml(user?.bio_raw || bioHtml, 400),
    location: (user?.location || '').trim(),
    website: (user?.website || '').trim(),
    groupName: (user?.primary_group_name || '').trim(),
    joinedAt: user?.created_at ?? null,
    lastSeenAt: user?.last_seen_at ?? null,
    lastPostedAt: user?.last_posted_at ?? null,
    gamificationScore: Number(user?.gamification_score) || 0,
    profileViews: Number(user?.profile_view_count) || 0,
    acceptedAnswers: Number(user?.accepted_answers) || 0,
    stats: {
      likesGiven: Number(stats?.likes_given) || 0,
      likesReceived: Number(stats?.likes_received) || 0,
      topicsEntered: Number(stats?.topics_entered) || 0,
      postsRead: Number(stats?.posts_read_count) || 0,
      daysVisited: Number(stats?.days_visited) || 0,
      topicCount: Number(stats?.topic_count) || 0,
      postCount: Number(stats?.post_count) || 0,
      solvedCount: Number(stats?.solved_count) || 0,
      readMinutes: Math.round((Number(stats?.time_read) || 0) / 60),
    },
    badges,
    recentTopics,
    topCategories,
  };
}

/* =============================================
   ====== 标签目录（/tags.json） ======
   ============================================= */

function normalizeTag(item: RawTag | null | undefined): TagView | null {
  const id = Number(item?.id);
  /* /tags.json 里个别标签 name 是 slug（如 65-tag），text 才是展示名 */
  const name = ((item?.text || item?.name || '') as string).trim();
  if (!name) return null;
  return {
    id: Number.isFinite(id) && id > 0 ? id : 0,
    name,
    slug: (item?.slug || '').trim(),
    count: Number(item?.count ?? item?.topic_count) || 0,
    description: stripHtml(item?.description, 120),
  };
}

const byTagCountDesc = (a: TagView, b: TagView) => b.count - a.count;

/**
 * `/tags.json` 的真实结构里，顶层 `tags` 与 `extras.tag_groups[].tags` **是两批
 * 互不重叠的标签**（实测顶层 65 个、分组 33 个，id/name 交集为 0）。
 * 所以「所有标签」必须把两批合并，按名称去重，再按主题数排序；
 * 分组保持服务端顺序，组内按主题数倒序。
 */
export function normalizeTags(raw: RawTags | null | undefined): TagCatalog {
  const byName = new Map<string, TagView>();
  const add = (item: RawTag | null | undefined): TagView | null => {
    const tag = normalizeTag(item);
    if (!tag) return null;
    const existing = byName.get(tag.name);
    if (existing) {
      /* 同一标签两处出现时取较大的计数，避免分组里显示 0 */
      if (tag.count > existing.count) {
        byName.set(tag.name, { ...existing, count: tag.count });
      }
      return byName.get(tag.name) ?? null;
    }
    byName.set(tag.name, tag);
    return tag;
  };

  for (const item of raw?.tags ?? []) add(item);

  const groups: TagGroupView[] = [];
  for (const group of raw?.extras?.tag_groups ?? []) {
    const id = Number(group?.id) || 0;
    const name = (group?.name || '').trim() || '未命名分组';
    const tags: TagView[] = [];
    for (const item of group?.tags ?? []) {
      const tag = add(item);
      if (tag) tags.push(tag);
    }
    if (tags.length > 0) groups.push({ id, name, tags: [...tags].sort(byTagCountDesc) });
  }

  const groupedNames = new Set(groups.flatMap((g) => g.tags.map((t) => t.name)));
  const flat = [...byName.values()].sort(byTagCountDesc);
  const ungrouped = flat.filter((t) => !groupedNames.has(t.name));

  return {
    flat,
    groups,
    ungrouped,
    grouped: groups.length > 0,
  };
}

/* =============================================
   ====== 列表分组 / 排序 / 搜索 ======
   ============================================= */

export interface GroupTopicsOptions {
  mode: NavMode;
  categoryId: number | null;
  categories: CategoryNode[];
  query: string;
  following: number[];
  readIds: number[];
  /**
   * 置顶轨道（官方首页的「社区置顶」来自 `featured` 标签，不是响应里的 pinned）。
   * 传空数组表示当前上下文不展示置顶（例如选中标签时）。
   */
  pinnedOverride?: TopicSummary[];
}

export interface TopicGroups {
  pinned: TopicSummary[];
  rest: TopicSummary[];
}

/** 置顶权重：点赞 3、回复 2、浏览 0.15（与原型一致） */
export function hotScore(topic: TopicSummary): number {
  const replies = Math.max(0, topic.postsCount - 1);
  return topic.likeCount * 3 + replies * 2 + topic.views * 0.15;
}

export function matchesQuery(topic: TopicSummary, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    topic.title,
    topic.excerpt,
    topic.author?.name,
    topic.author?.username,
    topic.categoryName,
    ...topic.tags,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(q);
}

/**
 * 置顶帖单独成组：
 *   - 「关注」视图不显示置顶（原型如此，置顶与服务端关注流无关）；
 *   - 其余视图下置顶**始终出现**，但跟随分类与搜索收敛；
 *   - 传 `pinnedOverride` 时以它为准（官方 featured 标签的 4 条）；
 *   - 全局置顶排在分类置顶之前，同组按最后回复倒序。
 */
export function groupTopics(topics: TopicSummary[], opts: GroupTopicsOptions): TopicGroups {
  const scope = categoryScopeIds(opts.categoryId, opts.categories);
  const inCategory = (t: TopicSummary) =>
    scope === null || (t.categoryId !== null && scope.includes(t.categoryId));
  const byBumpDesc = (a: TopicSummary, b: TopicSummary) =>
    (Date.parse(b.bumpedAt || b.lastPostedAt || '') || 0) -
    (Date.parse(a.bumpedAt || a.lastPostedAt || '') || 0);

  const pinnedSource = opts.pinnedOverride ?? topics.filter((t) => t.pinned);
  const pinned =
    opts.mode === 'following'
      ? []
      : pinnedSource
          .filter((t) => inCategory(t) && matchesQuery(t, opts.query))
          .sort((a, b) => Number(b.pinnedGlobally) - Number(a.pinnedGlobally) || byBumpDesc(a, b));

  const readSet = new Set(opts.readIds);
  const followingSet = new Set(opts.following);

  /* 有置顶轨道时，只隐藏轨道里已经出现的主题：像 id=5 这种「全局置顶但不在
     featured」的公告仍应出现在普通列表，否则会凭空少一条。
     没有轨道时保持旧行为：所有 pinned 都不进普通列表。 */
  const hiddenPinned = opts.pinnedOverride
    ? new Set(pinned.map((t) => t.id))
    : new Set(topics.filter((t) => t.pinned).map((t) => t.id));

  let rest = topics.filter(
    (t) => !hiddenPinned.has(t.id) && inCategory(t) && matchesQuery(t, opts.query),
  );
  if (opts.mode === 'unread') rest = rest.filter((t) => !readSet.has(t.id));
  if (opts.mode === 'following') rest = rest.filter((t) => followingSet.has(t.id));

  if (opts.mode === 'hot') rest.sort((a, b) => hotScore(b) - hotScore(a));
  else rest.sort(byBumpDesc);

  return { pinned, rest };
}

/** 可见的完整顺序（置顶在前），j/k 导航和「下一项」都基于它 */
export function flattenGroups(groups: TopicGroups): TopicSummary[] {
  return [...groups.pinned, ...groups.rest];
}

export function moveCursor(
  currentId: number | null,
  ids: number[],
  direction: 'next' | 'prev',
): number | null {
  if (ids.length === 0) return null;
  const index = currentId === null ? -1 : ids.indexOf(currentId);
  if (index < 0) return direction === 'next' ? ids[0] : ids[ids.length - 1];
  const next = index + (direction === 'next' ? 1 : -1);
  const clamped = Math.min(ids.length - 1, Math.max(0, next));
  return ids[clamped];
}

/** 顶栏/侧栏可见数量文案 */
export function topicCountText(count: number): string {
  return `${count} 个主题`;
}

/** 主题列表里「热度」的排序文案 */
export const NAV_LABELS: Record<NavMode, string> = {
  latest: '最新',
  hot: '热门',
  unread: '未读',
  following: '关注',
};

/* =============================================
   ====== 登录态 / 通知 / 私信 ======
   ============================================= */

/** Discourse notification_type → 中文分组名 */
export function notificationTypeLabel(type: number | null | undefined): string {
  switch (type) {
    case 1:
      return '@ 提及';
    case 2:
      return '回复';
    case 3:
      return '引用';
    case 4:
      return '编辑';
    case 5:
      return '点赞';
    case 6:
      return '私信';
    case 7:
      return '邀请';
    case 9:
      return '群组提及';
    case 10:
      return '群组消息';
    case 11:
      return '关注首帖';
    case 12:
      return '主题提醒';
    case 15:
      return '链接';
    case 19:
      return '新帖发布';
    case 24:
      return '成员批准';
    default:
      return '其他通知';
  }
}

/** 通知归一化：标题优先取 topic_title，其次 fancy_title / 私信内容 */
export function normalizeNotifications(raw: RawNotifications | null | undefined): CommunityNotification[] {
  const items = raw?.notifications ?? [];
  return items
    .filter((item) => (item.id ?? 0) > 0)
    .map((item) => {
      const type = item.notification_type ?? 0;
      const title =
        item.data?.topic_title ||
        item.fancy_title ||
        item.data?.message ||
        item.data?.badge_name ||
        item.data?.group_name ||
        '社区通知';
      const excerpt = item.data?.message || item.data?.display_username || '';
      return {
        id: item.id ?? 0,
        type,
        typeLabel: notificationTypeLabel(type),
        read: Boolean(item.read),
        createdAt: item.created_at ?? null,
        topicId: item.topic_id ?? null,
        postNumber: item.post_number ?? null,
        title: decodeShortcodes(title),
        excerpt: stripHtml(excerpt, 60),
        username: item.data?.display_username || item.data?.username || item.data?.original_username || null,
        avatar: avatarUrl(item.acting_user_avatar_template, 48),
      } satisfies CommunityNotification;
    });
}

/** 未读通知条数 */
export function unreadNotificationCount(items: CommunityNotification[]): number {
  return items.filter((item) => !item.read).length;
}

/** 频道归一化：public 在前，direct 在后，去掉无效 id */
export function normalizeChatChannels(raw: RawChatChannels | null | undefined): ChatChannelView[] {
  const pick = (
    list: RawChatChannels['public_channels'],
    kind: 'public' | 'direct',
  ): ChatChannelView[] =>
    (list ?? [])
      .filter((item) => (item.id ?? 0) > 0)
      .map((item) => ({
        id: item.id ?? 0,
        title: decodeShortcodes(item.title || (kind === 'public' ? '未命名频道' : '未命名私信')),
        unreadCount: Math.max(0, item.unread_count ?? 0),
        lastMessage: stripHtml(item.last_message?.message, 90),
        lastMessageAt: item.last_message?.created_at ?? null,
        lastUsername: item.last_message?.username ?? null,
        kind,
      }));

  return [...pick(raw?.public_channels, 'public'), ...pick(raw?.direct_message_channels, 'direct')];
}

/** 消息归一化；html 交给 sanitizeCookedHtml 再渲染 */
export function normalizeChatMessages(raw: RawChatMessages | null | undefined): ChatMessageView[] {
  return (raw?.messages ?? [])
    .filter((item) => (item.id ?? 0) > 0)
    .map((item) => {
      const html = item.cooked || '';
      return {
        id: item.id ?? 0,
        username: item.user?.username || '社区用户',
        name: item.user?.name || item.user?.username || '社区用户',
        avatar: avatarUrl(item.user?.avatar_template, 48),
        createdAt: item.created_at ?? null,
        html,
        text: stripHtml(html || item.message, 200),
        postNumber: item.post_number ?? null,
      } satisfies ChatMessageView;
    })
    .sort((a, b) => {
      const at = a.createdAt ? Date.parse(a.createdAt) : 0;
      const bt = b.createdAt ? Date.parse(b.createdAt) : 0;
      return at - bt;
    });
}
