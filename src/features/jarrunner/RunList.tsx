/*
 * JAR 运行器 · 运行记录列表
 * ------------------------------------------------------------------
 * 一条记录 = 一次启动。已结束的也留着（要看退出码与最后的日志），
 * 想清掉要点「移除」—— 自动消失的话，用户刚切走回来就找不到刚才的输出了。
 *
 * 时长要自己 tick：它显示的是「到现在为止跑了多久」，
 * 不给一个每秒推进的 now，界面上的时间会一直停在开始那一刻。
 * @Author: fu
 */
import React, { useEffect, useState } from 'react';
import { Button, Empty, Tag, Tooltip, Typography } from 'antd';
import { DeleteOutlined, StopOutlined } from '@ant-design/icons';
import { elapsedText, statusMeta } from './format';
import { useJarRunnerStore } from './store';

const { Text } = Typography;

interface RunListProps {
  onStop: (id: string) => void;
  onRemove: (id: string) => void;
}

const RunList: React.FC<RunListProps> = ({ onStop, onRemove }) => {
  const runs = useJarRunnerStore((s) => s.runs);
  const activeRunId = useJarRunnerStore((s) => s.activeRunId);
  const setActiveRun = useJarRunnerStore((s) => s.setActiveRun);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    /* 只在有进程在跑时才 tick：全停下来之后没必要每秒重渲染 */
    if (!runs.some((r) => r.status === 'running')) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [runs]);

  if (runs.length === 0) {
    return (
      <div className="jar-runs">
        <Empty description="还没有运行过" />
      </div>
    );
  }

  return (
    <div className="jar-runs">
      {runs.map((r) => {
        const meta = statusMeta(r.status);
        return (
          <div
            key={r.id}
            className={`jar-run${r.id === activeRunId ? ' jar-run-active' : ''}`}
            onClick={() => setActiveRun(r.id)}
          >
            <div className="jar-run-head">
              <span className="jar-run-name" title={r.name}>
                {r.name}
              </span>
              <Tag color={meta.tone} bordered={false}>
                {meta.label}
              </Tag>
            </div>
            <div className="jar-run-meta">
              pid {r.pid ?? '-'} · {elapsedText(r.startedAt, r.endedAt, now)}
              {r.exitCode !== null ? ` · 退出码 ${r.exitCode}` : ''}
            </div>
            <Tooltip title={r.command}>
              <div className="jar-run-cmd">{r.command}</div>
            </Tooltip>
            <div className="jar-run-meta">{r.jdkLabel}</div>
            {r.error ? (
              <Text type="danger" className="jar-run-err">
                {r.error}
              </Text>
            ) : null}
            <div className="jar-run-ops">
              {r.status === 'running' && (
                <Button
                  size="small"
                  danger
                  icon={<StopOutlined />}
                  onClick={(e) => {
                    e.stopPropagation();
                    onStop(r.id);
                  }}
                >
                  停止
                </Button>
              )}
              <Button
                size="small"
                type="text"
                icon={<DeleteOutlined />}
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(r.id);
                }}
              >
                移除
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default RunList;
