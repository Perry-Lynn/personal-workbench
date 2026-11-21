/*
 * Maven 助手模块 · 类型
 * 字段与 src-tauri/src/modules/maven/models.rs 一一对应（serde camelCase）。
 */

/** mvn 是从哪儿找到的 */
export type MavenSource = 'sdkman' | 'brew' | 'system' | 'wrapper';

export interface MavenInfo {
  found: boolean;
  path: string;
  version: string;
  source: MavenSource | null;
  repoPath: string;
  repoExists: boolean;
}

export interface SizeEntry {
  /** groupId，或 "groupId:artifactId" —— 取决于聚合维度 */
  key: string;
  bytes: number;
  count: number;
}

export interface DuplicateEntry {
  group: string;
  artifact: string;
  versions: string[];
  bytes: number;
  /** 单个版本里最大的那个占多少 —— 算「能释放多少」用 */
  largestBytes: number;
  snapshotCount: number;
}

export interface RepoStats {
  repoPath: string;
  totalBytes: number;
  artifactCount: number;
  versionCount: number;
  snapshotCount: number;
  topGroups: SizeEntry[];
  topArtifacts: SizeEntry[];
  duplicates: DuplicateEntry[];
  scannedAt: number;
  elapsedMs: number;
}

/** 这一条依赖为什么被 Maven 丢掉了 */
export type OmitReason = 'conflict' | 'duplicate' | 'managed' | 'excluded' | 'other';

export interface DepLine {
  depth: number;
  group: string;
  artifact: string;
  version: string;
  packaging: string;
  scope: string;
  omitReason: OmitReason | null;
  /** 冲突时赢家是哪个版本（来自 "omitted for conflict with X"） */
  conflictWith: string | null;
}

export interface Conflict {
  group: string;
  artifact: string;
  winner: string;
  losers: string[];
}

export interface TreeResult {
  root: string;
  lines: DepLine[];
  conflicts: Conflict[];
  raw: string;
  elapsedMs: number;
  warnings: string[];
}
