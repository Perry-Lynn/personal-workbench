/*
 * JAR 运行器 · 主体视图
 * ------------------------------------------------------------------
 * 一天的动线是：**拖进来 → 看一眼命令对不对 → 点启动 → 盯日志**。
 * 所以配置页按这个顺序排：左列是配置表单，下面接（已保存的配置 | 运行记录）
 * 并排一行；右列整列给输出 —— 输出才是这块屏幕上一直要看的东西。
 *
 * 四个刻意的设计：
 *   1. **命令预览必显**。启动前能看到「实际会跑什么」，
 *      出问题时用户第一件事就是复制它到终端里手动跑一遍 —— 藏着就得靠猜。
 *      预览由后端算（与启动同一套代码），界面不自己拼。
 *   2. **表单改完不用先保存**。想留着复用再点保存 —— 只是临时跑一次的
 *      场景远多于反复跑的场景，强制保存会让列表里堆满一次性配置。
 *   3. **运行记录是「一个按钮 + 一整页」**，不是配置页右栏里的一小块。
 *      记录会越攒越多，挤在 280px 的框里只能看到两三条，还得在小框里滚；
 *      而看记录（翻历史、比退出码）和配参数（选 jar、调参数）本来就是
 *      两件不同的事，各有各的屏幕更合适。配置页只留一个入口按钮 + 在跑的数量。
 *   4. **「停止」在配置页也要够得着**。输出区标题右侧就有一个 ——
 *      否则用户发现日志不对想停，还得先跳到记录页去点，多一步就是慢一拍。
 *      记录页里每条记录自己的「停止 / 移除」也原样保留。
 *
 * 拖进来的 jar 由常驻服务（service.ts）处理，这里只负责提示
 * —— 服务层没有 message 可用，而用户需要知道「拖的东西被收到了」。
 * @Author: fu
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, App as AntApp, Button, Empty, Space, Tag, Tooltip, Typography } from 'antd';
import {
  ArrowLeftOutlined,
  CopyOutlined,
  DeleteOutlined,
  HistoryOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  SaveOutlined,
  StopOutlined,
} from '@ant-design/icons';
import { copyText } from '@/core/clipboard';
import { baseName, jarDisplayName } from './format';
import ConfigForm from './ConfigForm';
import LogPane from './LogPane';
import RunList from './RunList';
import { useJarRunnerStore } from './store';
import './jarrunner.css';

const { Text } = Typography;

/** 两个视图：配参数 / 看记录 */
type View = 'config' | 'runs';

const JarRunnerView: React.FC = () => {
  const { message, modal } = AntApp.useApp();

  const loaded = useJarRunnerStore((s) => s.loaded);
  const loading = useJarRunnerStore((s) => s.loading);
  const error = useJarRunnerStore((s) => s.error);
  const jdks = useJarRunnerStore((s) => s.jdks);
  const configs = useJarRunnerStore((s) => s.configs);
  const draft = useJarRunnerStore((s) => s.draft);
  const preview = useJarRunnerStore((s) => s.preview);
  const previewError = useJarRunnerStore((s) => s.previewError);
  const runs = useJarRunnerStore((s) => s.runs);
  const activeRunId = useJarRunnerStore((s) => s.activeRunId);
  const configViewRequest = useJarRunnerStore((s) => s.configViewRequest);
  const starting = useJarRunnerStore((s) => s.starting);
  const lastDropped = useJarRunnerStore((s) => s.lastDropped);
  const lastDroppedAt = useJarRunnerStore((s) => s.lastDroppedAt);

  const loadAll = useJarRunnerStore((s) => s.loadAll);
  const refreshPreview = useJarRunnerStore((s) => s.refreshPreview);
  const startRun = useJarRunnerStore((s) => s.startRun);
  const stopRun = useJarRunnerStore((s) => s.stopRun);
  const removeRun = useJarRunnerStore((s) => s.removeRun);
  const saveDraft = useJarRunnerStore((s) => s.saveDraft);
  const removeConfig = useJarRunnerStore((s) => s.removeConfig);
  const loadConfig = useJarRunnerStore((s) => s.loadConfig);
  const setDraft = useJarRunnerStore((s) => s.setDraft);

  /* 视图选择放在组件里：模块 keepAlive，切走再回来还停在上次的视图 */
  const [view, setView] = useState<View>('config');

  useEffect(() => {
    if (configViewRequest > 0) setView('config');
  }, [configViewRequest]);

  /* 首次进模块拉一次；已加载过就直接用 store 里的（切走再回来不闪） */
  useEffect(() => {
    if (loaded) return;
    void loadAll().catch(() => {});
  }, [loaded, loadAll]);

  /* 表单变了就重算预览（后端算，250ms 合流，避免每敲一个字符打一次 IPC） */
  useEffect(() => {
    const t = window.setTimeout(() => {
      void refreshPreview();
    }, 250);
    return () => window.clearTimeout(t);
  }, [draft, refreshPreview]);

  /*
   * 拖进来的东西：服务把命中的路径记在 store，这里负责把「收到了」告诉用户。
   * 两类要分开说 —— 都说「已载入 xxx」的话，用户不知道它填进了哪一格
   * （jar 进 jar 路径，.yml 进配置文件）。一次拖放可能两类都有，那就**都念出来**：
   * 只念一个会让用户以为另一个也进去了，而它其实没进。
   */
  const shownDropRef = useRef(0);
  useEffect(() => {
    if (!lastDroppedAt || lastDroppedAt === shownDropRef.current) return;
    shownDropRef.current = lastDroppedAt;
    const parts: string[] = [];
    if (lastDropped?.jar) parts.push(jarDisplayName(lastDropped.jar));
    if (lastDropped?.config) parts.push(`配置文件 ${baseName(lastDropped.config)}`);
    if (parts.length) {
      message.success(`已载入 ${parts.join(' 与 ')}`);
      /* 拖进来的东西填在配置页，人却被留在记录页的话，会以为「拖了没反应」 */
      setView('config');
    }
  }, [lastDropped, lastDroppedAt, message]);

  const handleStart = useCallback(async () => {
    try {
      const run = await startRun();
      message.success(`已启动：${run.name}`);
    } catch (e) {
      message.error(e instanceof Error ? e.message : '启动失败');
    }
  }, [message, startRun]);

  const handleStop = useCallback(
    async (id: string) => {
      try {
        await stopRun(id);
        message.success('已停止');
      } catch (e) {
        message.error(e instanceof Error ? e.message : '停止失败');
      }
    },
    [message, stopRun],
  );

  const handleRemove = useCallback(
    async (id: string) => {
      try {
        await removeRun(id);
      } catch (e) {
        message.error(e instanceof Error ? e.message : '移除失败');
      }
    },
    [message, removeRun],
  );

  const handleSave = useCallback(async () => {
    const saveNow = async () => {
      try {
        const saved = await saveDraft();
        message.success(`已保存「${saved.name}」`);
      } catch (e) {
        message.error(e instanceof Error ? e.message : '保存失败');
      }
    };
    const retained = useJarRunnerStore.getState().retainedConfigReload;
    if (retained && useJarRunnerStore.getState().draft.id === retained.id) {
      modal.confirm({ title: '覆盖已恢复的配置？', content: '当前仍是恢复前的草稿。保存后会用这份旧草稿覆盖刚恢复的配置。', okText: '覆盖并保存', cancelText: '返回检查', onOk: saveNow });
      return;
    }
    await saveNow();
  }, [message, modal, saveDraft]);

  const handleSaveAs = useCallback(async () => {
    setDraft({ id: '' });
    try {
      const saved = await saveDraft();
      message.success(`已另存为「${saved.name}」`);
    } catch (e) {
      message.error(e instanceof Error ? e.message : '保存失败');
    }
  }, [message, saveDraft, setDraft]);

  const handleDeleteConfig = useCallback(async () => {
    if (!draft.id) return;
    try {
      await removeConfig(draft.id);
      message.success('已删除这份配置');
    } catch (e) {
      message.error(e instanceof Error ? e.message : '删除失败');
    }
  }, [draft.id, message, removeConfig]);

  const handleCopyCommand = useCallback(async () => {
    if (!preview) return;
    try {
      await copyText(preview);
      message.success('已复制命令');
    } catch (e) {
      message.error(e instanceof Error ? e.message : '复制失败');
    }
  }, [message, preview]);

  const activeRun = runs.find((r) => r.id === activeRunId) ?? null;
  const runningCount = runs.filter((r) => r.status === 'running').length;

  return (
    <div className="jar-root">
      {error && (
        <Alert
          type="error"
          showIcon
          message={error}
          action={
            <Button size="small" icon={<ReloadOutlined />} onClick={() => void loadAll()}>
              重试
            </Button>
          }
        />
      )}

      {jdks.length === 0 && loaded && !error && (
        <Alert
          type="warning"
          showIcon
          message="没在本机扫到 JDK"
          description="启动时需要一台 JAVA_HOME。装好之后点「重新探测」，或在 JDK 下拉框里手动选一个目录。"
          action={
            <Button size="small" icon={<ReloadOutlined />} onClick={() => void loadAll()}>
              重新探测
            </Button>
          }
        />
      )}

      {view === 'runs' ? (
        /* ===== 运行记录页 ===== */
        <div className="jar-card">
          <div className="jar-runs-head">
            <Button size="small" icon={<ArrowLeftOutlined />} onClick={() => setView('config')}>
              返回配置
            </Button>
            <Text type="secondary" className="jar-card-note">
              {runningCount > 0 ? `${runningCount} 个在跑 · ` : ''}共 {runs.length} 条
            </Text>
            <span className="jar-title-push" />
            <Text type="secondary" className="jar-card-note">
              点一条记录，配置页的输出区就切到它的日志
            </Text>
          </div>
          <div className="jar-runs-wrap jar-runs-wrap-full">
            <RunList onStop={handleStop} onRemove={handleRemove} />
          </div>
        </div>
      ) : (
        /* ===== 配置页 ===== */
        <div className="jar-grid">
          {/* 左：配置 */}
          <div className="jar-col">
            <div className="jar-card">
              <div className="jar-card-title">运行配置</div>
              <ConfigForm />

              <div className="jar-preview">
                <div className="jar-label">将执行</div>
                <pre className="jar-preview-cmd">{preview || '—'}</pre>
                {previewError && (
                  <Text type="danger" className="jar-hint">
                    {previewError}
                  </Text>
                )}
                <Space size={8} wrap>
                  <Button
                    size="small"
                    icon={<CopyOutlined />}
                    disabled={!preview}
                    onClick={handleCopyCommand}
                  >
                    复制命令
                  </Button>
                </Space>
              </div>

              <div className="jar-ops">
                <Button
                  type="primary"
                  icon={<PlayCircleOutlined />}
                  loading={starting}
                  disabled={!draft.jarPath.trim()}
                  onClick={handleStart}
                >
                  启动
                </Button>
                <Button icon={<SaveOutlined />} disabled={!draft.jarPath.trim()} onClick={handleSave}>
                  保存
                </Button>
                <Tooltip title="把当前表单存成一份新配置">
                  <Button disabled={!draft.jarPath.trim()} onClick={handleSaveAs}>
                    另存为
                  </Button>
                </Tooltip>
                <Button
                  danger
                  icon={<DeleteOutlined />}
                  disabled={!draft.id}
                  onClick={handleDeleteConfig}
                >
                  删除
                </Button>
              </div>
            </div>

            <div className="jar-pair">
              <div className="jar-card">
                <div className="jar-card-title">
                  已保存的配置
                  <Text type="secondary" className="jar-card-note">
                    {configs.length} 份
                  </Text>
                </div>
                {configs.length === 0 ? (
                  <Empty description="还没有保存过配置" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                ) : (
                  <div className="jar-configs">
                    {configs.map((c) => (
                      <div
                        key={c.id}
                        className={`jar-config-row${c.id === draft.id ? ' jar-config-row-active' : ''}`}
                      >
                        <div className="jar-config-main">
                          <span className="jar-config-name">{c.name}</span>
                          <span className="jar-config-path">{c.jarPath}</span>
                        </div>
                        <Space size={4}>
                          <Button size="small" type="link" onClick={() => loadConfig(c.id)}>
                            载入
                          </Button>
                          <Button
                            size="small"
                            type="text"
                            icon={<DeleteOutlined />}
                            onClick={() => {
                              void removeConfig(c.id).catch((e) => {
                                message.error(e instanceof Error ? e.message : '删除失败');
                              });
                            }}
                          />
                        </Space>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* 运行记录入口。原来它独占右栏一行（就一个按钮），
                  而这一列本身只有几十像素高 —— 并到「已保存的配置」旁边，
                  省下来的纵向空间全给了输出 */}
              <div className="jar-card jar-runs-card">
                <div className="jar-runs-entry">
                  <Button block icon={<HistoryOutlined />} onClick={() => setView('runs')}>
                    运行记录
                  </Button>
                  <Text type="secondary" className="jar-card-note">
                    {runningCount > 0 ? `${runningCount} 个在跑 · ` : ''}共 {runs.length} 条
                  </Text>
                </div>
              </div>
            </div>
          </div>

          {/* 右：输出。整列都归它 —— 「运行记录」已挪到左栏与「已保存的配置」并排 */}
          <div className="jar-col">
            <div className="jar-card">
              <div className="jar-card-title">
                输出
                {activeRun && (
                  <Tag
                    bordered={false}
                    color={activeRun.status === 'running' ? 'processing' : 'default'}
                  >
                    {activeRun.name}
                  </Tag>
                )}
                <span className="jar-title-push" />
                {/* 日志不对想立刻停时，不该还得先跳到记录页去点 */}
                {activeRun?.status === 'running' && (
                  <Button
                    size="small"
                    danger
                    icon={<StopOutlined />}
                    onClick={() => void handleStop(activeRun.id)}
                  >
                    停止
                  </Button>
                )}
              </div>
              <LogPane run={activeRun} />
            </div>
          </div>
        </div>
      )}

      {loading && !loaded && (
        <div className="jar-loading">
          <Text type="secondary">载入中…</Text>
        </div>
      )}
    </div>
  );
};

export default JarRunnerView;
