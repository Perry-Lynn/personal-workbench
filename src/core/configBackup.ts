import type { Project, ProjectsState } from '@/features/projects/types';
import type { JarConfig } from '@/features/jarrunner/types';
import type { ServerConfig } from '@/features/logsight/types';
type SafeJar = Pick<JarConfig, 'id'|'name'|'jarPath'|'jdkHome'|'configFile'|'workDir'|'updatedAt'>;
type SafeServer = Pick<ServerConfig, 'id'|'bookmark_category'|'title'|'host'|'port'|'username'|'auth_type'|'private_key_path'|'ssh_config_path'|'use_ssh_agent'|'ssh_agent_path'|'use_mfa'|'created_at'|'updated_at'|'last_connected_at'>;

export const BACKUP_FORMAT = 'workbench-safe-config';
export const BACKUP_VERSION = 1;
export const BACKUP_MAX_BYTES = 5 * 1024 * 1024;
export const BACKUP_SECTIONS = ['workbench', 'projects', 'git', 'jarrunner', 'logsight'] as const;
export type BackupSection = typeof BACKUP_SECTIONS[number];
export interface SafeBackup {
  format: typeof BACKUP_FORMAT;
  version: 1;
  createdAt: string;
  sections: Partial<Record<BackupSection, Record<string, unknown>>>;
}

const exact = (value: unknown, allowed: string[], label: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}必须是对象`);
  const obj = value as Record<string, unknown>;
  const extra = Object.keys(obj).filter((key) => !allowed.includes(key));
  if (extra.length) throw new Error(`${label}包含未知字段：${extra.join(', ')}`);
  return obj;
};
function safeUrl(raw: string): string {
  const u = new URL(raw);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('仅支持不含用户名或密码的 HTTP(S) 网址');
  return u.toString();
}
function cleanExportUrl(raw: string): string {
  const u = new URL(raw);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('项目存在非法网址');
  u.username = ''; u.password = ''; u.search = ''; u.hash = '';
  return u.toString();
}
const keys = (obj: Record<string, unknown>) => Object.fromEntries(Object.entries(obj).filter(([, v]) => typeof v !== 'undefined'));
const uniqueStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === 'string') && new Set(value).size === value.length;

export function buildSafeBackup(input: {
  selected: BackupSection[]; workbench: Record<string, unknown>; projects: ProjectsState;
  gitRecent: string[]; gitPrefs: { autoRefresh: boolean; refreshIntervalSec: number }; jars: SafeJar[]; servers: SafeServer[];
}): SafeBackup {
  const sections: SafeBackup['sections'] = {};
  if (input.selected.includes('workbench')) sections.workbench = input.workbench;
  if (input.selected.includes('projects')) sections.projects = {
    version: 1, activeProjectId: input.projects.activeProjectId,
    items: input.projects.items.map((p) => ({
      id: p.id, name: p.name, repoPath: p.repoPath, jarConfigIds: [...p.jarConfigIds], logServerIds: [...p.logServerIds],
      directories: p.directories.map((d) => ({ id: d.id, name: d.name, path: d.path })),
      links: p.links.map((l) => ({ id: l.id, name: l.name, url: cleanExportUrl(l.url) })),
    })),
  };
  if (input.selected.includes('git')) sections.git = { recentRepos: input.gitRecent, prefs: input.gitPrefs };
  if (input.selected.includes('jarrunner')) sections.jarrunner = { configs: input.jars.map((c) => ({ id: c.id, name: c.name, jarPath: c.jarPath, jdkHome: c.jdkHome, configFile: c.configFile, workDir: c.workDir, updatedAt: c.updatedAt })) };
  if (input.selected.includes('logsight')) sections.logsight = { servers: input.servers.map((s) => keys({
    id: s.id, bookmark_category: s.bookmark_category, title: s.title, host: s.host, port: s.port, username: s.username,
    auth_type: s.auth_type, private_key_path: s.private_key_path, ssh_config_path: s.ssh_config_path,
    use_ssh_agent: s.use_ssh_agent, ssh_agent_path: s.ssh_agent_path, use_mfa: s.use_mfa,
    created_at: s.created_at, updated_at: s.updated_at, last_connected_at: s.last_connected_at,
  })) };
  const backup: SafeBackup = { format: BACKUP_FORMAT, version: BACKUP_VERSION, createdAt: new Date().toISOString(), sections };
  if (new TextEncoder().encode(JSON.stringify(backup)).length > BACKUP_MAX_BYTES) throw new Error('安全配置备份超过 5 MiB');
  return backup;
}

export function parseSafeBackup(text: string): SafeBackup {
  if (new TextEncoder().encode(text).length > BACKUP_MAX_BYTES) throw new Error('备份文件超过 5 MiB');
  const raw: unknown = JSON.parse(text);
  const top = exact(raw, ['format', 'version', 'createdAt', 'sections'], '备份');
  if (top.format !== BACKUP_FORMAT || top.version !== BACKUP_VERSION || typeof top.createdAt !== 'string') throw new Error('未知备份格式或版本');
  const sections = exact(top.sections, [...BACKUP_SECTIONS], 'sections');
  if (!Object.keys(sections).length) throw new Error('备份至少需要一个配置分区');
  for (const [name, payload] of Object.entries(sections)) {
    if (name === 'workbench') {
      const w = exact(payload, ['theme', 'fontSize', 'siderCollapsed', 'siderWidth', 'modulePrefs', 'moduleOrder', 'homeLayout'], name);
      if (!(w.theme === null || w.theme === 'dark' || w.theme === 'light') || typeof w.fontSize !== 'number' || !Number.isFinite(w.fontSize) || w.fontSize < 13 || w.fontSize > 18 || typeof w.siderCollapsed !== 'boolean' || typeof w.siderWidth !== 'number' || !Number.isFinite(w.siderWidth) || w.siderWidth < 160 || w.siderWidth > 640 || !['list','grid'].includes(String(w.homeLayout))) throw new Error('工作台外观字段无效');
      if (!w.modulePrefs || typeof w.modulePrefs !== 'object' || Array.isArray(w.modulePrefs) || !w.moduleOrder || typeof w.moduleOrder !== 'object' || Array.isArray(w.moduleOrder)) throw new Error('工作台模块偏好无效');
      for (const value of Object.values(w.modulePrefs as object)) { const p = exact(value, ['hidden'], 'modulePrefs'); if (p.hidden !== undefined && typeof p.hidden !== 'boolean') throw new Error('模块隐藏状态必须是布尔值'); }
      for (const [group, ids] of Object.entries(w.moduleOrder as Record<string, unknown>)) if (!['总览','运维','效率','内容','设备','系统'].includes(group) || !Array.isArray(ids) || ids.length > 500 || !ids.every((v) => typeof v === 'string')) throw new Error('模块排序字段无效');
    }
    if (name === 'projects') {
      const projects = exact(payload, ['version', 'activeProjectId', 'items'], name);
      if (projects.version !== 1 || !(projects.activeProjectId === null || typeof projects.activeProjectId === 'string') || !Array.isArray(projects.items) || projects.items.length > 500) throw new Error('项目数据数量或版本无效');
      const seen = new Set<string>();
      for (const item of projects.items) {
        const p = exact(item, ['id', 'name', 'repoPath', 'jarConfigIds', 'logServerIds', 'directories', 'links'], '项目');
        if (typeof p.id !== 'string' || !p.id || p.id.length > 128 || /[\u0000-\u001f]/.test(p.id) || seen.has(p.id) || typeof p.name !== 'string' || p.name.trim().length === 0 || p.name.length > 200 || !(p.repoPath === null || typeof p.repoPath === 'string' && p.repoPath.length <= 4096) || !uniqueStrings(p.jarConfigIds) || p.jarConfigIds.length > 500 || !uniqueStrings(p.logServerIds) || p.logServerIds.length > 500 || !Array.isArray(p.directories) || p.directories.length > 500 || !Array.isArray(p.links) || p.links.length > 500) throw new Error('项目字段无效或 ID 重复');
        seen.add(p.id);
        const entryIds = new Set<string>();
        for (const d of p.directories) { const x = exact(d, ['id', 'name', 'path'], '项目目录'); if (![x.id, x.name, x.path].every((v) => typeof v === 'string') || !x.id || entryIds.has(x.id as string) || !(x.name as string).trim() || (x.path as string).length > 4096) throw new Error('项目目录字段无效或 ID 重复'); entryIds.add(x.id as string); }
        for (const l of p.links) { const x = exact(l, ['id', 'name', 'url'], '项目网址'); if (![x.id, x.name, x.url].every((v) => typeof v === 'string') || !x.id || entryIds.has(x.id as string) || !(x.name as string).trim()) throw new Error('项目网址字段无效或 ID 重复'); entryIds.add(x.id as string); safeUrl(x.url as string); }
      }
    }
    if (name === 'git') { const v = exact(payload, ['recentRepos', 'prefs'], name); if (!Array.isArray(v.recentRepos) || !v.recentRepos.every((x) => typeof x === 'string') || v.recentRepos.length > 500) throw new Error('Git 配置无效'); const p = exact(v.prefs, ['autoRefresh', 'refreshIntervalSec'], 'Git prefs'); if (typeof p.autoRefresh !== 'boolean' || typeof p.refreshIntervalSec !== 'number' || !Number.isInteger(p.refreshIntervalSec) || p.refreshIntervalSec < 3 || p.refreshIntervalSec > 3600) throw new Error('Git 自动刷新偏好无效'); }
    if (name === 'jarrunner') {
      const v = exact(payload, ['configs'], name); if (!Array.isArray(v.configs) || v.configs.length > 500) throw new Error('JAR 配置最多 500 条');
      const seen = new Set<string>(); for (const item of v.configs) { const x = exact(item, ['id','name','jarPath','jdkHome','configFile','workDir','updatedAt'], 'JAR 配置'); if (![x.id,x.name,x.jarPath,x.jdkHome,x.configFile,x.workDir].every((y) => typeof y === 'string') || typeof x.id !== 'string' || !x.id || x.id.length > 128 || typeof x.updatedAt !== 'number' || !Number.isFinite(x.updatedAt) || seen.has(x.id)) throw new Error('JAR 配置字段无效或 ID 重复'); seen.add(x.id); }
    }
    if (name === 'logsight') {
      const v = exact(payload, ['servers'], name); if (!Array.isArray(v.servers) || v.servers.length > 500) throw new Error('LogSight 配置最多 500 条');
      const seen = new Set<string>(); for (const item of v.servers) { const x = exact(item, ['id','bookmark_category','title','host','port','username','auth_type','private_key_path','ssh_config_path','use_ssh_agent','ssh_agent_path','use_mfa','created_at','updated_at','last_connected_at'], 'LogSight 配置'); if (typeof x.id !== 'string' || !x.id || seen.has(x.id) || typeof x.bookmark_category !== 'string' || typeof x.title !== 'string' || typeof x.host !== 'string' || typeof x.username !== 'string' || typeof x.port !== 'number' || !Number.isInteger(x.port) || x.port < 1 || x.port > 65535 || !['Password','PrivateKey','ConfigFile'].includes(String(x.auth_type)) || typeof x.use_ssh_agent !== 'boolean' || typeof x.use_mfa !== 'boolean' || typeof x.created_at !== 'string' || Number.isNaN(Date.parse(x.created_at)) || typeof x.updated_at !== 'string' || Number.isNaN(Date.parse(x.updated_at)) || !(x.last_connected_at === null || typeof x.last_connected_at === 'string' && !Number.isNaN(Date.parse(x.last_connected_at))) || ![x.private_key_path,x.ssh_config_path,x.ssh_agent_path].every((t) => t === null || typeof t === 'string')) throw new Error('LogSight 配置字段无效或 ID 重复'); seen.add(x.id); }
    }
  }
  return raw as SafeBackup;
}

export function projectBackupState(section: Record<string, unknown>, current: ProjectsState): ProjectsState {
  const incoming = section.items as Project[];
  const items = new Map(current.items.map((p) => [p.id, p]));
  incoming.forEach((p) => items.set(p.id, p));
  const active = typeof section.activeProjectId === 'string' && items.has(section.activeProjectId) ? section.activeProjectId : current.activeProjectId;
  return { version: 1, activeProjectId: active, items: [...items.values()] };
}

/** A failed file selection/parse must never leave an older backup eligible to apply. */
export function clearBackupImportPreview(
  clearBackup: (backup: null) => void,
  clearPreview: (preview: string[]) => void,
): void {
  clearBackup(null);
  clearPreview([]);
}
