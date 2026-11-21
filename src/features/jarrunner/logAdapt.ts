/*
 * JAR 运行器 · 原始输出 → 日志查看器行 的适配
 * ------------------------------------------------------------------
 * 子进程给的是**原始流**（stdout / stderr 一段一段的纯文本），而日志查看器
 * 要的是**结构化行**（时间 / 级别 / 线程 / logger / 消息 / 是否续行）。
 * 两者不是一回事，所以中间必须有这一层 —— 它的职责是「尽力而为地还原结构」：
 *
 *   1. **Spring Boot 的 logback 控制台输出本身就是结构化的**（默认 pattern
 *      `%d %-5level [%pid] --- [%thread] %logger : %msg`），能解析出
 *      级别 / 线程 / logger / 消息 —— 解析出来之后，查看器的级别列、
 *      logger 缩写、级别筛选才**有内容可筛**；不解析的话所有行都是「未知」，
 *      复用查看器就只剩下一个虚拟滚动列表；
 *   2. **解析不出来的行**（启动 banner、Tomcat 的裸输出、JVM 自己的报错、
 *      工作台写的「已启动」提示）退化成「整行即消息」，级别按关键字猜；
 *   3. **缩进行**（Java 堆栈帧）标成续行，交给查看器折叠成「+N 行堆栈」。
 *
 * ⚠️ 时间戳一律用**采集时间** `ts`，不用日志里解析出来的时间。
 * 两个原因：一是排序稳定 —— 查看器的过滤会按时间倒序重排，
 * 而日志里的时间来自应用自己的时区，用户加一句 `-Duser.timezone=UTC`
 * 就会让解析出的时间整体偏 8 小时、排序彻底乱掉；二是本地进程的采集时间
 * 与打印时间只差几毫秒，看不出区别。
 *
 * 全是纯函数，配 scripts/logic-test.ts 断言 —— 解析规则很容易越改越歪，
 * 而歪掉的表现是「级别列全是 I」，不写断言根本发现不了。
 * @Author: fu
 */
import type { LogLevel, ViewerLogLine } from '@/features/logsight/public';
import type { LogLine, LogStream } from './types';

/*
 * Spring Boot 控制台 pattern 的头部。
 * 兼容三种写法：Boot 3.x 的 `%pid ---`、Boot 2.x 没有 pid 段、
 * 以及 %d 里用逗号当毫秒分隔符（`%d{...,SSS}` 在某些 locale 下输出逗号）。
 */
const BOOT_HEAD =
  /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:[.,](\d{1,3}))?\s+(TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\b\s+(?:\d+\s+)?---\s+\[([^\]]*)\]\s*([\s\S]*)$/;

/*
 * 头部之后的部分：`[traceId] logger : message`。
 * traceId 段是可选的（pattern 里有 %X{traceId} 才有）；logger 段要求不含空格
 * 且形如 Java 类名。整段匹配不上时（pattern 里没有 %logger）就把剩下的
 * 全部当消息 —— 不能因为拆不出来就把内容丢了。
 */
const BOOT_TAIL = /^(?:\[([^\]]*)\]\s+)?([\w.$]+)\s*:\s?([\s\S]*)$/;

/** 日志级别词 → 查看器的级别枚举 */
const LEVEL_OF: Record<string, LogLevel> = {
  TRACE: 'Trace',
  DEBUG: 'Debug',
  INFO: 'Info',
  WARN: 'Warn',
  ERROR: 'Error',
  FATAL: 'Fatal',
};

/** 带包名的异常类名开头，如 java.lang.NullPointerException: null */
const EXCEPTION_HEAD = /^(?:[\w$]+\.)+[\w$]*(?:Exception|Error|Throwable)\b/;

/**
 * 这一行是不是上一条日志的**续行**（异常堆栈）。
 *
 * 判据只认三件在 Java 堆栈里稳定出现的事，不做模糊猜测：
 *   - 以空白开头（`\tat com.foo.Bar.baz(...)` 是堆栈帧的标准形状）；
 *   - `... 12 more`（被截断的共同栈帧）；
 *   - `Caused by:` / `Suppressed:` 开头的因果链。
 *
 * ⚠️ 异常**头**那一行（`java.lang.NullPointerException: null`）不以空白开头，
 * 会被当成独立主行 —— 这是有意的：它本身有信息量，且折叠后
 * 「+N 行堆栈」挂在它下面，比挂在上一行正常的业务日志下更说得通。
 */
export function isStackLine(raw: string): boolean {
  if (/^[ \t]/.test(raw)) return true;
  if (/^\.{3}\s*\d+\s*more\s*$/.test(raw)) return true;
  if (/^(Caused by|Suppressed):\s/.test(raw)) return true;
  return false;
}

/**
 * 猜一行**非 logback 格式**输出的级别。
 *
 * 猜错的代价只是级别列显示得不准，所以宁可保守：只有明确出现级别词
 * 或异常类名时才升级，其余按流归属 —— stderr 默认算错误
 * （这正是「只看错误」原本的语义：用户眼里的错误 ≈ 子进程往 stderr 写的东西）。
 */
export function guessLevel(raw: string, stream: LogStream): LogLevel {
  const u = raw.toUpperCase();
  if (/\bFATAL\b/.test(u)) return 'Fatal';
  if (/\b(ERROR|SEVERE)\b/.test(u)) return 'Error';
  if (EXCEPTION_HEAD.test(raw)) return 'Error';
  if (/\bWARN(ING)?\b/.test(u)) return 'Warn';
  if (/\bDEBUG\b/.test(u)) return 'Debug';
  if (/\bTRACE\b/.test(u)) return 'Trace';
  if (stream === 'stderr') return 'Error';
  return 'Info';
}

/**
 * 工作台自己写进日志流的提示（「已启动 pid=…」「进程退出码 1」）该算哪个级别。
 *
 * 为什么要单独判：这些行是 `system` 流，内容却是「这次运行成没成」的结论。
 * 全部按 Info 处理的话，用户筛「只看错误」时会连「进程异常结束（未拿到退出码）」
 * 一起筛掉 —— 而那句话正是他要找的东西。所以失败类的提示要升成 Error。
 */
export function systemLevel(text: string): LogLevel {
  if (/异常|失败|未拿到退出码/.test(text)) return 'Error';
  /* 「进程退出码 0」不算错；非 0 才算。用负向断言把 0 摘出去 */
  if (/进程退出码\s*(?!0\b)\d+/.test(text)) return 'Error';
  return 'Info';
}

/**
 * 一行原始输出 → 一行查看器行。返回 null 表示这行**不进查看器**（纯空行）。
 *
 * 空行为什么要丢：查看器是按行渲染的，空行会变成一条什么都没有的记录，
 * 看起来像渲染出了 bug；而纯空行在排查问题时也没有信息量。
 */
export function adaptLine(l: LogLine): ViewerLogLine | null {
  const raw = l.text;
  if (!raw.trim()) return null;

  /* 结构化字段的来源标记：1 = stdout，2 = stderr（与后端 LogLine.stream_source 同义） */
  const streamSource = l.stream === 'stderr' ? 2 : 1;

  const head = BOOT_HEAD.exec(raw);
  if (head) {
    const [, , , , levelWord, thread, tail] = head;
    const parsed = BOOT_TAIL.exec(tail);
    return {
      line_no: l.seq,
      raw,
      level: LEVEL_OF[levelWord] ?? 'Info',
      /* 采集时间，不是日志里那个（原因见文件头） */
      timestamp_ms: l.ts,
      server_id: 'jarrunner',
      stream_source: streamSource,
      thread: thread || null,
      trace_id: parsed?.[1] || null,
      logger: parsed?.[2] || null,
      message: parsed ? parsed[3] : tail,
      is_continuation: false,
    };
  }

  return {
    line_no: l.seq,
    raw,
    level: l.stream === 'system' ? systemLevel(raw) : guessLevel(raw, l.stream),
    timestamp_ms: l.ts,
    server_id: 'jarrunner',
    stream_source: streamSource,
    thread: null,
    trace_id: null,
    logger: null,
    message: raw,
    is_continuation: isStackLine(raw),
  };
}

/** 批量适配。顺序保持不变 —— 查看器要靠它把续行归到正确的上一行 */
export function adaptLines(lines: LogLine[]): ViewerLogLine[] {
  const out: ViewerLogLine[] = [];
  for (const l of lines) {
    const v = adaptLine(l);
    if (v) out.push(v);
  }
  return out;
}

/**
 * 默认要显示的级别集合（空数组 = 全显示）。
 * 单独抽出来是为了「只看错误」这个快捷开关与级别多选**共用同一份取值** ——
 * 两处各写一遍 ['Error','Fatal'] 的话，迟早有一处漏掉 Fatal。
 */
export const ERROR_LEVELS: LogLevel[] = ['Fatal', 'Error'];

/**
 * 级别下拉的候选项（按严重程度从高到低，与查看器的级别枚举一致）。
 *
 * 标签一律用**英文**，不用中文（「致命 / 错误 / …」）。理由：级别本来就是日志里
 * 的 token（INFO / WARN / ERROR），中文名跟日志正文对不上，用户还得在脑子里
 * 做一次映射；而且级别列上显示的就是这些字母，两处一致才扫得动。
 * 颜色由调用方按 `log-level-<级别小写>` 上（见 LogPane）。
 *
 * ⚠️ 这几个串与 `logsight/utils/logFormat.ts` 的 `LEVEL_TEXT` 必须一致 ——
 * 那边是级别徽标的 tooltip 文案。这里**不 import 它**是有意的：本文件被
 * logic-test 按路径直接引（要躲开门面里的 css 与 react-window），
 * 一旦引了 logsight 的运行时模块，单测就带不进 node 了。
 * 一致性改由 scripts/logic-test.ts 的断言钉住。
 */
export const LEVEL_OPTIONS: { value: LogLevel; label: string }[] = [
  { value: 'Fatal', label: 'Fatal' },
  { value: 'Error', label: 'Error' },
  { value: 'Warn', label: 'Warn' },
  { value: 'Info', label: 'Info' },
  { value: 'Debug', label: 'Debug' },
  { value: 'Trace', label: 'Trace' },
];
