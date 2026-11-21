/*
 * 远端地址 → 托管平台
 * ------------------------------------------------------------------
 * 输入是 `git remote -v` 的原文（后端 git_remotes 带回），输出是
 * 「这个仓库托管在哪」：GitHub / GitLab / Gitee / 自建 / 本地路径 …
 *
 * 为什么要判平台而不是只显示 URL：分支面板里只有 origin / upstream 这种**远端名**，
 * 光看名字根本不知道背后是 GitHub 还是公司自建的 GitLab —— 而「这条分支该去哪儿
 * 提 PR」正是用户看到远端时脑子里第一个问题。
 *
 * 判定只依赖 URL 的主机名，**不联网、不读 .git/config 之外的东西**：
 *   · 已知平台（github.com / gitee.com / gitlab.com …）按域名精确匹配；
 *   · 域名里带 gitlab / github / gitea 的按「自建」处理（gitlab.company.com 这种）；
 *   · 其余归到「自建 / 其它」，主机名照原样展示，不猜。
 *
 * ⚠️ 判错方向的代价不对称：把自建 GitLab 认成 GitHub 会让用户点错链接，
 * 所以**只在有把握时才给品牌名**，拿不准就展示主机名本身。
 * @Author: fu
 */

/** 托管平台。other = 认不出但确实是远端；local = 本地路径（没有托管方） */
export type RemoteProvider =
  | 'github'
  | 'gitlab'
  | 'gitea'
  | 'gitee'
  | 'bitbucket'
  | 'codeup'
  | 'coding'
  | 'gitcode'
  | 'other'
  | 'local';

export interface RemoteInfo {
  /** remote 名（origin / upstream…） */
  name: string;
  /** 原始 URL（照抄 git 的输出，不改写） */
  url: string;
  provider: RemoteProvider;
  /** 展示名：GitHub / GitLab · 自建 / 本地路径 … */
  label: string;
  /** 主机名（小写，去掉 www.）；本地路径为 null */
  host: string | null;
  /** owner/repo（GitLab 子组会多几段）；抠不出来为 null */
  slug: string | null;
  /** 可打开的仓库主页；本地路径或抠不出 slug 时为 null */
  webUrl: string | null;
}

/** 已知平台：域名 → 品牌名 */
const KNOWN_HOSTS: Record<string, { provider: RemoteProvider; label: string }> = {
  'github.com': { provider: 'github', label: 'GitHub' },
  'gitee.com': { provider: 'gitee', label: 'Gitee' },
  'gitlab.com': { provider: 'gitlab', label: 'GitLab' },
  'bitbucket.org': { provider: 'bitbucket', label: 'Bitbucket' },
  'codeup.aliyun.com': { provider: 'codeup', label: '云效 Codeup' },
  'e.coding.net': { provider: 'coding', label: 'Coding' },
  'coding.net': { provider: 'coding', label: 'Coding' },
  'gitcode.com': { provider: 'gitcode', label: 'GitCode' },
};

/**
 * 自建实例的线索：域名里带这些词就按对应产品算。
 * 顺序有讲究 —— gitlab 先于 git（没有单独的 git 条目，但保持「更具体的在前」的习惯）。
 */
const SELF_HOSTED_HINTS: { key: string; provider: RemoteProvider; label: string }[] = [
  { key: 'gitlab', provider: 'gitlab', label: 'GitLab · 自建' },
  { key: 'github', provider: 'github', label: 'GitHub · 企业版' },
  { key: 'gitea', provider: 'gitea', label: 'Gitea · 自建' },
  { key: 'gogs', provider: 'gitea', label: 'Gogs · 自建' },
  { key: 'bitbucket', provider: 'bitbucket', label: 'Bitbucket · 自建' },
  { key: 'coding', provider: 'coding', label: 'Coding · 自建' },
];

/**
 * 把 URL 拆成「主机 + 路径」，本地路径单独标记。
 *
 * 要认的四种写法（都是真实见过的）：
 *   https://github.com/user/repo.git        → 带协议
 *   ssh://git@host:2222/user/repo.git       → 带协议 + 端口
 *   git@github.com:user/repo.git            → scp 风格（最常见）
 *   /Users/me/repo · file:///Users/me/repo  → 本地
 *
 * ⚠️ 顺序不能颠倒：`https://…` 用 scp 的正则会先把 `https` 当主机名。
 */
function splitRemote(url: string): { host: string; path: string } | { local: string } {
  const s = url.trim();
  if (!s) return { local: '' };
  /* 本地：绝对路径 / 相对路径 / ~ / Windows 盘符 / file:// */
  if (
    s.startsWith('/') ||
    s.startsWith('./') ||
    s.startsWith('../') ||
    s.startsWith('~') ||
    /^[A-Za-z]:[\\/]/.test(s) ||
    s.toLowerCase().startsWith('file://')
  ) {
    return { local: s };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      return { host: u.hostname.toLowerCase(), path: u.pathname.replace(/^\/+/, '') };
    } catch {
      /* 解析不了就当本地路径：宁可显示原文，也不要猜错平台 */
      return { local: s };
    }
  }
  /* scp 风格：user@host:path / host:path（主机名里不会有斜杠） */
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(s);
  if (scp) return { host: scp[1].toLowerCase(), path: scp[2] };
  return { local: s };
}

/** 从路径里取 owner/repo（去掉开头的 ~、结尾的 / 与 .git） */
function slugOf(path: string): string | null {
  const p = path
    .replace(/^\/+/, '')
    .replace(/^~\/?/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');
  /* 至少要有 owner/repo 两段，单段（如 ssh 别名写成 host:repo）不算 */
  return p.includes('/') ? p : null;
}

/** 单个 URL → 平台判定 */
export function classifyRemote(url: string): Omit<RemoteInfo, 'name' | 'url'> {
  const split = splitRemote(url);
  if ('local' in split) {
    return { provider: 'local', label: '本地路径', host: null, slug: null, webUrl: null };
  }
  const host = split.host.replace(/^www\./, '');
  const slug = slugOf(split.path);
  const webUrl = slug ? `https://${host}/${slug}` : null;
  const known = KNOWN_HOSTS[host];
  if (known) return { provider: known.provider, label: known.label, host, slug, webUrl };
  const hint = SELF_HOSTED_HINTS.find((h) => host.includes(h.key));
  if (hint) return { provider: hint.provider, label: hint.label, host, slug, webUrl };
  return { provider: 'other', label: '自建 / 其它', host, slug, webUrl };
}

/**
 * 解析 `git remote -v`。
 *
 * 输出形如（**中间是真 tab**）：
 *   origin	git@github.com:user/repo.git (fetch)
 *   origin	git@github.com:user/repo.git (push)
 * 同一个 remote 的 fetch / push 地址可能不同（少见但合法），
 * 展示与判定都取 **fetch** 那条 —— 读代码才是「这个仓库在哪」的语义。
 */
export function parseRemotes(stdout: string): RemoteInfo[] {
  const urls = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const m = /^(\S+)\t(.+?)\s+\((fetch|push)\)\s*$/.exec(line.trimEnd());
    if (!m) continue;
    const [, name, url, kind] = m;
    if (kind === 'fetch' || !urls.has(name)) urls.set(name, url);
  }
  return [...urls].map(([name, url]) => ({ name, url, ...classifyRemote(url) }));
}

/**
 * 这个仓库「主要」的远端：优先当前分支上游所指的那个，其次 origin，最后第一个。
 *
 * 为什么不是直接取第一个：多远端仓库（fork 场景）里 origin 常常是别人的仓库，
 * 上游才是「我们真正在跟的那个」，工具栏上挂错平台名比不挂更误导。
 */
export function pickPrimaryRemote(remotes: RemoteInfo[], upstream: string | null): RemoteInfo | null {
  if (remotes.length === 0) return null;
  const name = upstream?.split('/')[0];
  return (
    (name ? remotes.find((r) => r.name === name) : undefined) ??
    remotes.find((r) => r.name === 'origin') ??
    remotes[0]
  );
}
