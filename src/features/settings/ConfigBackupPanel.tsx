import { useState } from 'react';
import { App as AntApp, Button, Checkbox, Descriptions, Space, Tag, Typography } from 'antd';
import { open } from '@tauri-apps/plugin-dialog';
import { call } from '@/core/ipc';
import { exportTextFile } from '@/core/export';
import { useWorkbenchStore } from '@/store/useWorkbenchStore';
import { buildSafeBackup, clearBackupImportPreview, parseSafeBackup, projectBackupState, type BackupSection, type SafeBackup } from '@/core/configBackup';
import { applyWithLocalRollback } from '@/core/configBackupApply';
import { applySafeBackupState as applyGitBackup, readSafeBackupState as readGitBackup } from '@/features/git/public';
import { applySafeBackupProjects, readSafeBackupProjects } from '@/features/projects/public';
import { listSafeBackupConfigs, reloadSavedConfigs } from '@/features/jarrunner/public';
import { listSafeBackupServers, reloadSavedServerList } from '@/features/logsight/public';

const LABELS: Record<BackupSection, string> = { workbench: '工作台外观与布局', projects: '项目工作区', git: 'Git 最近仓库与偏好', jarrunner: 'JAR 配置', logsight: 'LogSight 服务器配置' };
const KEYS = ['workbench:theme','workbench:font-size','workbench:sider-collapsed','workbench:sider-width','workbench:module-prefs','workbench:module-order','workbench:home-layout','workbench:projects','workbench:git-recent-repos','workbench:git-prefs'];
function collectPaths(value: unknown, key = '', out: string[] = []): string[] {
  if (typeof value === 'string' && value.startsWith('/') && !out.includes(value)) out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectPaths(v, key, out));
  else if (value && typeof value === 'object') Object.entries(value).forEach(([k,v]) => collectPaths(v, k, out));
  return out;
}

export default function ConfigBackupPanel() {
  const { message, modal } = AntApp.useApp();
  const [selected, setSelected] = useState<BackupSection[]>(['workbench','projects','git','jarrunner','logsight']);
  const [backup, setBackup] = useState<SafeBackup | null>(null);
  const [preview, setPreview] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const wb = useWorkbenchStore();
  const exportBackup = async () => {
    if (!selected.length) { message.warning('至少选择一个配置分区'); return; }
    setBusy(true);
    try {
      const [jars, servers] = await Promise.all([listSafeBackupConfigs(), listSafeBackupServers()]);
      const git = readGitBackup();
      const state = buildSafeBackup({ selected, workbench: {
        theme: wb.theme, fontSize: Number(localStorage.getItem('workbench:font-size') || 16),
        siderCollapsed: localStorage.getItem('workbench:sider-collapsed') === '1', siderWidth: Number(localStorage.getItem('workbench:sider-width') || 240),
        modulePrefs: wb.modulePrefs, moduleOrder: wb.moduleOrder, homeLayout: wb.homeLayout,
      }, projects: readSafeBackupProjects(), gitRecent: git.recentRepos,
      gitPrefs: git.prefs, jars, servers });
      const path = await exportTextFile(`workbench-safe-${new Date().toISOString().slice(0,10)}.json`, JSON.stringify(state, null, 2), { label: '安全配置备份', ext: 'json' });
      if (path) message.success(`安全配置备份已保存：${path}`);
    } catch (e) { message.error(`导出失败：${String(e)}`); } finally { setBusy(false); }
  };
  const importBackup = async () => {
    try {
      const path = await open({ multiple: false, filters: [{ name: '安全配置备份', extensions: ['json'] }] });
      if (typeof path !== 'string') return;
      const text = await call<string>('workbench_read_text_file', { path });
      const parsed = parseSafeBackup(text);
      const lines: string[] = [];
      const [currentJars, currentServers] = await Promise.all([parsed.sections.jarrunner ? listSafeBackupConfigs() : Promise.resolve([]), parsed.sections.logsight ? listSafeBackupServers() : Promise.resolve([])]);
      if (parsed.sections.projects) { const incoming = parsed.sections.projects.items as Array<{id:string}>; const existing = new Set(readSafeBackupProjects().items.map((x) => x.id)); const updates = incoming.filter((x) => existing.has(x.id)).length; lines.push(`项目：新增 ${incoming.length-updates}，同 ID 更新 ${updates}；保留本机额外项目`); }
      if (parsed.sections.git) lines.push(`Git：${(parsed.sections.git.recentRepos as string[]).length} 条最近仓库`);
      if (parsed.sections.jarrunner) { const incoming = parsed.sections.jarrunner.configs as Array<{id:string}>; const ids = new Set(currentJars.map((x) => x.id)); const updates = incoming.filter((x) => ids.has(x.id)).length; lines.push(`JAR：新增 ${incoming.length-updates}，同 ID 更新 ${updates}；参数保留现有值或为空`); }
      if (parsed.sections.logsight) { const incoming = parsed.sections.logsight.servers as Array<{id:string}>; const ids = new Set(currentServers.map((x) => x.id)); const updates = incoming.filter((x) => ids.has(x.id)).length; lines.push(`LogSight：新增 ${incoming.length-updates}，同 ID 更新 ${updates}；凭据不会导入，新服务器需补录`); }
      const paths = collectPaths(parsed.sections);
      const missing = paths.length ? await call<string[]>('workbench_check_config_paths', { paths }) : [];
      lines.push(`路径检查：${missing.length} 个路径在本机不存在${missing.length ? `：${missing.slice(0, 5).join('、')}${missing.length > 5 ? '…' : ''}` : ''}。跨设备路径可稍后修复。`);
      if (parsed.sections.projects) lines.push('项目网址的 query、hash 和 userinfo 已在导出时移除。');
      setBackup(parsed); setPreview(lines);
    } catch (e) { clearBackupImportPreview(setBackup, setPreview); message.error(`导入文件无效：${String(e)}`); }
  };
  const apply = () => {
    if (!backup) return;
    if (!selected.some((key) => backup.sections[key])) { message.warning('至少选择一个包含在备份中的分区'); return; }
    modal.confirm({ title: '应用安全配置备份', content: <div>按 ID 合并所选分区，不删除本机额外记录。JAR 参数和服务器凭据将保留本机值；新增服务器需要重新录入凭据。<ul>{preview.map((x) => <li key={x}>{x}</li>)}</ul></div>, okText: '应用', onOk: async () => {
      setBusy(true);
      const old = new Map(KEYS.map((k) => [k, localStorage.getItem(k)]));
      let nativeCommitted = false;
      try {
        const sections = Object.fromEntries(selected.filter((key) => backup.sections[key]).map((key) => [key, backup.sections[key]])) as SafeBackup['sections'];
        const jars = (sections.jarrunner?.configs || []) as Array<Record<string, unknown>>;
        const servers = (sections.logsight?.servers || []) as Array<Record<string, unknown>>;
        const request = { jars, servers };
        await call('workbench_validate_config_backup', { request });
        const nextProjects = sections.projects ? projectBackupState(sections.projects, readSafeBackupProjects()) : null;
        const writeLocal = () => {
        if (sections.workbench) {
          const s = sections.workbench;
          const write = (k: string, v: unknown) => { if (v !== undefined && v !== null) localStorage.setItem(k, typeof v === 'string' ? v : String(v)); };
          write('workbench:theme', s.theme); write('workbench:font-size', s.fontSize); write('workbench:sider-collapsed', s.siderCollapsed ? '1' : '0'); write('workbench:sider-width', s.siderWidth); write('workbench:module-prefs', JSON.stringify(s.modulePrefs)); write('workbench:module-order', JSON.stringify(s.moduleOrder)); write('workbench:home-layout', s.homeLayout);
        }
        if (nextProjects) localStorage.setItem('workbench:projects', JSON.stringify(nextProjects));
        if (sections.git) { localStorage.setItem('workbench:git-recent-repos', JSON.stringify(sections.git.recentRepos)); localStorage.setItem('workbench:git-prefs', JSON.stringify(sections.git.prefs)); }
        };
        const rollbackLocal = () => {
          old.forEach((v,k) => v === null ? localStorage.removeItem(k) : localStorage.setItem(k,v));
          window.dispatchEvent(new Event('workbench:projects-changed'));
        };
        await applyWithLocalRollback({ writeLocal, rollbackLocal, applyNative: () => call('workbench_apply_config_backup', { request }) });
        nativeCommitted = true;
        if (sections.workbench) {
          const s = sections.workbench;
          if (s.theme === 'dark' || s.theme === 'light') wb.setTheme(s.theme);
          if (typeof s.fontSize === 'number') wb.setFontSize(s.fontSize);
          if (typeof s.siderCollapsed === 'boolean') wb.setSiderCollapsed(s.siderCollapsed);
          if (typeof s.siderWidth === 'number') wb.setSiderWidth(s.siderWidth);
          wb.resetModulePrefs(); if (s.modulePrefs && typeof s.modulePrefs === 'object') Object.entries(s.modulePrefs as Record<string, {hidden?:boolean}>).forEach(([id,p]) => wb.setModulePref(id, p));
          wb.resetModuleOrder(); if (s.moduleOrder && typeof s.moduleOrder === 'object') Object.entries(s.moduleOrder as Record<string,string[]>).forEach(([group,ids]) => wb.setGroupModuleOrder(group as never, ids));
          if (s.homeLayout === 'grid' || s.homeLayout === 'list') wb.setHomeLayout(s.homeLayout);
        }
        if (sections.git) applyGitBackup({ recentRepos: sections.git.recentRepos as string[], prefs: sections.git.prefs as {autoRefresh:boolean;refreshIntervalSec:number} });
        if (nextProjects) applySafeBackupProjects(nextProjects);
        const reloads = await Promise.allSettled([sections.jarrunner ? reloadSavedConfigs() : Promise.resolve(), sections.logsight ? reloadSavedServerList() : Promise.resolve()]);
        const reloadFailed = reloads.some((r) => r.status === 'rejected');
        message[reloadFailed ? 'warning' : 'success'](reloadFailed ? '配置已保存；部分页面列表刷新失败，请重新进入对应模块。' : '所选安全配置已应用；运行会话未更改。'); setBackup(null); setPreview([]);
      } catch (e) {
        if (nativeCommitted) { message.warning(`配置已写入，但界面刷新失败：${String(e)}`); setBackup(null); setPreview([]); setBusy(false); return; }
        message.error(`应用失败：${String(e)}${String(e).includes('local rollback failed:') ? '' : '；本地设置已回滚'}`);
      } finally { setBusy(false); }
    }});
  };
  return <div><Space wrap><Checkbox.Group value={selected} options={Object.entries(LABELS).map(([value,label]) => ({value,label}))} onChange={(v) => setSelected(v as BackupSection[])} /><Button type="primary" loading={busy} onClick={() => void exportBackup()}>导出备份</Button><Button loading={busy} onClick={() => void importBackup()}>导入并预览</Button>{backup && <Button danger loading={busy} onClick={apply}>应用备份</Button>}</Space>
    <div className="mt-3"><Typography.Text type="secondary">不包含：主密钥与校验值、后台运行权威设置、JAR 环境变量与参数、LogSight 密码/私钥密文和自动脚本、运行日志，以及余额、AI Passport 和片段正文。</Typography.Text></div>
    {backup && <><Descriptions className="mt-3" size="small" bordered items={preview.map((text,i) => ({key:String(i),label:'预览',children:text}))} /><Tag color="orange">敏感字段不会从备份覆盖</Tag></>}
  </div>;
}
