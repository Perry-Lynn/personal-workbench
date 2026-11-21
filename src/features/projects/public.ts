import { useWorkbenchStore } from '@/store/useWorkbenchStore';
import { readProjects, writeProjects } from './store';

export function activateProject(id: string): void {
  const state = readProjects();
  if (!state.items.some((item) => item.id === id)) throw new Error('项目已不存在');
  writeProjects({ ...state, activeProjectId: id });
}

export function openProjects(): void {
  useWorkbenchStore.getState().setActiveModule('projects');
}

export function readSafeBackupProjects() { return readProjects(); }
export function applySafeBackupProjects(state: ReturnType<typeof readProjects>): void { writeProjects(state); }
