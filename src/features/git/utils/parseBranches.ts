/*
 * git for-each-ref 自定义格式的解析（纯函数，进 logic-test）
 * ------------------------------------------------------------------
 * 格式串（Rust runner.rs 的 branch_format）：
 *   %(refname) \x1f %(refname:short) \x1f %(objectname:short) \x1f
 *   %(upstream:short) \x1f %(upstream:track) \x1f %(HEAD) \x1f
 *   %(committerdate:unix) \x1f %(contents:subject) \x1e
 * ⚠️ for-each-ref 的 --format **不认** %x1f 转义（log 才认），
 * Rust 侧嵌的是字面控制字符，这里按 \x1f / \x1e 切即可。
 * for-each-ref 每条记录后补 \n，切完清尾部换行。
 * @Author: fu
 */
import type { BranchInfo } from '../types';

const FS = '\x1f';
const RS = '\x1e';

/**
 * 解析 `%(upstream:track)`。
 *
 * 形状（后端已强制 LC_ALL=C，保证是英文，见 runner.rs::run_read_c）：
 *   ""                   同步（git 同步时不输出任何内容）
 *   "[ahead 3]"          本地领先 3
 *   "[behind 2]"         本地落后 2
 *   "[ahead 3, behind 2]"有分歧
 *   "[gone]"             上游分支已不存在
 *
 * 认不出的形状一律按 0/0 处理 —— 宁可少显示一个徽标，也不能把数字认反
 * （认反了「待推送」会变成「待拉取」，比不显示更糟）。
 */
export function parseTrack(track: string): { ahead: number; behind: number; gone: boolean } {
  const s = track.trim();
  if (!s) return { ahead: 0, behind: 0, gone: false };
  if (/gone/i.test(s)) return { ahead: 0, behind: 0, gone: true };
  const ahead = Number(/ahead\s+(\d+)/i.exec(s)?.[1] ?? 0);
  const behind = Number(/behind\s+(\d+)/i.exec(s)?.[1] ?? 0);
  return { ahead, behind, gone: false };
}

/** 解析一段 for-each-ref 输出（本地 + 远程分支混在一起） */
export function parseBranches(raw: string): BranchInfo[] {
  const out: BranchInfo[] = [];
  for (const rec of raw.split(RS)) {
    const s = rec.replace(/^\n+/, '').replace(/\n+$/, '');
    if (!s) continue;
    const f = s.split(FS);
    /* 8 个字段：ref / name / hash / upstream / track / head / date / subject */
    if (f.length < 8) continue;
    const [ref, name, shortHash, upstream, track, head, date, ...subjectParts] = f;
    const t = parseTrack(track);
    out.push({
      ref,
      name,
      shortHash,
      upstream: upstream.trim() ? upstream.trim() : null,
      /* %(HEAD)：当前分支是 *，其余是空格 */
      current: head.trim() === '*',
      date: Number(date) || 0,
      subject: subjectParts.join(FS),
      remote: ref.startsWith('refs/remotes/'),
      ahead: t.ahead,
      behind: t.behind,
      gone: t.gone,
    });
  }
  return out;
}

/** 本地 / 远程分组（本地分支排前面，各自按最近提交倒序） */
export function splitBranches(list: BranchInfo[]): { local: BranchInfo[]; remote: BranchInfo[] } {
  const local = list.filter((b) => !b.remote).sort((a, b) => b.date - a.date);
  const remote = list.filter((b) => b.remote).sort((a, b) => b.date - a.date);
  return { local, remote };
}
