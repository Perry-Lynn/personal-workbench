/*
 * 分支面板
 * ------------------------------------------------------------------
 * 本地 / 远端两组；远端再按 remote 名（origin / upstream…）分组，
 * 每组标题可点击展开 / 折叠。
 *
 * 交互分工（对齐 IDEA 的分支列表习惯）：
 *   单击   → **只看该分支的提交历史**，不切换分支（远端分支也能看，纯本地读引用）
 *   双击   → 切换到该分支（走统一确认）
 *   右键   → 查看历史 / 切换 / 合并到当前分支 / 删除 / 强制删除
 *
 * 行高亮 = 「历史图当前正在看的分支」：跟随 HEAD 时就是当前分支那一行。
 * @Author: fu
 */
import { CaretDownOutlined, CaretRightOutlined, CheckOutlined, PlusOutlined } from '@ant-design/icons';
import { Button, Dropdown, Input, Modal, Tooltip } from 'antd';
import dayjs from 'dayjs';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { useGitOps } from '../hooks/useGitOps';
import { useGitStore } from '../store/useGitStore';
import type { BranchInfo } from '../types';

/** 可折叠的分组标题 */
function GroupHead({
  title,
  count,
  open,
  onToggle,
  indent = 0,
  hint,
}: {
  title: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  indent?: number;
  /** 标题后的补充说明（远端分组用它标「托管在哪」：GitHub / GitLab · 自建…） */
  hint?: ReactNode;
}) {
  return (
    <div
      className="git-section-head cursor-pointer select-none"
      style={{ paddingLeft: 8 + indent }}
      onClick={onToggle}
      title={open ? '折叠' : '展开'}
    >
      <span className="git-caret text-wb-text-tertiary">
        {open ? <CaretDownOutlined /> : <CaretRightOutlined />}
      </span>
      <span className="truncate">{title}</span>
      {hint && <span className="text-wb-text-tertiary git-fs-xs shrink-0">{hint}</span>}
      <span className="git-count">{count}</span>
    </div>
  );
}

function BranchRow({ b, isCurrent, isViewed }: { b: BranchInfo; isCurrent: boolean; isViewed: boolean }) {
  const repoInfo = useGitStore((s) => s.repoInfo);
  const viewBranchLog = useGitStore((s) => s.viewBranchLog);
  /* 这条远端分支有没有「自上次确认后」的新提交（比对基线见 utils/remotePeek） */
  const mark = useGitStore((s) => s.remoteUpdates[b.ref]);
  const { askCheckout, askMerge, askDeleteBranch } = useGitOps();
  const currentName = repoInfo?.branch ?? null;

  const items = [
    { key: 'view', label: '查看提交记录（不切换）', disabled: isViewed },
    { key: 'checkout', label: '切换到该分支', disabled: isCurrent },
    { key: 'merge', label: `合并到当前分支（${currentName ?? '—'}）`, disabled: isCurrent || !currentName },
    { type: 'divider' as const },
    { key: 'delete', label: '删除分支', disabled: isCurrent, danger: true },
    { key: 'force-delete', label: '强制删除（未合并也删）', disabled: isCurrent, danger: true },
  ];

  return (
    <Dropdown
      trigger={['contextMenu']}
      menu={{
        items,
        onClick: ({ key }) => {
          if (key === 'view') viewBranchLog({ ref: b.ref, label: b.name });
          else if (key === 'checkout') askCheckout(b.name, isCurrent);
          else if (key === 'merge') askMerge(b.name);
          else if (key === 'delete') askDeleteBranch(b.name, false);
          else if (key === 'force-delete') askDeleteBranch(b.name, true);
        },
      }}
    >
      <div
        className={`git-row flex items-center gap-1.5 pl-2 pr-2 py-[3px] cursor-pointer ${
          isViewed ? 'is-selected' : ''
        }`}
        /* 单击 = 看历史；当前分支那一行 = 回到「跟随 HEAD」 */
        onClick={() => viewBranchLog(isCurrent ? null : { ref: b.ref, label: b.name })}
        onDoubleClick={() => askCheckout(b.name, isCurrent)}
      >
        <span className="w-[13px] shrink-0 flex items-center justify-center">
          {isCurrent && <CheckOutlined className="text-wb-text-brand git-fs-sm" />}
        </span>
        {/*
         * 宽度分配：分支名优先。
         *   分支名 = flex-basis:auto + 上限 60%，有地方就按内容撑开（原来写死 110px，
         *            `feature/xxx` 这类名字必被切），挤的时候才收缩让位；
         *            用百分比而不是 px：左栏可拖 200~640，比例在每一档都合适
         *            （200px 时 60% ≈ 110px，正好不小于原来的上限）；
         *   提交说明 = flex-1，只吃剩下的那点宽度 —— 这个面板要认的是分支名，
         *            说明只是「这条分支最近干了啥」的辅助信息。
         * 两段都可能被截断，所以各自挂 tooltip 显示全文。
         * （原来整行挂的是原生 title：它和 AntD 的 tooltip 会先后冒出两个框，故去掉。）
         */}
        <Tooltip title={b.name} mouseEnterDelay={0.3}>
          <span
            className={`git-fs-md min-w-0 truncate max-w-[60%] ${
              isCurrent ? 'text-wb-text-brand font-medium' : 'text-wb-text-primary'
            }`}
          >
            {b.name}
          </span>
        </Tooltip>
        <Tooltip
          mouseEnterDelay={0.3}
          title={
            <>
              <div>{b.subject}</div>
              <div className="git-fs-xs mt-1">
                {dayjs.unix(b.date).format('YYYY-MM-DD HH:mm')} · 单击看历史 · 双击切换
              </div>
            </>
          }
        >
          <span className="text-wb-text-tertiary git-fs-xs flex-1 min-w-0 truncate">{b.subject}</span>
        </Tooltip>

        {/* 远端有新提交：知道个数就报个数，算不出来（旧引用已被回收）就只点一颗圆点 */}
        {mark &&
          (mark.count != null ? (
            <Tooltip title={`远端有新提交：${mark.count} 个（自你上次查看后 · 点这一行看历史即可清掉提示）`}>
              <span className="git-chip">↓{mark.count}</span>
            </Tooltip>
          ) : (
            <Tooltip title="远端有新提交（自你上次查看后 · 点这一行看历史即可清掉提示）">
              <span className="w-[7px] h-[7px] rounded-full bg-wb-info shrink-0" />
            </Tooltip>
          ))}

        {/* 本地分支：待推送 / 待拉取 / 上游已删 */}
        {!b.remote && b.ahead > 0 && (
          <Tooltip title={`待推送：本地领先上游 ${b.ahead} 个提交`}>
            <span className="git-chip is-hot">↑{b.ahead}</span>
          </Tooltip>
        )}
        {!b.remote && b.behind > 0 && (
          <Tooltip title={`待拉取：本地落后上游 ${b.behind} 个提交`}>
            <span className="git-chip">↓{b.behind}</span>
          </Tooltip>
        )}
        {!b.remote && b.gone && (
          <Tooltip title="上游分支已不存在（远端已删掉它）">
            <span className="git-chip">上游已删</span>
          </Tooltip>
        )}

        <span className="git-hash shrink-0 !w-auto">{b.shortHash}</span>
      </div>
    </Dropdown>
  );
}

export function BranchPanel() {
  const branches = useGitStore((s) => s.branches);
  const repoInfo = useGitStore((s) => s.repoInfo);
  const remotes = useGitStore((s) => s.remotes);
  const viewBranch = useGitStore((s) => s.viewBranch);
  const checkout = useGitStore((s) => s.checkout);
  const updateCount = useGitStore((s) => Object.keys(s.remoteUpdates).length);
  const clearRemoteUpdates = useGitStore((s) => s.clearRemoteUpdates);
  const [modalOpen, setModalOpen] = useState(false);
  const [newName, setNewName] = useState('');
  /** 分组折叠态：'local' / 'remote' / `remote:${名字}` */
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const isOpen = (key: string) => open[key] !== false;
  const toggleGroup = (key: string) => setOpen((prev) => ({ ...prev, [key]: !isOpen(key) }));

  const current = repoInfo?.branch ?? null;
  const local = branches?.local ?? [];
  const remote = branches?.remote ?? [];
  /* 远端分支按 remote 名（origin / upstream…）分组，和 IDEA 的 Remote 树一致 */
  const remoteGroups = remote.reduce<Record<string, BranchInfo[]>>((acc, b) => {
    const remoteName = b.name.split('/')[0] ?? 'remote';
    (acc[remoteName] ??= []).push(b);
    return acc;
  }, {});

  /*
   * 远端名 → 托管平台标签。远端名（origin / upstream）本身不含任何平台信息，
   * 而「这条分支要去哪儿提 PR」正是看到远端时第一个问题，所以在分组标题上补一句。
   * 判定见 utils/remotes.ts；还没读到远端配置时返回 null（不显示，也不猜）。
   */
  const remoteLabel = (name: string) => (remotes ?? []).find((r) => r.name === name)?.label ?? null;

  /* 历史图在看哪条分支：跟随 HEAD 时 = 当前分支 */
  const viewedRef = viewBranch ? viewBranch.ref : local.find((b) => b.name === current)?.ref ?? null;

  const createBranch = async () => {
    const name = newName.trim();
    if (!name) return;
    setModalOpen(false);
    setNewName('');
    /* 基于当前 HEAD 建新分支并切换 */
    await checkout('HEAD', name);
  };

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center gap-1 px-2 py-1 border-b border-wb-border-l1 shrink-0">
        <span className="text-wb-text-secondary git-fs-sm font-medium flex-1">分支</span>
        <Tooltip title="基于当前 HEAD 新建分支">
          <Button size="small" type="text" icon={<PlusOutlined />} onClick={() => setModalOpen(true)}>
            新建
          </Button>
        </Tooltip>
      </div>

      <div className="overflow-y-auto flex-1 min-h-0">
        <GroupHead title="本地" count={local.length} open={isOpen('local')} onToggle={() => toggleGroup('local')} />
        {isOpen('local') &&
          local.map((b) => (
            <BranchRow key={b.ref} b={b} isCurrent={b.name === current} isViewed={b.ref === viewedRef} />
          ))}

        {remote.length > 0 && (
          <>
            <GroupHead title="远端" count={remote.length} open={isOpen('remote')} onToggle={() => toggleGroup('remote')} />
            {isOpen('remote') &&
              Object.entries(remoteGroups).map(([remoteName, list]) => {
                const gk = `remote:${remoteName}`;
                return (
                  <div key={remoteName}>
                    <GroupHead
                      title={remoteName}
                      count={list.length}
                      open={isOpen(gk)}
                      onToggle={() => toggleGroup(gk)}
                      indent={12}
                      hint={remoteLabel(remoteName)}
                    />
                    {isOpen(gk) &&
                      list.map((b) => (
                        <BranchRow key={b.ref} b={b} isCurrent={false} isViewed={b.ref === viewedRef} />
                      ))}
                  </div>
                );
              })}
          </>
        )}

        {updateCount > 0 && (
          <div className="px-2 pt-2">
            <Button size="small" type="link" className="git-fs-xs px-0 h-auto" onClick={clearRemoteUpdates}>
              清掉全部远端更新提示（{updateCount}）
            </Button>
          </div>
        )}

        <div className="px-2 py-2 text-wb-text-tertiary git-fs-xs leading-relaxed">
          单击查看历史（不切换）· 双击切换
          <br />
          右键：查看 / 切换 / 合并 / 删除（改状态前都会先确认）
          <br />
          <span className="text-wb-info">↓N</span> 远端有新提交 ·{' '}
          <span className="text-wb-brand">↑N</span> 有待推送的提交
          <br />
          Pull = 把所选分支快进到远端最新（不产生合并提交）
        </div>
      </div>

      <Modal
        title="新建分支"
        open={modalOpen}
        onOk={() => void createBranch()}
        onCancel={() => setModalOpen(false)}
        okText="创建并切换"
        cancelText="取消"
        width={380}
      >
        <Input
          placeholder="分支名（如 feature/xxx）"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onPressEnter={() => void createBranch()}
          autoFocus
        />
        <div className="text-wb-text-tertiary git-fs-xs mt-2">
          基于当前 HEAD（{current ?? '分离头指针'}）创建并立即切换
        </div>
      </Modal>
    </div>
  );
}

export default BranchPanel;
