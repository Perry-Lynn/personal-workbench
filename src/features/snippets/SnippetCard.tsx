/*
 * 片段库 · 单条卡片
 * ------------------------------------------------------------------
 * 为什么是卡片而不是表格：每条要展示的内容是**异构**的 —— 标题长短差很多、
 * 正文要按原样保留缩进、标签数量不定。表格列宽在这种内容上怎么调都别扭，
 * 卡片可以让每一块自己决定占多少地方。
 *
 * 正文预览只取前几行、每行截断，但**不 trim 掉行首缩进** ——
 * 命令和配置的缩进是有意义的，去掉之后代码看起来是坏的。
 * @Author: fu
 */
import React from 'react';
import { Button, Popconfirm, Space, Tag, Tooltip, Typography } from 'antd';
import {
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  PushpinFilled,
  PushpinOutlined,
} from '@ant-design/icons';
import { splitByRanges } from '@/core/text';
import { langLabel, previewLines, queryRanges, summaryText } from './format';
import type { Snippet } from './types';

const { Text } = Typography;

interface Props {
  snippet: Snippet;
  /** 当前搜索词，用于高亮 */
  query: string;
  /** 当前时间（毫秒），相对时间由它算 —— 由父组件统一给，保证同一屏里口径一致 */
  now: number;
  onCopy: (s: Snippet) => void;
  onEdit: (s: Snippet) => void;
  onTogglePin: (s: Snippet) => void;
  onDelete: (s: Snippet) => void;
  /** 点标签 = 按该标签筛选 */
  onTagClick: (tag: string) => void;
}

const SnippetCard: React.FC<Props> = ({
  snippet: s,
  query,
  now,
  onCopy,
  onEdit,
  onTogglePin,
  onDelete,
  onTagClick,
}) => {
  const { lines, more } = previewLines(s.body);

  const renderHi = (text: string) =>
    splitByRanges(text, queryRanges(text, query)).map((seg, i) =>
      seg.hit ? (
        <mark className="snip-mark" key={i}>
          {seg.text}
        </mark>
      ) : (
        <React.Fragment key={i}>{seg.text}</React.Fragment>
      ),
    );

  return (
    <div className={`snip-card${s.pinned ? ' snip-card-pinned' : ''}`}>
      <div className="snip-card-head">
        <Tooltip title={s.pinned ? '取消置顶' : '置顶'}>
          <Button
            type="text"
            size="small"
            className={`snip-pin${s.pinned ? ' snip-pin-on' : ''}`}
            icon={s.pinned ? <PushpinFilled /> : <PushpinOutlined />}
            onClick={() => onTogglePin(s)}
          />
        </Tooltip>

        <Text strong className="snip-title">
          {renderHi(s.title)}
        </Text>
        <Tag className="snip-lang">{langLabel(s.lang)}</Tag>

        <span className="snip-spacer" />

        <Space size={4} wrap>
          {s.tags.map((t) => (
            <Tag key={t} className="snip-tag" onClick={() => onTagClick(t)}>
              {t}
            </Tag>
          ))}
        </Space>
      </div>

      <div className="snip-body">
        {lines.length === 0 ? (
          <Text type="secondary" className="snip-hint">
            （空片段）
          </Text>
        ) : (
          lines.map((l, i) => (
            <div className="snip-line" key={i}>
              {renderHi(l)}
            </div>
          ))
        )}
        {more && <div className="snip-more">…</div>}
      </div>

      <div className="snip-card-foot">
        <Text type="secondary" className="snip-meta">
          {summaryText(s, now)}
        </Text>

        <span className="snip-spacer" />

        <Space size={6}>
          <Button size="small" type="primary" ghost icon={<CopyOutlined />} onClick={() => onCopy(s)}>
            复制
          </Button>
          <Button size="small" icon={<EditOutlined />} onClick={() => onEdit(s)}>
            编辑
          </Button>
          <Popconfirm
            title="删除这条片段？"
            description="删掉就找不回来了。"
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => onDelete(s)}
          >
            <Button size="small" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      </div>
    </div>
  );
};

export default SnippetCard;
