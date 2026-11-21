/*
 * 设置模块
 * ------------------------------------------------------------------
 * 工作台级别的偏好设置：外观、侧栏、模块管理、本地数据、关于。
 * 模块自己的设置（如 SSH 默认端口）请放模块内部，不要塞到这里。
 * @Author: fu
 */
import React, { useEffect, useMemo } from 'react';
import {
  Button,
  Divider,
  Popconfirm,
  Segmented,
  Slider,
  Switch,
  Tag,
  Tooltip,
  App as AntApp,
} from 'antd';
import {
  BgColorsOutlined,
  LayoutOutlined,
  AppstoreOutlined,
  DatabaseOutlined,
  InfoCircleOutlined,
  ReloadOutlined,
  KeyOutlined,
  PictureOutlined,
  CheckOutlined,
  DesktopOutlined,
} from '@ant-design/icons';
import { useModules } from '@/core/useModules';
import { MODULE_GROUP_ORDER } from '@/core/types';
import type { ThemeMode } from '@/core/theme';
import { DOCK_ICONS } from '@/core/dockIcon';
import {
  FONT_DEFAULT_SIZE,
  FONT_MAX_SIZE,
  FONT_MIN_SIZE,
  SIDER_DEFAULT_WIDTH,
  SIDER_MAX_WIDTH,
  SIDER_MIN_WIDTH,
  useWorkbenchStore,
} from '@/store/useWorkbenchStore';
import ConfigBackupPanel from './ConfigBackupPanel';

/* =============================================
   ====== 通用分区容器 ======
   ============================================= */
interface SectionProps {
  icon: React.ReactNode;
  title: string;
  hint?: string;
  children: React.ReactNode;
}

const Section: React.FC<SectionProps> = ({ icon, title, hint, children }) => (
  <section
    className="rounded-xl border px-5 py-4 mb-4"
    style={{
      borderColor: 'var(--wb-border-l1)',
      backgroundColor: 'var(--wb-bg-surface)',
      boxShadow: 'var(--wb-shadow-panel)',
    }}
  >
    <div className="flex items-center gap-2 mb-3">
      <span className="" style={{ color: 'var(--wb-text-brand)', fontSize: 'calc(var(--wb-font-base) - 1px)' }}>
        {icon}
      </span>
      <h2 className=" font-semibold m-0" style={{ color: 'var(--wb-text-primary)', fontSize: 'calc(var(--wb-font-base) - 1px)' }}>
        {title}
      </h2>
    </div>
    {hint && (
      <div className=" mb-3 -mt-1" style={{ color: 'var(--wb-text-tertiary)', fontSize: 'calc(var(--wb-font-base) - 3.5px)' }}>
        {hint}
      </div>
    )}
    {children}
  </section>
);

/* 一行「标签 + 控件」 */
interface RowProps {
  label: string;
  desc?: string;
  children: React.ReactNode;
}

const Row: React.FC<RowProps> = ({ label, desc, children }) => (
  <div className="flex items-center justify-between gap-6 py-2.5">
    <div className="min-w-0">
      <div className="" style={{ color: 'var(--wb-text-primary)', fontSize: 'calc(var(--wb-font-base) - 2px)' }}>
        {label}
      </div>
      {desc && (
        <div className=" mt-0.5" style={{ color: 'var(--wb-text-tertiary)', fontSize: 'calc(var(--wb-font-base) - 3.5px)' }}>
          {desc}
        </div>
      )}
    </div>
    <div className="flex-shrink-0">{children}</div>
  </div>
);

/* =============================================
   ====== 设置主体 ======
   ============================================= */
const SettingsModule: React.FC = () => {
  const { message } = AntApp.useApp();
  const modules = useModules();

  const theme = useWorkbenchStore((s) => s.theme);
  const setTheme = useWorkbenchStore((s) => s.setTheme);
  const siderCollapsed = useWorkbenchStore((s) => s.siderCollapsed);
  const setSiderCollapsed = useWorkbenchStore((s) => s.setSiderCollapsed);
  const siderWidth = useWorkbenchStore((s) => s.siderWidth);
  const setSiderWidth = useWorkbenchStore((s) => s.setSiderWidth);
  const fontSize = useWorkbenchStore((s) => s.fontSize);
  const setFontSize = useWorkbenchStore((s) => s.setFontSize);
  const dockIcon = useWorkbenchStore((s) => s.dockIcon);
  const setDockIcon = useWorkbenchStore((s) => s.setDockIcon);
  const backgroundOnClose = useWorkbenchStore((s) => s.backgroundOnClose);
  const backgroundOnCloseLoaded = useWorkbenchStore((s) => s.backgroundOnCloseLoaded);
  const loadBackgroundOnClose = useWorkbenchStore((s) => s.loadBackgroundOnClose);
  const setBackgroundOnClose = useWorkbenchStore((s) => s.setBackgroundOnClose);
  const modulePrefs = useWorkbenchStore((s) => s.modulePrefs);
  const setModulePref = useWorkbenchStore((s) => s.setModulePref);
  const resetModulePrefs = useWorkbenchStore((s) => s.resetModulePrefs);
  const moduleOrder = useWorkbenchStore((s) => s.moduleOrder);
  const resetModuleOrder = useWorkbenchStore((s) => s.resetModuleOrder);

  /* 本地密钥（工作台级能力） */
  const masterKeyStatus = useWorkbenchStore((s) => s.masterKeyStatus);
  const masterKeyError = useWorkbenchStore((s) => s.masterKeyError);
  const masterKeySource = useWorkbenchStore((s) => s.masterKeySource);
  const masterKeyWarning = useWorkbenchStore((s) => s.masterKeyWarning);
  const ensureMasterKey = useWorkbenchStore((s) => s.ensureMasterKey);
  const rebuildMasterKey = useWorkbenchStore((s) => s.rebuildMasterKey);

  const masterKeyTag = {
    idle: { color: 'default', text: '未开始' },
    loading: { color: 'processing', text: '正在读取…' },
    ready: { color: 'success', text: '已就绪' },
    error: { color: 'error', text: '不可用' },
  }[masterKeyStatus];

  const masterKeySourceText =
    masterKeySource === 'keychain'
      ? '系统钥匙串'
      : masterKeySource === 'local'
        ? '本地数据目录（降级）'
        : '—';

  const grouped = useMemo(() => {
    return MODULE_GROUP_ORDER.map((g) => ({
      group: g,
      mods: modules.filter((m) => (m.group ?? '效率') === g),
    })).filter((x) => x.mods.length > 0);
  }, [modules]);

  const hiddenCount = Object.values(modulePrefs).filter((p) => p.hidden).length;
  /* 有没有自定义过首页卡片顺序（每个分组一条记录），决定「重置排序」是否可点 */
  const hasCustomOrder = Object.keys(moduleOrder).length > 0;

  /*
   * 关窗行为偏好的权威副本在后端，进设置页时读一次。
   * 依赖数组刻意留空：只在挂载时读，重复进设置页不必再请求（store 里也做了去重）。
   */
  useEffect(() => {
    loadBackgroundOnClose().catch((e: any) =>
      message.error(`读取后台运行设置失败：${e?.message || '请稍后重试'}`),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="max-w-[760px] mx-auto px-8 py-8">
        <h1
          className=" font-semibold mb-1"
          style={{ color: 'var(--wb-text-primary)', fontSize: 'calc(var(--wb-font-base) + 5px)' }}
        >
          工作台设置
        </h1>
        <div className=" mb-6" style={{ color: 'var(--wb-text-secondary)', fontSize: 'calc(var(--wb-font-base) - 2.5px)' }}>
          这里的设置作用于整个工作台；各功能模块自己的设置请到对应模块里调整。
        </div>

        {/* ===== 外观 ===== */}
        <Section
          icon={<BgColorsOutlined />}
          title="外观"
          hint="主题对所有模块生效，模块样式统一使用工作台设计令牌，切换后无需重启。"
        >
          <Row label="主题模式" desc="深色适合长时间盯日志，浅色适合白天办公">
            <Segmented
              value={theme}
              onChange={(v) => setTheme(v as ThemeMode)}
              options={[
                { label: '深色', value: 'dark' },
                { label: '浅色', value: 'light' },
              ]}
            />
          </Row>
          <Divider className="!my-2" style={{ borderColor: 'var(--wb-border-l1)' }} />
          <Row label="基准字号" desc={`当前 ${fontSize}px，按钮与输入框高度会跟着一起缩放`}>
            <div className="flex items-center gap-3">
              <Slider
                min={FONT_MIN_SIZE}
                max={FONT_MAX_SIZE}
                value={fontSize}
                onChange={setFontSize}
                style={{ width: 160 }}
              />
              <Button size="small" onClick={() => setFontSize(FONT_DEFAULT_SIZE)}>
                重置
              </Button>
            </div>
          </Row>
          {/* 预览用 CSS 变量渲染，所见即模块里 reflow 后的真实字号 */}
          <div
            className="mt-1 px-3 py-2 rounded-lg"
            style={{
              backgroundColor: 'var(--wb-bg-secondary)',
              color: 'var(--wb-text-secondary)',
              fontSize: 'var(--wb-font-base)',
            }}
          >
            预览：工作台基准字号 {fontSize}px — 侧栏、表格、按钮同步缩放
          </div>
        </Section>

        {/* ===== 程序坞图标（macOS） ===== */}
        <Section
          icon={<PictureOutlined />}
          title="程序坞图标"
          hint="切换 macOS 程序坞与启动器顶部显示的图标；只改进程内的 Dock 图，不动应用本身的 .icns，重启后自动恢复。"
        >
          <div className="grid grid-cols-3 gap-3 mt-1">
            {DOCK_ICONS.map((icon) => {
              const selected = dockIcon === icon.id;
              return (
                <button
                  key={icon.id}
                  type="button"
                  onClick={() => setDockIcon(icon.id)}
                  className="text-left rounded-lg p-3 transition-all"
                  style={{
                    backgroundColor: selected
                      ? 'var(--wb-bg-active)'
                      : 'var(--wb-bg-secondary)',
                    border: `1px solid ${
                      selected ? 'var(--wb-border-brand)' : 'var(--wb-border-l1)'
                    }`,
                    position: 'relative',
                  }}
                >
                  {selected && (
                    <CheckOutlined
                      style={{
                        position: 'absolute',
                        top: 8,
                        right: 8,
                        color: 'var(--wb-text-brand)',
                        fontSize: 14,
                      }}
                    />
                  )}
                  <img
                    src={icon.thumbnail}
                    alt={icon.name}
                    className="w-16 h-16 mx-auto mb-2 rounded-lg block"
                    style={{ imageRendering: '-webkit-optimize-contrast' }}
                  />
                  <div
                    className="text-center font-medium"
                    style={{
                      color: 'var(--wb-text-primary)',
                      fontSize: 'var(--wb-font-base)',
                    }}
                  >
                    {icon.name}
                  </div>
                  <div
                    className="text-center mt-1 leading-snug"
                    style={{
                      color: 'var(--wb-text-tertiary)',
                      fontSize: 'var(--wb-font-sm)',
                    }}
                  >
                    {icon.description}
                  </div>
                </button>
              );
            })}
          </div>
        </Section>

        {/* ===== 窗口与后台 ===== */}
        <Section
          icon={<DesktopOutlined />}
          title="窗口与后台"
          hint="决定点窗口关闭按钮（×）之后发生什么；与各模块自己的后台任务无关，那些任务在后台状态下照常运行。"
        >
          <Row
            label="关闭窗口后转入后台"
            desc={
              backgroundOnClose
                ? '点 × 不退出应用：程序坞图标隐藏，只在系统菜单栏保留一个入口，右键菜单栏图标可退出。'
                : '点 × 直接退出应用，同时停止所有后台任务。'
            }
          >
            <Switch
              checked={backgroundOnClose}
              loading={!backgroundOnCloseLoaded}
              onChange={(checked) => {
                setBackgroundOnClose(checked)
                  .then(() =>
                    message.success(
                      checked ? '已开启：点 × 后转入后台' : '已关闭：点 × 将直接退出',
                    ),
                  )
                  .catch((e: any) =>
                    message.error(`设置失败：${e?.message || '请稍后重试'}`),
                  );
              }}
            />
          </Row>
          <div
            className=" leading-relaxed px-3 py-2 rounded-lg mt-1"
            style={{
              backgroundColor: 'var(--wb-bg-secondary)',
              color: 'var(--wb-text-secondary)',
              fontSize: 'calc(var(--wb-font-base) - 3.5px)',
            }}
          >
            转入后台后，菜单栏上会保留一个入口：<strong>左键或右键</strong>都会弹出菜单，
            里面可以选择「显示主窗口」或「退出工作台」。
            如果余额模块正在推送，那一行文字就是余额；否则显示「工作台」。
          </div>
        </Section>

        {/* ===== 侧栏 ===== */}
        <Section icon={<LayoutOutlined />} title="侧栏">
          <Row label="默认收起侧栏" desc="收起后可通过顶部栏按钮或快捷键展开">
            <Switch checked={siderCollapsed} onChange={setSiderCollapsed} />
          </Row>
          <Divider className="!my-2" style={{ borderColor: 'var(--wb-border-l1)' }} />
          <Row label="侧栏宽度" desc={`当前 ${siderWidth}px，可直接拖拽侧栏右边缘调整`}>
            <div className="flex items-center gap-3">
              <Slider
                min={SIDER_MIN_WIDTH}
                max={SIDER_MAX_WIDTH}
                value={siderWidth}
                onChange={setSiderWidth}
                style={{ width: 160 }}
              />
              <Button size="small" onClick={() => setSiderWidth(SIDER_DEFAULT_WIDTH)}>
                重置
              </Button>
            </div>
          </Row>
        </Section>

        {/* ===== 模块管理 ===== */}
        <Section
          icon={<AppstoreOutlined />}
          title="模块管理"
          hint={`共 ${modules.length} 个模块，其中 ${hiddenCount} 个已隐藏（首页与侧栏都不显示）。首页卡片支持直接拖动排序。`}
        >
          {grouped.map(({ group, mods }) => (
            <div key={group} className="mb-3 last:mb-0">
              <div
                className=" font-medium tracking-wide mb-1"
                style={{ color: 'var(--wb-text-tertiary)', fontSize: 'calc(var(--wb-font-base) - 4px)' }}
              >
                {group}
              </div>
              {mods.map((m) => {
                const pref = modulePrefs[m.id] ?? {};
                const hidden = Boolean(pref.hidden) || Boolean(m.hiddenInSidebar);
                return (
                  <div
                    key={m.id}
                    className="flex items-center justify-between gap-4 py-2 border-b last:border-b-0"
                    style={{ borderColor: 'var(--wb-border-l1)' }}
                  >
                    <div className="flex items-start gap-2.5 min-w-0">
                      <span
                        className=" mt-0.5 flex-shrink-0"
                        style={{ color: 'var(--wb-text-brand)', fontSize: 'var(--wb-font-base)' }}
                      >
                        {m.icon}
                      </span>
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="" style={{ color: 'var(--wb-text-primary)', fontSize: 'calc(var(--wb-font-base) - 2px)' }}>
                            {m.name}
                          </span>
                          <span
                            className=" font-mono"
                            style={{ color: 'var(--wb-text-tertiary)', fontSize: 'calc(var(--wb-font-base) - 4.5px)' }}
                          >
                            {m.id}
                          </span>
                          {m.version && (
                            <Tag
                              color="processing"
                              className=" !m-0 !py-0 !px-1 !h-[15px] flex items-center rounded-full"
                             style={{ fontSize: 'calc(var(--wb-font-base) - 5.5px)' }}>
                              v{m.version}
                            </Tag>
                          )}
                          {m.keepAlive && (
                            <Tooltip title="切换模块时不会卸载，保留内部状态与长连接">
                              <Tag
                                className=" !m-0 !py-0 !px-1 !h-[15px] flex items-center rounded-full"
                                style={{ backgroundColor: 'var(--wb-bg-overlay)',
                                  color: 'var(--wb-text-tertiary)',
                                  borderColor: 'var(--wb-border-l1)', fontSize: 'calc(var(--wb-font-base) - 5.5px)' }}
                              >
                                保活
                              </Tag>
                            </Tooltip>
                          )}
                        </div>
                        <div
                          className=" mt-0.5 truncate"
                          style={{ color: 'var(--wb-text-tertiary)', fontSize: 'calc(var(--wb-font-base) - 3.5px)' }}
                        >
                          {m.description || '暂无说明'}
                        </div>
                      </div>
                    </div>
                    <Tooltip
                      title={
                        m.hiddenInSidebar
                          ? '该模块声明为不在侧栏显示，此处不可改'
                          : '关闭后该模块在首页与侧栏都隐藏'
                      }
                    >
                      <Switch
                        size="small"
                        disabled={Boolean(m.hiddenInSidebar)}
                        checked={!hidden}
                        onChange={(checked) =>
                          setModulePref(m.id, { hidden: !checked })
                        }
                      />
                    </Tooltip>
                  </div>
                );
              })}
            </div>
          ))}

          <div className="mt-3 flex items-center gap-2">
            <Popconfirm
              title="恢复模块显示设置"
              description="将清除所有模块的隐藏设置，恢复为默认全部显示。"
              okText="恢复"
              cancelText="取消"
              onConfirm={() => {
                resetModulePrefs();
                message.success('已恢复默认模块显示');
              }}
            >
              <Button size="small" icon={<ReloadOutlined />} disabled={hiddenCount === 0}>
                恢复默认显示
              </Button>
            </Popconfirm>
            <Popconfirm
              title="重置首页卡片排序"
              description="将清除首页拖拽产生的卡片顺序，恢复为默认排序。"
              okText="重置"
              cancelText="取消"
              onConfirm={() => {
                resetModuleOrder();
                message.success('已恢复默认卡片排序');
              }}
            >
              <Button size="small" icon={<ReloadOutlined />} disabled={!hasCustomOrder}>
                重置卡片排序
              </Button>
            </Popconfirm>
          </div>
        </Section>

        {/* ===== 本地密钥 ===== */}
        <Section
          icon={<KeyOutlined />}
          title="本地密钥"
          hint="工作台用它加密各模块的本地敏感数据（如服务器密码、私钥）。密钥保存在系统钥匙串里，所有模块共用一把。"
        >
          <Row
            label="状态"
            desc={
              masterKeyError ||
              (masterKeyStatus === 'idle'
                ? '尚未恢复；进入 LogSight 时按需读取（首次才请求钥匙串）'
                : '按需恢复，已就绪')
            }
          >
            <Tag color={masterKeyTag.color}>{masterKeyTag.text}</Tag>
          </Row>
          <Divider className="!my-2" style={{ borderColor: 'var(--wb-border-l1)' }} />
          <Row
            label="存储位置"
            desc={
              masterKeySource === 'local'
                ? '钥匙串不可用，已降级到本地数据目录。点下方「重试」可尝试迁回钥匙串。'
                : '优先存放在系统钥匙串，各模块共用同一把'
            }
          >
            <Tag color={masterKeySource === 'local' ? 'warning' : 'default'}>
              {masterKeySourceText}
            </Tag>
          </Row>
          {masterKeyWarning && (
            <div
              className=" leading-relaxed px-3 py-2 rounded-lg mt-1"
              style={{ backgroundColor: 'var(--wb-bg-secondary)',
                color: 'var(--wb-text-secondary)', fontSize: 'calc(var(--wb-font-base) - 3.5px)' }}
            >
              {masterKeyWarning}
            </div>
          )}
          <Divider className="!my-2" style={{ borderColor: 'var(--wb-border-l1)' }} />
          <Row label="重新读取" desc="读取失败时（例如钥匙串被锁定）可先解锁钥匙串再重试；降级存储时点这里可尝试迁回钥匙串">
            <Button
              size="small"
              icon={<ReloadOutlined />}
              disabled={masterKeyStatus === 'loading'}
              onClick={() => {
                ensureMasterKey(true)
                  .then(() => message.success('本地密钥已就绪'))
                  .catch((e: any) => message.error(`读取失败：${e?.message || '请稍后重试'}`));
              }}
            >
              重试
            </Button>
          </Row>
          <Divider className="!my-2" style={{ borderColor: 'var(--wb-border-l1)' }} />
          <Row
            label="重建本地密钥"
            desc="仅在确认钥匙串无法恢复时使用。重建后旧密文无法解开，需要重新录入凭据。"
          >
            <Popconfirm
              title="重建本地密钥"
              description="旧密文将无法解开，服务器密码 / 私钥需要重新录入。确定继续？"
              okText="重建"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={() => {
                rebuildMasterKey()
                  .then(() => message.success('本地密钥已重建，请重新录入各模块的凭据'))
                  .catch((e: any) => message.error(`重建失败：${e?.message || '请稍后重试'}`));
              }}
            >
              <Button size="small" danger icon={<ReloadOutlined />}>
                重建
              </Button>
            </Popconfirm>
          </Row>
        </Section>

        {/* ===== 本地数据 ===== */}
        <Section
          icon={<DatabaseOutlined />}
          title="本地数据"
          hint="工作台偏好保存在浏览器 localStorage；模块的业务数据由各自的后端服务管理。"
        >
          <div
            className=" leading-relaxed font-mono px-3 py-2.5 rounded-lg"
            style={{ backgroundColor: 'var(--wb-bg-secondary)',
              color: 'var(--wb-text-secondary)', fontSize: 'calc(var(--wb-font-base) - 3.5px)' }}
          >
            workbench:theme · workbench:active-module · workbench:sider-collapsed
            <br />
            workbench:sider-width · workbench:recent-modules · workbench:module-prefs
            <br />
            <span style={{ color: 'var(--wb-text-tertiary)' }}>
              另：窗口与后台偏好存在后端数据库（workbench/background_on_close），
              因为它要能被关窗回调读到，不能只放在页面里。
            </span>
          </div>
          <div className="mt-3">
            <Popconfirm
              title="重置工作台偏好"
              description="将清除主题、侧栏、最近访问、模块显示与关窗行为设置。模块业务数据不受影响。"
              okText="重置"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={() => {
                try {
                  [
                    'workbench:theme',
                    'workbench:active-module',
                    'workbench:sider-collapsed',
                    'workbench:sider-width',
                    'workbench:recent-modules',
                    'workbench:module-prefs',
                  ].forEach((k) => localStorage.removeItem(k));
                } catch (e: any) {
                  message.error(`重置失败：${e?.message || '请稍后重试'}`);
                  return;
                }
                /*
                 * 关窗行为不在 localStorage 里，得单独写回后端。
                 * 它失败**不影响**上面已经清掉的本地偏好，所以只提示、不回滚。
                 */
                setBackgroundOnClose(true)
                  .then(() => message.success('已重置，刷新后生效'))
                  .catch((e: any) =>
                    message.warning(
                      `本地偏好已重置，但关窗行为恢复失败：${e?.message || '请稍后重试'}`,
                    ),
                  );
              }}
            >
              <Button size="small" danger icon={<ReloadOutlined />}>
                重置工作台偏好
              </Button>
            </Popconfirm>
          </div>
        </Section>

        <Section icon={<DatabaseOutlined />} title="安全配置备份" hint="按分区导出可迁移配置；导入会先严格校验并预览，再由你显式应用。敏感凭据不会进入备份。">
          <ConfigBackupPanel />
        </Section>

        {/* ===== 关于 ===== */}
        <Section icon={<InfoCircleOutlined />} title="关于">
          <Row label="个人工作台" desc="一个可扩展的桌面工作台，功能以模块形式接入">
            <span className=" font-mono" style={{ color: 'var(--wb-text-secondary)', fontSize: 'calc(var(--wb-font-base) - 2.5px)' }}>
              v{__APP_VERSION__}
            </span>
          </Row>
          <Divider className="!my-2" style={{ borderColor: 'var(--wb-border-l1)' }} />
          <Row label="技术栈" desc="Tauri 2 · React 18 · TypeScript · Ant Design 6 · Zustand · Tailwind CSS">
            <span />
          </Row>
          <Divider className="!my-2" style={{ borderColor: 'var(--wb-border-l1)' }} />
          <Row
            label="新增模块"
            desc="在 src/features 下新建目录并导出 WorkbenchModule，再到 src/core/modules.ts 注册即可"
          >
            <span />
          </Row>
        </Section>
      </div>
    </div>
  );
};

export default SettingsModule;
