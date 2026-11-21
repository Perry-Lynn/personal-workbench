/*
 * Trae 社区 · 主题列表 + 置顶卡片轨道
 * ------------------------------------------------------------------
 * 置顶卡片单独一行：scroll-snap 横滑、左右箭头到头置灰、两端渐隐、
 * 鼠标滚轮转横向。上面这些都用原生事件实现（React 的 onWheel 是 passive，
 * preventDefault 不可靠，所以滚轮监听单独挂）。
 * @Author: fu
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Tooltip } from 'antd';
import {
  CheckCircleFilled,
  CommentOutlined,
  EyeOutlined,
  LikeOutlined,
  LeftOutlined,
  LockOutlined,
  PushpinOutlined,
  ReloadOutlined,
  RightOutlined,
  StarFilled,
  StarOutlined,
} from '@ant-design/icons';
import { useCommunityStore } from './store';
import { NAV_LABELS, formatCount, groupTopics, topicCountText } from './format';
import { Avatar, CategoryPill, ListSkeleton, SectionError, TagList, TimeText, useNowTick } from './bits';
import type { TopicSummary } from './types';

export function TopicList() {
  const topics = useCommunityStore((s) => s.topics);
  const categories = useCommunityStore((s) => s.categories);
  const nav = useCommunityStore((s) => s.nav);
  const categoryId = useCommunityStore((s) => s.categoryId);
  const query = useCommunityStore((s) => s.query);
  const readIds = useCommunityStore((s) => s.readIds);
  const following = useCommunityStore((s) => s.following);
  const cursorId = useCommunityStore((s) => s.cursorId);
  const loading = useCommunityStore((s) => s.loading);
  const refreshing = useCommunityStore((s) => s.refreshing);
  const loaded = useCommunityStore((s) => s.loaded);
  const error = useCommunityStore((s) => s.error);
  const setCursor = useCommunityStore((s) => s.setCursor);
  const openTopic = useCommunityStore((s) => s.openTopic);
  const refresh = useCommunityStore((s) => s.refresh);
  const now = useNowTick();

  /* 分类走服务端 category={id}；标签是独立的第二组筛选（服务端 /tag/{name}.json） */
  const categoryTopics = useCommunityStore((s) => s.categoryTopics);
  const categoryLoading = useCommunityStore((s) => s.categoryLoading);
  const categoryLoaded = useCommunityStore((s) => s.categoryLoaded);
  const categoryError = useCommunityStore((s) => s.categoryError);
  const categoryMoreUrl = useCommunityStore((s) => s.categoryMoreUrl);
  const categoryLoadingMore = useCommunityStore((s) => s.categoryLoadingMore);
  const categoryMoreError = useCommunityStore((s) => s.categoryMoreError);
  const setCategory = useCommunityStore((s) => s.setCategory);
  const loadMoreCategory = useCommunityStore((s) => s.loadMoreCategory);

  const tag = useCommunityStore((s) => s.tag);
  const tagTopics = useCommunityStore((s) => s.tagTopics);
  const tagLoading = useCommunityStore((s) => s.tagLoading);
  const tagLoaded = useCommunityStore((s) => s.tagLoaded);
  const tagError = useCommunityStore((s) => s.tagError);
  const tagMoreUrl = useCommunityStore((s) => s.tagMoreUrl);
  const tagLoadingMore = useCommunityStore((s) => s.tagLoadingMore);
  const tagMoreError = useCommunityStore((s) => s.tagMoreError);

  /* 分页状态：moreTopicsUrl 为 null 才是真的到底；失败时保留它，只报错重试 */
  const moreTopicsUrl = useCommunityStore((s) => s.moreTopicsUrl);
  const listLoadingMore = useCommunityStore((s) => s.listLoadingMore);
  const listMoreError = useCommunityStore((s) => s.listMoreError);
  const featured = useCommunityStore((s) => s.featured);
  /* synced=false 时（只有本地缓存）分页信息还未知，不能显示「已到底」 */
  const synced = useCommunityStore((s) => s.synced);
  const loadMoreList = useCommunityStore((s) => s.loadMoreList);
  const loadMoreTag = useCommunityStore((s) => s.loadMoreTag);
  const setTag = useCommunityStore((s) => s.setTag);

  /* 分类优先于标签（两者互斥，选其一时另一组会被清空） */
  const source = categoryId !== null ? categoryTopics : tag ? tagTopics : topics;
  const scoped = categoryId !== null || Boolean(tag);
  const groups = useMemo(
    () => groupTopics(source, {
      mode: nav,
      categoryId,
      categories,
      query,
      following,
      readIds,
      /* featured 是官方「社区置顶」的真实来源（4 条）；只在「全部」列表展示，
         分类/标签是服务端过滤后的另一份数据，不能混进全局置顶。
         还没同步完先不展示，避免先用本地缓存里的 2 条 pinned 冒充置顶。 */
      pinnedOverride: scoped ? [] : featured.length > 0 ? featured : synced ? undefined : [],
    }),
    [source, featured, scoped, synced, nav, categoryId, categories, query, following, readIds],
  );

  const activeCategory = categoryId === null
    ? null
    : categories.find((c) => c.id === categoryId) ?? null;

  const hasMore = Boolean(
    categoryId !== null ? categoryMoreUrl : tag ? tagMoreUrl : moreTopicsUrl,
  );
  const moreLoading = categoryId !== null
    ? categoryLoadingMore
    : tag
      ? tagLoadingMore
      : listLoadingMore;
  const moreFailure = categoryId !== null
    ? categoryMoreError
    : tag
      ? tagMoreError
      : listMoreError;
  const loadMore = categoryId !== null ? loadMoreCategory : tag ? loadMoreTag : loadMoreList;
  const listReady = categoryId !== null ? categoryLoaded : tag ? tagLoaded : loaded;
  const sentinelRef = useRef<HTMLDivElement>(null);

  /* 无限滚动：哨兵进入视区就取下一页。搜索时改为手动按钮，
     否则短短一屏会被自动翻过几十页。失败后不自动重试，交给用户点「重试」。 */
  useEffect(() => {
    if (!hasMore || moreLoading || moreFailure) return;
    const node = sentinelRef.current;
    if (!node) return;
    const root = node.closest('.cm-body');
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        if (query) return;
        void loadMore();
      },
      { root, rootMargin: '320px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, moreLoading, moreFailure, loadMore, query, tag, categoryId]);

  if (categoryLoading && !categoryLoaded && categoryTopics.length === 0) {
    return (
      <div className="cm-list">
        <div className="cm-list-head">
          <h2>正在加载分类「{activeCategory?.name ?? categoryId}」</h2>
          <span className="cm-list-count">按分类筛选</span>
        </div>
        <ListSkeleton rows={5} />
      </div>
    );
  }

  if (categoryError && categoryTopics.length === 0) {
    return (
      <div className="cm-list">
        <SectionError
          message={categoryError}
          onRetry={() => void setCategory(categoryId)}
        />
      </div>
    );
  }

  if (tagLoading && !tagLoaded && tagTopics.length === 0) {
    return (
      <div className="cm-list">
        <div className="cm-list-head">
          <h2>正在加载标签 #{tag}</h2>
          <span className="cm-list-count">按标签筛选</span>
        </div>
        <ListSkeleton rows={5} />
      </div>
    );
  }

  if (loading && !loaded && !tag && categoryId === null) {
    return (
      <div className="cm-list">
        <div className="cm-list-head">
          <h2>正在连接社区</h2>
          <span className="cm-list-count">首次加载会稍慢一点</span>
        </div>
        <ListSkeleton rows={7} />
      </div>
    );
  }

  if (tagError && tagTopics.length === 0) {
    return (
      <div className="cm-list">
        <SectionError message={tagError} onRetry={() => void setTag(tag)} />
      </div>
    );
  }

  if (error && topics.length === 0 && !scoped) {
    return (
      <div className="cm-list">
        <SectionError message={error} onRetry={() => void refresh()} />
      </div>
    );
  }

  const total = groups.pinned.length + groups.rest.length;

  return (
    <div className="cm-list">
      {groups.pinned.length > 0 && (
        <PinnedRail topics={groups.pinned} now={now} cursorId={cursorId} onCursor={setCursor} />
      )}

      <div className="cm-list-head">
        <div className="cm-list-head-left">
          <h2>
            {tag ? `#${tag}` : activeCategory ? activeCategory.name : NAV_LABELS[nav]}
            {query && <span className="cm-search-term">搜索「{query}」</span>}
          </h2>
          <span className="cm-list-count">
            {total > 0 ? `${topicCountText(total)}${hasMore ? ' · 还有更多' : ''}` : '暂无主题'}
            {refreshing && <i className="cm-sync-dot" title="正在同步" />}
          </span>
        </div>
        <Tooltip title="刷新列表">
          <button type="button" className="cm-ghost-btn" onClick={() => void refresh()}>
            <ReloadOutlined /> 刷新
          </button>
        </Tooltip>
      </div>

      {groups.rest.length === 0 ? (
        <EmptyHint nav={nav} query={query} categoryName={activeCategory?.name ?? null} tag={tag} />
      ) : (
        <div className="cm-topic-list">
          {groups.rest.map((topic, index) => {
            const isCursor = topic.id === cursorId;
            const isFollowed = following.includes(topic.id);
            const replies = topic.replyCount || Math.max(0, topic.postsCount - 1);
            return (
              <article
                key={topic.id}
                data-cm-topic
                className={`cm-topic${isCursor ? ' is-active' : ''}`}
                onClick={() => void openTopic(topic.id)}
                onMouseEnter={() => setCursor(topic.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    void openTopic(topic.id);
                  }
                }}
              >
                <span className="cm-topic-index">{String(index + 1).padStart(2, '0')}</span>
                <Avatar
                  user={topic.author}
                  size={38}
                  onClick={
                    topic.author
                      ? () => void useCommunityStore.getState().openProfile(topic.author!.username)
                      : undefined
                  }
                />
                <div className="cm-topic-main">
                  <div className="cm-topic-title-row">
                    <span className="cm-topic-title">
                      {topic.title}
                      {topic.hasAcceptedAnswer && (
                        <Tooltip title="已有采纳回复">
                          <CheckCircleFilled className="cm-title-badge is-answer" />
                        </Tooltip>
                      )}
                      {topic.closed && (
                        <Tooltip title="主题已关闭">
                          <LockOutlined className="cm-title-badge" />
                        </Tooltip>
                      )}
                    </span>
                    <Tooltip title={isFollowed ? '取消关注' : '关注这个主题'}>
                      <button
                        type="button"
                        className={`cm-star${isFollowed ? ' is-on' : ''}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          useCommunityStore.getState().toggleFollow(topic.id);
                        }}
                        onKeyDown={(e) => e.stopPropagation()}
                      >
                        {isFollowed ? <StarFilled /> : <StarOutlined />}
                      </button>
                    </Tooltip>
                  </div>

                  {topic.excerpt && <p className="cm-topic-excerpt">{topic.excerpt}</p>}

                  <div className="cm-topic-meta">
                    <CategoryPill name={topic.categoryName} color={topic.categoryColor} compact />
                    <TagList tags={topic.tags} onSelect={(name) => void setTag(name)} />
                    <span className="cm-meta-item">
                      <CommentOutlined /> {formatCount(replies)}
                    </span>
                    <span className="cm-meta-item">
                      <EyeOutlined /> {formatCount(topic.views)}
                    </span>
                    <span className="cm-meta-item">
                      <LikeOutlined /> {formatCount(topic.likeCount)}
                    </span>
                    <TimeText iso={topic.bumpedAt || topic.lastPostedAt} now={now} />
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {/* 分页脚：三种状态必须区分清楚 —— 还能翻 / 翻失败 / 真的到底 */}
      {hasMore && (
        <>
          <div className="cm-more-sentinel" ref={sentinelRef} aria-hidden />
          <div className="cm-more-bar">
            {moreLoading ? (
              <span className="cm-more-text">正在加载下一页…</span>
            ) : moreFailure ? (
              <span className="cm-more-text is-error">
                加载失败：{moreFailure}
                <button type="button" className="cm-more-btn is-retry" onClick={() => void loadMore()}>
                  重试
                </button>
              </span>
            ) : (
              <button type="button" className="cm-more-btn" onClick={() => void loadMore()}>
                加载更多
              </button>
            )}
          </div>
        </>
      )}

      {!hasMore && listReady && (scoped ? true : synced) && total > 0 && !moreFailure && (
        <div className="cm-list-end">
          已到底 · 共 {formatCount(total)} 个主题（服务端 <code>more_topics_url</code> 为空）
        </div>
      )}
    </div>
  );
}

/* =============================================
   ====== 置顶横向卡片 ======
   ============================================= */

function PinnedRail({
  topics,
  now,
  cursorId,
  onCursor,
}: {
  topics: TopicSummary[];
  now: number;
  cursorId: number | null;
  onCursor: (id: number | null) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [leftEdge, setLeftEdge] = useState(true);
  const [rightEdge, setRightEdge] = useState(false);

  const measure = useCallback(() => {
    const track = trackRef.current;
    if (!track) return;
    setLeftEdge(track.scrollLeft <= 2);
    setRightEdge(track.scrollLeft + track.clientWidth >= track.scrollWidth - 2);
  }, []);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    measure();
    track.addEventListener('scroll', measure, { passive: true });

    /* 滚轮转横向：必须非 passive，否则 preventDefault 会被浏览器忽略 */
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY === 0 || event.shiftKey) return;
      if (track.scrollWidth <= track.clientWidth) return;
      event.preventDefault();
      track.scrollLeft += event.deltaY;
    };
    track.addEventListener('wheel', onWheel, { passive: false });

    const observer = new ResizeObserver(measure);
    observer.observe(track);
    return () => {
      track.removeEventListener('scroll', measure);
      track.removeEventListener('wheel', onWheel);
      observer.disconnect();
    };
  }, [measure, topics.length]);

  const scrollBy = (direction: -1 | 1) => {
    trackRef.current?.scrollBy({ left: direction * 320, behavior: 'smooth' });
  };

  return (
    <div className="cm-pin-zone">
      <div className="cm-pin-head">
        <span className="cm-pin-label">
          <PushpinOutlined /> 社区置顶
        </span>
        <span className="cm-pin-count">{topics.length} 条</span>
        <div className="cm-pin-arrows">
          <button
            type="button"
            className="cm-arrow"
            aria-label="向左"
            disabled={leftEdge}
            onClick={() => scrollBy(-1)}
          >
            <LeftOutlined />
          </button>
          <button
            type="button"
            className="cm-arrow"
            aria-label="向右"
            disabled={rightEdge}
            onClick={() => scrollBy(1)}
          >
            <RightOutlined />
          </button>
        </div>
      </div>

      <div className="cm-pin-track-wrap">
        <div className="cm-pin-track" ref={trackRef}>
          {topics.map((topic) => {
            const followed = useCommunityStore.getState().following.includes(topic.id);
            return (
              <article
                key={topic.id}
                data-cm-topic
                className={`cm-pin-card${topic.id === cursorId ? ' is-active' : ''}`}
                onClick={() => void useCommunityStore.getState().openTopic(topic.id)}
                onMouseEnter={() => onCursor(topic.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    void useCommunityStore.getState().openTopic(topic.id);
                  }
                }}
              >
                <div className="cm-pin-card-top">
                  <CategoryPill name={topic.categoryName} color={topic.categoryColor} compact />
                  <button
                    type="button"
                    className={`cm-star${followed ? ' is-on' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      useCommunityStore.getState().toggleFollow(topic.id);
                    }}
                    onKeyDown={(e) => e.stopPropagation()}
                    aria-label={followed ? '取消关注' : '关注'}
                  >
                    {followed ? <StarFilled /> : <StarOutlined />}
                  </button>
                </div>
                <h3>{topic.title}</h3>
                <p>{topic.excerpt || '点击查看主题内容'}</p>
                <div className="cm-pin-card-foot">
                  <Avatar user={topic.author} size={22} />
                  <span className="cm-pin-author">{topic.author?.name || '社区'}</span>
                  <span className="cm-meta-item">
                    <CommentOutlined /> {formatCount(topic.replyCount || Math.max(0, topic.postsCount - 1))}
                  </span>
                  <TimeText iso={topic.bumpedAt || topic.lastPostedAt} now={now} />
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* =============================================
   ====== 空态 ======
   ============================================= */

function EmptyHint({
  nav,
  query,
  categoryName,
  tag,
}: {
  nav: string;
  query: string;
  categoryName: string | null;
  tag?: string | null;
}) {
  let title = '这里还没有主题';
  let desc = '换个分类看看，或者稍后刷新。';
  if (query) {
    title = `没有找到「${query}」`;
    desc = '试试更短的关键词，或清空搜索回到列表。';
  } else if (tag) {
    title = `标签 #${tag} 下暂时没有主题`;
    desc = '点左上角「清除」可以回到不带标签的全部主题。';
  } else if (nav === 'following') {
    title = '还没有关注主题';
    desc = '主题右侧的星标可以加入「关注」，之后会固定出现在这里。';
  } else if (nav === 'unread') {
    title = '没有未读主题';
    desc = '你点开过的主题会记为已读；新讨论会自动出现在这里。';
  } else if (categoryName) {
    title = `「${categoryName}」下没有主题`;
    desc = '服务端已确认该分类返回 0 个主题；可以切换到「全部」或其它分类。';
  }
  return (
    <div className="cm-empty">
      <div className="cm-empty-art">
        <CommentOutlined />
      </div>
      <h3>{title}</h3>
      <p>{desc}</p>
    </div>
  );
}
