/*
 * Trae 社区 · 用户资料 / 我的资料
 * ------------------------------------------------------------------
 * 「我的资料」不等于登录：这一版让用户在本机绑定一个社区用户名，
 * 然后读它的**公开**主页（/u/{name}.json + /summary.json）。
 * 通知、私信仍然需要真正的登录，见 LockedPane。
 *
 * 头像、简介里的 HTML 同样走 sanitizeCookedHtml。
 * @Author: fu
 */
import { useMemo, useState } from 'react';
import { Button, Input, Tag, Tooltip } from 'antd';
import {
  ArrowLeftOutlined,
  BellOutlined,
  CalendarOutlined,
  CheckCircleOutlined,
  EnvironmentOutlined,
  EyeOutlined,
  FireOutlined,
  LinkOutlined,
  LoadingOutlined,
  LockOutlined,
  LoginOutlined,
  MessageOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  SwapOutlined,
  TeamOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useCommunityStore } from './store';
import { formatCount, formatDateTime, formatReadTime, parseUsernameInput } from './format';
import { Avatar, SectionError, TimeText, useNowTick } from './bits';
import { sanitizeCookedHtml } from './sanitize';
import type { CommunityNotification, UserProfile } from './types';

export function ProfilePane() {
  const view = useCommunityStore((s) => s.view);
  const profile = useCommunityStore((s) => s.profile);
  const loading = useCommunityStore((s) => s.profileLoading);
  const error = useCommunityStore((s) => s.profileError);
  const mine = view.kind === 'profile' ? view.mine : false;
  const myUsername = useCommunityStore((s) => s.myUsername);
  const loggedIn = useCommunityStore((s) => s.session.loggedIn);
  const now = useNowTick();

  if (view.kind === 'me') return <MeBindPane />;

  if (loading && !profile) {
    return (
      <div className="cm-profile">
        <div className="cm-profile-skeleton">
          <div className="cm-profile-skel-head">
            <div className="cm-skel-avatar" />
            <div>
              <div className="cm-skel-line" style={{ width: 180 }} />
              <div className="cm-skel-line" style={{ width: 120 }} />
            </div>
          </div>
          <div className="cm-skel-card" />
        </div>
      </div>
    );
  }

  if (error && !profile) {
    return (
      <div className="cm-profile">
        <SectionError
          message={error}
          onRetry={() => {
            const name = useCommunityStore.getState().profileUsername;
            if (name) void useCommunityStore.getState().openProfile(name, mine);
          }}
        />
      </div>
    );
  }

  if (!profile) return null;

  return (
    <ProfileBody
      profile={profile}
      mine={mine}
      myUsername={myUsername}
      loggedIn={loggedIn}
      now={now}
    />
  );
}

function ProfileBody({
  profile,
  mine,
  myUsername,
  loggedIn,
  now,
}: {
  profile: UserProfile;
  mine: boolean;
  myUsername: string | null;
  loggedIn: boolean;
  now: number;
}) {
  const safeBio = useMemo(() => sanitizeCookedHtml(profile.bioHtml), [profile.bioHtml]);
  const stats = profile.stats;

  const statItems = [
    { label: '发帖', value: formatCount(stats.postCount), icon: <MessageOutlined /> },
    { label: '主题', value: formatCount(stats.topicCount), icon: <UserOutlined /> },
    { label: '获赞', value: formatCount(stats.likesReceived), icon: <FireOutlined /> },
    { label: '送出赞', value: formatCount(stats.likesGiven), icon: <FireOutlined /> },
    { label: '已读', value: formatCount(stats.postsRead), icon: <EyeOutlined /> },
    { label: '访问天数', value: String(stats.daysVisited), icon: <CalendarOutlined /> },
    { label: '采纳回答', value: formatCount(stats.solvedCount), icon: <CheckCircleOutlined /> },
    { label: '阅读时长', value: formatReadTime(stats.readMinutes * 60), icon: <TeamOutlined /> },
  ];

  return (
    <div className="cm-profile">
      {mine && !loggedIn && (
        <div className="cm-mine-banner">
          <LockOutlined />
          <span>
            这是本机绑定的用户名 <b>{myUsername || profile.username}</b>，当前<strong>未登录</strong>，只读取社区公开资料。
            通知与私信需要登录后才能使用。
          </span>
          <Button
            type="primary"
            size="small"
            icon={<LoginOutlined />}
            onClick={() => void useCommunityStore.getState().login()}
          >
            去登录
          </Button>
          <Button
            size="small"
            icon={<SwapOutlined />}
            onClick={() => useCommunityStore.getState().openMeSetup()}
          >
            切换
          </Button>
        </div>
      )}

      <header className="cm-profile-head">
        <Avatar user={{ name: profile.name, username: profile.username, avatar: profile.avatar }} size={76} />
        <div className="cm-profile-id">
          <div className="cm-profile-name-row">
            <h1>{profile.name}</h1>
            {profile.admin && <Tag color="volcano">管理员</Tag>}
            {profile.moderator && <Tag color="blue">版主</Tag>}
            {profile.trustLevel > 0 && <Tag>信任等级 {profile.trustLevel}</Tag>}
            {profile.groupName && <Tag color="green">{profile.groupName}</Tag>}
          </div>
          <div className="cm-profile-handle">@{profile.username}</div>
          {profile.title && <div className="cm-profile-title">{profile.title}</div>}
          <div className="cm-profile-meta">
            {profile.joinedAt && (
              <span>
                <CalendarOutlined /> 加入于 {formatDateTime(profile.joinedAt).slice(0, 10)}
              </span>
            )}
            {profile.lastSeenAt && (
              <span>
                <TimeText iso={profile.lastSeenAt} now={now} /> 活跃
              </span>
            )}
            {profile.location && (
              <span>
                <EnvironmentOutlined /> {profile.location}
              </span>
            )}
            {profile.website && /^https?:\/\//i.test(profile.website) && (
              <a href={profile.website} target="_blank" rel="noopener noreferrer">
                <LinkOutlined /> 个人主页
              </a>
            )}
          </div>
        </div>
      </header>

      {profile.bioText && (
        <section className="cm-profile-section">
          <h2>简介</h2>
          {safeBio ? (
            <div className="cm-rich cm-profile-bio" dangerouslySetInnerHTML={{ __html: safeBio }} />
          ) : (
            <p className="cm-profile-bio-text">{profile.bioText}</p>
          )}
        </section>
      )}

      <section className="cm-profile-section">
        <h2>社区数据</h2>
        <div className="cm-stats-grid">
          {statItems.map((item) => (
            <div className="cm-stat" key={item.label}>
              <span className="cm-stat-icon">{item.icon}</span>
              <span className="cm-stat-value">{item.value}</span>
              <span className="cm-stat-label">{item.label}</span>
            </div>
          ))}
        </div>
      </section>

      {profile.topCategories.length > 0 && (
        <section className="cm-profile-section">
          <h2>常驻分类</h2>
          <div className="cm-profile-chips">
            {profile.topCategories.map((cat) => (
              <span className="cm-cat-pill" key={`${cat.id}-${cat.name}`}>
                <i className="cm-dot" style={{ background: cat.color }} />
                {cat.name}
                <span className="cm-chip-count">{cat.topicCount}</span>
              </span>
            ))}
          </div>
        </section>
      )}

      {profile.badges.length > 0 && (
        <section className="cm-profile-section">
          <h2>徽章</h2>
          <div className="cm-badge-list">
            {profile.badges.slice(0, 16).map((badge) => (
              <Tooltip title={badge.description || badge.name} key={badge.id}>
                <span className="cm-badge">
                  {badge.icon ? badge.icon : <SafetyCertificateOutlined />}
                  <span>{badge.name}</span>
                </span>
              </Tooltip>
            ))}
          </div>
        </section>
      )}

      <section className="cm-profile-section">
        <h2>最近主题</h2>
        {profile.recentTopics.length === 0 ? (
          <div className="cm-profile-empty">还没有公开的主题记录</div>
        ) : (
          <div className="cm-profile-topics">
            {profile.recentTopics.slice(0, 8).map((topic) => (
              <article
                className="cm-profile-topic"
                key={topic.id}
                role="button"
                tabIndex={0}
                onClick={() => void useCommunityStore.getState().openTopic(topic.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    void useCommunityStore.getState().openTopic(topic.id);
                  }
                }}
              >
                <span className="cm-profile-topic-title">{topic.title}</span>
                <span className="cm-meta-item">
                  <MessageOutlined /> {formatCount(topic.postsCount)}
                </span>
                <span className="cm-meta-item">
                  <FireOutlined /> {formatCount(topic.likeCount)}
                </span>
                <TimeText iso={topic.createdAt} now={now} />
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/* =============================================
   ====== 绑定用户名 ======
   ============================================= */

function MeBindPane() {
  const myUsername = useCommunityStore((s) => s.myUsername);
  const bindUsername = useCommunityStore((s) => s.bindUsername);
  const [value, setValue] = useState(myUsername ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const name = parseUsernameInput(value);
    if (!name) {
      setError('请输入社区用户名，或粘贴你的社区主页链接');
      return;
    }
    setError('');
    setBusy(true);
    try {
      await bindUsername(name);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cm-me">
      <div className="cm-me-card">
        <div className="cm-me-icon">
          <UserOutlined />
        </div>
        <h1>我的资料</h1>
        <p className="cm-me-desc">
          这一版不登录。填写你的 Trae 社区用户名，就能在这里查看自己的公开资料
          （发帖、获赞、徽章与最近主题）。
        </p>

        <div className="cm-me-form">
          <Input
            size="large"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onPressEnter={() => void submit()}
            placeholder="用户名或主页链接，例如 https://forum.trae.cn/u/迟迟"
            prefix={<UserOutlined />}
            allowClear
          />
          <Button type="primary" size="large" loading={busy} onClick={() => void submit()}>
            查看公开资料
          </Button>
        </div>
        {error && <div className="cm-me-error">{error}</div>}

        {myUsername && (
          <div className="cm-me-current">
            当前绑定：<b>@{myUsername}</b>
            <button type="button" className="cm-link-btn" onClick={() => void useCommunityStore.getState().openMe()}>
              打开资料
            </button>
          </div>
        )}

        <div className="cm-me-note">
          <LockOutlined /> 无需登录也能读公开资料；通知、私信需要登录，入口已保留在右上角。
        </div>
      </div>
    </div>
  );
}

export function LockedPane({ panel }: { panel: 'notifications' | 'chat' }) {
  const session = useCommunityStore((s) => s.session);
  if (!session.loggedIn) return <LoginPane panel={panel} />;
  return panel === 'notifications' ? <NotificationsPane /> : <ChatPane />;
}

/* 未登录：真正的登录入口（内嵌 WebviewWindow → Trae 统一登录） */
function LoginPane({ panel }: { panel: 'notifications' | 'chat' }) {
  const busy = useCommunityStore((s) => s.loginBusy);
  const error = useCommunityStore((s) => s.loginError);
  const login = useCommunityStore((s) => s.login);
  const isNotifications = panel === 'notifications';

  return (
    <div className="cm-locked">
      <div className="cm-locked-card">
        <div className="cm-locked-icon">{isNotifications ? <BellOutlined /> : <MessageOutlined />}</div>
        <h1>{isNotifications ? '通知' : '私信'}</h1>
        <p>
          {isNotifications
            ? '登录后可读取真实通知：回复、@ 提及、点赞和系统通知，并支持一键标记已读。'
            : '登录后可读取私信与聊天频道：官方频道、一对一私信和未读数。'}
        </p>

        {error && <div className="cm-me-error">{error}</div>}

        <div className="cm-locked-actions">
          <Button
            type="primary"
            size="large"
            icon={busy ? <LoadingOutlined /> : <LoginOutlined />}
            loading={busy}
            onClick={() => void login()}
          >
            {busy ? '等待登录完成…' : '登录 Trae 社区'}
          </Button>
          <span className="cm-locked-hint">
            {busy ? '登录窗口已打开，完成后会自动关闭并刷新' : '点击后打开 Trae 统一登录窗口'}
          </span>
        </div>

        <div className="cm-locked-note">
          登录凭证只保存在本机（优先 macOS 钥匙串），界面与日志都不会出现 cookie。
        </div>
      </div>
    </div>
  );
}

/* 已登录：真实通知列表，按 notification_type 分组 */
function NotificationsPane() {
  const list = useCommunityStore((s) => s.notificationsList);
  const state = useCommunityStore((s) => s.notificationsState);
  const error = useCommunityStore((s) => s.notificationsError);
  const load = useCommunityStore((s) => s.loadNotifications);
  const markAll = useCommunityStore((s) => s.markAllNotificationsRead);
  const openTopic = useCommunityStore((s) => s.openTopic);
  const now = useNowTick();

  const groups = useMemo(() => {
    const map = new Map<string, CommunityNotification[]>();
    for (const item of list) {
      const bucket = map.get(item.typeLabel) ?? [];
      bucket.push(item);
      map.set(item.typeLabel, bucket);
    }
    return [...map.entries()];
  }, [list]);

  const unread = list.filter((item) => !item.read).length;

  return (
    <div className="cm-inbox">
      <div className="cm-inbox-head">
        <div>
          <h1>通知</h1>
          <span className="cm-inbox-sub">
            {list.length > 0 ? `${formatCount(list.length)} 条 · ${unread} 条未读` : '暂无通知'}
          </span>
        </div>
        <div className="cm-inbox-actions">
          <Button size="small" icon={<ReloadOutlined />} loading={state === 'loading'} onClick={() => void load()}>
            刷新
          </Button>
          <Button size="small" disabled={unread === 0} onClick={() => void markAll()}>
            全部标记已读
          </Button>
        </div>
      </div>

      {error && <div className="cm-me-error">{error}</div>}

      {state === 'loading' && list.length === 0 && <div className="cm-inbox-empty">正在读取通知…</div>}
      {state === 'ready' && list.length === 0 && (
        <div className="cm-inbox-empty">还没有通知。收到回复、@ 提及或点赞后会出现在这里。</div>
      )}

      {groups.map(([label, items]) => (
        <section key={label} className="cm-inbox-group">
          <h2>
            {label}
            <span>{items.length}</span>
          </h2>
          {items.map((item) => (
            <article
              key={item.id}
              className={`cm-inbox-item${item.read ? '' : ' is-unread'}`}
              onClick={() => {
                if (item.topicId) void openTopic(item.topicId);
              }}
            >
              <Avatar
                user={{ username: item.username ?? '', name: item.username ?? '社区用户', avatar: item.avatar }}
                size={34}
              />
              <div className="cm-inbox-main">
                <strong>{item.title}</strong>
                {item.excerpt && <p>{item.excerpt}</p>}
                <span className="cm-inbox-meta">
                  {item.username ? `@${item.username} · ` : ''}
                  <TimeText iso={item.createdAt} now={now} />
                  {item.postNumber ? ` · #${item.postNumber}` : ''}
                </span>
              </div>
              {!item.read && <i className="cm-inbox-dot" title="未读" />}
            </article>
          ))}
        </section>
      ))}
    </div>
  );
}

/* 已登录：私信/聊天频道；点开频道读真实消息 */
function ChatPane() {
  const list = useCommunityStore((s) => s.chatList);
  const source = useCommunityStore((s) => s.chatSource);
  const state = useCommunityStore((s) => s.chatState);
  const error = useCommunityStore((s) => s.chatError);
  const messages = useCommunityStore((s) => s.chatMessages);
  const activeId = useCommunityStore((s) => s.chatActiveId);
  const loading = useCommunityStore((s) => s.chatLoading);
  const load = useCommunityStore((s) => s.loadChatChannels);
  const openChannel = useCommunityStore((s) => s.openChatChannel);
  const closeChannel = useCommunityStore((s) => s.closeChatChannel);
  const now = useNowTick();

  const active = list.find((item) => item.id === activeId) ?? null;

  if (active) {
    return (
      <div className="cm-inbox cm-chat">
        <div className="cm-inbox-head">
          <div>
            <button type="button" className="cm-link-btn" onClick={() => closeChannel()}>
              <ArrowLeftOutlined /> 返回
            </button>
            <h1>{active.title}</h1>
            <span className="cm-inbox-sub">
              来自 {source === 'pm' ? '私信主题（/u/{username}/messages.json）' : 'Chat 插件'} · {messages.length} 条消息
            </span>
          </div>
          <div className="cm-inbox-actions">
            <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void openChannel(active.id)}>
              刷新
            </Button>
          </div>
        </div>

        {error && <div className="cm-me-error">{error}</div>}
        {loading && <div className="cm-inbox-empty">正在读取消息…</div>}

        <div className="cm-chat-stream">
          {messages.map((message) => (
            <article key={`${message.id}-${message.postNumber ?? 0}`} className="cm-chat-msg">
              <Avatar
                user={{ username: message.username, name: message.name, avatar: message.avatar ?? '' }}
                size={32}
              />
              <div className="cm-chat-body">
                <div className="cm-chat-meta">
                  <strong>{message.name}</strong>
                  <span>@{message.username}</span>
                  <TimeText iso={message.createdAt} now={now} />
                  {message.postNumber ? <span>#{message.postNumber}</span> : null}
                </div>
                {message.html ? (
                  <div
                    className="cm-cooked"
                    dangerouslySetInnerHTML={{ __html: sanitizeCookedHtml(message.html) }}
                  />
                ) : (
                  <p className="cm-chat-text">{message.text}</p>
                )}
              </div>
            </article>
          ))}
          {!loading && messages.length === 0 && <div className="cm-inbox-empty">这个频道还没有消息。</div>}
        </div>
      </div>
    );
  }

  return (
    <div className="cm-inbox">
      <div className="cm-inbox-head">
        <div>
          <h1>私信</h1>
          <span className="cm-inbox-sub">
            {list.length > 0 ? `${formatCount(list.length)} 个频道` : '暂无频道'}
            {source ? ` · ${source === 'pm' ? '私信主题回退' : 'Chat 插件'}` : ''}
          </span>
        </div>
        <div className="cm-inbox-actions">
          <Button size="small" icon={<ReloadOutlined />} loading={state === 'loading'} onClick={() => void load()}>
            刷新
          </Button>
        </div>
      </div>

      {error && <div className="cm-me-error">{error}</div>}
      {state === 'loading' && list.length === 0 && <div className="cm-inbox-empty">正在读取频道…</div>}
      {state === 'ready' && list.length === 0 && (
        <div className="cm-inbox-empty">还没有私信。官方频道开启后会出现在这里。</div>
      )}

      <div className="cm-chat-list">
        {list.map((channel) => (
          <button
            key={channel.id}
            type="button"
            className="cm-chat-channel"
            onClick={() => void openChannel(channel.id)}
          >
            <span className={`cm-chat-kind${channel.kind === 'direct' ? ' is-dm' : ''}`}>
              {channel.kind === 'direct' ? '私信' : '频道'}
            </span>
            <span className="cm-chat-title">
              {channel.title}
              {channel.lastMessage && <small>{channel.lastMessage}</small>}
            </span>
            {channel.unreadCount > 0 && <span className="cm-chat-unread">{channel.unreadCount}</span>}
            <TimeText iso={channel.lastMessageAt} now={now} />
          </button>
        ))}
      </div>
    </div>
  );
}
