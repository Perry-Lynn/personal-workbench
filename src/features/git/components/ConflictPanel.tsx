import { useState } from 'react';
import { Alert, App as AntApp, Button, Collapse, Space, Typography } from 'antd';
import { CopyOutlined, FolderOpenOutlined, ReloadOutlined } from '@ant-design/icons';
import { useGitStore } from '../store/useGitStore';
import { copyText } from '@/core/clipboard';

export function ConflictPanel() {
  const { message, modal } = AntApp.useApp();
  const root = useGitStore((s) => s.repoRoot);
  const op = useGitStore((s) => s.operationState);
  const refresh = useGitStore((s) => s.refresh);
  const runConflictAction = useGitStore((s) => s.runConflictAction);
  const ops = useGitStore((s) => s.ops);
  const globalBusy = Object.values(ops).some(Boolean);
  const [busy, setBusy] = useState<string | null>(null);
  if (!root || op.kind === 'none') return null;
  const isMerge = op.kind === 'merge';
  const perform = async (key: string, kind: 'open' | 'resolve' | 'resolve-binary' | 'continue' | 'abort', path?: string) => {
    const expectedRoot = root;
    setBusy(key);
    try {
      const result = await runConflictAction(expectedRoot, kind, path);
      if (useGitStore.getState().repoRoot !== expectedRoot) return;
      if (result.ok) message.success(result.message); else message.error(result.message);
    } catch (e) { message.error(String(e)); }
    finally { setBusy(null); }
  };
  const continueMerge = () => modal.confirm({ title: '完成合并', content: 'Git 将创建合并提交。', okText: '继续', onOk: () => perform('continue', 'continue') });
  const abortMerge = () => modal.confirm({ title: '中止合并', content: 'Git 将恢复合并开始前的状态。', okText: '中止合并', okButtonProps: { danger: true }, onOk: () => perform('abort', 'abort') });
  return <Alert className="mx-2 mt-2 shrink-0" type={op.conflicts.length ? 'warning' : 'info'} showIcon
    message={<Space wrap><Typography.Text strong>Git 正在进行：{op.kind === 'merge' ? 'merge' : op.kind}</Typography.Text><Typography.Text>{op.conflicts.length ? `${op.conflicts.length} 个冲突` : '当前没有未解决冲突'}</Typography.Text>
      {isMerge ? <><Button size="small" type="primary" disabled={op.conflicts.length > 0 || globalBusy} loading={busy === 'continue'} onClick={continueMerge}>继续合并</Button><Button size="small" danger disabled={globalBusy} loading={busy === 'abort'} onClick={abortMerge}>中止合并</Button></> : <Typography.Text type="secondary">请在外部工具中处理；此操作类型不支持本界面继续或中止。</Typography.Text>}
      <Button size="small" icon={<ReloadOutlined />} disabled={!!busy} onClick={() => void refresh()}>刷新状态</Button></Space>}
    description={op.conflicts.length > 0 && <Collapse size="small" items={[{ key: 'conflicts', label: '冲突文件', children: <div className="flex flex-col gap-2">{op.conflicts.map((path) => <ConflictRow key={path} root={root} path={path} busy={globalBusy} run={perform} />)}</div> }]} />}
  />;
}

function ConflictRow({ root, path, busy, run }: { root: string; path: string; busy: boolean; run: (key: string, kind: 'open' | 'resolve' | 'resolve-binary' | 'continue' | 'abort', path?: string) => Promise<void> }) {
  const { message } = AntApp.useApp();
  const copy = async () => { try { await copyText(`${root.replace(/[\\/]$/, '')}/${path}`); message.success('完整路径已复制'); } catch (e) { message.error(String(e)); } };
  return <div className="flex items-center justify-between gap-2"><Typography.Text className="font-mono git-fs-sm break-all">{path}</Typography.Text><Space wrap>
    <Button size="small" icon={<FolderOpenOutlined />} disabled={busy} onClick={() => void run(`open:${path}`, 'open', path)}>系统应用打开</Button>
    <Button size="small" icon={<CopyOutlined />} onClick={() => void copy()}>复制路径</Button>
    <Button size="small" type="primary" disabled={busy} onClick={() => void run(`resolve:${path}`, 'resolve', path)}>标记已解决</Button>
    <Button size="small" disabled={busy} onClick={() => void run(`resolve-binary:${path}`, 'resolve-binary', path)}>确认二进制已解决</Button>
  </Space></div>;
}
