/*
 * 提交面板
 * ------------------------------------------------------------------
 * 提交信息输入 + Commit / Commit and Push（IDEA 的提交区语义）。
 * 提交对象是**已暂存**的变更 —— 未暂存的改动在左侧列表勾选后自动进暂存区。
 * @Author: fu
 */
import { CheckOutlined, CloudUploadOutlined } from '@ant-design/icons';
import { Button, Input, Tooltip } from 'antd';
import { useGitStore } from '../store/useGitStore';

export function CommitPanel() {
  const message = useGitStore((s) => s.message);
  const setMessage = useGitStore((s) => s.setMessage);
  const commit = useGitStore((s) => s.commit);
  const status = useGitStore((s) => s.status);
  const ops = useGitStore((s) => s.ops);

  const stagedCount = status?.staged.length ?? 0;
  const canCommit = message.trim().length > 0 && stagedCount > 0 && !ops.commit;

  return (
    <div className="p-2 border-b border-wb-border-l1 shrink-0">
      <Input.TextArea
        id="git-commit-input"
        className="git-commit-msg"
        rows={2}
        placeholder={stagedCount > 0 ? '提交信息（⌘↩ 提交）' : '先在下面勾选要提交的文件'}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onPressEnter={(e) => {
          /* Cmd/Ctrl + Enter 直接提交（和 IDEA 一致） */
          if ((e.metaKey || e.ctrlKey) && canCommit) void commit();
        }}
      />
      <div className="flex items-center gap-1.5 mt-2">
        <Tooltip title={stagedCount === 0 ? '没有已暂存的文件' : '提交已暂存的文件'}>
          <Button
            type="primary"
            size="small"
            icon={<CheckOutlined />}
            disabled={!canCommit}
            loading={ops.commit}
            onClick={() => void commit()}
          >
            提交
          </Button>
        </Tooltip>
        <Tooltip title={stagedCount === 0 ? '没有已暂存的文件' : '提交后立即推送当前分支'}>
          <Button
            size="small"
            type="text"
            icon={<CloudUploadOutlined />}
            disabled={!canCommit}
            onClick={() => void commit({ push: true })}
          >
            提交并推送
          </Button>
        </Tooltip>
        <div className="flex-1" />
        <span className="git-count">{stagedCount} 个已暂存</span>
      </div>
    </div>
  );
}

export default CommitPanel;
