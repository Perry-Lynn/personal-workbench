export interface ProjectDirectory { id: string; name: string; path: string }
export interface ProjectLink { id: string; name: string; url: string }
export interface Project {
  id: string;
  name: string;
  repoPath: string | null;
  jarConfigIds: string[];
  logServerIds: string[];
  directories: ProjectDirectory[];
  links: ProjectLink[];
}
export interface ProjectsState { version: 1; activeProjectId: string | null; items: Project[] }
