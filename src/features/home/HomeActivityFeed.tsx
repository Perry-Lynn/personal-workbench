/*
 * 首页 · 最近动态
 * ------------------------------------------------------------------
 * 「现在」面板回答的是此刻有几个进程、几份日志；这一块回答的是
 * 「刚才发生了什么」。两者放在同一页，是因为它们回答的是同一个问题
 * 的两半 —— 只看数字，你会知道有个 JAR 挂了却不知道它刚才重启过三次。
 *
 * 数据来自 core/events.ts（各模块在自己的成功路径上推事件），
 * 本组件只读、不推。所以这里**不能**出现任何业务写操作。
 *
 * 三个克制：
 *   1. 默认只显示 6 条。时间线一旦铺满整屏，首页就又变回「信息过载」。
 *   2. 不做分页、不做筛选、不做搜索。要看历史就展开，最多 30 条 ——
 *      再往前翻的需求属于日志查看器，不属于首页。
 *   3. 行内不出现按钮。唯一可点的操作是「展开 / 清空」，都在标题行右侧。
 *
 * 视觉细节见同级 home.css 的「最近动态」段。
 * @Author: fu
 */
import React, { useEffect, useMemo, useState } from 'react';
import { HistoryOutlined } from '@ant-design/icons';
import { clearEvents, formatAgo, useEvents } from '@/core/events';
import type { WorkbenchEvent } from '@/core/events';
import { getModule } from '@/core/registry';
import { useModules } from '@/core/useModules';

/** 收起时显示几条 */
const COLLAPSED_COUNT = 6;

/** 展开后最多显示几条 —— 再多就该去日志里看了 */
const EXPANDED_COUNT = 30;

/**
 * 让「N 分钟前」自己往前走。
 *
 * 不订阅任何数据，纯粹按 30 秒重渲染一次。30 秒是刻意选的：
 * 分钟级的文案，一秒一跳没有意义，反而制造无谓的渲染。
 */
function useNowTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/**
 * 事件来源模块的图标；模块被删/被隐藏时退回到一个通用图标。
 *
 * 注意模块定义里的 `icon` 是 **ReactNode（元素实例）**，不是组件类型，
 * 所以只能直接渲染，不能 `const Icon = ...; <Icon />` —— 那样 tsc 会报
 * 「does not have any construct or call signatures」。
 */
function EventIcon({ module, tone }: { module: string; tone: WorkbenchEvent['tone'] }) {
  /* 依赖 useModules 只是为了在模块注册表变化后重新取一次 */
  useModules();
  const icon = getModule(module)?.icon ?? <HistoryOutlined />;
  return <span className={`home-feed-icon is-${tone}`}>{icon}</span>;
}

const ActivityFeed: React.FC = () => {
  const events = useEvents();
  const [expanded, setExpanded] = useState(false);

  const now = useNowTicker(events.length > 0);

  const limit = expanded ? EXPANDED_COUNT : COLLAPSED_COUNT;
  /* 纯截取，不排序 —— core/events.ts 保证「最新在前」 */
  const rows = useMemo(() => events.slice(0, limit), [events, limit]);

  const hasMore = events.length > COLLAPSED_COUNT;

  return (
    <section className="home-feed">
      <div className="home-feed-head">
        <span className="home-feed-title">最近动态</span>
        <div className="home-feed-actions">
          {events.length > 0 && <span className="home-feed-meta">{events.length} 条</span>}
          {hasMore && (
            <button
              type="button"
              className="home-feed-btn"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? '收起' : '展开'}
            </button>
          )}
          {events.length > 0 && (
            <button
              type="button"
              className="home-feed-btn"
              onClick={() => {
                clearEvents();
                setExpanded(false);
              }}
            >
              清空
            </button>
          )}
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="home-feed-empty">
          还没有记录。启动一个 JAR、提交一次 Git、或者打开一份日志，这里就会有动静。
        </div>
      ) : (
        <ul className="home-feed-list">
          {rows.map((e) => (
            <li key={e.id} className="home-feed-row">
              <span className="home-feed-time">{formatAgo(e.ts, now)}</span>
              <EventIcon module={e.module} tone={e.tone} />
              <span className="home-feed-text">
                {e.title}
                {e.repeat > 1 && <span className="home-feed-repeat">×{e.repeat}</span>}
              </span>
              <span className="home-feed-detail">{e.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

export default React.memo(ActivityFeed);
