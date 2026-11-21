import { call } from '@/core/ipc';
import type { ProjectsState, Project } from './types';

const KEY = 'workbench:projects';
const EMPTY: ProjectsState = { version: 1, activeProjectId: null, items: [] };

export function readProjects(): ProjectsState {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || 'null') as ProjectsState | null;
    if (value?.version === 1 && Array.isArray(value.items)) return value;
  } catch { /* damaged local data is treated as empty */ }
  return { ...EMPTY, items: [] };
}

export function writeProjects(value: ProjectsState): void {
  localStorage.setItem(KEY, JSON.stringify(value));
  window.dispatchEvent(new Event('workbench:projects-changed'));
}

export function makeProject(name: string): Project {
  return { id: crypto.randomUUID(), name, repoPath: null, jarConfigIds: [], logServerIds: [], directories: [], links: [] };
}

export function openDirectory(path: string): Promise<void> {
  return call<void>('workbench_open_directory', { path });
}

export function openExternalUrl(raw: string): Promise<void> {
  let url: URL;
  try { url = new URL(raw); } catch { return Promise.reject(new Error('网址无效')); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    return Promise.reject(new Error('仅允许不含用户名或密码的 HTTP(S) 网址'));
  }
  return call<void>('workbench_open_url', { url: url.toString() });
}

export const PROJECTS_STORAGE_KEY = KEY;
