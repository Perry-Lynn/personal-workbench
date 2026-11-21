import React, { useEffect, useMemo, useState } from 'react';
import { App as AntApp, Button, Card, Empty, Input, Modal, Popconfirm, Select, Space, Tag, Typography } from 'antd';
import { FolderOpenOutlined, LinkOutlined, PlusOutlined, ProjectOutlined } from '@ant-design/icons';
import { open } from '@tauri-apps/plugin-dialog';
import { useWorkbenchStore } from '@/store/useWorkbenchStore';
import { openProjectRepo } from '@/features/git/public';
import { listProjectConfigs, openProjectConfig } from '@/features/jarrunner/public';
import { listServersForProjects, openServerSettings } from '@/features/logsight/public';
import { makeProject, openDirectory, openExternalUrl, readProjects, writeProjects } from './store';
import type { Project, ProjectsState } from './types';
import './projects.css';

type Named = { id: string; name: string };
const ProjectsView: React.FC = () => {
  const { message } = AntApp.useApp();
  const [data, setData] = useState<ProjectsState>(() => readProjects());
  const [dialog, setDialog] = useState(false);
  const [name, setName] = useState('');
  const [renameId, setRenameId] = useState<string | null>(null);
  const [linkProjectId, setLinkProjectId] = useState<string | null>(null);
  const [linkName, setLinkName] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [jarItems, setJarItems] = useState<Named[]>([]);
  const [serverItems, setServerItems] = useState<Named[]>([]);
  const hidden = useWorkbenchStore((s) => s.modulePrefs);
  const activeModuleId = useWorkbenchStore((s) => s.activeModuleId);
  const refresh = () => setData(readProjects());
  const reloadAssociations = async () => {
    const [jars, servers] = await Promise.all([listProjectConfigs(), listServersForProjects()]);
    setJarItems(jars); setServerItems(servers);
  };
  useEffect(() => {
    const onChange = () => refresh();
    window.addEventListener('storage', onChange);
    window.addEventListener('workbench:projects-changed', onChange);
    return () => { window.removeEventListener('storage', onChange); window.removeEventListener('workbench:projects-changed', onChange); };
  }, []);
  useEffect(() => {
    if (activeModuleId === 'projects') void reloadAssociations().catch((e) => message.error(`读取项目关联列表失败：${String(e)}`));
  }, [activeModuleId]);
  const active = useMemo(() => data.items.find((p) => p.id === data.activeProjectId) ?? null, [data]);
  const persist = (next: ProjectsState) => { writeProjects(next); setData(next); };
  const update = (id: string, fn: (p: Project) => Project) => persist({ ...data, items: data.items.map((p) => p.id === id ? fn(p) : p) });
  const create = () => {
    const title = name.trim();
    if (!title) return;
    const p = makeProject(title);
    persist({ ...data, activeProjectId: data.activeProjectId ?? p.id, items: [p, ...data.items] });
    setName(''); setDialog(false);
  };
  const pickRepo = async (p: Project) => {
    if (hidden.git?.hidden) { message.warning('Git 模块已隐藏，请先到设置中显示它，再关联并打开仓库。'); return; }
    const path = await open({ directory: true, multiple: false, title: '选择 Git 仓库目录' });
    if (typeof path !== 'string') return;
    try {
      await openProjectRepo(path);
      update(p.id, (x) => ({ ...x, repoPath: path }));
      message.success('仓库已打开并关联到项目');
    } catch (e) { message.error(`打开仓库失败，项目关联未更改：${String(e)}`); }
  };
  const addDirectory = async (p: Project) => {
    const path = await open({ directory: true, multiple: false, title: '选择项目目录' });
    if (typeof path !== 'string') return;
    const label = path.split(/[\\/]/).filter(Boolean).pop() || path;
    update(p.id, (x) => ({ ...x, directories: [...x.directories, { id: crypto.randomUUID(), name: label, path }] }));
  };
  const addLink = () => {
    let url: URL;
    try { url = new URL(linkUrl.trim()); } catch { message.error('请输入有效的网址'); return; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) { message.error('仅支持不含用户名或密码的 HTTP(S) 网址'); return; }
    const title = linkName.trim();
    if (!title || !linkProjectId) { message.error('请填写链接名称'); return; }
    update(linkProjectId, (x) => ({ ...x, links: [...x.links, { id: crypto.randomUUID(), name: title, url: url.toString() }] }));
    setLinkProjectId(null); setLinkName(''); setLinkUrl('');
  };
  return <div className="h-full w-full overflow-y-auto"><div className="max-w-6xl mx-auto px-8 py-7">
    <div className="projects-row mb-5"><div><Typography.Title level={2} className="!mb-1">项目工作区</Typography.Title><Typography.Text type="secondary">切换项目只切换当前项目；打开仓库、加载配置和服务器编辑都由你显式触发。</Typography.Text></div><Button type="primary" icon={<PlusOutlined />} onClick={() => setDialog(true)}>新建项目</Button></div>
    <div className="projects-grid">{data.items.map((p) => <Card key={p.id} className="projects-card" styles={{ body: { padding: 0 } }}>
      <div className="projects-row"><Space><ProjectOutlined /><Typography.Title level={4} className="!mb-0">{p.name}</Typography.Title></Space>{p.id === data.activeProjectId ? <Tag color="green">当前项目</Tag> : <Button size="small" onClick={() => persist({ ...data, activeProjectId: p.id })}>切换到此项目</Button>}</div>
      <div className="projects-muted mt-3">仓库：{p.repoPath || '未关联'}</div>
      {hidden.git?.hidden && <Typography.Text type="warning" className="block mt-2">Git 已隐藏，去设置显示模块后才能打开仓库。 <Button size="small" type="link" onClick={() => useWorkbenchStore.getState().setActiveModule('settings')}>前往设置</Button></Typography.Text>}
      <Space wrap className="mt-3"><Button size="small" onClick={() => void pickRepo(p)}>关联/更换仓库</Button><Button size="small" disabled={!p.repoPath || !!hidden.git?.hidden} onClick={() => p.repoPath && openProjectRepo(p.repoPath).catch((e) => message.error(`仓库打开失败：${String(e)}`))}>打开 Git</Button><Button size="small" icon={<FolderOpenOutlined />} onClick={() => void addDirectory(p)}>添加目录</Button><Button size="small" icon={<LinkOutlined />} onClick={() => { setLinkProjectId(p.id); setLinkName(''); setLinkUrl(''); }}>添加网址</Button><Button size="small" onClick={() => { setName(p.name); setRenameId(p.id); }}>重命名</Button></Space>
      <div className="mt-4"><Typography.Text strong>JAR 配置</Typography.Text>{hidden.jarrunner?.hidden && <Typography.Text type="warning" className="block mt-2">JAR 运行器已隐藏，去设置显示模块后才能加载配置。 <Button size="small" type="link" onClick={() => useWorkbenchStore.getState().setActiveModule('settings')}>前往设置</Button></Typography.Text>}{p.jarConfigIds.length ? p.jarConfigIds.map((id) => { const item = jarItems.find((x) => x.id === id); return <div className="projects-row mt-2" key={id}><span>{item?.name ?? `失效关联：${id}`}</span><Space><Button size="small" disabled={!item || !!hidden.jarrunner?.hidden} onClick={() => { if (!item) { message.warning('JAR 配置关联已失效，请刷新或移除'); return; } if (hidden.jarrunner?.hidden) { message.warning('JAR 运行器已隐藏，请先到设置中显示它。'); return; } void openProjectConfig(id).catch((e) => message.error(`加载配置失败：${String(e)}`)); }}>加载配置</Button><Button size="small" type="link" onClick={() => update(p.id, (x) => ({ ...x, jarConfigIds: x.jarConfigIds.filter((v) => v !== id) }))}>移除</Button></Space></div>; }) : <div className="projects-muted mt-2">暂无关联</div>}<Select className="w-full mt-2" placeholder="关联已保存的 JAR 配置" options={jarItems.filter((x) => !p.jarConfigIds.includes(x.id)).map((x) => ({ value: x.id, label: x.name }))} onChange={(id) => update(p.id, (x) => ({ ...x, jarConfigIds: [...x.jarConfigIds, id] }))} /></div>
      <div className="mt-4"><Typography.Text strong>LogSight 服务器</Typography.Text>{hidden.logsight?.hidden && <Typography.Text type="warning" className="block mt-2">LogSight 已隐藏，去设置显示模块后才能编辑服务器配置。 <Button size="small" type="link" onClick={() => useWorkbenchStore.getState().setActiveModule('settings')}>前往设置</Button></Typography.Text>}{p.logServerIds.length ? p.logServerIds.map((id) => { const item = serverItems.find((x) => x.id === id); return <div className="projects-row mt-2" key={id}><span>{item?.name ?? `失效关联：${id}`}</span><Space><Button size="small" disabled={!item || !!hidden.logsight?.hidden} onClick={() => { if (!item) { message.warning('服务器关联已失效，请刷新或移除'); return; } if (hidden.logsight?.hidden) { message.warning('LogSight 已隐藏，请先到设置中显示它。'); return; } void openServerSettings(id).catch((e) => message.error(`打开服务器配置失败：${String(e)}`)); }}>服务器配置</Button><Button size="small" type="link" onClick={() => update(p.id, (x) => ({ ...x, logServerIds: x.logServerIds.filter((v) => v !== id) }))}>移除</Button></Space></div>; }) : <div className="projects-muted mt-2">暂无关联</div>}<Select className="w-full mt-2" placeholder="关联已保存的服务器" options={serverItems.filter((x) => !p.logServerIds.includes(x.id)).map((x) => ({ value: x.id, label: x.name }))} onChange={(id) => update(p.id, (x) => ({ ...x, logServerIds: [...x.logServerIds, id] }))} /></div>
      {(p.directories.length > 0 || p.links.length > 0) && <div className="mt-4"><Typography.Text strong>目录与网址</Typography.Text>{p.directories.map((d) => <div className="projects-row mt-2" key={d.id}><span title={d.path}>{d.name}</span><Space><Button size="small" onClick={() => openDirectory(d.path).catch((e) => message.error(String(e)))}>打开目录</Button><Button size="small" type="link" onClick={() => update(p.id, (x) => ({ ...x, directories: x.directories.filter((v) => v.id !== d.id) }))}>移除</Button></Space></div>)}{p.links.map((l) => <div className="projects-row mt-2" key={l.id}><Button type="link" onClick={() => openExternalUrl(l.url).catch((e) => message.error(String(e)))}>{l.name}</Button><Button size="small" type="link" onClick={() => update(p.id, (x) => ({ ...x, links: x.links.filter((v) => v.id !== l.id) }))}>移除</Button></div>)}</div>}
      <div className="flex justify-end mt-4"><Popconfirm title="删除项目？" description="仅删除工作区记录，不会删除仓库或配置。" onConfirm={() => persist({ ...data, activeProjectId: data.activeProjectId === p.id ? null : data.activeProjectId, items: data.items.filter((x) => x.id !== p.id) })}><Button danger type="text">删除项目</Button></Popconfirm></div>
    </Card>)}</div>{data.items.length === 0 && <Empty description="创建一个项目以集中管理常用入口" />}
    <Modal title="新建项目" open={dialog} onCancel={() => setDialog(false)} onOk={create} okText="创建"><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} onPressEnter={create} placeholder="项目名称" /></Modal>
    <Modal title="重命名项目" open={!!renameId} onCancel={() => setRenameId(null)} onOk={() => { const id = renameId; const title = name.trim(); if (!id || !title) { message.error('项目名称不能为空'); return; } update(id, (p) => ({ ...p, name: title })); setRenameId(null); }} okText="保存"><Input value={name} onChange={(e) => setName(e.target.value)} /></Modal>
    <Modal title="添加网址" open={!!linkProjectId} onCancel={() => setLinkProjectId(null)} onOk={addLink} okText="添加"><Space direction="vertical" className="w-full"><Input placeholder="链接名称" value={linkName} onChange={(e) => setLinkName(e.target.value)} /><Input placeholder="https://example.com" value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} /></Space></Modal>
    {active && <div className="projects-muted mt-4">当前项目：{active.name}</div>}
  </div></div>;
};
export default ProjectsView;
