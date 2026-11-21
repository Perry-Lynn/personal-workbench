/*
 * LogSight 模块主体
 * ------------------------------------------------------------------
 * 由原来的 LogSight 独立应用 App.tsx 改造而来，改动点：
 *   1. 移除全局 ConfigProvider —— 主题由工作台统一提供（core/theme.ts）
 *   2. 移除窗口级标题栏 —— 改为模块内工具栏，只保留本模块自己的操作
 *   3. 主题状态改读 useWorkbenchStore，模块 store 不再持有 theme
 *   4. 主密钥改读 useWorkbenchStore，模块内不再自己恢复/缓存
 *   5. 侧栏折叠改为模块内部状态，不再与工作台侧栏耦合
 * 业务逻辑（SSH 事件监听、服务器导入导出）保持原样。
 * @Author: fu
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Layout, Button, Tag, Tooltip, Dropdown, App as AntApp } from 'antd';
import type { MenuProps } from 'antd';
import {
  SettingOutlined,
  ImportOutlined,
  ExportOutlined,
  ReloadOutlined,
  DatabaseOutlined,
  MenuFoldOutlined,
  WarningOutlined,
  InfoCircleOutlined,
} from '@ant-design/icons';
import { listen } from '@tauri-apps/api/event';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import ServerListPanel from '@logsight/components/ServerListPanel';
import ServerConnectionDialog from '@logsight/components/ServerConnectionDialog';
import LogViewerTabs from '@logsight/components/LogViewerTabs';
import type { ServerConfig, LogTab } from '@logsight/types';
import { listServers, saveServer, stopTail } from '@logsight/services/tauriApi';
import { decryptSecret } from '@/core/masterKey';
import { exportTextFile } from '@/core/export';
import { useWorkbenchStore } from '@/store/useWorkbenchStore';
import { useLogSightStore } from '@logsight/store/useLogSightStore';
import { LOGSIGHT_VERSION } from '@logsight/version';

/* 模块样式随模块代码一起按需加载 */
import '@logsight/logsight.css';

dayjs.extend(relativeTime);

const { Content } = Layout;

const LogSightModule: React.FC = () => {
  const { message, modal } = AntApp.useApp();

  const servers = useLogSightStore((s) => s.servers);
  const setServers = useLogSightStore((s) => s.setServers);
  const addOrUpdateServer = useLogSightStore((s) => s.addOrUpdateServer);
  const setSecret = useLogSightStore((s) => s.setSecret);

  /* 主密钥是工作台级能力：启动时已由 main.tsx 触发恢复，这里只消费状态 */
  const masterKeyStatus = useWorkbenchStore((s) => s.masterKeyStatus);
  const masterKeyError = useWorkbenchStore((s) => s.masterKeyError);
  const masterKeyWarning = useWorkbenchStore((s) => s.masterKeyWarning);
  const ensureMasterKey = useWorkbenchStore((s) => s.ensureMasterKey);
  const rebuildMasterKey = useWorkbenchStore((s) => s.rebuildMasterKey);

  const dialogVisible = useLogSightStore((s) => s.connectionDialogVisible);
  const dialogEditingId = useLogSightStore((s) => s.connectionDialogEditingId);
  const openConnectionDialog = useLogSightStore((s) => s.openConnectionDialog);
  const closeConnectionDialog = useLogSightStore((s) => s.closeConnectionDialog);

  const tabs = useLogSightStore((s) => s.tabs);
  const activeTabKey = useLogSightStore((s) => s.activeTabKey);
  const setActiveTab = useLogSightStore((s) => s.setActiveTab);
  const addTab = useLogSightStore((s) => s.addTab);
  const removeTab = useLogSightStore((s) => s.removeTab);
  const appendLinesToTab = useLogSightStore((s) => s.appendLinesToTab);
  const updateTabBySessionId = useLogSightStore((s) => s.updateTabBySessionId);

  /* 模块内服务器列表折叠（原为应用级侧栏，现收进模块内部） */
  const [siderCollapsed, setSiderCollapsed] = useState(false);
  const toggleSider = useCallback(() => setSiderCollapsed((p) => !p), []);

  const initializationStartedRef = useRef(false);

  /** 初始化：取工作台主密钥 + 拉取服务器列表 + 解密每个服务器的密码/私钥 */
  useEffect(() => {
    // React StrictMode 在开发环境会重复执行 effect，避免并发初始化同一个 sled 数据库。
    if (initializationStartedRef.current) return;
    initializationStartedRef.current = true;

    const loadServersWithSecrets = async (master: string) => {
      const list = await listServers();
      setServers(list);
      // 解密各服务器的密码/私钥缓存到内存
      for (const s of list) {
        try {
          if (s.password_cipher) {
            const pwd = await decryptSecret(s.password_cipher, master);
            setSecret(s.id, pwd);
          }
          if (s.private_key_cipher) {
            const pem = await decryptSecret(s.private_key_cipher, master);
            setSecret(s.id, undefined, pem);
          }
        } catch (_) {
          /* 解密失败不阻塞，用户可编辑服务器重新录入凭据 */
        }
      }
    };

    (async () => {
      try {
        // 主密钥由工作台统一下发（按需恢复：首次进入 LogSight 时才向系统钥匙串取密钥），
        // 模块不再自己管理密钥；启动时不预热正是为了避免每次开应用都被弹 Apple 密码框。
        const master = await ensureMasterKey();
        await loadServersWithSecrets(master);
      } catch (e: any) {
        const errorText = e?.message || '请检查 Rust 后端是否正常编译运行';
        message.error(`LogSight 初始化失败：${errorText}`);
        // 钥匙串里没有主密钥、但本地已有加密数据：给用户一条明确的重建路径
        if (String(errorText).includes('系统钥匙串中找不到应用主密钥')) {
          modal.confirm({
            title: '本地密钥不可用',
            content:
              '无法从系统钥匙串恢复旧的应用主密钥。可以先取消并恢复钥匙串；如果确认无法恢复，可重建本地密钥。重建后服务器地址等配置会保留，但旧密码和私钥密文需要重新录入。',
            okText: '重建本地密钥',
            cancelText: '稍后处理',
            okButtonProps: { danger: true },
            onOk: async () => {
              try {
                const master = await rebuildMasterKey();
                await loadServersWithSecrets(master);
                message.success('本地密钥已重建；请编辑已有服务器，重新录入密码或私钥');
              } catch (resetError: any) {
                message.error(`重建失败：${resetError?.message || '请稍后重试'}`);
              }
            },
          });
        }
      }
    })();
  }, [ensureMasterKey, rebuildMasterKey, setServers, setSecret, message, modal]);

  /** 注册 Tauri 事件：后端会话状态变化 + 日志行批量推送 */
  useEffect(() => {
    const unlistens: Array<() => void> = [];
    (async () => {
      const u1 = await listen('logsight:log-session-status', (e) => {
        const payload = e.payload as any;
        const { session_id, status, message: msg } = payload ?? {};
        if (!session_id) return;
        updateTabBySessionId(session_id, {
          status,
          last_message: msg ?? undefined,
        });
      });
      unlistens.push(() => u1());

      const u2 = await listen('logsight:log-lines', (e) => {
        const payload = e.payload as any;
        const { session_id, lines } = payload ?? {};
        if (!session_id || !Array.isArray(lines)) return;
        appendLinesToTab(session_id, lines);
      });
      unlistens.push(() => u2());

      const u3 = await listen('workbench:app-closing', () => {
        // 窗口关闭前：主动请求停止所有流式会话
        tabs.forEach(async (t) => {
          if (t.session_id) {
            try {
              await stopTail(t.session_id);
            } catch (_) {}
          }
        });
      });
      unlistens.push(() => u3());
    })();
    return () => unlistens.forEach((u) => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appendLinesToTab, updateTabBySessionId]);

  /** 从服务器列表双击/菜单点击 "打开日志" -> 创建新标签页 */
  const handleOpenLog = useCallback(
    (server: ServerConfig) => {
      // 首次连接空白：remote_path = "", 路径输入框留空
      // 后续有历史记录时，LogViewerTabs 会从该服务器历史里取最新一条回填
      const tabKey = `tab_${server.id}_${Date.now()}`;
      const tab: LogTab = {
        key: tabKey,
        server_id: server.id,
        server_snapshot: server,
        remote_path: '',
        title: server.title,
        session_id: null,
        status: 'Idle',
        lines: [],
        total_lines: 0,
        last_message: '请输入或选择日志文件路径，然后点击 Tail -F 或 历史',
      };
      addTab(tab);
    },
    [addTab],
  );

  /** 连接对话框保存成功回调 */
  const handleServerSaved = useCallback(
    (s: ServerConfig) => {
      addOrUpdateServer(s);
      closeConnectionDialog();
    },
    [addOrUpdateServer, closeConnectionDialog],
  );

  /* 导出全部服务器配置（JSON，敏感字段保持密文）
   * ⚠️ 走 core/export 的系统保存对话框，**不要改回 Blob + `a[download]`**：
   * 后者在本应用的 WKWebView 里会被静默取消（点了没反应），见 core/export.ts */
  const handleExportServers = async () => {
    if (!servers.length) return message.warning('暂无服务器可导出');
    try {
      const path = await exportTextFile(
        `logsight-servers_${dayjs().format('YYYYMMDD-HHmmss')}.json`,
        JSON.stringify(servers, null, 2),
        { label: 'JSON', ext: 'json' },
      );
      /* 用户取消：不是错误 */
      if (!path) return;
      message.success(`已导出 ${servers.length} 台服务器配置（密文）`);
    } catch (e) {
      message.error(e instanceof Error ? e.message : '导出失败');
    }
  };

  /** 导入服务器配置 JSON */
  const handleImportServers = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      /*
       * 主密钥来自工作台 store。正常启动时 main.tsx 已经预热完成；
       * 若这里仍为空，说明启动恢复流程失败了，直接把原因讲清楚。
       */
      const master = useWorkbenchStore.getState().masterKey;
      if (!master) {
        const reason = useWorkbenchStore.getState().masterKeyError;
        message.error(
          reason
            ? `应用主密钥尚未就绪，暂不能导入：${reason}`
            : '应用主密钥尚未就绪，暂不能导入。请稍候重试，或到「设置 - 本地密钥」查看状态。',
        );
        return;
      }
      try {
        const text = await f.text();
        const arr = JSON.parse(text) as ServerConfig[];
        if (!Array.isArray(arr)) throw new Error('文件格式错误');
        let ok = 0;
        let locked = 0;
        let scriptsDisabled = 0;
        for (const s of arr) {
          if (!s || typeof s !== 'object' || !s.host || !s.username || !s.title) continue;
          const imported = {
            ...s,
            // 导入永远创建新记录，避免静默覆盖当前服务器配置。
            id: '',
            // 外部 JSON 不可信，导入后不自动执行其中的远程脚本。
            run_scripts_enabled: false,
            run_scripts: [],
          } as ServerConfig;
          if (s.run_scripts_enabled && s.run_scripts?.length) scriptsDisabled++;
          let passwordPlain: string | null = null;
          let privateKeyPemPlain: string | null = null;
          let credentialsLocked = false;
          try {
            if (s.password_cipher) {
              passwordPlain = await decryptSecret(s.password_cipher, master);
            }
            if (s.private_key_cipher) {
              privateKeyPemPlain = await decryptSecret(s.private_key_cipher, master);
            }
          } catch (_) {
            // 跨安装导入的密文可能属于另一把主密钥；先保留配置，提示用户重新录入凭据。
            locked++;
            credentialsLocked = true;
          }
          if (credentialsLocked) {
            // 失效密文不能继续伪装成可用凭据，避免后续连接反复失败。
            imported.password_cipher = null;
            imported.private_key_cipher = null;
          }
          const saved = await saveServer(
            imported,
            passwordPlain,
            privateKeyPemPlain,
            master,
          );
          addOrUpdateServer(saved);
          if (passwordPlain) setSecret(saved.id, passwordPlain);
          if (privateKeyPemPlain) setSecret(saved.id, undefined, privateKeyPemPlain);
          ok++;
        }
        const skipped = arr.length - ok;
        message.success(
          `成功导入 ${ok} 台服务器${locked ? `，其中 ${locked} 台凭据需要重新录入` : ''}${scriptsDisabled ? `，已禁用 ${scriptsDisabled} 台配置中的自动脚本` : ''}${skipped ? `，跳过 ${skipped} 条无效记录` : ''}`,
        );
      } catch (e: any) {
        message.error(e?.message || '导入失败');
      }
    };
    input.click();
  };

  /* 模块工具栏菜单 */
  const toolsMenu: MenuProps = {
    items: [
      {
        key: 'import',
        icon: <ImportOutlined />,
        label: '导入服务器配置 (.json)',
        onClick: handleImportServers,
      },
      {
        key: 'export',
        icon: <ExportOutlined />,
        label: '导出全部服务器配置',
        onClick: handleExportServers,
      },
      { type: 'divider' },
      {
        key: 'reload',
        icon: <ReloadOutlined />,
        label: '重新加载服务器列表',
        onClick: async () => {
          try {
            const list = await listServers();
            setServers(list);
            message.success(`已加载 ${list.length} 台`);
          } catch (e: any) {
            message.error(e?.message);
          }
        },
      },
    ],
  };

  const totalRunningTabs = useMemo(
    () => tabs.filter((t) => t.status === 'Streaming' || t.status === 'Connected').length,
    [tabs],
  );

  return (
    <Layout
      className="logsight-root-layout"
      style={{ backgroundColor: 'var(--wb-bg-base)', color: 'var(--wb-text-primary)' }}
    >
      {/* ===== 模块工具栏（原窗口标题栏，现在只放本模块自己的操作） ===== */}
      <div
        className="flex items-center gap-2 px-3 h-11 flex-shrink-0 border-b"
        style={{
          backgroundColor: 'var(--wb-bg-surface)',
          borderColor: 'var(--wb-border-l1)',
        }}
      >
        <div className="flex items-center gap-2.5">
          <div className="logsight-logo-badge w-6 h-6 rounded-md flex items-center justify-center text-white flex-shrink-0">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3" y="4" width="18" height="16" rx="3" />
              <line x1="7" y1="9" x2="17" y2="9" />
              <line x1="7" y1="13" x2="14" y2="13" />
              <line x1="7" y1="17" x2="12" y2="17" />
            </svg>
          </div>
          <div className="flex items-center gap-2">
            <div
              className=" font-semibold tracking-[0.01em]"
              style={{ color: 'var(--wb-text-primary)', fontSize: 'calc(var(--wb-font-base) - 1px)' }}
            >
              LogSight
            </div>
            <Tag
              color="processing"
              className=" !m-0 !py-0 !px-1.5 !h-4 flex items-center rounded-full"
             style={{ fontSize: 'calc(var(--wb-font-base) - 5px)' }}>
              v{LOGSIGHT_VERSION}
            </Tag>
          </div>
          {totalRunningTabs > 0 && (
            <Tag
              color="success"
              className=" !m-0 !py-0 !px-1.5 !h-4 flex items-center rounded-full"
             style={{ fontSize: 'calc(var(--wb-font-base) - 5px)' }}>
              {totalRunningTabs} 流会话中
            </Tag>
          )}
          <Tooltip title={siderCollapsed ? '展开服务器列表' : '收起服务器列表'}>
            <Button
              size="small"
              onClick={toggleSider}
              className="rounded-lg ml-0.5 sider-toggle-btn"
              icon={
                <span
                  className="sider-toggle-icon"
                  style={{ transform: siderCollapsed ? 'rotate(180deg)' : 'rotate(0deg)' }}
                >
                  <MenuFoldOutlined />
                </span>
              }
            />
          </Tooltip>
        </div>

        <div className="flex-1" />

        <Tooltip title="新建服务器连接">
          <Button
            type="primary"
            size="small"
            icon={<DatabaseOutlined />}
            onClick={() => openConnectionDialog(null)}
            className="logsight-btn-primary-glow rounded-lg"
          >
            新建连接
          </Button>
        </Tooltip>
        <Dropdown menu={toolsMenu} trigger={['click']} placement="bottomRight">
          <Button size="small" icon={<SettingOutlined />} className="rounded-lg" />
        </Dropdown>
      </div>

      {/* 主密钥异常时的常驻提示：初始化问题不能只闪一个 toast 就消失 */}
      {masterKeyStatus === 'error' && (
        <div
          className="flex items-center gap-2 px-3 py-1.5 flex-shrink-0 border-b"
          style={{ backgroundColor: 'var(--wb-bg-selected)',
            borderColor: 'var(--wb-border-l1)',
            color: 'var(--wb-text-secondary)', fontSize: 'calc(var(--wb-font-base) - 3px)' }}
        >
          <WarningOutlined style={{ color: 'var(--wb-warning)' }} />
          <span className="min-w-0 truncate" title={masterKeyError || undefined}>
            本地密钥不可用，服务器密码与私钥暂时无法解密：{masterKeyError || '未知原因'}
          </span>
          <div className="flex-1" />
          <Button size="small" type="link" onClick={() => ensureMasterKey(true).catch(() => {})}>
            重试
          </Button>
        </div>
      )}

      {/* 降级存储提示：功能正常，但要如实告诉用户密钥存在哪儿 */}
      {masterKeyStatus === 'ready' && masterKeyWarning && (
        <div
          className="flex items-center gap-2 px-3 py-1.5 flex-shrink-0 border-b"
          style={{ backgroundColor: 'var(--wb-bg-secondary)',
            borderColor: 'var(--wb-border-l1)',
            color: 'var(--wb-text-tertiary)', fontSize: 'calc(var(--wb-font-base) - 3px)' }}
        >
          <InfoCircleOutlined />
          <span className="min-w-0 truncate" title={masterKeyWarning}>
            {masterKeyWarning}
          </span>
        </div>
      )}

      <Layout hasSider className="min-h-0 w-full overflow-hidden" style={{ flex: 1 }}>
        {/* 服务器列表：用 wrapper div 控制宽度，CSS transition 实现平滑收起 */}
        <div
          className="shrink-0 h-full overflow-hidden"
          style={{
            width: siderCollapsed ? 0 : 300,
            transition: 'width 0.2s cubic-bezier(.2,.8,.2,1)',
          }}
        >
          <div
            className="h-full border-r"
            style={{
              width: 300,
              backgroundColor: 'var(--wb-bg-sider)',
              borderColor: 'var(--wb-border-l1)',
            }}
          >
            <ServerListPanel onOpenLog={handleOpenLog} />
          </div>
        </div>

        {/* 右侧：多标签日志查看 */}
        <Content
          className="min-h-0 h-full min-w-0 overflow-hidden"
          style={{ flex: 1, backgroundColor: 'var(--wb-bg-base)' }}
        >
          <LogViewerTabs
            tabs={tabs}
            activeKey={activeTabKey}
            onChange={setActiveTab}
            onRemove={removeTab}
          />
        </Content>
      </Layout>

      {/* 连接配置弹窗 */}
      <ServerConnectionDialog
        visible={dialogVisible}
        editingId={dialogEditingId}
        onCancel={closeConnectionDialog}
        onSaved={handleServerSaved}
      />
    </Layout>
  );
};

export default LogSightModule;
