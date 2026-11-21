/*
 * 仓库选择（无仓库打开时的落地页）
 * ------------------------------------------------------------------
 * 「打开仓库」走系统目录选择器（tauri-plugin-dialog，与 Maven 模块同款），
 * 选中子目录也没关系 —— 后端会收敛到仓库根。
 * @Author: fu
 */
import { FolderOpenOutlined } from '@ant-design/icons';
import { Button } from 'antd';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { useGitStore } from '../store/useGitStore';
import { RecentRepos } from './RecentRepos';

export function RepoPicker() {
  const openRepo = useGitStore((s) => s.openRepo);
  const repoLoading = useGitStore((s) => s.repoLoading);

  const pick = async () => {
    try {
      const dir = await openDialog({ directory: true, title: '选择 Git 仓库目录' });
      if (typeof dir === 'string' && dir) await openRepo(dir);
    } catch {
      /* 用户取消选择器：无事发生 */
    }
  };

  return (
    <div className="h-full flex flex-col items-center justify-center gap-6 p-8">
      <div className="text-center">
        <div className="text-wb-text-primary git-fs-lg mb-1">Git 管理</div>
        <div className="text-wb-text-secondary git-fs-md">
          打开一个本地仓库：查看修改、比较差异、提交、管理分支、拉取推送
        </div>
      </div>
      <Button type="primary" icon={<FolderOpenOutlined />} loading={repoLoading} onClick={() => void pick()}>
        打开仓库…
      </Button>
      <RecentRepos />
    </div>
  );
}

export default RepoPicker;
