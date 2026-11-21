/*
 * 模块挂载点
 * ------------------------------------------------------------------
 * 负责把当前激活的模块渲染出来，并处理三件事：
 *   1. 懒挂载：模块首次被访问才挂载，避免启动时把所有模块的副作用都跑一遍
 *   2. 保活：keepAlive 的模块切走后不卸载，用 display:none 隐藏，保留滚动位置与连接
 *   3. 隔离：每个模块外面套一层 ErrorBoundary，一个模块崩了不影响工作台外壳
 * @Author: fu
 */
import React, { Component, Suspense, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Empty, Result, Spin, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { getModule } from '@/core/registry';
import type { WorkbenchModule } from '@/core/types';

const { Paragraph, Text } = Typography;

/* =============================================
   ====== 模块级错误边界 ======
   ============================================= */
interface BoundaryProps {
  moduleId: string;
  children: React.ReactNode;
}

interface BoundaryState {
  error: Error | null;
}

class ModuleErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error(`[workbench] 模块 ${this.props.moduleId} 渲染异常`, error, info);
  }

  /*
   * 防御性兜底：万一将来有调用方复用同一个边界实例去渲染不同模块，
   * 这里能把上一个模块的错误状态清掉，否则会一直卡在错误页。
   *
   * 当前调用方（ModulePane）用 key={module.id} 让每个模块拥有独立实例，
   * 所以这段平时不会触发 —— 原来的注释写「切换模块时清掉」是**不准确**的。
   */
  componentDidUpdate(prev: BoundaryProps): void {
    if (prev.moduleId !== this.props.moduleId && this.state.error) {
      this.setState({ error: null });
    }
  }

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="h-full w-full flex items-center justify-center p-6">
        <Result
          status="error"
          title="这个模块出错了"
          subTitle="其它模块不受影响，可以继续使用。"
          extra={[
            <Button
              key="retry"
              type="primary"
              icon={<ReloadOutlined />}
              onClick={() => this.setState({ error: null })}
            >
              重试
            </Button>,
          ]}
        >
          <Paragraph>
            <Text type="danger" style={{ fontFamily: 'monospace', fontSize: 12 }}>
              {error.message || String(error)}
            </Text>
          </Paragraph>
        </Result>
      </div>
    );
  }
}

/* =============================================
   ====== 模块容器 ======
   ============================================= */
interface ModulePaneProps {
  module: WorkbenchModule;
  visible: boolean;
}

/* 模块首次加载（React.lazy 的 chunk 还没到位）时的占位 */
const ModuleLoading: React.FC = () => (
  <div className="h-full w-full flex items-center justify-center">
    <Spin size="large" />
  </div>
);

const ModulePane: React.FC<ModulePaneProps> = ({ module, visible }) => {
  const Comp = module.component;
  /*
   * 隐藏用 display:none：保留 DOM（组件状态 / 滚动位置 / 长连接都在），
   * 但**会丢弃布局** —— 被隐藏期间量到的尺寸是 0。
   * 模块若需要「不可见时也测量容器」，必须自己处理这一点。
   * （原先这里的注释写的是「用 visibility/position 让布局尺寸保持稳定」，
   *   与代码不符 —— 代码用的是 display:none。）
   *
   * ------------------------------------------------------------------
   * 面板本身是**纵向滚动容器**。
   *
   * 原来这里是 overflow-hidden：内容一旦高过面板就被**直接裁掉**，滚不到 ——
   * 表现就是「除了侧边栏，中间的内容整体滑不动」。
   * 外壳没法替模块决定「该不该滚」，所以按**根节点有没有高度**自动分流：
   *
   *   · 文档式模块（jvm / maven / spring / aipassport / balances）
   *     根节点只有 padding、没有高度 → 内容可以高过面板 → 由**面板**滚动。
   *   · 整屏式模块（home / settings / logsight）
   *     根节点自带 h-full（内部再 overflow-y-auto）→ 高度恒等于面板 →
   *     面板永远不溢出，滚动仍归模块内部，**不会出现双层滚动条**。
   *
   * 横向保持 hidden：横向溢出交给模块自己处理（如 AntD Table 的内部横向滚动），
   * 面板不开横向滚动条。CSS 里 y 轴非 visible 时 x 轴会自动变 auto，
   * 所以这里必须显式写 hidden 才压得住。
   */
  return (
    <div
      className="absolute inset-0 overflow-y-auto overflow-x-hidden"
      style={{
        display: visible ? 'block' : 'none',
        backgroundColor: 'var(--wb-bg-base)',
      }}
      data-module-pane={module.id}
    >
      <ModuleErrorBoundary moduleId={module.id}>
        {/*
         * Suspense 必须在错误边界**里面**：
         *   Suspense 负责「正在加载」，错误边界负责「真的出错了」。
         *
         * 之前全仓没有任何 Suspense 边界（只 import 了却没用），于是
         * React.lazy 的挂起在同步更新里会直接抛错并被错误边界接管，
         * 表现为「这个模块出错了」—— 这正是 useDeferredValue 那条修复要绕开的现象。
         * 那一版修完忘了补加载态，导致：首次进入模块（如 531KB 的 LogSight）
         * 期间没有任何指示，应用启动时初始模块也会先渲染成空白。
         */}
        <Suspense fallback={<ModuleLoading />}>
          <Comp moduleId={module.id} />
        </Suspense>
      </ModuleErrorBoundary>
    </div>
  );
};

/* =============================================
   ====== 挂载点主体 ======
   ============================================= */
interface ModuleHostProps {
  /** 当前激活的模块 id */
  activeModuleId: string;
}

const ModuleHost: React.FC<ModuleHostProps> = ({ activeModuleId }) => {
  const active = getModule(activeModuleId);
  /* 已挂载过的模块 id 集合（只增不减，保证保活语义） */
  const [mountedIds, setMountedIds] = useState<string[]>([]);
  const prevActiveRef = useRef<string | null>(null);

  /* 激活变化：登记挂载、触发 onActivate / onDeactivate */
  useEffect(() => {
    const prevId = prevActiveRef.current;
    if (prevId === activeModuleId) return;
    prevActiveRef.current = activeModuleId;

    const prev = getModule(prevId);
    try {
      prev?.onDeactivate?.();
    } catch (e) {
      console.warn('[workbench] onDeactivate 异常', e);
    }

    if (active) {
      setMountedIds((ids) => (ids.includes(active.id) ? ids : [...ids, active.id]));
      try {
        active.onActivate?.();
      } catch (e) {
        console.warn('[workbench] onActivate 异常', e);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeModuleId]);

  /*
   * 关键点：用 deferred 值驱动面板渲染。
   * 模块主体多为 React.lazy，首次进入时会在渲染中挂起（suspend）。
   * 如果这次渲染是由点击引发的同步更新，React 18 会直接报
   * "A component suspended while responding to synchronous input" 并让错误边界接管。
   * 把 activeModuleId 延迟一档，挂起就变成非紧急更新，Suspense 正常显示加载态。
   */
  const deferredActiveId = useDeferredValue(activeModuleId);

  /* 当前需要渲染的模块：保活的 + 当前激活的 */
  const panes = useMemo(() => {
    const keepIds = mountedIds.filter((id) => getModule(id)?.keepAlive);
    const ids = keepIds.includes(deferredActiveId) ? keepIds : [...keepIds, deferredActiveId];
    return ids
      .map((id) => getModule(id))
      .filter((m): m is WorkbenchModule => Boolean(m));
  }, [mountedIds, deferredActiveId]);

  if (!active) {
    return (
      <div className="h-full w-full flex items-center justify-center">
        <Empty description="没有找到这个模块，可能已被移除" />
      </div>
    );
  }

  return (
    <div className="relative h-full w-full overflow-hidden">
      {panes.map((m) => (
        <ModulePane key={m.id} module={m} visible={m.id === deferredActiveId} />
      ))}
    </div>
  );
};

export default ModuleHost;
