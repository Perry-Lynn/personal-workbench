/*
 * Git 模块 · 带确认的操作入口（唯一出口）
 * ------------------------------------------------------------------
 * 「会改工作区 / 历史 / 远端」的动作全部收口在这里：
 *   切换分支、合并、删除分支、拉取、推送
 *
 * 为什么必须收口：这些动作有**四个入口**（顶栏下拉、分支列表双击、
 * 分支右键菜单、键盘快捷键）。任何一个入口直接调 store 动作，
 * 都会绕过确认 ——「不管从哪触发都要先问一句」这条就守不住了。
 *
 * 动作本身仍走 useGitStore；这里只负责「问清楚再动手」。
 * 用 getState() 取动作而不是逐个订阅：动作引用在 zustand 里是稳定的，
 * 订阅只会在仓库态变化时白白多渲染一次。
 * @Author: fu
 */
import { useGitConfirm } from './useGitConfirm';
import { useGitStore } from '../store/useGitStore';
import { resolvePullTarget } from '../utils/pullTarget';

export interface GitOps {
  askCheckout: (name: string, isCurrent?: boolean) => void;
  askMerge: (name: string) => void;
  askDeleteBranch: (name: string, force: boolean) => void;
  askPull: () => void;
  askPush: () => void;
  /** fetch 只更新远端引用、不碰工作区，不需要确认 */
  doFetch: () => void;
}

export function useGitOps(): GitOps {
  const { confirm, alert } = useGitConfirm();
  /* 只有这两个值要参与渲染（对话框文案要用），其余动作走 getState() */
  const repoInfo = useGitStore((s) => s.repoInfo);
  const currentName = repoInfo?.branch ?? null;
  const ahead = repoInfo?.ahead ?? 0;

  return {
    askCheckout: (name, isCurrent = false) => {
      if (isCurrent) return;
      confirm({
        title: `切换到分支 ${name}？`,
        content: (
          <span>
            当前分支：<b>{currentName ?? '（分离头指针）'}</b>
            <br />
            工作区里未提交的修改会被带过去；若与目标分支冲突，git 会拒绝切换并给出提示。
          </span>
        ),
        okText: '切换',
        onOk: () => useGitStore.getState().checkout(name),
      });
    },

    askMerge: (name) => {
      confirm({
        title: `把 ${name} 合并到 ${currentName ?? '当前分支'}？`,
        content: '合并会在当前分支产生一个合并提交。若有冲突，可在冲突面板打开文件、标记已解决并继续或中止合并。',
        okText: '合并',
        onOk: () => useGitStore.getState().mergeBranch(name),
      });
    },

    askDeleteBranch: (name, force) => {
      confirm({
        title: force ? `强制删除分支 ${name}？` : `删除分支 ${name}？`,
        content: force
          ? '强制删除（-D）：即使该分支上的提交还没合并到其它分支，也会直接丢掉这条分支引用，未合并的提交将不再有分支指向它。'
          : '安全删除（-d）：如果该分支还有未合并的提交，git 会拒绝删除并给出提示。',
        okText: force ? '强制删除' : '删除',
        danger: true,
        onOk: () => useGitStore.getState().deleteBranch(name, force),
      });
    },

    /*
     * 拉取：把**所选分支**更新到远端最新，且只快进（不产生合并提交）。
     *
     * 刻意不做 `git pull` —— 那是 fetch + 把远端提交合并进当前分支，可能凭空多出一个
     * 合并提交，还会把你正在做的分支拽进来。这里的三种情形在确认框里逐条写明，
     * 用户点「拉取」之前就知道会发生什么、不会发生什么。
     */
    askPull: () => {
      const s = useGitStore.getState();
      const r = resolvePullTarget({
        viewBranch: s.viewBranch,
        branches: s.branches,
        currentUpstream: s.status?.upstream ?? s.repoInfo?.upstream ?? null,
      });
      /* 定不下目标就不弹确认框（点了确认也没有明确后果），直接说明原因 */
      if (!r.ok) {
        alert({ title: '无法确定要拉哪个远端分支', content: r.reason });
        return;
      }
      const upstream = `${r.target.remote}/${r.target.branch}`;
      const branch = r.target.branch;
      const isCheckedOut = branch === currentName;

      /* ① 选中的是远端分支：只动那一个远端引用 */
      if (!r.target.updateLocal) {
        confirm({
          title: `只更新 ${upstream} 的远端状态？`,
          content: (
            <span>
              只会刷新 <b>{upstream}</b> 这一个远端引用：
              <br />
              · <b>不碰</b>任何本地分支、不切换分支、不动工作区
              <br />
              · 想看它的新提交内容，点它那一行看历史即可
              <br />
              <br />
              想把远端提交并进某条本地分支：选中那条本地分支再点 Pull（会快进更新它）。
            </span>
          ),
          okText: '拉取',
          onOk: () => useGitStore.getState().pullSelectedBranch(),
        });
        return;
      }

      /* ② 选中的本地分支就是当前检出分支：会快进并同步工作区 */
      if (isCheckedOut) {
        confirm({
          title: `把当前分支 ${branch} 快进到 ${upstream} 的最新提交？`,
          content: (
            <span>
              当前检出的就是 <b>{branch}</b>，所以这次会把<b>工作区</b>一起更新到远端最新：
              <br />
              · <b>只快进</b>，不产生合并提交、不切换分支
              <br />
              · 若本地 {branch} 上有远端没有的提交（历史已分叉），git 会拒绝并保持原样
              <br />
              · 若工作区有会被覆盖的改动，git 会拒绝并保持原样
              <br />
              <br />
              要在当前分支上产生真正的合并提交：分支右键 → 合并到当前分支。
            </span>
          ),
          okText: '拉取',
          onOk: () => useGitStore.getState().pullSelectedBranch(),
        });
        return;
      }

      /* ③ 选中的是别的本地分支：快进它自己，当前的检出分支完全不动 */
      confirm({
        title: `把本地分支 ${branch} 更新到 ${upstream} 的最新提交？`,
        content: (
          <span>
            只会把 <b>{branch}</b> 这条本地分支快进到 {upstream} 的最新提交：
            <br />
            · <b>不切换</b>分支、<b>不动</b>工作区里的任何文件
            <br />
            · <b>不产生合并提交</b>，当前检出的 {currentName ?? '（分离头指针）'} 也不受影响
            <br />
            · 若 {branch} 上有远端没有的提交（历史已分叉），git 会拒绝并保持原样
          </span>
        ),
        okText: '拉取',
        onOk: () => useGitStore.getState().pullSelectedBranch(),
      });
    },

    askPush: () => {
      confirm({
        title: '推送当前分支到远端？',
        content: ahead > 0 ? `将推送 ${ahead} 个本地提交到上游分支。` : '上游已是最新（没有需推送的提交）。',
        okText: '推送',
        onOk: () => useGitStore.getState().push(),
      });
    },

    doFetch: () => useGitStore.getState().fetch(),
  };
}
