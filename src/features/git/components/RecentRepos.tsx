/*
 * 最近打开的仓库列表
 * ------------------------------------------------------------------
 * 点击即打开；hover 出「忘记」按钮（只从列表移除，不动磁盘）。
 * @Author: fu
 */
import { CloseOutlined, FolderOpenOutlined } from '@ant-design/icons';
import { useGitStore } from '../store/useGitStore';

export function RecentRepos() {
  const recentRepos = useGitStore((s) => s.recentRepos);
  const openRepo = useGitStore((s) => s.openRepo);
  const forgetRepo = useGitStore((s) => s.forgetRepo);

  if (recentRepos.length === 0) return null;

  return (
    <div className="w-[520px] max-w-full">
      <div className="mb-2 text-wb-text-secondary git-fs-sm">最近打开</div>
      <div className="rounded-wb border border-wb-border-l1 overflow-hidden">
        {recentRepos.map((p) => {
          /* 展示尾段两层目录（完整路径进 title） */
          const parts = p.split('/').filter(Boolean);
          const label = parts.slice(-2).join('/');
          return (
            <div
              key={p}
              className="git-row group flex items-center gap-2 px-3 py-2 cursor-pointer border-b border-wb-border-l1 last:border-b-0"
              onClick={() => void openRepo(p)}
              title={p}
            >
              <FolderOpenOutlined className="text-wb-text-tertiary git-fs-md" />
              <span className="text-wb-text-primary git-fs-md truncate flex-1">{label}</span>
              <span className="text-wb-text-tertiary git-fs-xs truncate max-w-[280px]">{p}</span>
              <CloseOutlined
                className="opacity-0 group-hover:opacity-100 text-wb-text-tertiary hover:text-wb-error git-fs-xs"
                onClick={(e) => {
                  e.stopPropagation();
                  forgetRepo(p);
                }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default RecentRepos;
