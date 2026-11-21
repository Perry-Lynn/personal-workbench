/*
 * Trae 社区 · 前端状态
 * ------------------------------------------------------------------
 * 数据全部放 store：模块没有 keepAlive，切走会卸载；如果用组件内 state，
 * 「搜到一半 / 点进帖子 / 切去看别的模块再回来」这些状态都会丢。
 *
 * 加载策略：
 *   1. 创建 store 时先读本地缓存，有缓存就**立刻**有内容（冷启动不空屏）；
 *   2. 组件挂载再调 load()：有缓存时是「后台刷新」，没有时才是骨架屏；
 *   3. 后端还有一层 60 秒内存缓存，切来切去不会反复打社区接口。
 * @Author: fu
 */
import { create } from 'zustand';
import * as api from './api';
import { readCache, writeCache } from './cache';
import {
  appendTopics,
  avatarUrl,
  categoryScopeIds,
  mergePosts,
  nextPostBatch,
  normalizeCategories,
  normalizeChatChannels,
  normalizeChatMessages,
  normalizeLatest,
  normalizeNotifications,
  normalizePosts,
  normalizeTags,
  normalizeTopic,
  normalizeUserProfile,
  remainingStreamIds,
  unreadNotificationCount,
} from './format';
import { readPrefs, writePrefs } from './prefs';
import type {
  CategoryNode,
  ChatChannelView,
  ChatMessageView,
  CommunityAuthor,
  CommunityNotification,
  CommunitySession,
  CommunityView,
  LoginGateState,
  NavMode,
  RawSessionState,
  TagCatalog,
  TopicDetail,
  TopicSummary,
  UserProfile,
} from './types';

const SYNC_TTL_MS = 5 * 60_000;

interface CommunityStore {
  /* 列表与分类 */
  topics: TopicSummary[];
  users: Record<number, CommunityAuthor>;
  categories: CategoryNode[];
  nav: NavMode;
  categoryId: number | null;
  query: string;
  cursorId: number | null;

  /* 最新列表分页（page 0 = 首页；moreTopicsUrl 为 null 才是真的到底） */
  latestPage: number;
  moreTopicsUrl: string | null;
  listLoadingMore: boolean;
  listMoreError: string | null;
  canCreateTopic: boolean;

  /* 分类筛选：同样走服务端 category={id}（首页 30 条里没有的分类不会被误判为空） */
  categoryTopics: TopicSummary[];
  categoryLoaded: boolean;
  categoryLoading: boolean;
  categoryError: string | null;
  categoryPage: number;
  categoryMoreUrl: string | null;
  categoryLoadingMore: boolean;
  categoryMoreError: string | null;

  /* 标签筛选（与分类是两组独立条件；标签走服务端过滤） */
  tag: string | null;
  tagTopics: TopicSummary[];
  tagLoaded: boolean;
  tagLoading: boolean;
  tagError: string | null;
  tagPage: number;
  tagMoreUrl: string | null;
  tagLoadingMore: boolean;
  tagMoreError: string | null;

  /* 标签目录 */
  tagCatalog: TagCatalog | null;
  tagsLoading: boolean;
  tagsError: string | null;

  /* 官方首页「社区置顶」= featured 标签的 4 条 */
  featured: TopicSummary[];
  featuredLoading: boolean;
  featuredError: string | null;

  /* 加载状态 */
  loaded: boolean;
  synced: boolean;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  fromCache: boolean;
  savedAt: number | null;
  lastSync: number | null;

  /* 路由 */
  view: CommunityView;

  /* 主题详情 */
  topic: TopicDetail | null;
  topicLoading: boolean;
  topicError: string | null;
  remainingPostIds: number[];
  postsLoading: boolean;
  /* 楼层跳转：先补载到目标楼层，再交给详情组件滚动/高亮 */
  jumpTarget: { postNumber: number; at: number } | null;
  jumpBusy: boolean;
  jumpError: string | null;

  /* 用户资料 */
  profile: UserProfile | null;
  profileLoading: boolean;
  profileError: string | null;
  profileUsername: string | null;

  /* 本地状态（匿名态拿不到服务端已读/关注） */
  readIds: number[];
  following: number[];
  myUsername: string | null;

  /* 登录后才可用的入口 */
  session: CommunitySession;
  loginBusy: boolean;
  loginError: string | null;
  notificationsList: CommunityNotification[];
  notificationsState: LoginGateState;
  notificationsError: string | null;
  chatList: ChatChannelView[];
  chatSource: 'chat' | 'pm' | null;
  chatMessages: ChatMessageView[];
  chatActiveId: number | null;
  chatLoading: boolean;
  chatState: LoginGateState;
  chatError: string | null;

  load: (force?: boolean) => Promise<void>;
  refresh: () => Promise<void>;
  setNav: (nav: NavMode) => void;
  setQuery: (query: string) => void;
  setCursor: (id: number | null) => void;
  setCategory: (categoryId: number | null, force?: boolean) => Promise<void>;
  loadMoreCategory: () => Promise<void>;
  setTag: (tag: string | null) => Promise<void>;
  openTags: () => Promise<void>;
  loadTags: (force?: boolean) => Promise<void>;
  loadMoreList: () => Promise<void>;
  loadMoreTag: () => Promise<void>;
  openTopic: (id: number) => Promise<void>;
  loadMorePosts: () => Promise<void>;
  jumpToPost: (postNumber: number) => Promise<void>;
  clearJump: () => void;
  openProfile: (username: string, mine?: boolean) => Promise<void>;
  openMe: () => Promise<void>;
  openMeSetup: () => void;
  bindUsername: (input: string) => Promise<boolean>;
  openLocked: (panel: 'notifications' | 'chat') => void;
  back: () => void;
  toggleFollow: (id: number) => void;
  markRead: (id: number) => void;
  initSession: () => Promise<void>;
  login: () => Promise<void>;
  logout: () => Promise<void>;
  loadNotifications: () => Promise<void>;
  markAllNotificationsRead: () => Promise<void>;
  loadChatChannels: () => Promise<void>;
  openChatChannel: (id: number) => Promise<void>;
  closeChatChannel: () => void;
}

/* 用缓存铺初始状态：分类先归一化，列表才能带出分类名 */
function hydrate(): {
  topics: TopicSummary[];
  users: Record<number, CommunityAuthor>;
  categories: CategoryNode[];
  savedAt: number | null;
} {
  const cached = readCache();
  if (!cached) return { topics: [], users: {}, categories: [], savedAt: null };
  const categories = normalizeCategories(cached.categories);
  const latest = normalizeLatest(cached.latest, categories);
  return { topics: latest.topics, users: latest.users, categories, savedAt: cached.savedAt };
}

const initial = hydrate();
const initialPrefs = readPrefs();

const EMPTY_SESSION: CommunitySession = {
  loggedIn: false,
  username: null,
  name: null,
  avatar: null,
  unreadNotifications: 0,
  unreadPrivateMessages: 0,
  stored: '',
  windowOpen: false,
};

/* IPC 只回登录态元数据，cookie 永远留在 Rust 侧 */
function normalizeSession(raw: RawSessionState | null | undefined): CommunitySession {
  return {
    loggedIn: Boolean(raw?.logged_in),
    username: raw?.username || null,
    name: raw?.name || raw?.username || null,
    avatar: avatarUrl(raw?.avatar_template, 64),
    unreadNotifications: Math.max(0, raw?.unread_notifications ?? 0),
    unreadPrivateMessages: Math.max(0, raw?.unread_private_messages ?? 0),
    stored: raw?.stored || '',
    windowOpen: Boolean(raw?.window_open),
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/* 请求序号：切主题很快时，旧的慢响应不能覆盖新的 */
let topicSeq = 0;
let profileSeq = 0;
let tagSeq = 0;
let categorySeq = 0;

function persistLocal(partial: {
  readIds?: number[];
  following?: number[];
  myUsername?: string | null;
}): void {
  const prefs = readPrefs();
  writePrefs({
    ...prefs,
    ...partial,
    seeded: prefs.seeded,
  });
}

export const useCommunityStore = create<CommunityStore>((set, get) => ({
  topics: initial.topics,
  users: initial.users,
  categories: initial.categories,
  nav: 'latest',
  categoryId: null,
  query: '',
  cursorId: null,

  latestPage: 0,
  moreTopicsUrl: null,
  listLoadingMore: false,
  listMoreError: null,
  canCreateTopic: false,

  categoryTopics: [],
  categoryLoaded: false,
  categoryLoading: false,
  categoryError: null,
  categoryPage: 0,
  categoryMoreUrl: null,
  categoryLoadingMore: false,
  categoryMoreError: null,

  tag: null,
  tagTopics: [],
  tagLoaded: false,
  tagLoading: false,
  tagError: null,
  tagPage: 0,
  tagMoreUrl: null,
  tagLoadingMore: false,
  tagMoreError: null,

  tagCatalog: null,
  tagsLoading: false,
  tagsError: null,

  featured: [],
  featuredLoading: false,
  featuredError: null,

  loaded: initial.topics.length > 0 || initial.categories.length > 0,
  synced: false,
  loading: false,
  refreshing: false,
  error: null,
  fromCache: initial.topics.length > 0,
  savedAt: initial.savedAt,
  lastSync: null,

  view: { kind: 'list' },

  topic: null,
  topicLoading: false,
  topicError: null,
  remainingPostIds: [],
  postsLoading: false,
  jumpTarget: null,
  jumpBusy: false,
  jumpError: null,

  profile: null,
  profileLoading: false,
  profileError: null,
  profileUsername: null,

  readIds: initialPrefs.readIds,
  following: initialPrefs.following,
  myUsername: initialPrefs.myUsername,

  session: EMPTY_SESSION,
  loginBusy: false,
  loginError: null,
  notificationsList: [],
  notificationsState: 'login_required',
  notificationsError: null,
  chatList: [],
  chatSource: null,
  chatMessages: [],
  chatActiveId: null,
  chatLoading: false,
  chatState: 'login_required',
  chatError: null,

  load: async (force = false) => {
    const state = get();
    if (state.loading || state.refreshing) return;
    if (!force && state.synced && state.lastSync && Date.now() - state.lastSync < SYNC_TTL_MS) {
      return;
    }

    const hasData = state.topics.length > 0 || state.categories.length > 0;
    set({ loading: !hasData, refreshing: hasData, error: null });

    set({ featuredLoading: true, featuredError: null });
    const [latestResult, categoriesResult, featuredResult] = await Promise.allSettled([
      api.fetchLatest(force),
      api.fetchCategories(force),
      api.fetchFeatured(force),
    ]);

    const categories =
      categoriesResult.status === 'fulfilled'
        ? normalizeCategories(categoriesResult.value)
        : state.categories;

    const featured =
      featuredResult.status === 'fulfilled'
        ? normalizeLatest(featuredResult.value, categories).topics
        : state.featured;
    const featuredError =
      featuredResult.status === 'rejected'
        ? featuredResult.reason instanceof Error
          ? featuredResult.reason.message
          : String(featuredResult.reason)
        : null;

    if (latestResult.status === 'fulfilled') {
      const normalized = normalizeLatest(latestResult.value, categories);

      /* 第一次成功拉到列表时，把**当时**的主题一次性记为已读：
         否则「未读」视图一进来就是全部主题，等于没有这个视图。
         只有这一次要合并 —— 之后新出现的主题必须保持未读，否则未读视图永远是空的。 */
      const prefs = readPrefs();
      const readIds = prefs.seeded ? state.readIds : mergeReadIds(state.readIds, normalized.topics);
      if (!prefs.seeded) {
        writePrefs({ ...prefs, readIds, seeded: true });
      }

      if (categoriesResult.status === 'fulfilled') {
        writeCache(latestResult.value, categoriesResult.value);
      }

      set({
        topics: normalized.topics,
        users: normalized.users,
        categories,
        featured,
        featuredLoading: false,
        featuredError,
        latestPage: 0,
        moreTopicsUrl: normalized.moreTopicsUrl,
        listLoadingMore: false,
        listMoreError: null,
        canCreateTopic: normalized.canCreateTopic,
        readIds,
        loaded: true,
        synced: true,
        loading: false,
        refreshing: false,
        error: null,
        fromCache: false,
        savedAt: categoriesResult.status === 'fulfilled' ? Date.now() : state.savedAt,
        lastSync: Date.now(),
        cursorId: normalized.topics.some((t) => t.id === state.cursorId) ? state.cursorId : null,
      });
      return;
    }

    /* 列表失败：保留缓存/旧数据，只把失败原因抛给界面 */
    set({
      categories,
      featured,
      featuredLoading: false,
      featuredError,
      loading: false,
      refreshing: false,
      error: latestResult.reason instanceof Error
        ? latestResult.reason.message
        : String(latestResult.reason),
    });
  },

  refresh: async () => {
    await get().load(true);
    const state = get();
    if (state.categoryId !== null) {
      await get().setCategory(state.categoryId, true);
    } else if (state.tag) {
      await get().setTag(state.tag);
    }
  },

  setNav: (nav) => set({ nav, cursorId: null }),
  setQuery: (query) => set({ query, cursorId: null }),
  setCursor: (cursorId) => set({ cursorId }),

  /* 选中分类：走服务端 /latest.json?category={id}，与标签筛选互斥（一次只留一组） */
  setCategory: async (categoryId, force = false) => {
    const seq = ++categorySeq;
    set({
      categoryId,
      tag: null,
      tagTopics: [],
      tagLoaded: false,
      tagError: null,
      categoryTopics: [],
      categoryLoaded: false,
      categoryPage: 0,
      categoryMoreUrl: null,
      categoryMoreError: null,
      cursorId: null,
      view: { kind: 'list' },
    });
    if (categoryId === null) {
      set({ categoryLoading: false, categoryError: null, categoryLoadingMore: false });
      return;
    }
    set({ categoryLoading: true, categoryError: null, categoryLoadingMore: false });
    try {
      const raw = await api.fetchCategoryTopics(categoryId, 0, force);
      if (seq !== categorySeq) return;
      const normalized = normalizeLatest(raw, get().categories);
      set({
        categoryTopics: normalized.topics,
        categoryLoaded: true,
        categoryLoading: false,
        categoryError: null,
        categoryMoreUrl: normalized.moreTopicsUrl,
      });
    } catch (e) {
      if (seq !== categorySeq) return;
      set({
        categoryLoading: false,
        categoryError: e instanceof Error ? e.message : String(e),
      });
    }
  },

  loadMoreCategory: async () => {
    const state = get();
    const categoryId = state.categoryId;
    if (categoryId === null || state.categoryLoadingMore || !state.categoryMoreUrl) return;
    set({ categoryLoadingMore: true, categoryMoreError: null });
    try {
      const raw = await api.fetchCategoryTopics(categoryId, state.categoryPage + 1);
      const normalized = normalizeLatest(raw, get().categories);
      set((s) => ({
        categoryTopics: appendTopics(s.categoryTopics, normalized.topics),
        categoryPage: s.categoryPage + 1,
        categoryMoreUrl: normalized.moreTopicsUrl,
        categoryLoadingMore: false,
        categoryMoreError: null,
      }));
    } catch (e) {
      /* 失败保留 categoryMoreUrl，界面显示「重试」而不是误报到底 */
      set({
        categoryLoadingMore: false,
        categoryMoreError: e instanceof Error ? e.message : String(e),
      });
    }
  },

  /* 选中标签：走服务端 /tag/{name}.json 过滤；传 null 取消筛选 */
  setTag: async (tag) => {
    const name = tag?.trim() || null;
    const seq = ++tagSeq;
    set({
      tag: name,
      categoryId: null,
      categoryTopics: [],
      categoryLoaded: false,
      categoryError: null,
      tagTopics: [],
      tagLoaded: false,
      tagPage: 0,
      tagMoreUrl: null,
      tagMoreError: null,
      cursorId: null,
      view: { kind: 'list' },
    });
    if (!name) {
      set({ tagLoading: false, tagError: null });
      return;
    }
    set({ tagLoading: true, tagError: null, tagLoadingMore: false });
    try {
      const raw = await api.fetchTagTopics(name, 0);
      if (seq !== tagSeq) return;
      const normalized = normalizeLatest(raw, get().categories);
      set({
        tagTopics: normalized.topics,
        tagLoaded: true,
        tagLoading: false,
        tagError: null,
        tagMoreUrl: normalized.moreTopicsUrl,
      });
    } catch (e) {
      if (seq !== tagSeq) return;
      set({
        tagLoading: false,
        tagError: e instanceof Error ? e.message : String(e),
      });
    }
  },

  openTags: async () => {
    set({ view: { kind: 'tags' } });
    await get().loadTags();
  },

  loadTags: async (force = false) => {
    if (get().tagsLoading) return;
    set({ tagsLoading: true, tagsError: null });
    try {
      const raw = await api.fetchTags(force);
      set({
        tagCatalog: normalizeTags(raw),
        tagsLoading: false,
        tagsError: null,
      });
    } catch (e) {
      set({
        tagsLoading: false,
        tagsError: e instanceof Error ? e.message : String(e),
      });
    }
  },

  /* 最新列表：按 more_topics_url 是否存在决定是否还能翻下一页 */
  loadMoreList: async () => {
    const state = get();
    if (state.listLoadingMore || !state.moreTopicsUrl) return;
    set({ listLoadingMore: true, listMoreError: null });
    try {
      const raw = await api.fetchLatest(false, state.latestPage + 1);
      const normalized = normalizeLatest(raw, get().categories);
      set((s) => ({
        topics: appendTopics(s.topics, normalized.topics),
        users: { ...s.users, ...normalized.users },
        latestPage: s.latestPage + 1,
        moreTopicsUrl: normalized.moreTopicsUrl,
        listLoadingMore: false,
        listMoreError: null,
      }));
    } catch (e) {
      /* 失败不能把 moreTopicsUrl 清掉，否则界面会误报「已到底」 */
      set({
        listLoadingMore: false,
        listMoreError: e instanceof Error ? e.message : String(e),
      });
    }
  },

  loadMoreTag: async () => {
    const state = get();
    const tag = state.tag;
    if (!tag || state.tagLoadingMore || !state.tagMoreUrl) return;
    set({ tagLoadingMore: true, tagMoreError: null });
    try {
      const raw = await api.fetchTagTopics(tag, state.tagPage + 1);
      const normalized = normalizeLatest(raw, get().categories);
      set((s) => ({
        tagTopics: appendTopics(s.tagTopics, normalized.topics),
        tagPage: s.tagPage + 1,
        tagMoreUrl: normalized.moreTopicsUrl,
        tagLoadingMore: false,
        tagMoreError: null,
      }));
    } catch (e) {
      set({
        tagLoadingMore: false,
        tagMoreError: e instanceof Error ? e.message : String(e),
      });
    }
  },

  openTopic: async (id) => {
    if (!Number.isFinite(id) || id <= 0) return;
    get().markRead(id);
    const seq = ++topicSeq;
    set({
      view: { kind: 'topic', topicId: id },
      topic: null,
      topicLoading: true,
      topicError: null,
      remainingPostIds: [],
      postsLoading: false,
      jumpTarget: null,
      jumpBusy: false,
      jumpError: null,
    });
    try {
      const raw = await api.fetchTopic(id);
      if (seq !== topicSeq) return;
      const detail = normalizeTopic(raw, get().categories);
      if (!detail) throw new Error('主题数据为空');
      set({
        topic: detail,
        topicLoading: false,
        remainingPostIds: remainingStreamIds(detail.streamIds, detail.posts),
      });
    } catch (e) {
      if (seq !== topicSeq) return;
      set({
        topicLoading: false,
        topicError: e instanceof Error ? e.message : String(e),
      });
    }
  },

  loadMorePosts: async () => {
    const state = get();
    const topic = state.topic;
    if (!topic || state.postsLoading || state.remainingPostIds.length === 0) return;
    const batch = nextPostBatch(state.remainingPostIds, 20);
    set({ postsLoading: true });
    try {
      const raw = await api.fetchTopicPosts(topic.id, batch);
      const incoming = normalizePosts(raw.post_stream, topic.id).posts;
      set((s) => {
        const current = s.topic;
        if (!current || current.id !== topic.id) return { postsLoading: false };
        const posts = mergePosts(current.posts, incoming);
        return {
          topic: { ...current, posts },
          remainingPostIds: remainingStreamIds(current.streamIds, posts),
          postsLoading: false,
        };
      });
    } catch (e) {
      set({ postsLoading: false });
      throw e;
    }
  },

  openProfile: async (username, mine = false) => {
    const name = username.trim();
    if (!name) return;
    const seq = ++profileSeq;
    set({
      view: { kind: 'profile', username: name, mine },
      profile: null,
      profileUsername: name,
      profileLoading: true,
      profileError: null,
    });
    const [userResult, summaryResult] = await Promise.allSettled([
      api.fetchUser(name),
      api.fetchUserSummary(name),
    ]);
    if (seq !== profileSeq) return;
    if (userResult.status === 'rejected') {
      set({
        profileLoading: false,
        profileError: userResult.reason instanceof Error
          ? userResult.reason.message
          : String(userResult.reason),
      });
      return;
    }
    const profile = normalizeUserProfile(
      userResult.value,
      summaryResult.status === 'fulfilled' ? summaryResult.value : null,
    );
    if (!profile) {
      set({ profileLoading: false, profileError: '没有找到这个用户' });
      return;
    }
    set({ profile, profileLoading: false, profileError: null });
  },

  openMe: async () => {
    const session = get().session;
    const name = session.loggedIn ? session.username : get().myUsername;
    if (!name) {
      set({ view: { kind: 'me' }, profile: null, profileError: null });
      return;
    }
    await get().openProfile(name, true);
  },

  openMeSetup: () => set({ view: { kind: 'me' }, profile: null, profileError: null }),

  bindUsername: async (input) => {
    const name = input.trim().replace(/^@/, '');
    if (!name) return false;
    set({ myUsername: name });
    persistLocal({ myUsername: name });
    await get().openProfile(name, true);
    return true;
  },

  openLocked: (panel) => {
    set({ view: { kind: 'locked', panel } });
    if (!get().session.loggedIn) return;
    if (panel === 'notifications') void get().loadNotifications();
    else void get().loadChatChannels();
  },

  back: () => set({
    view: { kind: 'list' },
    topic: null,
    topicError: null,
    jumpTarget: null,
    jumpBusy: false,
    jumpError: null,
  }),

  /* =============================================
     ====== 楼层跳转 ======
     ============================================= */

  /**
   * 跳到某一楼：如果这一楼还没加载（首屏只取 20 楼），先把中间的分批补完，
   * 再通过 jumpTarget 通知详情组件滚动 + 高亮。不会出现「滚到空白」。
   */
  jumpToPost: async (postNumber) => {
    if (!Number.isFinite(postNumber) || postNumber <= 0) return;
    const start = get();
    if (!start.topic) return;
    if (start.topic.posts.some((p) => p.postNumber === postNumber)) {
      set({ jumpTarget: { postNumber, at: Date.now() }, jumpError: null });
      return;
    }
    if (start.jumpBusy) return;
    set({ jumpBusy: true, jumpError: null });
    try {
      for (let i = 0; i < 80; i += 1) {
        const state = get();
        const topic = state.topic;
        if (!topic) throw new Error('主题未加载');
        if (topic.posts.some((p) => p.postNumber === postNumber)) break;
        if (state.remainingPostIds.length === 0) {
          throw new Error(`第 ${postNumber} 楼不在该主题的分页流里`);
        }
        const before = topic.posts.length;
        await get().loadMorePosts();
        /* 本批没带来任何新楼层（接口异常/空响应）时停止，避免死循环 */
        if ((get().topic?.posts.length ?? before) <= before) {
          throw new Error('继续加载楼层失败，请稍后重试');
        }
      }
      const found = get().topic?.posts.some((p) => p.postNumber === postNumber);
      if (!found) throw new Error(`没有找到第 ${postNumber} 楼`);
      set({ jumpBusy: false, jumpTarget: { postNumber, at: Date.now() } });
    } catch (e) {
      set({
        jumpBusy: false,
        jumpError: e instanceof Error ? e.message : String(e),
      });
    }
  },

  clearJump: () => set({ jumpTarget: null, jumpError: null }),

  toggleFollow: (id) => {
    const following = get().following.includes(id)
      ? get().following.filter((x) => x !== id)
      : [...get().following, id];
    set({ following });
    persistLocal({ following });
  },

  markRead: (id) => {
    if (!Number.isFinite(id) || id <= 0) return;
    if (get().readIds.includes(id)) return;
    const readIds = [...get().readIds, id];
    set({ readIds });
    persistLocal({ readIds });
  },

  initSession: async () => {
    try {
      const raw = await api.fetchSession();
      const session = normalizeSession(raw);
      set({ session });
      if (session.loggedIn) void get().loadNotifications();
    } catch {
      /* 读不到登录态不影响匿名浏览 */
    }
  },

  login: async () => {
    if (get().loginBusy) return;
    set({ loginBusy: true, loginError: null });
    try {
      const opened = await api.openLoginWindow();
      set({ session: { ...normalizeSession(opened), windowOpen: true } });

      /* 登录窗口里是 Trae 统一登录，可能要几次跳转、还要等短信验证码；
         每 1.2 秒校验一次 cookie，最多等 10 分钟，窗口关了就停。 */
      for (let i = 0; i < 500; i += 1) {
        await sleep(1200);
        let checked: RawSessionState | null = null;
        try {
          checked = await api.checkLogin();
        } catch {
          continue;
        }
        const session = normalizeSession(checked);
        set({ session });
        if (session.loggedIn) {
          set({ loginBusy: false, loginError: null });
          /* 登录窗口已被后端关闭，这里立刻拉真实通知与私信 */
          await Promise.allSettled([get().loadNotifications(), get().loadChatChannels()]);
          return;
        }
        if (!session.windowOpen) {
          set({ loginBusy: false, loginError: '登录窗口已关闭，未完成登录' });
          return;
        }
      }
      set({ loginBusy: false, loginError: '登录等待超时，关闭窗口后点「登录 Trae 社区」重试' });
    } catch (e) {
      set({ loginBusy: false, loginError: e instanceof Error ? e.message : String(e) });
    }
  },

  logout: async () => {
    try {
      const raw = await api.logout();
      set({
        session: normalizeSession(raw),
        loginError: null,
        notificationsList: [],
        notificationsState: 'login_required',
        notificationsError: null,
        chatList: [],
        chatSource: null,
        chatMessages: [],
        chatActiveId: null,
        chatState: 'login_required',
        chatError: null,
      });
    } catch (e) {
      set({ loginError: e instanceof Error ? e.message : String(e) });
    }
  },

  loadNotifications: async () => {
    if (!get().session.loggedIn) {
      set({ notificationsState: 'login_required' });
      return;
    }
    if (get().notificationsState === 'loading') return;
    set({ notificationsState: 'loading', notificationsError: null });
    try {
      const raw = await api.fetchNotifications(true);
      const list = normalizeNotifications(raw);
      set((state) => ({
        notificationsList: list,
        notificationsState: 'ready',
        session: { ...state.session, unreadNotifications: unreadNotificationCount(list) },
      }));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      set({
        notificationsState: needsLogin(message) ? 'login_required' : 'error',
        notificationsError: message,
      });
    }
  },

  markAllNotificationsRead: async () => {
    if (!get().session.loggedIn) return;
    try {
      await api.markNotificationsRead();
      set((state) => ({
        notificationsList: state.notificationsList.map((item) => ({ ...item, read: true })),
        session: { ...state.session, unreadNotifications: 0 },
      }));
      void get().loadNotifications();
    } catch (e) {
      set({ notificationsError: e instanceof Error ? e.message : String(e) });
    }
  },

  loadChatChannels: async () => {
    if (!get().session.loggedIn) {
      set({ chatState: 'login_required' });
      return;
    }
    if (get().chatState === 'loading') return;
    set({ chatState: 'loading', chatError: null });
    try {
      const raw = await api.fetchChatChannels(true);
      const list = normalizeChatChannels(raw);
      set((state) => ({
        chatList: list,
        chatSource: raw.source === 'pm' ? 'pm' : 'chat',
        chatState: 'ready',
        session: {
          ...state.session,
          unreadPrivateMessages: list.reduce((sum, item) => sum + item.unreadCount, 0),
        },
      }));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      set({
        chatState: needsLogin(message) ? 'login_required' : 'error',
        chatError: message,
      });
    }
  },

  openChatChannel: async (id) => {
    if (!Number.isFinite(id) || id <= 0) return;
    if (get().chatActiveId === id && get().chatMessages.length > 0) return;
    set({ chatActiveId: id, chatMessages: [], chatLoading: true, chatError: null });
    try {
      const raw = await api.fetchChatMessages(id);
      set({ chatMessages: normalizeChatMessages(raw), chatLoading: false });
    } catch (e) {
      set({ chatLoading: false, chatError: e instanceof Error ? e.message : String(e) });
    }
  },

  closeChatChannel: () => set({ chatActiveId: null, chatMessages: [], chatError: null }),
}));

function mergeReadIds(existing: number[], topics: TopicSummary[]): number[] {
  const out = new Set(existing);
  for (const topic of topics) out.add(topic.id);
  return [...out].slice(-5000);
}

function needsLogin(message: string): boolean {
  return /登录|403|需要登录/.test(message);
}

/* =============================================
   ====== 供组件使用的派生选择器 ======
   ============================================= */

/** 当前分类包含的后代 id（父分类筛选要带出子分类） */
export function useCategoryScope(): number[] | null {
  return useCommunityStore((s) => categoryScopeIds(s.categoryId, s.categories));
}
