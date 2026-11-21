/*
 * Trae 社区 · 本机偏好（已读 / 关注 / 我的用户名）
 * ------------------------------------------------------------------
 * 匿名态拿不到服务端的已读与关注状态，因此这两项**只在本机**记录：
 *   - readIds   ：点开过的主题。未读 = 没点开过（首次使用会把当时的列表
 *                 一次性记为已读，避免一进来满屏「未读」）
 *   - following ：本机关注的主题（星标）
 *   - myUsername：用户在模块里自行绑定的社区用户名。只用于读取公开资料，
 *                 与登录态无关；通知/私信仍然需要真正的登录。
 *
 * 这些数据允许丢（换机器就没了），不需要加密，也没必要走后端数据库。
 * @Author: fu
 */
const PREFS_KEY = 'workbench:community:prefs:v1';

export interface CommunityLocalPrefs {
  readIds: number[];
  following: number[];
  myUsername: string | null;
  /** 是否已把「第一次看到的列表」记为已读 */
  seeded: boolean;
}

export const EMPTY_PREFS: CommunityLocalPrefs = {
  readIds: [],
  following: [],
  myUsername: null,
  seeded: false,
};

function cleanIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const item of value) {
    const id = Number(item);
    if (Number.isFinite(id) && id > 0 && !out.includes(id)) out.push(id);
  }
  return out.slice(0, 5000);
}

export function readPrefs(): CommunityLocalPrefs {
  try {
    const text = globalThis.localStorage?.getItem(PREFS_KEY);
    if (!text) return { ...EMPTY_PREFS };
    const parsed = JSON.parse(text) as Partial<CommunityLocalPrefs>;
    return {
      readIds: cleanIds(parsed.readIds),
      following: cleanIds(parsed.following),
      myUsername: typeof parsed.myUsername === 'string' && parsed.myUsername.trim()
        ? parsed.myUsername.trim()
        : null,
      seeded: Boolean(parsed.seeded),
    };
  } catch {
    return { ...EMPTY_PREFS };
  }
}

export function writePrefs(prefs: CommunityLocalPrefs): void {
  try {
    globalThis.localStorage?.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* 存储不可用只影响「记住已读/关注」，不应该把主流程打断 */
  }
}

export const COMMUNITY_PREFS_KEY = PREFS_KEY;
