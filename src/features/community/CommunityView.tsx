/*
 * Trae 社区 · 主视图
 * ------------------------------------------------------------------
 * 两栏布局：左侧分类/导航，右侧内容。
 * 顶栏负责搜索（⌘K）、刷新、我的资料、通知/私信入口（需登录）。
 *
 * 快捷键（与原型一致）：
 *   1-4 最新/热门/未读/关注      Alt+1..9 分类
 *   j / k 上下选择 · Enter 打开    ⌘K 或 / 聚焦搜索
 *   p 我的资料 · n 通知 · c 私信 · r 刷新 · Esc 返回/清空
 *
 * ⌘K 用 capture 阶段拦截：工作台全局命令面板也监听 ⌘K，但社区内更希望
 * 「⌘K = 搜帖子」。离开模块组件即卸载，不会在其他模块里抢这个键。
 * @Author: fu
 */
import { useEffect, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import { Input, Tooltip, Button } from 'antd';
import type { InputRef } from 'antd';
import {
  ArrowLeftOutlined,
  BellOutlined,
  ClockCircleOutlined,
  CommentOutlined,
  FireOutlined,
  LineChartOutlined,
  LockOutlined,
  MessageOutlined,
  ReloadOutlined,
  SearchOutlined,
  StarOutlined,
  TagOutlined,
} from '@ant-design/icons';
import { useCommunityStore } from './store';
import { NAV_LABELS, flattenGroups, formatCacheAge, formatCount, groupTopics, moveCursor } from './format';
import { Avatar } from './bits';
import { TopicList } from './TopicList';
import { TopicDetail } from './TopicDetail';
import { TagPane } from './TagPane';
import { LockedPane, ProfilePane } from './ProfilePane';
import type { NavMode } from './types';
import './community.css';

const NAV_ITEMS: { mode: NavMode; icon: ReactNode; key: string }[] = [
  { mode: 'latest', icon: <ClockCircleOutlined />, key: '1' },
  { mode: 'hot', icon: <FireOutlined />, key: '2' },
  { mode: 'unread', icon: <LineChartOutlined />, key: '3' },
  { mode: 'following', icon: <StarOutlined />, key: '4' },
];

export default function CommunityView() {
  const topics = useCommunityStore((s) => s.topics);
  const categories = useCommunityStore((s) => s.categories);
  const nav = useCommunityStore((s) => s.nav);
  const categoryId = useCommunityStore((s) => s.categoryId);
  const query = useCommunityStore((s) => s.query);
  const readIds = useCommunityStore((s) => s.readIds);
  const following = useCommunityStore((s) => s.following);
  const view = useCommunityStore((s) => s.view);
  const loading = useCommunityStore((s) => s.loading);
  const refreshing = useCommunityStore((s) => s.refreshing);
  const error = useCommunityStore((s) => s.error);
  const fromCache = useCommunityStore((s) => s.fromCache);
  const savedAt = useCommunityStore((s) => s.savedAt);
  const session = useCommunityStore((s) => s.session);
  const loginBusy = useCommunityStore((s) => s.loginBusy);
  const loginError = useCommunityStore((s) => s.loginError);
  const tag = useCommunityStore((s) => s.tag);
  const tagTopics = useCommunityStore((s) => s.tagTopics);
  const tagCatalog = useCommunityStore((s) => s.tagCatalog);
  const load = useCommunityStore((s) => s.load);
  const loadTags = useCommunityStore((s) => s.loadTags);
  const refresh = useCommunityStore((s) => s.refresh);
  const back = useCommunityStore((s) => s.back);
  const setQuery = useCommunityStore((s) => s.setQuery);
  const setNav = useCommunityStore((s) => s.setNav);
  const setCategory = useCommunityStore((s) => s.setCategory);
  const setTag = useCommunityStore((s) => s.setTag);
  const openTags = useCommunityStore((s) => s.openTags);
  const openMe = useCommunityStore((s) => s.openMe);
  const openLocked = useCommunityStore((s) => s.openLocked);
  const initSession = useCommunityStore((s) => s.initSession);
  const login = useCommunityStore((s) => s.login);
  const logout = useCommunityStore((s) => s.logout);

  const searchRef = useRef<InputRef>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  /* 分类/标签都是服务端过滤后的另一份列表（分类优先，二者互斥），计数跟着当前列表走 */
  const categoryTopics = useCommunityStore((s) => s.categoryTopics);
  const categoryMoreUrl = useCommunityStore((s) => s.categoryMoreUrl);
  const tagMoreUrl = useCommunityStore((s) => s.tagMoreUrl);
  const moreTopicsUrl = useCommunityStore((s) => s.moreTopicsUrl);
  const activeTopics = categoryId !== null ? categoryTopics : tag ? tagTopics : topics;
  const activeHasMore = categoryId !== null
    ? Boolean(categoryMoreUrl)
    : tag
      ? Boolean(tagMoreUrl)
      : Boolean(moreTopicsUrl);
  const quickTags = useMemo(() => (tagCatalog?.flat ?? []).slice(0, 12), [tagCatalog]);

  const counts = useMemo(() => {
    const base = { categoryId, categories, query, following, readIds };
    const latest = groupTopics(activeTopics, { ...base, mode: 'latest' }).rest.length;
    const hot = groupTopics(activeTopics, { ...base, mode: 'hot' }).rest.length;
    const unread = groupTopics(activeTopics, { ...base, mode: 'unread' }).rest.length;
    const follow = groupTopics(activeTopics, { ...base, mode: 'following' }).rest.length;
    return { latest, hot, unread, following: follow };
  }, [activeTopics, categories, categoryId, query, following, readIds]);

  const activeCategory = categoryId === null
    ? null
    : categories.find((c) => c.id === categoryId) ?? null;

  const title =
    view.kind === 'list'
      ? tag
        ? `#${tag}`
        : activeCategory?.name ?? NAV_LABELS[nav]
      : view.kind === 'tags'
        ? '所有标签'
        : view.kind === 'topic'
        ? '主题阅读'
        : view.kind === 'profile'
          ? '用户资料'
          : view.kind === 'me'
            ? '我的资料'
            : view.kind === 'locked'
              ? view.panel === 'notifications'
                ? '通知'
                : '私信'
              : '';

  const viewKey = view.kind === 'topic'
    ? `topic:${view.topicId}`
    : view.kind === 'profile'
      ? `profile:${view.username}`
      : view.kind;

  /* 首次进入：有缓存先显示缓存，再后台同步；5 分钟内回来不重复打接口 */
  useEffect(() => {
    void load();
    void loadTags();
    void initSession();
  }, [load, loadTags, initSession]);

  /* 切换阅读对象时把内容区滚回顶部，否则会停在上一篇的底部 */
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
  }, [viewKey]);

  /* 快捷键：全部通过 store.getState() 读当前值，监听器只注册一次 */
  useEffect(() => {
    const focusSearch = () => {
      const input = searchRef.current?.input;
      input?.focus();
      input?.select();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = Boolean(
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable),
      );

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        event.stopPropagation();
        focusSearch();
        return;
      }

      const state = useCommunityStore.getState();

      if (typing) {
        if (event.key === 'Escape' && target?.getAttribute('data-cm-search') === '1') {
          event.preventDefault();
          state.setQuery('');
          target.blur();
        }
        return;
      }

      const active = state.categoryId !== null
        ? state.categoryTopics
        : state.tag
          ? state.tagTopics
          : state.topics;
      const groups = groupTopics(active, {
        mode: state.nav,
        categoryId: state.categoryId,
        categories: state.categories,
        query: state.query,
        following: state.following,
        readIds: state.readIds,
        pinnedOverride: state.categoryId !== null || state.tag ? [] : state.featured,
      });
      const visible = flattenGroups(groups);
      const ids = visible.map((t) => t.id);
      const digits = /^[1-4]$/.test(event.key) ? Number(event.key) : 0;

      /* 用 code 而不是 key：macOS 上 Option+1 产出的 key 是「¡」，
         key 匹配数字会让分类快捷键在 Mac 上全部失效。 */
      if (event.altKey && /^(?:Digit|Numpad)[1-9]$/.test(event.code)) {
        event.preventDefault();
        const index = Number(event.code.slice(-1)) - 1;
        const targetCategory = state.categories[index];
        if (targetCategory) state.setCategory(targetCategory.id);
        return;
      }

      if (digits && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        const mode = NAV_ITEMS[digits - 1]?.mode;
        if (mode) state.setNav(mode);
        return;
      }

      switch (event.key) {
        case 'j':
          if (state.view.kind === 'list') {
            event.preventDefault();
            state.setCursor(moveCursor(state.cursorId, ids, 'next'));
          }
          return;
        case 'k':
          if (state.view.kind === 'list') {
            event.preventDefault();
            state.setCursor(moveCursor(state.cursorId, ids, 'prev'));
          }
          return;
        case 'Enter': {
          /* 焦点已经在主题卡片上时，交给卡片自己的 onKeyDown ——
             否则这里的游标主题和卡片主题会各打开一次。 */
          if (target?.closest('[data-cm-topic]')) return;
          if (state.view.kind === 'list' && state.cursorId) {
            event.preventDefault();
            void state.openTopic(state.cursorId);
          }
          return;
        }
        case 'Escape':
          if (state.view.kind !== 'list') {
            event.preventDefault();
            state.back();
          } else if (state.query) {
            state.setQuery('');
          }
          return;
        case '/':
          event.preventDefault();
          focusSearch();
          return;
        case 'p':
          event.preventDefault();
          void state.openMe();
          return;
        case 'n':
          event.preventDefault();
          state.openLocked('notifications');
          return;
        case 'c':
          event.preventDefault();
          state.openLocked('chat');
          return;
        case 'r':
          event.preventDefault();
          void state.refresh();
          return;
        default:
          return;
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [categories]);

  const unreadCount = counts.unread;
  const countsByMode: Record<NavMode, number> = {
    latest: counts.latest,
    hot: counts.hot,
    unread: counts.unread,
    following: counts.following,
  };

  return (
    <div className="cm-root">
      <aside className="cm-rail">
        <div className="cm-rail-brand">
          <span className="cm-brand-icon">
            <CommentOutlined />
          </span>
          <div>
            <strong>Trae 社区</strong>
            <small>forum.trae.cn</small>
          </div>
          <i className="cm-live" title="公开数据" />
        </div>

        <nav className="cm-nav">
          {NAV_ITEMS.map((item) => (
            <button
              type="button"
              key={item.mode}
              className={`cm-nav-item${nav === item.mode ? ' is-active' : ''}`}
              onClick={() => setNav(item.mode)}
            >
              <span className="cm-nav-icon">{item.icon}</span>
              <span className="cm-nav-label">{NAV_LABELS[item.mode]}</span>
              {/* 当前列表还有下一页时标 N+，避免把首屏 30 当成总量 */}
              <span className="cm-nav-count">
                {formatCount(countsByMode[item.mode])}
                {activeHasMore ? '+' : ''}
              </span>
              <kbd>{item.key}</kbd>
            </button>
          ))}
        </nav>

        <div className="cm-rail-split" />

        <div className="cm-cat-head">
          <span>分类</span>
          <span className="cm-cat-head-hint">Alt+数字</span>
        </div>
        <div className="cm-cat-list">
          <button
            type="button"
            className={`cm-cat-item${categoryId === null ? ' is-active' : ''}`}
            onClick={() => void setCategory(null)}
          >
            <i className="cm-dot is-all" />
            <span className="cm-cat-name">全部主题</span>
            {/* 首页只有 30 条；more_topics_url 非空时用 N+ 表示「不止这些」 */}
            <span className="cm-cat-count">
              {formatCount(topics.length)}
              {moreTopicsUrl ? '+' : ''}
            </span>
          </button>
          {categories.map((category, index) => (
            <button
              type="button"
              key={category.id}
              className={`cm-cat-item${categoryId === category.id ? ' is-active' : ''}`}
              onClick={() => void setCategory(category.id)}
              title={category.description || category.name}
            >
              <i className="cm-dot" style={{ background: category.color }} />
              <span className="cm-cat-name">{category.name}</span>
              <span className="cm-cat-count">{formatCount(category.topicCount)}</span>
              {index < 9 && <kbd>{index + 1}</kbd>}
            </button>
          ))}
        </div>

        <div className="cm-tag-sect">
          <div className="cm-cat-head">
            <span><TagOutlined /> 标签</span>
            <button
              type="button"
              className="cm-tag-all"
              onClick={() => void openTags()}
            >
              所有标签
            </button>
          </div>
          <div className="cm-tag-list">
            {tag && (
              <button
                type="button"
                className="cm-cat-item cm-tag-row is-active"
                onClick={() => void setTag(null)}
                title="清除标签筛选"
              >
                <span className="cm-tag-name">#{tag}</span>
                <span className="cm-tag-count">清除</span>
              </button>
            )}
            {quickTags
              .filter((t) => t.name !== tag)
              .map((item) => (
                <button
                  type="button"
                  key={`${item.id}-${item.name}`}
                  className="cm-cat-item cm-tag-row"
                  onClick={() => void setTag(item.name)}
                  title={item.description || item.name}
                >
                  <span className="cm-tag-name">#{item.name}</span>
                  <span className="cm-tag-count">{formatCount(item.count)}</span>
                </button>
              ))}
            {!tagCatalog && <span className="cm-tag-hint">标签目录加载中…</span>}
          </div>
        </div>

        <div className="cm-rail-foot">
          <div className="cm-sync-state">
            <i className={`cm-sync-light${refreshing ? ' is-syncing' : ''}`} />
            {refreshing ? '正在同步' : fromCache ? formatCacheAge(savedAt) : '已同步'}
          </div>
          <div className="cm-shortcuts">
            <span><kbd>⌘K</kbd> 搜索</span>
            <span><kbd>j</kbd><kbd>k</kbd> 选择</span>
            <span><kbd>Enter</kbd> 打开</span>
          </div>
        </div>
      </aside>

      <section className="cm-main">
        <header className="cm-topbar">
          <div className="cm-topbar-title">
            {view.kind !== 'list' && (
              <button type="button" className="cm-back" onClick={() => back()} title="返回列表（Esc）">
                <ArrowLeftOutlined />
              </button>
            )}
            <div>
              <h1>{title}</h1>
              <div className="cm-topbar-sub">
                {view.kind === 'list'
                  ? tag
                    ? `标签筛选 #${tag} · ${formatCount(activeTopics.length)} 个主题${tagMoreUrl ? '（还有更多）' : ''}`
                    : categoryId !== null
                      ? `分类筛选 · ${formatCount(activeTopics.length)} 个主题${categoryMoreUrl ? '（还有更多）' : ''}`
                      : `${formatCount(activeTopics.length)} 个主题${moreTopicsUrl ? '（还有更多）' : ''} · 匿名可读`
                  : view.kind === 'tags'
                    ? '全部标签与主题数 · 数据来自 /tags.json'
                    : view.kind === 'topic'
                      ? '正文与楼层'
                      : view.kind === 'profile'
                        ? `@${view.username}`
                        : view.kind === 'me'
                          ? '本地绑定用户名，未登录'
                          : session.loggedIn
                            ? `已登录 · @${session.username}`
                            : '需要登录'}
              </div>
            </div>
          </div>

          <div className="cm-topbar-actions">
            <Input
              ref={searchRef}
              className="cm-search"
              allowClear
              prefix={<SearchOutlined />}
              placeholder="搜索标题、标签（⌘K）"
              value={query}
              data-cm-search="1"
              onChange={(e) => {
                setQuery(e.target.value);
                if (view.kind !== 'list') back();
              }}
              onPressEnter={() => {
                if (view.kind !== 'list') back();
                searchRef.current?.input?.blur();
              }}
              onKeyDown={(e) => {
                /* 只处理 Esc；其余快捷键交给全局监听器（typing 时会跳过） */
                if (e.key === 'Escape') {
                  e.stopPropagation();
                }
                if (e.key === 'Escape' && !query) searchRef.current?.input?.blur();
              }}
            />

            <Tooltip title="刷新（r）">
              <button type="button" className="cm-icon-btn" onClick={() => void refresh()} disabled={loading}>
                <ReloadOutlined spin={refreshing} />
              </button>
            </Tooltip>

            {session.loggedIn ? (
              <>
                <Tooltip title="我的资料（p）">
                  <button type="button" className="cm-user-chip" onClick={() => void openMe()}>
                    <Avatar
                      user={{
                        username: session.username ?? '',
                        name: session.name || session.username || '我',
                        avatar: session.avatar ?? '',
                      }}
                      size={26}
                    />
                    <span>{session.name || session.username}</span>
                  </button>
                </Tooltip>
                <button type="button" className="cm-link-btn" onClick={() => void logout()}>
                  退出登录
                </button>
              </>
            ) : (
              <Button
                type="primary"
                size="small"
                className="cm-login-btn"
                loading={loginBusy}
                onClick={() => void login()}
              >
                {loginBusy ? '登录中…' : '登录 Trae 社区'}
              </Button>
            )}

            <Tooltip title={session.loggedIn ? '通知' : '通知 · 需要登录（n）'}>
              <button type="button" className="cm-icon-btn" onClick={() => openLocked('notifications')}>
                <BellOutlined />
                {session.unreadNotifications > 0 ? (
                  <span className="cm-badge">{session.unreadNotifications > 99 ? '99+' : session.unreadNotifications}</span>
                ) : (
                  <i className={`cm-lock-dot${session.loggedIn ? ' is-ready' : ''}`} />
                )}
              </button>
            </Tooltip>
            <Tooltip title={session.loggedIn ? '私信' : '私信 · 需要登录（c）'}>
              <button type="button" className="cm-icon-btn" onClick={() => openLocked('chat')}>
                <MessageOutlined />
                {session.unreadPrivateMessages > 0 ? (
                  <span className="cm-badge">{session.unreadPrivateMessages > 99 ? '99+' : session.unreadPrivateMessages}</span>
                ) : (
                  <i className={`cm-lock-dot${session.loggedIn ? ' is-ready' : ''}`} />
                )}
              </button>
            </Tooltip>
          </div>
        </header>

        {loginError && view.kind !== 'locked' && (
          <div className="cm-banner is-error">
            <span>登录未完成：{loginError}</span>
            <button type="button" onClick={() => void login()}>重试</button>
          </div>
        )}

        {error && topics.length > 0 && (
          <div className="cm-banner is-error">
            <span>同步失败：{error}</span>
            <button type="button" onClick={() => void refresh()}>重试</button>
          </div>
        )}

        {!error && fromCache && (
          <div className="cm-banner">
            <span>
              <LockOutlined /> 正在显示本地缓存 · {formatCacheAge(savedAt)}
            </span>
            <button type="button" onClick={() => void refresh()}>立即同步</button>
          </div>
        )}

        <div className="cm-body" ref={bodyRef}>
          {view.kind === 'list' && <TopicList />}
          {view.kind === 'tags' && <TagPane />}
          {view.kind === 'topic' && <TopicDetail />}
          {(view.kind === 'profile' || view.kind === 'me') && <ProfilePane />}
          {view.kind === 'locked' && <LockedPane panel={view.panel} />}
        </div>

        {unreadCount > 0 && view.kind === 'list' && (
          <div className="cm-floating-hint">
            {unreadCount} 个未读主题 · 按 <kbd>3</kbd> 查看
          </div>
        )}
      </section>
    </div>
  );
}


