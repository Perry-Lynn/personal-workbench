/*
 * JAR 运行器 · 参数历史与建议
 * ------------------------------------------------------------------
 * JVM 参数与程序参数是「调一次、记不住、下次还得翻聊天记录」的典型：
 * `-Xmx512m -Dfile.encoding=UTF-8 -Duser.timezone=Asia/Shanghai` 这一串
 * 没有人会每次手打。所以这两格给一个下拉：**这个 jar 用过的**（历史）
 * 排在前面，**常用的**（建议）排在后面。
 *
 * 三个取舍：
 *   1. **按 jar 分别记**，不是全局共用一个池子。同一个 jar 反复调参是常态，
 *      而不同项目的参数几乎不通用（`--server.port` 换一个项目就是另一个值）——
 *      混在一起的下拉里全是别的项目的参数，等于没有。
 *   2. **历史记整串**，不是拆成一个个参数词。调参的实际情况是「换一套」
 *      （dev 一套、prod 一套、压测一套），一键回填一整串才有用；
 *      拆成词条的话每次还得挑三四次，反而更慢。
 *   3. **存在 localStorage**，不进后端配置。它只是「输入框的候选值」，
 *      不需要跨设备、也不需要参与运行；而且存后端要给 JarConfig 加字段，
 *      那条路上踩过 `serde(default)` 的坑（老记录会静默消失）。
 *
 * 只有真正**启动成功**过的参数才会进历史 —— 手打一半的、试错的、报错回滚的
 * 都不该污染候选列表。
 * @Author: fu
 */

/** 参数的两种用途。JVM 参数在 `-jar` 之前，程序参数在 jar 之后 */
export type ArgKind = 'jvm' | 'program';

/** 一条参数历史 */
export interface ArgEntry {
  /** 完整参数串（原样保存，不做拆分与规范化） */
  args: string;
  /** 最近一次使用的时间戳（毫秒） */
  usedAt: number;
  /** 用过几次 */
  count: number;
}

/** 一个 jar 的两类参数历史 */
export interface JarArgHistory {
  jvm: ArgEntry[];
  program: ArgEntry[];
}

/** 全部历史：键是 jar 的绝对路径 */
export type ArgHistory = Record<string, JarArgHistory>;

/** 下拉里的一条候选 */
export interface ArgSuggestion {
  /** 选中后填进输入框的完整参数串 */
  args: string;
  /** 括号里那句人话，说明这套参数是干什么的 */
  note: string;
}

const LS_KEY = 'jarrunner:arg-history';

/** 每个 jar 每类最多留几条（再多下拉就翻不到底了） */
export const MAX_PER_KIND = 8;
/** 最多记几个 jar，按「最近用过」淘汰（防止历史无限长大） */
export const MAX_JARS = 30;

/* ===== JVM 参数建议：整串给，一键得到一套能跑的配置 ===== */
export const JVM_SUGGESTIONS: ArgSuggestion[] = [
  { args: '-Xms256m -Xmx512m -Dfile.encoding=UTF-8', note: '小服务 / 本地调试' },
  { args: '-Xms512m -Xmx1024m -Dfile.encoding=UTF-8 -Duser.timezone=Asia/Shanghai', note: '常规服务' },
  { args: '-Xmx2g -XX:+HeapDumpOnOutOfMemoryError', note: '内存大一些，OOM 时留堆转储' },
  { args: '-XX:MaxMetaspaceSize=256m -XX:+HeapDumpOnOutOfMemoryError', note: '限制元空间，防动态类膨胀' },
  { args: '-Djava.security.egd=file:/dev/./urandom', note: '加快启动时的随机数初始化' },
  { args: '-Dspring.profiles.active=dev', note: '用 dev 配置启动' },
  { args: '-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:5005', note: '开远程调试端口 5005' },
];

/* ===== 程序参数建议（Spring Boot 风格） =====
 * ⚠️ 这里刻意**不提供** `--spring.config.location`：那一格由上面的「配置文件」
 * 专门管，用户在这里手打一份、又在上面选一份的话，两处会互相覆盖且很难发现。
 * 想额外挂一份外部配置请用 `additional-location`（叠加而不是替换）。 */
export const PROGRAM_SUGGESTIONS: ArgSuggestion[] = [
  { args: '--spring.profiles.active=dev', note: '用 dev 配置' },
  { args: '--server.port=8081', note: '换个端口起（避免和已占用的端口撞车）' },
  { args: '--logging.level.root=DEBUG', note: '把根日志级别调到 DEBUG' },
  { args: '--logging.level.com.example=DEBUG', note: '只调自己包的日志级别' },
  { args: '--spring.config.additional-location=file:./config/', note: '额外叠加一份外部配置（保留 jar 内默认值）' },
  { args: '--management.endpoints.web.exposure.include=*', note: '放开 actuator 端点（本地排查用）' },
];

/** 取某个 jar 某一类的建议清单 */
export function suggestionsFor(kind: ArgKind): ArgSuggestion[] {
  return kind === 'jvm' ? JVM_SUGGESTIONS : PROGRAM_SUGGESTIONS;
}

/* ===== 读取与校验 =====
 * 存储里的东西是**用户能改的**（开发者工具里一改就变），所以读进来必须逐层校验：
 * 一个 `count: "三"` 就能让界面上显示成 NaN，而这类坏数据会一直留在存储里。
 * 校验失败时**丢弃那一条**而不是整份历史 —— 部分可用好过全部不可用。 */
function sanitizeEntry(x: unknown): ArgEntry | null {
  if (!x || typeof x !== 'object') return null;
  const e = x as Partial<ArgEntry>;
  if (typeof e.args !== 'string' || !e.args.trim()) return null;
  const count = typeof e.count === 'number' && Number.isFinite(e.count) && e.count > 0 ? e.count : 1;
  const usedAt = typeof e.usedAt === 'number' && Number.isFinite(e.usedAt) ? e.usedAt : 0;
  return { args: e.args, count, usedAt };
}

function sanitizeList(x: unknown): ArgEntry[] {
  if (!Array.isArray(x)) return [];
  const out: ArgEntry[] = [];
  const seen = new Set<string>();
  for (const raw of x) {
    const e = sanitizeEntry(raw);
    /* 同一个 jar 的同一类里，同一串参数只留一条（存储被手改过时可能重复） */
    if (e && !seen.has(e.args)) {
      seen.add(e.args);
      out.push(e);
    }
  }
  return out.slice(0, MAX_PER_KIND);
}

export function sanitizeHistory(raw: unknown): ArgHistory {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: ArgHistory = {};
  for (const [jarPath, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!jarPath.trim() || !v || typeof v !== 'object') continue;
    const item = v as Partial<JarArgHistory>;
    const jvm = sanitizeList(item.jvm);
    const program = sanitizeList(item.program);
    if (jvm.length || program.length) out[jarPath] = { jvm, program };
  }
  return trimJars(out);
}

export function loadArgHistory(): ArgHistory {
  try {
    return sanitizeHistory(JSON.parse(localStorage.getItem(LS_KEY) ?? '{}'));
  } catch {
    /* 存储被写坏（或隐私模式下不可用）时从空开始，不能让整个模块起不来 */
    return {};
  }
}

export function saveArgHistory(h: ArgHistory): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(h));
  } catch {
    /* 配额满 / 不可用：历史记不住不影响本次运行，静默即可 */
  }
}

/** 只保留最近用过的 maxJars 个 jar（对象的键顺序就是「最近在前」） */
export function trimJars(h: ArgHistory, maxJars = MAX_JARS): ArgHistory {
  const keys = Object.keys(h);
  if (keys.length <= maxJars) return h;
  const out: ArgHistory = {};
  for (const k of keys.slice(0, maxJars)) out[k] = h[k];
  return out;
}

/**
 * 记一次「这个 jar 用了这串参数」。返回**新对象**（不改传入的那份）。
 *
 * 命中已有的同一串时只把它挪到最前并 +1，不新增一条 —— 否则反复用同一套参数
 * 会把 8 个位置全占满成同一条。
 */
export function recordArg(
  h: ArgHistory,
  jarPath: string,
  kind: ArgKind,
  args: string,
  now = Date.now(),
): ArgHistory {
  const value = args.trim();
  if (!jarPath.trim() || !value) return h;

  const prev = h[jarPath] ?? { jvm: [], program: [] };
  const list = kind === 'jvm' ? prev.jvm : prev.program;
  const hit = list.find((e) => e.args === value);
  const head: ArgEntry = { args: value, usedAt: now, count: (hit?.count ?? 0) + 1 };
  const rest = list.filter((e) => e.args !== value);
  const next = [head, ...rest].slice(0, MAX_PER_KIND);

  const entry: JarArgHistory = {
    jvm: kind === 'jvm' ? next : prev.jvm,
    program: kind === 'program' ? next : prev.program,
  };

  /* 重建对象把刚用过的 jar 挪到最前：靠对象键的插入顺序表达「最近用过」，
   * 这样淘汰时直接砍尾巴就行，不需要再遍历比较 usedAt。 */
  const rebuilt: ArgHistory = { [jarPath]: entry };
  for (const [k, v] of Object.entries(h)) {
    if (k !== jarPath) rebuilt[k] = v;
  }
  return trimJars(rebuilt);
}

/** 某个 jar 某一类的历史（没有就返回空数组） */
export function listArgs(h: ArgHistory, jarPath: string, kind: ArgKind): ArgEntry[] {
  if (!jarPath.trim()) return [];
  return h[jarPath]?.[kind] ?? [];
}

/** 清掉某个 jar 某一类的历史（用户手滑存进了一串密码之类，得能删掉） */
export function clearArgs(h: ArgHistory, jarPath: string, kind: ArgKind): ArgHistory {
  const prev = h[jarPath];
  if (!prev) return h;
  const entry: JarArgHistory = {
    jvm: kind === 'jvm' ? [] : prev.jvm,
    program: kind === 'program' ? [] : prev.program,
  };
  /* 两类都空了就把这个 jar 整个摘掉，别在存储里留空壳 */
  if (entry.jvm.length === 0 && entry.program.length === 0) {
    const out: ArgHistory = {};
    for (const [k, v] of Object.entries(h)) if (k !== jarPath) out[k] = v;
    return out;
  }
  return { ...h, [jarPath]: entry };
}
