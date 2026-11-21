/*
 * Trae 社区 · 主题阅读态
 * ------------------------------------------------------------------
 * 正文来自 `cooked`（其他用户可编辑的 HTML），渲染前统一过 sanitizeCookedHtml：
 * 白名单标签 + 白名单属性 + 协议校验，代码块只保留 `class="lang-xx"` 供样式上色。
 * @Author: fu
 */
import { useMemo, useState, useEffect, useRef } from 'react';
import { Button, Tooltip } from 'antd';
import {
  CheckCircleFilled,
  CommentOutlined,
  EyeOutlined,
  LikeOutlined,
  LoadingOutlined,
  LockOutlined,
  StarFilled,
  StarOutlined,
  DownloadOutlined,
} from '@ant-design/icons';
import { useCommunityStore } from './store';
import { formatCount, formatDateTime } from './format';
import { Avatar, CategoryPill, SectionError, TagList, TimeText, useNowTick } from './bits';
import { sanitizeCookedHtml } from './sanitize';
import type { TopicPost } from './types';

export function TopicDetail() {
  const topic = useCommunityStore((s) => s.topic);
  const loading = useCommunityStore((s) => s.topicLoading);
  const error = useCommunityStore((s) => s.topicError);
  const remaining = useCommunityStore((s) => s.remainingPostIds);
  const postsLoading = useCommunityStore((s) => s.postsLoading);
  const following = useCommunityStore((s) => s.following);
  const view = useCommunityStore((s) => s.view);
  const jumpTarget = useCommunityStore((s) => s.jumpTarget);
  const jumpBusy = useCommunityStore((s) => s.jumpBusy);
  const jumpError = useCommunityStore((s) => s.jumpError);
  const clearJump = useCommunityStore((s) => s.clearJump);
  const now = useNowTick();
  const [moreError, setMoreError] = useState<string | null>(null);
  const [activePost, setActivePost] = useState<number | null>(null);
  const highlightTimer = useRef<number | null>(null);

  const topicId = view.kind === 'topic' ? view.topicId : null;
  const safePosts = useMemo(
    () => (topic?.posts ?? []).map((post) => ({ post, html: sanitizeCookedHtml(post.cooked) })),
    [topic?.posts],
  );

  /* 楼层跳转：store 保证目标楼层已经加载完，这里只负责滚动 + 高亮。
     滚动容器是 .cm-body（顶栏在它外面），所以按容器坐标计算；再留 12px
     顶部余量，避免吸顶头部或主题标题把目标楼层贴住。 */
  useEffect(() => {
    if (!jumpTarget) return;
    const n = jumpTarget.postNumber;
    const timer = window.setTimeout(() => {
      const el = document.querySelector<HTMLElement>(`[data-post-number="${n}"]`);
      const container = document.querySelector<HTMLElement>('.cm-body');
      if (!el) return;
      if (container) {
        const top =
          el.getBoundingClientRect().top -
          container.getBoundingClientRect().top +
          container.scrollTop -
          12;
        container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      } else {
        el.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }
      setActivePost(n);
      if (highlightTimer.current) window.clearTimeout(highlightTimer.current);
      highlightTimer.current = window.setTimeout(() => setActivePost(null), 2200);
    }, 60);
    return () => window.clearTimeout(timer);
  }, [jumpTarget]);

  /* 切主题时清掉上一轮的跳转高亮 */
  useEffect(() => {
    setActivePost(null);
    if (highlightTimer.current) window.clearTimeout(highlightTimer.current);
  }, [topic?.id]);

  useEffect(() => () => {
    if (highlightTimer.current) window.clearTimeout(highlightTimer.current);
  }, []);

  if (loading && !topic) {
    return (
      <div className="cm-detail">
        <div className="cm-detail-skeleton">
          <div className="cm-skel-line is-title" />
          <div className="cm-skel-line" style={{ width: '42%' }} />
          <div className="cm-skel-card" />
          <div className="cm-skel-card" />
        </div>
      </div>
    );
  }

  if (error && !topic) {
    return (
      <div className="cm-detail">
        <SectionError
          message={error}
          onRetry={topicId ? () => void useCommunityStore.getState().openTopic(topicId) : undefined}
        />
      </div>
    );
  }

  if (!topic) return null;
  const followed = following.includes(topic.id);
  const replies = topic.replyCount || Math.max(0, topic.postsCount - 1);

  return (
    <div className="cm-detail">
      <header className="cm-detail-head">
        <div className="cm-detail-kicker">
          <CategoryPill name={topic.categoryName} color={topic.categoryColor} />
          {topic.pinned && <span className="cm-kicker-badge">置顶</span>}
          {topic.closed && (
            <span className="cm-kicker-badge is-muted">
              <LockOutlined /> 已关闭
            </span>
          )}
          {topic.archived && <span className="cm-kicker-badge is-muted">已归档</span>}
          <TagList tags={topic.tags} onSelect={(name) => void useCommunityStore.getState().setTag(name)} />
        </div>

        <div className="cm-detail-title-row">
          <h1>{topic.title}</h1>
          <Tooltip title={followed ? '取消关注' : '关注这个主题'}>
            <button
              type="button"
              className={`cm-star cm-star-lg${followed ? ' is-on' : ''}`}
              onClick={() => useCommunityStore.getState().toggleFollow(topic.id)}
            >
              {followed ? <StarFilled /> : <StarOutlined />}
            </button>
          </Tooltip>
        </div>

        <div className="cm-detail-meta">
          {topic.posts[0] && (
            <span className="cm-detail-author">
              <Avatar
                user={{
                  name: topic.posts[0].name,
                  username: topic.posts[0].username,
                  avatar: topic.posts[0].avatar,
                }}
                size={26}
                onClick={() => void useCommunityStore.getState().openProfile(topic.posts[0].username)}
              />
              {topic.posts[0].name}
            </span>
          )}
          <TimeText iso={topic.createdAt} now={now} />
          <span className="cm-meta-item">
            <EyeOutlined /> {formatCount(topic.views)} 浏览
          </span>
          <span className="cm-meta-item">
            <CommentOutlined /> {formatCount(replies)} 回复
          </span>
          <span className="cm-meta-item">
            <LikeOutlined /> {formatCount(topic.likeCount)} 赞
          </span>
        </div>
      </header>

      {jumpError && (
        <div className="cm-jump-note is-error">
          <span>楼层跳转失败：{jumpError}</span>
          <button type="button" onClick={clearJump}>关闭</button>
        </div>
      )}

      <div className="cm-posts">
        {safePosts.map(({ post, html }) => (
          <PostCard
            key={post.id}
            post={post}
            html={html}
            first={post.postNumber === 1}
            now={now}
            active={activePost === post.postNumber}
            jumping={jumpBusy}
            onJump={(n) => void useCommunityStore.getState().jumpToPost(n)}
          />
        ))}
      </div>

      {remaining.length > 0 ? (
        <div className="cm-more">
          {moreError && <span className="cm-more-error">{moreError}</span>}
          <Button
            icon={postsLoading ? <LoadingOutlined /> : <DownloadOutlined />}
            loading={postsLoading}
            onClick={() => {
              setMoreError(null);
              void useCommunityStore
                .getState()
                .loadMorePosts()
                .catch((e: unknown) => setMoreError(e instanceof Error ? e.message : String(e)));
            }}
          >
            加载更多回复（还有 {remaining.length} 楼）
          </Button>
        </div>
      ) : (
        <div className="cm-more is-end">已经到底了 · 共 {topic.posts.length} 楼</div>
      )}
    </div>
  );
}

function PostCard({
  post,
  html,
  first,
  now,
  active,
  jumping,
  onJump,
}: {
  post: TopicPost;
  html: string;
  first: boolean;
  now: number;
  active: boolean;
  jumping: boolean;
  onJump: (postNumber: number) => void;
}) {
  const staffLabel = post.admin ? '管理员' : post.moderator ? '版主' : post.staff ? '官方' : post.userTitle;
  const openProfile = () => void useCommunityStore.getState().openProfile(post.username);

  return (
    <article
      data-post-number={post.postNumber}
      id={`post-${post.postNumber}`}
      className={`cm-post${first ? ' is-first' : ''}${post.acceptedAnswer ? ' is-accepted' : ''}${active ? ' is-target' : ''}`}
    >
      <div className="cm-post-head">
        <Tooltip title={`跳到第 ${post.postNumber} 楼`}>
          <button
            type="button"
            className={`cm-floor cm-floor-btn${active ? ' is-target' : ''}`}
            onClick={() => onJump(post.postNumber)}
          >
            #{post.postNumber}
          </button>
        </Tooltip>
        <Avatar user={{ name: post.name, username: post.username, avatar: post.avatar }} size={first ? 40 : 30} onClick={openProfile} />
        <div className="cm-post-author">
          <button type="button" className="cm-author-name" onClick={openProfile}>
            {post.name}
          </button>
          <div className="cm-post-author-sub">
            <span className="cm-author-handle">@{post.username}</span>
            {staffLabel && <span className={`cm-staff${post.admin || post.moderator || post.staff ? ' is-staff' : ''}`}>{staffLabel}</span>}
            {post.acceptedAnswer && (
              <span className="cm-accepted">
                <CheckCircleFilled /> 已采纳
              </span>
            )}
          </div>
        </div>
        <div className="cm-post-head-right">
          {post.replyToPostNumber !== null && post.replyToPostNumber > 0 && (
            <button
              type="button"
              className="cm-reply-to cm-reply-btn"
              title={`跳到被回复的第 ${post.replyToPostNumber} 楼`}
              disabled={jumping}
              onClick={() => onJump(post.replyToPostNumber as number)}
            >
              回复 #{post.replyToPostNumber}
            </button>
          )}
          <span className="cm-post-time" title={formatDateTime(post.createdAt)}>
            {formatDateTime(post.createdAt)}
          </span>
        </div>
      </div>

      <div
        className="cm-rich"
        /* 已过 sanitizeCookedHtml 白名单清洗，只保留安全标签/属性 */
        dangerouslySetInnerHTML={{ __html: html }}
      />

      {post.deleted && <div className="cm-post-deleted">该楼层已被删除</div>}

      <div className="cm-post-foot">
        {post.likeCount > 0 && (
          <span className="cm-meta-item">
            <LikeOutlined /> {formatCount(post.likeCount)}
          </span>
        )}
        {post.reads > 0 && (
          <span className="cm-meta-item">
            <EyeOutlined /> {formatCount(post.reads)}
          </span>
        )}
        <TimeText iso={post.createdAt} now={now} />
      </div>
    </article>
  );
}
