/*
 * unified diff 的解析（纯函数，进 logic-test）
 * ------------------------------------------------------------------
 * 输入 `git diff -U3` / `git show --format=` 的输出，切成按文件的 hunk 列表。
 *
 * 关键取舍：
 *   · 路径取自 `--- a/x` / `+++ b/x`（rename 时另读 rename from/to），
 *     **不**从 `diff --git a/x b/x` 里抠 —— 带空格的文件名在那一行无法可靠切分；
 *   · 每个 hunk 保留 `raw` 原文 —— 按块暂存要把 hunk 原样喂给 git apply，
 *     手工重建会漏掉「\ No newline at end of file」这类标记；
 *   · 超长 diff 截断（MAX_LINES）—— 几万行的生成文件进来会把界面拖死。
 * @Author: fu
 */
import type { DiffLine, FileDiff, Hunk } from '../types';

/** 单文件最多解析的差异行数（超过截断并标记 truncated） */
export const MAX_DIFF_LINES = 3000;

/** `--- a/foo` → foo；`--- /dev/null` → null */
function stripSide(line: string, prefixLen: number): string | null {
  let p = line.slice(prefixLen);
  /*
   * ⚠️ 真实 git 输出里 ---/+++ 行可能带「\t + 时间戳」字段（unified diff 的传统格式），
   * 实测 `git diff --no-index` 对带空格的文件名就会补一个尾随 tab ——
   * 不剥掉的话路径会变成 "foo.txt\t"，按路径回查/定位文件全部对不上。
   * 文件名本身不可能含 tab（git 会加引号转义），按第一个 tab 切是安全的。
   */
  const tab = p.indexOf('\t');
  if (tab !== -1) p = p.slice(0, tab);
  /* 带特殊字符的路径 git 会加引号："a/\346\226\207.txt" */
  if (p.startsWith('"') && p.endsWith('"')) {
    try {
      p = JSON.parse(p) as string;
    } catch {
      p = p.slice(1, -1);
    }
  }
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** @@ -1,5 +1,6 @@ 可选上下文 → 行号与范围 */
function parseHunkHeader(line: string): { oldStart: number; oldLines: number; newStart: number; newLines: number } | null {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!m) return null;
  return {
    oldStart: Number(m[1]),
    /* 省略长度时是 1（如 `@@ -3 +3 @@`） */
    oldLines: m[2] === undefined ? 1 : Number(m[2]),
    newStart: Number(m[3]),
    newLines: m[4] === undefined ? 1 : Number(m[4]),
  };
}

/** 解析一段 diff 文本为多个文件的差异 */
export function parseDiff(raw: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | null = null;
  let curHunk: Hunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  let totalLines = 0;
  let truncated = false;

  const pushHunk = () => {
    if (cur && curHunk) {
      cur.hunks.push(curHunk);
      curHunk = null;
    }
  };
  const pushFile = () => {
    pushHunk();
    if (cur) {
      files.push(cur);
      cur = null;
    }
  };

  for (const line of raw.split('\n')) {
    /* 截断后只消费到文件边界，保持已解析部分的结构完整 */
    if (truncated && !line.startsWith('diff --git ')) continue;

    if (line.startsWith('diff --git ')) {
      pushFile();
      cur = {
        oldPath: null,
        newPath: null,
        newFile: false,
        deletedFile: false,
        renamed: false,
        binary: false,
        hunks: [],
        truncated: false,
      };
      totalLines = 0;
      truncated = false;
      continue;
    }
    if (!cur) continue; // diff 前的杂音（如 git show 的 merge 头部）

    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      cur.binary = true;
      continue;
    }
    if (line.startsWith('new file mode')) {
      cur.newFile = true;
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      cur.deletedFile = true;
      continue;
    }
    if (line.startsWith('rename from ')) {
      cur.renamed = true;
      cur.oldPath = line.slice('rename from '.length);
      continue;
    }
    if (line.startsWith('rename to ')) {
      cur.renamed = true;
      cur.newPath = line.slice('rename to '.length);
      continue;
    }
    if (line.startsWith('--- ')) {
      cur.oldPath = stripSide(line, 4);
      continue;
    }
    if (line.startsWith('+++ ')) {
      cur.newPath = stripSide(line, 4);
      continue;
    }

    const hunkHead = line.startsWith('@@ ') ? parseHunkHeader(line) : null;
    if (hunkHead) {
      pushHunk();
      oldNo = hunkHead.oldStart;
      newNo = hunkHead.newStart;
      curHunk = {
        header: line,
        ...hunkHead,
        lines: [],
        raw: line,
      };
      continue;
    }

    if (!curHunk) continue; // index / similarity index 等元行

    /* hunk 内的行 */
    if (totalLines >= MAX_DIFF_LINES) {
      truncated = true;
      cur.truncated = true;
      continue;
    }
    totalLines += 1;

    if (line.startsWith('\\')) {
      /* \ No newline at end of file —— 只进 raw，不占行号 */
      curHunk.raw += `\n${line}`;
      continue;
    }
    const c = line[0];
    const text = line.slice(1);
    let d: DiffLine;
    if (c === '+') {
      d = { kind: 'add', oldNo: null, newNo: newNo++, text };
    } else if (c === '-') {
      d = { kind: 'del', oldNo: oldNo++, newNo: null, text };
    } else {
      /* ' ' 上下文；行首异常（如空行在某些 diff 生成器下没有前缀）按上下文兜底 */
      d = { kind: 'ctx', oldNo: oldNo++, newNo: newNo++, text: line.startsWith(' ') ? text : line };
    }
    curHunk.lines.push(d);
    curHunk.raw += `\n${line}`;
  }
  pushFile();
  return files;
}

/**
 * 拼出「单个 hunk 的迷你 patch」——按块暂存/取消暂存喂给 `git apply --cached -`。
 * 头部用 /dev/null 对待「没有的那一侧」（新增/删除文件），与 git 自己的输出一致。
 */
export function buildHunkPatch(file: FileDiff, hunk: Hunk): string {
  const oldLabel = file.oldPath ? `a/${file.oldPath}` : '/dev/null';
  const newLabel = file.newPath ? `b/${file.newPath}` : '/dev/null';
  return `--- ${oldLabel}\n+++ ${newLabel}\n${hunk.raw}\n`;
}
