/*
 * JVM 与 Spring · 模块外壳（两个标签页）
 * ------------------------------------------------------------------
 * 合并说明：spring 服务台原来是一个独立模块。它和「JVM 进程」回答的是同一个问题 ——
 * 本机有哪些 Java 进程、占哪个端口、健不健康 —— 分成两个模块只会逼用户在两个列表
 * 之间对 PID。现在它降级成这里的第二个标签页，侧栏少一项，首页少一行。
 *
 * 实现上刻意**不动**那两个视图：
 *   · JvmView 713 行、SpringView 也都是自成一体的页面，重写它们只为「合并」不划算；
 *   · 这里只做一层外壳：一条标签栏 + 二选一渲染，两个视图各自 lazy，切到才加载。
 *
 * 标签栏用 sticky：模块面板本身是滚动容器（见 ModuleHost 的说明），进程多的时候
 * 标签栏要一直看得见，不能跟着内容滚走。
 * @Author: fu
 */
import React, { Suspense, lazy, useState } from 'react';
import { Spin } from 'antd';

import './jvm-tabs.css';

const JvmView = lazy(() => import('./JvmView'));
/* 走门面拿组件，不直接 import spring 的内部实现 */
const SpringPanel = lazy(() =>
  import('@/features/spring/public').then((m) => ({ default: m.SpringPanel })),
);

type Tab = 'process' | 'spring';

const TABS: Array<{ value: Tab; label: string }> = [
  { value: 'process', label: '进程' },
  { value: 'spring', label: 'Spring 服务' },
];

const PaneLoading: React.FC = () => (
  <div className="jvm-pane-loading">
    <Spin size="small" />
  </div>
);

const JvmModuleView: React.FC = () => {
  const [tab, setTab] = useState<Tab>('process');

  return (
    <div className="jvm-module">
      <div className="jvm-tabs" role="tablist" aria-label="JVM 视图切换">
        {TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={tab === t.value}
            className={`jvm-tab${tab === t.value ? ' is-active' : ''}`}
            onClick={() => setTab(t.value)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <Suspense fallback={<PaneLoading />}>
        {tab === 'process' ? <JvmView /> : <SpringPanel />}
      </Suspense>
    </div>
  );
};

export default JvmModuleView;
