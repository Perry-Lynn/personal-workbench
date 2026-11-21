/*
 * 智能体余额 · 纯逻辑自测
 * ------------------------------------------------------------------
 * 跑法：`npm run test:logic`
 *
 * 为什么需要它：额度提醒的去重 / 重新武装、健康度的方向归一、颜色的端点，
 * 这些逻辑全都在浏览器里才能体现出来，而「跌破阈值」这种状态要真的把额度耗到
 * 那个程度才能复现 —— 靠手动点界面验证成本太高，还容易漏边界。
 * 这里用 esbuild 把纯逻辑（alerts.ts / format.ts）单独打成一个 .mjs 在 node 里跑，
 * 不引入测试框架、不依赖浏览器。
 *
 * 约定：**两个桩都必须写在所有业务 import 之前**（靠 import 顺序求值生效）：
 *   - `./localstorage-stub` —— `alerts.ts` 在模块顶层就会读 localStorage
 *   - `./tauri-stub`        —— 给 `@/core/ipc` 的 invoke 造出 `window.__TAURI_INTERNALS__`
 * 另：`test:logic` 的 esbuild 带 `--alias:@=./src`，所以这里可以直接写 `@/` 路径。
 * @Author: fu
 */
import './localstorage-stub';
import { callCount, resetCommands, setCommand } from './tauri-stub';

import {
  ALERT_THRESHOLDS,
  alertBody,
  alertSnapshot,
  alertStatus,
  evaluateAlerts,
  resetAlerts,
  unmarkAlert,
} from '../src/features/balances/alerts';
import {
  buildBadgeSummary,
  buildBadgeSummaryResult,
  byteLen,
  clockAt,
  formatCountdown,
  healthBadgeText,
  healthBadgeTone,
  BADGE_TONE_WARN_AT,
  BADGE_TONE_DANGER_AT,
  healthColor,
  healthPercentOf,
  exhaustedNote,
  isUsageLabel,
  itemHealth,
  looksLikeDate,
  metricValueKind,
  percentOf,
  shortLabel,
  SUMMARY_SEP,
  truncateBytes,
  worstHealth,
  decideHistory,
  pickTrendMetric,
  bucketHistory,
  pruneHistory,
  TREND_MAX,
  sparkY,
} from '../src/features/balances/format';
// pickPrimaryMetric / pickHomeMetric 定义在 snapshot.ts（不在 format.ts），单独导入
import { pickHomeMetric, pickPrimaryMetric } from '../src/features/balances/snapshot';
/*
 * JAR 运行器：新模块一律用**命名空间导入** —— 纯逻辑断言全堆在一个文件里跑，
 * 同名导出会被后来者静默覆盖（已踩四次：alertBody / percentOf / formatElapsed /
 * worstHealth）。带前缀从结构上消灭重名，不靠「加之前先 grep」这种自觉。
 */
import * as jarFmt from '../src/features/jarrunner/format';
/*
 * 输出行适配与参数历史。这两个都能在 node 里跑：
 *   - logAdapt.ts 只用 `import type` 引 logsight 的门面，esbuild 会把类型导入整段擦除，
 *     所以不会顺着门面去拉 react-window / css（那些在 node 里跑不动）；
 *   - argHistory.ts 顶层不读 localStorage（读盘在 loadArgHistory 里，由 store 调）。
 */
import * as jarAdapt from '../src/features/jarrunner/logAdapt';
import * as jarArgs from '../src/features/jarrunner/argHistory';
/*
 * 日志查看器的过滤纯逻辑（复用链的下游）。这里走**相对路径直接引纯逻辑文件**，
 * 而不是走 logsight/public.ts 门面：门面会连带 css 与 react-window，
 * 在 node 里跑不动。生产代码那边一律走门面（见 LogPane.tsx）。
 */
import { applyLogFilter, DEFAULT_SEARCH_FILTER } from '../src/features/logsight/utils/logFilter';
/*
 * 级别名（徽标 tooltip 用的那份）。它只 `import type`，同样能进 node。
 * 引它是为了钉住「级别一律英文」这条约定 —— 中文名一旦回来，
 * 界面上的下拉与 tooltip 就会与日志正文里的 INFO/WARN 对不上，
 * 而这件事不报任何错（见下面那组断言）。
 */
import { LEVEL_TEXT } from '../src/features/logsight/utils/logFormat';
/*
 * store 也拉进来测。它依赖 `@/core/ipc`，过去正是「跑不进 node」所以一条断言都没有 ——
 * 有了 `./tauri-stub` 与 esbuild 的 `--alias:@=./src` 才可行（见文件头那两条约定）。
 */
import { useJarRunnerStore } from '../src/features/jarrunner/store';
import * as jarPublic from '../src/features/jarrunner/public';
import { useGitStore } from '../src/features/git/store/useGitStore';
import * as safeBackup from '../src/core/configBackup';
import { applyWithLocalRollback } from '../src/core/configBackupApply';
import {
  buildDeviceLines,
  deviceLinesKey,
  sanitizeField,
  DEVICE_LINE_MAX,
  DEVICE_LABEL_MAX,
  DEVICE_REFRESHED_MAX,
  DEVICE_VALUE_MAX,
} from '../src/features/balances/device';
/*
 * 间隔收敛来自 prefs.ts。在这里 import 它是安全的：snapshot.ts 本来就引了
 * zustand 与 prefs（见上方的 pickPrimaryMetric），localStorage 桩也已铺好。
 */
import {
  AUTO_REFRESH_OPTIONS,
  DEFAULT_REFRESH_MIN,
  MAX_REFRESH_MIN,
  MIN_REFRESH_MIN,
  resolveRefreshMin,
  validInterval,
  validProviderRefreshMin,
  validPushProviders,
  validTrayFields,
  validTrayIconOff,
  validTrayIconScale,
  validTrayLabels,
} from '../src/features/balances/prefs';
/*
 * 菜单栏文本（features/balances/tray.ts）。
 * **必须命名空间导入**：这个文件里所有模块的断言都堆在一起，具名导入时
 * 同名导出会静默互相覆盖（已踩四次，见 MEMORY）。tray.ts 里有
 * compactValue / quotaItem 这类「很容易在别处也叫这名」的短名字。
 */
import * as balTray from '../src/features/balances/tray';
/*
 * 图标位图缩放（features/balances/bitmap.ts）。**命名空间导入**，理由同上。
 * 这个模块是**纯数值**的（不碰 canvas），所以能在这里跑 —— icons.ts 不能，
 * 它一 import 就要 document。缩放算法是「改了看不出对不对」的那一类
 * （画面上只是小一圈），必须靠断言钉住几何关系。
 */
import * as balBitmap from '../src/features/balances/bitmap';
/*
 * 全局基准字号解析（core/theme.ts）。**命名空间导入**，理由同上：
 * `clampFontSize` / `parseStoredFontSize` 都是很容易撞名的短名字。
 * 引 core 用相对路径（本文件不认 `@/` 别名，见坑 21）。
 */
import * as themeCore from '../src/core/theme';
/*
 * Git 管理模块：解析器与提交图布局全是纯函数，样例一律取**真实 git 输出**
 * （macOS git 2.50 的 porcelain v2 -z / unified diff / 自定义 log 格式）——
 * 手编的样例很容易和真实输出差一个空格，解析器却照样「测过」。
 * 命名空间导入防重名（见上）。
 */
import * as gitStatus from '../src/features/git/utils/parseStatus';
import * as gitDiff from '../src/features/git/utils/parseDiff';
import * as gitSide from '../src/features/git/utils/sideBySide';
import * as gitLog from '../src/features/git/utils/parseLog';
import * as gitBranches from '../src/features/git/utils/parseBranches';
import * as gitPullTarget from '../src/features/git/utils/pullTarget';
import * as gitPeek from '../src/features/git/utils/remotePeek';
import * as gitRemotes from '../src/features/git/utils/remotes';
import type { BranchInfo } from '../src/features/git/types';
import * as gitGraph from '../src/features/git/utils/graphLayout';
import * as gitTree from '../src/features/git/utils/buildFileTree';
import * as gitPrefs from '../src/features/git/prefs';
/*
 * Trae 社区：归一化 / 分组排序 / 正文清洗 / 本地缓存全是纯逻辑，
 * 组件里不写兜底，所以这些断言就是「字段缺失不 panic」的唯一防线。
 * 命名空间导入防重名（见上）；localStorage 桩已在文件头铺好。
 */
import * as cmFmt from '../src/features/community/format';
import * as cmSanitize from '../src/features/community/sanitize';
import * as cmCache from '../src/features/community/cache';
import * as cmPrefs from '../src/features/community/prefs';
import type { TopicSummary } from '../src/features/community/types';

let pass = 0;
let fail = 0;

function eq(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
  } else {
    fail++;
    console.log(`FAIL ${label}\n  期望 ${e}\n  实际 ${a}`);
  }
}

function ok(label: string, cond: boolean): void {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log(`FAIL ${label}`);
  }
}

/* =============================================
   ====== 百分比解析与方向归一 ======
   ============================================= */
eq('percentOf 29%', percentOf('29%'), 29);
eq('percentOf 带空格', percentOf(' 12 % '), 12);
eq('percentOf 小数', percentOf('7.5%'), 7.5);
eq('percentOf 非百分比', percentOf('$12.50'), null);
eq('percentOf 越界收敛到 100', percentOf('120%'), 100);
eq('percentOf 负值收敛到 0', percentOf('-5%'), 0);

eq('「已用」算 usage', isUsageLabel('本周已用'), true);
eq('「剩余」不算 usage', isUsageLabel('剩余额度'), false);
eq('认不出时按 usage 处理', isUsageLabel('本周'), true);

eq('健康度：已用 29% → 71', healthPercentOf('本周已用', '29%'), 71);
eq('健康度：剩余 5% → 5', healthPercentOf('剩余额度', '5%'), 5);
eq('健康度：非百分比 → null', healthPercentOf('余额', '$3.20'), null);

/*
 * 数值配色分流（2026-09-24 新增）。
 *
 * 用户原话：「qoder 的使用量和余额也要用不同的颜色标识」。
 * 规则是**按「是不是百分比」分**，不是按「已用 / 剩余」分 —— 因为
 * 「剩余 12.5%」必须继续走健康度色（快用完时是红的），按字面分会把告警抹掉。
 * 于是三档：百分比 → 健康度色；非百分比的数量 → 中性信息色；日期等 → 不上色。
 *
 * ⚠️ 日期那一档是最容易写错的：`parseNumeric('2026-10-01')` 返回 **2026**，
 * 只看「能不能解析出数字」的话「额度到期」会被当成余额染成蓝色。
 */
/*
 * metricValueKind 现在吃**整条 BalanceItem**（不是裸字符串），因为染色还要看
 * `usedPercent` —— 那条让「降级成绝对值、但上限已知」的指标也能走健康度色。
 * 下面每条都用结构字面量 `{ label, value, usedPercent? }` 表达。
 */
eq('分流：百分比 → health', metricValueKind({ label: '', value: '87%' }), 'health');
eq('分流：剩余百分比也是 health（方向归一留给 healthPercentOf）',
  metricValueKind({ label: '', value: '12.5%' }), 'health');
eq('分流：credits 余额 → amount', metricValueKind({ label: '', value: '26099 credits' }), 'amount');
eq('分流：带币种的金额 → amount', metricValueKind({ label: '', value: '$12.50' }), 'amount');
eq('分流：带千分位 → amount', metricValueKind({ label: '', value: '1,234.5' }), 'amount');
eq('分流：区间值 → amount', metricValueKind({ label: '', value: '246~1280' }), 'amount');
/* 这一条是上面的坑：日期不是量，不能染色 */
eq('分流：日期 → plain（parseNumeric 会返回 2026，不能当余额）',
  metricValueKind({ label: '', value: '2026-10-01' }), 'plain');
eq('分流：中文日期 → plain', metricValueKind({ label: '', value: '2026年10月1日' }), 'plain');
eq('分流：纯文字 → plain', metricValueKind({ label: '', value: '不限量' }), 'plain');
eq('分流：空串 → plain', metricValueKind({ label: '', value: '' }), 'plain');
/* Qoder 卡片的三行正是这三档，各来一条 */
eq('Qoder 组织池剩余（余额）→ amount', metricValueKind({ label: '', value: '26099 credits' }), 'amount');
eq('Qoder 资源包已用（使用量）→ health', metricValueKind({ label: '', value: '87%' }), 'health');
eq('Qoder 额度到期（日期）→ plain', metricValueKind({ label: '', value: '2026-10-01' }), 'plain');

/*
 * ⭐ usedPercent 这条才是用户要的红线：团队账号里「个人额度用尽、组织池还有余额」是常态，
 * 那时个人额度只显示「3000 credits」（非百分比 → 本来算 amount 中性蓝），看不出「用完」。
 * 带上 usedPercent=100 后，itemHealth 归一到 0（= 红），metricValueKind 转成 health，
 * 前端把它染成红 —— 「用完」这件事终于在界面上有信号。
 */
eq('Qoder 个人额度用尽（绝对值 + usedPercent=100）→ health（红）',
  metricValueKind({ label: '个人额度已用', value: '3000 credits', usedPercent: 100 }), 'health');
eq('Qoder 个人额度用尽 → itemHealth 归一到 0（红端）',
  itemHealth({ label: '个人额度已用', value: '3000 credits', usedPercent: 100 }), 0);
eq('Qoder 个人额度用了一半（usedPercent=50）→ health 归一到 50',
  itemHealth({ label: '个人额度已用', value: '1500 credits', usedPercent: 50 }), 50);
eq('Qoder 个人额度刚用一点（usedPercent=10）→ itemHealth 90（绿端）',
  itemHealth({ label: '个人额度已用', value: '300 credits', usedPercent: 10 }), 90);
eq('无 usedPercent 的余额类 → itemHealth 回退到 value 百分比判据',
  itemHealth({ label: '资源包已用', value: '87%' }), 13);
/* 负值 / 超界会被夹到端点，不会出 NaN */
eq('usedPercent 越界（150）被夹到 100 → itemHealth 0',
  itemHealth({ label: '个人额度已用', value: 'x', usedPercent: 150 }), 0);
eq('usedPercent 负值（-5）被夹到 0 → itemHealth 100',
  itemHealth({ label: '个人额度已用', value: 'x', usedPercent: -5 }), 100);
eq('usedPercent 为 NaN → 当作没有，回落 value 判据',
  metricValueKind({ label: '个人额度已用', value: '26099 credits', usedPercent: NaN }), 'amount');

/* 日期识别的边界：不能把「四位数」一律当日期，也不能漏掉中文写法 */
eq('日期识别：2026-10-01', looksLikeDate('2026-10-01'), true);
eq('日期识别：2026/10/01', looksLikeDate('2026/10/01'), true);
eq('日期识别：2026年10月1日', looksLikeDate('2026年10月1日'), true);
eq('日期识别：2026-10（只有年月）', looksLikeDate('2026-10'), true);
eq('日期识别：26099 credits 不是日期', looksLikeDate('26099 credits'), false);
/* 没有分隔符的四位数是**数量**（1200 次），不是年份 —— 判据必须有分隔符 */
eq('日期识别：纯四位数 2026 不算日期', looksLikeDate('2026'), false);
eq('日期识别：984.31 不是日期', looksLikeDate('984.31'), false);
eq('日期识别：区间 246~1280 不是日期', looksLikeDate('246~1280'), false);

/*
 * Qoder CN 的标签契约（跨语言，必须钉死）。
 * 后端 `qoder.rs` 产出「额度已用 / 资源包已用」—— 这两个词**同时命中**
 * 「已用」和「额度」两组模式，`isUsageLabel` 是靠**先查「已用」**才判成 usage 语义的。
 * 一旦有人调换那两行的顺序，Qoder 的健康度会从 75 翻成 25（颜色与阈值提醒整体反向），
 * 而这种错在界面上看不出来（只是颜色不对）。所以在这里把结论钉住，而不是钉实现顺序。
 */
eq('Qoder「额度已用」算 usage（含「额度」也不能翻）', isUsageLabel('额度已用'), true);
eq('Qoder「资源包已用」算 usage', isUsageLabel('资源包已用'), true);
eq('Qoder 健康度：已用 25% → 75', healthPercentOf('额度已用', '25%'), 75);
eq('Qoder 健康度：已用 2% → 98', healthPercentOf('资源包已用', '2%'), 98);
/* 组织资源包只有绝对用量、没有 %，不能混进健康度参与告警 */
eq('Qoder 组织资源包（无 %）不参与健康度', healthPercentOf('组织资源包', '1234'), null);

/*
 * Qoder 走 CLI 那条路（qoder_cli.rs）的标签契约。
 *
 * 团队账号的真实形态是「个人额度用尽 + 组织资源包不限量（cap = -1）」，
 * 后端据此**故意不出任何百分比**：出了就会让侧栏角标永远报 0%，
 * 而 CLI 自己的判断是「额度未耗尽」（isQuotaExceeded = false）。
 * 所以这里要钉住「绝对值标签不参与健康度」这一条。
 *
 * ⚠️ cap = -1 时后端出的是**两条**：`组织池剩余`（组织级 remaining）与
 * `资源包已用`（本人当月取用）。2026-09-22 对照网页控制台原始响应确认：
 *   organization_pool.limit_value − used_value = 46000 − 19901 = 26099
 *   与 shared_quota.quota_summary.remaining_value 精确相等
 * → remaining 是**组织级**、used 是**本人级**，口径不同，合在一行会被读成
 *   「我的额度剩 26071、我只用了 4042」。所以两条的方向也必须分别钉住。
 */
eq('Qoder CLI「组织池剩余」是绝对值，不参与健康度', healthPercentOf('组织池剩余', '26071 credits'), null);
eq('Qoder CLI「资源包已用」是绝对值，不参与健康度', healthPercentOf('资源包已用', '4042 credits'), null);
eq('Qoder CLI「可用总额」是绝对值，不参与健康度', healthPercentOf('可用总额', '26071 credits'), null);
eq('Qoder CLI「额度到期」是日期，不参与健康度', healthPercentOf('额度到期', '2026-09-30'), null);
/* 有上限时才会出百分比，那时方向必须是「已用」 */
eq('Qoder CLI 资源包有上限时算 usage', isUsageLabel('资源包已用'), true);
eq('Qoder CLI 资源包有上限时健康度：已用 50% → 50', healthPercentOf('资源包已用', '50%'), 50);
/* 「剩余」方向相反，写反了颜色会整体翻过来 */
eq('Qoder CLI「组织池剩余」方向是 remaining', isUsageLabel('组织池剩余'), false);

/*
 * 短标签必须与后端标签逐字对上 —— 对不上不报错，只是徽章 95 字节预算被长标签吃掉，
 * 表现为「徽章上少显示了几个平台」。断言在这里替人记住。
 */
eq('短标签：组织池剩余', shortLabel('组织池剩余'), '组织池');
eq('短标签：资源包已用', shortLabel('资源包已用'), '资源包');
eq('短标签：个人额度已用', shortLabel('个人额度已用'), '个人额度');
eq('短标签：可用总额', shortLabel('可用总额'), '可用');
eq('短标签：额度到期', shortLabel('额度到期'), '到期');
/*
 * 「今日已用」是后端**本地差分**出来的（Qoder 接口只给当月累计，没有今日维度，
 * 见 qoder_cli.rs::advance_day）。它是绝对值、不是百分比，所以：
 *   · 不参与健康度（healthPercentOf 认不出百分比 → null）
 *   · 但方向仍是「已用」（isUsageLabel → true），写反了颜色会翻过来
 */
eq('短标签：今日已用', shortLabel('今日已用'), '今日');
eq('Qoder「今日已用」算 usage 方向', isUsageLabel('今日已用'), true);
eq('Qoder「今日已用」是绝对值，不参与健康度', healthPercentOf('今日已用', '93 credits'), null);
/*
 * Qoder 的 PAT 兜底路径（qoder.rs）产出的是另一套标签 —— 只在「没装 CLI」时才会走到，
 * 正因为不常出现，漏登记最难被发现。三个都钉住。
 */
eq('短标签：额度已用（PAT 路径）', shortLabel('额度已用'), '额度');
eq('短标签：资源包已用（PAT 路径）', shortLabel('资源包已用'), '资源包');
eq('短标签：组织资源包（PAT 路径）', shortLabel('组织资源包'), '组织包');
/* 带序号的动态标签走前缀表，且序号必须接回去（多个专用包靠它区分） */
eq('短标签：专用资源包 1', shortLabel('专用资源包 1'), '专用包 1');
eq('短标签：专用资源包 12（多位数序号）', shortLabel('专用资源包 12'), '专用包 12');
/* Trae（trae.rs）：五项都钉住，「本周期」是订阅周期，别与 ChatGPT 的「本时段」混 */
eq('短标签：本周期剩余', shortLabel('本周期剩余'), '剩余');
eq('短标签：本周期已用', shortLabel('本周期已用'), '已用');
eq('短标签：本周期总额', shortLabel('本周期总额'), '总额');
eq('短标签：已用比例', shortLabel('已用比例'), '比例');
eq('短标签：权益包额度', shortLabel('权益包额度'), '权益包');
/*
 * Trae 的「已用比例」是接口给的百分比（0~1 换算而来），方向必须认成「已用」——
 * 认反了健康度会从 25% 变成 75%，颜色与提醒档位全跟着翻。
 * 而「本周期剩余 / 权益包额度」是 credits 绝对量，不该被当成百分比。
 */
eq('Trae「已用比例」算 usage 方向', isUsageLabel('已用比例'), true);
eq('Trae「已用比例」参与健康度', healthPercentOf('已用比例', '25%'), 75);
eq('Trae「本周期剩余」是绝对值，不参与健康度', healthPercentOf('本周期剩余', '1499.5'), null);
/* 没登记的标签原样返回，不能被截断或改写 */
eq('短标签：未登记时原样返回', shortLabel('某新平台余额'), '某新平台余额');
eq('短标签：前缀像但不等价时原样返回', shortLabel('专用资源包'), '专用资源包');

/* =============================================
   ====== 颜色：100 绿 → 0 红 ======
   ============================================= */
/* 端点必须落在主题的语义色上：100 = 成功绿、0 = 错误红 */
eq('深色 100% 收敛到成功绿', healthColor(100, 'dark'), 'rgb(52 211 153)');
eq('深色 0% 收敛到错误红', healthColor(0, 'dark'), 'rgb(248 113 113)');
eq('浅色 100% 收敛到成功绿', healthColor(100, 'light'), 'rgb(5 150 105)');
eq('浅色 0% 收敛到错误红', healthColor(0, 'light'), 'rgb(220 38 38)');
eq('越界向下收敛到端点', healthColor(-20, 'dark'), healthColor(0, 'dark'));
eq('越界向上收敛到端点', healthColor(180, 'light'), healthColor(100, 'light'));

const rgbOf = (v: string): [number, number, number] => {
  const m = v.match(/\d+/g)!.slice(0, 3).map(Number);
  return [m[0], m[1], m[2]];
};
const relLum = ([r, g, b]: [number, number, number]): number => {
  const f = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrastOf = (a: [number, number, number], b: [number, number, number]): number => {
  const [hi, lo] = [relLum(a), relLum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const satOf = ([r, g, b]: [number, number, number]): number => {
  const x = r / 255;
  const y = g / 255;
  const z = b / 255;
  const mx = Math.max(x, y, z);
  const mn = Math.min(x, y, z);
  const l = (mx + mn) / 2;
  return mx === mn ? 0 : (mx - mn) / (1 - Math.abs(2 * l - 1));
};
const CANVAS: Record<'dark' | 'light', [number, number, number]> = {
  dark: [10, 11, 13],
  light: [255, 255, 255],
};

/*
 * 这两条是「颜色发棕」的直接防线：
 *   1. 对比度 —— 首页 34px/700、面板 22px/600 都算大号字，门槛 3:1
 *   2. 饱和度 —— 「棕/浑浊」的观感来自低饱和的暗黄。固定亮度的老实现在
 *      浅色主题中间段会呈现橄榄色。这条断言防止以后又把配色改浑。
 * 注意断言的是**要求**而不是具体色值：色标可以随时微调，门槛不能退。
 */
for (const mode of ['dark', 'light'] as const) {
  let minC = Infinity;
  let minS = Infinity;
  for (let p = 0; p <= 100; p += 5) {
    const rgb = rgbOf(healthColor(p, mode));
    minC = Math.min(minC, contrastOf(rgb, CANVAS[mode]));
    minS = Math.min(minS, satOf(rgb));
  }
  ok(`${mode} 全段对比度 ≥3:1（大号字门槛），实测最低 ${minC.toFixed(2)}`, minC >= 3);
  ok(`${mode} 全段饱和度 ≥0.55（防止退化成浑浊的暗黄），实测最低 ${minS.toFixed(2)}`, minS >= 0.55);
}

/* =============================================
   ====== 阈值提醒 ======
   ============================================= */
type Src = { provider: string; name: string; items: { label: string; value: string }[] };

const src = (provider: string, name: string, label: string, value: string): Src => ({
  provider,
  name,
  items: [{ label, value }],
});

eq('阈值档位', ALERT_THRESHOLDS.slice(), [50, 30, 20, 10, 5]);

resetAlerts();
eq('初始无提醒记录', alertSnapshot(), {});

/* --- 首次跌破 50：只发一档 --- */
let out = evaluateAlerts([src('chatgpt', 'ChatGPT', '本周已用', '60%')]);
eq('跌破 50 只发一档', out.map((a) => a.threshold), [50]);
eq('提醒正文', alertBody(out[0]), 'ChatGPT 本周剩余 40%');

/* --- 同一数据再评估：去重 --- */
eq('同数据不重复发', evaluateAlerts([src('chatgpt', 'ChatGPT', '本周已用', '60%')]), []);

/* --- 继续跌破 30/20：只发最深那档，但两档都记账 --- */
out = evaluateAlerts([src('chatgpt', 'ChatGPT', '本周已用', '85%')]);
eq('同时跌破 30/20 只发最深', out.map((a) => a.threshold), [20]);
eq('两档都记成已提醒', out[0].marked.slice().sort((a, b) => b - a), [30, 20]);
eq('再评估仍不重复发', evaluateAlerts([src('chatgpt', 'ChatGPT', '本周已用', '85%')]), []);

/* --- 一路跌到 4%：10/5 两档，发最深 5 --- */
out = evaluateAlerts([src('chatgpt', 'ChatGPT', '本周已用', '96%')]);
eq('跌破 10/5 只发最深', out.map((a) => a.threshold), [5]);
eq('5% 档正文', alertBody(out[0]), 'ChatGPT 本周剩余 4%');

/* --- 额度窗口重置（回升）→ 重新武装 --- */
eq('回升时不发提醒', evaluateAlerts([src('chatgpt', 'ChatGPT', '本周已用', '0%')]), []);
eq('回升后记录清空', alertSnapshot()['chatgpt::本周已用'], undefined);

out = evaluateAlerts([src('chatgpt', 'ChatGPT', '本周已用', '55%')]);
eq('重新武装后 50 档可再发', out.map((a) => a.threshold), [50]);

/* --- 边界：仍在阈值之下 / 恰好等于阈值 / 严格大于才重新武装 --- */
eq('health 40 < 50 时不发', evaluateAlerts([src('chatgpt', 'ChatGPT', '本周已用', '60%')]), []);
eq('50 档仍在记录里', alertSnapshot()['chatgpt::本周已用'], [50]);
eq('health 恰好 50 不算回升', evaluateAlerts([src('chatgpt', 'ChatGPT', '本周已用', '50%')]), []);
eq('恰好 50 时记录不变', alertSnapshot()['chatgpt::本周已用'], [50]);
eq('health 60 > 50 才算回升', evaluateAlerts([src('chatgpt', 'ChatGPT', '本周已用', '40%')]), []);
eq('回升后记录清空', alertSnapshot()['chatgpt::本周已用'], undefined);

/* --- 推送失败回滚后可重发 --- */
resetAlerts();
out = evaluateAlerts([src('claude', 'Claude', '剩余额度', '3%')]);
eq('剩余 3% 发最深档 5', out.map((a) => a.threshold), [5]);
unmarkAlert(out[0]);
out = evaluateAlerts([src('claude', 'Claude', '剩余额度', '3%')]);
eq('回滚后可重发', out.map((a) => a.threshold), [5]);

/* --- 不同标签互不干扰 --- */
resetAlerts();
out = evaluateAlerts([
  src('chatgpt', 'ChatGPT', '本周已用', '60%'),
  src('chatgpt', 'ChatGPT', '本时段已用', '60%'),
]);
eq('不同指标各自提醒', out.map((a) => a.label), ['本周已用', '本时段已用']);

/* --- 出错平台 / 非百分比指标不参与 --- */
resetAlerts();
eq(
  '出错平台被跳过',
  evaluateAlerts([
    { provider: 'gemini', name: 'Gemini', items: [{ label: '已用', value: '90%' }], error: '无凭证' },
  ]),
  [],
);
eq('非百分比不参与', evaluateAlerts([src('chatgpt', 'ChatGPT', '余额', '$3.20')]), []);

/* =============================================
   ====== 摘要字节预算（固件正文上限 95 字节）======
   ============================================= */
{
  const many = Array.from({ length: 12 }, (_, i) => ({
    name: `平台${i}`,
    items: [{ label: '本周已用', value: `${i}0%` }],
  }));
  const s = buildBadgeSummary(many);
  ok(`摘要不超 95 字节（实际 ${byteLen(s)}）`, byteLen(s) <= 95);
  ok('摘要非空', s.length > 0);
}
eq('空列表摘要为空串', buildBadgeSummary([]), '');

/*
 * ⚠️ 分隔符的字节数回归（2026-10-22 修的真 bug）。
 *
 * ' · ' 中间的 '·' 是 U+00B7，UTF-8 占 **2 字节**，加两侧空格共 **4 字节**。
 * 原代码手写 `const SEP = 3`，于是每多一个平台就少算 1 字节：
 * 两个平台时预算算出来正好 95，真实字符串却是 96 —— 前端放行、后端拒绝，
 * 表现为「推送到徽章总是报正文过长（96 字节，徽章最多 95 字节）」。
 *
 * 这条断言钉住「分隔符的字节数 = 现算出来的值」，防止有人再手抄数字。
 */
eq('分隔符是 4 字节（不是 3）', byteLen(SUMMARY_SEP), 4);

/* truncateBytes：不切断字符，且结果一定不超预算 */
{
  eq('不超预算时原样返回', truncateBytes('abc', 10), 'abc');
  eq('中文按字节截断', truncateBytes('中文中文', 6), '中文');
  ok('截断结果不超预算', byteLen(truncateBytes('中文中文中文', 7)) <= 7);
  /* 代理对不能被劈成两半（emoji 是 4 字节） */
  const emoji = '🙂';
  eq('emoji 不被劈开', truncateBytes(emoji + 'a', 2), '');
}

/*
 * 复现原始 bug 的**精确用例**（2026-10-22 真 bug）。
 *
 * 两个平台，head 分别是「40 个 A + 余额1」与「36 个 B + 余额2」：
 *   真实长度 = head1(48) + ' · '(4) + head2(44) = 96 字节
 *   旧预算   = head1(48) + 3        + head2(44) = 95 字节 → **恰好放行**
 * 于是前端放行、后端按「96 > 95」把整条推送拒掉。
 *
 * 修好之后同一组输入只剩第一个平台（48 字节）——
 * 第二个平台被整块丢弃，而不是拼出一条会被拒绝的正文。
 */
{
  const list = [
    { name: 'A'.repeat(40), items: [{ label: '余额', value: '1' }] },
    { name: 'B'.repeat(36), items: [{ label: '余额', value: '2' }] },
  ];
  const s = buildBadgeSummary(list);
  ok(`边界用例不超 95 字节（实际 ${byteLen(s)}）`, byteLen(s) <= 95);
  /* 超限时整块丢弃末尾平台，而不是把内容截成两半 */
  ok('第二个平台被整块丢弃（不是截断）', !s.includes('B'));
}

/* 各种极端形状下都不许超限（这一组是「后端会整条拒收」的防线） */
{
  const shapes: Array<{ name: string; items: Array<{ label: string; value: string }> }> = [
    { name: '', items: [{ label: '余额', value: '1' }] },
    { name: 'x'.repeat(200), items: [{ label: '余额', value: '1' }] },
    { name: '正常平台', items: [{ label: '余额', value: '$984.31' }] },
    {
      name: '多指标',
      items: [
        { label: '剩余额度', value: '$984.31' },
        { label: '本周已用', value: '64%' },
        { label: '本时段已用', value: '12%' },
      ],
    },
  ];
  for (const shape of shapes) {
    const s = buildBadgeSummary([shape]);
    ok(
      `极端形状「${shape.name.slice(0, 12)}」不超 95 字节（实际 ${byteLen(s)}）`,
      byteLen(s) <= 95,
    );
  }
}

/*
 * `buildBadgeSummaryResult` 的 `included`：告诉界面「哪些平台真的上了徽章」。
 *
 * 为什么值得单独测：设置页要提示「你勾了 5 个，其中 3 个放不下被略过了」，
 * 这个提示的判据只能是 `included`。用 `text.includes(name)` 那种子串匹配
 * 在平台名互为前缀时会误判，而误判的方向恰好是「少报漏掉的」——
 * 用户永远看不到那条提示，也就永远不知道为什么徽章上少了一个平台。
 */
{
  /* ① 两个短平台都装得下 → 两个都该在 included 里，且顺序与输入一致 */
  const both = buildBadgeSummaryResult([
    { name: 'ChatGPT', items: [{ label: '余额', value: '$984.31' }] },
    { name: 'Claude', items: [{ label: '本周已用', value: '64%' }] },
  ]);
  eq('两个平台都进了摘要', both.included, ['ChatGPT', 'Claude']);
  ok('正文里确实有两个平台', both.text.includes('ChatGPT') && both.text.includes('Claude'));

  /* ② 放不下第二个 → included 只留第一个（**与正文严格同步**） */
  const over = buildBadgeSummaryResult([
    { name: 'A'.repeat(40), items: [{ label: '余额', value: '1' }] },
    { name: 'B'.repeat(36), items: [{ label: '余额', value: '2' }] },
  ]);
  eq('超限时只报第一个平台', over.included, ['A'.repeat(40)]);

  /*
   * ③ 带 error 的平台不进 included —— 它的 items 是上次的残留或空的，
   * 打包时被 filter 掉了，所以也不该被算成「已推送」。
   */
  const withErr = buildBadgeSummaryResult([
    { name: 'ChatGPT', items: [{ label: '余额', value: '$1' }] },
    { name: 'Gemini', items: [{ label: '余额', value: '$2' }], error: '无凭证' },
  ]);
  eq('有 error 的平台不进 included', withErr.included, ['ChatGPT']);

  /* ④ 空输入 → 空正文、空 included（不能返回 [''] 之类的东西） */
  const empty = buildBadgeSummaryResult([]);
  eq('空输入正文为空', empty.text, '');
  eq('空输入 included 为空', empty.included, []);

  /*
   * ⑤ 兜底分支（一个平台都放不下、只能砍名字）也要如实报告「进了摘要」——
   * 它确实推上去了一个（名字被截短），不能因为截短就不算。
   */
  const huge = buildBadgeSummaryResult([
    { name: 'X'.repeat(200), items: [{ label: '余额', value: '1' }] },
  ]);
  eq('兜底砍名字时仍算已推送', huge.included.length, 1);
  ok('兜底正文不超 95 字节', byteLen(huge.text) <= 95);
}

/* 超限时整块丢弃末尾的平台，而不是把数值拦腰截断 */
{
  const long = {
    name: '长名字平台',
    items: [{ label: '余额', value: '$984.31' }],
  };
  const s = buildBadgeSummary([long, long, long, long, long, long, long, long]);
  ok(`超限时仍不超 95 字节（实际 ${byteLen(s)}）`, byteLen(s) <= 95);
  /* 数值必须完整 —— 截一半会得到一个「另一个数字」，比少显示一项糟糕得多 */
  ok('超限时数值不被截断', !s.includes('$984.3 '));
}

/* =============================================
   ====== 最低健康度（侧栏角标用）======
   ============================================= */
eq('空列表 → null', worstHealth([]), null);
eq(
  '只有非百分比指标 → null',
  worstHealth([{ name: 'X', items: [{ label: '余额', value: '$3.20' }] }]),
  null,
);
eq(
  '同一平台取最紧张的那个指标',
  worstHealth([
    {
      name: 'X',
      items: [
        { label: '本时段已用', value: '64%' }, // 健康度 36 ← 最小
        { label: '本周已用', value: '39%' }, // 61
        { label: 'gpt-reserve', value: '0%' }, // 100
      ],
    },
  ]),
  36,
);
eq(
  '跨平台取全局最低',
  worstHealth([
    { name: 'A', items: [{ label: '已用', value: '10%' }] }, // 90
    { name: 'B', items: [{ label: '剩余额度', value: '12%' }] }, // 12 ← 最小
  ]),
  12,
);
eq(
  '带 error 的平台整块跳过',
  worstHealth([
    { name: 'A', items: [{ label: '已用', value: '99%' }], error: '无凭证' }, // 1，应被跳过
    { name: 'B', items: [{ label: '已用', value: '10%' }] }, // 90
  ]),
  90,
);
eq('结果四舍五入', worstHealth([{ name: 'X', items: [{ label: '已用', value: '63.6%' }] }]), 36);

/* ---- 角标文案的边界 ---- */
eq('健康时不出角标', healthBadgeText(80, 50), null);
eq('恰好等于阈值要出角标（用 <=）', healthBadgeText(50, 50), '50%');
eq('跌破阈值出角标', healthBadgeText(36, 50), '36%');
eq('最低到 0 也出角标', healthBadgeText(0, 50), '0%');
eq('没有可比数据时不出角标', healthBadgeText(null, 50), null);

/* =============================================
   ====== 倒计时短语（「约 N 分钟后自动刷新」）======
   ============================================= */
eq('倒计时 0 秒', formatCountdown(0), '不到 1 分钟');
eq('倒计时 59 秒', formatCountdown(59), '不到 1 分钟');
eq('倒计时 60 秒', formatCountdown(60), '1 分钟');
eq('倒计时 12 分钟', formatCountdown(12 * 60), '12 分钟');
eq('倒计时 59 分钟', formatCountdown(59 * 60), '59 分钟');
eq('倒计时 60 分钟', formatCountdown(60 * 60), '1 小时');
eq('倒计时 65 分钟', formatCountdown(65 * 60), '1 小时 5 分');
eq('倒计时负数不出现「约 0 分钟」', formatCountdown(-5), '不到 1 分钟');

/* =============================================
   ====== 时刻文本（ChatGPT 重置 / 刷新时间）======
   =============================================
   用 Date 的**本地分量**造时间戳，所以断言与运行机器的时区无关。
   ============================================= */
const tNow = new Date(2026, 10, 9, 12, 0, 0).getTime() / 1000;
eq(
  '当天时刻 → 只给 HH:mm',
  clockAt(new Date(2026, 10, 9, 16, 42, 40).getTime() / 1000, tNow),
  '16:42',
);
eq(
  '跨天时刻必须带 HH:mm（不能只剩日期）',
  clockAt(new Date(2026, 10, 14, 6, 46, 1).getTime() / 1000, tNow),
  '11-14 06:46',
);
eq('无效时间 → null，不编造', clockAt(NaN, tNow), null);
/* ChatGPT 本时段耗尽、但重置在几天后：菜单栏那一格要写成「5h 11-14 06:46」 */
eq(
  'ChatGPT 耗尽 + 跨天重置：菜单栏带时分',
  balTray.chatgptWindowsBody(
    [
      { label: '本时段已用', value: '100%', resetAt: new Date(2026, 10, 14, 6, 46, 1).getTime() / 1000 },
      { label: '本周已用', value: '48%', resetAt: new Date(2026, 10, 15, 8, 0, 0).getTime() / 1000 },
    ],
    tNow,
  ),
  '5h 11-14 06:46 · 7d 48%',
);

/* =============================================
   ====== 已提醒档位的界面视图 ======
   ============================================= */
/* =============================================
   ====== sparkline 纵向映射 ======
   ============================================= */
/* 真机数据里余额长期不变，10 个点全等 —— 这一格必须画在正中 */
eq('全等序列画在正中，不是贴着底部', sparkY(984.31, 984.31, 984.31, 56, 6), 28);
eq('最大值贴近上边距', sparkY(100, 0, 100, 56, 6), 6);
eq('最小值贴近下边距', sparkY(0, 0, 100, 56, 6), 50);
eq('中间值落在正中', sparkY(50, 0, 100, 56, 6), 28);

/* =============================================
   ====== 趋势序列：主指标换了必须重开 ======
   ============================================= */
eq('空历史 → 追加', decideHistory(null, 100, '剩余额度', 1000, 60), 'append');
eq(
  '同一指标、值不同 → 追加',
  decideHistory({ t: 900, v: 100, label: '剩余额度' }, 120, '剩余额度', 1000, 60),
  'append',
);
eq(
  '同一指标、同值且 60s 内 → 跳过（防噪声）',
  decideHistory({ t: 980, v: 100, label: '剩余额度' }, 100, '剩余额度', 1000, 60),
  'skip',
);
eq(
  '同一指标、同值但已过 60s → 追加',
  decideHistory({ t: 900, v: 100, label: '剩余额度' }, 100, '剩余额度', 1000, 60),
  'append',
);
eq(
  '主指标换了（剩余额度 → 本时段已用）→ 重开序列',
  decideHistory({ t: 900, v: 984.31, label: '剩余额度' }, 64, '本时段已用', 1000, 60),
  'reset',
);
/* 这一格最容易写错：量纲不同的两个 64 不是「重复」，必须先判指标再判去重 */
eq(
  '主指标换了且数值恰好相同 → 仍然是重开，不能当重复跳过',
  decideHistory({ t: 980, v: 64, label: '本时段已用' }, 64, '剩余额度', 1000, 60),
  'reset',
);
eq(
  '升级前的老点没有 label → 视为主指标已变，重开一次',
  decideHistory({ t: 900, v: 100 }, 100, '剩余额度', 1000, 60),
  'reset',
);

/* =============================================
   ====== 角标色调：角标能不能表达紧急程度 ======
   ============================================= */
eq('健康 60（角标本就不显示的区间）→ info', healthBadgeTone(60), 'info');
eq('健康 50（刚好开始出现角标）→ info', healthBadgeTone(50), 'info');
eq('健康 31 → info', healthBadgeTone(31), 'info');
eq('健康 30（第二档提醒）→ warn', healthBadgeTone(30), 'warn');
eq('健康 11 → warn', healthBadgeTone(11), 'warn');
eq('健康 10（第四档提醒）→ danger', healthBadgeTone(10), 'danger');
eq('健康 5（最后一档）→ danger', healthBadgeTone(5), 'danger');
eq('健康 0 → danger', healthBadgeTone(0), 'danger');

/*
 * 边界必须落在 ALERT_THRESHOLDS 已有的档位上。
 * 这条断言是防「两套刻度漂移」的：如果哪天有人改了提醒档位却忘了改颜色边界，
 * 用户就会看到「已经变红了但还没提醒过」这种自相矛盾的状态。
 */
ok(
  '角标边界必须是提醒档位之一（30）',
  ALERT_THRESHOLDS.includes(BADGE_TONE_WARN_AT as (typeof ALERT_THRESHOLDS)[number]),
);
ok(
  '角标边界必须是提醒档位之一（10）',
  ALERT_THRESHOLDS.includes(BADGE_TONE_DANGER_AT as (typeof ALERT_THRESHOLDS)[number]),
);
ok('warn 必须比 danger 更宽（否则 warn 永远不可达）', BADGE_TONE_WARN_AT > BADGE_TONE_DANGER_AT);

resetAlerts();
eq('无记录时是空数组', alertStatus(), []);

evaluateAlerts([src('chatgpt', 'ChatGPT', '本周已用', '85%')]);
/* 已用 85% → 健康度 15 → 跨过 50 / 30 / 20 三档，从宽到严排 */
eq(
  'alertStatus 拆开 provider 与 label，档位从宽到严',
  alertStatus().map((r) => [r.provider, r.label, r.notified]),
  [['chatgpt', '本周已用', [50, 30, 20]]],
);

resetAlerts();
evaluateAlerts([src('x', 'X', 'a::b', '90%')]);
eq(
  '标签里含 :: 也按第一个分隔符拆对',
  alertStatus().map((r) => [r.provider, r.label, r.notified]),
  [['x', 'a::b', [50, 30, 20, 10]]],
);

/* =============================================
   ====== 趋势粒度：按次 / 按小时 / 按天 ======
   ============================================= */
/* 用本地时间构造时间戳，断言就不依赖运行机器的时区 */
const at = (y: number, mo: number, d: number, h = 0, mi = 0): number =>
  Math.floor(new Date(y, mo, d, h, mi).getTime() / 1000);
const pt = (t: number, v: number): { t: number; v: number } => ({ t, v });

eq('按次：原样返回，不聚合', bucketHistory([pt(at(2026, 8, 18, 10, 0), 1)], 'raw').length, 1);

eq(
  '按小时：同一小时合并，保留最后一条',
  bucketHistory(
    [
      pt(at(2026, 8, 18, 10, 5), 1),
      pt(at(2026, 8, 18, 10, 50), 2),
      pt(at(2026, 8, 18, 11, 5), 3),
    ],
    'hour',
  ).map((x) => x.v),
  [2, 3],
);
eq(
  '按小时：跨小时要分开（59 分与 00 分不是同一桶）',
  bucketHistory([pt(at(2026, 8, 18, 10, 59), 1), pt(at(2026, 8, 18, 11, 0), 2)], 'hour').length,
  2,
);

eq(
  '按天：同一本地日合并，保留最后一条',
  bucketHistory(
    [
      pt(at(2026, 8, 18, 1, 0), 1),
      pt(at(2026, 8, 18, 23, 30), 2),
      pt(at(2026, 8, 19, 0, 30), 3),
    ],
    'day',
  ).map((x) => x.v),
  [2, 3],
);
/* 这一格最容易错：用 UTC 切天会让 UTC+8 的用户在凌晨 8 点换天 */
eq(
  '按天：按本地日切分（23:59 与次日 00:01 是两天）',
  bucketHistory([pt(at(2026, 8, 18, 23, 59), 1), pt(at(2026, 8, 19, 0, 1), 2)], 'day').length,
  2,
);
eq(
  '按天：跨月按本地日期分开',
  bucketHistory([pt(at(2026, 8, 30, 12, 0), 1), pt(at(2026, 9, 1, 12, 0), 2)], 'day').length,
  2,
);

/* ---- 分层降采样 ---- */
const NOW = at(2026, 8, 18, 12, 0);
const DAY = 24 * 3600;
const raw = [
  pt(NOW - 30 * DAY, 100), // 30 天前 -> 每天一条
  pt(NOW - 30 * DAY + 3600, 101),
  pt(NOW - 3 * DAY, 200), // 3 天前 -> 每小时一条
  pt(NOW - 3 * DAY + 600, 201),
  pt(NOW - 3 * DAY + 1200, 202),
  pt(NOW - 3600, 300), // 1 小时前 -> 全部保留
  pt(NOW - 1800, 301),
];
const pruned = pruneHistory(raw, NOW);
eq(
  '降采样：30 天前的同一天只留最后一条',
  pruned.filter((x) => x.v >= 100 && x.v < 200).map((x) => x.v),
  [101],
);
eq(
  '降采样：3 天前的同一小时只留最后一条',
  pruned.filter((x) => x.v >= 200 && x.v < 300).map((x) => x.v),
  [202],
);
eq(
  '降采样：24 小时内全部保留',
  pruned.filter((x) => x.v >= 300).map((x) => x.v),
  [300, 301],
);
ok('降采样：结果仍按时间升序', pruned.every((x, i) => i === 0 || x.t >= pruned[i - 1].t));

const many = Array.from({ length: TREND_MAX + 50 }, (_, i) =>
  pt(NOW - (TREND_MAX + 50 - i) * 30, i),
);
eq('降采样：超出上限时从最旧开始丢', pruneHistory(many, NOW).length, TREND_MAX);

/* =============================================
   ====== 趋势跟踪哪个指标 ======
   ============================================= */
const item = (label: string, value: string, resetAt?: number) => ({ label, value, resetAt });
/* 真机快照（2026-09-18 ChatGPT PLUS 的实际返回） */
const REAL_ITEMS = [
  item('本时段已用', '66%'),
  item('本周已用', '39%'),
  item('剩余额度', '984.31'),
  item('约可用消息', '246~1280'),
  item('可用重置次数', '2'),
  item('gpt-reserve', '0%'),
];

/*
 * 这一格就是用户报的「趋势永远是直线」：主指标按优先级挑到「剩余额度」（credits），
 * 而它在 18 次刷新里一次没变。自动模式必须避开这种恒定绝对量。
 */
eq(
  '自动模式避开恒定的「剩余额度」，改挑百分比指标',
  pickTrendMetric(REAL_ITEMS, null, pickPrimaryMetric(REAL_ITEMS))?.label,
  '本时段已用',
);
eq('主指标本身仍是「剩余额度」（面板大数字不该被改）', pickPrimaryMetric(REAL_ITEMS)?.label, '剩余额度');

eq(
  '用户显式指定时优先用它',
  pickTrendMetric(REAL_ITEMS, '本周已用', pickPrimaryMetric(REAL_ITEMS))?.label,
  '本周已用',
);
eq(
  '指定的指标不存在时回落到自动',
  pickTrendMetric(REAL_ITEMS, '不存在的指标', pickPrimaryMetric(REAL_ITEMS))?.label,
  '本时段已用',
);
/* 没有任何百分比时（例如只有货币余额），才沿用主指标 */
const NO_PCT = [item('余额', '$12.50'), item('重置次数', '3')];
eq(
  '没有百分比指标时回落到主指标',
  pickTrendMetric(NO_PCT, null, pickPrimaryMetric(NO_PCT))?.label,
  '余额',
);
eq('空列表返回 null', pickTrendMetric([], null, null), null);
eq(
  '百分比指标之间按优先级取（已用优先于其它）',
  pickTrendMetric([item('gpt-reserve', '0%'), item('本周已用', '39%')], null, null)?.label,
  '本周已用',
);

/* =============================================
   ====== 首页那一格展示哪个指标（snapshot.pickHomeMetric） ======
   =============================================
   2026-10-26 的真 bug：首页主数字走 pickPrimaryMetric、曲线走 pickTrendMetric，
   两者可以指向**不同指标**。用户选了「本周已用」，首页照旧显示「剩余额度」，
   而且曲线画的是另一个指标 —— 数字和曲线说的不是一回事。
   现在整格只有一个口径：用户选的优先，没选/选不到就自动挑。
   ============================================= */
eq('首页取数：不指定时自动挑', pickHomeMetric(REAL_ITEMS, null)?.label, '本时段已用');
eq(
  '首页取数：用户选了「本周已用」就用它（而不是剩余额度）',
  pickHomeMetric(REAL_ITEMS, '本周已用')?.label,
  '本周已用',
);
/* 值必须跟着指标一起换 —— 只换标签不换数字才是最难发现的那种错 */
eq('首页取数：值随指标一起换', pickHomeMetric(REAL_ITEMS, '本周已用')?.value, '39%');
eq('首页取数：选剩余额度时给的是那个绝对值', pickHomeMetric(REAL_ITEMS, '剩余额度')?.value, '984.31');
/* 选过的指标若已不在本次数据里（后端改标签 / 该平台这次没返回），回落到自动，不能空白 */
eq(
  '首页取数：指定的指标不存在时回落到自动',
  pickHomeMetric(REAL_ITEMS, '不存在的指标')?.label,
  '本时段已用',
);
eq('首页取数：空列表返回 null', pickHomeMetric([], '本周已用'), null);
/* 没有任何百分比时沿用主指标，不能因为选了百分比就整格空白 */
eq('首页取数：没有百分比时回落到主指标', pickHomeMetric(NO_PCT, null)?.label, '余额');

/* =============================================
   ====== 额度用满时的「什么时候回来」（format.exhaustedNote） ======
   =============================================
   判据三条都要对：**用量类** + **用满** + **后端给了重置时间**。
   任何一条写反，界面上只是多一行或少一行，肉眼发现不了。
   ============================================= */
eq(
  '用满：本周已用 100% 带出重置时间',
  exhaustedNote({ label: '本周已用', value: '100%', sub: '重置 10月27日 08:00' }),
  '重置 10月27日 08:00',
);
eq(
  '用满：本时段带「已达上限」前缀时原样带出',
  exhaustedNote({ label: '本时段已用', value: '100%', sub: '已达上限 · 重置 14:30' }),
  '已达上限 · 重置 14:30',
);
eq(
  '用满：没用满就不显示',
  exhaustedNote({ label: '本周已用', value: '39%', sub: '重置 10月27日 08:00' }),
  null,
);
/* 用满了但后端没给 reset_at —— 用户明确要求这种情况不要显示空壳 */
eq('用满：没有重置时间就不显示', exhaustedNote({ label: '本周已用', value: '100%' }), null);
eq(
  '用满：空字符串的 sub 也不显示',
  exhaustedNote({ label: '本周已用', value: '100%', sub: '   ' }),
  null,
);
/* 剩余额度归零不是「本时段/本周」那回事，它的 sub 是 credits，不是重置时间 */
eq(
  '用满：剩余额度归零不显示（sub 不是重置时间）',
  exhaustedNote({ label: '剩余额度', value: '0%', sub: 'credits' }),
  null,
);
eq('用满：null 安全', exhaustedNote(null), null);
/* usedPercent 那条路也要能触发（Qoder 这类被降级成绝对值的用量项） */
eq(
  '用满：靠 usedPercent 判定的用量项也能带出',
  exhaustedNote({ label: 'gpt-reserve', value: '3000', usedPercent: 100, sub: '重置 08:00' }),
  '重置 08:00',
);

/* =============================================
   ====== 设备行（徽章上的余额图表页） ======
   =============================================
   固件侧的解析器在 ai-passport/main/balance_store.c，那边也有一套主机测试。
   这里只测「编出来的行」是否符合协议与字节预算 —— 编错的表现是设备上
   什么都没变（固件整行丢弃且不报错），在界面上根本看不出来。

   趋势行（BALT）已废弃：设备屏上不画 sparkline，所以这里也只推一行 BAL。
   固件仍会「认领」BALT 只是为了拦住没重启的旧版工作台。 */

type DevItem = { label: string; value: string; resetAt?: number };
const devSnap = (items: DevItem[], ageSec = 120) => ({
  provider: 'chatgpt',
  name: 'ChatGPT',
  items,
  refreshedAt: Math.floor(Date.now() / 1000) - ageSec,
});

/* 真机上的典型数据：主指标是恒定的绝对量，百分比指标才在变 */
const DEV_ITEMS: DevItem[] = [
  item('剩余额度', '984.31'),
  item('本时段已用', '64%'),
  item('本周已用', '12%'),
];
const devBase = { snapshot: devSnap(DEV_ITEMS) };

const devLines = buildDeviceLines(devBase);
eq('只推一行（趋势已废弃）', devLines.length, 1);
ok('这一行是 BAL', devLines[0].startsWith('BAL|'));
ok('每行都不超过固件整行上限', devLines.every((l) => byteLen(l) <= DEVICE_LINE_MAX));
ok('行内不含换行（换行会把一条拆成两条）', devLines.every((l) => !/[\r\n]/.test(l)));

/* 头部字段：平台 / 刷新时间 / 主指标三元组 / 环... */
const devHead = devLines[0].split('|');
eq('平台名', devHead[1], 'ChatGPT');
eq('主指标标签', devHead[3].split('~')[0], '剩余额度');
eq('主指标值', devHead[3].split('~')[1], '984.31');
/* 绝对量没有百分比语义 → 健康度必须留空（「未知」和「0 = 耗尽」是两件事） */
eq('绝对量主指标的健康度留空', devHead[3].split('~')[2], '');
eq('环形指标数量', devHead.length - 4, 2);

/*
 * 第三段是**绝对时刻**（Unix 秒），不是「3 分钟前刷新」这种短语。
 *
 * 短语是**推送那一刻**算好的，写进设备后就再也不变 —— 断连、或「数据没变所以
 * 不推」的时候，设备上那句「3 分钟前」会永久停在错误的时刻上。时间戳交给设备
 * 自己算（固件用它的 NTP），断连期间那句话还会继续往上走，那才是它该有的行为。
 */
ok('刷新时刻是纯数字（Unix 秒）', /^\d+$/.test(devHead[2]));
eq('刷新时刻就是快照里的 refreshedAt', devHead[2], String(devBase.snapshot.refreshedAt));
ok('刷新时刻里没有非 ASCII 字符（那句话由设备自己渲染）', !/[^\x00-\x7F]/.test(devHead[2]));
ok('刷新时刻不会撑破字段上限', byteLen(devHead[2]) <= DEVICE_REFRESHED_MAX);

/* 取不到时间 → 留空字段。固件把「空」当「不知道」并隐藏这一行，
   比编一个假的「刚刚刷新」诚实。 */
const devNoTime = buildDeviceLines({
  snapshot: { provider: 'chatgpt', name: 'ChatGPT', items: DEV_ITEMS, refreshedAt: 0 },
});
eq('没有刷新时刻 → 字段留空', devNoTime[0].split('|')[2], '');

/*
 * 去重键里带着刷新时刻，所以「只刷新了、数值一个都没变」也会算作内容变化。
 * 这是**故意的**：设备上那句「N 分钟前刷新」就是拿这个时刻算的，
 * 不重推的话它会一直从上一轮开始数，越数越离谱。
 * （用绝对时间戳构造，避免依赖 Date.now 的抖动。）
 */
const devT1 = { snapshot: { ...devBase.snapshot, refreshedAt: 1_758_441_600 } };
const devT2 = { snapshot: { ...devBase.snapshot, refreshedAt: 1_758_441_660 } };
const devA = buildDeviceLines(devT1)[0].split('|');
const devB = buildDeviceLines(devT2)[0].split('|');
ok('只有刷新时刻那一段不同', devA[2] !== devB[2]);
eq(
  '其余各段完全一致',
  devA.filter((_, i) => i !== 2).join('|'),
  devB.filter((_, i) => i !== 2).join('|'),
);
ok(
  '只刷新了时间 → 去重键也必须变',
  deviceLinesKey(buildDeviceLines(devT1)) !== deviceLinesKey(buildDeviceLines(devT2)),
);

/*
 * 环形：**固定就是「本时段」「本周」两个窗口**，顺序也是固定的。
 *
 * 以前是按健康度升序取前二，结果「剩余额度」一消失（credits 用光），主指标
 * 就降级成「本时段已用」，而主指标不参与环形候选 → 两个窗口只剩一个环
 * （2026-10-30 实际发生）。现在窗口优先、不看主指标，环数不再随数据漂移。
 *
 * 弧长用接口原值、颜色用归一后的健康度，两者必须分开 ——
 * 「已用 64%」弧长 64、颜色按「还剩 36%」取。
 */
const devRing0 = devHead[4].split('~');
const devRing1 = devHead[5].split('~');
eq('第一个环固定是本时段', devRing0[0], '本时段已用');
eq('弧长 = 接口原值', devRing0[1], '64');
eq('颜色 = 健康度（已用 → 100 - 64）', devRing0[2], '36');
eq('第二个环固定是本周', devRing1[0], '本周已用');
eq('第二环的健康度', devRing1[2], '88');
/* 第 4 段是重置时刻；这批数据没带 resetAt → 留空（固件据此隐藏那行），
   但**占位必须留着**，否则后面的字段会整体错位 */
eq('没有重置时刻 → 第 4 段留空', devRing0[3], '');
eq('环的子字段数是 4（不是 3）', devRing0.length, 4);

/*
 * 回归用例：主指标本身就是「本时段已用」时，仍然必须出两个环。
 * 这正是「credits 用光后徽章上只剩一个环」的那个场景 ——
 * 主指标与环会重复同一个数字，这是**故意**的，见 device.ts 的 WINDOW_RING_LABELS。
 */
const devNoCredits = buildDeviceLines({
  snapshot: devSnap([
    item('本时段已用', '3%'),
    item('本周已用', '4%'),
    item('可用重置次数', '1'),
  ]),
});
const devNoCreditsHead = devNoCredits[0].split('|');
eq('没有剩余额度时主指标降级成本时段', devNoCreditsHead[3].split('~')[0], '本时段已用');
eq('环数仍是两个', devNoCreditsHead.length - 4, 2);
eq('环一仍是本时段', devNoCreditsHead[4].split('~')[0], '本时段已用');
eq('环二是本周', devNoCreditsHead[5].split('~')[0], '本周已用');

/*
 * 重置时刻：Unix 秒原样推过去，**不在这里算「2 小时后」** ——
 * 短语是推送那一刻算好的，写进设备就冻住，断连后永远停在错的时刻上。
 */
const devReset = buildDeviceLines({
  snapshot: devSnap([
    item('本时段已用', '3%', 1_793_331_989),
    item('本周已用', '4%', 1_793_890_472),
  ]),
});
const devResetHead = devReset[0].split('|');
eq('环一的重置时刻是绝对秒', devResetHead[4].split('~')[3], '1793331989');
eq('环二的重置时刻是绝对秒', devResetHead[5].split('~')[3], '1793890472');
ok('重置时刻是纯数字', /^\d+$/.test(devResetHead[4].split('~')[3]));

/* 重置时刻也不能撑破整行（第 4 段每个环多 11 字节，最坏情况贴着上限） */
ok('带重置时刻时每行仍不超上限', byteLen(devReset[0]) <= DEVICE_LINE_MAX);

/* 没有指标 → 什么都不推（调用方据此提示「暂无可推送的余额数据」） */
eq('items 为空 → 不推任何行', buildDeviceLines({ snapshot: devSnap([]) }).length, 0);

/* 只有货币余额（没有百分比指标）→ 不出环 */
const devMoney = buildDeviceLines({ snapshot: devSnap([item('余额', '$12.50')]) });
eq('没有百分比指标时不出环', devMoney[0].split('|').length, 4);

/* 字段清洗：协议分隔符出现在内容里会把整行拆错位，必须先替换掉 */
eq('竖线被替换', sanitizeField('a|b', 64), 'a/b');
eq('波浪线被替换', sanitizeField('a~b', 64), 'a/b');
eq('换行被替换', sanitizeField('a\nb', 64), 'a/b');
eq('首尾空白被裁掉', sanitizeField('  ChatGPT  ', 64), 'ChatGPT');
eq(
  '按 UTF-8 边界截断，不切出半个汉字',
  byteLen(sanitizeField('一二三四五六七八九十', DEVICE_LABEL_MAX)),
  DEVICE_LABEL_MAX,
);
ok(
  '截断结果一定是完整的字符（字节数是 3 的倍数）',
  byteLen(sanitizeField('一二三四五六七八九十', DEVICE_LABEL_MAX)) % 3 === 0,
);

/* 极端输入下的字节预算：标签与数值都顶到上限 */
const devStress = buildDeviceLines({
  snapshot: devSnap([
    item('这是一个特别特别长的剩余额度指标标签', '1234567890123456789012345'),
    item('一个同样很长的已用百分比标签', '99%'),
    item('另一个很长的百分比指标标签', '1%'),
  ]),
});
ok('极端输入下每行仍不超上限', devStress.every((l) => byteLen(l) <= DEVICE_LINE_MAX));
const devStressHead = devStress[0].split('|');
ok(
  '字段长度受显示宽度约束（不是协议上限）',
  byteLen(devStressHead[3].split('~')[1]) <= DEVICE_VALUE_MAX,
);
ok(
  '环形标签也受显示宽度约束',
  devStressHead.slice(4).every((r) => byteLen(r.split('~')[0]) <= DEVICE_LABEL_MAX),
);

/* 去重键：内容变了键就得变，否则设备上的图永远停在第一次推送的样子 */
ok('内容不同 → 去重键不同', deviceLinesKey(devLines) !== deviceLinesKey(devMoney));
eq('内容相同 → 去重键相同', deviceLinesKey(devLines), deviceLinesKey(buildDeviceLines(devBase)));

/* =============================================
   ====== 自动刷新间隔的收敛（预设 + 自定义） ======
   ============================================= */
/*
 * 间隔值算错，两种后果都不会在界面上显形：夹太松会把平台接口打爆，
 * 夹太紧会把用户填的值静默改掉。所以每条边界都钉住。
 */
eq('预设含 1 分钟', AUTO_REFRESH_OPTIONS.includes(1), true);
eq('预设含 2 分钟', AUTO_REFRESH_OPTIONS.includes(2), true);
eq('预设含 3 分钟', AUTO_REFRESH_OPTIONS.includes(3), true);
ok(
  '预设严格递增（下拉顺序不能乱）',
  AUTO_REFRESH_OPTIONS.every((v, i) => i === 0 || v > AUTO_REFRESH_OPTIONS[i - 1]),
);
ok(
  '预设都落在合法区间内',
  AUTO_REFRESH_OPTIONS.every((v) => v >= MIN_REFRESH_MIN && v <= MAX_REFRESH_MIN),
);
eq('默认值本身合法', validInterval(DEFAULT_REFRESH_MIN), DEFAULT_REFRESH_MIN);

/* 自定义值必须原样接受 —— 这是本次需求的核心 */
eq('自定义 7 分钟', validInterval(7), 7);
eq('自定义 45 分钟', validInterval(45), 45);
eq('自定义 1 分钟（下限）', validInterval(MIN_REFRESH_MIN), MIN_REFRESH_MIN);
eq('自定义 1440 分钟（上限）', validInterval(MAX_REFRESH_MIN), MAX_REFRESH_MIN);
eq('旧预设 60 仍有效', validInterval(60), 60);
eq('小数四舍五入到整分钟', validInterval(7.6), 8);

/* 越界：上限夹住，下限回默认（0/负数属于损坏值，不是用户意图） */
eq('超过上限夹到上限', validInterval(99999), MAX_REFRESH_MIN);
eq('0 → 回默认（而不是夹成 1 分钟）', validInterval(0), DEFAULT_REFRESH_MIN);
eq('负数 → 回默认', validInterval(-5), DEFAULT_REFRESH_MIN);
eq('NaN → 回默认', validInterval(Number.NaN), DEFAULT_REFRESH_MIN);
eq('Infinity → 回默认', validInterval(Number.POSITIVE_INFINITY), DEFAULT_REFRESH_MIN);
eq('字符串 → 回默认', validInterval('15'), DEFAULT_REFRESH_MIN);
eq('null → 回默认', validInterval(null), DEFAULT_REFRESH_MIN);
eq('undefined → 回默认', validInterval(undefined), DEFAULT_REFRESH_MIN);

/* 无论喂什么，输出都必须是 [1,1440] 内的整数，否则 setInterval 会退化 */
ok(
  '输出恒为合法整数分钟',
  [0, -1, 0.4, 1.5, 7, 59.9, 1440, 1e9, Number.NaN, Number.POSITIVE_INFINITY, 'x', null, undefined]
    .map(validInterval)
    .every((n) => Number.isInteger(n) && n >= MIN_REFRESH_MIN && n <= MAX_REFRESH_MIN),
);

/*
 * 单平台独立刷新间隔的收敛（prefs.validProviderRefreshMin / resolveRefreshMin）。
 * 这是「agent 刷新时间支持独立设置」需求的核心：一张 map 里只存「显式覆盖值」，
 * 越界 / 非数字 / 非对象都丢掉该键（而不是夹回边界），缺失键 = 跟随全局。
 */
eq('空输入 → 空 map', validProviderRefreshMin(undefined), {});
eq('非对象 → 空 map', validProviderRefreshMin('x'), {});
eq('数组 → 空 map', validProviderRefreshMin([1, 2]), {});
eq('正常覆盖原样保留', validProviderRefreshMin({ chatgpt: 5, qoder: 30 }), {
  chatgpt: 5,
  qoder: 30,
});
eq('合法小数四舍五入', validProviderRefreshMin({ chatgpt: 5.6 }), { chatgpt: 6 });
eq('越界值（0）被丢弃', validProviderRefreshMin({ chatgpt: 0 }), {});
eq('越界值（99999）被丢弃', validProviderRefreshMin({ chatgpt: 99999 }), {});
eq('非数字值被丢弃', validProviderRefreshMin({ chatgpt: 'x' }), {});
eq('空字符串键被丢弃', validProviderRefreshMin({ '': 5 }), {});
eq(
  '混合好坏值只留好的',
  validProviderRefreshMin({ a: 5, b: 0, c: 'x', d: 99999, e: 60 }),
  { a: 5, e: 60 },
);

/* resolveRefreshMin：缺失覆盖 → 回落全局默认 */
const samplePrefs = {
  autoRefreshIntervalMin: 15,
  providerRefreshMin: { chatgpt: 5, qoder: 30 },
} as unknown as import('../src/features/balances/prefs').BalancesPrefs;
eq('跟随全局默认', resolveRefreshMin('claude', samplePrefs), 15);
eq('取单平台覆盖（chatgpt）', resolveRefreshMin('chatgpt', samplePrefs), 5);
eq('取单平台覆盖（qoder）', resolveRefreshMin('qoder', samplePrefs), 30);
eq('未知平台回落全局', resolveRefreshMin('unknown', samplePrefs), 15);

/*
 * 菜单栏「每平台显示哪个指标」的映射收敛（prefs.validTrayFields）。
 * localStorage 是用户可改的，坏值会让设置页的下拉匹配不到选项而显示空白 ——
 * 而空白下拉比默认值更难解释（用户会以为配置坏了）。
 */
eq('正常映射原样保留', validTrayFields({ qoder: '组织池剩余' }), { qoder: '组织池剩余' });
eq('多个平台都保留', validTrayFields({ qoder: 'a', chatgpt: 'b' }), { qoder: 'a', chatgpt: 'b' });
eq('空对象', validTrayFields({}), {});
eq('null → 空对象', validTrayFields(null), {});
eq('undefined → 空对象', validTrayFields(undefined), {});
eq('字符串 → 空对象', validTrayFields('qoder'), {});
eq('数字 → 空对象', validTrayFields(7), {});
eq('数组 → 空对象（不是「有键的对象」）', validTrayFields(['组织池剩余']), {});
eq('值不是字符串的条目被丢掉', validTrayFields({ qoder: 123, chatgpt: '本时段已用' }), {
  chatgpt: '本时段已用',
});
eq('空串值被丢掉（等同「没配置」）', validTrayFields({ qoder: '' }), {});
eq('null 值被丢掉', validTrayFields({ qoder: null }), {});
eq('对象值被丢掉', validTrayFields({ qoder: { label: 'x' } }), {});

/*
 * 菜单栏「自定义名字」的收敛（prefs.validTrayLabels）。
 *
 * 这里最关键的一条是 **trim**：用户在输入框里打一个空格再删掉，值会变成 `" "` ——
 * 它既不是空串（躲过了判空），又会在菜单栏上变成一个看不见的名字，
 * 表现为「这个平台的名字凭空消失了」。存 `" "` 还是「没有自定义名」，
 * 语义上也说不通，所以一律按「没配置」处理。
 */
eq('正常自定义名原样保留', validTrayLabels({ qoder: '主力号' }), { qoder: '主力号' });
eq('两侧空白被去掉', validTrayLabels({ qoder: '  主力号  ' }), { qoder: '主力号' });
eq('纯空白值被丢掉', validTrayLabels({ qoder: '   ' }), {});
eq('空串值被丢掉', validTrayLabels({ qoder: '' }), {});
eq('null 值被丢掉', validTrayLabels({ qoder: null }), {});
eq('数字值被丢掉', validTrayLabels({ qoder: 123 }), {});
eq('数组 → 空对象', validTrayLabels(['主力号']), {});
eq('null → 空对象', validTrayLabels(null), {});
eq('undefined → 空对象', validTrayLabels(undefined), {});
eq('空对象', validTrayLabels({}), {});

/*
 * 菜单栏「关掉图标的平台」的收敛（prefs.validTrayIconOff）。
 *
 * 存的是**关闭列表**（不在列表里 = 显示图标），所以名字自带默认值 ——
 * 比 `Record<provider, boolean>` 那种「缺省是 true 还是 false」要清楚。
 *
 * 去重是必须的：界面上的开关是「在列表里 = 关掉」，列表里有重复项时
 * 「关一次再开一次」会删掉一份、还剩一份，表现为**开关点了没反应**。
 */
eq('正常列表原样保留', validTrayIconOff(['qoder', 'trae']), ['qoder', 'trae']);
eq('重复项被去重', validTrayIconOff(['qoder', 'qoder', 'trae']), ['qoder', 'trae']);
eq('空串被丢掉', validTrayIconOff(['qoder', '', 'trae']), ['qoder', 'trae']);
eq('非字符串被丢掉', validTrayIconOff(['qoder', 7, null, 'trae']), ['qoder', 'trae']);
eq('非数组 → 空列表（= 全部显示图标）', validTrayIconOff(null), []);
eq('undefined → 空列表', validTrayIconOff(undefined), []);
eq('对象 → 空列表', validTrayIconOff({ qoder: true }), []);
eq('空数组', validTrayIconOff([]), []);

/*
 * 徽章推送平台的收敛（prefs.validPushProviders）。
 *
 * ⚠️ **空数组必须保留** —— `null` = 跟随显示中的平台，`[]` = 一个都不推，
 * 两者语义完全相反。把 `[]` 收敛成 null 会让用户「一个都不推」的意图
 * 变成「全推」，正好相反。
 */
eq('正常列表原样保留', validPushProviders(['qoder', 'trae']), ['qoder', 'trae']);
eq('重复项被去重', validPushProviders(['qoder', 'qoder', 'trae']), ['qoder', 'trae']);
eq('空串被丢掉', validPushProviders(['qoder', '', 'trae']), ['qoder', 'trae']);
eq('非字符串被丢掉', validPushProviders(['qoder', 7, null, 'trae']), ['qoder', 'trae']);
eq('空数组保留（= 一个都不推，不是 null）', validPushProviders([]), []);
eq('非数组 → null（= 跟随显示中的平台）', validPushProviders(null), null);
eq('undefined → null', validPushProviders(undefined), null);
eq('对象 → null', validPushProviders({ qoder: true }), null);
eq('字符串 → null', validPushProviders('qoder'), null);

/*
 * 菜单栏图标大小的收敛（prefs.validTrayIconScale）。
 *
 * 两步，顺序不能换：**先量化**（抹掉滑块浮点噪声）**再判越界**。
 * 越界一律**回默认值**而不是夹到边界 —— 越界值只可能来自手改 localStorage
 * 或上游 bug，夹到 0.5 等于静默写进一个用户没设过的尺寸；回默认是可见的
 * （图标跳回标准尺寸），用户一眼知道值没被接受。
 *
 * ⚠️ 默认值（1）**不再等于上限**（1.3）—— 上限特意留了头寸，
 * 好让「拉到头 = 加这个偏好之前 logo 的大小」成立（见 prefs 里的说明）。
 * 于是「调得太大」与「值损坏」现在指向不同档位，别再写成一条。
 */
eq('图标大小：默认 1', validTrayIconScale(1), 1);
eq('图标大小：0.8 原样保留', validTrayIconScale(0.8), 0.8);
eq('图标大小：下限 0.5 保留', validTrayIconScale(0.5), 0.5);
eq('图标大小：上限 1.3 保留（拉到头 = 旧 logo 大小）', validTrayIconScale(1.3), 1.3);
/* 0.499 只差浮点噪声就是合法下限 → 量化成 0.5 后落在范围内，保留 */
eq('图标大小：0.499 量化成 0.5 后保留', validTrayIconScale(0.499), 0.5);
eq('图标大小：0.49 越界 → 回默认', validTrayIconScale(0.49), 1);
eq('图标大小：0 越界 → 回默认', validTrayIconScale(0), 1);
eq('图标大小：负数越界 → 回默认', validTrayIconScale(-2), 1);
eq('图标大小：1.31 越界 → 回默认', validTrayIconScale(1.31), 1);
eq('图标大小：字符串 "0.8" 视为损坏 → 回默认', validTrayIconScale('0.8'), 1);
eq('图标大小：null → 回默认', validTrayIconScale(null), 1);
eq('图标大小：NaN → 回默认', validTrayIconScale(Number.NaN), 1);
/* 量化：滑块的浮点噪声必须被抹平，否则会污染缓存键与去重键 */
eq('图标大小：浮点噪声被量化', validTrayIconScale(0.7000000000000001), 0.7);
eq('图标大小：量化到两位小数', validTrayIconScale(0.8234), 0.82);

/* =============================================
   ====== JVM 进程看板：归类 / 格式化 / 严重度 ======
   ============================================= */
/*
 * 这里的每条断言对应的都是「在真机上复现成本极高」的场景：
 *   依赖冲突式的进程归类（IDEA 起的 Maven server 到底算谁的）、
 *   ps 的 etime 三种写法、堆占用算不出来时该显示什么。
 * 手动点界面验证要真的把服务跑到那种状态才行，不现实。
 */
import {
  CPU_DANGER_AT,
  CPU_WARN_AT,
  HEAP_DANGER_AT,
  HEAP_WARN_AT,
  /* 别名：balances/alerts 里也有 alertBody，重名会静默覆盖掉那边的断言 */
  alertBody as jvmAlertBody,
  badgeText,
  classifyProcess,
  displayName,
  formatHeap,
  formatMem,
  formatPorts,
  formatUptime,
  heapPercent,
  pickAlertTarget,
  processSummary,
  severityOf,
  severityTone,
  sortPorts,
  worstSeverity,
} from '../src/features/jvm/format';
import {
  DEFAULT_REFRESH_SEC,
  MAX_REFRESH_SEC,
  MIN_REFRESH_SEC,
  REFRESH_OPTIONS_SEC,
  shouldArmAutoScan,
  validIntervalSec,
} from '../src/features/jvm/prefs';
import type { JavaProcess } from '../src/features/jvm/types';

const proc = (over: Partial<JavaProcess> & { pid: number }): JavaProcess => ({
  mainClass: 'com.example.Main',
  jarPath: null,
  command: 'java -jar app.jar',
  ports: [],
  cpuPercent: 1,
  memMb: 100,
  uptimeSec: 60,
  heapUsedMb: null,
  heapMaxMb: null,
  jdkVersion: null,
  ...over,
});

/* ---- 归类：越具体的越靠前 ---- */
eq(
  'IDEA 起的 Maven server 归到 IDEA（用户视角：这是 IDEA 的后台进程）',
  classifyProcess({ mainClass: 'org.jetbrains.idea.maven.server.RemoteMavenServer36', command: '' }),
  'idea',
);
eq('IntelliJ 平台进程归 IDEA', classifyProcess({ mainClass: 'com.intellij.idea.Main', command: '' }), 'idea');
eq('Gradle daemon 归 Gradle', classifyProcess({ mainClass: 'org.gradle.launcher.daemon.bootstrap.GradleDaemon', command: '' }), 'gradle');
eq('Maven launcher 归 Maven', classifyProcess({ mainClass: 'org.codehaus.plexus.classworlds.launcher.Launcher', command: '' }), 'maven');
eq(
  '带 profile 参数的 jar 归 Spring Boot',
  classifyProcess({ mainClass: 'com.example.DemoApplication', command: 'java -jar demo.jar --spring.profiles.active=dev' }),
  'spring-boot',
);
eq(
  '只带 --server.port 也算 Spring Boot（启动类不一定叫 Application）',
  classifyProcess({ mainClass: 'com.example.Launcher', command: 'java -jar x.jar --server.port=8081' }),
  'spring-boot',
);
eq('surefire 归测试', classifyProcess({ mainClass: 'com.example.FooTest', command: 'java -cp surefirebooter.jar' }), 'test');
eq('认不出来归其它', classifyProcess({ mainClass: 'com.example.Main', command: 'java -jar x.jar' }), 'other');

/* ---- 显示名 ---- */
eq('jar 名剥掉版本号（发版后仍是同一个服务）', displayName(proc({ pid: 1, jarPath: '/opt/app/order-service-2.3.1.jar' })), 'order-service');
eq('SNAPSHOT 版本也剥掉', displayName(proc({ pid: 1, jarPath: '/opt/app/gateway-1.0-SNAPSHOT.jar' })), 'gateway');
eq('没有 jar 时取类名最后一段', displayName(proc({ pid: 1, mainClass: 'com.example.DemoApplication' })), 'DemoApplication');
eq('两者都没有时退回 PID', displayName(proc({ pid: 123, mainClass: '', jarPath: null })), 'PID 123');
/* 名字里带数字的不能被误剥（"service2" 不是版本号，前面没有短横线） */
eq('名字里的数字不会被误剥', displayName(proc({ pid: 1, jarPath: '/opt/app/service2.jar' })), 'service2');

/* ---- 端口 ---- */
eq('端口去重并升序', sortPorts([8080, 5005, 8080, 9000]), [5005, 8080, 9000]);
eq('端口过滤非法值', sortPorts([0, -1, Number.NaN, 8080]), [8080]);
eq('有端口时逗号分隔', formatPorts([8080, 9000]), '8080, 9000');
eq('没端口时给明确占位（空字符串看不出是「无」还是「没读到」）', formatPorts([]), '无监听端口');

/* ---- 运行时长 ---- */
eq('不到 1 分钟显示秒', formatUptime(45), '45 秒');
eq('1 分钟', formatUptime(60), '1 分钟');
eq('59 分钟', formatUptime(59 * 60), '59 分钟');
eq('整小时不带分', formatUptime(2 * 3600), '2 小时');
eq('带零头要显示分', formatUptime(2 * 3600 + 5 * 60), '2 小时 5 分');
eq('整天不带小时', formatUptime(24 * 3600), '1 天');
eq('1 天 3 小时', formatUptime(24 * 3600 + 3 * 3600), '1 天 3 小时');
eq('拿不到时是破折号而不是 0 秒', formatUptime(null), '—');
eq('负数不当真', formatUptime(-1), '—');

/* ---- 内存 / 堆 ---- */
eq('小于 1G 用 MB', formatMem(512.4), '512 MB');
eq('大于等于 1G 用 GB', formatMem(2048), '2.0 GB');
eq('拿不到是破折号', formatMem(null), '—');
eq('0 也是破折号（「没读到」和「真的 0」分不清）', formatMem(0), '—');
eq('堆：已用 / 容量', formatHeap(512, 1024), '512 / 1024 MB');
eq('堆：任一侧缺失都是破折号', formatHeap(512, null), '—');
eq('堆：容量为 0 时也是破折号（除零）', formatHeap(0, 0), '—');

/* ---- 堆占用率 ---- */
eq('堆占用百分比', heapPercent(proc({ pid: 1, heapUsedMb: 512, heapMaxMb: 1024 })), 50);
eq('容量为 0 → null（不是 NaN 也不是 0）', heapPercent(proc({ pid: 1, heapUsedMb: 0, heapMaxMb: 0 })), null);
eq('缺一侧 → null', heapPercent(proc({ pid: 1, heapUsedMb: 512, heapMaxMb: null })), null);
eq('溢出被裁剪到 100', heapPercent(proc({ pid: 1, heapUsedMb: 2000, heapMaxMb: 1024 })), 100);

/* ---- 严重度 ---- */
eq('一切正常', severityOf(proc({ pid: 1, cpuPercent: 5, heapUsedMb: 100, heapMaxMb: 1024 })), 'ok');
eq(`堆 ${HEAP_WARN_AT}% 转黄`, severityOf(proc({ pid: 1, heapUsedMb: 768, heapMaxMb: 1024 })), 'warn');
eq('堆 74% 仍是绿（边界用 >=）', severityOf(proc({ pid: 1, heapUsedMb: 757, heapMaxMb: 1024 })), 'ok');
eq(`堆 ${HEAP_DANGER_AT}% 转红`, severityOf(proc({ pid: 1, heapUsedMb: 922, heapMaxMb: 1024 })), 'danger');
eq(`CPU ${CPU_WARN_AT}% 转黄`, severityOf(proc({ pid: 1, cpuPercent: 150 })), 'warn');
eq(`CPU ${CPU_DANGER_AT}% 转红`, severityOf(proc({ pid: 1, cpuPercent: 400 })), 'danger');
eq('CPU 转红不依赖堆（堆读不到也要能变红）', severityOf(proc({ pid: 1, cpuPercent: 500, heapMaxMb: null })), 'danger');

eq('空列表没有最严重值（区分「都正常」和「没数据」）', worstSeverity([]), null);
eq('全正常是 ok', worstSeverity([proc({ pid: 1 }), proc({ pid: 2 })]), 'ok');
eq('有一个黄的整批是黄', worstSeverity([proc({ pid: 1 }), proc({ pid: 2, cpuPercent: 200 })]), 'warn');
eq('有一个红的整批是红', worstSeverity([proc({ pid: 1, cpuPercent: 200 }), proc({ pid: 2, cpuPercent: 500 })]), 'danger');

/* ---- 角标 ---- */
eq('没有进程不出角标', badgeText([]), null);
eq('有进程显示数量', badgeText([proc({ pid: 1 }), proc({ pid: 2 })]), '2');
eq('ok → info', severityTone('ok'), 'info');
eq('warn → warn', severityTone('warn'), 'warn');
eq('danger → danger', severityTone('danger'), 'danger');

/* ---- 摘要 / 告警 ---- */
eq('没进程时的摘要', processSummary([]), '没有运行中的 Java 进程');
eq('有端口的摘要', processSummary([proc({ pid: 1, ports: [8080] }), proc({ pid: 2, ports: [9000] })]), '2 个 JVM · 8080, 9000');
eq('端口跨进程去重排序', processSummary([proc({ pid: 1, ports: [9000, 8080] })]), '1 个 JVM · 8080, 9000');
eq('无端口的摘要', processSummary([proc({ pid: 1 })]), '1 个 JVM · 无监听端口');

eq('全正常时没有告警目标', pickAlertTarget([proc({ pid: 1 })]), null);
eq(
  '只推最严重的那一个（徽章屏幕窄，一次三条只会被全划掉）',
  pickAlertTarget([
    proc({ pid: 1, cpuPercent: 200 }),
    proc({ pid: 2, heapUsedMb: 950, heapMaxMb: 1024 }),
  ])?.pid,
  2,
);
eq(
  '堆到阈值时的告警正文',
  jvmAlertBody(proc({ pid: 1, jarPath: '/opt/app/order-1.0.jar', heapUsedMb: 950, heapMaxMb: 1024 })),
  'order 堆占用 93%',
);
eq(
  '堆读不到时报 CPU',
  jvmAlertBody(proc({ pid: 1, jarPath: '/opt/app/order-1.0.jar', cpuPercent: 250 })),
  'order CPU 250%',
);

/* ---- 刷新间隔（秒级） ---- */
eq('预设含 5 秒', REFRESH_OPTIONS_SEC.includes(5), true);
eq('预设含 60 秒', REFRESH_OPTIONS_SEC.includes(60), true);
ok('预设严格递增', REFRESH_OPTIONS_SEC.every((v, i) => i === 0 || v > REFRESH_OPTIONS_SEC[i - 1]));
ok(
  '预设都落在合法区间内',
  REFRESH_OPTIONS_SEC.every((v) => v >= MIN_REFRESH_SEC && v <= MAX_REFRESH_SEC),
);
eq('默认值本身合法', validIntervalSec(DEFAULT_REFRESH_SEC), DEFAULT_REFRESH_SEC);
eq('3 秒（下限）', validIntervalSec(MIN_REFRESH_SEC), MIN_REFRESH_SEC);
eq('1 小时（上限）', validIntervalSec(MAX_REFRESH_SEC), MAX_REFRESH_SEC);
eq('小数四舍五入', validIntervalSec(10.6), 11);
eq('超过上限夹到上限', validIntervalSec(99999), MAX_REFRESH_SEC);
/* 下限不靠夹：0/负数属于损坏值，夹成 3 秒会变成每 3 秒 fork 一堆子进程 */
eq('0 → 回默认而不是夹成 3 秒', validIntervalSec(0), DEFAULT_REFRESH_SEC);
eq('负数 → 回默认', validIntervalSec(-5), DEFAULT_REFRESH_SEC);
eq('2.4 秒（四舍五入后仍低于下限）→ 回默认', validIntervalSec(2.4), DEFAULT_REFRESH_SEC);
eq('NaN → 回默认', validIntervalSec(Number.NaN), DEFAULT_REFRESH_SEC);
eq('Infinity → 回默认', validIntervalSec(Number.POSITIVE_INFINITY), DEFAULT_REFRESH_SEC);
eq('字符串 → 回默认', validIntervalSec('15'), DEFAULT_REFRESH_SEC);
eq('null → 回默认', validIntervalSec(null), DEFAULT_REFRESH_SEC);
ok(
  '输出恒为合法整数秒',
  [0, -1, 2.4, 3, 10, 3600, 1e9, Number.NaN, Number.POSITIVE_INFINITY, 'x', null, undefined]
    .map(validIntervalSec)
    .every((n) => Number.isInteger(n) && n >= MIN_REFRESH_SEC && n <= MAX_REFRESH_SEC),
);

/* 后台停扫：两条互相独立的否决理由，四象限逐个钉住。
   它错了不会报任何错，只会让应用在后台悄悄继续扫盘 —— 只能靠断言守。 */
eq('自动刷新开 + 在前台 → 排定时器', shouldArmAutoScan(true, false), true);
eq('自动刷新开 + 在后台 → 不排（后台停扫）', shouldArmAutoScan(true, true), false);
eq('自动刷新关 + 在前台 → 不排', shouldArmAutoScan(false, false), false);
eq('自动刷新关 + 在后台 → 不排', shouldArmAutoScan(false, true), false);
ok(
  '只要在后台就不排（与开关无关）',
  [true, false].every((auto) => shouldArmAutoScan(auto, true) === false),
);
ok(
  '回前台后是否能排，完全取决于开关',
  [true, false].every((auto) => shouldArmAutoScan(auto, false) === auto),
);

/* =============================================
   ====== Maven 助手：体积 / 清理收益 / 冲突 ======
   ============================================= */
/*
 * 「能释放多少」这类数字算错的话，用户会照着它去删仓库 ——
 * 删错了下次构建要重新下载，成本比不清理高得多。所以边界必须钉死。
 */
import {
  barWidth,
  conflictKey,
  conflictSummary,
  dupSummary,
  effectiveCount,
  formatBytes,
  indentPx,
  /* 别名：balances/format 里也有 percentOf（解析百分比字符串），重名会静默覆盖 */
  percentOf as mavenPercentOf,
  reclaimableBytes,
  totalReclaimable,
} from '../src/features/maven/format';
import type { Conflict, DepLine, DuplicateEntry, SizeEntry } from '../src/features/maven/types';

/*
 * core 层通用文本能力（跨模块共用：按后端给的区间切段、按关键词现算区间、截断）
 * 原先散在各模块的 format.ts 里，已上收到 core。
 */
import { MAX_HIGHLIGHTS, findRanges, splitByRanges, truncateStrict, truncateText } from '../src/core/text';

/*
 * Spring 服务台：纯逻辑（健康度归一 / 主端口挑选 / 展示文案）
 *
 * ⚠️ 这里**刻意用命名空间导入**，不用具名导入。
 *
 * 原因：本文件把所有模块的断言堆在一起，具名导入时**不同模块的同名导出会静默互相覆盖**，
 * 断言悄悄失效、甚至连锁都锁不住 —— 已经踩过四次：
 * balances 的 `alertBody` / `percentOf` / `worstHealth`、两个模块同名的 `formatElapsed`。
 * 而 `worstHealth` 这次更糟：spring 的实现把 balances 的覆盖了，
 * 导致 balances 的旧断言拿对象去调 `toUpperCase()` 直接崩。
 *
 * 命名空间导入从**结构上**消灭这类问题：`springFmt.xxx` 永远指不到别的模块去。
 * 新增模块请照此办理。
 */
import * as springFmt from '../src/features/spring/format';
import type { SpringApp, SpringSnapshot } from '../src/features/spring/types';

/* 片段库：纯逻辑（归一化 / 搜索筛选 / 排序 / 预览 / 时间）。同样用命名空间导入，理由见上。 */
import * as snipFmt from '../src/features/snippets/format';
import type { Snippet } from '../src/features/snippets/types';

/* ---- 字节格式化 ---- */
eq('0 → 破折号（「没读到」和「真的是 0」分不清）', formatBytes(0), '—');
eq('null → 破折号', formatBytes(null), '—');
eq('小于 1KB 直接给字节', formatBytes(512), '512 B');
eq('KB 档', formatBytes(2048), '2 KB');
eq('MB 档小于 10 保留一位', formatBytes(5 * 1024 * 1024), '5.0 MB');
eq('MB 档大于等于 10 取整', formatBytes(238 * 1024 * 1024), '238 MB');
eq('GB 档', formatBytes(3 * 1024 * 1024 * 1024), '3.00 GB');

eq('占比', mavenPercentOf(50, 200), 25);
eq('总量为 0 时是 0 而不是 NaN', mavenPercentOf(10, 0), 0);

/* ---- 清理收益 ---- */
const dup = (over: Partial<DuplicateEntry>): DuplicateEntry => ({
  group: 'com.a',
  artifact: 'x',
  versions: ['1', '2'],
  bytes: 100,
  largestBytes: 60,
  snapshotCount: 0,
  ...over,
});

eq('可释放 = 总量 - 保留的最大版本', reclaimableBytes(dup({ bytes: 910, largestBytes: 900 })), 10);
eq('不会出现负数', reclaimableBytes(dup({ bytes: 100, largestBytes: 100 })), 0);
eq(
  '按最大版本算而不是按版本数平分',
  reclaimableBytes(dup({ bytes: 910, largestBytes: 900, versions: ['1', '2'] })),
  10,
);
eq('多个包累加', totalReclaimable([dup({ bytes: 910, largestBytes: 900 }), dup({ bytes: 300, largestBytes: 100 })]), 210);
eq('空列表', totalReclaimable([]), 0);

eq('没有重复时的摘要', dupSummary([]), '没有存了多个版本的包');
ok('有重复时摘要带数量', dupSummary([dup({})]).includes('1 个包'));
ok('有重复时摘要带可释放量', dupSummary([dup({})]).includes('可释放'));

/* ---- 冲突 ---- */
const cf = (over: Partial<Conflict>): Conflict => ({
  group: 'org.a',
  artifact: 'b',
  winner: '2.0',
  losers: ['1.0'],
  ...over,
});

eq('没有冲突', conflictSummary([]), '没有版本冲突');
eq('一个包两个输家', conflictSummary([cf({ losers: ['1.0', '1.5'] })]), '1 个包存在版本冲突（共 2 个版本被仲裁掉）');
eq('坐标', conflictKey(cf({})), 'org.a:b');

/* ---- 依赖树 ---- */
const dep = (over: Partial<DepLine>): DepLine => ({
  depth: 1,
  group: 'org.a',
  artifact: 'b',
  version: '1',
  packaging: 'jar',
  scope: 'compile',
  omitReason: null,
  conflictWith: null,
  ...over,
});

eq('只数真正被引入的行', effectiveCount([dep({}), dep({ omitReason: 'conflict' }), dep({ omitReason: 'duplicate' })]), 1);
eq('没有行时是 0', effectiveCount([]), 0);

eq('深度 0 不缩进', indentPx(0), 0);
eq('每层 20px', indentPx(3), 60);
eq('负数不缩成负值', indentPx(-1), 0);

const size = (key: string, bytes: number): SizeEntry => ({ key, bytes, count: 1 });
eq('条宽按最长的一条取比例', barWidth(size('b', 250), size('a', 1000)), 25);
eq('最长的一条是满格', barWidth(size('a', 1000), size('a', 1000)), 100);
eq('没有基准时不画条', barWidth(size('a', 100), undefined), 0);

/* =============================================
   ====== core/text：按区间切段 ======
   ============================================= */
const seg = (line: string, ranges: [number, number][]) =>
  splitByRanges(line, ranges).map((s) => `${s.hit ? '[' : ''}${s.text}${s.hit ? ']' : ''}`).join('');

eq('没有命中区间 = 整行原样', seg('abcd', []), 'abcd');
eq('中间一段命中', seg('abcd', [[1, 3]]), 'a[bc]d');
eq('行首命中', seg('abcd', [[0, 2]]), '[ab]cd');
eq('行尾命中', seg('abcd', [[2, 4]]), 'ab[cd]');
eq('整行命中', seg('abc', [[0, 3]]), '[abc]');
eq('两处命中', seg('abcd', [[0, 1], [2, 3]]), '[a]b[c]d');
/* 后端是多线程并发汇总的，区间乱序是常态 —— 不排序会切出倒序的碎片 */
eq('区间乱序也能切对', seg('abcd', [[2, 3], [0, 1]]), '[a]b[c]d');
/* 重叠区间若都渲染会重复染色同一段文本 */
eq('重叠区间只算一次', seg('abcdef', [[0, 4], [2, 3]]), '[abcd]ef');
eq('完全被包含的区间跳过', seg('abcdef', [[1, 5], [2, 3], [3, 4]]), 'a[bcde]f');
/* 越界裁掉而不是抛错：一行显示不全比整个结果列表崩掉好 */
eq('右越界裁剪到行尾', seg('abc', [[1, 100]]), 'a[bc]');
eq('左越界裁剪到行首', seg('abc', [[-3, 2]]), '[ab]c');
eq('空区间被丢弃', seg('abc', [[2, 2]]), 'abc');
eq('全越界退化为原行', seg('abc', [[9, 12]]), 'abc');

/* =============================================
   ====== core/text：关键词定位 ======
   ============================================= */
eq('空查询 = 无区间', findRanges('abc', ''), []);
eq('纯空白查询 = 无区间', findRanges('abc', '   '), []);
eq('单处命中', findRanges('aXbXc', 'X'), [[1, 2], [3, 4]]);
eq('大小写不敏感', findRanges('Foo foo FOO', 'foo'), [[0, 3], [4, 7], [8, 11]]);
eq('下标落在原文上（不被大小写折叠带偏）', findRanges('İx', 'x'), [[1, 2]]);
/* 用户搜 "List<String>" 时不该被当成正则 */
eq('正则元字符按字面处理', findRanges('a(b)c', '(b)'), [[1, 4]]);
eq('正则元字符不匹配空串', findRanges('abc', '.*'), []);
eq('查不到 = 无区间', findRanges('abc', 'z'), []);
eq('中文命中', findRanges('你好世界', '世界'), [[2, 4]]);
/* 上限：不是为了省性能，是为了不让界面切出上千个 <span> */
eq('命中数被上限截断', findRanges('aaaa', 'a', 2).length, 2);
eq('上限为 0 = 不匹配', findRanges('aaaa', 'a', 0), []);
eq('默认上限是个正数', MAX_HIGHLIGHTS > 0, true);

/* =============================================
   ====== core/text：截断 ======
   ============================================= */
eq('短文本不截断', truncateText('abc', 10), 'abc');
eq('刚好等于上限不截断', truncateText('abc', 3), 'abc');
eq('超长截断并加省略号', truncateText('abcdefg', 4), 'abcd…');
eq('空串不炸', truncateText('', 4), '');

/* truncateStrict 是「归一化」用的精确截断：不加省略号，长度就是 max */
eq('精确截断不加省略号', truncateStrict('abcdefg', 4), 'abcd');
eq('精确截断长度就是上限', truncateStrict('abcdefg', 4).length, 4);
eq('精确截断不超上限时原样', truncateStrict('abc', 4), 'abc');
eq('精确截断按字符不按字节', truncateStrict('你好世界', 2), '你好');

/* =========================================================
   ====== Spring 服务台 ======
   ========================================================= */
const spApp = (over: Partial<SpringApp>): SpringApp => ({
  pid: 100,
  name: 'demo',
  mainClass: null,
  jar: null,
  ports: [],
  profiles: [],
  command: 'java -jar demo.jar',
  cpuPercent: 0,
  memMb: 0,
  uptimeSec: null,
  evidence: [],
  hint: null,
  confirmed: false,
  actuator: null,
  actuatorError: null,
  ...over,
});

/* ---- 健康度归一 ---- */
/*
 * Spring 的 status 是**开放集合**：四种内置 + 自定义 HealthIndicator 返回的值。
 * 认不出来的一律按「未知」处理 —— 把没见过的状态当正常是最危险的默认值。
 */
eq('UP 最健康', springFmt.healthRank('UP'), 3);
eq('DOWN 最糟', springFmt.healthRank('DOWN'), 0);
eq('OUT_OF_SERVICE 次糟', springFmt.healthRank('OUT_OF_SERVICE'), 1);
eq('UNKNOWN 居中', springFmt.healthRank('UNKNOWN'), 2);
eq('大小写不敏感', springFmt.healthRank('up'), 3);
eq('没探到按未知', springFmt.healthRank(null), 2);
eq('自定义状态按未知', springFmt.healthRank('WHATEVER'), 2);

eq('UP 绿', springFmt.healthTone('UP'), 'success');
eq('DOWN 红', springFmt.healthTone('DOWN'), 'error');
eq('OUT_OF_SERVICE 黄', springFmt.healthTone('OUT_OF_SERVICE'), 'warning');
eq('UNKNOWN 灰', springFmt.healthTone('UNKNOWN'), 'default');
eq('没探到灰', springFmt.healthTone(null), 'default');

eq('UP 文案', springFmt.healthLabel('UP'), '正常');
eq('DOWN 文案', springFmt.healthLabel('DOWN'), '异常');
eq('OUT_OF_SERVICE 文案', springFmt.healthLabel('OUT_OF_SERVICE'), '已停止服务');
eq('没探到文案', springFmt.healthLabel(null), '未探测');
/* 自定义状态原样显示，不硬翻译 */
eq('自定义状态原样', springFmt.healthLabel('MAINTENANCE'), 'MAINTENANCE');

/* ---- 最糟的那个 ---- */
eq('有一个 DOWN 就是 DOWN', springFmt.worstHealth(['UP', 'DOWN']), 'DOWN');
eq('全 UP 就是 UP', springFmt.worstHealth(['UP', 'UP']), 'UP');
eq('OUT_OF_SERVICE 比 UP 糟', springFmt.worstHealth(['UP', 'OUT_OF_SERVICE']), 'OUT_OF_SERVICE');
eq('空列表按未知', springFmt.worstHealth([]), 'UNKNOWN');
eq('全都没探到按未知', springFmt.worstHealth([null, null]), 'UNKNOWN');
eq('没探到的不会盖过 UP', springFmt.worstHealth(['UP', null]), 'UNKNOWN');

/* ---- 应用状态 ---- */
eq('没有 actuator 就是 null', springFmt.appStatus(spApp({})), null);
eq(
  '有 actuator 取它的 status',
  springFmt.appStatus(
    spApp({
      actuator: { baseUrl: 'http://127.0.0.1:8080', appName: null, appVersion: null, status: 'UP', components: [] },
    }),
  ),
  'UP',
);

/* ---- 计数 ---- */
eq('一个正常一个异常一个未探测', springFmt.statusCounts([
  spApp({ pid: 1, actuator: { baseUrl: 'http://127.0.0.1:1', appName: null, appVersion: null, status: 'UP', components: [] } }),
  spApp({ pid: 2, actuator: { baseUrl: 'http://127.0.0.1:2', appName: null, appVersion: null, status: 'DOWN', components: [] } }),
  spApp({ pid: 3 }),
]), { up: 1, bad: 1, unknown: 1 });
eq('空列表', springFmt.statusCounts([]), { up: 0, bad: 0, unknown: 0 });

/* ---- 端口 ---- */
eq('livereload 不是业务端口', springFmt.isNonAppPort(35729), true);
eq('调试端口不是业务端口', springFmt.isNonAppPort(5005), true);
eq('8080 是业务端口', springFmt.isNonAppPort(8080), false);

eq('从 baseUrl 取端口', springFmt.portOfBaseUrl('http://127.0.0.1:8080'), 8080);
eq('没有 baseUrl', springFmt.portOfBaseUrl(null), null);
eq('baseUrl 里没有端口', springFmt.portOfBaseUrl('http://127.0.0.1'), null);
eq('端口越界', springFmt.portOfBaseUrl('http://127.0.0.1:99999'), null);

/*
 * 一个服务同时监听 8080 与 35729 时，显示 35729 就完全错了 ——
 * 用户点开只会看到一个 livereload 的 JSON。
 */
eq('排除 livereload 后取最小业务端口', springFmt.primaryPort([35729, 8080]), 8080);
eq('全被排除时退回最小端口', springFmt.primaryPort([35729, 5005]), 5005);
eq('多个业务端口取最小的', springFmt.primaryPort([9000, 8080]), 8080);
eq('没有端口', springFmt.primaryPort([]), null);
/* 探活成功的那个端口一定是对的，优先它 */
eq(
  '优先探活成功的端口',
  springFmt.primaryPort([8080, 9000], 'http://127.0.0.1:9000'),
  9000,
);
/* 但探活端口不在监听列表里时不能凭空返回它 */
eq(
  '探活端口不在列表里就退回规则',
  springFmt.primaryPort([8080], 'http://127.0.0.1:9000'),
  8080,
);

/* ---- 运行时长 ---- */
eq('没拿到时长显示破折号', springFmt.formatUptime(null), '—');
eq('负数也显示破折号', springFmt.formatUptime(-1), '—');
eq('不到一分钟按秒', springFmt.formatUptime(59), '59 秒');
eq('整一分钟', springFmt.formatUptime(60), '1 分');
eq('不到一小时按分', springFmt.formatUptime(3599), '59 分');
eq('整一小时', springFmt.formatUptime(3600), '1 小时');
eq('一小时一分钟', springFmt.formatUptime(3660), '1 小时 1 分');
eq('一天', springFmt.formatUptime(86400), '1 天 0 小时');

/* ---- 文案 ---- */
eq('没指定 profile 显示默认', springFmt.profileText([]), '默认');
eq('单个 profile', springFmt.profileText(['dev']), 'dev');
eq('多个 profile', springFmt.profileText(['dev', 'test']), 'dev, test');

eq('证据为空就是空列表', springFmt.evidenceLines(spApp({})), []);
eq('证据加提示', springFmt.evidenceLines(spApp({ evidence: ['类路径含 spring-boot'], hint: '名字里带 spring' })), [
  '类路径含 spring-boot',
  '名字里带 spring',
]);

eq('探活确认且有特征', springFmt.detectText(spApp({ confirmed: true, evidence: ['x'] })), 'actuator 确认 · 命令行也有特征');
eq('只有探活确认', springFmt.detectText(spApp({ confirmed: true })), 'actuator 确认');
eq('只有命令行特征', springFmt.detectText(spApp({ evidence: ['x'] })), '仅命令行特征');

const spSnap = (over: Partial<SpringSnapshot>): SpringSnapshot => ({
  apps: [],
  javaProcesses: 3,
  elapsedMs: 500,
  warnings: [],
  ...over,
});
eq('没有快照就没有摘要', springFmt.summaryText(null), '');
ok('零服务时摘要带 Java 进程数', springFmt.summaryText(spSnap({})).includes('3 个 Java 进程'));
ok(
  '有服务时摘要带总数与正常数',
  springFmt.summaryText(
    spSnap({
      apps: [
        spApp({ pid: 1, actuator: { baseUrl: 'http://127.0.0.1:1', appName: null, appVersion: null, status: 'UP', components: [] } }),
        spApp({ pid: 2, actuator: { baseUrl: 'http://127.0.0.1:2', appName: null, appVersion: null, status: 'DOWN', components: [] } }),
      ],
    }),
  ).includes('2 个服务 · 1 正常 · 1 异常'),
);
ok('未探测数量会出现在摘要里', springFmt.summaryText(spSnap({ apps: [spApp({})] })).includes('1 未探测'));

eq('耗时毫秒', springFmt.formatElapsed(500), '500 ms');
eq('耗时秒', springFmt.formatElapsed(1500), '1.5 秒');

/* =============================================
   ====== 片段库 ======
   ============================================= */

/* 工厂必须声明在**使用点之前** —— esbuild 打包不报错，运行时才会 ReferenceError。
   body 默认空串：给个 'b' 之类的默认值会让「搜 b」的断言意外命中，测试自己就不干净了。 */
const sn = (over: Partial<Snippet>): Snippet => ({
  id: 'x',
  title: 't',
  body: '',
  lang: null,
  tags: [],
  pinned: false,
  createdAt: 0,
  updatedAt: 0,
  usedAt: null,
  useCount: 0,
  ...over,
});

/* ---- 归一化 ---- */

eq('标题折叠空白', snipFmt.normalizeTitle('  a \n b\tc  '), 'a b c');
eq('纯空白标题归一为空', snipFmt.normalizeTitle('  \n '), '');
eq('标题超长按字符截断', snipFmt.normalizeTitle('汉'.repeat(300)).length, snipFmt.MAX_TITLE_CHARS);

eq('标签按逗号切开', snipFmt.normalizeTags('a,b'), ['a', 'b']);
eq('标签认中文逗号', snipFmt.normalizeTags('a，b'), ['a', 'b']);
eq('标签认空格', snipFmt.normalizeTags('a b'), ['a', 'b']);
eq('标签混合分隔符', snipFmt.normalizeTags('a, b，c d'), ['a', 'b', 'c', 'd']);
eq('标签去空项', snipFmt.normalizeTags('a,,b'), ['a', 'b']);
eq('标签去重忽略大小写并保留首次写法', snipFmt.normalizeTags('SQL,sql,Sql'), ['SQL']);
eq('标签数量封顶', snipFmt.normalizeTags(Array.from({ length: 40 }, (_, i) => `t${i}`).join(',')).length, snipFmt.MAX_TAGS);
eq('单个标签超长按字符截断', snipFmt.normalizeTags('汉'.repeat(100))[0].length, snipFmt.MAX_TAG_CHARS);
eq('空标签串得到空数组', snipFmt.normalizeTags('   '), []);

eq('标签回填成输入框文案', snipFmt.tagsToInput(['a', 'b']), 'a, b');
eq('没有标签时回填空串', snipFmt.tagsToInput([]), '');

/* ---- 搜索 ---- */

eq('查询串按空白切词并小写', snipFmt.queryTokens('  A  b '), ['a', 'b']);
eq('空查询命中一切', snipFmt.matchesQuery(sn({}), ''), true);
eq('纯空白查询命中一切', snipFmt.matchesQuery(sn({}), '   '), true);
eq('命中标题', snipFmt.matchesQuery(sn({ title: '查看端口' }), '端口'), true);
eq('命中正文', snipFmt.matchesQuery(sn({ body: 'lsof -iTCP' }), 'lsof'), true);
eq('命中标签', snipFmt.matchesQuery(sn({ tags: ['maven'] }), 'maven'), true);
eq('命中语言标记', snipFmt.matchesQuery(sn({ lang: 'sql' }), 'sql'), true);
eq('大小写不敏感', snipFmt.matchesQuery(sn({ title: 'Maven' }), 'maven'), true);
/* 多词是 AND：一个词命中的是标题、另一个命中正文，这种组合在片段库里很常见 */
eq('多词分别命中不同字段', snipFmt.matchesQuery(sn({ title: 'maven', body: '版本' }), 'maven 版本'), true);
eq('多词有一个没命中就不算', snipFmt.matchesQuery(sn({ title: 'maven', body: '版本' }), 'maven 依赖'), false);
eq('查不到就不命中', snipFmt.matchesQuery(sn({ title: 'abc' }), 'zzz'), false);

const snList = [
  sn({ id: '1', title: 'a', tags: ['maven'] }),
  sn({ id: '2', title: 'b', tags: ['Maven', 'sql'] }),
  sn({ id: '3', title: 'c', tags: [] }),
];
eq('标签为 null = 不筛', snipFmt.filterSnippets(snList, '', null).length, 3);
/* 后端存的写法可能被改过大小写，比较必须忽略大小写 */
eq('按标签筛（忽略大小写）', snipFmt.filterSnippets(snList, '', 'maven').map((s) => s.id), ['1', '2']);
eq('标签 + 关键词同时生效', snipFmt.filterSnippets(snList, 'b', 'maven').map((s) => s.id), ['2']);
eq('空标签串 = 不筛', snipFmt.filterSnippets(snList, '', '  ').length, 3);

const snTagged = [
  sn({ id: '1', tags: ['maven', 'sql'] }),
  sn({ id: '2', tags: ['maven'] }),
  sn({ id: '3', tags: [] }),
];
eq('标签统计按次数倒序', snipFmt.tagCounts(snTagged), [
  { tag: 'maven', count: 2 },
  { tag: 'sql', count: 1 },
]);
/* 同一标签的大小写变体必须合并成一条，否则筛选栏里会出现两个看着一样的项 */
eq('同名词的不同大小写会合并', snipFmt.tagCounts([sn({ tags: ['A'] }), sn({ tags: ['a'] })]), [
  { tag: 'A', count: 2 },
]);
eq('没有标签就没有统计', snipFmt.tagCounts([sn({ tags: [] })]), []);

/* ---- 排序 ---- */

/* 置顶必须永远在最前，与后端 list() 同口径 —— 换个排序方式就沉下去会让人以为置顶坏了 */
eq(
  '置顶优先于更新时间',
  snipFmt.sortSnippets(
    [sn({ id: 'a', updatedAt: 100 }), sn({ id: 'b', pinned: true, updatedAt: 1 })],
    'updated',
  ).map((s) => s.id),
  ['b', 'a'],
);
eq(
  '最近更新倒序',
  snipFmt.sortSnippets([sn({ id: 'a', updatedAt: 1 }), sn({ id: 'b', updatedAt: 9 })], 'updated').map((s) => s.id),
  ['b', 'a'],
);
eq(
  '最近创建倒序',
  snipFmt.sortSnippets([sn({ id: 'a', createdAt: 1 }), sn({ id: 'b', createdAt: 9 })], 'created').map((s) => s.id),
  ['b', 'a'],
);
/* usedAt 为 null（从没用过）当 0 处理，不能排在用过的前面 */
eq(
  '最近使用倒序_没用过的垫底',
  snipFmt.sortSnippets([sn({ id: 'a', usedAt: null }), sn({ id: 'b', usedAt: 5 })], 'used').map((s) => s.id),
  ['b', 'a'],
);
eq(
  '按标题升序',
  snipFmt.sortSnippets([sn({ id: 'a', title: 'b' }), sn({ id: 'b', title: 'a' })], 'title').map((s) => s.id),
  ['b', 'a'],
);
/* 毫秒时间戳会撞车，没有 id 兜底时顺序取决于底层遍历顺序，看着像在乱跳 */
eq(
  '同时间戳按_id_定序',
  snipFmt.sortSnippets([sn({ id: 'b' }), sn({ id: 'a' })], 'updated').map((s) => s.id),
  ['a', 'b'],
);
const snUnsorted = [sn({ id: 'b' }), sn({ id: 'a' })];
snipFmt.sortSnippets(snUnsorted, 'updated');
eq('排序不改原数组', snUnsorted.map((s) => s.id), ['b', 'a']);

/* ---- 预览 ---- */

eq('空正文没有预览行', snipFmt.previewLines('').lines, []);
eq('只有空白等于空', snipFmt.previewLines('  \n\n ').lines, []);
/* 从别处粘来的片段常带前导空行，不去掉的话预览是一片空白，看着像「这条是空的」 */
eq('去掉前导空行', snipFmt.previewLines('\n\n  a\nb').lines, ['  a', 'b']);
/* 命令和配置的缩进有意义，行首空白必须留着 */
eq('保留行首缩进', snipFmt.previewLines('    indented').lines, ['    indented']);
eq('行尾空白去掉', snipFmt.previewLines('a   \nb').lines, ['a', 'b']);
eq('行数取上限', snipFmt.previewLines('a\nb\nc\nd\ne').lines.length, snipFmt.PREVIEW_LINES);
eq('超出上限时标 more', snipFmt.previewLines('a\nb\nc\nd').more, true);
eq('没超出时不标 more', snipFmt.previewLines('a\nb').more, false);
eq('超长行截断', snipFmt.previewLines('x'.repeat(500)).lines[0].length, snipFmt.PREVIEW_LINE_CHARS + 1);

eq('行数统计', snipFmt.lineCount('a\nb'), 2);
eq('结尾换行不算多一行', snipFmt.lineCount('a\nb\n'), 2);
eq('空正文 0 行', snipFmt.lineCount(''), 0);
eq('只有空白 0 行', snipFmt.lineCount('   \n  '), 0);

/* ---- 展示 ---- */

eq('没有语言标记显示文本', snipFmt.langLabel(null), '文本');
eq('纯空白语言标记也算没有', snipFmt.langLabel('   '), '文本');
eq('语言标记大写展示', snipFmt.langLabel('java'), 'JAVA');

const T0 = 1_700_000_000_000;
eq('null 时间给空串', snipFmt.formatRelative(null, T0), '');
eq('半分钟内是刚刚', snipFmt.formatRelative(T0 - 30_000, T0), '刚刚');
eq('分钟', snipFmt.formatRelative(T0 - 90_000, T0), '1 分钟前');
eq('小时', snipFmt.formatRelative(T0 - 3 * 3_600_000, T0), '3 小时前');
eq('天', snipFmt.formatRelative(T0 - 2 * 86_400_000, T0), '2 天前');
/* 未来时间（时钟回拨 / 别的机器写的时间戳）不能显示成「-3 分钟前」 */
eq('未来时间显示刚刚', snipFmt.formatRelative(T0 + 60_000, T0), '刚刚');
const farMs = Date.UTC(2026, 0, 5, 3, 0, 0);
ok('超过 7 天显示 YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(snipFmt.formatRelative(farMs, farMs + 10 * 86_400_000)));
ok('日期取的是当年当月', snipFmt.formatRelative(farMs, farMs + 10 * 86_400_000).startsWith('2026-01-'));

eq('摘要含行数与更新时间', snipFmt.summaryText(sn({ body: 'a\nb', updatedAt: T0 }), T0), '2 行 · 更新于 刚刚');
eq(
  '用过才显示次数',
  snipFmt.summaryText(sn({ body: 'a', updatedAt: T0, useCount: 3 }), T0),
  '1 行 · 更新于 刚刚 · 用过 3 次',
);

eq('没有片段时的统计文案', snipFmt.totalText(0, 0), '还没有片段');
eq('全部展示时的统计文案', snipFmt.totalText(3, 3), '共 3 条');
eq('被筛过时的统计文案', snipFmt.totalText(5, 2), '筛出 2 / 5 条');

/* ---- 体积 ---- */

/* 必须按 UTF-8 字节算：一个汉字 3 字节，用 .length 会得到 1，和落盘口径对不上 */
eq('汉字按 3 字节算', snipFmt.bodyBytes('汉'), 3);
eq('ascii 按 1 字节算', snipFmt.bodyBytes('abc'), 3);
eq('刚好等于上限不算超', snipFmt.bodyTooLarge('x'.repeat(snipFmt.MAX_BODY_BYTES)), false);
eq('超过一字节就算超', snipFmt.bodyTooLarge('x'.repeat(snipFmt.MAX_BODY_BYTES + 1)), true);
eq('体积文案', snipFmt.formatKb(1024), '1.0 KB');
eq('体积文案带一位小数', snipFmt.formatKb(1536), '1.5 KB');

/* ---- 高亮区间 ---- */

const hi = (text: string, q: string) =>
  splitByRanges(text, snipFmt.queryRanges(text, q))
    .map((s) => `${s.hit ? '[' : ''}${s.text}${s.hit ? ']' : ''}`)
    .join('');

eq('空查询不高亮', hi('abc', ''), 'abc');
/* 多词必须各自高亮：按整串找的话「maven 版本」在正文里几乎不连在一起，一处都标不出来 */
eq('多词各自高亮', hi('maven 命令', 'maven 命令'), '[maven] [命令]');
eq('高亮忽略大小写', hi('Maven', 'maven'), '[Maven]');
eq('正文里没有的词不高亮', hi('abc', 'zzz'), 'abc');

/* =============================================
   ====== 菜单栏文本（features/balances/tray.ts） ======
   ============================================= */

/* ---- 显示列宽 ---- */

/* 中文是全角，占 2 列。用 String.length 算预算会少算一半，标题就冲出预设宽度了 */
eq('ascii 每字符 1 列', balTray.displayWidth('abc'), 3);
eq('中文每字 2 列', balTray.displayWidth('余26099'), 7);
eq('中点算 1 列', balTray.displayWidth('·'), 1);
eq('中英混排逐字算', balTray.displayWidth('Qoder 余26099'), 13);

eq('没超宽就原样返回', balTray.truncateToWidth('abcdef', 10), 'abcdef');
eq('超宽按列截断并补省略号', balTray.truncateToWidth('abcdefghijkl', 5), 'abcd…');
/* 截断后总宽度必须真的不超 —— 这是「按列」而不是「按字符」的全部意义 */
eq('截断后宽度不超上限', balTray.displayWidth(balTray.truncateToWidth('中文中文中文', 5)), 5);

/* ---- 数值压缩 ---- */

eq('丢掉单位', balTray.compactValue('26099 credits'), '26099');
eq('保留百分号', balTray.compactValue('87%'), '87%');
eq('小数原样', balTray.compactValue('12.34'), '12.34');
eq('保留货币符号', balTray.compactValue('$12.34'), '$12.34');
eq('千分位原样保留', balTray.compactValue('1,234.5'), '1,234.5');
/*
 * 「额度到期」的值是 2026-10-01，正则能从里面抠出 2026 —— 必须挡掉，
 * 否则菜单栏会显示「Qoder 余2026」，看起来像额度，其实是个年份。
 */
eq('日期不算额度', balTray.compactValue('2026-10-01'), null);
eq('认不出数值就返回 null', balTray.compactValue('已用尽'), null);
eq('空值返回 null', balTray.compactValue('   '), null);

/* ---- 额度标签 ---- */

eq('已用是额度', balTray.isQuotaLabel('本时段已用'), true);
eq('剩余是额度', balTray.isQuotaLabel('组织池剩余'), true);
eq('约可用消息也算额度', balTray.isQuotaLabel('约可用消息'), true);
eq('无关标签不算额度', balTray.isQuotaLabel('团队名称'), false);

/* ---- 挑主指标 ---- */

const qoderItems = [
  { label: '组织池剩余', value: '26099 credits', sub: '全组织共享' },
  { label: '资源包已用', value: '4042 credits', sub: '本人当月' },
  { label: '额度到期', value: '2026-10-01', sub: null },
];
eq('剩余优先于已用', balTray.quotaItem(qoderItems)?.label, '组织池剩余');
/* 一个平台只出一个数：绝不把「组织池剩余」和「资源包已用」并排（两者口径不同层级） */
eq('只挑一项', balTray.quotaItem(qoderItems)?.value, '26099 credits');
/*
 * 加了「今日已用」之后，自动挑选**仍必须挑「组织池剩余」**。
 * 今日用量是辅助信息（只是个增量），它若抢了主位，菜单栏会显示「Qoder 今日93」
 * 而不是「Qoder 余23095」—— 后者才是「还能用多久」的答案，前者答的是别的问题。
 * 这条钉住的是 itemPriority 的档位：余额/剩余 > 已用/用量。
 */
const qoderItemsWithToday = [
  ...qoderItems,
  { label: '今日已用', value: '93 credits', sub: '本人当日' },
];
eq('今日已用不抢占主位', balTray.quotaItem(qoderItemsWithToday)?.label, '组织池剩余');
/* 但它仍要出现在可选列表里 —— 用户想盯「今天烧了多少」时可以手动指定 */
ok(
  '今日已用可选（用户可手动指定）',
  balTray.trayFieldOptions(qoderItemsWithToday).some((i) => i.label === '今日已用'),
);
eq('只有日期时挑不出额度', balTray.quotaItem([{ label: '额度到期', value: '2026-10-01' }]), null);
eq(
  '有剩余额度就优先它',
  balTray.quotaItem([
    { label: '本时段已用', value: '87%' },
    { label: '剩余额度', value: '12.34' },
  ])?.label,
  '剩余额度',
);
eq(
  '没有剩余就退到已用',
  balTray.quotaItem([
    { label: '本时段已用', value: '87%' },
    { label: '可用重置次数', value: '3' },
  ])?.label,
  '本时段已用',
);
eq('空指标列表挑不出', balTray.quotaItem([]), null);

/* ---- 平台短名 ---- */

eq('已登记平台用短名', balTray.providerShort('qoder', 'Qoder CN'), 'Qoder');
eq('未登记平台退回展示名', balTray.providerShort('newthing', 'New Thing'), 'New Thing');

/* ---- 按平台指定指标（设置页里每个平台那个下拉） ---- */

/*
 * 可选项只留「值能压成数值」的指标。不能压的（额度到期 2026-10-01）在菜单栏上
 * 只能显示成 2026 —— 看着像额度其实是年份，所以**选项里就不给选**，
 * 而不是让用户选完得到一个看不懂的数。
 */
eq(
  '可选项只留能压成数值的',
  balTray.trayFieldOptions(qoderItems).map((it) => it.label),
  ['组织池剩余', '资源包已用'],
);
eq(
  '日期类指标不在可选项里',
  balTray
    .trayFieldOptions([
      { label: '额度到期', value: '2026-10-01' },
      { label: '组织池剩余', value: '26099 credits' },
    ])
    .map((it) => it.label),
  ['组织池剩余'],
);
eq('没有可选项时是空数组', balTray.trayFieldOptions([{ label: '团队名称', value: 'abc' }]), []);
eq('空指标列表', balTray.trayFieldOptions([]), []);

/* 指定了就用指定的；没指定 / 传 null 都走自动挑 */
eq('指定「已用」就用已用', balTray.trayItem(qoderItems, '资源包已用')?.label, '资源包已用');
eq('不指定则自动挑剩余', balTray.trayItem(qoderItems)?.label, '组织池剩余');
eq('显式传 null 等同不指定', balTray.trayItem(qoderItems, null)?.label, '组织池剩余');

/*
 * 指定失效时必须**回落自动挑**，而不是让这个平台从菜单栏消失：
 * 菜单栏是常驻显示，一次标签文案改动就让整段不见，用户只会以为程序坏了。
 */
eq(
  '指定的标签已不存在 → 回落自动挑',
  balTray.trayItem(qoderItems, '已经改名的指标')?.label,
  '组织池剩余',
);
eq(
  '指定的指标值认不出 → 回落自动挑',
  balTray.trayItem(
    [
      { label: '组织池剩余', value: '26099 credits' },
      { label: '资源包已用', value: '已用尽' },
    ],
    '资源包已用',
  )?.label,
  '组织池剩余',
);
eq(
  '连回落项都没有时返回 null',
  balTray.trayItem([{ label: '额度到期', value: '2026-10-01' }], '额度到期'),
  null,
);
/* 指定的指标**不是**额度类也要认（用户说了算）：只要求值能压成数值 */
eq(
  '指定非额度类指标也生效',
  balTray.trayItem(
    [
      { label: '组织池剩余', value: '26099 credits' },
      { label: '请求次数', value: '1,234' },
    ],
    '请求次数',
  )?.value,
  '1,234',
);

/* ---- 名字：内置短名 + 用户自定义 ---- */

eq('没自定义名时用内置短名', balTray.providerLabel('qoder', 'Qoder CN'), 'Qoder');
eq('未登记平台退回展示名', balTray.providerLabel('newthing', 'New Thing'), 'New Thing');
eq('自定义名优先于内置短名', balTray.providerLabel('qoder', 'Qoder CN', '主力号'), '主力号');
eq('自定义名两侧空白会被去掉', balTray.providerLabel('qoder', 'Qoder CN', '  主力号  '), '主力号');
/*
 * 空白值一律当「没自定义」—— 与 prefs.validTrayLabels 的收敛口径一致。
 * 不这么做的话，用户在输入框里打一个空格再删掉，那一格的名字就变成一个
 * 看不见的空格（表现为「名字凭空消失」）。
 */
eq('纯空白当没自定义', balTray.providerLabel('qoder', 'Qoder CN', '   '), 'Qoder');
eq('空串当没自定义', balTray.providerLabel('qoder', 'Qoder CN', ''), 'Qoder');
eq('null 当没自定义', balTray.providerLabel('qoder', 'Qoder CN', null), 'Qoder');

/* ---- 图标字形 ---- */

eq('内置字形', balTray.glyphOf('qoder'), 'Q');
eq('未登记平台退回 id 首字母并大写', balTray.glyphOf('newthing'), 'N');
eq('自定义名时字形跟着名字走', balTray.glyphOf('qoder', '主力号'), '主');
eq('自定义名首字母小写转大写', balTray.glyphOf('qoder', 'alpha'), 'A');
eq('空白自定义名退回内置字形', balTray.glyphOf('qoder', '   '), 'Q');
eq('空串自定义名退回内置字形', balTray.glyphOf('qoder', ''), 'Q');
/*
 * 转大写**可能变成多个码点**（德文 ß → SS）。画布只按单个字形居中，
 * 返回两个字符的话会被裁掉一半 —— 所以取首码点。
 */
eq('转大写后变多码点时只取首码点', balTray.glyphOf('qoder', 'ßeta'), 'S');

/* ---- 每平台一格 ---- */

const qoderSrc = { provider: 'qoder', name: 'Qoder CN', items: qoderItems };
const gptSrc = {
  provider: 'chatgpt',
  name: 'ChatGPT',
  items: [{ label: '本时段已用', value: '87%', sub: '重置 3h' }],
};
/* 默认配置：不改名、都显示图标 */
const PLAIN = { labels: {}, iconOff: [] };

const plainItems = balTray.buildTrayItems([qoderSrc, gptSrc], PLAIN);
eq('每个平台各一格', plainItems.length, 2);
eq('格子的 key 是 provider id（后端用它拼状态项 id）', plainItems.map((it) => it.key), [
  'qoder',
  'chatgpt',
]);
/* 图标开着时平台由图标认，文字只放数值 —— 菜单栏每一列都很贵 */
eq('图标开着时文字只放数值', plainItems.map((it) => it.title), ['余26099', '用87%']);
eq('图标开着时带字形', plainItems.map((it) => it.glyph), ['Q', 'C']);
eq('顺序与入参一致（与面板卡片同序）', plainItems.map((it) => it.key), ['qoder', 'chatgpt']);

/* ---- ChatGPT 满额度时菜单栏改显「重置时间」 ---- */

/*
 * ChatGPT 5 小时额度（本时段已用）用满 100% 时，菜单栏改显「重置时间」，
 * 不再显示 100%（见 tray.usageFullReset）：满额度本身已无信息量，
 * 用户此刻想知道的是「什么时候能再用」。
 */
const gptFullSrc = {
  provider: 'chatgpt',
  name: 'ChatGPT',
  items: [{ label: '本时段已用', value: '100%', sub: '重置 09-28 14:30' }],
};
const gptFullItems = balTray.buildTrayItems([gptFullSrc], PLAIN);
eq('满额度时菜单栏改显重置时间', gptFullItems[0].title, '重置09-28 14:30');
eq('满额度时图标仍保留', gptFullItems[0].glyph, 'C');
ok(
  '满额度时悬停提示仍含完整信息（100% 与重置时间都在）',
  gptFullItems[0].tooltip.includes('本时段已用 100%（重置 09-28 14:30）'),
);
/* 关掉图标时同样改显重置时间；名字因预算不够被截短（值永远不截，见 composeTitle） */
eq(
  '满额度且关图标时显示重置时间、名字被截短',
  balTray.buildTrayItems([gptFullSrc], { labels: {}, iconOff: ['chatgpt'] })[0].title,
  'C… 重置09-28 14:30',
);
/* 「已达上限」写法（已达上限 · 重置 …）同样识别 */
eq(
  '已达上限写法也改显重置时间',
  balTray.buildTrayItems(
    [
      {
        provider: 'chatgpt',
        name: 'ChatGPT',
        items: [{ label: '本时段已用', value: '100%', sub: '已达上限 · 重置 09-28 14:30' }],
      },
    ],
    PLAIN,
  )[0].title,
  '重置09-28 14:30',
);
/* 没给重置时间就不强行改写（回落显示 100%） */
eq(
  '没给重置时间时回落显示 100%',
  balTray.buildTrayItems(
    [{ provider: 'chatgpt', name: 'ChatGPT', items: [{ label: '本时段已用', value: '100%' }] }],
    PLAIN,
  )[0].title,
  '用100%',
);

/*
 * 周额度（本周已用）用满 100% 时同理：菜单栏改显「周的更新时间」。
 * usageFullReset 对 session / weekly 通用，这里的 sub 就是本周的重置时间，
 * 显示出来正是用户要的「周的更新时间」。
 */
const gptWeekFullSrc = {
  provider: 'chatgpt',
  name: 'ChatGPT',
  items: [{ label: '本周已用', value: '100%', sub: '重置 09-28 14:30' }],
};
eq(
  '周额度满时也改显周的更新时间',
  balTray.buildTrayItems([gptWeekFullSrc], PLAIN)[0].title,
  '重置09-28 14:30',
);
/* 用户手动指定「本周已用」为菜单栏指标、且满额度时同样生效 */
eq(
  '指定周额度且满额度也改显更新时间',
  balTray.buildTrayItems([{ ...gptWeekFullSrc, field: '本周已用' }], PLAIN)[0].title,
  '重置09-28 14:30',
);

/* ---- ChatGPT 双窗口（5h + 7d）并排 ---- */

/*
 * ChatGPT 的两个限流窗口在数据里是两条独立指标（本时段已用 / 本周已用）。
 * 菜单栏只有一行，所以合成 `5h 68% · 7d 75%`；悬停提示仍保留完整标签，
 * 「68% 是已用还是剩余」这类语义不靠猜，去提示里看。
 */
const gptBothSrc = {
  provider: 'chatgpt',
  name: 'ChatGPT PLUS',
  items: [
    { label: '本时段已用', value: '68%', sub: '重置 10-30 19:00' },
    { label: '本周已用', value: '75%', sub: '重置 11-02 14:00' },
    { label: '剩余额度', value: '984.31', sub: 'credits' },
  ],
};
const gptBoth = balTray.buildTrayItems([gptBothSrc], PLAIN)[0];
eq('双窗口合成一行（5h 在前、7d 在后）', gptBoth.title, '5h 68% · 7d 75%');
eq('双窗口时仍保留图标', gptBoth.glyph, 'C');
ok(
  '双窗口时悬停提示含两个窗口的完整标签',
  gptBoth.tooltip.includes('本时段已用 68%') && gptBoth.tooltip.includes('本周已用 75%'),
);
/* 真实数据里还有「剩余额度」等其它指标，双窗口必须优先，不能被它顶掉 */
ok('双窗口优先于 credits 等其它指标', !gptBoth.title.includes('984'));

/*
 * 缺一个窗口时的降级：**不硬贴窗口标签**，退回原有单值显示。
 * 理由：后端把「只有 primary」的套餐一律当作周窗口，单窗口时无法确认
 * 它到底是 5h 还是 7d，贴标签在部分套餐上会是错的；单值本身在提示里有完整口径。
 */
eq(
  '缺周窗口时退回单值（不硬贴 5h）',
  balTray.buildTrayItems(
    [{ provider: 'chatgpt', name: 'ChatGPT', items: [{ label: '本时段已用', value: '68%' }] }],
    PLAIN,
  )[0].title,
  '用68%',
);
eq(
  '缺时段窗口时退回单值（不硬贴 7d）',
  balTray.buildTrayItems(
    [{ provider: 'chatgpt', name: 'ChatGPT', items: [{ label: '本周已用', value: '75%' }] }],
    PLAIN,
  )[0].title,
  '用75%',
);
/*
 * 显式 field **不再压过双窗口**：两个窗口都在时仍合并。
 * 这条防回退：以前把「显式选择优先」写成了默认，结果老用户只要选过
 * 「本时段已用」，5h/7d 就永远不出现。
 */
const gptBothExplicit = balTray.buildTrayItems(
  [{ ...gptBothSrc, field: '本时段已用' }],
  PLAIN,
)[0];
eq('显式指定指标时 ChatGPT 仍合并双窗口', gptBothExplicit.title, '5h 68% · 7d 75%');
eq('显式指定指标时仍挂两行明细', gptBothExplicit.details.length, 2);
/*
 * 满额度：双窗口并列时保留百分比（把「重置时间」换成文字会让这一格
 * 膨胀到 20 列以上），重置时间仍在悬停提示里。
 */
eq(
  '双窗口满额时保留百分比',
  balTray.buildTrayItems(
    [
      {
        provider: 'chatgpt',
        name: 'ChatGPT',
        items: [
          { label: '本时段已用', value: '100%', sub: '重置 09-28 14:30' },
          { label: '本周已用', value: '75%', sub: '重置 10-02 14:30' },
        ],
      },
    ],
    PLAIN,
  )[0].title,
  '5h 100% · 7d 75%',
);
eq(
  '双窗口且关图标时补名字并按预算截短',
  balTray.buildTrayItems([gptBothSrc], { labels: {}, iconOff: ['chatgpt'] })[0].title,
  'C… 5h 68% · 7d 75%',
);

/* ---- ChatGPT 双窗口：右键菜单明细 + 耗尽态 ---- */

/*
 * `at` 是本地时间构造器（见文件前面的趋势粒度断言），所以这里断言
 * 不依赖运行机器的时区：当天重置 → HH:MM，跨天重置 → MM-DD。
 */
const TRAY_NOW = at(2026, 9, 30, 12, 0); /* 2026-10-30 12:00 本地 */
const TRAY_OPTS = { ...PLAIN, now: TRAY_NOW };
const gptResetSrc = {
  provider: 'chatgpt',
  name: 'ChatGPT PLUS',
  items: [
    { label: '本时段已用', value: '68%', resetAt: at(2026, 9, 30, 19, 0) },
    { label: '本周已用', value: '75%', resetAt: at(2026, 10, 2, 14, 0) },
  ],
};
const gptReset = balTray.buildTrayItems([gptResetSrc], TRAY_OPTS)[0];
eq('有重置时间时标题仍是单行百分比', gptReset.title, '5h 68% · 7d 75%');
eq('明细分组标题带平台名', gptReset.detailTitle, 'ChatGPT 额度');
eq('双窗口各带一条明细', gptReset.details.length, 2);
eq(
  '明细：当天重置显示 HH:MM',
  gptReset.details[0],
  '5h 已用 68% · 19:00 重置',
);
/* 跨天也必须带时分：只给 11-02 时用户判断不了「还剩几小时」 */
eq(
  '明细：跨天重置显示 MM-DD HH:MM',
  gptReset.details[1],
  '7d 已用 75% · 11-02 14:00 重置',
);

/* 5h 耗尽：标题里用重置时间替代 100%，明细写「已用尽」 */
const gpt5hFull = balTray.buildTrayItems(
  [
    {
      ...gptResetSrc,
      items: [
        { label: '本时段已用', value: '100%', resetAt: at(2026, 9, 30, 19, 0) },
        { label: '本周已用', value: '75%', resetAt: at(2026, 10, 2, 14, 0) },
      ],
    },
  ],
  TRAY_OPTS,
)[0];
eq('5h 耗尽时标题用重置时间', gpt5hFull.title, '5h 19:00 · 7d 75%');
eq(
  '5h 耗尽时明细写已用尽',
  gpt5hFull.details[0],
  '5h 已用尽 · 19:00 重置',
);
eq(
  '5h 耗尽时 7d 明细不受影响',
  gpt5hFull.details[1],
  '7d 已用 75% · 11-02 14:00 重置',
);

/* 7d 耗尽：跨天重置在标题里用 MM-DD HH:MM */
const gpt7dFull = balTray.buildTrayItems(
  [
    {
      ...gptResetSrc,
      items: [
        { label: '本时段已用', value: '68%', resetAt: at(2026, 9, 30, 19, 0) },
        { label: '本周已用', value: '100%', resetAt: at(2026, 10, 2, 14, 0) },
      ],
    },
  ],
  TRAY_OPTS,
)[0];
eq('7d 耗尽时标题用重置日期 + 时分', gpt7dFull.title, '5h 68% · 7d 11-02 14:00');
eq(
  '7d 耗尽时明细写已用尽',
  gpt7dFull.details[1],
  '7d 已用尽 · 11-02 14:00 重置',
);

/* 两个窗口同时耗尽：去掉标签后的空格，避免顶爆菜单栏宽度 */
const gptBothFull = balTray.buildTrayItems(
  [
    {
      ...gptResetSrc,
      items: [
        { label: '本时段已用', value: '100%', resetAt: at(2026, 9, 30, 19, 0) },
        { label: '本周已用', value: '100%', resetAt: at(2026, 10, 2, 14, 0) },
      ],
    },
  ],
  TRAY_OPTS,
)[0];
eq('两窗口同时耗尽时压缩成最短可读形式', gptBothFull.title, '5h19:00 · 7d11-02 14:00');
eq(
  '两窗口同时耗尽时两条明细都写已用尽',
  gptBothFull.details,
  ['5h 已用尽 · 19:00 重置', '7d 已用尽 · 11-02 14:00 重置'],
);

/*
 * 单窗口回退不回归：只有一条窗口指标时仍走原有单值逻辑，
 * 不贴 5h / 7d 标签、也不挂明细；耗尽时用 resetAt 的重置时间替代 100%。
 */
const gptSingle = balTray.buildTrayItems(
  [{ provider: 'chatgpt', name: 'ChatGPT', items: [{ label: '本时段已用', value: '68%' }] }],
  TRAY_OPTS,
)[0];
eq('单窗口回退仍显示单值', gptSingle.title, '用68%');
eq('单窗口回退不挂明细', gptSingle.details, []);
eq('单窗口回退没有明细标题', gptSingle.detailTitle, null);
const gptSingleFull = balTray.buildTrayItems(
  [
    {
      provider: 'chatgpt',
      name: 'ChatGPT',
      items: [
        { label: '本时段已用', value: '100%', resetAt: at(2026, 9, 30, 19, 0) },
      ],
    },
  ],
  TRAY_OPTS,
)[0];
eq('单窗口耗尽时标题用重置时间', gptSingleFull.title, '重置19:00');
eq('单窗口耗尽仍不挂明细', gptSingleFull.details, []);

/* 其它平台完全不受影响：Qoder 没有明细，菜单保持默认两项 */
const qoderTray = balTray.buildTrayItems([qoderSrc], TRAY_OPTS)[0];
eq('Qoder 没有明细行', qoderTray.details, []);
eq('Qoder 没有明细标题', qoderTray.detailTitle, null);

/*
 * 关掉图标 → 文字**自动补上名字**。这是整个设计的枢纽：
 * 没有它，关掉图标的那一格就只剩一个数字，谁也认不出是哪个平台。
 */
const noIconItems = balTray.buildTrayItems([qoderSrc, gptSrc], {
  labels: {},
  iconOff: ['qoder'],
});
eq('关掉图标的格子补上名字', noIconItems[0].title, 'Qoder 余26099');
eq('关掉图标的格子不带字形', noIconItems[0].glyph, null);
eq('没关的格子不受影响', noIconItems[1].title, '用87%');
eq('没关的格子仍有字形', noIconItems[1].glyph, 'C');

/* 自定义名字同时作用于**文字与图标** —— 改名的同时图标就变了，不必再配一遍 */
const renamedIconOff = balTray.buildTrayItems([qoderSrc], {
  labels: { qoder: '主力号' },
  iconOff: ['qoder'],
});
eq('自定义名字进文字', renamedIconOff[0].title, '主力号 余26099');
eq(
  '自定义名字进图标字形',
  balTray.buildTrayItems([qoderSrc], { labels: { qoder: '主力号' }, iconOff: [] })[0].glyph,
  '主',
);

/* 长名字：**截名字，绝不截数值** */
const longName = balTray.buildTrayItems([qoderSrc], {
  labels: { qoder: '非常非常非常长的名字' },
  iconOff: ['qoder'],
});
ok('超宽时截的是名字', longName[0].title.includes('…'));
ok(
  '超宽时数值原样保留',
  longName[0].title.endsWith(' 余26099'),
  );
ok(
  '截断后整格宽度不超预算',
  balTray.displayWidth(longName[0].title) <= balTray.TRAY_ITEM_BUDGET_COLS,
);

/*
 * 数值本身超预算时**不截** —— 预算是用来决定名字能占多宽的，不是用来切数字的。
 * 截一个额度数字会让它读成另一个数（26099 → 2609），那是错的；
 * 一格挤一点只是难看。
 */
const hugeValue = balTray.buildTrayItems(
  [
    {
      provider: 'qoder',
      name: 'Qoder CN',
      items: [{ label: '剩余额度', value: '123456789012345678' }],
    },
  ],
  { labels: {}, iconOff: ['qoder'] },
);
eq('数值超预算时名字让位、数值原样', hugeValue[0].title, '余123456789012345678');
ok(
  '数值超预算时也不会被截出省略号',
  !hugeValue[0].title.includes('…'),
);

/* 读不到数的平台**整格不出** —— 一格只写「暂无数据」的项是纯噪音 */
eq(
  '出错的平台整格不出',
  balTray.buildTrayItems([{ ...qoderSrc, error: '未配置凭证' }, gptSrc], PLAIN).map(
    (it) => it.key,
  ),
  ['chatgpt'],
);
eq(
  '没有数据的平台整格不出',
  balTray.buildTrayItems([{ provider: 'trae', name: 'Trae', items: [] }], PLAIN),
  [],
);
/* 有指标但一个额度类都没有 → 也整格不出（宁可不显示，也不放无关文本） */
eq(
  '没有额度类指标就不出格',
  balTray.buildTrayItems(
    [{ provider: 'trae', name: 'Trae', items: [{ label: '团队名称', value: 'abc' }] }],
    PLAIN,
  ),
  [],
);
eq('一个平台都没有时是空数组', balTray.buildTrayItems([], PLAIN), []);

/* 指定字段失效时仍要出格（回落自动挑），且「余 / 用」要跟着变 */
eq(
  '指定已用指标后改用「用」',
  balTray.buildTrayItems([{ ...qoderSrc, field: '资源包已用' }], PLAIN)[0].title,
  '用4042',
);
eq(
  '指定字段失效时仍出格（回落自动挑）',
  balTray.buildTrayItems([{ ...qoderSrc, field: '不存在的指标' }], PLAIN)[0].title,
  '余26099',
);

/* ---- 悬停提示（每格只讲自己那个平台） ---- */

const qoderTip = balTray.buildTrayItems([qoderSrc], PLAIN)[0].tooltip;
ok('提示带平台展示名', qoderTip.startsWith('Qoder CN · '));
/* 压缩掉的单位与口径必须能在提示里找回来，否则「只显示一个数」就是真的丢信息 */
ok('提示保留单位', qoderTip.includes('26099 credits'));
ok('提示保留口径', qoderTip.includes('（全组织共享）'));
ok('提示保留其它指标', qoderTip.includes('资源包已用 4042 credits（本人当月）'));

/*
 * 改名之后提示里**两个名字都要有** —— 用户自定义了名字，还得能对上面板里那个平台。
 */
ok(
  '改名后提示同时写自定义名与展示名',
  balTray
    .buildTrayItems([qoderSrc], { labels: { qoder: '主力号' }, iconOff: [] })[0]
    .tooltip.startsWith('主力号（Qoder CN） · '),
);

/* 读不到数的平台虽然不出格，但它不会进到这里 —— 出格的一定有数据 */
eq(
  '出错的平台提示写明原因',
  balTray.buildTrayItemTooltip({ ...gptSrc, error: '未配置凭证' }, null),
  'ChatGPT：读取失败（未配置凭证）',
);
eq(
  '没有数据的平台提示写明暂无',
  balTray.buildTrayItemTooltip({ provider: 'trae', name: 'Trae', items: [] }, null),
  'Trae：暂无数据',
);
/*
 * 没改名时**不许**补展示名 —— 内置短名（Qoder）本来就 ≠ 展示名（Qoder CN），
 * 用「最终显示名 ≠ 展示名」当判据的话，每一格的提示都会变成
 * `Qoder（Qoder CN） · …` 这种重复噪音。
 */
eq(
  '没改名时提示里不补展示名',
  balTray.buildTrayItemTooltip(qoderSrc, null).startsWith('Qoder CN · '),
  true,
);
eq(
  '自定义名与展示名相同时也不补',
  balTray.buildTrayItemTooltip(qoderSrc, 'Qoder CN').startsWith('Qoder CN · '),
  true,
);

/* =============================================
   ====== 菜单栏图标缩放（features/balances/bitmap.ts） ======
   ============================================= */
/*
 * 「图标大小」这个设置**改坏了看不出来**：屏幕上只是小一圈，没有报错、
 * 没有异常值、诊断里一切正常，所以必须把几何关系钉成断言。这里钉五件事：
 *
 *   ① **画布尺寸不变**（36×36 进、36×36 出）—— 只缩墨迹不缩画布，
 *      Rust 侧的 `Image::new_owned(rgba, size, size)` 才不用跟着改；
 *   ② **墨迹居中**（四周留白对称，否则菜单栏上图标会偏）；
 *   ③ **裁到墨迹再缩**，与素材边距无关 —— 同一个图形摆在画布哪个角落，
 *      结果必须一模一样（整张画布等比缩做不到这一点）；
 *   ④ **面积平均，不是最近邻** —— 缩小时笔画粗细不能随方向变；
 *   ⑤ `0 / 负数 / NaN` 不许得到「全透明图」（屏幕上图标直接消失，
 *      而诊断里一切正常，是这类设置最难查的失败方式）。
 */

/** 造一张 size×size 的 alpha 图，`paint(x,y)` 给该点的不透明度 */
function makeAlpha(size: number, paint: (x: number, y: number) => number): number[] {
  const out: number[] = [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) out.push(paint(x, y));
  }
  return out;
}

/* ---------- 墨迹外接矩形（alphaInkBox） ---------- */

eq('墨迹：整张全透明 → 没有墨迹', balBitmap.alphaInkBox(makeAlpha(4, () => 0), 4), null);
eq(
  '墨迹：只有一个点 → 1×1 的框',
  balBitmap.alphaInkBox(makeAlpha(4, (x, y) => (x === 1 && y === 2 ? 255 : 0)), 4),
  { x0: 1, y0: 2, x1: 1, y1: 2 },
);
eq(
  '墨迹：框住最外圈的不透明像素',
  balBitmap.alphaInkBox(makeAlpha(4, (x, y) => (x >= 1 && x <= 2 && y >= 1 && y <= 2 ? 200 : 0)), 4),
  { x0: 1, y0: 1, x1: 2, y1: 2 },
);
/*
 * 阈值那条线：抗锯齿会在图形外围撒一圈 alpha = 1~3 的散点。
 * 若用 `> 0` 判，**一个远在天边的散点就能把框撑到整张画布**，
 * 于是图形被白白缩小一圈 —— 而素材本身肉眼看着完全正常。
 * 所以下面这两条：5 不算、9 算。
 */
eq(
  '墨迹：alpha=5 的散点不算墨迹',
  balBitmap.alphaInkBox(makeAlpha(4, (x, y) => (x === 0 && y === 0 ? 5 : 0)), 4),
  null,
);
eq(
  '墨迹：alpha=9 算墨迹',
  balBitmap.alphaInkBox(makeAlpha(4, (x, y) => (x === 0 && y === 0 ? 9 : 0)), 4),
  { x0: 0, y0: 0, x1: 0, y1: 0 },
);
eq(
  '墨迹：远处的散点不会把框撑大',
  balBitmap.alphaInkBox(
    makeAlpha(4, (x, y) => (x < 2 && y < 2 ? 200 : x === 3 && y === 3 ? 3 : 0)),
    4,
  ),
  { x0: 0, y0: 0, x1: 1, y1: 1 },
);

/* ---------- 统一口径缩放（fitAlphaToBox） ---------- */

const solid36 = makeAlpha(36, () => 255);
/* 目标墨迹 26px 就是 scale = 1 的默认档（见 bitmap.ts 的「统一口径」） */
const b26 = balBitmap.fitAlphaToBox(solid36, 36, 26, 36);
eq('缩放：画布尺寸不变（36×36 进、36×36 出）', b26.length, 36 * 36);
eq(
  '缩放：墨迹 26px 时居中（offset = (36-26)/2 = 5）',
  balBitmap.alphaInkBox(b26, 36),
  { x0: 5, y0: 5, x1: 30, y1: 30 },
);
eq(
  '缩放：拉到头（1.3 → 墨迹 34px）恰好复现旧 logo 的大小',
  balBitmap.alphaInkBox(balBitmap.fitAlphaToBox(solid36, 36, Math.round(26 * 1.3), 36), 36),
  { x0: 1, y0: 1, x1: 34, y1: 34 },
);
eq(
  '缩放：输出 alpha 仍是 0..255 的整数（IPC 要的是 Vec<u8>）',
  b26.every((v) => Number.isInteger(v) && v >= 0 && v <= 255),
  true,
);

/*
 * **面积平均，不是最近邻**。4×4 全 255、只把左上角那一个点改成 100：
 * 缩到 2×2 时输出 (0,0) 覆盖源 [0,2)×[0,2)，四个像素 100+255+255+255
 * → 865/4 = 216.25 → 216。最近邻只会给出 100 或 255，都不是 216，
 * 所以这一条能把两种实现区分开。
 *
 * 值落在下标 **5** 而不是 0：缩放结果还要居中放进画布，
 * offset = (4-2)/2 = 1 → (0+1)×4 + (0+1) = 5。写 0 会拿到「左上角之外」的透明像素。
 */
const oneDim4 = makeAlpha(4, (x, y) => (x === 0 && y === 0 ? 100 : 255));
eq('缩放：面积平均（100+255×3）/4 = 216', balBitmap.fitAlphaToBox(oneDim4, 4, 2, 4)[5], 216);
eq(
  '缩放：实心块缩一半后中心仍是实心（面积平均不衰减）',
  balBitmap.fitAlphaToBox(solid36, 36, 18, 36)[18 * 36 + 18],
  255,
);

/*
 * NaN 回归（2026-09-24 实测踩到，就是这条断言抓出来的）。
 *
 * 重采样里 `sy1` 是浮点累加出来的，本该正好落在 box 下边界时可能多出 1e-15，
 * `Math.ceil` 于是把循环多推一格 → 读到源数组之外 → `undefined * w = NaN`。
 * 后果不是「画得难看」而是**整张位图里散着 NaN**：过 IPC 的 JSON 变成 `null`，
 * Rust 侧的 `Vec<u8>` 直接反序列化失败，菜单栏一格都上不去。
 *
 * ⚠️ 判据**不能**只钉出问题的那一个尺寸（box=34 / 画布=36）—— 那种写法换个尺寸
 * 就漏了，而这类错恰恰是「只在一部分尺寸组合下出现」。所以这里**扫全部尺寸**，
 * 且用两张不同形状的源图：整块不透明（墨迹占满画布）与四周留白（像真 logo），
 * 两者的失败条件不一样。
 */
const alphaSane = (a: number[]): boolean => a.every((v) => Number.isInteger(v) && v >= 0 && v <= 255);
const inset36 = makeAlpha(36, (x, y) => (x >= 1 && x <= 34 && y >= 1 && y <= 33 ? 200 : 0));
eq(
  '缩放：所有目标尺寸都算出有限整数（NaN 回归）',
  [solid36, inset36].every((src) => {
    for (let box = 1; box <= 36; box += 1) {
      if (!alphaSane(balBitmap.fitAlphaToBox(src, 36, box, 36))) return false;
    }
    return true;
  }),
  true,
);

/*
 * ③ 的判据：**同一个图形摆在画布哪个角落，结果必须一样**。
 * 这是「裁到墨迹再缩」相对「整张画布等比缩」唯一可断言的差别 ——
 * 后者会把偏在角上的图形也缩到角上，菜单栏里就是「图标歪了」。
 */
const inkAtTopLeft = makeAlpha(8, (x, y) => (x < 2 && y < 2 ? 255 : 0));
const inkAtCenter = makeAlpha(8, (x, y) => (x >= 4 && x < 6 && y >= 4 && y < 6 ? 255 : 0));
eq(
  '缩放：墨迹在画布里的位置不影响结果（裁到墨迹再居中）',
  balBitmap.fitAlphaToBox(inkAtTopLeft, 8, 4, 8),
  balBitmap.fitAlphaToBox(inkAtCenter, 8, 4, 8),
);
eq(
  '缩放：素材墨迹比目标小也会被放大（尺寸与素材边距无关）',
  balBitmap.alphaInkBox(balBitmap.fitAlphaToBox(inkAtTopLeft, 8, 6, 8), 8),
  { x0: 1, y0: 1, x1: 6, y1: 6 },
);

/*
 * ⑤ 损坏值。**不许得到全透明图**：boxSize 若被当成「缩放到 0 像素」，
 * 屏幕上图标直接消失，而诊断里一切正常。
 * 口径与 prefs.validInterval 一致：损坏值回默认，不夹到边界
 * （默认在这里 = 「按整张画布处理」）。
 */
eq(
  '缩放：boxSize = 0 不缩（不是缩成 0 像素的空白图）',
  balBitmap.fitAlphaToBox(solid36, 36, 0, 36),
  solid36,
);
eq('缩放：boxSize 为负不缩', balBitmap.fitAlphaToBox(solid36, 36, -3, 36), solid36);
eq('缩放：boxSize 为 NaN 不缩', balBitmap.fitAlphaToBox(solid36, 36, NaN, 36), solid36);
eq(
  '缩放：boxSize 为 Infinity 不缩（Number.isFinite 挡住）',
  balBitmap.fitAlphaToBox(solid36, 36, Infinity, 36),
  solid36,
);
eq(
  '缩放：boxSize 大于画布时夹到画布边长（不能画到画布外）',
  balBitmap.fitAlphaToBox(solid36, 36, 99, 36),
  solid36,
);
eq(
  '缩放：全透明图缩放后仍全透明（不会凭空造出墨迹）',
  balBitmap.fitAlphaToBox(makeAlpha(36, () => 0), 36, 26, 36).every((v) => v === 0),
  true,
);

/* =============================================
   ====== 全局基准字号：首次运行必须是「默认」而不是「下限」 ======
   ============================================= */
/*
 * 这一节钉的是一个**真实踩过的 bug**（2026-09-23 用无头浏览器探针量到
 * `--wb-font-base = 13px` 才发现）：
 *   原实现 `clampFontSize(Number(readLS(...)))` 在首次运行时 readLS 返回 null，
 *   `Number(null)` 是 **0** → 被夹到**下限 13**。于是「新用户 / 清过缓存的人
 *   字号永远是最小号」，而把 FONT_DEFAULT_SIZE 从 15 改成 16 毫无效果 ——
 *   代码根本走不到默认值那个分支。
 *
 * 三条边界缺一不可：null（首次）、空串（清过）、非法串（手改过）。
 * 全都必须回落到 **默认值**，而不是下限。
 */
eq('字号：无记录 → 默认值（不是下限）', themeCore.parseStoredFontSize(null), themeCore.FONT_DEFAULT_SIZE);
eq('字号：空串 → 默认值', themeCore.parseStoredFontSize(''), themeCore.FONT_DEFAULT_SIZE);
eq('字号：空白串 → 默认值', themeCore.parseStoredFontSize('   '), themeCore.FONT_DEFAULT_SIZE);
eq('字号：非数字 → 默认值', themeCore.parseStoredFontSize('abc'), themeCore.FONT_DEFAULT_SIZE);
eq('字号：合法值原样采纳', themeCore.parseStoredFontSize('17'), 17);
eq('字号：超上限收敛到上限', themeCore.parseStoredFontSize('99'), themeCore.FONT_MAX_SIZE);
eq('字号：低于下限收敛到下限', themeCore.parseStoredFontSize('2'), themeCore.FONT_MIN_SIZE);
/* 默认值必须落在合法区间内，否则 clamp 会把它挪走、上面的断言就自相矛盾了 */
ok(
  '字号：默认值本身在 [min, max] 内',
  themeCore.FONT_DEFAULT_SIZE >= themeCore.FONT_MIN_SIZE &&
    themeCore.FONT_DEFAULT_SIZE <= themeCore.FONT_MAX_SIZE,
);
/*
 * 反过来把 bug 本身钉住：`Number(null)` 是 0，这正是当年误用的写法 ——
 * 若哪天有人「简化」回去，这条会提醒他 0 会被夹成下限 13。
 */
eq('字号：Number(null) 是 0（当年误用写法的根源）', Number(null), 0);
ok(
  '字号：clampFontSize(0) 会落到下限（所以绝不能直接喂 Number(null)）',
  themeCore.clampFontSize(Number(null)) === themeCore.FONT_MIN_SIZE,
);

/* =============================================
   ====== JAR 运行器 · 日志合并 / 过滤 / 展示 ======
   ============================================= */
/*
 * 这一节钉的是三类「界面上查不出来」的边界：
 *   1. 日志**合并**：模块挂载时会拉一次后端缓存，而事件流此刻也在推 ——
 *      两边必然重叠一段。不按 seq 去重，界面上就会出现整段重影，
 *      而且只在「启动时」出现，手动点很难复现。
 *   2. 上限：日志是长跑服务，没有上限内存会一直涨。
 *   3. 路径识别与拖放分流：看错一个后缀的代价是「配置没生效但服务起来了」，
 *      而这种失败不会报错。
 *
 * 「过滤」相关的断言**已不在这一节**：输出区改成复用 LogSight 的日志查看器后，
 * 关键字 / 排除词 / 正则 / 级别筛选由查看器那套纯逻辑负责；
 * 本模块自己新增的是「原始输出 → 查看器行」的适配，断言见下面 jarAdapt 那一节。
 */
const jl = (seq: number, text: string, stream = 'stdout') => ({ seq, ts: 0, stream, text }) as any;

eq('JAR：状态文案', jarFmt.statusMeta('running').label, '运行中');
eq('JAR：失败用红色调', jarFmt.statusMeta('failed').tone, 'error');
eq('JAR：已停止用灰调', jarFmt.statusMeta('stopped').tone, 'default');

eq('JAR：时长不足一分按秒', jarFmt.elapsedText(0, 45_000, 45_000), '45 秒');
eq('JAR：时长按分秒', jarFmt.elapsedText(0, 83_000, 83_000), '1 分 23 秒');
eq('JAR：时长按小时分', jarFmt.elapsedText(0, 7_500_000, 7_500_000), '2 小时 5 分');
/* 还在跑（endedAt 为 null）时算到 now —— 传的 now 必须真的被用上 */
eq('JAR：未结束时算到 now', jarFmt.elapsedText(1000, null, 61_000), '1 分 0 秒');

eq('JAR：认 jar 后缀', jarFmt.isJarPath('/a/b.jar'), true);
eq('JAR：后缀不分大小写', jarFmt.isJarPath('/a/B.JAR'), true);
eq('JAR：非 jar 不认', jarFmt.isJarPath('/a/b.zip'), false);
eq('JAR：带空格的路径两端空白不影响判定', jarFmt.isJarPath('  /a/b.jar  '), true);

/*
 * 配置文件的后缀识别：拖放要靠它把 .yml 分流到「配置文件」那一格。
 * 名字不必叫 application —— 只看后缀，用户完全可以写成 order-service-dev.yml。
 */
eq('JAR：认 yml 配置文件', jarFmt.isConfigPath('/a/application.yml'), true);
eq('JAR：认 yaml 配置文件', jarFmt.isConfigPath('/a/application.yaml'), true);
eq('JAR：认 properties 配置文件', jarFmt.isConfigPath('/a/application.properties'), true);
eq('JAR：配置文件后缀不分大小写', jarFmt.isConfigPath('/a/Application.YML'), true);
eq('JAR：任意文件名的 yml 都认', jarFmt.isConfigPath('/a/order-service-dev.yml'), true);
eq('JAR：带空格的路径两端空白不影响配置文件判定', jarFmt.isConfigPath('  /a/b.yml  '), true);
/* 两类必须互斥，否则 service.ts 的拖放分流会出现「谁先匹配」的歧义 */
eq('JAR：jar 不是配置文件', jarFmt.isConfigPath('/a/b.jar'), false);
eq('JAR：配置文件不是 jar', jarFmt.isJarPath('/a/application.yml'), false);
eq('JAR：别的后缀不算配置文件', jarFmt.isConfigPath('/a/b.json'), false);
eq('JAR：没有后缀不算配置文件', jarFmt.isConfigPath('/a/b'), false);

/*
 * 拖放分流：一次拖放可能带**多个**路径，两类要分别找、都留下。
 * 早先写成「jar 优先、命中就收工」，于是「把 jar 和它的 application.yml 一起拖进来」
 * 时配置文件被静默丢掉 —— 用户以为配置带上了，实际没有。
 */
eq('拖放分流：只拖 jar', jarFmt.pickDropTargets(['/a/b.jar']), { jar: '/a/b.jar', config: null });
eq('拖放分流：只拖配置文件', jarFmt.pickDropTargets(['/a/x.yml']), { jar: null, config: '/a/x.yml' });
eq(
  '拖放分流：jar 与配置文件一起拖，两类都要',
  jarFmt.pickDropTargets(['/a/b.jar', '/a/application.yml']),
  { jar: '/a/b.jar', config: '/a/application.yml' },
);
/* 顺序反过来结果必须一样：不能靠「谁在列表前面」决定 */
eq(
  '拖放分流：顺序反过来也一样',
  jarFmt.pickDropTargets(['/a/application.yml', '/a/b.jar']),
  { jar: '/a/b.jar', config: '/a/application.yml' },
);
/* 混着一堆无关文件时也要挑对，而不是被第一个不认的文件打断 */
eq(
  '拖放分流：无关文件不影响挑选',
  jarFmt.pickDropTargets(['/a/a.txt', '/a/b.jar', '/a/c.png', '/a/x.properties']),
  { jar: '/a/b.jar', config: '/a/x.properties' },
);
eq(
  '拖放分流：都不认时两个都是 null',
  jarFmt.pickDropTargets(['/a/readme.txt']),
  { jar: null, config: null },
);
eq('拖放分流：空列表', jarFmt.pickDropTargets([]), { jar: null, config: null });

eq('JAR：文件名', jarFmt.baseName('/opt/app/order.jar'), 'order.jar');
eq('JAR：所在目录', jarFmt.parentDirOf('/opt/app/order.jar'), '/opt/app');
eq('JAR：根目录文件没有上级目录', jarFmt.parentDirOf('/order.jar'), '');
eq('JAR：展示名去掉后缀', jarFmt.jarDisplayName('/opt/app/order-service.jar'), 'order-service');

/* 合并：重叠段只留一份，且按 seq 有序 */
eq(
  'JAR：合并重叠日志按 seq 去重',
  jarFmt.mergeLines([jl(1, 'a'), jl(2, 'b')], [jl(2, 'b'), jl(3, 'c')]).map((l) => l.seq),
  [1, 2, 3],
);
/* 后来者覆盖：同一 seq 的内容以新到的为准（后端是权威） */
eq(
  'JAR：同 seq 以后到的内容为准',
  jarFmt.mergeLines([jl(1, '旧')], [jl(1, '新')])[0].text,
  '新',
);
/* 上限：超出时丢**最旧**的，用户要看的是最新的 */
eq(
  'JAR：合并超过上限丢最旧的',
  jarFmt.mergeLines([jl(1, 'a'), jl(2, 'b'), jl(3, 'c')], [], 2).map((l) => l.seq),
  [2, 3],
);
eq('JAR：追加空批次不动原数组', jarFmt.appendLines([jl(1, 'a')], []).length, 1);

/*
 * 过滤与裁剪的断言随实现一起搬走了：输出区现在复用 LogSight 的日志查看器，
 * 关键字 / 排除词 / 正则 / 级别筛选由查看器那套纯逻辑负责（见 logAdapt.ts）。
 * 这里只留统计 —— 它仍然是本模块自己的口径（stderr 行数）。
 */
const mixed = [jl(1, 'INFO ok'), jl(2, 'boom', 'stderr'), jl(3, '已启动', 'system')];

eq('JAR：统计总行数', jarFmt.logStats(mixed).total, 3);
eq('JAR：统计错误行数', jarFmt.logStats(mixed).errors, 1);

/*
 * 下拉框里的 JDK 标签与后端 models.rs::jdk_label 是两份实现（一个 Rust 一个 TS），
 * 文案必须对得上，否则会出现「下拉框写 sdkman、运行记录写 Homebrew」。
 */
eq('JAR：JDK 标签带来源', jarFmt.jdkLabel('17.0.10', 'sdkman'), 'Java 17.0.10 · sdkman');
eq('JAR：JDK 标签 Homebrew', jarFmt.jdkLabel('21', 'brew'), 'Java 21 · Homebrew');
eq('JAR：JDK 标签 JAVA_HOME', jarFmt.jdkLabel('8', 'env'), 'Java 8 · JAVA_HOME');
eq('JAR：JDK 标签系统', jarFmt.jdkLabel('11', 'system'), 'Java 11 · 系统');
eq('JAR：版本读不出来不能留空', jarFmt.jdkLabel('', 'system'), 'Java 未知版本 · 系统');

/* ============================================================
   ====== 输出行适配：原始流 → 日志查看器行 ======
   ============================================================
 * 输出区复用 LogSight 的日志查看器，但子进程给的是**原始文本**，
 * 查看器要的是**结构化行**（级别 / 线程 / logger / 是否续行）。
 * 中间那层适配（logAdapt.ts）没有断言的话，改歪了的表现是
 * 「级别列全是 I」「堆栈不折叠」—— 界面都「能看」，肉眼极难发现。
 */

/** 造一行原始输出（ts 随 seq 递增，便于验证排序） */
const jr = (seq: number, text: string, stream = 'stdout') =>
  ({ seq, ts: 1_700_000_000_000 + seq, stream, text }) as any;

/* --- Spring Boot 的 logback 输出能解析出结构化字段 --- */
const boot = jarAdapt.adaptLine(jr(1, '2026-09-24 15:36:51.123  INFO 12345 --- [main] c.e.a.OrderService : 服务已启动'))!;
eq('适配：级别解析', boot.level, 'Info');
eq('适配：线程解析', boot.thread, 'main');
eq('适配：logger 解析', boot.logger, 'c.e.a.OrderService');
eq('适配：消息剥离前缀', boot.message, '服务已启动');
eq('适配：不是续行', boot.is_continuation, false);
/*
 * 时间戳必须取**采集时间**，不是日志里解析出来的那个：
 * 日志时间来自应用自己的时区，用户加一句 -Duser.timezone=UTC 就会整体偏 8 小时，
 * 而查看器的过滤会按时间倒序重排 —— 用日志时间排序会彻底乱掉。
 */
eq('适配：时间戳取采集时间', boot.timestamp_ms, 1_700_000_000_001);

eq(
  '适配：ERROR 级别',
  jarAdapt.adaptLine(jr(2, '2026-09-24 15:36:51.200 ERROR 12345 --- [http-nio-8080-exec-1] c.e.a.Ctrl : 炸了'))!.level,
  'Error',
);
eq(
  '适配：WARN 级别',
  jarAdapt.adaptLine(jr(3, '2026-09-24 15:36:51.300  WARN 12345 --- [main] c.e.a.Ctrl : 慢'))!.level,
  'Warn',
);
/* Boot 2.x 的 pattern 没有 %pid 段，同样要能解析 */
eq(
  '适配：无 pid 段的 Boot 2.x 输出',
  jarAdapt.adaptLine(jr(4, '2026-09-24 15:36:51.400  INFO --- [main] c.e.a.A : hi'))!.logger,
  'c.e.a.A',
);
/* pattern 里带 %X{traceId} 时，logger 前面多一段 [traceId] */
eq(
  '适配：traceId 解析',
  jarAdapt.adaptLine(jr(5, '2026-09-24 15:36:51.500  INFO 12345 --- [main] [abc123] c.e.a.A : hi'))!.trace_id,
  'abc123',
);
/* 某些 locale 下 %d 的毫秒分隔符是逗号 */
eq(
  '适配：逗号毫秒分隔符',
  jarAdapt.adaptLine(jr(6, '2026-09-24 15:36:51,600  INFO 12345 --- [main] c.e.a.A : hi'))!.level,
  'Info',
);

/* --- 解析不出来的行退化成「整行即消息」，不能因为拆不出来就把内容丢了 --- */
const banner = jarAdapt.adaptLine(jr(7, '  .   ____          _'))!;
eq('适配：非 pattern 行整行当消息', banner.message, '  .   ____          _');
eq('适配：非 pattern 行没有 logger', banner.logger, null);
/* stderr 默认算错误：这正是「只看错误」原来的语义 */
eq('适配：stderr 默认算错误', jarAdapt.adaptLine(jr(8, 'something bad', 'stderr'))!.level, 'Error');
/* 异常类名开头即使写在 stdout 也算错误 */
eq('适配：异常类名判错误', jarAdapt.adaptLine(jr(9, 'java.lang.NullPointerException: null'))!.level, 'Error');
/* 关键字优先于「按流归属」 */
eq('适配：WARN 词优先于 stderr', jarAdapt.adaptLine(jr(10, 'WARN something', 'stderr'))!.level, 'Warn');

/* --- 工作台自己写的提示：失败类要升成 Error，否则筛「只看错误」会把结论一起滤掉 --- */
eq('适配：退出码 0 是信息', jarAdapt.systemLevel('进程已结束（退出码 0）'), 'Info');
eq('适配：非零退出码是错误', jarAdapt.systemLevel('进程退出码 1'), 'Error');
eq('适配：未拿到退出码是错误', jarAdapt.systemLevel('进程异常结束（未拿到退出码）'), 'Error');
eq('适配：已启动是信息', jarAdapt.systemLevel('已启动 pid=123：java -jar /a/b.jar'), 'Info');

/* --- 堆栈续行：只认三种在 Java 堆栈里稳定出现的形状 --- */
eq('适配：tab 缩进行是续行', jarAdapt.isStackLine('\tat com.example.Foo.bar(Foo.java:42)'), true);
eq('适配：空格缩进也是续行', jarAdapt.isStackLine('    at com.example.Foo.bar(Foo.java:42)'), true);
eq('适配：... N more 是续行', jarAdapt.isStackLine('... 12 more'), true);
eq('适配：Caused by 是续行', jarAdapt.isStackLine('Caused by: java.lang.IllegalStateException'), true);
/* 异常头那一行**不是**续行：它自己有信息量，折叠后「+N 行堆栈」挂在它下面更说得通 */
eq('适配：异常头不是续行', jarAdapt.isStackLine('java.lang.NullPointerException: null'), false);
eq('适配：普通行不是续行', jarAdapt.isStackLine('Started Application in 3.2 seconds'), false);

/* --- 空行丢掉：查看器里空行会变成一条什么都没有的记录，看着像渲染 bug --- */
eq('适配：空行不进查看器', jarAdapt.adaptLine(jr(11, '   ')), null);
eq('适配：空行不占位', jarAdapt.adaptLines([jr(1, 'a'), jr(2, ''), jr(3, 'b')]).length, 2);
/* 顺序必须保持：查看器靠它把续行归到正确的上一行 */
eq('适配：顺序保持', jarAdapt.adaptLines([jr(5, 'a'), jr(6, 'b')]).map((l) => l.line_no), [5, 6]);

/* 「只看错误」的取值与级别下拉共用一份，别两处各写一遍 */
eq('适配：错误级别含致命与错误', [...jarAdapt.ERROR_LEVELS].sort(), ['Error', 'Fatal']);
ok('适配：级别下拉不含未知（本模块猜不出 Unknown）', !jarAdapt.LEVEL_OPTIONS.some((o) => o.value === 'Unknown'));

/*
 * 级别一律用**英文**。
 *
 * 为什么值得钉：日志正文里写的就是 `INFO` / `WARN` 这些 token，级别名换成中文
 * （「信息」「警告」）之后，下拉与 tooltip 就跟正文对不上，看的人得在脑子里
 * 做一次映射；而这属于「文案退化」，不报错、不影响功能，靠肉眼 review 很容易漏。
 * 同时钉住下拉标签与徽标 tooltip 是同一批串 —— 两处各写一份迟早会分叉。
 */
const levelNames = ['Fatal', 'Error', 'Warn', 'Info', 'Debug', 'Trace'] as const;
eq(
  '级别：下拉标签全是英文名',
  jarAdapt.LEVEL_OPTIONS.map((o) => o.label),
  [...levelNames],
);
ok(
  '级别：下拉里没有汉字',
  jarAdapt.LEVEL_OPTIONS.every((o) => !/[\u4e00-\u9fa5]/.test(o.label)),
);
eq(
  '级别：下拉标签与徽标 tooltip 同一批串',
  jarAdapt.LEVEL_OPTIONS.map((o) => o.label),
  levelNames.map((l) => LEVEL_TEXT[l]),
);
ok('级别：tooltip 里也没有汉字', !/[\u4e00-\u9fa5]/.test(LEVEL_TEXT.Unknown));

/* --- 适配 + 过滤串起来：这就是输出区真正走的那条链 --- */
const chain = jarAdapt.adaptLines([
  jr(1, '2026-09-24 15:36:51.100  INFO 1 --- [main] c.e.a.A : 开始'),
  jr(2, '2026-09-24 15:36:51.200 ERROR 1 --- [main] c.e.a.A : 炸了'),
  jr(3, '\tat com.example.Foo.bar(Foo.java:42)'),
  jr(4, '2026-09-24 15:36:51.300  INFO 1 --- [main] c.e.a.A : 结束'),
]);
const allRows = applyLogFilter(chain, { ...DEFAULT_SEARCH_FILTER });
/* 续行被归并进上一行，不作为独立行出现 */
eq('链路：堆栈续行归并', allRows.rows.length, 3);
eq(
  '链路：续行挂到 ERROR 那行下',
  allRows.rows.find((r) => r.line.line_no === 2)?.children.length,
  1,
);
/* ⚠️ 查看器是**倒序**的（最新在最上面）。改这里就要同步改 LogPane 里「最新在上」那句提示 */
eq('链路：倒序（最新在上）', allRows.rows.map((r) => r.line.line_no), [4, 2, 1]);
eq(
  '链路：只看错误只剩 ERROR',
  applyLogFilter(chain, { ...DEFAULT_SEARCH_FILTER, levels: ['Error'] }).rows.map((r) => r.line.line_no),
  [2],
);
/* 关键字搜的是全量（含被折叠的堆栈内容）——在堆栈里搜类名是很常见的用法 */
eq(
  '链路：关键字能搜到堆栈里的类名',
  applyLogFilter(chain, { ...DEFAULT_SEARCH_FILTER, keyword: ['Foo'] }).rows.map((r) => r.line.line_no),
  [2],
);
eq(
  '链路：排除词生效',
  applyLogFilter(chain, { ...DEFAULT_SEARCH_FILTER, keyword_exclude: ['结束'] }).rows.map((r) => r.line.line_no),
  [2, 1],
);

/* ============================================================
   ====== 参数历史：按 jar 分别记 ======
   ============================================================
 * 历史是「启动成功才记」的输入候选，写坏了的表现是
 * 「下拉里全是别的项目的参数」或「同一条重复占满所有位置」。
 */
const A = '/a/order.jar';
const B = '/a/other.jar';

eq('参数历史：坏数据当空', Object.keys(jarArgs.sanitizeHistory(null)).length, 0);

let h = jarArgs.recordArg({}, A, 'jvm', '-Xmx512m', 1000);
eq('参数历史：记一条', jarArgs.listArgs(h, A, 'jvm').length, 1);
eq('参数历史：首次次数为 1', jarArgs.listArgs(h, A, 'jvm')[0].count, 1);
/* 同一串再记一次只加次数、不新增一条，否则 8 个位置会被同一条占满 */
h = jarArgs.recordArg(h, A, 'jvm', '-Xmx512m', 2000);
eq('参数历史：同一串不重复', jarArgs.listArgs(h, A, 'jvm').length, 1);
eq('参数历史：同一串次数累加', jarArgs.listArgs(h, A, 'jvm')[0].count, 2);
eq('参数历史：同一串刷新时间', jarArgs.listArgs(h, A, 'jvm')[0].usedAt, 2000);
/* 两类互不干扰 */
h = jarArgs.recordArg(h, A, 'program', '--server.port=8081', 3000);
eq('参数历史：程序参数独立成一组', jarArgs.listArgs(h, A, 'program').length, 1);
eq('参数历史：记程序参数不动 JVM 组', jarArgs.listArgs(h, A, 'jvm').length, 1);
/* 按 jar 分开：别的 jar 拿不到这个 jar 的历史 */
eq('参数历史：别的 jar 拿不到', jarArgs.listArgs(h, B, 'jvm').length, 0);
h = jarArgs.recordArg(h, B, 'jvm', '-Xmx2g', 4000);
eq('参数历史：两个 jar 各自一份', jarArgs.listArgs(h, B, 'jvm')[0].args, '-Xmx2g');
eq('参数历史：互不串台', jarArgs.listArgs(h, A, 'jvm')[0].args, '-Xmx512m');

/* 空串不记：手打一半的空白不该进候选 */
eq('参数历史：空串不记', jarArgs.recordArg(h, A, 'jvm', '   '), h);
eq('参数历史：没有 jar 路径不记', jarArgs.recordArg(h, '', 'jvm', '-Xmx1g'), h);

/* 最近的排最前 */
h = jarArgs.recordArg(h, A, 'jvm', '-Xmx1g', 5000);
eq('参数历史：最新的在最前', jarArgs.listArgs(h, A, 'jvm').map((e) => e.args), ['-Xmx1g', '-Xmx512m']);

/* 每类上限：超出丢最旧的 */
let capped: jarArgs.ArgHistory = {};
for (let i = 0; i < jarArgs.MAX_PER_KIND + 3; i += 1) {
  capped = jarArgs.recordArg(capped, A, 'jvm', `-Xmx${i}g`, 6000 + i);
}
eq('参数历史：每类有上限', jarArgs.listArgs(capped, A, 'jvm').length, jarArgs.MAX_PER_KIND);
eq(
  '参数历史：超出时最新的仍在',
  jarArgs.listArgs(capped, A, 'jvm')[0].args,
  `-Xmx${jarArgs.MAX_PER_KIND + 2}g`,
);
ok(
  '参数历史：最旧的已被挤掉',
  !jarArgs.listArgs(capped, A, 'jvm').some((e) => e.args === '-Xmx0g'),
);

/* jar 数上限：按「最近用过」淘汰 */
let manyJars: jarArgs.ArgHistory = {};
for (let i = 0; i < jarArgs.MAX_JARS + 2; i += 1) {
  manyJars = jarArgs.recordArg(manyJars, `/a/j${i}.jar`, 'jvm', '-Xmx1g', 7000 + i);
}
eq('参数历史：jar 数有上限', Object.keys(manyJars).length, jarArgs.MAX_JARS);
ok('参数历史：最早那个 jar 被淘汰', !('/a/j0.jar' in manyJars));

/* 清除 */
const cleared = jarArgs.clearArgs(h, A, 'jvm');
eq('参数历史：清掉 JVM 组', jarArgs.listArgs(cleared, A, 'jvm').length, 0);
eq('参数历史：清 JVM 不动程序参数', jarArgs.listArgs(cleared, A, 'program').length, 1);
/* 两类都空了就把这个 jar 整个摘掉，别在存储里留空壳 */
ok('参数历史：两类都空后不留空壳', !(A in jarArgs.clearArgs(cleared, A, 'program')));
eq('参数历史：清不存在的 jar 不动原对象', jarArgs.clearArgs(h, '/a/none.jar', 'jvm'), h);

/*
 * 存储里的东西用户能改（开发者工具里一改就变），读进来必须逐层校验：
 * 一条坏数据不能让整份历史不可用，也不能让界面显示成 NaN。
 */
const dirty = jarArgs.sanitizeHistory({
  [A]: {
    jvm: [
      { args: '-Xmx512m', count: 2, usedAt: 1 },
      { args: '', count: 1, usedAt: 1 },
      { count: 1 },
      'nope',
    ],
    program: [{ args: '--a=1' }],
  },
  [B]: { jvm: 'not-an-array' },
  '': { jvm: [{ args: '-Xmx1g', count: 1, usedAt: 1 }] },
});
eq('参数历史：坏条目被丢掉', jarArgs.listArgs(dirty, A, 'jvm').map((e) => e.args), ['-Xmx512m']);
eq('参数历史：缺字段的条目补默认值', jarArgs.listArgs(dirty, A, 'program')[0].count, 1);
eq('参数历史：非数组的组当空', jarArgs.listArgs(dirty, B, 'jvm').length, 0);
ok('参数历史：空路径的项被丢掉', !('' in dirty));
/* 同一串重复出现只留一条（存储被手改过时会出现） */
const dupArgs = jarArgs.sanitizeHistory({
  [A]: {
    jvm: [
      { args: '-X', count: 1, usedAt: 1 },
      { args: '-X', count: 2, usedAt: 2 },
    ],
    program: [],
  },
});
eq('参数历史：重复串去重', jarArgs.listArgs(dupArgs, A, 'jvm').length, 1);

/*
 * 建议清单：**不能**出现替换语义的 `--spring.config.location`。
 * 那一格由上面的「配置文件」专门管；用户在这里手打一份、又在上面选一份的话，
 * 两处会互相覆盖且很难发现。想额外挂外部配置要用叠加语义的 additional-location。
 */
ok('参数建议：JVM 建议不含 spring.config.location', !jarArgs.JVM_SUGGESTIONS.some((s) => s.args.includes('spring.config.location')));
ok(
  '参数建议：程序建议不含替换语义的 location',
  !jarArgs.PROGRAM_SUGGESTIONS.some((s) => /(^|\s)--spring\.config\.location/.test(s.args)),
);
ok(
  '参数建议：程序建议里用的是叠加语义',
  jarArgs.PROGRAM_SUGGESTIONS.some((s) => s.args.includes('additional-location')),
);
eq('参数建议：按 kind 取对应清单', jarArgs.suggestionsFor('program').length, jarArgs.PROGRAM_SUGGESTIONS.length);
eq('参数建议：JVM 清单非空', jarArgs.suggestionsFor('jvm').length > 0, true);

/* store 侧：记历史会落盘、清除会把空壳摘掉 */
useJarRunnerStore.getState().recordArgs('/tmp/hist.jar', 'jvm', '-Xmx256m');
eq(
  '参数历史：store 记进状态',
  jarArgs.listArgs(useJarRunnerStore.getState().argHistory, '/tmp/hist.jar', 'jvm').length,
  1,
);
ok(
  '参数历史：store 记完会落盘',
  (globalThis.localStorage.getItem('jarrunner:arg-history') ?? '').includes('-Xmx256m'),
);
useJarRunnerStore.getState().clearArgHistory('/tmp/hist.jar', 'jvm');
ok('参数历史：store 清除后不留空壳', !('/tmp/hist.jar' in useJarRunnerStore.getState().argHistory));

/* ============================================================
   ====== jarrunner store：状态事件早于 start 返回的竞态 ======
   ============================================================
 * 这是「幽灵运行中」缺陷的**回归测试**（2026-09-24 修）。
 *
 * 缺陷：jar 一启动就退出时，后端的 `jarrunner:run-status` 事件会在
 * `ipc.start()` 的返回值**之前**到达；那时 store 的 `runs` 里还没有这条记录，
 * `ingestStatus` 里的 `runs.map()` 不会凭空建 → 这次状态更新被**静默丢弃**。
 * 而 `start` 返回的 `RunInfo` 是「刚 spawn」的死快照（后端 `runner.rs` 里
 * `status` 硬编码 `Running`），它不会自己变成「已结束」→ 界面永远停在运行中。
 *
 * 修法：`startRun` 里 `set` 完紧跟一次 `loadRuns()` 对账。
 *
 * 构造方式：**把 start 的返回值用闸门卡住**，期间把事件塞进 store ——
 * 这样时序是确定性的，不靠 sleep 抢跑（那种写法会 flaky）。
 * 敏感性：若删掉 `startRun` 里那次 `loadRuns()`，下面三条会全红。
 */

/** 造一条 RunInfo；默认是「刚启动」的样子 */
const mkRun = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'r-race-1',
  configId: '',
  name: 'race.jar',
  jarPath: '/tmp/race.jar',
  javaBin: '/jdk/bin/java',
  jdkLabel: 'Java 17 · 测试',
  command: 'java -jar /tmp/race.jar',
  workDir: '/tmp',
  status: 'running',
  pid: 4242,
  startedAt: 1000,
  endedAt: null,
  exitCode: null,
  error: null,
  ...over,
});

resetCommands();
let releaseStart: () => void = () => {};
const gate = new Promise<void>((res) => {
  releaseStart = res;
});

/* start 返回「刚 spawn」的快照，但要等闸门放行 —— 期间我们先把事件塞进去 */
setCommand('jarrunner_start', async () => {
  await gate;
  return mkRun();
});
/* 后端此刻已经知道它失败了（进程已退出），对账时会读到这个 */
setCommand('jarrunner_list_runs', () => [
  mkRun({ status: 'failed', exitCode: 3, endedAt: 2000, error: '进程退出码 3' }),
]);
setCommand('jarrunner_logs', () => []);

const pendingStart = useJarRunnerStore.getState().startRun();

/* start 还没返回 —— 现在把状态事件送进去。这正是竞态发生的那一刻 */
useJarRunnerStore.getState().ingestStatus('r-race-1', 'failed', 3, 2000, '进程退出码 3');
eq(
  '竞态前提：事件先到时 store 里还没有这条 run（更新被丢掉）',
  useJarRunnerStore.getState().runs.length,
  0,
);

releaseStart();
await pendingStart;

eq(
  '竞态修复：start 返回后对账，拿到真状态而不是「运行中」',
  useJarRunnerStore.getState().runs[0]?.status,
  'failed',
);
eq('竞态修复：退出码也补上了', useJarRunnerStore.getState().runs[0]?.exitCode, 3);
eq('竞态修复：错误文案也在', useJarRunnerStore.getState().runs[0]?.error, '进程退出码 3');
ok('竞态修复：确实去对过账（loadRuns 调过）', callCount('jarrunner_list_runs') >= 1);

/* ============================================================
   ====== jarrunner store：选配置文件只动那一格 ======
   ============================================================
 * 名字与工作目录是从 **jar** 推出来的（`pickJar` 里填）。
 * 换个配置文件不该把它们一起改掉 —— 同一份配置换环境（dev / prod）是常态，
 * 那时名字还是原来那个、工作目录也还是原来那个。
 * 这条断言防的是「顺手复用 pickJar 的逻辑」：那会把工作目录改到配置文件所在的目录去，
 * 而 jar 里若有相对路径（日志、上传目录）就会指向错的地方。
 */
/* 先清干净，免得依赖前面用例留下的 draft */
useJarRunnerStore.getState().setDraft({ id: '', name: '', jarPath: '', workDir: '', configFile: '' });

useJarRunnerStore.getState().pickJar('/opt/app/order-service.jar');
eq('选 jar 后名字从 jar 推出来', useJarRunnerStore.getState().draft.name, 'order-service');
eq('选 jar 后工作目录默认是 jar 所在目录', useJarRunnerStore.getState().draft.workDir, '/opt/app');

useJarRunnerStore.getState().pickConfigFile('/etc/conf/prod/application.yml');
eq(
  '选配置文件后填进 configFile',
  useJarRunnerStore.getState().draft.configFile,
  '/etc/conf/prod/application.yml',
);
eq('选配置文件不动名字', useJarRunnerStore.getState().draft.name, 'order-service');
eq('选配置文件不动工作目录', useJarRunnerStore.getState().draft.workDir, '/opt/app');
eq('选配置文件不动 jar 路径', useJarRunnerStore.getState().draft.jarPath, '/opt/app/order-service.jar');

/* 清掉要能真的清掉：空串会让后端不追加那条参数 */
useJarRunnerStore.getState().pickConfigFile('');
eq('配置文件可以清空', useJarRunnerStore.getState().draft.configFile, '');

/*
 * 拖放记的是「命中的东西」而不是单个路径：一次拖放可能同时带 jar 与配置文件。
 * 早先存的是「一个路径 + 一个类别」，于是「两个都拖进来」根本表达不出来。
 */
useJarRunnerStore.getState().markDropped({ jar: null, config: '/a/b.yml' });
eq('只拖配置文件时记下配置路径', useJarRunnerStore.getState().lastDropped?.config, '/a/b.yml');
eq('只拖配置文件时 jar 为空', useJarRunnerStore.getState().lastDropped?.jar, null);

useJarRunnerStore.getState().markDropped({ jar: '/a/b.jar', config: '/a/b.yml' });
eq('两类同时拖入都记下来（jar）', useJarRunnerStore.getState().lastDropped?.jar, '/a/b.jar');
eq('两类同时拖入都记下来（配置文件）', useJarRunnerStore.getState().lastDropped?.config, '/a/b.yml');

/* =============================================
   ====== Git 模块：状态 / 差异 / 历史解析 ======
   ============================================= */

/* ---- porcelain v2 -z（样例取自 git 2.50 真实输出） ---- */
const GIT_STATUS_RAW = [
  '# branch.oid 9ea6bf78afb59a4978c55a11cfd3db6d9902d7ef',
  '# branch.head main',
  '# branch.upstream origin/main',
  '# branch.ab +2 -3',
  '1 .M N... 100644 100644 100644 7dbf4175571df1a7f795f8332098f59ac6bb0a0b 7dbf4175571df1a7f795f8332098f59ac6bb0a0b a.txt',
  '2 R. N... 100644 100644 100644 587be6b4c3f93f93c489c0111bba5596147a26cb 587be6b4c3f93f93c489c0111bba5596147a26cb R100 renamed.txt',
  'my old file.txt',
  '1 M. N... 100644 100644 100644 ce013625030ba8dba906f756967f9e9ca394464a bc23c276dfade7f2b5e24415a1bcb0d172c35d87 sub/with space.txt',
  '? untracked.txt',
  'u UU N... 100644 100644 100644 100644 1111111 2222222 3333333 conflicted.txt',
].join('\0');

const GIT_STATUS_RES = gitStatus.parseStatus(GIT_STATUS_RAW);
eq('status 分支名', GIT_STATUS_RES.branch, 'main');
eq('status 非 detached', GIT_STATUS_RES.detached, false);
eq('status 上游', GIT_STATUS_RES.upstream, 'origin/main');
eq('status 领先 2', GIT_STATUS_RES.ahead, 2);
eq('status 落后 3', GIT_STATUS_RES.behind, 3);
eq('status 未暂存（a.txt 修改）', GIT_STATUS_RES.unstaged.map((f) => f.path), ['a.txt']);
eq('status 未暂存类型', GIT_STATUS_RES.unstaged[0].kind, 'modified');
eq(
  'status 已暂存（rename + 空格文件名）',
  GIT_STATUS_RES.staged.map((f) => f.path),
  ['renamed.txt', 'sub/with space.txt'],
);
eq('status rename 的原路径是独立 NUL 段', GIT_STATUS_RES.staged[0].oldPath, 'my old file.txt');
eq('status rename 类型', GIT_STATUS_RES.staged[0].kind, 'renamed');
eq('status 空格文件名完整不切坏', GIT_STATUS_RES.staged[1].path, 'sub/with space.txt');
eq('status 未跟踪', GIT_STATUS_RES.untracked.map((f) => f.path), ['untracked.txt']);
eq('status 冲突组', GIT_STATUS_RES.conflicted.map((f) => f.path), ['conflicted.txt']);
eq('status 变更总数（去重）', gitStatus.totalChanged(GIT_STATUS_RES), 5);

const GIT_DETACHED_RAW = ['# branch.oid abc', '# branch.head (detached)', '? x.txt'].join('\0');
const GIT_DETACHED_RES = gitStatus.parseStatus(GIT_DETACHED_RAW);
eq('status detached 时分支为 null', GIT_DETACHED_RES.branch, null);
eq('status detached 标记', GIT_DETACHED_RES.detached, true);

/* ---- unified diff（多 hunk / 新文件 / rename / 二进制 / 无换行标记） ---- */
const GIT_DIFF_MULTI = [
  'diff --git a/f.txt b/f.txt',
  'index 1111111..2222222 100644',
  '--- a/f.txt',
  '+++ b/f.txt',
  '@@ -1,3 +1,3 @@ 可选的上下文标题',
  ' ctx1',
  '-del1',
  '-del2',
  '+add1',
  '+add2',
  '+add3',
  ' ctx2',
  '@@ -10,2 +10,3 @@',
  ' x',
  '+y',
  '\\ No newline at end of file',
].join('\n');
const GIT_DIFF_RES = gitDiff.parseDiff(GIT_DIFF_MULTI);
eq('diff 文件数', GIT_DIFF_RES.length, 1);
eq('diff 路径取自 ---/+++', GIT_DIFF_RES[0].newPath, 'f.txt');
eq('diff hunk 数', GIT_DIFF_RES[0].hunks.length, 2);
eq('diff hunk 头行号解析', [
  GIT_DIFF_RES[0].hunks[0].oldStart,
  GIT_DIFF_RES[0].hunks[0].oldLines,
  GIT_DIFF_RES[0].hunks[0].newStart,
  GIT_DIFF_RES[0].hunks[0].newLines,
], [1, 3, 1, 3]);
eq('diff 首 hunk 行数（2 删 3 增 2 上下文）', GIT_DIFF_RES[0].hunks[0].lines.length, 7);
eq('diff 行号递增', [
  GIT_DIFF_RES[0].hunks[0].lines[0].oldNo,
  GIT_DIFF_RES[0].hunks[0].lines[0].newNo,
  GIT_DIFF_RES[0].hunks[0].lines[1].oldNo,
  GIT_DIFF_RES[0].hunks[0].lines[3].newNo,
], [1, 1, 2, 2]);
ok('diff raw 保留「无换行」标记', GIT_DIFF_RES[0].hunks[1].raw.includes('\\ No newline at end of file'));

const GIT_DIFF_NEWFILE = gitDiff.parseDiff(
  [
    'diff --git a/untracked.txt b/untracked.txt',
    'new file mode 100644',
    'index 0000000..d5a09df',
    '--- /dev/null',
    '+++ b/untracked.txt',
    '@@ -0,0 +1 @@',
    '+brand new',
  ].join('\n'),
);
eq('diff 新文件标记', GIT_DIFF_NEWFILE[0].newFile, true);
eq('diff 新文件旧路径为 null', GIT_DIFF_NEWFILE[0].oldPath, null);
eq('diff 新文件路径', GIT_DIFF_NEWFILE[0].newPath, 'untracked.txt');

const GIT_DIFF_RENAME = gitDiff.parseDiff(
  [
    'diff --git a/new-on-feature.txt b/renamed.txt',
    'similarity index 100%',
    'rename from new-on-feature.txt',
    'rename to renamed.txt',
  ].join('\n'),
);
eq('diff rename 标记', GIT_DIFF_RENAME[0].renamed, true);
eq('diff rename 路径', [GIT_DIFF_RENAME[0].oldPath, GIT_DIFF_RENAME[0].newPath], ['new-on-feature.txt', 'renamed.txt']);

const GIT_DIFF_BINARY = gitDiff.parseDiff(
  ['diff --git a/x.bin b/x.bin', 'index 111..222 100644', 'Binary files a/x.bin and b/x.bin differ'].join('\n'),
);
eq('diff 二进制标记', GIT_DIFF_BINARY[0].binary, true);

/* ---/+++ 行可能带「\t + 时间戳」字段（git diff --no-index 实测会补），必须剥掉 */
const GIT_DIFF_TAB = gitDiff.parseDiff(
  [
    'diff --git a/sub/another file.txt b/sub/another file.txt',
    '--- /dev/null\t',
    '+++ b/sub/another file.txt\t',
    '@@ -0,0 +1 @@',
    '+q',
  ].join('\n'),
);
eq('diff 剥掉 ---/+++ 行的尾随 tab', GIT_DIFF_TAB[0].newPath, 'sub/another file.txt');

/* 按块暂存的 patch：头 + 原样 hunk */
const PATCH = gitDiff.buildHunkPatch(GIT_DIFF_RES[0], GIT_DIFF_RES[0].hunks[1]);
ok('hunk patch 带 ---/+++ 头', PATCH.startsWith('--- a/f.txt\n+++ b/f.txt\n@@ -10,2 +10,3 @@'));
ok('hunk patch 保留无换行标记', PATCH.trimEnd().endsWith('\\ No newline at end of file'));
const PATCH_NEW = gitDiff.buildHunkPatch(GIT_DIFF_NEWFILE[0], GIT_DIFF_NEWFILE[0].hunks[0]);
ok('新文件 hunk patch 用 /dev/null', PATCH_NEW.startsWith('--- /dev/null\n+++ b/untracked.txt\n'));

/* ---- 双栏配对 ---- */
const SIDE_ROWS = gitSide.hunkToRows(GIT_DIFF_RES[0].hunks[0]);
eq('side 行数（1 对上下文 + 2 对修改 + 1 增）', SIDE_ROWS.length, 5);
eq('side 首行是上下文对', [SIDE_ROWS[0].left.kind, SIDE_ROWS[0].right.kind], ['ctx', 'ctx']);
eq('side del+add 配成修改行', [SIDE_ROWS[1].left.kind, SIDE_ROWS[1].right.kind], ['mod', 'mod']);
eq('side 修改行取左删右增', [SIDE_ROWS[1].left.text, SIDE_ROWS[1].right.text], ['del1', 'add1']);
eq('side 多余增行左列补空', [SIDE_ROWS[3].left.kind, SIDE_ROWS[3].right.kind], ['empty', 'add']);
eq('side 多余增行文本', SIDE_ROWS[3].right.text, 'add3');
eq('side 末行回上下文对', SIDE_ROWS[4].left.text, 'ctx2');

const SIDE_DEL_ONLY = gitSide.hunkToRows(
  gitDiff.parseDiff(['diff --git a/g.txt b/g.txt', '--- a/g.txt', '+++ b/g.txt', '@@ -1,2 +1,1 @@', '-gone', ' stay'].join('\n'))[0].hunks[0],
);
eq('side 多余删行右列补空', [SIDE_DEL_ONLY[0].left.kind, SIDE_DEL_ONLY[0].right.kind], ['del', 'empty']);

/* ---- log / 分支 ---- */
const GIT_LOG_RAW =
  '9ea6bf78afb59a4978c55a11cfd3db6d9902d7ef\x1f090b6b2878fcb083a5eb9f5f47ba3958a6ef92df 184682e4ec724607ff61dc097f78b36946097330\x1fTester\x1ft@t.io\x1f1792380875\x1fHEAD -> main\x1fmerge feature into main\x1e\n' +
  '184682e4ec724607ff61dc097f78b36946097330\x1f6336e8d368b7e3509f7d77fc6574bd586a486836\x1fTester\x1ft@t.io\x1f1792380875\x1ffeature\x1ffeature: add new file\x1e\n' +
  '090b6b2878fcb083a5eb9f5f47ba3958a6ef92df\x1f\x1fTester\x1ft@t.io\x1f1792380875\x1f\x1finit commit\x1e\n';
const GIT_LOG_RES = gitLog.parseLog(GIT_LOG_RAW);
eq('log 条数', GIT_LOG_RES.length, 3);
eq('log 合并提交的双父', GIT_LOG_RES[0].parents.length, 2);
eq('log 引用装饰', GIT_LOG_RES[0].refs, 'HEAD -> main');
eq('log subject', GIT_LOG_RES[0].subject, 'merge feature into main');
eq('log 根提交无父', GIT_LOG_RES[2].parents, []);
eq('log 短 hash', GIT_LOG_RES[0].shortHash, '9ea6bf7');
eq('log 时间是数字', GIT_LOG_RES[0].date, 1792380875);

/* 8 个字段：ref / name / hash / upstream / track / head / date / subject */
const GIT_BR_RAW =
  'refs/heads/feature\x1ffeature\x1f184682e\x1f\x1f\x1f \x1f1792380875\x1ffeature: add new file\x1e\n' +
  'refs/heads/main\x1fmain\x1f9ea6bf7\x1forigin/main\x1f[ahead 2, behind 1]\x1f*\x1f1792380875\x1fmerge feature into main\x1e\n' +
  'refs/remotes/origin/main\x1forigin/main\x1f9ea6bf7\x1f\x1f\x1f\x1f1792380800\x1fremote head\x1e\n';
const GIT_BR_RES = gitBranches.parseBranches(GIT_BR_RAW);
eq('branch 条数', GIT_BR_RES.length, 3);
eq('branch 当前分支标记', GIT_BR_RES.find((b) => b.name === 'main')?.current, true);
eq('branch 非当前分支', GIT_BR_RES.find((b) => b.name === 'feature')?.current, false);
eq('branch 远程判定', GIT_BR_RES.find((b) => b.name === 'origin/main')?.remote, true);
eq('branch 记下上游', GIT_BR_RES.find((b) => b.name === 'main')?.upstream, 'origin/main');
eq('branch 无上游时为 null', GIT_BR_RES.find((b) => b.name === 'feature')?.upstream, null);
/* 上游跟踪：本地分支才有（待推送 / 待拉取就靠它） */
eq('track：有分歧', [GIT_BR_RES.find((b) => b.name === 'main')?.ahead, GIT_BR_RES.find((b) => b.name === 'main')?.behind], [2, 1]);
eq('track：空 = 与上游同步', [GIT_BR_RES.find((b) => b.name === 'feature')?.ahead, GIT_BR_RES.find((b) => b.name === 'feature')?.behind], [0, 0]);
eq('track：远端分支没有上游', [GIT_BR_RES.find((b) => b.name === 'origin/main')?.ahead, GIT_BR_RES.find((b) => b.name === 'origin/main')?.behind], [0, 0]);
const GIT_BR_SPLIT = gitBranches.splitBranches(GIT_BR_RES);
eq('branch 本地/远程分组', [GIT_BR_SPLIT.local.length, GIT_BR_SPLIT.remote.length], [2, 1]);

/*
 * track 文案的形状（后端强制 LC_ALL=C，所以只可能是英文；但认不出时
 * **宁可 0/0 不显示，也不能把方向认反** —— 认反了「待推送」会变「待拉取」）。
 */
eq('track 只领先', gitBranches.parseTrack('[ahead 3]'), { ahead: 3, behind: 0, gone: false });
eq('track 只落后', gitBranches.parseTrack('[behind 4]'), { ahead: 0, behind: 4, gone: false });
eq('track 上游已删', gitBranches.parseTrack('[gone]').gone, true);
eq('track 认不出的形状按 0 处理（别认反方向）', gitBranches.parseTrack('[领先 2]'), { ahead: 0, behind: 0, gone: false });
eq('track 空串按 0 处理', gitBranches.parseTrack(''), { ahead: 0, behind: 0, gone: false });

/* ---- Pull 目标：只拉所选分支的远端引用 ---- */
const PT_BRS = {
  local: [
    { ref: 'refs/heads/main', name: 'main', upstream: 'origin/main' },
    { ref: 'refs/heads/localonly', name: 'localonly', upstream: null },
  ],
  remote: [{ ref: 'refs/remotes/origin/demo/blufi', name: 'origin/demo/blufi' }],
} as unknown as { local: BranchInfo[]; remote: BranchInfo[] };

const ptRes = (viewBranch: { ref: string; label: string } | null, currentUpstream: string | null) =>
  gitPullTarget.resolvePullTarget({ viewBranch, branches: PT_BRS, currentUpstream });

const PT_REMOTE = ptRes({ ref: 'refs/remotes/origin/demo/blufi', label: 'origin/demo/blufi' }, null);
eq('pull 目标：选远端分支（多级名按第一个斜杠切）—— 只刷远端引用', PT_REMOTE, {
  ok: true,
  target: { remote: 'origin', branch: 'demo/blufi', updateLocal: false },
});
const PT_LOCAL = ptRes({ ref: 'refs/heads/main', label: 'main' }, null);
eq('pull 目标：选本地分支走它的上游，且要更新本地', PT_LOCAL, {
  ok: true,
  target: { remote: 'origin', branch: 'main', updateLocal: true },
});
const PT_NO_UP = ptRes({ ref: 'refs/heads/localonly', label: 'localonly' }, 'origin/main');
eq('pull 目标：本地分支没上游就报原因，不去猜当前分支的上游', PT_NO_UP.ok, false);
const PT_HEAD_ALIAS = ptRes({ ref: 'refs/remotes/origin/HEAD', label: 'origin/HEAD' }, null);
eq('pull 目标：origin/HEAD 是别名，拒绝', PT_HEAD_ALIAS.ok, false);
const PT_FALLBACK = ptRes(null, 'origin/main');
eq('pull 目标：没选分支时用当前分支上游，也要更新本地（快进当前分支）', PT_FALLBACK, {
  ok: true,
  target: { remote: 'origin', branch: 'main', updateLocal: true },
});
eq('pull 目标：没选分支且当前也没有上游 → 拒绝', ptRes(null, null).ok, false);
eq('pull 目标：分离头指针（上游是 HEAD）→ 拒绝', ptRes(null, 'HEAD').ok, false);

/* ---- 远端「有新提交」的检测 ---- */
const RP_BRS = [
  { ref: 'refs/remotes/origin/main', shortHash: 'aaa' },
  { ref: 'refs/remotes/origin/dev', shortHash: 'bbb' },
] as unknown as BranchInfo[];
eq('peek：首次见到（无基线）不提示', gitPeek.detectUpdates({}, RP_BRS), {});
eq('peek：哈希没变不提示', gitPeek.detectUpdates({ 'refs/remotes/origin/main': 'aaa' }, RP_BRS), {});
eq('peek：哈希变了就标出来（带 from/to 供算个数）', gitPeek.detectUpdates({ 'refs/remotes/origin/main': 'old' }, RP_BRS), {
  'refs/remotes/origin/main': { from: 'old', to: 'aaa' },
});
eq('peek：确认后基线推进到当前哈希', gitPeek.ackRef({ a: 'old' }, 'b', 'new'), { a: 'old', b: 'new' });
/* node 环境没有 localStorage：读写都必须静默降级，不能抛（否则刷新流程整条断掉） */
eq('peek：无 localStorage 时读出空基线', gitPeek.loadPeek('/tmp/nope'), {});
eq('peek：无 localStorage 时写入静默失败', (() => { gitPeek.savePeek('/tmp/nope', { a: 'b' }); return 'ok'; })(), 'ok');

/* ---- 远端 → 托管平台（工具栏那枚 GitHub / GitLab 胶囊） ---- */
/* 样例照抄 `git remote -v` 的真实输出：名字与 URL 之间是**真 tab** */
const GIT_REMOTE_V = [
  'origin\tgit@github.com:acme/workbench.git (fetch)',
  'origin\tgit@github.com:acme/workbench.git (push)',
  'upstream\thttps://gitlab.com/acme/workbench.git (fetch)',
  'upstream\thttps://gitlab.com/acme/workbench.git (push)',
  '',
].join('\n');
const GIT_REMOTES = gitRemotes.parseRemotes(GIT_REMOTE_V);
eq('remote：同一远端的 fetch/push 两行只算一个', GIT_REMOTES.length, 2);
eq('remote：远端名按出现顺序', GIT_REMOTES.map((r) => r.name), ['origin', 'upstream']);
eq(
  'remote：scp 写法（git@host:path）认成 GitHub',
  [GIT_REMOTES[0].provider, GIT_REMOTES[0].host, GIT_REMOTES[0].slug],
  ['github', 'github.com', 'acme/workbench'],
);
eq('remote：https 写法认成 GitLab', GIT_REMOTES[1].provider, 'gitlab');
eq('remote：webUrl 去掉 .git 后缀', GIT_REMOTES[0].webUrl, 'https://github.com/acme/workbench');
eq('remote：没有远端时是空数组（不是错误）', gitRemotes.parseRemotes(''), []);

/* 自建实例：域名里带产品名才给品牌名，否则只报主机名 —— 认错方向会让用户点错链接 */
const GIT_SELF = gitRemotes.classifyRemote('ssh://git@gitlab.acme.internal:2222/team/sub/app.git');
eq('自建 GitLab：带端口也能拆出主机', GIT_SELF.host, 'gitlab.acme.internal');
eq('自建 GitLab：标签标明「自建」', GIT_SELF.label, 'GitLab · 自建');
eq('自建 GitLab：子组路径整段保留', GIT_SELF.slug, 'team/sub/app');
eq('认不出的主机不冒充品牌', gitRemotes.classifyRemote('git@git.acme.com:team/app.git').label, '自建 / 其它');
eq('GitHub 企业版按域名识别', gitRemotes.classifyRemote('git@github.acme.com:team/app.git').label, 'GitHub · 企业版');

/* 本地路径 / file:// 没有托管方 —— 这类「远端」不该显示成任何平台 */
eq('本地路径不算托管平台', gitRemotes.classifyRemote('/Users/me/repo').provider, 'local');
eq('file:// 也算本地', gitRemotes.classifyRemote('file:///Users/me/repo.git').provider, 'local');
eq('本地路径没有 webUrl', gitRemotes.classifyRemote('/Users/me/repo').webUrl, null);
eq('带空格的本地路径也不猜平台', gitRemotes.classifyRemote('/Users/me/My Repo').host, null);

/* 主远端：跟着当前分支上游走，其次 origin，最后第一个 */
eq('主远端：跟随当前分支上游', gitRemotes.pickPrimaryRemote(GIT_REMOTES, 'upstream/main')?.name, 'upstream');
eq('主远端：没有上游时退回 origin', gitRemotes.pickPrimaryRemote(GIT_REMOTES, null)?.name, 'origin');
eq('主远端：上游指向已不存在的远端时退回 origin', gitRemotes.pickPrimaryRemote(GIT_REMOTES, 'fork/main')?.name, 'origin');
eq('主远端：一个远端都没有时为 null', gitRemotes.pickPrimaryRemote([], 'origin/main'), null);

/* ---- 提交图 lane 布局 ---- */
/* 线性：全在 lane 0，圆点上方只在「有子提交」时才有线 */
const G_LINEAR = gitGraph.layoutGraph([
  { hash: 'c', parents: ['b'] },
  { hash: 'b', parents: ['a'] },
  { hash: 'a', parents: [] },
]);
eq('graph 线性全在 lane 0', G_LINEAR.map((r) => r.lane), [0, 0, 0]);
eq('graph 线性无贯穿线', G_LINEAR.map((r) => r.passThrough.length), [0, 0, 0]);
eq('graph 线性：首个提交行顶无来源', G_LINEAR.map((r) => r.incoming), [false, true, true]);
eq('graph 线性：根提交只连到此处', G_LINEAR[2].edges.length, 0);

/* 合并（真实 fixture 的形状：merge ← base + feature 链） */
const G_MERGE = gitGraph.layoutGraph([
  { hash: 'm', parents: ['base', 'f2'] },
  { hash: 'f2', parents: ['f1'] },
  { hash: 'f1', parents: ['base'] },
  { hash: 'base', parents: [] },
]);
eq('graph 合并点 lane', G_MERGE.map((r) => r.lane), [0, 1, 1, 0]);
eq('graph 合并：第一父直线下行 + 第二父曲线', G_MERGE[0].edges, [
  { to: 0, curve: false },
  { to: 1, curve: true },
]);
/*
 * ⚠️ 关键回归：合并行新开的那条 lane 不能出现在 passThrough 里。
 * 它这一行才第一次出现，行顶还没有它 ——
 * 一旦当贯穿线画（y=0→h），就是「凭空冒出来、超出且没有圆点」的那条线。
 */
eq('graph 合并行不产生凭空竖线（新 lane 不进 passThrough）', G_MERGE[0].passThrough, []);
eq('graph 合并行行顶无线则 incoming 为假', G_MERGE[0].incoming, false);
eq('graph 分支行贯穿线保留主线等待父提交', G_MERGE[1].passThrough, [0]);
eq('graph 支线汇合回主线', G_MERGE[2].edges, [{ to: 0, curve: true }]);
eq('graph 支线行贯穿线只在主线', G_MERGE[2].passThrough, [0]);
eq('graph 根提交只留主线且无贯穿', G_MERGE[3].passThrough, []);
eq('graph 合并提交标记', G_MERGE.map((r) => r.merge), [true, false, false, false]);
eq('graph 最大 lane 数', gitGraph.maxLanes(G_MERGE), 2);

/* 两个子提交汇合到同一父 */
const G_CONV = gitGraph.layoutGraph([
  { hash: 'c1', parents: ['p'] },
  { hash: 'c2', parents: ['p'] },
  { hash: 'p', parents: [] },
]);
eq('graph 汇合画曲线到父 lane', G_CONV[1].edges, [{ to: 0, curve: true }]);
eq('graph 第二个线头行顶无来源（它是分支尖端）', G_CONV[1].incoming, false);
eq('graph 汇合后子线终止', G_CONV[2].lane, 0);
eq('graph 汇合父提交的贯穿线已清空', G_CONV[2].passThrough, []);

/* octopus（三父合并）：每个额外父各开一条 lane，且都不进贯穿线 */
const G_OCTO = gitGraph.layoutGraph([
  { hash: 'm', parents: ['a', 'b', 'c'] },
  { hash: 'a', parents: [] },
  { hash: 'b', parents: [] },
  { hash: 'c', parents: [] },
]);
eq('graph octopus 第一父直线 + 每个额外父各开一 lane', G_OCTO[0].edges, [
  { to: 0, curve: false },
  { to: 1, curve: true },
  { to: 2, curve: true },
]);
eq('graph octopus 行顶无竖线', G_OCTO[0].passThrough, []);
eq('graph octopus 最大 lane 数', gitGraph.maxLanes(G_OCTO), 3);

/* ---- 变更目录树（Java 项目那种深路径是主要场景） ---- */
const MOD = (p: string) => ({ path: p, kind: 'modified' as const });

/* 单链压缩：src/main/java/com/ziyun/medical 这一串折成一个节点 */
const TR_CHAIN = gitTree.buildFileTree([
  MOD('src/main/java/com/ziyun/medical/controller/AmbulanceController.java'),
  MOD('src/main/java/com/ziyun/medical/model/response/AmbulanceRes.java'),
]);
eq('tree 顶层只剩一个被压缩的目录', TR_CHAIN.length, 1);
eq('tree 压缩后展示名用 / 连接', TR_CHAIN[0].label, 'src/main/java/com/ziyun/medical');
eq('tree 压缩节点下分成两叉', TR_CHAIN[0].children.map((c) => c.label), ['controller', 'model/response']);
eq('tree 目录节点带上了全部后代文件', gitTree.fileCount(TR_CHAIN[0]), 2);
eq('tree 目录级勾选取到的就是全部后代路径', gitTree.pathsOf(TR_CHAIN[0]).sort(), [
  'src/main/java/com/ziyun/medical/controller/AmbulanceController.java',
  'src/main/java/com/ziyun/medical/model/response/AmbulanceRes.java',
].sort());
eq(
  'tree 计数与路径数一致（目录勾选不会漏文件）',
  gitTree.fileCount(TR_CHAIN[0]),
  gitTree.pathsOf(TR_CHAIN[0]).length,
);

/* 同级排序：目录在前、文件在后，文件走自然序（file2 在 file10 之前） */
const TR_SORT = gitTree.buildFileTree([
  MOD('a/file10.txt'),
  MOD('a/file2.txt'),
  MOD('a/README.md'),
  MOD('a/sub/x.txt'),
]);
eq('tree 同级目录在前文件在后且按自然序', TR_SORT[0].children.map((c) => c.label), [
  'sub',
  'file2.txt',
  'file10.txt',
  'README.md',
]);

/* 目录本身含文件时不再压缩（否则文件名会被并进目录名里，看不出来） */
const TR_STOP = gitTree.buildFileTree([MOD('aa/bb/cc/d.txt'), MOD('aa/keep.txt')]);
eq('tree 含文件的目录保持原样', TR_STOP[0].label, 'aa');
eq('tree 压缩在「有文件的目录」处停下', TR_STOP[0].children.map((c) => c.label), ['bb/cc', 'keep.txt']);

/* 顶层文件与该顶层目录混排 */
eq('tree 顶层目录与文件混排', gitTree.buildFileTree([MOD('pom.xml'), MOD('src/App.java')]).map((n) => `${n.kind}:${n.label}`), [
  'dir:src',
  'file:pom.xml',
]);
eq('tree 空列表返回空数组', gitTree.buildFileTree([]), []);

/*
 * 泛型版本：提交详情那棵树用 FileDiff 建，路径取 newPath ?? oldPath
 * （删除的文件只有 oldPath）。这条断言钉住「取路径规则由调用方决定」。
 */
const DIFFY = [
  { newPath: 'src/a/B.java', oldPath: 'src/a/B.java' },
  { newPath: null as string | null, oldPath: 'src/a/gone.txt' },
  { newPath: 'pom.xml', oldPath: null as string | null },
];
const TR_DIFF = gitTree.buildPathTree(DIFFY, (f) => f.newPath ?? f.oldPath ?? '(未知路径)');
eq(
  'tree（泛型）删除的文件用旧路径入树',
  TR_DIFF.flatMap((n) => n.files)
    .map((f) => f.newPath ?? f.oldPath)
    .sort(),
  ['pom.xml', 'src/a/B.java', 'src/a/gone.txt'],
);
eq('tree（泛型）顶层目录压缩后与文件混排', TR_DIFF.map((n) => `${n.kind}:${n.label}`), ['dir:src/a', 'file:pom.xml']);
eq('tree（泛型）目录计数', gitTree.fileCount(TR_DIFF[0]), 2);

/* 「一键全部折叠」要一次折完所有目录，靠的就是这份清单 */
eq('tree 收集全部目录路径（含压缩链与子树）', gitTree.dirPaths(TR_CHAIN), [
  'src/main/java/com/ziyun/medical',
  'src/main/java/com/ziyun/medical/controller',
  'src/main/java/com/ziyun/medical/model/response',
]);
eq('tree 收集全部目录路径：只有顶层文件时为空', gitTree.dirPaths(gitTree.buildFileTree([MOD('pom.xml')])), []);

/* ---- 变更列表自动刷新（间隔收敛 + 什么时候不该轮询） ---- */
eq('git 默认轮询间隔是 5 秒', gitPrefs.DEFAULT_REFRESH_SEC, 5);
eq('git 间隔：非数值回默认', gitPrefs.validIntervalSec('abc'), 5);
eq('git 间隔：null 回默认', gitPrefs.validIntervalSec(null), 5);
eq('git 间隔：过小回默认（不夹到下限，免得变成每 3 秒 fork 一堆 git）', gitPrefs.validIntervalSec(1), 5);
eq('git 间隔：0 回默认', gitPrefs.validIntervalSec(0), 5);
eq('git 间隔：合法值原样', gitPrefs.validIntervalSec(10), 10);
eq('git 间隔：超上限收到 3600', gitPrefs.validIntervalSec(99999), 3600);

const POLL_OK = { autoRefresh: true, active: true, hasRepo: true, busy: false, hidden: false };
eq('git 轮询：正常情况应当轮询', gitPrefs.shouldPoll(POLL_OK), true);
eq('git 轮询：关了自动刷新就不轮询', gitPrefs.shouldPoll({ ...POLL_OK, autoRefresh: false }), false);
eq('git 轮询：模块切走（不在前台）不轮询', gitPrefs.shouldPoll({ ...POLL_OK, active: false }), false);
eq('git 轮询：没打开仓库不轮询', gitPrefs.shouldPoll({ ...POLL_OK, hasRepo: false }), false);
eq('git 轮询：写操作进行中不插队', gitPrefs.shouldPoll({ ...POLL_OK, busy: true }), false);
eq('git 轮询：窗口被藏起来（关窗转后台）不轮询', gitPrefs.shouldPoll({ ...POLL_OK, hidden: true }), false);

/* =============================================
   ====== 首页拖拽排序（features/home/order.ts） ======
   拖拽是纯手感的活儿，但「顺序怎么算」是可断言的：
   尤其是 mergeOrder —— 它防的是「拖一次，被隐藏的模块顺序就丢了」。
   ============================================= */
import { applyOrder, mergeOrder, moveItem } from '../src/features/home/order';
import { clearEvents, formatAgo, getEvents, pushEvent } from '../src/core/events';

const OM = (id: string) => ({ id });

eq('排序：往后挪 0 -> 2', moveItem(['a', 'b', 'c', 'd'], 0, 2), ['b', 'c', 'a', 'd']);
eq('排序：往前挪 3 -> 1', moveItem(['a', 'b', 'c', 'd'], 3, 1), ['a', 'd', 'b', 'c']);
eq('排序：原位挪动不变', moveItem(['a', 'b', 'c'], 1, 1), ['a', 'b', 'c']);

const MOVE_SRC = ['a', 'b', 'c'];
moveItem(MOVE_SRC, 0, 2);
eq('排序：moveItem 不改原数组', MOVE_SRC, ['a', 'b', 'c']);

eq('排序：没有记录时原样返回', applyOrder([OM('a'), OM('b')]).map((x) => x.id), ['a', 'b']);
eq(
  '排序：按记录重排',
  applyOrder([OM('a'), OM('b'), OM('c')], ['c', 'a', 'b']).map((x) => x.id),
  ['c', 'a', 'b'],
);
eq(
  '排序：记录里没有的排最后（保持原序）',
  applyOrder([OM('a'), OM('b'), OM('c')], ['c']).map((x) => x.id),
  ['c', 'a', 'b'],
);

eq('合并：全可见时就是新顺序', mergeOrder(['a', 'b', 'c'], ['c', 'a', 'b']), ['c', 'a', 'b']);
eq('合并：隐藏项留在自己的槽位', mergeOrder(['a', 'b', 'c', 'd'], ['c', 'a', 'd']), ['c', 'b', 'a', 'd']);
eq(
  '合并：末尾隐藏项不受影响',
  mergeOrder(['a', 'b', 'c', 'd'], ['d', 'a', 'b', 'c']),
  ['d', 'a', 'b', 'c'],
);
eq('合并：可见项不在 full 里时补末尾（防御）', mergeOrder(['a', 'b'], ['b', 'z']), ['a', 'b', 'z']);

/* =============================================
   ====== 首页世界时钟（features/home/clocks.ts） ======
   时区换算是「看代码觉得对、跑起来差一小时」的重灾区：
   夏令时、半小时时区、跨日标记，全靠断言钉住。
   样例取**固定 UTC 时刻**，不依赖本机时区（TZ 变了断言也不该变）。
   ============================================= */
import * as tz from '../src/core/timezones';
import * as homeClocks from '../src/features/home/clocks';
const { CLOCK_MAX, ZONE_CATALOG } = tz;

/* 2026-01-05T00:30:00Z（冬令时）与 2026-07-05T00:30:00Z（夏令时） */
const WINTER = new Date('2026-01-05T00:30:00Z');
const SUMMER = new Date('2026-07-05T00:30:00Z');

eq('时钟：上海 08:30（东八区）', tz.formatClock(WINTER, 'Asia/Shanghai')?.time, '08:30');
eq('时钟：上海偏移 480 分钟', tz.formatClock(WINTER, 'Asia/Shanghai')?.offsetMinutes, 480);
eq(
  '时钟：东京比上海早 1 小时',
  tz.formatClock(WINTER, 'Asia/Tokyo')?.time,
  '09:30',
);
eq(
  '时钟：纽约冬令时 19:30（前一天）',
  tz.formatClock(WINTER, 'America/New_York')?.time,
  '19:30',
);
eq(
  '时钟：纽约冬令时日期是前一天',
  tz.formatClock(WINTER, 'America/New_York')?.dayKey,
  '2026-01-04',
);
eq(
  '时钟：纽约冬令时偏移 -300',
  tz.formatClock(WINTER, 'America/New_York')?.offsetMinutes,
  -300,
);
/* 同一条断言换成夏天：偏移必须自己变成 -240。这条防的是「手写偏移表」那种实现 */
eq(
  '时钟：纽约夏令时自动变 -240（不手写偏移表）',
  tz.formatClock(SUMMER, 'America/New_York')?.offsetMinutes,
  -240,
);
eq(
  '时钟：新德里是半小时时区（+5:30 → 06:00）',
  tz.formatClock(WINTER, 'Asia/Kolkata')?.time,
  '06:00',
);
eq(
  '时钟：新德里偏移 330 分钟',
  tz.formatClock(WINTER, 'Asia/Kolkata')?.offsetMinutes,
  330,
);
eq('时钟：UTC 偏移 0', tz.formatClock(WINTER, 'UTC')?.offsetMinutes, 0);
eq('时钟：秒数两位补零', tz.formatClock(WINTER, 'Asia/Shanghai')?.second, '00');
eq(
  '时钟：日期标签带月日',
  tz.formatClock(WINTER, 'Asia/Shanghai')?.dateLabel.startsWith('1月5日'),
  true,
);
/* 非法时区不许抛：渲染层靠 null 降级成「—」，抛出去整页会进 ErrorBoundary */
eq('时钟：非法时区返回 null 而不是抛错', tz.formatClock(WINTER, 'Not/AZone'), null);

eq('时钟：跨日标记（地区是昨天）', tz.dayDeltaLabel('2026-01-04', '2026-01-05'), '昨天');
eq('时钟：跨日标记（地区是明天）', tz.dayDeltaLabel('2026-01-06', '2026-01-05'), '明天');
/* 同一天刻意不返回「今天」—— 每张卡都挂一个「今天」会把真正的「明天」淹掉 */
eq('时钟：同一天不给标记', tz.dayDeltaLabel('2026-01-05', '2026-01-05'), '');
eq('时钟：跨日标记容忍脏数据', tz.dayDeltaLabel('', '2026-01-05'), '');

eq('时钟：时差文案（同步）', tz.offsetLabel(0), '与本地相同');
eq('时钟：时差文案（早 1 小时）', tz.offsetLabel(60), '比本地早 1 小时');
eq('时钟：时差文案（晚 12 小时）', tz.offsetLabel(-720), '比本地晚 12 小时');
eq('时钟：时差文案（半小时）', tz.offsetLabel(-30), '比本地晚 30 分钟');
eq('时钟：时差文案（1 小时 30 分）', tz.offsetLabel(90), '比本地早 1 小时 30 分钟');
eq('时钟：时差文案（非法值）', tz.offsetLabel(Number.NaN), '');

/*
 * 「没存过」与「用户删空了」必须分开：前者给默认值，后者要尊重空列表。
 * 这条判据和 core/theme.ts::parseStoredFontSize 是同一个坑（clamp 会把
 * 「没有值」掩盖成一个合法值）。
 */
const defaultEntries = homeClocks.normalizeClockEntries(null);
ok(
  '时钟：没存过时给 4 个默认地区，第一格是本机时区',
  defaultEntries.length === 4 &&
    defaultEntries[0].id === tz.localZoneId() &&
    new Set(defaultEntries.map((e) => e.id)).size === 4,
);
/*
 * 本机时区是白名单的唯一例外：它可能不在目录里（`Etc/GMT-8` 之类），
 * 但必须能留在列表里 —— 否则下次启动「本地」那一格就没了。
 */
ok(
  '时钟：本机时区即使不在目录里也要保留',
  homeClocks.normalizeClockEntries([tz.localZoneId()])[0]?.id === tz.localZoneId(),
);
eq('时钟：目录外时区按 id 兜底取名', tz.cityFromZoneId('Europe/Kyiv'), 'Kyiv');
eq('时钟：兜底名把下划线换成空格', tz.cityFromZoneId('America/Argentina/Buenos_Aires'), 'Buenos Aires');
eq('时钟：目录内优先用中文名', tz.zoneLabel('Asia/Tokyo'), '东京');
eq('时钟：目录外才走兜底名', tz.zoneLabel('Europe/Kyiv'), 'Kyiv');
eq('时钟：用户删空了就保持空（不回默认）', homeClocks.normalizeClockEntries([]), []);
eq(
  '时钟：未知时区 / 非字符串 / 重复项都被剔掉',
  homeClocks.normalizeClockEntries(['Asia/Tokyo', 'Asia/Tokyo', 'Nope/Zone', 42, 'Europe/Paris']),
  [{ id: 'Asia/Tokyo' }, { id: 'Europe/Paris' }],
);
eq(
  '时钟：存量超上限时截断',
  homeClocks.normalizeClockEntries(ZONE_CATALOG.map((z) => z.id)).length,
  CLOCK_MAX,
);

/* ---- 城市名：条目记的是「用户选的那个城市」，不是一个裸时区 ---- */
eq(
  '时钟：旧格式（裸 id 数组）自动迁移成条目',
  homeClocks.normalizeClockEntries(['Asia/Tokyo']),
  [{ id: 'Asia/Tokyo' }],
);
eq(
  '时钟：别名城市被保留（北京挂在 Asia/Shanghai 下）',
  homeClocks.normalizeClockEntries([{ id: 'Asia/Shanghai', city: '北京' }]),
  [{ id: 'Asia/Shanghai', city: '北京' }],
);
/*
 * 手改存储塞进来「东京 + 北京」这种组合：宁可丢掉城市名，也不能让格子上
 * 写着北京、走的却是东京时间。
 */
eq(
  '时钟：城市名与该时区不匹配时丢掉城市名',
  homeClocks.normalizeClockEntries([{ id: 'Asia/Tokyo', city: '北京' }]),
  [{ id: 'Asia/Tokyo' }],
);
eq(
  '时钟：城市名过长时丢掉',
  homeClocks.normalizeClockEntries([{ id: 'Asia/Tokyo', city: '东'.repeat(40) }]),
  [{ id: 'Asia/Tokyo' }],
);
ok(
  '时钟：cityBelongsTo 只认该时区真的有的城市',
  tz.cityBelongsTo('Asia/Shanghai', '北京') &&
    tz.cityBelongsTo('Asia/Shanghai', '上海') &&
    !tz.cityBelongsTo('Asia/Tokyo', '北京'),
);

const twoEntries = [{ id: 'Asia/Tokyo' }, { id: 'Europe/Paris' }];
const addedAgain = homeClocks.addClockEntry(twoEntries, 'Asia/Tokyo');
/* 组件靠「引用没变」判断「要不要写盘」，所以这条必须是同一个引用而不是等值数组 */
ok('时钟：重复添加返回原数组（引用不变）', addedAgain === twoEntries);
eq('时钟：添加新地区', homeClocks.addClockEntry(twoEntries, 'UTC'), [
  { id: 'Asia/Tokyo' },
  { id: 'Europe/Paris' },
  { id: 'UTC' },
]);
/*
 * 同一个时区**允许并存多条**：北京和上海是同一个钟，但用户想同时看见两个城市名。
 * 去重键是 id + city，不是 id —— 按 id 去重会把后加的那个变成「替换显示名」。
 */
const beijingOnShanghai = homeClocks.addClockEntry([{ id: 'Asia/Shanghai' }], 'Asia/Shanghai', '北京');
eq('时钟：同区的另一个城市可以并存（不替换）', beijingOnShanghai, [
  { id: 'Asia/Shanghai' },
  { id: 'Asia/Shanghai', city: '北京' },
]);
/* 同 id 同城市才是重复 */
ok(
  '时钟：同 id 同城市再 add 返回原数组（引用不变）',
  homeClocks.addClockEntry(beijingOnShanghai, 'Asia/Shanghai', '北京') === beijingOnShanghai,
);
eq('时钟：未知时区不许加进去', homeClocks.addClockEntry(twoEntries, 'Nope/Zone'), twoEntries);
eq(
  '时钟：满员后加不进去',
  homeClocks.addClockEntry(
    ZONE_CATALOG.slice(0, CLOCK_MAX).map((z) => ({ id: z.id })),
    'UTC',
  ).length,
  CLOCK_MAX,
);

/* ---- 条目键与删除：同区多条的区分靠 id + city ---- */
eq(
  '时钟：entryKey 区分同区的不同城市',
  [
    homeClocks.entryKey({ id: 'Asia/Shanghai' }),
    homeClocks.entryKey({ id: 'Asia/Shanghai', city: '北京' }),
  ],
  ['Asia/Shanghai|', 'Asia/Shanghai|北京'],
);
eq(
  '时钟：按 key 删除只删那一格',
  homeClocks.removeClockEntry(
    [{ id: 'Asia/Shanghai' }, { id: 'Asia/Shanghai', city: '北京' }],
    'Asia/Shanghai|北京',
  ),
  [{ id: 'Asia/Shanghai' }],
);
/* 与主城同名的城市名会被归一掉，省得同义条目占两格 */
eq(
  '时钟：城市名等于主城时归一成缺省',
  homeClocks.normalizeClockEntries([{ id: 'Asia/Shanghai', city: '上海' }]),
  [{ id: 'Asia/Shanghai' }],
);
eq(
  '时钟：移除地区',
  homeClocks.removeClockEntry(twoEntries, 'Asia/Tokyo|'),
  [{ id: 'Europe/Paris' }],
);
eq(
  '时钟：移除不存在的地区无副作用',
  homeClocks.removeClockEntry(twoEntries, 'UTC|'),
  twoEntries,
);

/* ---- 搜索 ---- */
eq('时钟：空关键词返回全量目录', tz.searchCities('').length, ZONE_CATALOG.length);
eq(
  '时钟：英文名也能搜到',
  tz.searchCities('tokyo').map((z) => z.id),
  ['Asia/Tokyo'],
);
eq(
  '时钟：中文名也能搜到',
  tz.searchCities('东京').map((z) => z.id),
  ['Asia/Tokyo'],
);
eq(
  '时钟：IANA id 片段也能搜到',
  tz.searchCities('america/new').map((z) => z.id),
  ['America/New_York'],
);
ok(
  '时钟：分区名能筛出整组',
  tz.searchCities('美洲').every((z) => z.region === '美洲'),
);
eq('时钟：搜不到时是空数组', tz.searchCities('zzzzzz').length, 0);

/* ---- 城市别名：搜「北京」要能搜到，且结果里写的是北京 ---- */
eq(
  '时钟：搜北京命中 Asia/Shanghai',
  tz.searchCities('北京').map((z) => [z.id, z.city]),
  [['Asia/Shanghai', '北京']],
);
eq(
  '时钟：英文 beijing 同样命中',
  tz.searchCities('beijing').map((z) => [z.id, z.city]),
  [['Asia/Shanghai', '北京']],
);
/*
 * ⚠️ 别名**不按 id 匹配**：否则搜 shanghai 会同时冒出「北京」，
 * 用户看到的是「我搜上海，结果出现北京」。
 */
eq(
  '时钟：搜上海不会带出同一天区的北京',
  tz.searchCities('shanghai').map((z) => z.city),
  ['上海'],
);
ok(
  '时钟：别名城市带上了所属分区',
  tz.searchCities('西雅图').every((z) => z.region === '美洲'),
);
ok(
  '时钟：凤凰城在美国但不实行夏令时',
  tz.searchCities('凤凰城').some((z) => z.id === 'America/Phoenix') &&
    tz.nextTransition('America/Phoenix', Date.UTC(2026, 0, 15)) === null,
);

/* ---- 国家 / 地区名检索：用户脑子里常常是国家，不是城市 ---- */
eq(
  '时钟：搜「印度尼西亚」能出雅加达',
  tz.searchCities('印度尼西亚').map((z) => z.id),
  ['Asia/Jakarta'],
);
eq(
  '时钟：搜简称「印尼」也行',
  tz.searchCities('印尼').map((z) => z.id),
  ['Asia/Jakarta'],
);
eq(
  '时钟：搜英文 Indonesia 也行',
  tz.searchCities('indonesia').map((z) => z.id),
  ['Asia/Jakarta'],
);
/* 一个国家多个时区时返回一组，让用户自己挑城市 */
eq(
  '时钟：搜「美国」返回它的全部时区',
  tz.searchCities('美国').map((z) => z.id),
  [
    'America/New_York',
    'America/Chicago',
    'America/Denver',
    'America/Los_Angeles',
    'America/Anchorage',
    'America/Phoenix',
    'Pacific/Honolulu',
  ],
);
/* 「印度」是「印度尼西亚」的前缀，包含匹配下两边都该出来 —— 这是期望行为，不是 bug */
ok(
  '时钟：搜「印度」同时命中印度与印度尼西亚',
  (() => {
    const ids = tz.searchCities('印度').map((z) => z.id);
    return ids.includes('Asia/Kolkata') && ids.includes('Asia/Jakarta');
  })(),
);
/* 中国含港澳台：搜「中国」应当把四个时区都列出来 */
eq(
  '时钟：搜「中国」含港澳台',
  tz.searchCities('中国').map((z) => z.id),
  ['Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Macau', 'Asia/Taipei'],
);
/* 国家命中只扩散到目录，不扩散到别名城市 —— 否则搜「美国」会刷出二十几条 */
ok(
  '时钟：搜「美国」不把别名城市一起刷出来',
  tz.searchCities('美国').every((z) => z.city === tz.zoneLabel(z.id)),
);
/* 时区对比模块的下拉是「固定选项 + 自拼检索串」，靠这个反查表把国家名拼进去 */
ok(
  '时钟：反查表能给出时区所属国家',
  tz.countryNamesOf('Asia/Jakarta').includes('印度尼西亚') &&
    tz.countryNamesOf('America/Los_Angeles').includes('美国') &&
    tz.countryNamesOf('Asia/Shanghai').includes('中国'),
);
eq('时钟：没登记国家的时区返回空数组', tz.countryNamesOf('UTC'), []);

/* =============================================
   ====== 固定标准时（时区对比的「夏令时开关」） ======
   =============================================
   关掉夏令时之后，墙上时间 = 瞬间 + 标准偏移，不再问 Intl。
   这条路径**没有** gap / ambiguous —— 固定偏移是单射。
   ============================================= */
/* 2026-07-15 13:00Z：洛杉矶真实是 PDT 06:00，按标准时（-8）读就是 05:00 */
ok(
  '固定标准时：洛杉矶夏令时期间按 -8 读',
  (() => {
    const p = tz.partsAtOffset(Date.UTC(2026, 6, 15, 13, 0), -480);
    return !!p && p.hour === 5 && p.minute === 0;
  })(),
);
/* 跨日：2026-07-15 03:00Z 按 -8 读是前一天的 19:00 */
ok(
  '固定标准时：跨日时日期跟着退一天',
  (() => {
    const p = tz.partsAtOffset(Date.UTC(2026, 6, 15, 3, 0), -480);
    return !!p && p.day === 14 && p.hour === 19;
  })(),
);
/* 周名必须与真实路径同一套写法（都来自同一个 Intl formatter） */
eq(
  '固定标准时：周名与真实路径同形',
  tz.partsAtOffset(Date.UTC(2026, 6, 15, 13, 0), -480)?.weekday,
  tz.instantParts(Date.UTC(2026, 6, 15, 13, 0), 'America/Los_Angeles')?.weekday,
);
/* 偏移字段要换成调用方给的，不能沿用 UTC 的 0 */
eq('固定标准时：偏移字段是传入的那个', tz.partsAtOffset(Date.now(), 330)?.offsetMinutes, 330);
/* 墙上时间 → 瞬间：与读回来的一来一回必须闭合 */
ok(
  '固定标准时：读写闭合',
  (() => {
    const at = tz.wallToInstantAtOffset(-300, { year: 2026, month: 7, day: 15, hour: 5, minute: 0 });
    const back = at === null ? null : tz.partsAtOffset(at, -300);
    return (
      !!back &&
      back.year === 2026 &&
      back.month === 7 &&
      back.day === 15 &&
      back.hour === 5 &&
      back.minute === 0
    );
  })(),
);
/* 美国冬令时那半天（-5）与标准偏移一致：关掉开关不该让时间跳走 */
eq(
  '固定标准时：冬令时期间开关不改变钟点',
  tz.partsAtOffset(Date.UTC(2026, 0, 15, 14, 0), -300)?.hour,
  tz.instantParts(Date.UTC(2026, 0, 15, 14, 0), 'America/New_York')?.hour,
);

const zoneGroups = tz.groupZones(tz.searchCities(''));
ok(
  '时钟：分区不出现空组',
  zoneGroups.every((g) => g.zones.length > 0),
);
eq(
  '时钟：分区顺序固定（亚洲在前）',
  zoneGroups[0].region,
  '亚洲',
);
eq(
  '时钟：归组不丢项',
  zoneGroups.reduce((n, g) => n + g.zones.length, 0),
  ZONE_CATALOG.length,
);

/* =============================================
   ====== 墙上时间 → 瞬间（core/timezones.ts） ======
   时区对比模块的核心。夏令时的两个坑必须显式区分：
   前跳那一段**不存在**，回拨那一段**出现两次**。
   全部用 2026 年美国的真实跳变时刻（3/8 02:00、11/1 02:00）。
   ============================================= */
const NY = 'America/New_York';
const nyWall = (y: number, mo: number, d: number, h: number, mi: number) =>
  tz.wallToInstant(NY, { year: y, month: mo, day: d, hour: h, minute: mi });

/* 冬令时：EST = UTC−5 */
eq('换算：纽约冬令时 09:00 = 14:00Z', nyWall(2026, 1, 15, 9, 0)?.ms, Date.UTC(2026, 0, 15, 14, 0));
/* 夏令时：EDT = UTC−4，同一墙上时间提前一小时落到 UTC */
eq('换算：纽约夏令时 09:00 = 13:00Z', nyWall(2026, 7, 15, 9, 0)?.ms, Date.UTC(2026, 6, 15, 13, 0));

const gapRes = nyWall(2026, 3, 8, 2, 30);
eq('换算：前跳时 02:30 不存在（kind=gap）', gapRes?.kind, 'gap');
eq('换算：前跳顺延到 03:30 EDT', gapRes?.ms, Date.UTC(2026, 2, 8, 7, 30));
eq('换算：前跳的缺口是 60 分钟', gapRes && 'gapMinutes' in gapRes ? gapRes.gapMinutes : null, 60);
/* 顺延后的瞬间，其墙上时间必须正好是 03:30 —— 这就是「顺延」的定义 */
eq(
  '换算：顺延后的墙上时间是 03:30',
  tz.instantParts(Date.UTC(2026, 2, 8, 7, 30), NY)?.hour,
  3,
);

const ambRes = nyWall(2026, 11, 1, 1, 30);
eq('换算：回拨时 01:30 出现两次（kind=ambiguous）', ambRes?.kind, 'ambiguous');
/* 取较早的那次 = 仍在 EDT */
eq('换算：回拨取较早的一次（EDT）', ambRes?.ms, Date.UTC(2026, 10, 1, 5, 30));
eq(
  '换算：回拨的另一次晚 1 小时（EST）',
  ambRes && 'alternativeMs' in ambRes ? ambRes.alternativeMs : null,
  Date.UTC(2026, 10, 1, 6, 30),
);
/* 两个候选必须真的落在同一墙上时间上，否则「模糊」这个判断就是假的 */
eq(
  '换算：两个候选的墙上时间相同',
  [
    tz.instantParts(Date.UTC(2026, 10, 1, 5, 30), NY)?.hour,
    tz.instantParts(Date.UTC(2026, 10, 1, 6, 30), NY)?.hour,
  ],
  [1, 1],
);

eq('换算：不实行夏令时的时区永远唯一', tz.wallToInstant('Asia/Shanghai', { year: 2026, month: 7, day: 15, hour: 9, minute: 0 })?.kind, 'ok');
eq('换算：非法时区返回 null', tz.wallToInstant('Not/AZone', { year: 2026, month: 1, day: 1, hour: 0, minute: 0 }), null);

/* ---- 缩写：美国夏令时在界面上最直接的证据 ---- */
eq('缩写：纽约冬天是 EST', tz.zoneAbbr(new Date(Date.UTC(2026, 0, 15, 12, 0)), NY), 'EST');
eq('缩写：纽约夏天是 EDT', tz.zoneAbbr(new Date(Date.UTC(2026, 6, 15, 12, 0)), NY), 'EDT');
eq(
  '缩写：洛杉矶夏天是 PDT',
  tz.zoneAbbr(new Date(Date.UTC(2026, 6, 15, 12, 0)), 'America/Los_Angeles'),
  'PDT',
);
/* 没有字母缩写的时区返回空串，由调用方退回 UTC±H —— 别把 GMT+8 当缩写显示两遍 */
eq('缩写：上海没有字母缩写', tz.zoneAbbr(new Date(Date.UTC(2026, 0, 15, 12, 0)), 'Asia/Shanghai'), '');
eq('UTC 偏移文案（整点）', tz.formatUtcOffset(480), 'UTC+8');
eq('UTC 偏移文案（半小时）', tz.formatUtcOffset(-210), 'UTC-3:30');
eq('UTC 偏移文案（零）', tz.formatUtcOffset(0), 'UTC+0');

/* ---- 下一次跳变 ---- */
const springForward = tz.nextTransition(NY, Date.UTC(2026, 0, 1));
eq('跳变：2026 年美国夏令时从 3/8 07:00Z 开始', springForward?.ms, Date.UTC(2026, 2, 8, 7, 0));
eq('跳变：开始时偏移 −300 → −240', [springForward?.fromOffset, springForward?.toOffset], [-300, -240]);
const fallBack = tz.nextTransition(NY, Date.UTC(2026, 5, 1));
eq('跳变：2026 年美国夏令时在 11/1 06:00Z 结束', fallBack?.ms, Date.UTC(2026, 10, 1, 6, 0));
eq('跳变：结束时偏移 −240 → −300', [fallBack?.fromOffset, fallBack?.toOffset], [-240, -300]);
/* 跳过整个夏令时区间之后应当找到「下一次开始」= 2027 年 */
eq(
  '跳变：跨过一年后找到下一轮',
  tz.nextTransition(NY, Date.UTC(2026, 11, 1))?.toOffset,
  -240,
);
eq('跳变：不实行夏令时的时区返回 null', tz.nextTransition('Asia/Shanghai', Date.UTC(2026, 0, 1)), null);

/* ---- 按缩写搜索 ---- */
eq(
  '搜索：PT 命中两个太平洋时区',
  tz.searchCities('pt').map((z) => z.id),
  ['America/Los_Angeles', 'America/Vancouver'],
);
eq(
  '搜索：PST 同样命中（缩写不分大小写）',
  tz.searchCities('PST').map((z) => z.id),
  ['America/Los_Angeles', 'America/Vancouver'],
);
/*
 * 缩写是**全等**匹配。用巴黎来钉：它的缩写是 CET/CEST，而 'et' 是 'cet' 的子串 ——
 * 若按包含匹配，输入两个字母就会刷出一屏欧洲城市。
 * （城市名仍是包含匹配，所以 'et' 会带出 Detroit / 圣彼得堡，那是正常结果。）
 */
ok(
  '搜索：ET 命中东部时区',
  (() => {
    const hits = tz.searchCities('et');
    return (
      hits.some((z) => z.id === 'America/New_York') &&
      hits.some((z) => z.id === 'America/Toronto')
    );
  })(),
);
ok(
  '搜索：ET 不会因为 CET 包含 et 而命中巴黎（缩写全等）',
  !tz.searchCities('et').some((z) => z.id === 'Europe/Paris'),
);
ok(
  '搜索：CET 确实能命中巴黎（缩写表本身生效）',
  tz.searchCities('cet').some((z) => z.id === 'Europe/Paris'),
);
eq(
  '搜索：CST 同时给出美国和中国的候选',
  tz.searchCities('cst').map((z) => z.id),
  ['Asia/Shanghai', 'America/Chicago', 'America/Mexico_City'],
);

/* =============================================
   ====== 时区对比界面（features/timezone/format.ts） ======
   上面钉的是换算本身，这里钉**输入框与文案** —— 它们才是用户真正碰到的东西。
   两条最容易出事的：
     · 空串 / 半截输入不能当成 1970 年（浏览器在用户没输完时也会触发 change）；
     · 缩写徽标只能显示一次偏移信息（GMT+8 和 UTC+8 并排是噪声）。
   ============================================= */
import * as tzf from '../src/features/timezone/format';

/* ---- 瞬间 → 输入框的值 ---- */
eq('对比：瞬间 → date input（纽约，前一天）', tzf.toDateInput(tz.instantParts(Date.UTC(2026, 0, 5, 0, 30), NY)), '2026-01-04');
eq('对比：瞬间 → time input（纽约）', tzf.toTimeInput(tz.instantParts(Date.UTC(2026, 0, 5, 0, 30), NY)), '19:30');
eq('对比：非法时区给空串（不抛错）', tzf.toDateInput(tz.instantParts(Date.UTC(2026, 0, 5), 'Not/AZone')), '');

/* ---- 输入框的值 → 墙上时间 ---- */
eq('对比：空日期串 → null', tzf.parseDateInput(''), null);
eq('对比：半截日期串 → null', tzf.parseDateInput('2026-1'), null);
eq('对比：正常日期', tzf.parseDateInput('2026-03-08'), { year: 2026, month: 3, day: 8 });
/* 格式对、日期不存在：靠 UTC 回读校验挡掉，否则会静默变成 3 月 2 日 */
eq('对比：2 月 30 日 → null', tzf.parseDateInput('2026-02-30'), null);
eq('对比：2026 年 2 月 29 日 → null（平年）', tzf.parseDateInput('2026-02-29'), null);
eq('对比：2024 年 2 月 29 日可用（闰年）', tzf.parseDateInput('2024-02-29'), { year: 2024, month: 2, day: 29 });
eq('对比：空时间串 → null', tzf.parseTimeInput(''), null);
eq('对比：24:00 → null', tzf.parseTimeInput('24:00'), null);
eq('对比：正常时间', tzf.parseTimeInput('02:30'), { hour: 2, minute: 30 });
/* Safari 的 time 输入在带 step 时会给出 HH:mm:ss，不能因此判成非法 */
eq('对比：容忍 HH:mm:ss', tzf.parseTimeInput('02:30:45'), { hour: 2, minute: 30 });

/* ---- 缩写徽标 ---- */
eq('对比：纽约夏天徽标是 EDT', tzf.offsetBadge(Date.UTC(2026, 6, 15, 12, 0), NY), 'EDT');
eq('对比：纽约冬天徽标是 EST', tzf.offsetBadge(Date.UTC(2026, 0, 15, 12, 0), NY), 'EST');
/* 没有字母缩写的时区退回 UTC±H —— 不能把 Intl 给的 GMT+8 原样显示（和 UTC+8 重复） */
eq('对比：上海徽标退回 UTC+8', tzf.offsetBadge(Date.UTC(2026, 0, 15, 12, 0), 'Asia/Shanghai'), 'UTC+8');
eq('对比：印度徽标保留半小时', tzf.offsetBadge(Date.UTC(2026, 0, 15, 12, 0), 'Asia/Kolkata'), 'UTC+5:30');

/* ---- 跳变的中文说法 ---- */
/*
 * 跳变点必须用**跳变前**的墙上时间表述（美国人都说「凌晨 2 点」）。
 * 若误用跳变后的时间，开始那句会变成 03:00、结束那句会变成 01:00 —— 差一小时，
 * 而且看上去完全正常。
 */
eq(
  '对比：夏令时开始的说法',
  tzf.transitionText(NY, springForward),
  '夏令时 3月8日 02:00 开始，之后转为 EDT',
);
eq(
  '对比：夏令时结束的说法',
  tzf.transitionText(NY, fallBack),
  '夏令时 11月1日 02:00 结束，之后回到 EST',
);
eq('对比：不实行夏令时的时区', tzf.transitionText('Asia/Shanghai', null), '不实行夏令时');

/* ---- 时差 ----
 * 视图里的时差是「两边**有效**偏移之差」（有效 = 跟随夏令时用真实偏移、
 * 固定标准时用标准偏移），所以这里直接测底层 offsetAt 的差值。
 */
const diffAt = (ms: number, a: string, b: string) => {
  const oa = tz.offsetAt(ms, a);
  const ob = tz.offsetAt(ms, b);
  return oa === null || ob === null ? null : oa - ob;
};
eq('对比：冬天上海比纽约早 13 小时', diffAt(Date.UTC(2026, 0, 15, 12, 0), 'Asia/Shanghai', NY), 780);
/* 夏令时期间差 12 小时：同一个输入，换个季节结果就该变 */
eq(
  '对比：夏天上海比纽约早 12 小时（美国进入夏令时）',
  diffAt(Date.UTC(2026, 6, 15, 12, 0), 'Asia/Shanghai', NY),
  720,
);
eq('对比：非法时区时差为 null', diffAt(0, 'Not/AZone', NY), null);
eq('时差文案：以对方为参照', tz.offsetLabel(180, '洛杉矶'), '比洛杉矶早 3 小时');
eq('时差文案：参照物相同', tz.offsetLabel(0, '纽约'), '与纽约相同');
/* 默认参照仍是「本地」—— 首页世界时钟靠这个默认值，别被新参数带偏 */
eq('时差文案：默认参照是本地', tz.offsetLabel(60), '比本地早 1 小时');

/* ---- 联动：这才是用户真正看到的效果 ---- */
/* 在洛杉矶填 09:00，纽约那一栏必须自己走到 12:00（同一天、夏令时） */
const laMorning = tz.wallToInstant('America/Los_Angeles', {
  year: 2026,
  month: 7,
  day: 15,
  hour: 9,
  minute: 0,
});
eq(
  '对比：洛杉矶 09:00 时纽约是 12:00',
  laMorning ? tzf.toTimeInput(tz.instantParts(laMorning.ms, NY)) : null,
  '12:00',
);
/* 往东走：洛杉矶 20:00 时纽约 23:00 —— 仍是同一天，只是更晚 */
const laNight = tz.wallToInstant('America/Los_Angeles', {
  year: 2026,
  month: 7,
  day: 15,
  hour: 20,
  minute: 0,
});
eq(
  '对比：洛杉矶 20:00 时纽约是 23:00',
  laNight ? tzf.toTimeInput(tz.instantParts(laNight.ms, NY)) : null,
  '23:00',
);
eq(
  '对比：洛杉矶 20:00 与纽约 23:00 是同一天',
  laNight ? tzf.toDateInput(tz.instantParts(laNight.ms, NY)) : null,
  '2026-07-15',
);
/* 往西跨过国际日期变更线附近才会掉一天：上海 09:00 时纽约还是前一天 21:00 */
const shMorning = tz.wallToInstant('Asia/Shanghai', {
  year: 2026,
  month: 7,
  day: 15,
  hour: 9,
  minute: 0,
});
eq(
  '对比：上海 09:00 时纽约是前一天',
  shMorning ? tzf.toDateInput(tz.instantParts(shMorning.ms, NY)) : null,
  '2026-07-14',
);
eq(
  '对比：同上，钟点是 21:00',
  shMorning ? tzf.toTimeInput(tz.instantParts(shMorning.ms, NY)) : null,
  '21:00',
);

/* =============================================
   ====== 夏令时档案（features/timezone/format.ts） ======
   界面要把 `PDT` 和 `PST` 讲清楚，靠的就是这两个函数。
   它们**不许写死任何时区**：换成悉尼、伦敦都得自己算对。
   ============================================= */
const nySummer = tz.dstProfile(
  tz.offsetAt(Date.UTC(2026, 6, 15, 12, 0), NY),
  tz.nextTransition(NY, Date.UTC(2026, 6, 15, 12, 0)),
);
eq('夏令时：纽约夏天在夏令时里', nySummer?.inDst, true);
eq('夏令时：纽约标准偏移是 −300', nySummer?.standardOffset, -300);
eq('夏令时：夏令时增量 60 分钟', nySummer?.shift, 60);

const nyWinter2 = tz.dstProfile(
  tz.offsetAt(Date.UTC(2026, 0, 15, 12, 0), NY),
  tz.nextTransition(NY, Date.UTC(2026, 0, 15, 12, 0)),
);
eq('夏令时：纽约冬天不在夏令时里', nyWinter2?.inDst, false);
/* 冬夏两季算出来的标准偏移必须是同一个值，否则「另一档」就会飘 */
eq('夏令时：纽约冬天的标准偏移也是 −300', nyWinter2?.standardOffset, -300);

const shProfile = tz.dstProfile(
  tz.offsetAt(Date.UTC(2026, 0, 15, 12, 0), 'Asia/Shanghai'),
  tz.nextTransition('Asia/Shanghai', Date.UTC(2026, 0, 15, 12, 0)),
);
eq('夏令时：上海不实行', shProfile?.usesDst, false);
eq('夏令时：上海增量为 0', shProfile?.shift, 0);
eq('夏令时：上海的标准偏移等于当前偏移', shProfile?.standardOffset, shProfile?.offset);

/* 南半球：10 月底悉尼正在夏令时，而「下一次跳变」是次年 4 月的结束 —— 方向反着，逻辑必须照样对 */
const sydMs = Date.UTC(2026, 9, 26, 0, 0);
const syd = tz.dstProfile(
  tz.offsetAt(sydMs, 'Australia/Sydney'),
  tz.nextTransition('Australia/Sydney', sydMs),
);
eq('夏令时：南半球 10 月底在夏令时里', syd?.inDst, true);
eq('夏令时：悉尼标准偏移 +600', syd?.standardOffset, 600);
eq('夏令时：悉尼当前偏移 +660', syd?.offset, 660);
eq('夏令时：偏移为 null 时返回 null', tz.dstProfile(null, null), null);

/*
 * 跳变那一秒：`next` 是缓存的旧值，只有实时的 offset 能反映「已经跳过去了」。
 * 两条断言一起钉住「inDst 用实时 offset 判定」这个实现选择。
 */
const FB = Date.UTC(2026, 10, 1, 6, 0);
const beforeFB = tz.dstProfile(
  tz.offsetAt(FB - 1000, NY),
  tz.nextTransition(NY, FB - 1000),
);
const afterFB = tz.dstProfile(tz.offsetAt(FB, NY), tz.nextTransition(NY, FB));
eq('夏令时：回拨前 1 秒还在夏令时', beforeFB?.inDst, true);
eq('夏令时：回拨那一刻已经是标准时', afterFB?.inDst, false);

/* ---- 两档缩写：问 Intl 要跳变点两侧，不查手写表 ---- */
const pairFromWinter = tz.abbrPair(NY, tz.nextTransition(NY, Date.UTC(2026, 0, 15)));
const pairFromSummer = tz.abbrPair(NY, tz.nextTransition(NY, Date.UTC(2026, 6, 15)));
eq('缩写对：标准时是 EST', pairFromWinter?.standard, 'EST');
eq('缩写对：夏令时是 EDT', pairFromWinter?.daylight, 'EDT');
/* 从冬天推（下次是开始）与从夏天推（下次是结束）必须得出同一对 —— 方向写反了这里就红 */
eq('缩写对：从冬天与从夏天推出的两档一致', pairFromWinter, pairFromSummer);
eq('缩写对：不实行夏令时时为 null', tz.abbrPair('Asia/Shanghai', null), null);
/*
 * 伦敦：Intl 给的是 `GMT` / `GMT+1`，夏令时那一档**没有字母缩写**。
 * 钉住它是因为界面必须容忍这种情况（徽标退回 UTC±H），不能假设每个实行
 * 夏令时的时区都有 ST/DT 两档缩写。
 */
const lonPair = tz.abbrPair('Europe/London', tz.nextTransition('Europe/London', Date.UTC(2026, 0, 15)));
eq('缩写对：伦敦标准时是 GMT', lonPair?.standard, 'GMT');
eq('缩写对：伦敦夏令时没有字母缩写', lonPair?.daylight, '');

/* ---- 「另一档」的文案 ---- */
eq('另一档：纽约夏天给的是标准时', tz.otherTier(nySummer!, pairFromSummer).name, '标准时');
eq('另一档：纽约标准时带缩写与偏移', tz.otherTier(nySummer!, pairFromSummer).text, 'EST（UTC-5）');

const lonWinter = tz.dstProfile(
  tz.offsetAt(Date.UTC(2026, 0, 15, 12, 0), 'Europe/London'),
  tz.nextTransition('Europe/London', Date.UTC(2026, 0, 15)),
);
const lonOther = tz.otherTier(lonWinter!, lonPair);
eq('另一档：伦敦冬天是夏令时', lonOther.name, '夏令时');
/* 伦敦夏令时那档没有字母缩写 —— 不能拼成「UTC+1（UTC+1）」 */
eq('另一档：没有字母缩写时只写偏移', lonOther.text, 'UTC+1');

/* ---- 两档钟点：同一个瞬间按标准时 / 夏令时各写一次 ---- */
/* 纽约夏天 09:00 EDT = 13:00Z；按标准时算就是 08:00 */
eq('两档：纽约夏天 09:00 的标准时是 08:00', tz.tierTimes(Date.UTC(2026, 6, 15, 13, 0), nySummer!), {
  standard: '08:00',
  daylight: '09:00',
});
/* 冬天 09:00 EST = 14:00Z；按夏令时算反而是 10:00 */
eq('两档：纽约冬天 09:00 的夏令时是 10:00', tz.tierTimes(Date.UTC(2026, 0, 15, 14, 0), nyWinter2!), {
  standard: '09:00',
  daylight: '10:00',
});
/* 不实行夏令时的时区两档必然相同 —— 界面据此不显示这一行 */
eq('两档：上海两档相同', tz.tierTimes(Date.UTC(2026, 0, 15, 1, 0), shProfile!), {
  standard: '09:00',
  daylight: '09:00',
});

const laProfile = tz.dstProfile(
  tz.offsetAt(Date.UTC(2026, 6, 15, 7, 0), 'America/Los_Angeles'),
  tz.nextTransition('America/Los_Angeles', Date.UTC(2026, 6, 15, 7, 0)),
);
/*
 * 午夜前后：洛杉矶 00:00（夏令时）时，标准时是前一天的 23:00。
 * 两档只差 shift 分钟，界面上不写日期，靠差值自明。
 */
eq('两档：洛杉矶午夜 00:00 的标准时是 23:00', tz.tierTimes(Date.UTC(2026, 6, 15, 7, 0), laProfile!), {
  standard: '23:00',
  daylight: '00:00',
});

/* =============================================
   ====== 事件流（core/events.ts） ======
   时间刻度与去重窗口都是「边界才出错」的逻辑：
   59 秒和 60 秒、4 秒内和 4 秒后，肉眼看界面分不出来。
   ============================================= */
const FEED_T0 = new Date(2026, 9, 20, 15, 0, 0).getTime(); /* 2026-10-20 15:00 本地 */

eq('事件流：30 秒前是刚刚', formatAgo(FEED_T0 - 30_000, FEED_T0), '刚刚');
eq('事件流：59 秒仍是刚刚', formatAgo(FEED_T0 - 59_000, FEED_T0), '刚刚');
eq('事件流：整 60 秒改说分钟', formatAgo(FEED_T0 - 60_000, FEED_T0), '1 分钟前');
eq('事件流：59 分钟', formatAgo(FEED_T0 - 59 * 60_000, FEED_T0), '59 分钟前');
eq('事件流：满 1 小时改用时刻', formatAgo(FEED_T0 - 3_600_000, FEED_T0), '14:00');
eq('事件流：昨天带前缀', formatAgo(new Date(2026, 9, 19, 22, 5).getTime(), FEED_T0), '昨天 22:05');
eq('事件流：更早带日期', formatAgo(new Date(2026, 9, 15, 8, 3).getTime(), FEED_T0), '10月15日 08:03');
eq('事件流：未来时间按刚刚处理', formatAgo(FEED_T0 + 5_000, FEED_T0), '刚刚');

clearEvents();
const FEED_EV1 = pushEvent({ module: 'jarrunner', title: '启动了 A', ts: FEED_T0 });
const FEED_EV2 = pushEvent({ module: 'git', title: '已提交', ts: FEED_T0 + 1_000 });
eq('事件流：最新的排在最前', getEvents().map((e) => e.title), ['已提交', '启动了 A']);
ok('事件流：id 递增', FEED_EV2.id > FEED_EV1.id);

pushEvent({ module: 'git', title: '已提交', ts: FEED_T0 + 2_000 });
eq('事件流：4 秒内同一条只占一行', getEvents().length, 2);
eq('事件流：合并后计数为 2', getEvents()[0].repeat, 2);

pushEvent({ module: 'git', title: '已提交', ts: FEED_T0 + 9_000 });
eq('事件流：超出窗口另起一行', getEvents().length, 3);
eq('事件流：新起的一行计数为 1', getEvents()[0].repeat, 1);

pushEvent({ module: 'git', title: '已提交', detail: 'fix: x', ts: FEED_T0 + 10_000 });
eq('事件流：detail 不同不合并', getEvents().length, 4);

clearEvents();
for (let i = 0; i < 260; i++) {
  pushEvent({ module: 'm', title: `e${i}`, ts: FEED_T0 + i * 10_000 });
}
eq('事件流：环形缓冲封顶 200', getEvents().length, 200);
eq('事件流：截断后最新的仍在头部', getEvents()[0].title, 'e259');

clearEvents();
eq('事件流：清空后为空', getEvents().length, 0);

/* =============================================
   ====== 安全配置备份：白名单、拒绝未知字段与失败回滚 ======
   ============================================= */
const backupProjects = { version: 1 as const, activeProjectId: 'p1', items: [{
  id: 'p1', name: 'demo', repoPath: '/repo', jarConfigIds: ['j1'], logServerIds: ['s1'], directories: [],
  links: [{ id: 'l1', name: 'docs', url: 'https://user:secret@example.com/a?token=secret#part' }],
}] };
const backup = safeBackup.buildSafeBackup({ selected: ['projects'], workbench: {}, projects: backupProjects,
  gitRecent: [], gitPrefs: { autoRefresh: false, refreshIntervalSec: 10 }, jars: [], servers: [] });
const backupText = JSON.stringify(backup);
ok('备份项目链接会去除 userinfo、query、hash', !backupText.includes('secret') && !backupText.includes('token=') && !backupText.includes('#part'));
eq('备份按所选分区输出', Object.keys(backup.sections), ['projects']);
const sensitiveProjection = safeBackup.buildSafeBackup({ selected: ['jarrunner', 'logsight'], workbench: {}, projects: backupProjects,
  gitRecent: [], gitPrefs: { autoRefresh: false, refreshIntervalSec: 10 },
  jars: [{ id:'j-safe', name:'jar', jarPath:'/app.jar', jdkHome:'', configFile:'', workDir:'', updatedAt:1, env:[{key:'TOKEN',value:'jar-secret'}], jvmArgs:'jvm-secret', programArgs:'arg-secret', customCommand:'command-secret' } as never],
  servers: [{ id:'s-safe', bookmark_category:'default', title:'server', host:'host', port:22, username:'root', auth_type:'Password', private_key_path:null, ssh_config_path:null, use_ssh_agent:false, ssh_agent_path:null, use_mfa:false, created_at:'2026-01-01T00:00:00Z', updated_at:'2026-01-01T00:00:00Z', last_connected_at:null, password_cipher:'password-secret', private_key_cipher:'key-secret', run_scripts:[{content:'script-secret'}], description:'description-secret' } as never] });
const sensitiveText = JSON.stringify(sensitiveProjection);
ok('JAR/LogSight安全投影不含环境变量、参数、命令、凭据、脚本或描述', !/jar-secret|jvm-secret|arg-secret|command-secret|password-secret|key-secret|script-secret|description-secret|password_cipher|private_key_cipher|run_scripts/.test(sensitiveText));
let invalidBackupRejected = false;
try { safeBackup.parseSafeBackup(JSON.stringify({ ...backup, extra: true })); } catch { invalidBackupRejected = true; }
ok('备份解析拒绝未知顶层字段', invalidBackupRejected);
invalidBackupRejected = false;
try { safeBackup.parseSafeBackup(JSON.stringify({ ...backup, version: 2 })); } catch { invalidBackupRejected = true; }
ok('备份解析拒绝未知版本', invalidBackupRejected);
invalidBackupRejected = false;
try { safeBackup.parseSafeBackup(JSON.stringify({ ...backup, sections: { projects: { ...backup.sections.projects, items: [backupProjects.items[0], backupProjects.items[0]] } } })); } catch { invalidBackupRejected = true; }
ok('备份解析拒绝重复项目 ID', invalidBackupRejected);
invalidBackupRejected = false;
try { const bad = JSON.parse(JSON.stringify(backup)); bad.sections.projects.items[0].links[0].url = 'javascript:alert(1)'; safeBackup.parseSafeBackup(JSON.stringify(bad)); } catch { invalidBackupRejected = true; }
ok('备份解析拒绝非法网址协议', invalidBackupRejected);
let stalePreviewBackup: unknown = backup;
let stalePreviewLines = ['来自上一个有效文件'];
try { safeBackup.parseSafeBackup(JSON.stringify({ ...backup, unexpected: true })); }
catch { safeBackup.clearBackupImportPreview((v) => { stalePreviewBackup = v; }, (v) => { stalePreviewLines = v; }); }
ok('无效备份会清空之前可应用的预览', stalePreviewBackup === null && stalePreviewLines.length === 0);
const localState = new Map([['setting', 'before']]);
let nativeFailed = false;
try {
  await applyWithLocalRollback({ writeLocal: () => localState.set('setting', 'after'), rollbackLocal: () => localState.set('setting', 'before'), applyNative: async () => { throw new Error('injected native failure'); } });
} catch { nativeFailed = true; }
ok('native应用失败时安全恢复本地设置', nativeFailed && localState.get('setting') === 'before');
let localWriteFailed = false;
try {
  await applyWithLocalRollback({ writeLocal: () => { localState.set('setting', 'partial'); throw new Error('injected local failure'); }, rollbackLocal: () => localState.set('setting', 'before'), applyNative: async () => 'unreachable' });
} catch { localWriteFailed = true; }
ok('本地分段写入失败时也恢复已写入部分', localWriteFailed && localState.get('setting') === 'before');
const filteredSections = Object.fromEntries(['projects'].filter((key) => backup.sections[key as keyof typeof backup.sections]).map((key) => [key, backup.sections[key as keyof typeof backup.sections]]));
eq('未选择分区不进入恢复 payload', Object.keys(filteredSections), ['projects']);

/* JAR 安全恢复：干净草稿自动刷新；脏草稿由用户决定重新载入或保留。 */
const savedJar = { id: 'restore-jar', name: 'restored', jarPath: '/restored.jar', jdkHome: '/jdk', jvmArgs: '-Xmx1g', programArgs: '', configFile: '', workDir: '/restored', env: [{ key: 'TOKEN', value: 'keep-secret' }], customCommand: '', updatedAt: 2 };
setCommand('jarrunner_list_configs', () => [savedJar]);
useJarRunnerStore.setState({ draft: { ...savedJar, jarPath: '/old.jar' }, draftDirty: false, pendingConfigReload: null, retainedConfigReload: null, configs: [{ ...savedJar, jarPath: '/old.jar' }] });
await jarPublic.reloadSavedConfigs();
ok('恢复时自动刷新已加载且无未保存编辑的JAR草稿', useJarRunnerStore.getState().draft.jarPath === '/restored.jar' && !useJarRunnerStore.getState().pendingConfigReload);
const userDraft = { ...savedJar, jarPath: '/user-edit.jar', jvmArgs: '-Xmx2g' };
useJarRunnerStore.setState({ draft: userDraft, draftDirty: true, pendingConfigReload: null });
setCommand('jarrunner_list_configs', () => [{ ...savedJar, jarPath: '/backup-restored.jar' }]);
await jarPublic.reloadSavedConfigs();
ok('恢复不静默覆盖有未保存编辑的JAR草稿', useJarRunnerStore.getState().draft.jarPath === '/user-edit.jar' && useJarRunnerStore.getState().pendingConfigReload?.jarPath === '/backup-restored.jar');
useJarRunnerStore.getState().keepDraftAfterConfigReload();
ok('用户选择保留JAR草稿会保留编辑并提示仍有恢复版本', useJarRunnerStore.getState().draft.jarPath === '/user-edit.jar' && !useJarRunnerStore.getState().pendingConfigReload && useJarRunnerStore.getState().retainedConfigReload?.jarPath === '/backup-restored.jar');
useJarRunnerStore.setState({ draft: userDraft, draftDirty: true, pendingConfigReload: { ...savedJar, jarPath: '/backup-restored.jar' } });
useJarRunnerStore.getState().reloadPendingConfig();
ok('用户选择重新载入会应用恢复后的JAR配置', useJarRunnerStore.getState().draft.jarPath === '/backup-restored.jar' && !useJarRunnerStore.getState().draftDirty);
const oldRun = { id: 'still-running', name: 'run', jarPath: '/running.jar', status: 'running', pid: 123, startedAt: 1, endedAt: null, exitCode: null, error: null, jdkLabel: 'JDK' } as never;
useJarRunnerStore.setState({ activeRunId: oldRun.id, runs: [oldRun], logsByRun: { [oldRun.id]: [] } });
const viewBeforeRestoreOpen = useJarRunnerStore.getState().configViewRequest;
await jarPublic.openProjectConfig('restore-jar');
ok('项目加载JAR配置会切回配置表单且不清运行记录/日志', useJarRunnerStore.getState().activeRunId === null && useJarRunnerStore.getState().configViewRequest === viewBeforeRestoreOpen + 1 && useJarRunnerStore.getState().runs[0]?.id === oldRun.id && oldRun.id in useJarRunnerStore.getState().logsByRun);

/* Git 仓库切换竞态：A 的慢刷新不能挡住 B 首次对账或留下 merge 标记。 */
let releaseRepoAStatus: ((raw: { stdout: string; stderr: string }) => void) | null = null;
setCommand('git_open_repo', (args) => ({ root: args?.path, valid: true, branch: args?.path === '/repo-b' ? 'branch-b' : 'branch-a', detached: false, upstream: null, ahead: 0, behind: 0, empty: false }));
setCommand('git_status', (args) => args?.repo === '/repo-a' ? new Promise((resolve) => { releaseRepoAStatus = resolve; }) : ({ stdout: '# branch.head branch-b\n', stderr: '' }));
setCommand('git_branches', () => ({ stdout: '', stderr: '' }));
setCommand('git_ahead_behind', () => ({ ahead: 0, behind: 0 }));
setCommand('git_operation_state', (args) => args?.repo === '/repo-a' ? { kind: 'merge', conflicts: ['A-conflict'] } : { kind: 'none', conflicts: [] });
setCommand('git_log', () => ({ stdout: '', stderr: '' }));
setCommand('git_checkout', () => ({ ok: true, message: 'checked out', hash: null, conflicts: [], stderr: '' }));
const openRepoA = useGitStore.getState().openRepo('/repo-a');
while (!releaseRepoAStatus) await new Promise((resolve) => setTimeout(resolve, 0));
const openRepoB = useGitStore.getState().openRepo('/repo-b');
await openRepoB;
ok('切换仓库时B独立完成首次状态刷新且清除A的merge标记', useGitStore.getState().repoRoot === '/repo-b' && useGitStore.getState().status?.branch === 'branch-b' && useGitStore.getState().operationState.kind === 'none' && useGitStore.getState().branches !== null);
releaseRepoAStatus?.({ stdout: '# branch.head branch-a\n', stderr: '' });
await openRepoA;
ok('A迟到刷新不会覆盖B的状态', useGitStore.getState().repoRoot === '/repo-b' && useGitStore.getState().status?.branch === 'branch-b' && useGitStore.getState().operationState.kind === 'none');
await useGitStore.getState().checkout('topic');
ok('自动刷新关闭时B对账完成后仍可执行checkout', callCount('git_checkout') === 1 && useGitStore.getState().repoRoot === '/repo-b');
resetCommands();

/* =============================================
   ====== Trae 社区：时间 / 文本 / 数字 ======
   ============================================= */
/*
 * 相对时间全部用**本地时间构造**的样本：`new Date(y, m, d, h)` 不受运行时区影响，
 * 断言在任何机器上都稳定（用 ISO 字符串会在不同时区下偏一天）。
 */
const cmNowMs = new Date(2026, 10, 6, 12, 0, 0).getTime();
const cmRel = (ms: number) => cmFmt.formatRelativeTime(new Date(ms).toISOString(), cmNowMs);
eq('社区相对时间：一分钟内是刚刚', cmRel(cmNowMs - 30_000), '刚刚');
eq('社区相对时间：分钟', cmRel(cmNowMs - 5 * 60_000), '5 分钟前');
eq('社区相对时间：小时', cmRel(cmNowMs - 3 * 3600_000), '3 小时前');
eq('社区相对时间：昨天', cmRel(new Date(2026, 10, 5, 8, 0, 0).getTime()), '昨天');
eq('社区相对时间：几天前', cmRel(new Date(2026, 10, 3, 8, 0, 0).getTime()), '3 天前');
eq('社区相对时间：同年月日', cmRel(new Date(2026, 9, 2, 10, 0, 0).getTime()), '10 月 2 日');
eq('社区相对时间：跨年月日', cmRel(new Date(2025, 11, 25, 10, 0, 0).getTime()), '2025 年 12 月 25 日');
eq('社区相对时间：坏时间兜底', cmFmt.formatRelativeTime('not-a-date', cmNowMs), '—');
eq('社区时间：绝对时间补零', cmFmt.formatDateTime(new Date(2026, 10, 6, 9, 5).toISOString()), '2026-11-06 09:05');
eq('社区时间：绝对时间坏值兜底', cmFmt.formatDateTime(null), '—');
eq('社区缓存时间：刚刚', cmFmt.formatCacheAge(cmNowMs - 30_000, cmNowMs), '刚刚同步');
eq('社区缓存时间：分钟', cmFmt.formatCacheAge(cmNowMs - 5 * 60_000, cmNowMs), '5 分钟前同步');
eq('社区缓存时间：空值不出文案', cmFmt.formatCacheAge(null, cmNowMs), '');

eq('社区数字：千以内原样', cmFmt.formatCount(999), '999');
eq('社区数字：千级用 k', cmFmt.formatCount(1228), '1.2k');
eq('社区数字：整千不留小数', cmFmt.formatCount(1000), '1k');
eq('社区数字：万级', cmFmt.formatCount(12_000), '1.2 万');
eq('社区数字：十万级取整', cmFmt.formatCount(120_000), '12 万');
eq('社区数字：负数归零', cmFmt.formatCount(-5), '0');
eq('社区数字：非数字归零', cmFmt.formatCount(null), '0');
eq('社区阅读时长：秒', cmFmt.formatReadTime(45), '45 秒');
eq('社区阅读时长：分钟', cmFmt.formatReadTime(90), '1 分钟');
eq('社区阅读时长：小时', cmFmt.formatReadTime(7200), '2 小时');

eq('社区摘要：去标签并还原实体', cmFmt.stripHtml('<p>Hello&nbsp;<strong>world</strong> &amp; more</p>'), 'Hello world & more');
eq('社区摘要：脚本内容整段丢弃', cmFmt.stripHtml('<script>alert(1)</script><p>安全</p>'), '安全');
eq('社区摘要：超长截断补省略号', cmFmt.stripHtml('a'.repeat(20), 10), 'aaaaaaaaaa…');
eq('社区摘要：空值兜底', cmFmt.stripHtml(null), '');

eq('社区短码：已知短码换 emoji', cmFmt.decodeShortcodes(':tada: 新版本'), '🎉 新版本');
eq('社区短码：不误伤时间', cmFmt.decodeShortcodes('12:30:45'), '12:30:45');
eq('社区短码：未知短码去掉冒号段', cmFmt.decodeShortcodes('a:unknown:b'), 'ab');
eq('社区头像：相对路径补全域名并替换尺寸', cmFmt.avatarUrl('/user_avatar/forum.trae.cn/x/{size}/1.png', 48), `${cmFmt.FORUM_BASE}/user_avatar/forum.trae.cn/x/48/1.png`);
eq('社区头像：绝对地址原样', cmFmt.avatarUrl('https://cdn.example.com/a.png'), 'https://cdn.example.com/a.png');
eq('社区头像：空值返回 null', cmFmt.avatarUrl(null), null);
eq('社区分类颜色：合法十六进制保留', cmFmt.safeCategoryColor('#ff0000'), '#ff0000');
eq('社区分类颜色：三位简写保留', cmFmt.safeCategoryColor('#abc'), '#abc');
eq('社区分类颜色：非法值回品牌色', cmFmt.safeCategoryColor('red'), cmFmt.DEFAULT_CATEGORY_COLOR);
eq('社区用户名：@ 前缀', cmFmt.parseUsernameInput('@迟迟'), '迟迟');
eq('社区用户名：主页链接', cmFmt.parseUsernameInput('https://forum.trae.cn/u/迟迟/summary'), '迟迟');
eq('社区用户名：带 .json', cmFmt.parseUsernameInput('迟迟.json'), '迟迟');
eq('社区用户名：空输入', cmFmt.parseUsernameInput('   '), '');

/* =============================================
   ====== Trae 社区：分类 / 主题 / 字段兜底 ======
   ============================================= */
const cmCatRaw = {
  category_list: {
    categories: [
      { id: 1, name: '公告', color: '#ff0000', subcategory_ids: [2], topic_count: 10 },
      { id: 2, name: '版本', parent_category_id: 1, color: 'not-a-color' },
      { id: 0, name: '坏分类' },
    ],
  },
};
const cmCats = cmFmt.normalizeCategories(cmCatRaw);
eq('社区分类：丢弃非法 id', cmCats.map((c) => c.id), [1, 2]);
eq('社区分类：非法颜色回品牌色', cmCats[1].color, cmFmt.DEFAULT_CATEGORY_COLOR);
eq('社区分类：一级分类只留无父级的', cmFmt.topLevelCategories(cmCats).map((c) => c.id), [1]);
eq('社区分类：筛选父分类带出子分类', cmFmt.categoryScopeIds(1, cmCats), [1, 2]);
eq('社区分类：不筛选返回 null', cmFmt.categoryScopeIds(null, cmCats), null);
eq('社区分类：直接命中子分类自身', cmFmt.categoryOf(2, cmCats)?.id, 2);
eq('社区分类：未知分类返回 null', cmFmt.categoryOf(99, cmCats), null);

const cmLatestRaw = {
  users: [
    { id: 7, username: 'alice', name: 'Alice', avatar_template: '/user_avatar/forum.trae.cn/alice/{size}/1.png', moderator: true },
  ],
  topic_list: {
    topics: [
      {
        id: 11,
        fancy_title: ':tada: 新版本发布',
        excerpt: '<p>更新内容</p>',
        category_id: 2,
        pinned_globally: true,
        posts_count: 3,
        like_count: 10,
        views: 100,
        bumped_at: '2026-11-06T10:00:00Z',
        posters: [{ user_id: 7 }, { user_id: -1 }],
      },
      { id: 12, title: '', category_id: 99 },
      { id: 0, title: '坏主题' },
    ],
  },
};
const cmNormalized = cmFmt.normalizeLatest(cmLatestRaw, cmCats);
const cmT11 = cmNormalized.topics[0];
const cmT12 = cmNormalized.topics[1];
eq('社区主题：丢弃非法 id', cmNormalized.topics.map((t) => t.id), [11, 12]);
eq('社区主题：短码解码', cmT11.title, '🎉 新版本发布');
eq('社区主题：摘要去 HTML', cmT11.excerpt, '更新内容');
eq('社区主题：父分类名带出', cmT11.categoryName, '版本');
ok('社区主题：pinned_globally 也算置顶', cmT11.pinned);
eq('社区主题：作者来自 posters + users', cmT11.author?.username, 'alice');
ok('社区主题：版主标记归一', cmT11.author?.staff === true);
eq('社区主题：缺标题兜底', cmT12.title, '无标题主题');
eq('社区主题：未知分类兜底', cmT12.categoryName, '未分类');
eq('社区主题：缺分类颜色回品牌色', cmT12.categoryColor, cmFmt.DEFAULT_CATEGORY_COLOR);
eq('社区主题：缺作者不 panic', cmT12.author, null);
eq('社区主题：缺标签兜底空数组', cmT12.tags, []);
eq('社区主题：缺时间兜底 null', cmT12.bumpedAt, null);
eq('社区主题：缺计数归零', [cmT12.postsCount, cmT12.replyCount, cmT12.views, cmT12.likeCount], [0, 0, 0, 0]);
ok('社区主题：pinned_globally 单独保留（排序用）', cmT11.pinnedGlobally);
eq('社区分页：缺 more_topics_url 视为到底', cmNormalized.moreTopicsUrl, null);
eq('社区分页：匿名态 can_create_topic=false', cmNormalized.canCreateTopic, false);
const cmPageRaw = { topic_list: { topics: [{ id: 13, title: '下一页' }], more_topics_url: '/latest?no_definitions=true&page=2', can_create_topic: false } };
const cmPage = cmFmt.normalizeLatest(cmPageRaw, cmCats);
eq('社区分页：more_topics_url 原样带回', cmPage.moreTopicsUrl, '/latest?no_definitions=true&page=2');

const cmBaseTopic: TopicSummary = {
  id: 1,
  title: '主题',
  excerpt: '',
  categoryId: null,
  categoryName: '未分类',
  categoryColor: cmFmt.DEFAULT_CATEGORY_COLOR,
  author: null,
  posters: [],
  postsCount: 1,
  replyCount: 0,
  views: 0,
  likeCount: 0,
  tags: [],
  pinned: false,
  pinnedGlobally: false,
  closed: false,
  archived: false,
  hasAcceptedAnswer: false,
  createdAt: null,
  lastPostedAt: null,
  bumpedAt: null,
  imageUrl: null,
};
const cmTopic = (patch: Partial<TopicSummary>): TopicSummary => ({ ...cmBaseTopic, ...patch });
eq('社区分页：追加时按 id 去重且保留顺序', cmFmt.appendTopics([cmTopic({ id: 1 }), cmTopic({ id: 2 })], [cmTopic({ id: 2 }), cmTopic({ id: 3 })]).map((t) => t.id), [1, 2, 3]);

const cmList = [
  cmTopic({ id: 1, pinned: true, categoryId: 1, bumpedAt: '2026-11-01T00:00:00Z' }),
  cmTopic({ id: 2, pinned: true, categoryId: 2, bumpedAt: '2026-11-02T00:00:00Z' }),
  cmTopic({ id: 3, categoryId: 1, bumpedAt: '2026-11-03T00:00:00Z', likeCount: 100, postsCount: 3, views: 1000 }),
  cmTopic({ id: 4, categoryId: 2, bumpedAt: '2026-11-05T00:00:00Z' }),
  cmTopic({ id: 5, categoryId: 1, title: '别的主题', bumpedAt: '2026-11-04T00:00:00Z' }),
];
const cmGroup = (mode: 'latest' | 'hot' | 'unread' | 'following', patch: { categoryId?: number | null; query?: string; following?: number[]; readIds?: number[] } = {}) =>
  cmFmt.groupTopics(cmList, {
    mode,
    categoryId: patch.categoryId ?? null,
    categories: cmCats,
    query: patch.query ?? '',
    following: patch.following ?? [],
    readIds: patch.readIds ?? [],
  });

const cmLatestGroup = cmGroup('latest', { categoryId: 1 });
/* 筛父分类会带出子分类：分类 1 的主题 + 子分类 2 的主题一起出现 */
eq('社区分组：置顶跟随分类（父分类带出子分类）', cmLatestGroup.pinned.map((t) => t.id), [2, 1]);
eq('社区分组：普通主题按最后回复倒序', cmLatestGroup.rest.map((t) => t.id), [4, 5, 3]);
eq('社区分组：视图顺序置顶在前', cmFmt.flattenGroups(cmLatestGroup).map((t) => t.id), [2, 1, 4, 5, 3]);
eq('社区分组：关注视图不显示置顶', cmGroup('following', { following: [4] }).pinned, []);
eq('社区分组：关注视图只留关注项', cmGroup('following', { following: [4] }).rest.map((t) => t.id), [4]);
eq('社区分组：未读过滤已读', cmGroup('unread', { readIds: [4, 5] }).rest.map((t) => t.id), [3]);
eq('社区分组：热门按热度排序', cmGroup('hot').rest.map((t) => t.id), [3, 4, 5]);
eq('社区分组：搜索收敛置顶与列表', cmGroup('latest', { query: '别的' }).pinned, []);
eq('社区分组：搜索命中标题', cmGroup('latest', { query: '别的' }).rest.map((t) => t.id), [5]);
ok('社区热度：点赞×3 + 回复×2 + 浏览×0.15', Math.abs(cmFmt.hotScore(cmList[2]) - (300 + 4 + 150)) < 1e-9);
ok('社区搜索：空查询全通过', cmFmt.matchesQuery(cmBaseTopic, '  '));
ok('社区搜索：大小写不敏感并覆盖作者', cmFmt.matchesQuery(cmTopic({ title: 'Hello', author: { id: 1, username: 'alice', name: 'Alice', avatar: null, staff: false } }), 'alice'));
eq('社区游标：空列表返回 null', cmFmt.moveCursor(null, [], 'next'), null);
eq('社区游标：无选中时下一项取首个', cmFmt.moveCursor(null, [3, 4], 'next'), 3);
eq('社区游标：无选中时上一项取末个', cmFmt.moveCursor(null, [3, 4], 'prev'), 4);
eq('社区游标：到末尾不越界', cmFmt.moveCursor(4, [3, 4], 'next'), 4);
eq('社区游标：到开头不越界', cmFmt.moveCursor(3, [3, 4], 'prev'), 3);
eq('社区游标：当前项不在列表时回落到首项', cmFmt.moveCursor(99, [3, 4], 'next'), 3);

/* 置顶轨道换成 featured 标签的 4 条后，旧 pinned 字段里的公告（id=2）不能被吞掉 */
const cmRail = [
  cmTopic({ id: 4, categoryId: 2 }),
  cmTopic({ id: 1, pinned: true, pinnedGlobally: true, categoryId: 1 }),
];
const cmRailGroup = cmFmt.groupTopics(cmList, {
  mode: 'latest',
  categoryId: null,
  categories: cmCats,
  query: '',
  following: [],
  readIds: [],
  pinnedOverride: cmRail,
});
eq('社区置顶：override 决定置顶轨道', cmRailGroup.pinned.map((t) => t.id), [1, 4]);
eq('社区置顶：不在轨道的 pinned 仍进普通列表', cmRailGroup.rest.map((t) => t.id), [5, 3, 2]);
eq('社区置顶：选中标签时不展示置顶', cmFmt.groupTopics(cmList, {
  mode: 'latest',
  categoryId: null,
  categories: cmCats,
  query: '',
  following: [],
  readIds: [],
  pinnedOverride: [],
}).pinned, []);

/* 真实 /tags.json 的两批标签互不重叠，必须合并后展示 */
const cmTagsRaw = {
  tags: [
    { id: 42, text: 'featured', name: 'featured', slug: '42-tag', count: 4 },
    { id: 16, text: '活动回顾', name: '活动回顾', count: 28 },
    { id: 73, text: '65-tag', name: '65-tag', count: 0 },
    { id: 0, name: '  ' },
  ],
  extras: {
    tag_groups: [
      { id: 5, name: '互动话题', tags: [{ id: 26, text: 'TRAE今日打卡', name: 'TRAE今日打卡', count: 12 }, { id: 16, text: '活动回顾', name: '活动回顾', count: 30 }] },
      { id: 6, name: '空分组', tags: [] },
    ],
  },
};
const cmTags = cmFmt.normalizeTags(cmTagsRaw);
eq('社区标签：两批标签合并去重后按计数倒序', cmTags.flat.map((t) => t.name), ['活动回顾', 'TRAE今日打卡', 'featured', '65-tag']);
eq('社区标签：重复标签取较大计数', cmTags.flat[0].count, 30);
eq('社区标签：空分组不展示', cmTags.groups.map((g) => g.name), ['互动话题']);
eq('社区标签：组内按计数倒序', cmTags.groups[0].tags.map((t) => t.name), ['活动回顾', 'TRAE今日打卡']);
eq('社区标签：未分组标签单独列出', cmTags.ungrouped.map((t) => t.name), ['featured', '65-tag']);
ok('社区标签：拿到分组时 grouped=true', cmTags.grouped);
const cmTagsFlatOnly = cmFmt.normalizeTags({ tags: [{ id: 1, name: '日常' }] });
ok('社区标签：无分组时标记 grouped=false 以便平铺', cmTagsFlatOnly.grouped === false);

/* =============================================
   ====== Trae 社区：正文清洗（XSS 用例） ======
   ============================================= */
eq('社区正文：script 整段删除', cmSanitize.sanitizeCookedHtml('<script>alert(1)</script><p>安全</p>'), '<p>安全</p>');
eq('社区正文：style 整段删除', cmSanitize.sanitizeCookedHtml('<style>body{display:none}</style><p>x</p>'), '<p>x</p>');
eq('社区正文：注释删除', cmSanitize.sanitizeCookedHtml('<!-- 注释 --><p>y</p>'), '<p>y</p>');
eq('社区正文：事件属性丢弃', cmSanitize.sanitizeCookedHtml('<p onclick="alert(1)">x</p>'), '<p>x</p>');
eq('社区正文：javascript 协议丢弃', cmSanitize.sanitizeCookedHtml('<a href="javascript:alert(1)">x</a>'), '<a>x</a>');
eq('社区正文：实体编码的 javascript 协议也丢弃', cmSanitize.sanitizeCookedHtml('<a href="javascript&#58;alert(1)">x</a>'), '<a>x</a>');
eq('社区正文：未知标签只留文字', cmSanitize.sanitizeCookedHtml('<foo>bar</foo>'), 'bar');
eq('社区正文：安全外链补 noopener', cmSanitize.sanitizeCookedHtml('<a href="https://forum.trae.cn/t/1">看</a>'), '<a href="https://forum.trae.cn/t/1" target="_blank" rel="noopener noreferrer nofollow">看</a>');
eq('社区正文：图片补懒加载并丢事件', cmSanitize.sanitizeCookedHtml('<img src="https://example.com/a.png" onerror="alert(1)" alt="图">'), '<img src="https://example.com/a.png" alt="图" loading="lazy" referrerpolicy="no-referrer">');
eq('社区正文：缺 src 的图片丢弃', cmSanitize.sanitizeCookedHtml('<img alt="x">'), '');
eq('社区正文：data 协议图片丢弃', cmSanitize.sanitizeCookedHtml('<img src="data:image/png;base64,AAA">'), '');
eq('社区正文：代码块保留语言 class', cmSanitize.sanitizeCookedHtml('<pre><code class="lang-js">x</code></pre>'), '<pre><code class="lang-js">x</code></pre>');
eq('社区正文：表格数字属性保留', cmSanitize.sanitizeCookedHtml('<table><tr><td colspan="2">x</td></tr></table>'), '<table><tr><td colspan="2">x</td></tr></table>');
eq('社区正文：空值返回空串', cmSanitize.sanitizeCookedHtml(null), '');

/* =============================================
   ====== Trae 社区：本地缓存与偏好 ======
   ============================================= */
globalThis.localStorage.removeItem(cmCache.COMMUNITY_CACHE_KEY);
ok('社区缓存：空缓存读 null', cmCache.readCache() === null);
const cmSavedAt = cmCache.writeCache(
  { topic_list: { topics: [{ id: 1, title: '缓存主题' }] } },
  { category_list: { categories: [{ id: 1, name: '公告' }] } },
  1234,
);
ok('社区缓存：写入返回时间戳', cmSavedAt === 1234);
const cmLoadedCache = cmCache.readCache();
ok('社区缓存：能读回原始响应', cmLoadedCache?.savedAt === 1234
  && cmLoadedCache.latest.topic_list?.topics?.[0]?.id === 1
  && cmLoadedCache.categories.category_list?.categories?.[0]?.name === '公告');
globalThis.localStorage.setItem(cmCache.COMMUNITY_CACHE_KEY, '{bad json');
ok('社区缓存：坏 JSON 当没有缓存', cmCache.readCache() === null);
globalThis.localStorage.setItem(cmCache.COMMUNITY_CACHE_KEY, JSON.stringify({ version: 99, savedAt: 1, latest: {}, categories: {} }));
ok('社区缓存：版本不符丢弃', cmCache.readCache() === null);
globalThis.localStorage.setItem(cmCache.COMMUNITY_CACHE_KEY, JSON.stringify({ version: 1, savedAt: 1, latest: {}, categories: {} }));
ok('社区缓存：结构不全丢弃', cmCache.readCache() === null);
cmCache.clearCache();
ok('社区缓存：清空后读 null', cmCache.readCache() === null);

globalThis.localStorage.removeItem(cmPrefs.COMMUNITY_PREFS_KEY);
eq('社区偏好：默认值', cmPrefs.readPrefs(), cmPrefs.EMPTY_PREFS);
globalThis.localStorage.setItem(
  cmPrefs.COMMUNITY_PREFS_KEY,
  JSON.stringify({ readIds: [1, 1, -2, '3', 'x'], following: [9], myUsername: '  迟迟 ', seeded: 1 }),
);
const cmLoadedPrefs = cmPrefs.readPrefs();
eq('社区偏好：已读去重并过滤非法 id', cmLoadedPrefs.readIds, [1, 3]);
eq('社区偏好：关注保留合法 id', cmLoadedPrefs.following, [9]);
eq('社区偏好：用户名去空白', cmLoadedPrefs.myUsername, '迟迟');
ok('社区偏好：seeded 归一为布尔', cmLoadedPrefs.seeded === true);
globalThis.localStorage.setItem(cmPrefs.COMMUNITY_PREFS_KEY, 'not json');
eq('社区偏好：坏数据回落默认值', cmPrefs.readPrefs(), cmPrefs.EMPTY_PREFS);
cmPrefs.writePrefs({ readIds: [42], following: [], myUsername: 'alice', seeded: true });
eq('社区偏好：写入后可读回', cmPrefs.readPrefs().readIds, [42]);

/* =============================================
   ====== Trae 社区：登录后的通知 / 私信 ======
   ============================================= */

eq('通知类型：回复映射', cmFmt.notificationTypeLabel(2), '回复');
eq('通知类型：私信映射', cmFmt.notificationTypeLabel(6), '私信');
eq('通知类型：点赞映射', cmFmt.notificationTypeLabel(5), '点赞');
eq('通知类型：未知类型兜底', cmFmt.notificationTypeLabel(999), '其他通知');
eq('通知类型：空值兜底', cmFmt.notificationTypeLabel(null), '其他通知');

const cmNotifs = cmFmt.normalizeNotifications({
  notifications: [
    {
      id: 101,
      notification_type: 2,
      read: false,
      created_at: '2026-11-06T02:00:00Z',
      topic_id: 464575,
      post_number: 3,
      fancy_title: '短码标题',
      data: {
        topic_title: '自定义模型持续报错4054，但新会话能够正常使用',
        display_username: 'CC3',
      },
      acting_user_avatar_template: '/user_avatar/forum.trae.cn/cc3/{size}/123_2.png',
    },
    { id: 0, notification_type: 1, read: true },
    {
      id: 102,
      notification_type: 5,
      read: true,
      created_at: '2026-11-05T12:00:00Z',
      data: { topic_title: '某主题', display_username: 'alice' },
    },
  ],
});
eq('通知归一化：过滤无效 id', cmNotifs.length, 2);
eq('通知归一化：标题优先 topic_title', cmNotifs[0].title, '自定义模型持续报错4054，但新会话能够正常使用');
eq('通知归一化：作者取自 display_username', cmNotifs[0].username, 'CC3');
eq('通知归一化：未读标记', cmNotifs[0].read, false);
eq('通知归一化：楼层号透传', cmNotifs[0].postNumber, 3);
eq('通知归一化：未读计数', cmFmt.unreadNotificationCount(cmNotifs), 1);
ok('通知归一化：头像走 CDN 模板', (cmNotifs[0].avatar ?? '').includes('/123_2.png'));

const cmChannels = cmFmt.normalizeChatChannels({
  source: 'chat',
  public_channels: [
    {
      id: 3,
      title: '官方公告',
      unread_count: 2,
      last_message: { message: '<p>欢迎</p>', created_at: '2026-11-06T01:00:00Z', username: 'CC3' },
    },
  ],
  direct_message_channels: [{ id: 9, title: '和迟迟的私信' }],
});
eq('私信频道：public 在前 direct 在后', cmChannels.map((c) => c.id), [3, 9]);
eq('私信频道：未读透传', cmChannels[0].unreadCount, 2);
eq('私信频道：HTML 摘要去标签', cmChannels[0].lastMessage, '欢迎');
ok('私信频道：direct 类型区分', cmChannels[1].kind === 'direct');
ok('私信频道：缺 last_message 不报错', cmChannels[1].lastMessage === '');

const cmMsgs = cmFmt.normalizeChatMessages({
  messages: [
    { id: 2, cooked: '<p>第二条</p>', created_at: '2026-11-06T02:00:00Z', user: { username: 'bob' } },
    {
      id: 1,
      cooked: '<p>第一条</p>',
      created_at: '2026-11-06T01:00:00Z',
      user: { username: 'alice', name: 'Alice', avatar_template: '/user_avatar/x/{size}/1.png' },
    },
  ],
});
eq('私信消息：按时间升序', cmMsgs.map((m) => m.id), [1, 2]);
eq('私信消息：缺名字回落用户名', cmMsgs[1].name, 'bob');
ok('私信消息：HTML 保留给清洗层', cmMsgs[0].html.includes('第一条'));
ok('私信消息：头像走 CDN 模板', (cmMsgs[0].avatar ?? '').includes('/1.png'));

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail > 0) process.exit(1);
