/*
 * Trae 社区 · 小部件
 * ------------------------------------------------------------------
 * 头像、分类点、标签、时间、错误/空态这些在列表、详情、资料页反复出现，
 * 集中在这里，避免三份样式三种间距。
 * @Author: fu
 */
import { useEffect, useState } from 'react';
import { Alert, Button, Skeleton } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import type { CommunityAuthor, CategoryNode } from './types';
import { formatRelativeTime } from './format';

/** 头像：加载失败自动回落成首字母色块，不留破图 */
export function Avatar({
  user,
  size = 40,
  onClick,
}: {
  user: Pick<CommunityAuthor, 'name' | 'username' | 'avatar'> | null;
  size?: number;
  onClick?: () => void;
}) {
  const [broken, setBroken] = useState(false);
  const name = user?.name || user?.username || '?';
  const initial = name.trim().slice(0, 1).toUpperCase() || '?';
  const hue = hueOf(user?.username || name);

  const style = {
    width: size,
    height: size,
    borderRadius: size >= 64 ? 18 : 999,
    fontSize: Math.max(12, Math.round(size / 2.6)),
  } as const;

  const content =
    user?.avatar && !broken ? (
      <img src={user.avatar} alt={name} style={style} onError={() => setBroken(true)} loading="lazy" />
    ) : (
      <span className="cm-avatar-fallback" style={{ ...style, background: `hsl(${hue} 34% 46%)` }}>
        {initial}
      </span>
    );

  if (!onClick) return <span className="cm-avatar">{content}</span>;
  return (
    <button
      type="button"
      className="cm-avatar cm-avatar-btn"
      title={name}
      /* 头像嵌在主题卡片里：点/回车只该开用户资料，不能顺带把主题也打开 */
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {content}
    </button>
  );
}

function hueOf(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) % 360;
  return hash;
}

/** 分类小胶囊：色点 + 名称 */
export function CategoryPill({
  name,
  color,
  compact = false,
}: {
  name: string;
  color: string;
  compact?: boolean;
}) {
  return (
    <span className={`cm-cat-pill${compact ? ' is-compact' : ''}`}>
      <i className="cm-dot" style={{ background: color }} />
      {name}
    </span>
  );
}

export function TagList({
  tags,
  onSelect,
}: {
  tags: string[];
  /** 点标签 → 按该标签筛选；传了才会渲染成按钮 */
  onSelect?: (tag: string) => void;
}) {
  if (!tags.length) return null;
  return (
    <span className="cm-tags">
      {tags.slice(0, 3).map((tag) =>
        onSelect ? (
          <button
            type="button"
            className="cm-tag cm-tag-btn"
            key={tag}
            title={`按标签 #${tag} 筛选`}
            onClick={(e) => {
              e.stopPropagation();
              onSelect(tag);
            }}
            onKeyDown={(e) => e.stopPropagation()}
          >
            {tag}
          </button>
        ) : (
          <span className="cm-tag" key={tag}>
            {tag}
          </span>
        ),
      )}
    </span>
  );
}

export function TimeText({ iso, now }: { iso: string | null; now: number }) {
  return (
    <span className="cm-time" title={iso || undefined}>
      {formatRelativeTime(iso, now)}
    </span>
  );
}

export function SectionError({
  message,
  onRetry,
  compact = false,
}: {
  message: string;
  onRetry?: () => void;
  compact?: boolean;
}) {
  return (
    <div className={`cm-error${compact ? ' is-compact' : ''}`}>
      <Alert
        type="error"
        showIcon
        message="加载失败"
        description={message}
        action={
          onRetry ? (
            <Button size="small" icon={<ReloadOutlined />} onClick={onRetry}>
              重试
            </Button>
          ) : undefined
        }
      />
    </div>
  );
}

export function ListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="cm-skeleton" aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <div className="cm-skeleton-row" key={i}>
          <Skeleton.Avatar active size={40} shape="circle" />
          <div className="cm-skeleton-main">
            <Skeleton.Input active size="small" style={{ width: `${58 + ((i * 13) % 30)}%` }} />
            <Skeleton.Input active size="small" style={{ width: `${34 + ((i * 7) % 20)}%`, height: 12 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** 60 秒刷新一次相对时间，避免「3 分钟前」永远停在 3 分钟 */
export function useNowTick(interval = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), interval);
    return () => window.clearInterval(timer);
  }, [interval]);
  return now;
}

export function CategoryListEmpty({ category }: { category: CategoryNode | null }) {
  return (
    <div className="cm-empty-note">
      {category ? `「${category.name}」下还没有可展示的主题` : '社区暂时没有可展示的主题'}
    </div>
  );
}
