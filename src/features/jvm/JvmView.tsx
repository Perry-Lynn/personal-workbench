/*
 * JVM 进程看板模块 · 主体视图
 * ------------------------------------------------------------------
 * 数据来源：jvm_scan（见 ipc.ts），由 service.ts 的常驻服务定时刷新；
 * 面板只负责展示与触发动作（线程栈 / 堆转储 / 结束进程 / 查端口）。
 *
 * 两条和字号有关的约定：
 *   - 所有自定义字号走 `calc(var(--wb-font-base) ± Npx)`，不写死 px
 *     （设置页的基准字号才能带着它们一起变）
 *   - 横向排布一律用 `<Space wrap>`：字号调大后不换行会把按钮挤出可视区
 * @Author: fu
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Empty,
  Input,
  Modal,
  Popconfirm,
  Progress,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { ReloadOutlined, DeleteOutlined, SearchOutlined, CopyOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
/* 别名：本文件下面有一个同名的「复制并提示」包装（copyText） */
import { copyText as writeClipboard } from '@/core/clipboard';
/*
 * 跨模块只走门面：这里要知道「这个 pid 是不是工作台自己起的 JAR」，
 * 以及「跳到它的日志」。两个能力都由 jarrunner/public.ts 提供，
 * 不 import 它的 store —— 否则 JVM 模块会跟着拖进 JAR 运行器的全部状态。
 */
import { openRunLogs, useRunPidMap } from '@/features/jarrunner/public';
import * as ipc from './ipc';
import {
  CPU_DANGER_AT,
  HEAP_DANGER_AT,
  HEAP_WARN_AT,
  KIND_LABEL,
  classifyProcess,
  displayName,
  formatHeap,
  formatMem,
  formatPorts,
  formatUptime,
  heapPercent,
  severityOf,
} from './format';
import { REFRESH_OPTIONS_SEC, useJvmPrefs } from './prefs';
import { scanJvm, useJvmRuntime } from './service';
import { useJvmStore } from './store';
import type { JavaProcess, JdkInfo, PortOwner, Severity } from './types';
import './jvm.css';

const { Text, Paragraph } = Typography;

/** 严重程度 → 角标/进度条的语义色（warn 没有内置 status，只能给色值） */
const SEVERITY_COLOR: Record<Severity, string> = {
  ok: '#52c41a',
  warn: '#faad14',
  danger: '#ff4d4f',
};

const JDK_SOURCE_LABEL: Record<JdkInfo['source'], string> = {
  sdkman: 'sdkman',
  system: '系统',
  brew: 'Homebrew',
  env: 'JAVA_HOME',
};

const JvmView: React.FC = () => {
  const { message, modal } = AntApp.useApp();

  const processes = useJvmStore((s) => s.processes);
  const jdks = useJvmStore((s) => s.jdks);
  const toolHome = useJvmStore((s) => s.toolHome);
  const warnings = useJvmStore((s) => s.warnings);
  const loading = useJvmStore((s) => s.loading);
  const setLoading = useJvmStore((s) => s.setLoading);
  const setLastError = useJvmStore((s) => s.setLastError);
  const lastError = useJvmStore((s) => s.lastError);

  const lastScanAt = useJvmRuntime((s) => s.lastScanAt);
  const nextScanAt = useJvmRuntime((s) => s.nextScanAt);

  const prefs = useJvmPrefs();

  /*
   * 「这个 pid 是不是工作台自己起的」—— 整张表的日志入口都靠它。
   * 拿不到就什么都不显示：不是本工作台起的进程没有日志可取，
   * 给个点不动的按钮比不给更糟。
   */
  const runPidMap = useRunPidMap();

  /* 线程栈弹窗 */
  const [dump, setDump] = useState<{ pid: number; text: string; name: string } | null>(null);
  const [dumping, setDumping] = useState(false);
  /* 端口查询 */
  const [portText, setPortText] = useState('');
  const [owner, setOwner] = useState<PortOwner | null>(null);
  const [querying, setQuerying] = useState(false);
  /* JDK 管家：验证某台 JDK 的结果弹窗 */
  const [verifying, setVerifying] = useState(false);
  const [verifyOut, setVerifyOut] = useState<{ home: string; label: string; text: string } | null>(
    null,
  );

  /*
   * 「端口 → 进程 → 日志」这条链的最后一跳。
   * 查到的占用者如果是本工作台起的进程，就能直接跳过去看日志；
   * 否则为空 —— 别人的进程没有日志可取，不显示按钮。
   */
  const ownerRunId =
    owner && owner.found && owner.pid != null ? (runPidMap.get(owner.pid) ?? null) : null;

  /* 首次进入时主动扫一次（常驻服务已经扫过，这里保证面板拿到的是最新的） */
  useEffect(() => {
    if (useJvmStore.getState().scannedAt === 0) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLastError(null);
    try {
      await scanJvm();
    } catch (e) {
      const msg = (e as Error)?.message || String(e);
      setLastError(msg);
      message.error(`扫描失败：${msg}`);
    } finally {
      setLoading(false);
    }
  }, [setLoading, setLastError, message]);

  /** 有问题的排前面，其次按内存从大到小 */
  const rows = useMemo(() => {
    const rank: Record<Severity, number> = { danger: 0, warn: 1, ok: 2 };
    return [...processes].sort((a, b) => {
      const d = rank[severityOf(a)] - rank[severityOf(b)];
      return d !== 0 ? d : b.memMb - a.memMb;
    });
  }, [processes]);

  const openThreadDump = useCallback(
    async (p: JavaProcess) => {
      setDumping(true);
      try {
        const r = await ipc.threadDump(p.pid, prefs.toolHome);
        setDump({ pid: p.pid, text: r.text, name: displayName(p) });
      } catch (e) {
        message.error(`抓线程栈失败：${(e as Error)?.message || e}`);
      } finally {
        setDumping(false);
      }
    },
    [prefs.toolHome, message],
  );

  const doHeapDump = useCallback(
    async (p: JavaProcess) => {
      setDumping(true);
      try {
        const r = await ipc.heapDump(p.pid, prefs.toolHome);
        message.success(`堆转储已保存（${r.sizeMb} MB）：${r.path}`);
      } catch (e) {
        message.error(`堆转储失败：${(e as Error)?.message || e}`);
      } finally {
        setDumping(false);
      }
    },
    [prefs.toolHome, message],
  );

  const doKill = useCallback(
    async (p: JavaProcess, force: boolean) => {
      try {
        await ipc.kill(p.pid, force);
        message.success(force ? `已强制结束 ${p.pid}` : `已请求结束 ${p.pid}`);
        await refresh();
      } catch (e) {
        message.error(`结束进程失败：${(e as Error)?.message || e}`);
      }
    },
    [refresh, message],
  );

  const confirmKill = useCallback(
    (p: JavaProcess, force: boolean) => {
      modal.confirm({
        title: force ? `强制结束 ${displayName(p)}（PID ${p.pid}）？` : `结束 ${displayName(p)}（PID ${p.pid}）？`,
        content: force
          ? '将发送 SIGKILL：进程会被立刻杀掉，来不及执行关闭钩子，未落盘的数据会丢失。'
          : '将发送 SIGTERM：进程有机会执行关闭钩子。如果它不响应，可以再来一次「强制结束」。',
        okText: force ? '强制结束' : '结束',
        okButtonProps: { danger: true },
        cancelText: '取消',
        onOk: () => doKill(p, force),
      });
    },
    [modal, doKill],
  );

  const queryPort = useCallback(async () => {
    const port = Number(portText.trim());
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      message.warning('请输入 1~65535 之间的端口号');
      return;
    }
    setQuerying(true);
    try {
      setOwner(await ipc.portOwner(port));
    } catch (e) {
      message.error(`查询失败：${(e as Error)?.message || e}`);
    } finally {
      setQuerying(false);
    }
  }, [portText, message]);

  const columns: ColumnsType<JavaProcess> = [
    {
      title: '进程',
      dataIndex: 'mainClass',
      key: 'name',
      width: 240,
      render: (_, p) => {
        const kind = classifyProcess(p);
        return (
          <div>
            <Space size={6} wrap>
              <Text strong style={{ fontSize: 'calc(var(--wb-font-base) + 0px)' }}>
                {displayName(p)}
              </Text>
              <Tag color={kind === 'other' ? 'default' : 'blue'}>{KIND_LABEL[kind]}</Tag>
            </Space>
            <div>
              <Text
                type="secondary"
                style={{ fontSize: 'calc(var(--wb-font-base) - 3px)' }}
                ellipsis
              >
                {p.mainClass}
              </Text>
            </div>
          </div>
        );
      },
    },
    {
      title: 'PID',
      dataIndex: 'pid',
      key: 'pid',
      width: 80,
      render: (pid: number) => <Text copyable={{ text: String(pid) }}>{pid}</Text>,
    },
    {
      title: '端口',
      key: 'ports',
      width: 140,
      render: (_, p) =>
        p.ports.length > 0 ? (
          <Space size={4} wrap>
            {p.ports.map((port) => (
              <Tag key={port} color="geekblue">
                {port}
              </Tag>
            ))}
          </Space>
        ) : (
          <Text type="secondary">—</Text>
        ),
    },
    {
      title: 'CPU',
      dataIndex: 'cpuPercent',
      key: 'cpu',
      width: 90,
      render: (cpu: number) => {
        const over = cpu >= CPU_DANGER_AT;
        return (
          <Text type={over ? 'danger' : undefined}>{cpu >= 10 ? Math.round(cpu) : cpu.toFixed(1)}%</Text>
        );
      },
    },
    {
      title: '内存',
      dataIndex: 'memMb',
      key: 'mem',
      width: 90,
      render: (mb: number) => formatMem(mb),
    },
    {
      title: '堆占用',
      key: 'heap',
      width: 180,
      render: (_, p) => {
        const pct = heapPercent(p);
        if (pct === null) return <Text type="secondary">—</Text>;
        const sev = severityOf(p);
        return (
          <div>
            <Progress
              percent={pct}
              size="small"
              strokeColor={SEVERITY_COLOR[sev]}
              format={(v) => `${v}%`}
            />
            <Text type="secondary" style={{ fontSize: 'calc(var(--wb-font-base) - 3px)' }}>
              {formatHeap(p.heapUsedMb, p.heapMaxMb)}
            </Text>
          </div>
        );
      },
    },
    {
      title: '运行时长',
      key: 'uptime',
      width: 110,
      render: (_, p) => formatUptime(p.uptimeSec),
    },
    {
      title: 'JDK',
      key: 'jdk',
      width: 90,
      render: (_, p) => p.jdkVersion ?? <Text type="secondary">—</Text>,
    },
    {
      title: '操作',
      key: 'actions',
      width: 240,
      /*
       * 操作列固定在最右边：横向滚动时按钮始终可见。
       * 列宽给够（240），避免在「线程栈 / 堆转储 / 强制」三个按钮换行时把
       * 「强制」挤出可视区 —— 这是用户对当前版本最直接的抱怨。
       */
      fixed: 'right',
      render: (_, p) => (
        <Space size={4} wrap>
          {/* 只有「本工作台起的进程」才有日志可看 —— 其余进程不给这个按钮 */}
          {runPidMap.has(p.pid) && (
            <Tooltip title="跳到 JAR 运行器，看这个进程的实时日志">
              <Button
                size="small"
                type="link"
                onClick={() => openRunLogs(runPidMap.get(p.pid) as string)}
              >
                日志
              </Button>
            </Tooltip>
          )}
          <Button size="small" loading={dumping} onClick={() => void openThreadDump(p)}>
            线程栈
          </Button>
          <Button size="small" loading={dumping} onClick={() => void doHeapDump(p)}>
            堆转储
          </Button>
          <Popconfirm
            title="结束这个进程？"
            description="默认发送 SIGTERM；需要更强硬请在弹窗里选「强制结束」。"
            okText="继续"
            cancelText="取消"
            onConfirm={() => confirmKill(p, false)}
          >
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
          <Button size="small" type="link" onClick={() => confirmKill(p, true)}>
            强制
          </Button>
        </Space>
      ),
    },
  ];

  const jdkOptions = useMemo(
    () => [
      { value: '', label: '自动（挑一台带 jps 的）' },
      ...jdks.map((j) => ({
        value: j.home,
        label: `${j.version || j.id}${j.isDefault ? '（默认）' : ''} · ${JDK_SOURCE_LABEL[j.source]}${
          j.hasTools ? '' : ' · 无 jps'
        }`,
      })),
    ],
    [jdks],
  );

  /**
   * 验证某台 JDK 能不能真的跑起来。
   * 扫目录只证明「路径下有 bin/java」：sdkman current 指到已卸载的版本、
   * x86 JDK 装在 arm Mac 上，都会留下一个跑不起来的 home。
   */
  const verifyJdk = useCallback(
    async (j: JdkInfo) => {
      setVerifying(true);
      try {
        const text = await ipc.jdkVersion(j.home);
        setVerifyOut({ home: j.home, label: j.version || j.id, text });
      } catch (e) {
        message.error(`验证失败：${(e as Error)?.message || e}`);
      } finally {
        setVerifying(false);
      }
    },
    [message],
  );

  /*
   * 复制一段文本到剪贴板，并给出提示。
   * 真正的复制（插件 + navigator 兜底）在 @/core/clipboard，这里只管提示文案。
   */
  const copyText = useCallback(
    (text: string, tip: string) => {
      writeClipboard(text)
        .then(() => message.success(tip))
        .catch(() => message.warning('复制失败，请手动选中复制'));
    },
    [message],
  );

  const jdkColumns: ColumnsType<JdkInfo> = [
    {
      title: '版本',
      key: 'version',
      width: 150,
      render: (_, j) => (
        <Space size={6} wrap>
          <Text strong>{j.version || '未知版本'}</Text>
          {j.isDefault && <Tag color="green">默认</Tag>}
          {!j.hasTools && <Tag color="red">无 jps</Tag>}
        </Space>
      ),
    },
    {
      title: '厂商',
      dataIndex: 'vendor',
      key: 'vendor',
      width: 140,
      render: (v: string) => v || <Text type="secondary">—</Text>,
    },
    {
      title: '来源',
      dataIndex: 'source',
      key: 'source',
      width: 100,
      render: (s: JdkInfo['source']) => <Tag>{JDK_SOURCE_LABEL[s]}</Tag>,
    },
    {
      title: 'JAVA_HOME',
      dataIndex: 'home',
      key: 'home',
      render: (home: string) => (
        <Text copyable={{ text: home }} ellipsis style={{ maxWidth: 460 }}>
          {home}
        </Text>
      ),
    },
    {
      title: '工具',
      key: 'tools',
      width: 260,
      /*
       * 直接列出**有哪些**工具，而不是只给一个「可用/不可用」：
       * JRE 也能列出进程（jps 在）但抓不了线程栈（jstack 不在），
       * 只给布尔值的话用户点了「线程栈」才会失败，那时他只会以为功能坏了。
       */
      render: (_, j) => (
        <Space size={4} wrap>
          {j.tools.map((t) => (
            <Tag key={t} color={t === 'java' ? 'default' : 'blue'}>
              {t}
            </Tag>
          ))}
        </Space>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 260,
      fixed: 'right',
      render: (_, j) => (
        <Space size={4} wrap>
          <Button size="small" loading={verifying} onClick={() => void verifyJdk(j)}>
            验证
          </Button>
          <Tooltip title={`复制：export JAVA_HOME="${j.home}"`}>
            <Button
              size="small"
              icon={<CopyOutlined />}
              onClick={() =>
                copyText(`export JAVA_HOME="${j.home}"`, `已复制 JAVA_HOME（${j.version || j.id}）`)
              }
            >
              复制 JAVA_HOME
            </Button>
          </Tooltip>
          {j.source === 'sdkman' && (
            <Tooltip title={`复制：sdk use java ${j.id}`}>
              <Button size="small" onClick={() => copyText(`sdk use java ${j.id}`, '已复制 sdk use 命令')}>
                sdk use
              </Button>
            </Tooltip>
          )}
          <Button
            size="small"
            type={prefs.toolHome === j.home ? 'primary' : 'default'}
            onClick={() => {
              prefs.setToolHome(j.home);
              message.success(`已用 ${j.version || j.id} 采集，下次扫描生效`);
            }}
          >
            用它采集
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div className="jvm-view">
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Card
          title={<span style={{ fontSize: 'calc(var(--wb-font-base) + 2px)' }}>JVM 进程</span>}
          extra={
            <Space size={8} wrap>
              <Button
                icon={<ReloadOutlined />}
                loading={loading}
                onClick={() => void refresh()}
              >
                刷新
              </Button>
            </Space>
          }
        >
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Space size={12} wrap>
              <Space size={6}>
                <Switch
                  checked={prefs.autoRefresh}
                  onChange={prefs.setAutoRefresh}
                  size="small"
                />
                <Text>自动刷新</Text>
              </Space>
              <Space size={6}>
                <Text type="secondary">间隔</Text>
                <Select
                  size="small"
                  style={{ width: 96 }}
                  value={prefs.refreshIntervalSec}
                  onChange={prefs.setRefreshInterval}
                  options={REFRESH_OPTIONS_SEC.map((s) => ({ value: s, label: `${s} 秒` }))}
                />
              </Space>
              <Space size={6}>
                <Text type="secondary">采集用的 JDK</Text>
                <Select
                  size="small"
                  style={{ minWidth: 240 }}
                  value={prefs.toolHome ?? ''}
                  onChange={(v) => prefs.setToolHome(v || null)}
                  options={jdkOptions}
                />
              </Space>
              <Space size={6}>
                <Switch
                  checked={prefs.pushToBadge}
                  onChange={prefs.setPushToBadge}
                  size="small"
                />
                <Tooltip title="堆占用或 CPU 到阈值时，往已连接的 AI-Passport 徽章推一条提醒">
                  <Text>推送告警到徽章</Text>
                </Tooltip>
              </Space>
            </Space>

            <Space size={8} wrap>
              <Input
                size="small"
                style={{ width: 120 }}
                placeholder="端口号"
                value={portText}
                onChange={(e) => setPortText(e.target.value)}
                onPressEnter={() => void queryPort()}
              />
              <Button
                size="small"
                icon={<SearchOutlined />}
                loading={querying}
                onClick={() => void queryPort()}
              >
                谁占了这个端口
              </Button>
              {owner && (
                <Space size={6}>
                  <Text type={owner.found ? undefined : 'secondary'}>
                    {owner.found
                      ? `${owner.port} 被 ${owner.command}（PID ${owner.pid}）占着`
                      : `${owner.port} 现在没人监听`}
                  </Text>
                  {ownerRunId && (
                    <>
                      <Text type="secondary">· 本工作台启动</Text>
                      <Button size="small" type="link" onClick={() => openRunLogs(ownerRunId)}>
                        看日志
                      </Button>
                    </>
                  )}
                </Space>
              )}
            </Space>

            <Space size={12} wrap>
              <Text type="secondary">
                {processes.length > 0
                  ? `${processes.length} 个进程 · 端口 ${formatPorts(processes.flatMap((p) => p.ports))}`
                  : '没有运行中的 Java 进程'}
              </Text>
              {lastScanAt > 0 && (
                <Text type="secondary">
                  最近扫描 {new Date(lastScanAt * 1000).toLocaleTimeString()}
                  {nextScanAt > 0 ? ` · 下次 ${new Date(nextScanAt * 1000).toLocaleTimeString()}` : ''}
                </Text>
              )}
              {toolHome && (
                <Tooltip title={toolHome}>
                  <Text type="secondary" ellipsis style={{ maxWidth: 320 }}>
                    采集用 {toolHome}
                  </Text>
                </Tooltip>
              )}
            </Space>

            {lastError && <Alert type="error" showIcon message={lastError} />}

            {warnings.map((w) => (
              <Alert key={w} type="warning" showIcon message={w} />
            ))}

            {processes.length === 0 && !loading ? (
              <Empty description="没有运行中的 Java 进程（或没找到可用的 JDK，见上方提示）" />
            ) : (
              <Table<JavaProcess>
                rowKey="pid"
                size="small"
                columns={columns}
                dataSource={rows}
                loading={loading}
                pagination={false}
                /*
                 * scroll.x 给各列宽之和 + buffer：
                 - 进程 240 + PID 80 + 端口 140 + CPU 90 + 内存 90 + 堆 180 + 运行时 110 + JDK 90 + 操作 240 = 1260
                 - 加上列间距与「强制」按钮可能换行的余量（操作列 fixed right 通常要更宽一点）= 1320
                 - 这样 1280px 屏（主区 ~1040px）会有横向滚动，但「操作」始终贴着右边界可见。
                 */
                scroll={{ x: 1320, y: 'calc(100vh - 380px)' }}
              />
            )}
          </Space>
        </Card>

        <Card
          title={<span style={{ fontSize: 'calc(var(--wb-font-base) + 2px)' }}>已安装的 JDK</span>}
          extra={<Text type="secondary">{jdks.length > 0 ? `${jdks.length} 台` : '未找到'}</Text>}
        >
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Text type="secondary" style={{ fontSize: 'calc(var(--wb-font-base) - 2px)' }}>
              「验证」会真的跑一次 java -version —— 目录里有 bin/java 不代表它能执行
              （sdkman 的 current 可能指向已卸载的版本）。缺 jstack 的 JDK 抓不了线程栈。
            </Text>
            {jdks.length === 0 ? (
              <Empty description="没有在常见位置找到 JDK（sdkman / JavaVirtualMachines / Homebrew / JAVA_HOME）" />
            ) : (
              <Table<JdkInfo>
                rowKey="home"
                size="small"
                columns={jdkColumns}
                dataSource={jdks}
                pagination={false}
                scroll={{ x: 1180 }}
              />
            )}
          </Space>
        </Card>

        <Modal
          open={dump !== null}
          title={dump ? `线程栈 · ${dump.name}（PID ${dump.pid}）` : ''}
          width={860}
          onCancel={() => setDump(null)}
          footer={[
            <Button
              key="copy"
              onClick={() => {
                navigator.clipboard
                  .writeText(dump?.text ?? '')
                  .then(() => message.success('已复制到剪贴板'))
                  .catch(() => message.warning('复制失败，请手动选中复制'));
              }}
            >
              复制
            </Button>,
            <Button key="close" type="primary" onClick={() => setDump(null)}>
              关闭
            </Button>,
          ]}
        >
          <Paragraph type="secondary" style={{ fontSize: 'calc(var(--wb-font-base) - 3px)' }}>
            用 jstack -l 抓取；死锁检测依赖它额外打印的 ownable synchronizers。
          </Paragraph>
          <pre className="jvm-dump">{dump?.text ?? ''}</pre>
        </Modal>

        <Modal
          open={verifyOut !== null}
          title={verifyOut ? `java -version · ${verifyOut.label}` : ''}
          width={720}
          onCancel={() => setVerifyOut(null)}
          footer={[
            <Button
              key="copy"
              onClick={() => copyText(verifyOut?.text ?? '', '已复制输出')}
            >
              复制
            </Button>,
            <Button key="close" type="primary" onClick={() => setVerifyOut(null)}>
              关闭
            </Button>,
          ]}
        >
          <pre className="jvm-dump">{verifyOut?.text ?? ''}</pre>
        </Modal>
      </Space>

      {/*
       * 堆占用阈值的说明放在最后：这两个数字决定了角标什么时候变黄变红，
       * 不说清楚的话用户看到变色只会以为是随机告警。
       */}
      <Text type="secondary" style={{ fontSize: 'calc(var(--wb-font-base) - 3px)' }}>
        告警阈值：堆占用 ≥ {HEAP_WARN_AT}% 转黄、≥ {HEAP_DANGER_AT}% 转红；CPU ≥ 150% 转黄、≥{' '}
        {CPU_DANGER_AT}% 转红。ps 的 CPU 是进程生命周期内的平均值，不是瞬时值。
      </Text>
    </div>
  );
};

export default JvmView;
