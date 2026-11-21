/*
 * 片段库 · 新建 / 编辑弹窗
 * ------------------------------------------------------------------
 * 用受控 state 而不是 AntD Form：这里只有四个字段，而标签要**边输边预览**
 * （用户输入 "maven, 命令" 时立刻看到会存成两个标签），
 * 这种「输入 → 即时展示归一结果」的联动用 Form 反而绕。
 *
 * 校验只做两件：标题归一后不能为空、正文不能超字节上限。
 * 其余（去重、截断、小写化）都由归一函数悄悄做完 —— 用户不该为了存一条
 * 命令去理解「标签不能重复」这种规则。
 * @Author: fu
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Alert, AutoComplete, Button, Input, Modal, Space, Tag, Typography } from 'antd';
import {
  LANG_PRESETS,
  MAX_BODY_BYTES,
  MAX_TAGS,
  MAX_TITLE_CHARS,
  bodyBytes,
  bodyTooLarge,
  formatKb,
  normalizeTags,
  normalizeTitle,
  tagsToInput,
} from './format';
import type { Snippet, SnippetDraft } from './types';

const { Text } = Typography;

interface Props {
  open: boolean;
  /** null = 新建 */
  source: Snippet | null;
  onCancel: () => void;
  /** 抛错 = 保存失败，弹窗保持打开（调用方负责提示） */
  onSubmit: (draft: SnippetDraft) => Promise<void>;
}

const SnippetEditor: React.FC<Props> = ({ open, source, onCancel, onSubmit }) => {
  const [title, setTitle] = useState('');
  const [lang, setLang] = useState<string | null>(null);
  const [tagsInput, setTagsInput] = useState('');
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);

  /* 每次打开都按「当前编辑对象」重置 —— 不重置的话会带上一条的残留内容 */
  useEffect(() => {
    if (!open) return;
    setTitle(source?.title ?? '');
    setLang(source?.lang ?? null);
    setTagsInput(source ? tagsToInput(source.tags) : '');
    setBody(source?.body ?? '');
    setSaving(false);
  }, [open, source]);

  const tags = useMemo(() => normalizeTags(tagsInput), [tagsInput]);
  const normalizedTitle = normalizeTitle(title);
  const tooLarge = bodyTooLarge(body);
  const canSave = normalizedTitle.length > 0 && !tooLarge && !saving;

  const handleOk = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      await onSubmit({
        id: source?.id,
        title: normalizedTitle,
        body,
        lang: lang && lang.trim() ? lang.trim() : null,
        tags,
      });
    } catch {
      /*
       * 吞掉异常只为不产生「未处理的 Promise 拒绝」——提示由调用方负责。
       * 弹窗不关，用户刚敲的内容一个字都不会丢。
       */
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      title={source ? '编辑片段' : '新建片段'}
      width={760}
      onCancel={onCancel}
      maskClosable={false}
      footer={[
        <Button key="cancel" onClick={onCancel} disabled={saving}>
          取消
        </Button>,
        <Button key="ok" type="primary" loading={saving} disabled={!canSave} onClick={handleOk}>
          保存
        </Button>,
      ]}
    >
      <div className="snip-form">
        <div className="snip-field">
          <Text className="snip-label">标题</Text>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="例：查看占用某端口的进程"
            showCount
            maxLength={MAX_TITLE_CHARS}
            autoFocus
          />
        </div>

        <div className="snip-field">
          <Text className="snip-label">类型</Text>
          <AutoComplete
            value={lang ?? ''}
            onChange={(v) => setLang(v)}
            options={LANG_PRESETS.map((v) => ({ value: v }))}
            placeholder="java / sql / bash…（可留空）"
            allowClear
            style={{ width: 240 }}
          />
          <Text type="secondary" className="snip-hint">
            只用于展示分类，不做语法高亮
          </Text>
        </div>

        <div className="snip-field">
          <Text className="snip-label">标签</Text>
          <Input
            value={tagsInput}
            onChange={(e) => setTagsInput(e.target.value)}
            placeholder="逗号或空格分隔，例：maven, 排查"
          />
          {/* 边输边给归一结果：让「会存成什么」当场可见，而不是存完才发现被拆错了 */}
          <Space size={6} wrap className="snip-tag-preview">
            {tags.length === 0 ? (
              <Text type="secondary" className="snip-hint">
                还没有标签
              </Text>
            ) : (
              tags.map((t) => (
                <Tag key={t} className="snip-tag">
                  {t}
                </Tag>
              ))
            )}
            {tags.length >= MAX_TAGS && (
              <Text type="warning" className="snip-hint">
                最多 {MAX_TAGS} 个，多的会被丢掉
              </Text>
            )}
          </Space>
        </div>

        <div className="snip-field">
          <Space size={8} align="center">
            <Text className="snip-label">正文</Text>
            <Text type={tooLarge ? 'danger' : 'secondary'} className="snip-hint">
              {formatKb(bodyBytes(body))} / {formatKb(MAX_BODY_BYTES)}
            </Text>
          </Space>
          <Input.TextArea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={14}
            className="snip-body-input"
            placeholder="lsof -nP -iTCP:8080 -sTCP:LISTEN"
          />
        </div>

        {tooLarge && (
          <Alert
            type="error"
            showIcon
            message="正文太大了"
            description={`片段库放的是「一小段」，上限 ${formatKb(MAX_BODY_BYTES)}。整份文件请直接在编辑器里打开。`}
          />
        )}
      </div>
    </Modal>
  );
};

export default SnippetEditor;
