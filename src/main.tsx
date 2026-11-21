/*
 * 工作台前端入口
 * ------------------------------------------------------------------
 * 启动顺序很重要：
 *   1. 注册模块（后续所有查询都依赖注册表）
 *   2. 同步主题 class 到 DOM（早于 React 渲染，避免首帧闪白/闪黑）
 *   3. 校验上次打开的模块是否还存在，失效则回落到首页
 *   4. 挂载 React
 *
 * 注意：工作台主密钥**不在启动时恢复**。一旦启动就向系统钥匙串要密钥，
 * macOS 每次打开应用都会弹一次 Apple 密码框，体验很差；而真正需要密钥的
 * 只有 LogSight（解密服务器密码/私钥）。所以主密钥改为「按需恢复」——
 * 首次进入 LogSight 时由模块触发 ensureMasterKey()，钥匙串授权框只在这时出现。
 * 设置页的「重试」按钮也能手动触发。
 * @Author: fu
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { DEFAULT_MODULE_ID, bootstrapModules } from '@/core/modules';
import { getModule } from '@/core/registry';
import { bootstrapWorkbench, useWorkbenchStore } from '@/store/useWorkbenchStore';

import './index.css';

/* 1. 注册全部模块 */
const moduleIds = bootstrapModules();

/* 2. 主题 class 提前落到 html/body */
bootstrapWorkbench();

/* 3. 修正失效的当前模块（例如模块被移除后本地仍记着它的 id） */
(() => {
  const store = useWorkbenchStore.getState();
  if (!getModule(store.activeModuleId)) {
    console.warn(
      `[workbench] 本地记录的模块 "${store.activeModuleId}" 不存在，回落到 ${DEFAULT_MODULE_ID}`,
    );
    store.setActiveModule(DEFAULT_MODULE_ID);
  }
  if (import.meta.env.DEV) {
    console.info(`[workbench] 已注册模块：${moduleIds.join(', ')}`);
  }
})();

/*
 * 工作台主密钥不再于启动时恢复（见文件头注释）：避免每次打开应用都弹 Apple 密码框。
 * 改为「按需恢复」——首次进入需要密钥的模块（LogSight）时由模块触发 ensureMasterKey()。
 */

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
