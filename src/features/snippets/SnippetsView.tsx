/*
 * 片段库 · 主体视图
 * ------------------------------------------------------------------
 * 本地可复用的文本片段：搜索 / 标签筛选 / 排序 / 一键复制 / 增删改 / 置顶。
 *
 * 交互上的两个取舍：
 *   1. 点标签 = 按该标签筛选。筛选栏里也有一排标签，但卡片上的标签更顺手 ——
 *      看到「这条属于 maven」时，下一个动作往往就是想看所有 maven 的。
 *   2. 复制走 core/clipboard（插件 + navigator 双路），复制成功后**才**记一次使用；
 *      记次数失败不报错（那只是统计，不该让用户以为复制没成功）。
 *
 * 字号约定同其它模块：自定义字号走 `calc(var(--wb-font-base) ± Npx)`，
 * 横向排布一律 `<Space wrap>`。
 * @Author: fu
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, App as AntApp, Button, Empty, Input, Select, Space, Spin, Tag, Typography } from 'antd';
import { PlusOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { copyText } from '@/core/clipboard';
import SnippetCard from './SnippetCard';
import SnippetEditor from './SnippetEditor';
import { SORT_MODES, filterSnippets, sortSnippets, tagCounts, totalText, type SortMode } from './format';
import { useSnippetsPrefs } from './prefs';
import { useSnippetsStore } from './store';
import type { Snippet, SnippetDraft } from './types';
import './snippets.css';

const { Text } = Typography;

/* 相对时间的刷新间隔：不刷新的话「更新于 3 分钟前」会一直停在那儿 */
const NOW_TICK_MS = 60_000;

const SnippetsView: React.FC = () => {
  const { message } = AntApp.useApp();

  const items = useSnippetsStore((s) => s.items);
  const loaded = useSnippetsStore((s) => s.loaded);
  const loading = useSnippetsStore((s) => s.loading);
  const error = useSnippetsStore((s) => s.error);
  const query = useSnippetsStore((s) => s.query);
  const activeTag = useSnippetsStore((s) => s.activeTag);
  const load = useSnippetsStore((s) => s.load);
  const setQuery = useSnippetsStore((s) => s.setQuery);
  const setActiveTag = useSnippetsStore((s) => s.setActiveTag);
  const save = useSnippetsStore((s) => s.save);
  const remove = useSnippetsStore((s) => s.remove);
  const togglePin = useSnippetsStore((s) => s.togglePin);
  const markUsed = useSnippetsStore((s) => s.markUsed);

  const sort = useSnippetsPrefs((s) => s.sort);
  const setSort = useSnippetsPrefs((s) => s.setSort);

  const [editorOpen, setEditorOpen] = useState(false);
  /* 正在编辑的那条；null = 新建 */
  const [editing, setEditing] = useState<Snippet | null>(null);
  const [now, setNow] = useState(() => Date.now());

  /* 首次进模块拉一次；已加载过就直接用 store 里的（切走再回来不闪） */
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), NOW_TICK_MS);
    return () => window.clearInterval(t);
  }, []);

  const counts = useMemo(() => tagCounts(items), [items]);
  const visible = useMemo(
    () => sortSnippets(filterSnippets(items, query, activeTag), sort),
    [items, query, activeTag, sort],
  );

  const handleCopy = useCallback(
    async (s: Snippet) => {
      try {
        await copyText(s.body);
        message.success(`已复制「${s.title}」`);
      } catch (e) {
        message.error(e instanceof Error ? e.message : '复制失败');
        return;
      }
      /*
       * 记使用次数放在复制成功之后，且**单独 try**：
       * 它只是统计，写失败不该让用户以为复制没成功。
       */
      try {
        await markUsed(s.id);
      } catch {
        /* 忽略 */
      }
    },
    [markUsed, message],
  );

  const handleSave = useCallback(
    async (draft: SnippetDraft) => {
      try {
        await save(draft);
        message.success(draft.id ? '已保存' : '已新建');
        setEditorOpen(false);
        setEditing(null);
      } catch (e) {
        message.error(e instanceof Error ? e.message : '保存失败');
        /* 抛出去让编辑器保持打开，用户输入不丢 */
        throw e;
      }
    },
    [message, save],
  );

  const handleTogglePin = useCallback(
    async (s: Snippet) => {
      try {
        await togglePin(s.id);
      } catch (e) {
        message.error(e instanceof Error ? e.message : '置顶失败');
      }
    },
    [message, togglePin],
  );

  const handleDelete = useCallback(
    async (s: Snippet) => {
      try {
        await remove(s.id);
        message.success(`已删除「${s.title}」`);
      } catch (e) {
        message.error(e instanceof Error ? e.message : '删除失败');
      }
    },
    [message, remove],
  );

  const openCreate = () => {
    setEditing(null);
    setEditorOpen(true);
  };

  const openEdit = (s: Snippet) => {
    setEditing(s);
    setEditorOpen(true);
  };

  const clearFilters = () => {
    setQuery('');
    setActiveTag(null);
  };

  return (
    <div className="snip-view">
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        {/* ===== 工具栏 ===== */}
        <Space size={8} wrap>
          <Input
            style={{ width: 320 }}
            allowClear
            prefix={<SearchOutlined />}
            placeholder="搜标题 / 正文 / 标签"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <Select<SortMode>
            style={{ width: 130 }}
            value={sort}
            options={SORT_MODES}
            onChange={setSort}
          />
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load(true)}>
            刷新
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新建片段
          </Button>
        </Space>

        {/* ===== 标签筛选 ===== */}
        {counts.length > 0 && (
          <Space size={6} wrap>
            <Tag
              className={`snip-filter-tag${activeTag === null ? ' snip-filter-on' : ''}`}
              onClick={() => setActiveTag(null)}
            >
              全部 {items.length}
            </Tag>
            {counts.map((c) => (
              <Tag
                key={c.tag}
                className={`snip-filter-tag${
                  activeTag?.toLowerCase() === c.tag.toLowerCase() ? ' snip-filter-on' : ''
                }`}
                onClick={() => setActiveTag(c.tag)}
              >
                {c.tag} {c.count}
              </Tag>
            ))}
          </Space>
        )}

        <Text type="secondary" className="snip-total">
          {totalText(items.length, visible.length)}
        </Text>

        {/* ===== 加载失败 ===== */}
        {error && (
          <Alert
            type="error"
            showIcon
            message="读取片段失败"
            description={error}
            action={
              <Button size="small" onClick={() => void load(true)}>
                重试
              </Button>
            }
          />
        )}

        {/* ===== 列表 ===== */}
        {!loaded && loading ? (
          <div className="snip-loading">
            <Spin />
          </div>
        ) : visible.length === 0 ? (
          <Empty
            description={
              items.length === 0 ? '还没有片段，点右上角「新建片段」' : '没有匹配的片段'
            }
          >
            {items.length > 0 && (
              <Button size="small" onClick={clearFilters}>
                清空筛选
              </Button>
            )}
          </Empty>
        ) : (
          <div className="snip-list">
            {visible.map((s) => (
              <SnippetCard
                key={s.id}
                snippet={s}
                query={query}
                now={now}
                onCopy={handleCopy}
                onEdit={openEdit}
                onTogglePin={handleTogglePin}
                onDelete={handleDelete}
                onTagClick={setActiveTag}
              />
            ))}
          </div>
        )}
      </Space>

      <SnippetEditor
        open={editorOpen}
        source={editing}
        onCancel={() => {
          setEditorOpen(false);
          setEditing(null);
        }}
        onSubmit={handleSave}
      />
    </div>
  );
};

export default SnippetsView;
