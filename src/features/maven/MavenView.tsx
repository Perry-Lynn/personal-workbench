/*
 * Maven 助手模块 · 主体视图
 * ------------------------------------------------------------------
 * 两块能力：
 *   1. 本地仓库（~/.m2）：体积排行 + 存了多个版本的包（清理收益一眼看到）
 *   2. 依赖树：选一个项目目录跑 mvn dependency:tree -Dverbose，
 *      把「谁被仲裁掉了、谁赢了」直接列出来
 *
 * 字号约定同其它模块：自定义字号走 `calc(var(--wb-font-base) ± Npx)`，
 * 横向排布一律 `<Space wrap>`。
 * @Author: fu
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Collapse,
  Empty,
  Input,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { FolderOpenOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import type { ColumnsType } from 'antd/es/table';
import * as ipc from './ipc';
import {
  OMIT_LABEL,
  barWidth,
  conflictKey,
  conflictSummary,
  dupSummary,
  formatBytes,
  indentPx,
  percentOf,
  reclaimableBytes,
  totalReclaimable,
} from './format';
import { useMavenStore } from './store';
import type { Conflict, DuplicateEntry, SizeEntry } from './types';
import './maven.css';

const { Text } = Typography;

const SOURCE_LABEL: Record<string, string> = {
  sdkman: 'sdkman',
  brew: 'Homebrew',
  system: '系统',
  wrapper: '项目自带 mvnw',
};

const MavenView: React.FC = () => {
  const { message } = AntApp.useApp();

  const info = useMavenStore((s) => s.info);
  const repo = useMavenStore((s) => s.repo);
  const tree = useMavenStore((s) => s.tree);
  const treeDir = useMavenStore((s) => s.treeDir);
  const repoLoading = useMavenStore((s) => s.repoLoading);
  const treeLoading = useMavenStore((s) => s.treeLoading);
  const repoError = useMavenStore((s) => s.repoError);
  const treeError = useMavenStore((s) => s.treeError);
  const setInfo = useMavenStore((s) => s.setInfo);
  const setRepo = useMavenStore((s) => s.setRepo);
  const setTree = useMavenStore((s) => s.setTree);
  const setRepoLoading = useMavenStore((s) => s.setRepoLoading);
  const setTreeLoading = useMavenStore((s) => s.setTreeLoading);
  const setRepoError = useMavenStore((s) => s.setRepoError);
  const setTreeError = useMavenStore((s) => s.setTreeError);

  const [dir, setDir] = useState('');
  const [offline, setOffline] = useState(true);

  const locate = useCallback(async () => {
    try {
      setInfo(await ipc.locate(null));
    } catch (e) {
      setInfo(null);
      message.error(`探测失败：${(e as Error)?.message || e}`);
    }
  }, [setInfo, message]);

  const scan = useCallback(async () => {
    setRepoLoading(true);
    setRepoError(null);
    try {
      setRepo(await ipc.scanRepo(null));
    } catch (e) {
      const msg = (e as Error)?.message || String(e);
      setRepoError(msg);
      message.error(`扫描失败：${msg}`);
    } finally {
      setRepoLoading(false);
    }
  }, [setRepo, setRepoLoading, setRepoError, message]);

  useEffect(() => {
    void locate();
    void scan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pickDir = useCallback(async () => {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked === 'string' && picked) setDir(picked);
  }, []);

  const analyze = useCallback(async () => {
    if (!dir.trim()) {
      message.warning('请先选择项目目录');
      return;
    }
    setTreeLoading(true);
    setTreeError(null);
    try {
      const r = await ipc.dependencyTree(dir.trim(), offline);
      setTree(r, dir.trim());
    } catch (e) {
      const msg = (e as Error)?.message || String(e);
      setTreeError(msg);
      message.error(`分析失败：${msg}`);
    } finally {
      setTreeLoading(false);
    }
  }, [dir, offline, setTree, setTreeLoading, setTreeError, message]);

  /** 体积排行条：相对最长的一条画比例，不按总量取百分比（否则条都短得看不见） */
  const rankBars = (list: SizeEntry[], total: number) =>
    list.map((e) => (
      <div key={e.key} className="maven-bar-row">
        <div className="maven-bar-label">
          <Text ellipsis>{e.key}</Text>
        </div>
        <div className="maven-bar-track">
          <div className="maven-bar-fill" style={{ width: `${barWidth(e, list[0])}%` }} />
        </div>
        <div className="maven-bar-value">
          <Text>{formatBytes(e.bytes)}</Text>
          <Text type="secondary" style={{ fontSize: 'calc(var(--wb-font-base) - 3px)' }}>
            {percentOf(e.bytes, total)}%
          </Text>
        </div>
      </div>
    ));

  const dupColumns: ColumnsType<DuplicateEntry> = [
    {
      title: '包',
      key: 'name',
      render: (_, d) => (
        <div>
          <Text strong>{d.artifact}</Text>
          <div>
            <Text type="secondary" style={{ fontSize: 'calc(var(--wb-font-base) - 3px)' }}>
              {d.group}
            </Text>
          </div>
        </div>
      ),
    },
    {
      title: '版本',
      key: 'versions',
      width: 220,
      render: (_, d) => (
        <Space size={4} wrap>
          {d.versions.map((v) => (
            <Tag key={v} color={v.toUpperCase().includes('SNAPSHOT') ? 'orange' : 'default'}>
              {v}
            </Tag>
          ))}
        </Space>
      ),
    },
    {
      title: '占用',
      dataIndex: 'bytes',
      key: 'bytes',
      width: 100,
      render: (b: number) => formatBytes(b),
    },
    {
      title: '可释放',
      key: 'reclaim',
      width: 110,
      /*
       * 只删旧版本、保留最大的那个 —— 这是「清理仓库」里唯一安全的做法：
       * 全删了下次构建要重新下载，而保留一个版本至少还有很大概率命中。
       */
      render: (_, d) => <Text type="success">{formatBytes(reclaimableBytes(d))}</Text>,
    },
  ];

  const conflictColumns: ColumnsType<Conflict> = [
    {
      title: '包',
      key: 'name',
      render: (_, c) => <Text strong>{conflictKey(c)}</Text>,
    },
    {
      title: '胜出',
      dataIndex: 'winner',
      key: 'winner',
      width: 140,
      render: (v: string) => <Tag color="green">{v}</Tag>,
    },
    {
      title: '被仲裁掉',
      key: 'losers',
      render: (_, c) => (
        <Space size={4} wrap>
          {c.losers.map((v) => (
            <Tag key={v} color="red">
              {v}
            </Tag>
          ))}
        </Space>
      ),
    },
  ];

  const totalDup = useMemo(
    () => (repo ? totalReclaimable(repo.duplicates) : 0),
    [repo],
  );

  return (
    <div className="maven-view">
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Card>
          <Space size={12} wrap>
            <Text>
              {info?.found ? (
                <>
                  mvn <Text strong>{info.version || '（版本未知）'}</Text>
                </>
              ) : (
                <Text type="danger">没有找到 mvn</Text>
              )}
            </Text>
            {info?.found && (
              <>
                <Tag>{SOURCE_LABEL[info.source ?? ''] ?? info.source}</Tag>
                <Tooltip title={info.path}>
                  <Text type="secondary" ellipsis style={{ maxWidth: 380 }}>
                    {info.path}
                  </Text>
                </Tooltip>
              </>
            )}
            <Tooltip title={info?.repoPath ?? ''}>
              <Text type="secondary" ellipsis style={{ maxWidth: 320 }}>
                仓库 {info?.repoPath ?? '—'}
              </Text>
            </Tooltip>
            <Button size="small" icon={<ReloadOutlined />} onClick={() => void locate()}>
              重新探测
            </Button>
          </Space>
        </Card>

        <Card
          title={<span style={{ fontSize: 'calc(var(--wb-font-base) + 2px)' }}>本地仓库</span>}
          extra={
            <Space size={8} wrap>
              <Button
                size="small"
                icon={<ReloadOutlined />}
                loading={repoLoading}
                onClick={() => void scan()}
              >
                重新扫描
              </Button>
            </Space>
          }
        >
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            {repoError && <Alert type="error" showIcon message={repoError} />}

            {repo && (
              <>
                <Space size={16} wrap>
                  <Text>
                    总计 <Text strong>{formatBytes(repo.totalBytes)}</Text>
                  </Text>
                  <Text type="secondary">{repo.artifactCount} 个包</Text>
                  <Text type="secondary">{repo.versionCount} 个版本</Text>
                  <Text type="secondary">{repo.snapshotCount} 个 SNAPSHOT</Text>
                  <Text type="secondary">耗时 {repo.elapsedMs} ms</Text>
                </Space>

                <Alert
                  type={totalDup > 0 ? 'warning' : 'success'}
                  showIcon
                  message={dupSummary(repo.duplicates)}
                  description={
                    totalDup > 0
                      ? '只列占用最大的 30 个。「可释放」= 清掉除最大版本以外的旧版本。'
                      : undefined
                  }
                />

                <Text strong>体积最大的 group</Text>
                {repo.topGroups.length > 0 ? (
                  rankBars(repo.topGroups, repo.totalBytes)
                ) : (
                  <Empty description="仓库是空的" />
                )}

                <Text strong>存了多个版本的包</Text>
                {repo.duplicates.length > 0 ? (
                  <Table<DuplicateEntry>
                    rowKey={(d) => `${d.group}:${d.artifact}`}
                    size="small"
                    columns={dupColumns}
                    dataSource={repo.duplicates}
                    pagination={false}
                    scroll={{ x: 720 }}
                  />
                ) : (
                  <Text type="secondary">没有存了多个版本的包</Text>
                )}
              </>
            )}

            {!repo && !repoLoading && !repoError && <Empty description="点「重新扫描」开始" />}
          </Space>
        </Card>

        <Card
          title={
            <span style={{ fontSize: 'calc(var(--wb-font-base) + 2px)' }}>依赖冲突分析</span>
          }
        >
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Space size={8} wrap>
              <Input
                style={{ width: 420 }}
                placeholder="项目目录（含 pom.xml）"
                value={dir}
                onChange={(e) => setDir(e.target.value)}
                readOnly
              />
              <Button icon={<FolderOpenOutlined />} onClick={() => void pickDir()}>
                选择目录
              </Button>
              <Space size={6}>
                <Switch checked={offline} onChange={setOffline} size="small" />
                <Tooltip title="离线（-o）不去仓库检查更新，快得多；本地缺依赖时会失败，届时可关掉重试">
                  <Text>离线</Text>
                </Tooltip>
              </Space>
              <Button
                type="primary"
                icon={<SearchOutlined />}
                loading={treeLoading}
                onClick={() => void analyze()}
              >
                分析
              </Button>
            </Space>

            {treeLoading && (
              <Alert
                type="info"
                showIcon
                message="正在跑 mvn dependency:tree，首次可能要下载插件，请稍候（最长 2 分钟）"
              />
            )}
            {treeError && <Alert type="error" showIcon message={treeError} />}

            {tree && (
              <>
                <Space size={12} wrap>
                  <Text>
                    <Text strong>{tree.root || '（未识别到项目坐标）'}</Text>
                  </Text>
                  <Text type="secondary">耗时 {tree.elapsedMs} ms</Text>
                  <Text type="secondary">{tree.lines.length} 行</Text>
                </Space>

                {tree.warnings.map((w) => (
                  <Alert key={w} type="warning" showIcon message={w} />
                ))}

                <Alert
                  type={tree.conflicts.length > 0 ? 'warning' : 'success'}
                  showIcon
                  message={conflictSummary(tree.conflicts)}
                />

                {tree.conflicts.length > 0 && (
                  <Table<Conflict>
                    rowKey={conflictKey}
                    size="small"
                    columns={conflictColumns}
                    dataSource={tree.conflicts}
                    pagination={false}
                    scroll={{ x: 640 }}
                  />
                )}

                <Collapse
                  ghost
                  items={[
                    {
                      key: 'tree',
                      label: '依赖树（划掉的是没被引入的）',
                      children: (
                        <div className="maven-tree">
                          {tree.lines.map((l, i) => (
                            <div
                              key={`${l.group}:${l.artifact}:${l.version}:${i}`}
                              className={l.omitReason ? 'maven-line maven-line-omit' : 'maven-line'}
                              style={{ paddingLeft: indentPx(l.depth) }}
                            >
                              <span>
                                {l.group}:{l.artifact}:{l.version}
                              </span>
                              {l.scope && <Tag>{l.scope}</Tag>}
                              {l.omitReason && (
                                <Tag color="red">{OMIT_LABEL[l.omitReason]}</Tag>
                              )}
                              {l.conflictWith && (
                                <Text type="secondary">→ 实际用 {l.conflictWith}</Text>
                              )}
                            </div>
                          ))}
                        </div>
                      ),
                    },
                    {
                      key: 'raw',
                      label: '原始输出',
                      children: <pre className="maven-dump">{tree.raw}</pre>,
                    },
                  ]}
                />
              </>
            )}

            {!tree && !treeLoading && !treeError && (
              <Empty description="选一个含 pom.xml 的项目目录，就能看到谁被仲裁掉了" />
            )}
            {treeDir && !tree && <Text type="secondary">上次分析：{treeDir}</Text>}
          </Space>
        </Card>
      </Space>
    </div>
  );
};

export default MavenView;
