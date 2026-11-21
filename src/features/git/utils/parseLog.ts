/*
 * git log 自定义格式的解析（纯函数，进 logic-test）
 * ------------------------------------------------------------------
 * 格式串（Rust runner.rs 的 commit_format）：
 *   %H \x1f %P \x1f %an \x1f %ae \x1f %at \x1f %D \x1f %s \x1e
 * 字段间 \x1f、记录间 \x1e —— subject 里什么可打印字符都可能出现，
 * 只有控制字符做分隔才不会撞车。
 * git log 每条记录后还补一个 \n，切完要清掉记录尾部的换行。
 * @Author: fu
 */
import type { Commit } from '../types';

const FS = '\x1f';
const RS = '\x1e';

/** 解析一段 log 输出（多条记录） */
export function parseLog(raw: string): Commit[] {
  const out: Commit[] = [];
  for (const rec of raw.split(RS)) {
    /* 记录之间的换行/空白：git log 在每条记录后补 \n */
    const s = rec.replace(/^\n+/, '').replace(/\n+$/, '');
    if (!s) continue;
    const f = s.split(FS);
    if (f.length < 7) continue; // 格式不对的段直接跳，别让一条脏数据毁掉整个图
    const [hash, parents, author, email, date, refs, ...subjectParts] = f;
    out.push({
      hash,
      shortHash: hash.slice(0, 7),
      parents: parents.trim() ? parents.trim().split(/\s+/) : [],
      author,
      email,
      date: Number(date) || 0,
      refs: refs.trim(),
      subject: subjectParts.join(FS),
    });
  }
  return out;
}
