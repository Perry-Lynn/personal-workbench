/*
 * 顶部工具栏
 * ------------------------------------------------------------------
 * 仓库切换（最近列表 + 打开…）、分支快速切换、Fetch / Pull / Push、刷新。
 * 仓库名后面挂一枚「托管平台」胶囊（GitHub / GitLab · 自建 / 本地路径）——
 * 远端名只有 origin / upstream，光看名字判断不出背后是哪家，判定见 utils/remotes.ts。
 * 领先/落后用 ↑↓ 胶囊标注（IDEA 新 UI 的同步按钮语义）。
 * 切换分支 / 拉取 / 推送都走 useGitOps 的统一确认流程。
 *
 * ⚠️ 分支下拉的 menu key 用完整 refname（唯一），但**切换时必须传短名**：
 * git 拿到 `refs/heads/main` 会认成一次游离检出（实测直接进分离头指针），
 * 传 `main` 才会真正「切到这条分支」。
 *
 * Pull 的语义是「把所选分支快进到远端最新」（不产生合并提交；见 useGitOps.askPull），
 * 所以按钮上直接把将要拉取的目标标出来，免得用户以为是「拉全部」。
 * @Author: fu
 */
import {
  CloudDownloadOutlined,
  CloudUploadOutlined,
  DownOutlined,
  FolderOpenOutlined,
  ReloadOutlined,
  SwapOutlined,
} from '@ant-design/icons';
import { Button, Dropdown, Tooltip } from 'antd';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { useGitOps } from '../hooks/useGitOps';
import { useGitStore } from '../store/useGitStore';
import { resolvePullTarget } from '../utils/pullTarget';
import { pickPrimaryRemote } from '../utils/remotes';

export function GitToolbar() {
  const repoRoot = useGitStore((s) => s.repoRoot);
  const repoInfo = useGitStore((s) => s.repoInfo);
  const recentRepos = useGitStore((s) => s.recentRepos);
  const branches = useGitStore((s) => s.branches);
  const remotes = useGitStore((s) => s.remotes);
  const viewBranch = useGitStore((s) => s.viewBranch);
  const ops = useGitStore((s) => s.ops);
  const openRepo = useGitStore((s) => s.openRepo);
  const refresh = useGitStore((s) => s.refresh);
  const { askCheckout, askPull, askPush, doFetch } = useGitOps();

  const pick = async () => {
    try {
      const dir = await openDialog({ directory: true, title: '选择 Git 仓库目录' });
      if (typeof dir === 'string' && dir) await openRepo(dir);
    } catch {
      /* 用户取消：忽略 */
    }
  };

  const repoName = (repoRoot ?? '').split('/').filter(Boolean).slice(-1)[0] ?? '';
  const branchName = repoInfo?.detached ? '（分离头指针）' : (repoInfo?.branch ?? '—');
  const ahead = repoInfo?.ahead ?? 0;
  const behind = repoInfo?.behind ?? 0;

  /*
   * 这个仓库托管在哪（GitHub / GitLab / 自建 / 本地路径）。
   * 取「主远端」而不是第一个：多远端（fork）时 origin 常常是别人的仓库，
   * 跟着当前分支上游走才不会标错平台。判定见 utils/remotes.ts。
   */
  const primaryRemote = pickPrimaryRemote(remotes ?? [], repoInfo?.upstream ?? null);
  const noRemote = remotes !== null && remotes.length === 0;

  /*
   * Pull 会拉到哪条分支、会不会动工作区：渲染时就定下来，按钮上的提示才不是空话。
   * 选中本地分支 = 把那条分支快进到远端（选中当前检出分支时连工作区一起更新）；
   * 选中远端分支 = 只刷新远端引用。
   */
  const pullRes = resolvePullTarget({
    viewBranch,
    branches,
    currentUpstream: repoInfo?.upstream ?? null,
  });
  const pullTip = !pullRes.ok
    ? `拉取所选分支的远端更新 —— 现在定不下目标：${pullRes.reason}`
    : !pullRes.target.updateLocal
      ? `只刷新远端引用 ${pullRes.target.remote}/${pullRes.target.branch}（不碰任何本地分支）`
      : pullRes.target.branch === repoInfo?.branch
        ? `把当前分支 ${pullRes.target.branch} 快进到 ${pullRes.target.remote}/${pullRes.target.branch}（含工作区，无合并提交）`
        : `把本地分支 ${pullRes.target.branch} 快进到 ${pullRes.target.remote}/${pullRes.target.branch}（不动工作区、不切换）`;

  /*
   * 下拉项里的字号也走同一条阶梯：名字 md（与顶栏按钮文字同档）、
   * 哈希等次要信息 sm（只低一档）。AntD 菜单默认按 base 档渲染（= 16px），
   * 而顶栏按钮是 small 档（= md），不显式对齐就会出现「菜单里的字比按钮大一截」。
   */
  const localItems = (branches?.local ?? []).map((b) => ({
    /* key 要唯一且稳定，用完整 refname；切换时再取短名（见文件头 ⚠️） */
    key: b.ref,
    label: (
      <span className="flex items-center gap-2">
        <span className={`git-fs-md ${b.current ? 'text-wb-text-brand font-medium' : ''}`}>
          {b.name}
        </span>
        {b.ahead > 0 && (
          <Tooltip title={`领先上游 ${b.ahead} 个提交（待推送）`}>
            <span className="git-chip is-hot">↑{b.ahead}</span>
          </Tooltip>
        )}
        {b.behind > 0 && (
          <Tooltip title={`落后上游 ${b.behind} 个提交（待拉取）`}>
            <span className="git-chip">↓{b.behind}</span>
          </Tooltip>
        )}
        <span className="text-wb-text-tertiary git-fs-sm">{b.shortHash}</span>
      </span>
    ),
    disabled: b.current,
  }));

  const branchItems = [
    ...(localItems.length > 0
      ? localItems
      : [{ key: 'none', label: <span className="git-fs-md">（暂无本地分支）</span>, disabled: true }]),
    { type: 'divider' as const },
    {
      key: 'refresh-branches',
      label: (
        <span className="flex items-center gap-2 git-fs-md">
          <ReloadOutlined /> 刷新分支列表
        </span>
      ),
    },
  ];

  return (
    <div className="h-11 flex items-center gap-1.5 px-3 border-b border-wb-border-l1 shrink-0">
      {/* 仓库切换 */}
      <Dropdown
        menu={{
          items: [
            ...recentRepos.map((p) => ({ key: p, label: <span className="git-fs-md">{p}</span> })),
            ...(recentRepos.length > 0 ? [{ type: 'divider' as const }] : []),
            {
              key: '__open',
              label: (
                <span className="flex items-center gap-2 git-fs-md">
                  <FolderOpenOutlined /> 打开其它仓库…
                </span>
              ),
            },
          ],
          onClick: ({ key }) => {
            if (key === '__open') void pick();
            else void openRepo(key);
          },
        }}
      >
        <Button size="small" type="text" icon={<FolderOpenOutlined />}>
          <span className="max-w-[170px] truncate inline-block align-middle font-medium">
            {repoName || '选择仓库'}
          </span>
          {/* 下拉箭头用 sm 档（不是 xs）：按钮里的文字/图标在 AntD small 档 = md，
              箭头低一档就够；低两档会让整行看起来「文字大、图标小」 */}
          <DownOutlined className="git-fs-sm ml-1 text-wb-text-tertiary" />
        </Button>
      </Dropdown>

      {/* 托管平台：一眼看出这个仓库在 GitHub 还是自建 GitLab（判定见 utils/remotes.ts） */}
      {primaryRemote && (
        <Tooltip
          title={
            <div className="git-fs-sm">
              <div>
                {primaryRemote.name} · {primaryRemote.label}
              </div>
              <div className="mt-0.5 break-all">{primaryRemote.url}</div>
              {(remotes ?? []).length > 1 && (
                <div className="mt-1">
                  还有：
                  {(remotes ?? [])
                    .filter((r) => r.name !== primaryRemote.name)
                    .map((r) => `${r.name}（${r.label}）`)
                    .join('、')}
                </div>
              )}
            </div>
          }
        >
          <span className="git-chip shrink-0">{primaryRemote.label}</span>
        </Tooltip>
      )}
      {noRemote && (
        <Tooltip title="这个仓库没有配置任何远端 —— 纯本地仓库，不涉及任何托管平台">
          <span className="text-wb-text-tertiary git-fs-sm shrink-0">无远端</span>
        </Tooltip>
      )}

      {/* 组分隔：用 1px 元素而不是给竖线字符上色 —— 后者只是「看起来能用」 */}
      <span className="w-px h-4 bg-wb-border-l2 shrink-0 select-none" />

      {/* 分支切换（先确认）。key 是完整 refname，切换传短名 —— 见文件头 ⚠️ */}
      <Dropdown
        menu={{
          items: branchItems,
          onClick: ({ key }) => {
            if (key === 'refresh-branches') void refresh();
            else if (key !== 'none') {
              const b = branches?.local.find((x) => x.ref === key);
              if (b) askCheckout(b.name);
            }
          },
        }}
      >
        <Button size="small" type="text">
          <span className="max-w-[150px] truncate inline-block align-middle">{branchName}</span>
          {/* 下拉箭头用 sm 档（不是 xs）：按钮里的文字/图标在 AntD small 档 = md，
              箭头低一档就够；低两档会让整行看起来「文字大、图标小」 */}
          <DownOutlined className="git-fs-sm ml-1 text-wb-text-tertiary" />
        </Button>
      </Dropdown>

      {/* 领先/落后胶囊 */}
      {ahead > 0 && (
        <Tooltip title={`本地领先上游 ${ahead} 个提交（待推送）`}>
          <span className="git-chip is-hot">↑{ahead}</span>
        </Tooltip>
      )}
      {behind > 0 && (
        <Tooltip title={`本地落后上游 ${behind} 个提交（待拉取）`}>
          <span className="git-chip">↓{behind}</span>
        </Tooltip>
      )}

      <div className="flex-1" />

      {/* 仓库全路径：次要信息，只比按钮文字低一档（低两档整行就散了） */}
      <span className="text-wb-text-tertiary git-fs-sm max-w-[240px] truncate" title={repoRoot ?? ''}>
        {repoRoot}
      </span>

      <Tooltip title="获取远端更新（fetch --all --prune，只更新远端引用，不改工作区）">
        <Button
          size="small"
          type="text"
          icon={<CloudDownloadOutlined />}
          loading={ops.fetch}
          onClick={doFetch}
        >
          Fetch
        </Button>
      </Tooltip>
      <Tooltip title={pullTip}>
        <Button size="small" type="text" icon={<DownOutlined />} loading={ops.pull} onClick={askPull}>
          Pull
          {pullRes.ok && (
            <span className="git-fs-sm text-wb-text-tertiary ml-1">{pullRes.target.branch}</span>
          )}
        </Button>
      </Tooltip>
      <Tooltip title="推送到远端（push，会先确认）">
        <Button size="small" type="text" icon={<CloudUploadOutlined />} loading={ops.push} onClick={askPush}>
          Push
        </Button>
      </Tooltip>
      <Tooltip title="刷新状态（快捷键 R）">
        <Button size="small" type="text" icon={<SwapOutlined />} onClick={() => void refresh()} />
      </Tooltip>
    </div>
  );
}

export default GitToolbar;
