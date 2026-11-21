/*
 * 工作台根组件
 * ------------------------------------------------------------------
 * 只做两件事：把工作台主题接到 AntD ConfigProvider 上，然后渲染外壳。
 * 具体功能一律在模块里，本文件不应随功能增加而变长。
 * @Author: fu
 */
import React, { useMemo } from 'react';
import { App as AntApp, ConfigProvider } from 'antd';
import { buildAntdConfig } from '@/core/theme';
import { useWorkbenchStore } from '@/store/useWorkbenchStore';
import AppShell from '@/shell/AppShell';

const App: React.FC = () => {
  const theme = useWorkbenchStore((s) => s.theme);
  const fontSize = useWorkbenchStore((s) => s.fontSize);

  /* 主题或基准字号变化时重建 AntD 配置，所有模块的 AntD 组件同步换肤/变字号 */
  const config = useMemo(() => buildAntdConfig(theme, fontSize), [theme, fontSize]);

  return (
    <ConfigProvider {...config}>
      <AntApp>
        <AppShell />
      </AntApp>
    </ConfigProvider>
  );
};

export default App;
