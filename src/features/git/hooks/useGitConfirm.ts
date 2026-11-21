/*
 * Git 模块 · 操作二次确认
 * ------------------------------------------------------------------
 * 为什么要有它：切换分支 / 合并 / 删除都是**会改工作区或历史**的动作，
 * 点一下就走完太容易误触（尤其是分支列表里的双击和右键菜单）。
 * 统一收口到这一个 hook，保证「不管从哪个入口触发」都先问一句、由用户拍板。
 *
 * 用 App.useApp() 的 modal 而不是 Modal.confirm 静态方法：
 * 静态方法拿不到 ConfigProvider 的主题上下文（换肤/字号会不生效），
 * 这也与本仓其它模块（见 jvm/JvmView.tsx）的做法一致。
 * @Author: fu
 */
import { App as AntApp } from 'antd';
import type { ReactNode } from 'react';
import { useCallback } from 'react';

export interface ConfirmOptions {
  title: string;
  /** 补充说明：把「会发生什么」讲清楚，用户才好判断 */
  content?: ReactNode;
  okText?: string;
  /** 破坏性操作（删除之类）用红色确认按钮 */
  danger?: boolean;
  /** 返回 Promise 时对话框保持 loading 直到操作真正结束 */
  onOk: () => void | Promise<void>;
}

export function useGitConfirm(): {
  confirm: (opts: ConfirmOptions) => void;
  /**
   * 纯告知，没有「做 / 不做」的选项。
   * 用在「目标定不下来」这类情况：用户点了按钮，但动作没能开始 ——
   * 必须当场把原因说清楚，只往顶部通知条里塞一句话太容易被错过。
   */
  alert: (opts: { title: string; content?: ReactNode }) => void;
} {
  const { modal } = AntApp.useApp();

  const confirm = useCallback(
    ({ title, content, okText = '确定', danger, onOk }: ConfirmOptions) => {
      modal.confirm({
        title,
        content,
        okText,
        cancelText: '取消',
        okButtonProps: danger ? { danger: true } : undefined,
        onOk: () => onOk(),
      });
    },
    [modal],
  );

  const alert = useCallback(
    ({ title, content }: { title: string; content?: ReactNode }) => {
      modal.info({ title, content, okText: '知道了' });
    },
    [modal],
  );

  return { confirm, alert };
}
