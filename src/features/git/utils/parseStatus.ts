/*
 * git status --porcelain=v2 --branch -z 的解析（纯函数，进 logic-test）
 * ------------------------------------------------------------------
 * 为什么要自己解析：porcelain v2 是**机器可读**的稳定格式（v1 的 XY 位置编码
 * 在 rename/文件名带空格时有歧义），-z 用 \0 分段又彻底绕开了文件名里的换行。
 *
 * 格式备忘（-z 变体，段与段之间是 \0）：
 *   # branch.oid <hash>        仓库 oid（空仓库是 "(initial)"）
 *   # branch.head <name>       当前分支（detached 时是 "(detached)"）
 *   # branch.upstream <name>   上游（没设过就没有这行）
 *   # branch.ab +<ahead> -<behind>
 *   1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
 *   2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path> \0 <origPath>
 *   u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
 *   ? <path>                   未跟踪
 *   ! <path>                   已忽略（不关心）
 * ⚠️ rename 条目（2）的原路径是**独立的下一段**，不是空格分隔 —— 这是 -z 与
 *    普通输出最大的不同，按空格切会把 origPath 丢掉。
 * ⚠️ path 可能含空格，所以固定字段必须「按个数切」，剩下的整段才是路径。
 * @Author: fu
 */
import type { ChangeGroup, ChangeKind, StatusResult } from '../types';

/** 状态字符 → 变更类型 */
export function kindFromChar(c: string): ChangeKind {
  switch (c) {
    case 'M':
      return 'modified';
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'T':
      return 'typeChanged';
    case 'U':
      return 'conflicted';
    default:
      /* '.'（未变）与未知字符：按修改兜底，界面上仍能看能操作 */
      return 'modified';
  }
}

/**
 * 按「空格个数」切成 n 段：前 n-1 段是固定字段，第 n 段吞掉剩余全部
 * （路径里有空格也不怕）。
 */
function splitFixed(s: string, n: number): string[] {
  const out: string[] = [];
  let rest = s;
  for (let i = 0; i < n - 1; i++) {
    const idx = rest.indexOf(' ');
    if (idx === -1) {
      out.push(rest);
      rest = '';
    } else {
      out.push(rest.slice(0, idx));
      rest = rest.slice(idx + 1);
    }
  }
  out.push(rest);
  return out;
}

/** 分支头信息行（# branch.xxx） */
function applyHeader(res: StatusResult, line: string): void {
  const body = line.slice(2); // 去掉 "# "
  const sp = body.indexOf(' ');
  const key = sp === -1 ? body : body.slice(0, sp);
  const val = sp === -1 ? '' : body.slice(sp + 1);
  switch (key) {
    case 'branch.head':
      if (val === '(detached)') {
        res.detached = true;
        res.branch = null;
      } else {
        res.detached = false;
        res.branch = val;
      }
      break;
    case 'branch.upstream':
      res.upstream = val;
      break;
    case 'branch.ab': {
      /* 形如 "+2 -3"：+ = 领先，- = 落后 */
      const m = /\+(\d+)\s+-(\d+)/.exec(val);
      if (m) {
        res.ahead = Number(m[1]);
        res.behind = Number(m[2]);
      }
      break;
    }
    default:
      /* branch.oid 等：暂不需要 */
      break;
  }
}

/** 解析一段 porcelain v2 -z 输出 */
export function parseStatus(raw: string): StatusResult {
  const res: StatusResult = {
    branch: null,
    detached: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
  };

  const segs = raw.split('\0');
  let i = 0;
  while (i < segs.length) {
    const seg = segs[i];
    i += 1;
    if (!seg) continue;

    if (seg.startsWith('# ')) {
      /* 头信息行在 -z 下也以 \0 结尾，但有的 git 版本会把多行拼一段 —— 按行再切 */
      for (const line of seg.split('\n')) {
        if (line.startsWith('# ')) applyHeader(res, line);
      }
      continue;
    }

    const tag = seg[0];
    if (tag === '?') {
      res.untracked.push({ path: seg.slice(2), kind: 'untracked' });
      continue;
    }
    if (tag === '!') {
      continue; // 已忽略
    }
    if (tag === 'u') {
      /* 冲突：u XY sub m1 m2 m3 mW h1 h2 h3 path（10 个固定字段 + 路径） */
      const f = splitFixed(seg.slice(2), 10);
      const path = f[9];
      if (path) res.conflicted.push({ path, kind: 'conflicted' });
      continue;
    }
    if (tag === '1' || tag === '2') {
      /*
       * 1: XY sub mH mI mW hH hI path            → 8 个固定字段 + 路径
       * 2: XY sub mH mI mW hH hI Xscore path     → 9 个固定字段 + 路径，下一段是 origPath
       */
      const fixed = tag === '1' ? 8 : 9;
      const f = splitFixed(seg.slice(2), fixed);
      const xy = f[0];
      const path = f[fixed - 1];
      let oldPath: string | undefined;
      if (tag === '2') {
        const orig = segs[i];
        if (orig !== undefined && orig !== '') {
          oldPath = orig;
          i += 1;
        }
      }
      if (!path) continue;

      const x = xy[0] ?? '.';
      const y = xy[1] ?? '.';
      if (x !== '.') {
        res.staged.push({ path, oldPath, kind: kindFromChar(x) });
      }
      if (y !== '.') {
        res.unstaged.push({ path, oldPath, kind: kindFromChar(y) });
      }
    }
    /* 其它未知段：跳过（向前兼容新格式） */
  }
  return res;
}

/** 某个分组的文件数（badge / 提交按钮可用性判断） */
export function groupCount(res: StatusResult | null, group: ChangeGroup): number {
  if (!res) return 0;
  return res[group].length;
}

/** 变更文件总数（去重：同时暂存+未暂存的文件算一个） */
export function totalChanged(res: StatusResult | null): number {
  if (!res) return 0;
  const set = new Set<string>();
  for (const g of ['staged', 'unstaged', 'untracked', 'conflicted'] as const) {
    for (const f of res[g]) set.add(f.path);
  }
  return set.size;
}
