/*
 * AI-Passport 蓝牙模块 · 主体视图
 * ------------------------------------------------------------------
 * 功能（严格只做蓝牙连接与推送，不碰固件逻辑）：
 *   1. 扫描周围 AI-Passport 设备
 *   2. 连接 / 断开
 *   3. 向徽章推送 通知 / 提醒 / 日程（<类别>|<来源>|<正文>）
 *   4. 清空设备通知列表
 * 设备只接收不下发，UI 状态来自后端事件 aipassport:state / aipassport:devices。
 */
import React, { useEffect, useState } from 'react';
import {
  App as AntApp,
  Alert,
  Button,
  Card,
  Empty,
  Input,
  List,
  Select,
  Space,
  Tag,
} from 'antd';
import {
  ApiOutlined,
  ClearOutlined,
  CloseOutlined,
  ReloadOutlined,
  SendOutlined,
} from '@ant-design/icons';
import { CATEGORY_OPTIONS, type PushCategory } from './types';
import * as ipc from './ipc';
import { useAiPassportStore } from './store';
import './aipassport.css';

const AiPassportView: React.FC = () => {
  const { message } = AntApp.useApp();

  const devices = useAiPassportStore((s) => s.devices);
  const conn = useAiPassportStore((s) => s.conn);
  const lastResult = useAiPassportStore((s) => s.lastResult);
  const setDevices = useAiPassportStore((s) => s.setDevices);
  const setConn = useAiPassportStore((s) => s.setConn);
  const setLastResult = useAiPassportStore((s) => s.setLastResult);

  const [scanning, setScanning] = useState(false);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [pushing, setPushing] = useState(false);
  const [category, setCategory] = useState<PushCategory>('SCHED');
  const [source, setSource] = useState('');
  const [body, setBody] = useState('');

  /* 订阅后端事件 + 首次拉取状态 */
  useEffect(() => {
    let unDevices: (() => void) | undefined;
    let unState: (() => void) | undefined;
    (async () => {
      unDevices = await ipc.onDevices((d) => setDevices(d));
      unState = await ipc.onState((s) => setConn(s));
      try {
        setConn(await ipc.getState());
      } catch {
        /* 后端未就绪时忽略 */
      }
    })();
    return () => {
      unDevices?.();
      unState?.();
    };
  }, [setDevices, setConn]);

  const handleScan = async () => {
    setScanning(true);
    setConn({
      state: 'scanning',
      device_id: conn.device_id,
      device_name: conn.device_name,
      error: null,
    });
    try {
      const list = await ipc.scan(8000);
      setDevices(list);
      if (list.length === 0) {
        message.warning('未扫描到 AI-Passport。请确认徽章已开机、蓝牙可连接，且本机蓝牙已开启。');
      } else {
        message.success(`找到 ${list.length} 个设备`);
      }
    } catch (e) {
      message.error((e as Error).message || '扫描失败');
    } finally {
      setScanning(false);
    }
  };

  const handleConnect = async (id: string) => {
    setConnectingId(id);
    try {
      const dev = await ipc.connect(id);
      message.success(`已连接 ${dev.name}`);
      setLastResult(null);
    } catch (e) {
      message.error((e as Error).message || '连接失败');
    } finally {
      setConnectingId(null);
    }
  };

  const handleDisconnect = async () => {
    try {
      await ipc.disconnect();
      message.success('已断开');
    } catch (e) {
      message.error((e as Error).message || '断开失败');
    }
  };

  const handlePush = async () => {
    if (!body.trim()) {
      message.warning('请填写正文');
      return;
    }
    setPushing(true);
    try {
      const r = await ipc.push(category, source.trim(), body.trim());
      setLastResult(r.text);
      message.success(`已推送（${r.bytes} 字节）`);
    } catch (e) {
      message.error((e as Error).message || '推送失败');
    } finally {
      setPushing(false);
    }
  };

  const handleClear = async () => {
    try {
      const r = await ipc.clearDevice();
      setLastResult(r.text);
      message.success('已发送清空指令');
    } catch (e) {
      message.error((e as Error).message || '清空失败');
    }
  };

  const statusTag = (() => {
    switch (conn.state) {
      case 'connected':
        return <Tag color="success">已连接{conn.device_name ? ` · ${conn.device_name}` : ''}</Tag>;
      case 'connecting':
        return <Tag color="processing">连接中…</Tag>;
      case 'scanning':
        return <Tag color="processing">扫描中…</Tag>;
      case 'error':
        return <Tag color="error">错误</Tag>;
      default:
        return <Tag>未连接</Tag>;
    }
  })();

  const connected = conn.state === 'connected';

  /* 实时字节数（固件按字节计，中文 3 字节/字，故用 TextEncoder 而非 length）。
   * 绑定约束是设备存储上限：正文 95 字节(NOTIF_TEXT_MAX-1)、来源 23 字节(NOTIF_SOURCE_MAX-1)；
   * 超长**整条推送会被拒绝**（不是截断），所以这里提前提示并禁推。 */
  const bodyBytes = new TextEncoder().encode(body.trim()).length;
  const sourceBytes = new TextEncoder().encode(source.trim()).length;
  const overLimit = bodyBytes > 95 || sourceBytes > 23;

  return (
    <div className="aipassport-root">
      <div className="aipassport-title">
        <ApiOutlined className="aipassport-title-icon" />
        <h2>AI Passport</h2>
        {statusTag}
      </div>
      <p className="aipassport-subtitle">
        通过蓝牙连接 AI-Passport 徽章，推送通知 / 提醒 / 日程，或清空设备列表。
      </p>

      <Alert
        type="info"
        showIcon
        className="aipassport-tip"
        message="需要持有物理 AI-Passport 且本机蓝牙已开启才能连接。macOS 有时会抢先连上附近 BLE 设备导致扫描不到，遇到时复位一下徽章即可。"
      />

      <Card
        className="aipassport-card"
        title="设备"
        extra={
          <Button icon={<ReloadOutlined />} loading={scanning} onClick={handleScan}>
            扫描设备
          </Button>
        }
      >
        <List
          dataSource={devices}
          locale={{ emptyText: <Empty description="尚未扫描到设备，点右上角「扫描设备」" /> }}
          renderItem={(d) => {
            const isConnected = connected && conn.device_id === d.id;
            return (
              <List.Item
                actions={[
                  isConnected ? (
                    <Tag color="success" key="c">
                      已连接
                    </Tag>
                  ) : (
                    <Button
                      key="conn"
                      size="small"
                      type="primary"
                      loading={connectingId === d.id}
                      disabled={connected}
                      onClick={() => handleConnect(d.id)}
                    >
                      连接
                    </Button>
                  ),
                ]}
              >
                <List.Item.Meta
                  title={d.name}
                  description={<span className="aipassport-device-id">{d.id}</span>}
                />
              </List.Item>
            );
          }}
        />
      </Card>

      {connected && (
        <Card className="aipassport-card" title="推送通知" extra={
          <Button danger size="small" icon={<CloseOutlined />} onClick={handleDisconnect}>
            断开
          </Button>
        }>
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Space wrap>
              <Select<PushCategory>
                value={category}
                onChange={(v) => setCategory(v)}
                options={CATEGORY_OPTIONS}
                style={{ width: 120 }}
              />
              <Input
                placeholder="来源（如：日历 / 钉钉）"
                value={source}
                onChange={(e) => setSource(e.target.value)}
                style={{ width: 220 }}
              />
            </Space>
            <Input.TextArea
              rows={3}
              placeholder="正文（推送到徽章上显示的内容）"
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
            <div
              className="aipassport-bytecount"
              style={{ color: overLimit ? '#cf1322' : 'rgba(0,0,0,0.45)', fontSize: 12 }}
            >
              正文 {bodyBytes}/95 字节 · 来源 {sourceBytes}/23 字节（超长会被拒绝，内容送不出去）
            </div>
            <Space>
              <Button
                type="primary"
                icon={<SendOutlined />}
                loading={pushing}
                disabled={overLimit}
                onClick={handlePush}
              >
                推送
              </Button>
              <Button icon={<ClearOutlined />} onClick={handleClear}>
                清空设备
              </Button>
            </Space>
          </Space>
        </Card>
      )}

      {conn.error && (
        <Alert type="error" showIcon message={conn.error} className="aipassport-tip" />
      )}
      {lastResult && !conn.error && (
        <Alert
          type="success"
          showIcon
          message={`最近发送：${lastResult}`}
          className="aipassport-tip"
        />
      )}
    </div>
  );
};

export default AiPassportView;
