/*
 * Spring Boot 服务台 · 主体视图
 * ------------------------------------------------------------------
 * 一屏看全本机跑着的 Spring Boot 服务：状态 / 端口 / profile / 组件 / 资源占用，
 * 并且能一键打开 actuator 页面。
 *
 * 为什么不用 Table：每个服务要展示的东西是**异构**的 —— 组件标签数量不定、
 * 错误信息长短不定、证据和启动命令是折叠的。硬塞进表格只会得到一堆省略号。
 * 所以用「一服务一块」的卡片式排布。
 *
 * 字号约定同其它模块：自定义字号走 `calc(var(--wb-font-base) ± Npx)`，
 * 横向排布一律 `<Space wrap>`。
 * @Author: fu
 */
import React, { useCallback, useEffect, useMemo } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Collapse,
  Empty,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { ApiOutlined, LinkOutlined, ReloadOutlined } from '@ant-design/icons';
import * as ipc from './ipc';
import {
  appStatus,
  detectText,
  evidenceLines,
  formatElapsed,
  formatUptime,
  healthLabel,
  healthTone,
  primaryPort,
  profileText,
  statusCounts,
  summaryText,
  worstHealth,
} from './format';
import { useSpringStore } from './store';
import { useSpringPrefs } from './prefs';
import type { SpringApp } from './types';
import './spring.css';

const { Text } = Typography;

const SpringView: React.FC = () => {
  const { message } = AntApp.useApp();

  const snapshot = useSpringStore((s) => s.snapshot);
  const loading = useSpringStore((s) => s.loading);
  const retryingPid = useSpringStore((s) => s.retryingPid);
  const error = useSpringStore((s) => s.error);
  const setSnapshot = useSpringStore((s) => s.setSnapshot);
  const setLoading = useSpringStore((s) => s.setLoading);
  const setRetryingPid = useSpringStore((s) => s.setRetryingPid);
  const setError = useSpringStore((s) => s.setError);
  const applyProbe = useSpringStore((s) => s.applyProbe);

  const probeEnabled = useSpringPrefs((s) => s.probeEnabled);
  const setProbeEnabled = useSpringPrefs((s) => s.setProbeEnabled);

  const run = useCallback(
    async (probe: boolean) => {
      setLoading(true);
      setError(null);
      try {
        setSnapshot(await ipc.scan(probe));
      } catch (e) {
        const msg = (e as Error)?.message || String(e);
        setError(msg);
        message.error(`扫描失败：${msg}`);
      } finally {
        setLoading(false);
      }
    },
    [setSnapshot, setLoading, setError, message],
  );

  /* 进模块自动扫一次：这个模块的价值就是「打开就知道现在有什么在跑」 */
  useEffect(() => {
    void run(probeEnabled);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openPage = useCallback(
    async (port: number, path: string) => {
      try {
        await ipc.openPage(port, path);
      } catch (e) {
        message.error(`打开失败：${(e as Error)?.message || e}`);
      }
    },
    [message],
  );

  const retry = useCallback(
    async (pid: number, port: number) => {
      setRetryingPid(pid);
      try {
        const info = await ipc.probeOne(port);
        applyProbe(pid, info, null);
        message.success('探活成功');
      } catch (e) {
        const msg = (e as Error)?.message || String(e);
        applyProbe(pid, null, msg);
        message.warning(`探活失败：${msg}`);
      } finally {
        setRetryingPid(null);
      }
    },
    [setRetryingPid, applyProbe, message],
  );

  const counts = useMemo(
    () => statusCounts(snapshot?.apps ?? []),
    [snapshot],
  );

  const overall = useMemo(
    () => (snapshot && snapshot.apps.length > 0
      ? worstHealth(snapshot.apps.map(appStatus))
      : null),
    [snapshot],
  );

  const renderApp = (a: SpringApp) => {
    const st = appStatus(a);
    const port = primaryPort(a.ports, a.actuator?.baseUrl);
    const extraPorts = a.ports.filter((p) => p !== port);
    return (
      <div className="spring-app" key={a.pid}>
        <div className="spring-app-head">
          <Tag color={healthTone(st)}>{healthLabel(st)}</Tag>
          <Text strong style={{ fontSize: 'calc(var(--wb-font-base) + 1px)' }}>
            {a.name}
          </Text>
          <Tag>pid {a.pid}</Tag>
          {port !== null && <Tag color="blue">:{port}</Tag>}
          {extraPorts.length > 0 && (
            <Tooltip title={`全部监听端口：${a.ports.join(', ')}`}>
              <Tag>+{extraPorts.length}</Tag>
            </Tooltip>
          )}
          <Tag color={a.profiles.length > 0 ? 'geekblue' : 'default'}>
            profile {profileText(a.profiles)}
          </Tag>
          <div className="spring-app-spacer" />
          <Text type="secondary">
            CPU {a.cpuPercent}% · {a.memMb} MB · 运行 {formatUptime(a.uptimeSec)}
          </Text>
        </div>

        <Space size={8} wrap>
          {a.actuator?.components.map((c) => (
            <Tooltip key={c.name} title={c.detail ?? ''}>
              <Tag color={healthTone(c.status)}>
                {c.name} {c.status}
              </Tag>
            </Tooltip>
          ))}
          {a.actuator?.appVersion && (
            <Text type="secondary">版本 {a.actuator.appVersion}</Text>
          )}
          <Tooltip title={evidenceLines(a).join('；') || '命令行上看不出是 Spring Boot'}>
            <Text type="secondary">{detectText(a)}</Text>
          </Tooltip>
        </Space>

        {a.actuatorError && (
          <Alert type="info" showIcon message={`探活：${a.actuatorError}`} />
        )}

        <Space size={8} wrap>
          <Button
            size="small"
            icon={<ReloadOutlined />}
            loading={retryingPid === a.pid}
            disabled={port === null}
            onClick={() => {
              if (port !== null) void retry(a.pid, port);
            }}
          >
            重试探活
          </Button>
          <Button
            size="small"
            type="primary"
            icon={<LinkOutlined />}
            disabled={port === null}
            onClick={() => {
              if (port !== null) void openPage(port, '/actuator/health');
            }}
          >
            健康检查
          </Button>
          <Button
            size="small"
            icon={<ApiOutlined />}
            disabled={port === null}
            onClick={() => {
              if (port !== null) void openPage(port, '/');
            }}
          >
            打开首页
          </Button>
          <Text
            type="secondary"
            copyable={{ text: a.command, tooltips: ['复制启动命令', '已复制'] }}
          >
            复制启动命令
          </Text>
        </Space>

        <Collapse
          ghost
          size="small"
          items={[
            {
              key: 'cmd',
              label: '启动命令',
              children: <pre className="spring-cmd">{a.command}</pre>,
            },
          ]}
        />
      </div>
    );
  };

  return (
    <div className="spring-view">
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Card>
          <Space size={14} wrap>
            <Button
              type="primary"
              icon={<ReloadOutlined />}
              loading={loading}
              onClick={() => void run(probeEnabled)}
            >
              重新扫描
            </Button>
            <Space size={6}>
              <Switch
                size="small"
                checked={probeEnabled}
                onChange={(v) => {
                  setProbeEnabled(v);
                  /* 开关一变就按新设置重扫一次，否则用户会以为没生效 */
                  void run(v);
                }}
              />
              <Tooltip title="向每个候选端口请求 /actuator/health —— 这是最可靠的识别手段；关掉后只能靠命令行特征">
                <Text>Actuator 探活</Text>
              </Tooltip>
            </Space>
            {overall && <Tag color={healthTone(overall)}>{healthLabel(overall)}</Tag>}
            <Text>{summaryText(snapshot)}</Text>
            {snapshot && (
              <Text type="secondary">耗时 {formatElapsed(snapshot.elapsedMs)}</Text>
            )}
          </Space>
        </Card>

        <Card
          title={<span style={{ fontSize: 'calc(var(--wb-font-base) + 2px)' }}>服务</span>}
        >
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            {error && <Alert type="error" showIcon message={error} />}
            {snapshot?.warnings.map((w) => (
              <Alert key={w} type="warning" showIcon message={w} />
            ))}

            {snapshot && counts.bad > 0 && (
              <Alert
                type="error"
                showIcon
                message={`有 ${counts.bad} 个服务不健康`}
                description="展开对应服务可以看到具体是哪个组件挂了（数据库 / Redis / 磁盘…）。"
              />
            )}

            {snapshot?.apps.map(renderApp)}

            {snapshot && snapshot.apps.length === 0 && !loading && (
              <Empty
                description={
                  snapshot.javaProcesses > 0
                    ? `扫到 ${snapshot.javaProcesses} 个 Java 进程，但都不是 Spring Boot`
                    : '没有正在运行的 Java 进程'
                }
              />
            )}

            {!snapshot && !loading && !error && <Empty description="点「重新扫描」开始" />}
          </Space>
        </Card>
      </Space>
    </div>
  );
};

export default SpringView;
