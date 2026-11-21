/*
 * 智能体余额模块 · 主体视图
 * ------------------------------------------------------------------
 * 展示各 AI 平台（ChatGPT / OpenAI / Claude / Gemini / Trae / WorkBuddy）的
 * 余额或用量；凭证加密保存在本地，仅在刷新时经后端调用各平台接口。
 * 连上 AI-Passport 蓝牙时可把余额摘要推送到徽章。
 *
 * 状态来自 balances_* 命令（见 ipc.ts）；蓝牙状态来自 aipassport 公开契约（见 bridge.ts）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  App as AntApp,
  Alert,
  Button,
  Card,
  Checkbox,
  Empty,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Slider,
  Space,
  Switch,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  ReloadOutlined,
  SettingOutlined,
  DeleteOutlined,
  SendOutlined,
  WalletOutlined,
  EditOutlined,
  SlidersOutlined,
  ClearOutlined,
  CloudDownloadOutlined,
} from '@ant-design/icons';
import * as ipc from './ipc';
import { useBalancesStore } from './store';
import {
  AUTO_REFRESH_OPTIONS,
  DEFAULT_TRAY_ICON_SCALE,
  MAX_REFRESH_MIN,
  MAX_TRAY_ICON_SCALE,
  MIN_REFRESH_MIN,
  MIN_TRAY_ICON_SCALE,
  TRAY_ICON_SCALE_STEP,
  useBalancesPrefs,
} from './prefs';
import { ALERT_THRESHOLDS, alertStatus, resetAlerts } from './alerts';
import {
  currentBadgeSources,
  currentBadgeSummary,
  currentTraySources,
  pushBadgeNow,
  pushSummaryFor,
  pushTestAlert,
  refreshBalances,
  refreshProviderBalances,
  useBalancesRuntime,
} from './service';
import {
  TRAY_ITEM_BUDGET_COLS,
  buildTrayItems,
  compactValue,
  displayWidth,
  glyphOf,
  providerShort,
  trayFieldOptions,
} from './tray';
import type { TrayItem, TraySource } from './tray';
import { hasBrandLogo, trayIconDataUrl } from './icons';
import { useWorkbenchStore } from '@/store/useWorkbenchStore';
import { getPalette } from '@/core/theme';
import {
  clockAt,
  formatCountdown,
  formatPushedAt,
  formatRefreshedAt,
  healthColor,
  isUsageLabel,
  itemHealth,
  metricValueKind,
  percentOf,
  sortItems,
  BODY_MAX,
  byteLen,
  TREND_GRANULARITY_OPTIONS,
} from './format';
import type { TrendGranularity } from './format';
import { pickHomeMetric } from './snapshot';
import type { AgentBalance, ProviderMeta } from './types';
import './balances.css';

const { Text } = Typography;

/**
 * 间隔下拉里「自定义…」那一项的哨兵值。
 * 取负数：真实间隔都是正数，不可能撞上。
 */
const CUSTOM_INTERVAL = -1;
/** 单平台间隔下拉里「跟随全局」那一项的哨兵值 */
const FOLLOW_GLOBAL = -1;

/**
 * 预览里的一格：图标 + 文字，形如菜单栏上的一个状态项。
 *
 * 图标用的是**与真实推送同一份位图**（icons.trayIconDataUrl 内部复用
 * trayIconBitmap 的缓存），只是按当前主题上了个可见的颜色 ——
 * 真实菜单栏上的颜色由系统按前景色决定，与主题无关（模板图）。
 * 若这里另画一个 SVG，就会出现「预览和菜单栏长得不一样」，
 * 而那类不一致极难发现。
 *
 * 固定 18px 的方框里放位图，**不是**把方框按 scale 一起缩 ——
 * 真实的菜单栏格子（18pt）也不会变，变的是图形在格子里占多大。
 * 两者用同一套几何，预览才有意义。
 */
const TrayPreviewChip: React.FC<{ item: TrayItem; color: string; scale: number }> = ({
  item,
  color,
  scale,
}) => {
  const url = item.glyph ? trayIconDataUrl(item.key, item.glyph, color, scale) : null;
  return (
    <span className="balances-tray-chip" title={item.tooltip}>
      {url && (
        <img
          className="balances-tray-chip-icon"
          src={url}
          width={18}
          height={18}
          alt=""
          draggable={false}
        />
      )}
      <span>{item.title}</span>
    </span>
  );
};

/**
 * 「自动刷新」页里每个平台一行：下拉选「跟随全局 / 每 N 分钟 / 自定义…」，
 * 选「自定义…」后再出现一个输入框。覆盖值存进 providerRefreshMin，
 * 删掉覆盖（选回「跟随全局」）即恢复共用全局默认。
 */
const ProviderIntervalRow: React.FC<{
  provider: string;
  name: string;
  override?: number;
  globalDefault: number;
  disabled: boolean;
}> = ({ provider, name, override, globalDefault, disabled }) => {
  const setProviderRefreshMin = useBalancesPrefs((s) => s.setProviderRefreshMin);
  const [customMode, setCustomMode] = useState(false);
  const isPreset =
    override !== undefined && (AUTO_REFRESH_OPTIONS as readonly number[]).includes(override);
  const selectValue = override === undefined ? FOLLOW_GLOBAL : isPreset ? override : CUSTOM_INTERVAL;
  const showCustom = customMode || (override !== undefined && !isPreset);
  return (
    <div className="balances-provider-interval">
      <span className="balances-provider-interval-name">{name}</span>
      <Select
        size="small"
        className="balances-config-select"
        value={selectValue}
        disabled={disabled}
        onChange={(v) => {
          if (v === FOLLOW_GLOBAL) {
            setCustomMode(false);
            setProviderRefreshMin(provider, null);
          } else if (v === CUSTOM_INTERVAL) {
            setCustomMode(true);
          } else {
            setCustomMode(false);
            setProviderRefreshMin(provider, v);
          }
        }}
        options={[
          { value: FOLLOW_GLOBAL, label: `跟随全局（${globalDefault} 分钟）` },
          ...AUTO_REFRESH_OPTIONS.map((v) => ({ value: v, label: `每 ${v} 分钟` })),
          { value: CUSTOM_INTERVAL, label: '自定义…' },
        ]}
      />
      {showCustom && (
        <InputNumber
          size="small"
          className="balances-config-number"
          min={MIN_REFRESH_MIN}
          max={MAX_REFRESH_MIN}
          value={override ?? globalDefault}
          disabled={disabled}
          onChange={(v) => {
            /* 清空输入框时 v 是 null：保持原值，别把间隔写成 0 */
            if (typeof v === 'number') setProviderRefreshMin(provider, v);
          }}
          addonAfter="分钟"
        />
      )}
    </div>
  );
};

const BalancesView: React.FC = () => {
  const { message } = AntApp.useApp();

  const providers = useBalancesStore((s) => s.providers);
  const balances = useBalancesStore((s) => s.balances);
  const loading = useBalancesStore((s) => s.loading);
  const setProviders = useBalancesStore((s) => s.setProviders);
  const setLoading = useBalancesStore((s) => s.setLoading);
  const codexAvailable = useBalancesStore((s) => s.codexAvailable);
  const setCodex = useBalancesStore((s) => s.setCodex);

  /*
   * 只读内存里的主密钥，**绝不主动 ensureMasterKey()**。
   * 工作台约定：钥匙串授权框只在进入 LogSight 解密服务器密码/私钥时出现；
   * 余额面板日常刷新走 ~/.codex/auth.json，完全不需要密钥。
   */
  const masterKey = useWorkbenchStore((s) => s.masterKey);
  /* 百分比颜色要按底色选亮度，所以得知道当前主题（见 format.healthColor） */
  const theme = useWorkbenchStore((s) => s.theme);

  /* 用户偏好：显示哪些卡片 + 首页固定展示哪个 + 是否自动推送 */
  const visibleProviders = useBalancesPrefs((s) => s.visibleProviders);
  const setVisibleProviders = useBalancesPrefs((s) => s.setVisibleProviders);
  /*
   * 推到徽章的摘要里包含哪些平台。
   * **独立于面板显示**（见 prefs.pushProviders 的说明）：面板可以铺满一屏，
   * 而徽章正文只有 95 字节，通常只放最关心的两三个。
   */
  const pushProviders = useBalancesPrefs((s) => s.pushProviders);
  const setPushProviders = useBalancesPrefs((s) => s.setPushProviders);
  const homePinnedProvider = useBalancesPrefs((s) => s.homePinnedProvider);
  const setHomePinned = useBalancesPrefs((s) => s.setHomePinned);
  /*
   * 首页格子的「走势跟哪个指标」「聚合粒度」。
   * 这两个偏好以前**只有首页在读、没有任何界面能写** —— 首页展示什么内容
   * 因此实际上不可配置。现在收进「首页」页签，与菜单栏那页并列。
   */
  const trendMetric = useBalancesPrefs((s) => s.trendMetric);
  const setTrendMetric = useBalancesPrefs((s) => s.setTrendMetric);
  const trendGranularity = useBalancesPrefs((s) => s.trendGranularity);
  const setTrendGranularity = useBalancesPrefs((s) => s.setTrendGranularity);
  const autoPush = useBalancesPrefs((s) => s.autoPush);
  const setAutoPush = useBalancesPrefs((s) => s.setAutoPush);
  const autoRefresh = useBalancesPrefs((s) => s.autoRefresh);
  const setAutoRefresh = useBalancesPrefs((s) => s.setAutoRefresh);
  const autoRefreshIntervalMin = useBalancesPrefs((s) => s.autoRefreshIntervalMin);
  const setAutoRefreshInterval = useBalancesPrefs((s) => s.setAutoRefreshInterval);
  const providerRefreshMin = useBalancesPrefs((s) => s.providerRefreshMin);
  /* 是否把「使用 / 剩余额度」显示到系统菜单栏（macOS 顶部状态栏） */
  const trayEnabled = useBalancesPrefs((s) => s.trayEnabled);
  const setTrayEnabled = useBalancesPrefs((s) => s.setTrayEnabled);
  /*
   * 菜单栏显示哪些平台 + 每个平台用哪个指标 / 哪个名字 / 要不要图标
   * （配置界面见下方「在系统菜单栏显示」块）
   */
  const trayProviders = useBalancesPrefs((s) => s.trayProviders);
  const setTrayProviders = useBalancesPrefs((s) => s.setTrayProviders);
  const trayFields = useBalancesPrefs((s) => s.trayFields);
  const setTrayField = useBalancesPrefs((s) => s.setTrayField);
  const trayLabels = useBalancesPrefs((s) => s.trayLabels);
  const setTrayLabel = useBalancesPrefs((s) => s.setTrayLabel);
  const trayIconOff = useBalancesPrefs((s) => s.trayIconOff);
  const setTrayIconVisible = useBalancesPrefs((s) => s.setTrayIconVisible);
  const trayIconScale = useBalancesPrefs((s) => s.trayIconScale);
  const setTrayIconScale = useBalancesPrefs((s) => s.setTrayIconScale);

  /*
   * 间隔是否处于「自定义」模式。
   * 两个判据缺一不可：值不在预设集合里（本来就是自定义值），
   * **或**用户刚点了「自定义…」—— 后者必须单独记，因为此时值可能恰好是预设（如 15），
   * 光看值判断不出他想自定义。
   */
  const [intervalCustomMode, setIntervalCustomMode] = useState(false);
  /** 正在单独刷新的平台 id（每张卡片一个刷新按钮） */
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const intervalIsPreset = (AUTO_REFRESH_OPTIONS as readonly number[]).includes(
    autoRefreshIntervalMin,
  );
  const showCustomInterval = intervalCustomMode || !intervalIsPreset;

  /*
   * 蓝牙连接状态与「上次推送于 …」来自模块级常驻服务（service.ts）。
   * 订阅、自动推送都在那里，面板只负责显示 —— 这样即使从没打开过本模块，
   * 徽章连上时也会自动推送。
   */
  const bleConnected = useBalancesRuntime((s) => s.bleConnected);
  const lastPushedAt = useBalancesRuntime((s) => s.lastPushedAt);
  const pushing = useBalancesRuntime((s) => s.pushing);
  const nextRefreshAt = useBalancesRuntime((s) => s.nextRefreshAt);
  const providerNextRefresh = useBalancesRuntime((s) => s.providerNextRefresh);

  const [showConfig, setShowConfig] = useState(false);
  /*
   * 已提醒的档位不是响应式的（alerts.ts 是纯逻辑模块，刻意不进 zustand），
   * 所以在打开弹窗时快照一次即可 —— 弹窗开着的时候不会有人去改它。
   */
  const [alertRows, setAlertRows] = useState<ReturnType<typeof alertStatus>>([]);
  useEffect(() => {
    if (showConfig) setAlertRows(alertStatus());
  }, [showConfig]);
  /* 上一次刷新实际用的密钥；undefined = 还没刷新过（用于识别「密钥刚被解锁」） */
  const usedKeyRef = useRef<string | null | undefined>(undefined);
  /* 定时重渲染，让「刷新于 … 分钟前」保持准确 */
  const [, setTick] = useState(0);
  const [editing, setEditing] = useState<ProviderMeta | null>(null);
  /*
   * 凭证输入值：**按字段 key 存**，而不是写死一个 tokenInput。
   * 字段表由后端声明（ChatGPT 一条 access_token，Trae 两条 authorization + cookie），
   * 前端照着渲染并原样提交 —— 新增多字段平台时这里不用改。
   */
  const [credInputs, setCredInputs] = useState<Record<string, string>>({});
  const [accountIdInput, setAccountIdInput] = useState('');
  const [saving, setSaving] = useState(false);
  /* 「一键抓取」进行中（最长约 2 分钟，按钮要有明确的等待态） */
  const [grabbing, setGrabbing] = useState(false);
  const [manualEditing, setManualEditing] = useState<ProviderMeta | null>(null);
  const [manualLabel, setManualLabel] = useState('余额');
  const [manualValue, setManualValue] = useState('');

  /* 拉取余额；mk 省略时用内存里的主密钥（可能为 null，后端会自行降级到 Codex 凭证） */
  const doRefresh = useCallback(
    async (mk?: string | null) => {
      setLoading(true);
      try {
        const key = mk !== undefined ? mk : masterKey;
        usedKeyRef.current = key;
        /* 走 service 的刷新入口：结果会同时写回模块状态与前端快照 */
        await refreshBalances(key);
      } catch (e) {
        message.error((e as Error).message || '刷新失败');
      } finally {
        setLoading(false);
      }
    },
    [masterKey, setLoading, message],
  );

  /* 首次进入：拉平台列表 → 探测 Codex → 刷新（全程不碰钥匙串） */
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [provs, codex] = await Promise.all([
          ipc.listProviders(),
          ipc.autodetectCodex().catch(() => false),
        ]);
        if (!alive) return;
        setProviders(provs);
        setCodex(codex);
        await doRefresh();
      } catch (e) {
        if (alive) message.error((e as Error).message || '初始化失败');
      }
    })();
    return () => {
      alive = false;
    };
    // 仅首次挂载执行
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /*
   * 用户在别处（设置 → 本地密钥）解锁了主密钥后，自动用密钥再刷一次，
   * 把「已保存但加密的凭证」也解出来。首次挂载时 usedKeyRef 还是 undefined，
   * 不会重复触发。
   */
  useEffect(() => {
    if (usedKeyRef.current === undefined) return;
    if (masterKey && masterKey !== usedKeyRef.current) {
      doRefresh(masterKey).catch(() => {});
    }
  }, [masterKey, doRefresh]);

  /* 每 30 秒重渲染一次，让「刷新于 N 分钟前」自动走字 */
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => window.clearInterval(t);
  }, []);

  /* 某平台是否在面板显示（visibleProviders 为 null 表示全部显示） */
  const isVisible = useCallback(
    (id: string) => visibleProviders === null || visibleProviders.includes(id),
    [visibleProviders],
  );

  /*
   * 推送选择（设置弹窗「推送」tab 里用）。
   *
   * 候选 = **全部**平台，而不是「显示中」的子集 —— 推送与面板显示是解耦的，
   * 用户可以只把 ChatGPT 推上徽章，同时面板上照旧显示全部平台。
   *
   * 实际推送走 service.currentPushSources + buildBadgeSummary，
   * 预览走 service.pushSummaryFor（**同一个函数**）——
   * 预览与真实推送必须逐字一致，否则用户看到的预览就是骗人的。
   */
  const pushData = new Map(currentBadgeSources().map((c) => [c.provider, c]));
  const pushRows: TraySource[] = providers.map(
    (p): TraySource =>
      pushData.get(p.id) ?? { provider: p.id, name: p.name, items: [], error: null },
  );
  /*
   * 当前实际生效的推送范围。
   * `pushProviders === null` = 跟随「显示中的平台」（**含暂时没数据的**——
   * 它一旦有了数据就该被推上去，所以勾选框要按「可见」算，而不是按「现在有数据」算）；
   * 否则就是用户勾的那几个。
   * 下面 checkbox 的 value 用它 —— 呈现的永远是「现在真正会推什么」。
   */
  const pushOnIds: string[] =
    pushProviders === null
      ? providers.filter((p) => isVisible(p.id)).map((p) => p.id)
      : pushProviders;
  /** 预览结果（正文 + 谁真的进了摘要），与真实推送逐字一致 */
  const pushResult = pushSummaryFor(pushProviders);
  const pushPreview = pushResult.text;
  const pushPreviewBytes = byteLen(pushPreview);
  /** 预览是否超了固件的正文上限（95 字节）——超了就会被后端整条拒掉 */
  const pushPreviewOver = pushPreviewBytes > BODY_MAX;
  /*
   * 有几个平台**因为放不下**被丢掉了。
   *
   * 徽章正文只有 95 字节，两三个平台就满了 —— 超出部分不是被截断，
   * 而是**整块丢弃**（见 buildBadgeSummaryResult）。不把这件事说出来，
   * 用户会以为「我勾了 5 个，怎么徽章上只有 2 个」。
   *
   * 判据用打包结果里的 `included`（**平台名白名单**），而不是
   * `pushPreview.includes(c.name)`：后者是子串匹配，平台名互为前缀时
   * （比如两个都叫「XX」和「XX Pro」）会把被丢掉的那个算成「已包含」。
   * 按平台名匹配是可行的 —— included 里的名字与这里的 c.name 来自同一份数据源。
   */
  const pushDropped = pushRows.filter(
    (c) =>
      pushOnIds.includes(c.provider) &&
      c.items.length > 0 &&
      !pushResult.included.includes(c.name),
  ).length;

  /*
   * 菜单栏配置（设置弹窗里用）。
   *
   * 候选 = 「显示中」的**全部**平台（刻意不过滤菜单栏勾选），因为设置页要把没勾的
   * 平台也列出来让用户勾。取数走 service.currentTraySources —— 与实际推送同一个函数，
   * 所以下面这段预览与菜单栏上真实显示的东西必然一致（预览骗人是最难发现的问题）。
   *
   * 刻意不 memo：候选来自 store 的实时数据，用 useMemo 反而要跟着 balances /
   * 快照 / 两个偏好一起进依赖，比直接算更容易出错；平台最多十来个，代价可以忽略。
   */
  const trayCandidates = currentTraySources(null, trayFields);
  /*
   * 列表行 = 有数据的平台 + 「显示中但当前没数据」的平台。
   * 后者必须补上：一次刷新失败就让某一行从列表里消失的话，用户会以为配置丢了，
   * 而它其实只是这次没读到（数据回来那一行就恢复正常）。
   */
  const trayHave = new Set(trayCandidates.map((c) => c.provider));
  const trayRows: TraySource[] = [
    ...trayCandidates,
    ...providers
      .filter((p) => isVisible(p.id) && !trayHave.has(p.id))
      .map((p): TraySource => ({ provider: p.id, name: p.name, items: [], error: null })),
  ];
  /* 勾选上菜单栏的平台 id；偏好为 null = 跟随「显示中」的平台 */
  const trayOnIds = trayProviders ?? trayCandidates.map((c) => c.provider);
  /* 真正会出现在菜单栏上的（有数据 + 已勾选）—— 与推送走同一段逻辑 */
  const trayShown = trayCandidates.filter((c) => trayOnIds.includes(c.provider));
  /*
   * 预览的每一格。**与真实推送调用同一个 buildTrayItems**，所以下面显示什么、
   * 菜单栏上就是什么（预览骗人是最难发现的一类问题）。
   */
  const trayPreviewItems: TrayItem[] = buildTrayItems(trayShown, {
    labels: trayLabels,
    iconOff: trayIconOff,
  });
  /*
   * 文字总列宽（不含图标）。图标是固定的 18pt，折不成「列」，
   * 所以分开说而不是混进一个数里 —— 报一个算不准的数比不报更糟。
   */
  const trayPreviewCols = trayPreviewItems.reduce((n, it) => n + displayWidth(it.title), 0);
  /* 最宽的一格：预算是**每格** TRAY_ITEM_MAX_COLS（不再是所有平台共享一份） */
  const trayWidest = trayPreviewItems.reduce((n, it) => Math.max(n, displayWidth(it.title)), 0);
  /*
   * 有哪一格被截短了。数值永远不截（截掉几位就是错的），所以出现 `…`
   * 一定是名字太长 —— 提醒用户可以改短一点，或者关掉图标（关掉会补上名字，
   * 反而更容易超）。`…` 是 tray.truncateToWidth 的产物，见那边的说明。
   */
  const trayTruncated = trayPreviewItems.filter((it) => it.title.endsWith('…')).length;
  /* 勾了、也显示中，但这次挑不出可上菜单栏的指标（值认不出数值等） */
  const trayNoField = trayShown.filter(
    (c) => !trayPreviewItems.some((it) => it.key === c.provider),
  ).length;
  /*
   * 勾了、但这次连候选都不在。**两种原因要一起说**：
   *   ① 在「显示智能体」tab 里被隐藏了（菜单栏是「显示中」的子集，这是设计如此）
   *   ② 显示中，但这次没读到数据
   * 只写「没数据」的话，① 的用户会跑去查网络和凭证 —— 而其实是他自己隐藏的。
   */
  const trayMissing = trayOnIds.filter(
    (id) => !trayCandidates.some((c) => c.provider === id),
  ).length;
  /* 一格都上不去（没勾任何平台 / 勾了但都没数据） */
  const trayPreviewEmpty = trayPreviewItems.length === 0;
  /*
   * 图标预览用的前景色。**取自主题色板，不写死** —— 真实菜单栏上的图标是模板图，
   * 颜色由系统按菜单栏前景色决定；这里的颜色只影响设置页里的预览观感，
   * 但它必须跟着主题走，否则浅色主题下白底图标会看不见。
   * 色板来自 core/theme 的 getPalette —— 那正是为「在 canvas 里手绘取色」留的扩展点。
   */
  const trayGlyphColor = getPalette(theme).textPrimary;

  /** 勾选/取消某平台是否上菜单栏（全选时收敛回 null，语义 = 跟随「显示中」） */
  const toggleTrayProvider = useCallback(
    (id: string, checked: boolean) => {
      const order = trayCandidates.map((c) => c.provider);
      const next = order.filter((pid) => (pid === id ? checked : trayOnIds.includes(pid)));
      setTrayProviders(next.length === order.length ? null : next);
    },
    [trayCandidates, trayOnIds, setTrayProviders],
  );

  /*
   * 手动推送。摘要的打包与去重都在 service.ts 里 —— 自动推送和手动推送
   * 用的是同一份口径（含哪些平台由「推送」页的勾选决定），不会出现两处不一致。
   */
  const doPush = useCallback(async () => {
    if (!currentBadgeSummary()) {
      message.warning('暂无可推送的余额数据，请先刷新');
      return;
    }
    try {
      await pushBadgeNow();
      message.success('已推送到 AI-Passport');
    } catch (e) {
      message.error((e as Error).message || '推送失败');
    }
  }, [message]);

  /*
   * 测试提醒：额度提醒要真的把额度耗到 50% 以下才触发，用户没法主动验证通道通不通，
   * 所以给一个「现在就发一条」的按钮（不参与已提醒记账）。
   */
  const handleTestAlert = useCallback(async () => {
    try {
      await pushTestAlert();
      message.success('已推送测试提醒到徽章');
    } catch (e) {
      message.error((e as Error).message || '推送失败');
    }
  }, [message]);

  const handleResetAlerts = useCallback(() => {
    resetAlerts();
    setAlertRows([]);
    message.success('已清空提醒记录，下一轮刷新会重新评估');
  }, [message]);

  const handleSave = async () => {
    if (!editing) return;
    /*
     * 必填校验**按后端声明的字段表**走（不只是「非空」）：
     * Trae 两段登录态缺一段都拿不到数，只提示「access_token 不能为空」
     * 那种写法在多字段平台下就完全对不上了。
     */
    const missing = editing.credential_fields.find(
      (f) => f.required && !(credInputs[f.key] ?? '').trim(),
    );
    if (missing) {
      message.warning(`请填写「${missing.label}」`);
      return;
    }
    /*
     * 保存凭证必须加密，所以这里需要主密钥。但**不主动去要**——
     * 主动要会弹钥匙串授权框，而余额模块不该弹。
     * 改为提示用户到设置页显式解锁（那是一次明确的用户动作）。
     */
    if (!masterKey) {
      message.warning(
        '保存凭证需要先解锁本地主密钥：请到「设置 → 本地密钥」点「重试」。日常查看余额不需要密钥。',
      );
      return;
    }
    setSaving(true);
    try {
      const mk = masterKey;
      /* 只提交该平台声明的字段（多提交的键会一起加密进凭证表，没有意义） */
      const fields: Record<string, string> = {};
      for (const f of editing.credential_fields) {
        fields[f.key] = (credInputs[f.key] ?? '').trim();
      }
      await ipc.saveCredential(editing.id, fields, accountIdInput.trim() || null, mk);
      message.success(`已保存 ${editing.name} 凭证`);
      setEditing(null);
      setCredInputs({});
      setAccountIdInput('');
      const provs = await ipc.listProviders();
      setProviders(provs);
      await doRefresh(mk);
    } catch (e) {
      message.error((e as Error).message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  /*
   * 「一键抓取」网页登录态。
   * 前端拿到的是字段表（键与 credential_fields 一致），直接回填到表单 ——
   * **不自动保存**：让用户看一眼抓到了什么、再点「保存」，比替他做主更稳妥
   * （抓错账号、抓到了别的站点登录态这种事，用户一眼能看出来）。
   */
  const handleGrab = async () => {
    if (!editing) return;
    setGrabbing(true);
    try {
      const fields = await ipc.grabSession(editing.id);
      setCredInputs((prev) => ({ ...prev, ...fields }));
      message.success('已读取登录态，确认后点「保存」生效');
    } catch (e) {
      message.error((e as Error).message || '抓取失败');
    } finally {
      setGrabbing(false);
    }
  };

  const handleDelete = async (p: ProviderMeta) => {
    try {
      await ipc.deleteCredential(p.id);
      message.success(`已删除 ${p.name} 凭证`);
      setProviders(await ipc.listProviders());
      await doRefresh();
    } catch (e) {
      message.error((e as Error).message || '删除失败');
    }
  };

  /*
   * 清除手动录入的余额。
   * 与「删除凭证」是两件事：凭证在 `balances:<id>`（密文）、手动值在 `balances:manual:<id>`
   * （明文），删掉一个另一个还在。所以各给一个入口 —— 否则手动值只能覆盖、删不掉。
   * 清完要重拉平台列表，否则 `has_manual` 还是 true，这个按钮不会消失。
   */
  const handleClearManual = async (p: ProviderMeta) => {
    try {
      await ipc.clearManual(p.id);
      message.success(`已清除 ${p.name} 的手动余额`);
      setProviders(await ipc.listProviders());
      await doRefresh();
    } catch (e) {
      message.error((e as Error).message || '清除失败');
    }
  };

  const handleSaveManual = async () => {
    if (!manualEditing) return;
    if (!manualValue.trim()) {
      message.warning('请填写余额内容');
      return;
    }
    try {
      await ipc.saveManual(manualEditing.id, manualLabel.trim() || '余额', manualValue.trim());
      message.success(`已保存 ${manualEditing.name} 手动余额`);
      setManualEditing(null);
      setManualValue('');
      await doRefresh();
    } catch (e) {
      message.error((e as Error).message || '保存失败');
    }
  };

  const balanceMap = useMemo(() => {
    const m = new Map<string, AgentBalance>();
    balances.forEach((b) => m.set(b.provider, b));
    return m;
  }, [balances]);

  /* 只渲染「显示中」的平台卡片 */
  const shownProviders = useMemo(
    () => providers.filter((p) => isVisible(p.id)),
    [providers, isVisible],
  );

  /*
   * 首页格子的预览。
   * 用**与首页完全相同的函数**（`pickHomeMetric` / `itemHealth` / `percentOf` /
   * `healthColor`）算，而不是另写一套「大概长这样」—— 否则预览和真实首页迟早分叉，
   * 预览就失去意义了。
   */
  const homeSnap = homePinnedProvider ? balanceMap.get(homePinnedProvider) ?? null : null;
  const homePrimary = homeSnap ? pickHomeMetric(homeSnap.items, trendMetric) : null;
  const homeHealth = homePrimary ? itemHealth(homePrimary) : null;
  const homePct = homePrimary ? percentOf(homePrimary.value) : null;
  /* 能展示的指标：只要「值能压成数字」的那些，否则进度条与曲线都没有纵轴可言 */
  const homeFieldOpts = homeSnap ? trayFieldOptions(homeSnap.items) : [];
  const homeFieldMissing = !!trendMetric && !homeFieldOpts.some((it) => it.label === trendMetric);

  const renderBalance = (b?: AgentBalance) => {
    if (!b) return <Text type="secondary">尚未刷新</Text>;
    if (b.error) return <Text type="secondary">{b.error}</Text>;
    if (b.items.length === 0) return <Text type="secondary">暂无数据</Text>;
    /* 与徽章摘要同一套排序：余额类指标排在最前 */
    const items = sortItems(b.items);
    return (
      <div className="balances-metrics">
        {items.map((it, i) => {
          /*
           * 数值按**类别**取色（见 format.metricValueKind）：
           *   百分比 → 健康度渐变（100 绿 → 0 红）—— 保住「快用完」的告警色
           *   数量（余额 / credits）→ 中性信息色，与「使用量」一眼分开
           *   日期等 → 不染色，保持默认文字色
           *
           * 方向归一仍然必须走 healthPercentOf：「已用 90%」和「剩余 10%」
           * 是同一个健康度，颜色得一致（否则同一件事会有两种观感）。
           *
           * `amount` 用 CSS 变量而不是写死的十六进制：`--wb-info` 在主题里已经分好
           * 深浅两色（深 #60A5FA / 浅 #2563EB），自己再挑一套就与设计系统脱节了。
           * 健康度的色带则相反 —— 那是本模块自己的色标（见 format.HEALTH_RAMP）。
           */
          const kind = metricValueKind(it);
          const health = itemHealth(it);
          const valueColor =
            kind === 'health'
              ? health === null
                ? undefined
                : healthColor(health, theme)
              : kind === 'amount'
                ? 'var(--wb-info)'
                : undefined;
          return (
            <div className="balances-metric" key={i}>
              <div className="balances-metric-label">{it.label}</div>
              <div
                className="balances-metric-value"
                style={valueColor === undefined ? undefined : { color: valueColor }}
                /* 悬停提示「还剩多少」：颜色含义自解释，免得用户以为绿=用量低就没事 */
                title={
                  health === null || !isUsageLabel(it.label)
                    ? undefined
                    : `额度剩余 ${Math.round(health)}%`
                }
              >
                {it.value}
              </div>
              {it.sub && <div className="balances-metric-sub">{it.sub}</div>}
            </div>
          );
        })}
      </div>
    );
  };

  /* 每张卡片的「刷新于 …」——取该平台最新的 refreshed_at */
  const refreshedHint = (b?: AgentBalance) => {
    const t = b ? formatRefreshedAt(b.refreshed_at) : '';
    return t ? <div className="balances-refreshed">{t}</div> : null;
  };

  /* 提醒记录里存的是 provider id，界面要显示人能看懂的平台名 */
  const providerName = (id: string) => providers.find((p) => p.id === id)?.name ?? id;

  /*
   * 自动刷新的状态文案。**带倒计时是刻意的**：定时器是分钟级的、而且发生在后台，
   * 只写「每 15 分钟」的话用户根本没法判断它到底有没有在跑
   * （而这正是这个模块最容易悄悄坏掉的地方）。
   */
  const autoRefreshHint = () => {
    if (!autoRefresh) return '自动刷新已关闭';
    const base = '各智能体按各自间隔自动刷新';
    if (nextRefreshAt <= 0) return base;
    const left = nextRefreshAt - Math.floor(Date.now() / 1000);
    return `${base}（最近一次约 ${formatCountdown(left)}后）`;
  };

  /**
   * 某平台「下次自动刷新」的文案（基于服务端下发的下次时刻）。
   * **绝对时刻 + 相对倒计时**：只写「约 12 分钟后」时，用户得自己在心里
   * 加一遍才知道是几点，过一个界面刷新又要重算。
   */
  const nextRefreshHint = (t: number) => {
    const left = t - Math.floor(Date.now() / 1000);
    if (left <= 0) return '即将自动刷新';
    const clock = clockAt(t);
    return clock
      ? `下次自动刷新 ${clock}（约 ${formatCountdown(left)}后）`
      : `下次自动刷新约 ${formatCountdown(left)}`;
  };

  return (
    <div className="balances-root">
      <div className="balances-title">
        <WalletOutlined className="balances-title-icon" />
        <h2>智能体余额</h2>
        <Tag color={bleConnected ? 'success' : 'default'}>
          {bleConnected ? '徽章已连接' : '徽章未连接'}
        </Tag>
      </div>
      <p className="balances-subtitle">
        读取各 AI 平台的余额 / 用量（本地加密保存凭证），连上 AI-Passport 时会自动推送到徽章
        —— 不必停在这个页面，后台服务会一直盯着。用「偏好设置」挑平台、定自动刷新间隔；
        点卡片上的房子图标可把它固定到首页图表，<b>固定的那个平台的图表会同时推到徽章的
        「余额」页</b>（主指标 + 本时段/本周两个环，环下还带各自的额度重置时刻；
        设备屏上不画历史趋势）。
      </p>

      <Alert
        type="info"
        showIcon
        className="balances-tip"
        message="凭证说明"
        description="ChatGPT 走网页端内部接口（access_token）：已装 Codex CLI 会自动读取 ~/.codex/auth.json；否则从 chatgpt.com/api/auth/session 取 accessToken 粘贴。Qoder CN 免配置：直接调用本机 qoderclicn（CLI 自己已登录），团队 / 企业账号同样有效；机器上没装 CLI 时才需要粘贴个人版 PAT 兜底，而那条路要解密凭证，刷新前需先在「设置 → 本地密钥」解锁。Trae 走网页登录态：在「配置」里点「一键抓取」自动借本机 Chrome 的登录态（也支持从 F12 手动复制 authorization 与 cookie 两行）。所有凭证用工作台主密钥加密后仅存本地，不上传。ChatGPT 查看余额不需要主密钥（不会弹系统授权框）。"
      />

      <Space className="balances-toolbar" wrap>
        <Button
          type="primary"
          icon={<ReloadOutlined />}
          loading={loading}
          onClick={() => doRefresh()}
        >
          刷新
        </Button>
        <Button
          icon={<SendOutlined />}
          disabled={!bleConnected}
          loading={pushing}
          onClick={() => doPush()}
        >
          推送到徽章
        </Button>
        {/*
         * 正文字节数**摆在按钮旁边**，而不是只藏在设置页里。
         * 固件的正文上限 95 字节，超了整条推送会被拒（且不截断）。
         * 事先给出字节数 + 超限时的红色提示，用户能立刻判断是「勾选太多」
         * 而不是去猜「为什么推送老报错」。
         */}
        {pushPreview && (
          <span
            className="balances-pushed-hint"
            style={pushPreviewOver ? { color: 'var(--wb-error)' } : undefined}
          >
            推送 {pushPreviewBytes}/{BODY_MAX} 字节
            {pushPreviewOver && ' · 超出上限，会被拒绝'}
          </span>
        )}
        <span className="balances-autopush">
          <Switch size="small" checked={autoPush} onChange={setAutoPush} />
          <Text type="secondary">连上蓝牙时自动推送</Text>
          {lastPushedAt > 0 && (
            <Text type="secondary" className="balances-pushed-hint">
              （{formatPushedAt(lastPushedAt)}）
            </Text>
          )}
        </span>
        <span className="balances-autopush">
          <Switch size="small" checked={autoRefresh} onChange={setAutoRefresh} />
          <Text type="secondary">{autoRefreshHint()}</Text>
        </span>
        <Button icon={<SlidersOutlined />} onClick={() => setShowConfig(true)}>
          偏好设置
        </Button>
      </Space>

      {providers.length === 0 ? (
        <Empty className="balances-empty" description="尚未加载平台列表" />
      ) : shownProviders.length === 0 ? (
        <Empty
          className="balances-empty"
          description={
            <span>
              已隐藏全部智能体卡片
              <br />
              <Text type="secondary">点上方「偏好设置」可重新勾选</Text>
            </span>
          }
        />
      ) : (
        <div className="balances-grid">
          {shownProviders.map((p) => {
            const b = balanceMap.get(p.id);
            return (
              <Card
                key={p.id}
                className="balances-card"
                title={
                  <Space wrap>
                    <span>{p.name}</span>
                    {p.has_credential && <Tag color="blue">已配置</Tag>}
                    {p.id === 'chatgpt' && !p.has_credential && codexAvailable && (
                      <Tag color="green">Codex 已登录</Tag>
                    )}
                    {p.kind === 'manual' && <Tag>手动</Tag>}
                    {homePinnedProvider === p.id && <Tag color="purple">首页</Tag>}
                  </Space>
                }
                extra={
                  <Space size={4} wrap>
                    <Tooltip title="只刷新这一个智能体">
                      <Button
                        size="small"
                        icon={<ReloadOutlined />}
                        loading={refreshingId === p.id}
                        onClick={() => {
                          setRefreshingId(p.id);
                          refreshProviderBalances(p.id)
                            .then(() => message.success(`${p.name} 已刷新`))
                            .catch((e) => message.error((e as Error).message || '刷新失败'))
                            .finally(() => setRefreshingId(null));
                        }}
                      />
                    </Tooltip>
                    {p.requires_token && (
                      <Button
                        size="small"
                        icon={<SettingOutlined />}
                        onClick={() => {
                          setEditing(p);
                          /* 清空上一次填的内容：凭证不会回显（只存密文），
                             留着空输入框比留一个假的占位值诚实 */
                          setCredInputs({});
                          setAccountIdInput('');
                        }}
                      >
                        配置
                      </Button>
                    )}
                    {p.requires_token && p.has_credential && (
                      <Button
                        size="small"
                        danger
                        icon={<DeleteOutlined />}
                        onClick={() => handleDelete(p)}
                      />
                    )}
                    <Button
                      size="small"
                      icon={<EditOutlined />}
                      onClick={() => {
                        setManualEditing(p);
                        setManualLabel('余额');
                        setManualValue('');
                      }}
                    >
                      手动
                    </Button>
                    {/*
                      仅当这个平台**已录入手动余额**时才出现。
                      它删的是 `balances:manual:<id>`，与上面的「删除凭证」互不影响 ——
                      两条独立存储，所以必须各给一个入口，否则手动值只能覆盖、删不掉。
                      加 Popconfirm 是因为这一行已经挤了 5 个按钮（刷新/首页/配置/删凭证/手动），
                      误点概率不低，而它删掉的是用户手打的数值。
                    */}
                    {p.has_manual && (
                      <Popconfirm
                        title="清除手动录入的余额？"
                        description="只清除手动数值，已配置的凭证不受影响。"
                        okText="清除"
                        cancelText="取消"
                        okButtonProps={{ danger: true }}
                        onConfirm={() => handleClearManual(p)}
                      >
                        <Button size="small" danger icon={<ClearOutlined />} />
                      </Popconfirm>
                    )}
                  </Space>
                }
              >
                <div className="balances-card-desc">{p.description}</div>
                {renderBalance(b)}
                {refreshedHint(b)}
                {autoRefresh && providerNextRefresh[p.id] > 0 && (
                  <div className="balances-refreshed">{nextRefreshHint(providerNextRefresh[p.id])}</div>
                )}
                {b?.raw && !b.error && (
                  <a className="balances-link" href={b.raw} target="_blank" rel="noreferrer">
                    打开控制台
                  </a>
                )}
              </Card>
            );
          })}
        </div>
      )}

      <Modal
        open={showConfig}
        title="余额设置"
        onCancel={() => setShowConfig(false)}
        onOk={() => setShowConfig(false)}
        okText="完成"
        cancelText="关闭"
        width={560}
        className="balances-prefs-modal"
        destroyOnClose
      >
        {/*
          弹窗分四个 tab —— 原本四个 section 摞在 520px 宽的弹窗里，
          高度直奔 800+，看起来一眼望不到底。
          切到 tab 后每个面板只剩自己一块，整体高度压在 540px 以内（最长的是「菜单栏」）。
          defaultActiveKey 写「refresh」：用户进来一般想调的就是刷新频率。
        */}
        <Tabs
          defaultActiveKey="refresh"
          items={[
            {
              key: 'refresh',
              label: '自动刷新',
              children: (
                <>
                <div className="balances-config-block">
                  <div className="balances-config-head">
                    <Text strong>自动刷新</Text>
                    <Switch size="small" checked={autoRefresh} onChange={setAutoRefresh} />
                  </div>
                  <Text type="secondary" className="balances-config-desc">
                    后台按间隔重新读取各平台余额，不需要停在本页面（也不会弹钥匙串授权框）。
                    间隔越长越省流量，但额度跌破阈值时收到的提醒会相应滞后。
                  </Text>
                  {/*
                    预设下拉 + 自定义输入框。选「自定义…」后输入框才出现 ——
                    常驻两个控件改同一个值，会让人不知道以哪个为准。
                  */}
                  <div className="balances-config-interval">
                    <Select
                      size="small"
                      className="balances-config-select"
                      value={showCustomInterval ? CUSTOM_INTERVAL : autoRefreshIntervalMin}
                      onChange={(v) => {
                        if (v === CUSTOM_INTERVAL) {
                          setIntervalCustomMode(true);
                          return;
                        }
                        setIntervalCustomMode(false);
                        setAutoRefreshInterval(v);
                      }}
                      disabled={!autoRefresh}
                      options={[
                        ...AUTO_REFRESH_OPTIONS.map((v) => ({ value: v, label: `每 ${v} 分钟` })),
                        { value: CUSTOM_INTERVAL, label: '自定义…' },
                      ]}
                    />
                    {showCustomInterval && (
                      <InputNumber
                        size="small"
                        className="balances-config-number"
                        min={MIN_REFRESH_MIN}
                        max={MAX_REFRESH_MIN}
                        value={autoRefreshIntervalMin}
                        onChange={(v) => {
                          /* 清空输入框时 v 是 null：保持原值，别把间隔写成 0 */
                          if (typeof v === 'number') setAutoRefreshInterval(v);
                        }}
                        disabled={!autoRefresh}
                        addonAfter="分钟"
                      />
                    )}
                  </div>
                  {showCustomInterval && (
                    <Text type="secondary" className="balances-config-desc">
                      可填 {MIN_REFRESH_MIN}–{MAX_REFRESH_MIN} 分钟，超出范围会被收敛到边界。
                    </Text>
                  )}
                </div>

                <div className="balances-config-block balances-config-perprovider">
                  <div className="balances-config-head">
                    <Text strong>每个智能体的刷新间隔</Text>
                  </div>
                  <Text type="secondary" className="balances-config-desc">
                    默认跟随上方的全局间隔；这里可以给某个平台单独设一个更快或更慢的频率
                    （例如 ChatGPT 接口便宜可设 1 分钟，企业平台设 60 分钟）。
                    选回「跟随全局」即共用默认，不额外存储。
                  </Text>
                  {providers.length === 0 ? (
                    <Text type="secondary" className="balances-config-desc">
                      先刷新一次拿到平台列表，再来逐个配置。
                    </Text>
                  ) : (
                    providers.map((p) => (
                      <ProviderIntervalRow
                        key={p.id}
                        provider={p.id}
                        name={p.name}
                        override={providerRefreshMin[p.id]}
                        globalDefault={autoRefreshIntervalMin}
                        disabled={!autoRefresh}
                      />
                    ))
                  )}
                </div>
                </>
              ),
            },
            {
              key: 'tray',
              label: '菜单栏',
              children: (
                <div className="balances-config-block">
                  <div className="balances-config-head">
                    <Text strong>在系统菜单栏显示</Text>
                    <Switch size="small" checked={trayEnabled} onChange={setTrayEnabled} />
                  </div>
                  <Text type="secondary" className="balances-config-desc">
                    把「使用 / 剩余额度」挂到屏幕顶部菜单栏，随时能瞥一眼，不用开窗口。
                    <Text strong>每个平台占一格</Text>，每格只显示一个数：
                    <Text code>余</Text> = 剩余额度，<Text code>用</Text> = 已用。
                    平台靠格子前面的图标认；关掉图标时会自动补上名字。
                    单位、口径（如「全组织共享」「本人当月」）以及该平台的其它指标都在悬停提示里
                    —— 鼠标停在某一格上就看到那个平台的全部明细。点任意一格都会把本窗口唤回来。
                  </Text>

                  {trayEnabled && (
                    <>
                      {/* 实时预览：走 buildTrayItems，与真实推送同一段逻辑 */}
                      <div className="balances-tray-preview">
                        <span className="balances-tray-preview-label">菜单栏预览</span>
                        <span className="balances-tray-preview-strip">
                          {trayPreviewEmpty ? (
                            <span className="balances-tray-preview-none">（一格都没有）</span>
                          ) : (
                            trayPreviewItems.map((it) => (
                              <TrayPreviewChip
                                key={it.key}
                                item={it}
                                color={trayGlyphColor}
                                scale={trayIconScale}
                              />
                            ))
                          )}
                        </span>
                        {!trayPreviewEmpty && (
                          <span className="balances-tray-preview-cols">
                            {trayPreviewItems.length} 格 · 文字共 {trayPreviewCols} 列 · 最宽{' '}
                            {trayWidest} 列（单格预算 {TRAY_ITEM_BUDGET_COLS}，数值不受它限制）
                          </span>
                        )}
                      </div>

                      {/*
                        图标大小。调的是**图形在格子里占多大**，不是格子多大 ——
                        菜单栏格子的高度（18pt）是系统写死的，改不了（见 prefs 的说明）。
                        上限特意超过 100%，好让拉到头能回到「加这个设置之前 logo 的大小」。

                        ⚠️ **只用 onChange，不用 onChangeComplete**。无头浏览器探针实测
                        （2026-09-24）：rc-slider 只在**拖拽松手**时调 onChangeComplete，
                        键盘改值（方向键）**根本不会调** —— 依赖它的话，键盘用户看到滑块
                        动了、设置却没存下来，重开弹窗就弹回去。这类「看起来生效了」的
                        静默丢失最难发现，所以这里改成每档都落盘。
                        落盘频繁的代价由 service.syncTray 的**合流**接住（同时最多一个 IPC
                        在飞，回来再按最新值补一次），不需要在界面层再做一套「拖动中」状态。
                      */}
                      <div className="balances-config-head balances-tray-size">
                        <Text>图标大小</Text>
                        <span className="balances-tray-size-ctl">
                          <Slider
                            className="balances-tray-size-slider"
                            min={MIN_TRAY_ICON_SCALE}
                            max={MAX_TRAY_ICON_SCALE}
                            step={TRAY_ICON_SCALE_STEP}
                            value={trayIconScale}
                            onChange={setTrayIconScale}
                            tooltip={{
                              formatter: (v) => `${Math.round((v ?? DEFAULT_TRAY_ICON_SCALE) * 100)}%`,
                            }}
                          />
                          <Button
                            size="small"
                            disabled={trayIconScale === DEFAULT_TRAY_ICON_SCALE}
                            onClick={() => setTrayIconScale(DEFAULT_TRAY_ICON_SCALE)}
                          >
                            重置
                          </Button>
                        </span>
                      </div>
                      <Text type="secondary" className="balances-config-desc">
                        统一作用于所有格子：100% 时字形与品牌图标一样大，拉到头（130%）就是品牌图标
                        原本的大小。文字大小不受影响 —— 菜单栏上数值的清晰度优先于观感。
                      </Text>

                      {trayPreviewEmpty ? (
                        <Text type="secondary" className="balances-config-desc">
                          现在一格都不会出现在菜单栏上 —— 要么没勾任何平台，要么勾了的平台这次都没读到数据。
                          关窗转入后台时菜单栏上仍会留一个「工作台」入口，不会回不来。
                        </Text>
                      ) : (
                        <Text type="secondary" className="balances-config-desc">
                          上面每一格就是菜单栏上会出现的一项（图标在真实菜单栏里会跟随系统前景色）。
                          悬停某一格看到的是那个平台的完整口径。
                        </Text>
                      )}
                      {trayPreviewItems.length >= 5 && (
                        <Text type="warning" className="balances-config-desc">
                          已经有 {trayPreviewItems.length} 格了 —— 菜单栏上还挤着系统图标、输入法、
                          时钟，格数太多会把这些挤到看不见。建议只留最要紧的两三个。
                        </Text>
                      )}
                      {trayTruncated > 0 && (
                        <Text type="secondary" className="balances-config-desc">
                          有 {trayTruncated} 格的名字被截短了（末尾的「…」）。数值**永远不会被截**——
                          一个截掉几位的额度数字是错的，所以只截名字。想显示完整就把名字改短一点。
                        </Text>
                      )}
                      {trayMissing > 0 && (
                        <Text type="secondary" className="balances-config-desc">
                          另有 {trayMissing} 个已勾选的平台暂时不会出现在菜单栏上 ——
                          它们在「显示智能体」里被隐藏了，或者这次没读到数据。
                        </Text>
                      )}
                      {trayNoField > 0 && (
                        <Text type="secondary" className="balances-config-desc">
                          还有 {trayNoField} 个平台有数据、但挑不出能上菜单栏的数值
                          （比如只有「额度到期 2026-10-01」这种不是额度的值）——
                          这类值上菜单栏会被读成年份，所以宁可不显示。
                        </Text>
                      )}

                      <Text type="secondary" className="balances-config-desc">
                        菜单栏空间有限，所以这里的勾选**独立于**「显示智能体」：
                        面板可以铺满一屏，菜单栏只放你真正要盯的几个。取消勾选不影响面板与徽章推送。
                        每个平台默认「自动挑」一个余额类指标，也可以指定成别的、改个名字、或关掉图标。
                      </Text>

                      <div className="balances-tray-rows">
                        {trayRows.length === 0 ? (
                          <Text type="secondary" className="balances-config-desc">
                            还没有可用的余额数据，先刷新一次再来配置。
                          </Text>
                        ) : (
                          trayRows.map((c) => {
                            const on = trayOnIds.includes(c.provider);
                            const noData = !!c.error || c.items.length === 0;
                            const opts = trayFieldOptions(c.items);
                            const cur = trayFields[c.provider] ?? '';
                            /* 之前选过的指标若已不在本次数据里（后端改了标签、或该平台读取失败），
                               也要出现在选项里并标注 —— 否则下拉会因为匹配不到而显示空白 */
                            const missing = !!cur && !opts.some((it) => it.label === cur);
                            const custom = trayLabels[c.provider] ?? '';
                            /* 内置短名：既是输入框的占位提示，也是「留空会用哪个名字」的答案 */
                            const fallback = providerShort(c.provider, c.name);
                            const iconOn = !trayIconOff.includes(c.provider);
                            /*
                             * 图标画什么由 icons.trayIconBitmap 定，分两种：
                             *   有品牌 logo 的平台（brand）→ **恒为 logo**，改名也不变
                             *   其余 → 字形**跟着名字走**（改名同时图标就变了，见 tray.glyphOf）
                             * 这里算出的 glyph 对前者只是「万一 logo 数据坏了」的兜底，
                             * 但仍要传给 trayIconDataUrl —— 免得预览与真实推送的入参不一致。
                             */
                            const brand = hasBrandLogo(c.provider);
                            const glyph = glyphOf(c.provider, custom);
                            const glyphUrl = trayIconDataUrl(
                              c.provider,
                              glyph,
                              trayGlyphColor,
                              trayIconScale,
                            );
                            return (
                              <div className="balances-tray-row" key={c.provider}>
                                {/* 平台名长短不一，包一层固定宽度，右边的控件才能上下对齐 */}
                                <span className="balances-tray-pick">
                                  <Checkbox
                                    checked={on}
                                    disabled={noData}
                                    onChange={(e) => toggleTrayProvider(c.provider, e.target.checked)}
                                  >
                                    <span className={noData ? 'balances-tray-name-off' : undefined}>
                                      {c.name}
                                    </span>
                                  </Checkbox>
                                </span>

                                {/* 图标开关：左边直接显示会画上去的那个图标。
                                    有品牌 logo 的平台显示 logo（改名不变）；其余显示字形（跟着名字变） */}
                                <Tooltip
                                  title={
                                    iconOn
                                      ? brand
                                        ? '在菜单栏上显示品牌图标（关掉后这一格会自动补上名字）'
                                        : '在菜单栏上显示图标（关掉后这一格会自动补上名字）'
                                      : '已关掉图标 —— 菜单栏上改用名字标识这一格'
                                  }
                                >
                                  <span className="balances-tray-icon-toggle">
                                    {glyphUrl && (
                                      <img
                                        className={`balances-tray-glyph${iconOn ? '' : ' balances-tray-glyph-off'}`}
                                        src={glyphUrl}
                                        width={18}
                                        height={18}
                                        alt=""
                                        draggable={false}
                                      />
                                    )}
                                    <Switch
                                      size="small"
                                      checked={iconOn}
                                      disabled={!on}
                                      onChange={(v) => setTrayIconVisible(c.provider, v)}
                                    />
                                  </span>
                                </Tooltip>

                                {/* 自定义名字。留空 = 用内置短名（占位提示里就是它） */}
                                <Input
                                  size="small"
                                  className="balances-tray-label"
                                  value={custom}
                                  placeholder={fallback}
                                  disabled={!on}
                                  maxLength={12}
                                  onChange={(e) => setTrayLabel(c.provider, e.target.value)}
                                />

                                <Select
                                  size="small"
                                  className="balances-tray-field"
                                  disabled={!on || opts.length === 0}
                                  value={cur}
                                  onChange={(v) => setTrayField(c.provider, v || null)}
                                  options={[
                                    { value: '', label: '自动挑' },
                                    ...opts.map((it) => ({
                                      value: it.label,
                                      label: `${it.label} ${compactValue(it.value) ?? ''}`.trim(),
                                    })),
                                    ...(missing
                                      ? [{ value: cur, label: `${cur}（当前数据里没有）` }]
                                      : []),
                                  ]}
                                />
                              </div>
                            );
                          })
                        )}
                      </div>
                    </>
                  )}
                </div>
              ),
            },
            {
              key: 'home',
              label: '首页',
              children: (
                <div className="balances-config-block">
                  <div className="balances-config-head">
                    <Text strong>首页「现在」面板里的余额格</Text>
                  </div>
                  <Text type="secondary" className="balances-config-desc">
                    首页那格只放得下一个平台、一个指标：一个大数字、一条进度条、一段走势。
                    这里决定它显示谁、显示哪个指标 —— 与「菜单栏」「推送」是
                    <Text strong>三份彼此独立的选择</Text>，改这边不影响那两处。
                  </Text>

                  <div className="balances-home-row">
                    <Text>展示哪个智能体</Text>
                    <Select
                      size="small"
                      className="balances-home-select"
                      value={homePinnedProvider ?? ''}
                      onChange={(v) => {
                        const id = String(v);
                        const p = providers.find((x) => x.id === id);
                        setHomePinned(id || null, p?.name ?? null);
                      }}
                      options={[
                        { value: '', label: '不显示' },
                        ...providers.map((p) => ({ value: p.id, label: p.name })),
                      ]}
                    />
                  </div>

                  <div className="balances-home-row">
                    <Text>展示哪个指标</Text>
                    <Select
                      size="small"
                      className="balances-home-select"
                      disabled={homeFieldOpts.length === 0}
                      value={trendMetric ?? ''}
                      onChange={(v) => setTrendMetric(String(v) || null)}
                      options={[
                        { value: '', label: '自动挑（剩余额度优先）' },
                        ...homeFieldOpts.map((it) => ({
                          value: it.label,
                          label: `${it.label} ${compactValue(it.value) ?? ''}`.trim(),
                        })),
                        /* 之前选过的指标若已不在本次数据里，也要出现在选项里 —— 否则下拉会显示空白 */
                        ...(homeFieldMissing
                          ? [{ value: trendMetric as string, label: `${trendMetric}（当前数据里没有）` }]
                          : []),
                      ]}
                    />
                  </div>

                  <div className="balances-home-row">
                    <Text>走势聚合粒度</Text>
                    <Select
                      size="small"
                      className="balances-home-select"
                      value={trendGranularity}
                      onChange={(v) => setTrendGranularity(v as TrendGranularity)}
                      options={TREND_GRANULARITY_OPTIONS}
                    />
                  </div>

                  {/* 预览：与首页走同一批纯函数，不是「大概长这样」 */}
                  <div className="balances-home-preview">
                    <span className="balances-home-preview-label">首页将显示</span>
                    {!homePinnedProvider ? (
                      <span className="balances-home-preview-none">
                        （那一格会显示「还没固定平台」，点它可进本模块）
                      </span>
                    ) : !homeSnap || !homePrimary ? (
                      <span className="balances-home-preview-none">
                        （这个平台还没有数据，先刷新一次）
                      </span>
                    ) : (
                      <div className="balances-home-preview-card">
                        <span
                          className="balances-home-preview-value"
                          style={
                            homeHealth === null
                              ? undefined
                              : { color: healthColor(homeHealth, theme) }
                          }
                        >
                          {homePrimary.value}
                        </span>
                        <span className="balances-home-preview-sub">
                          {[homeSnap.name ?? homePinnedProvider, homePrimary.label]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                        {homePct !== null && (
                          <span className="balances-home-preview-bar">
                            <span
                              className="balances-home-preview-bar-fill"
                              style={{
                                width: `${homePct}%`,
                                backgroundColor:
                                  homeHealth === null
                                    ? undefined
                                    : healthColor(homeHealth, theme),
                              }}
                            />
                          </span>
                        )}
                      </div>
                    )}
                  </div>

                  <Text type="secondary" className="balances-config-desc">
                    首页那一格点一下就会进本模块；数字的颜色按健康度算，
                    与面板上的环形进度同一个口径（<Text code>itemHealth</Text>）。
                  </Text>
                </div>
              ),
            },
            {
              key: 'alert',
              label: '额度提醒',
              children: (
                <div className="balances-config-block">
                  <div className="balances-config-head">
                    <Text strong>额度提醒</Text>
                  </div>
                  <Text type="secondary" className="balances-config-desc">
                    额度剩余跌破 {ALERT_THRESHOLDS.join('% / ')}% 时，各向徽章推一条提醒（同一档只提醒一次）。
                    需要「徽章已连接」且上方「连上蓝牙时自动推送」为开；额度窗口重置、剩余回升后会重新计数。
                    <Text strong>只针对「推送」页勾选的平台</Text>（与摘要同一口径）——
                    没勾的平台不会来提醒。
                    另外，跌破 {ALERT_THRESHOLDS[0]}% 后侧栏本模块会挂一个角标显示最低剩余百分比 ——
                    它不依赖蓝牙，徽章没连时靠它兜底。
                  </Text>

                  {/* 把「已提醒」状态摆出来：否则用户只能靠等徽章震动来判断提醒有没有在走 */}
                  <div className="balances-alert-status">
                    {alertRows.length === 0 ? (
                      <Text type="secondary" className="balances-config-desc">
                        还没有指标跌破过阈值（也可能只是还没连过徽章）。
                      </Text>
                    ) : (
                      alertRows.map((r) => (
                        <div className="balances-alert-row" key={`${r.provider}::${r.label}`}>
                          <span className="balances-alert-where">
                            {providerName(r.provider)} · {r.label}
                          </span>
                          <span className="balances-alert-tags">
                            {r.notified.map((t) => (
                              <Tag key={t} color="orange" className="!m-0" style={{ fontSize: 'calc(var(--wb-font-base) - 4.5px)' }}>
                                已提醒 {t}%
                              </Tag>
                            ))}
                          </span>
                        </div>
                      ))
                    )}
                  </div>

                  <div className="balances-config-actions">
                    <Button size="small" disabled={!bleConnected} onClick={handleTestAlert}>
                      测试提醒
                    </Button>
                    <Button size="small" onClick={handleResetAlerts}>
                      重置提醒记录
                    </Button>
                  </div>
                  {!bleConnected && (
                    <Text type="secondary" className="balances-config-desc">
                      徽章当前未连接，测试提醒不可用；连上后会自动补发漏掉的档位。
                    </Text>
                  )}
                </div>
              ),
            },
            {
              key: 'push',
              label: '推送',
              children: (
                <div className="balances-config-block">
                  <div className="balances-config-head">
                    <Text strong>推送到徽章哪些智能体</Text>
                    {pushProviders === null && (
                      <Tag className="!m-0" color="default" style={{ fontSize: 'calc(var(--wb-font-base) - 4.5px)' }}>
                        跟随显示中的平台
                      </Tag>
                    )}
                  </div>
                  <Text type="secondary" className="balances-config-desc">
                    徽章的正文上限只有 <Text code>{BODY_MAX}</Text> 字节（一个汉字 3 字节），
                    所以一次最多放得下两三个平台。勾选哪些，就只推哪些 ——
                    <Text strong>这里的选择独立于面板显示</Text>，面板照旧可以铺满一屏。
                    额度提醒也只针对勾选的平台。
                  </Text>

                  {/* 预览：走 pushSummaryFor —— 与真实推送同一个函数，逐字一致 */}
                  <div className="balances-push-preview">
                    <span className="balances-push-preview-label">徽章将显示</span>
                    {pushPreview ? (
                      <>
                        <span className="balances-push-preview-text">{pushPreview}</span>
                        <span className="balances-push-preview-cols">
                          {pushPreviewBytes}/{BODY_MAX} 字节
                          {pushPreviewOver && ' · 超出上限，会被拒绝'}
                          {pushDropped > 0 && ` · 另有 ${pushDropped} 个平台放不下，已略过`}
                        </span>
                      </>
                    ) : (
                      <span className="balances-push-preview-none">（暂无数据，先刷新一次）</span>
                    )}
                  </div>

                  <Checkbox.Group
                    className="balances-provider-checks"
                    value={pushOnIds}
                    onChange={(vals) => {
                      const ids = (vals as string[]).map(String);
                      /*
                       * 全选时收敛回 null（= 跟随显示中的平台）——
                       * 这样将来新增平台会自动进入推送范围。
                       * ⚠️ 但**取消勾选最后一个**时保留 []（一个都不推），
                       *    不能也收敛成 null —— 那会让用户「全不推」变成「全推」，
                       *    与他的意图正好相反。
                       */
                      setPushProviders(
                        ids.length === providers.length ? null : ids,
                      );
                    }}
                  >
                    {pushRows.map((c) => {
                      const noData = !!c.error || c.items.length === 0;
                      return (
                        <Checkbox key={c.provider} value={c.provider}>
                          <span className={noData ? 'balances-tray-name-off' : undefined}>
                            {c.name}
                          </span>
                          {noData && (
                            <Tag
                              className="!ml-1.5 !m-0"
                              color="default"
                              style={{ fontSize: 'calc(var(--wb-font-base) - 4.5px)' }}
                            >
                              无数据
                            </Tag>
                          )}
                        </Checkbox>
                      );
                    })}
                  </Checkbox.Group>
                  <div className="balances-config-actions">
                    <Button size="small" onClick={() => setPushProviders(null)}>
                      跟随显示中的平台
                    </Button>
                    <Button size="small" onClick={() => setPushProviders([])}>
                      一个都不推
                    </Button>
                  </div>
                  {pushPreviewOver && (
                    <Text type="secondary" className="balances-config-desc">
                      当前内容超出 {BODY_MAX} 字节。徽章的正文缓冲就这么大，
                      <Text strong>超限的推送会被整条拒绝</Text>（不是截断，内容一条都送不出去）——
                      减少勾选的平台即可。
                    </Text>
                  )}
                </div>
              ),
            },
            {
              key: 'display',
              label: '显示智能体',
              children: (
                <div className="balances-config-block">
                  <div className="balances-config-head">
                    <Text strong>显示哪些智能体</Text>
                  </div>
                  <Text type="secondary" className="balances-config-desc">
                    勾选的会显示在面板上，未勾选的不显示。
                    <Text strong>推送到徽章的内容、以及额度提醒针对哪些平台，由「推送」页单独决定</Text>
                    ，两者互不影响 —— 面板上铺满一屏、徽章上只推一个平台是正常用法。
                  </Text>
                  <Checkbox.Group
                    className="balances-provider-checks"
                    value={visibleProviders ?? providers.map((p) => p.id)}
                    onChange={(vals) => {
                      const ids = (vals as string[]).map(String);
                      /* 把「首页固定」的平台取消勾选时，同时清掉首页固定，避免首页展示一个已隐藏的平台 */
                      if (homePinnedProvider && !ids.includes(homePinnedProvider)) setHomePinned(null);
                      /* 全选时收敛回 null，语义更清晰（= 跟随平台列表，将来新增平台自动显示） */
                      setVisibleProviders(ids.length === providers.length ? null : ids);
                    }}
                  >
                    {providers.map((p) => (
                      <Checkbox key={p.id} value={p.id}>
                        <span>{p.name}</span>
                        {p.kind === 'manual' && (
                          <Tag className="!ml-1.5 !m-0" color="default" style={{ fontSize: 'calc(var(--wb-font-base) - 4.5px)' }}>
                            手动
                          </Tag>
                        )}
                      </Checkbox>
                    ))}
                  </Checkbox.Group>
                  <div className="balances-config-actions">
                    <Button size="small" onClick={() => setVisibleProviders(null)}>
                      全部显示
                    </Button>
                    <Button
                      size="small"
                      onClick={() => {
                        setVisibleProviders([]);
                        setHomePinned(null);
                      }}
                    >
                      全部隐藏
                    </Button>
                  </div>
                </div>
              ),
            },
          ]}
        />
      </Modal>

      <Modal
        open={!!editing}
        title={`配置 ${editing?.name ?? ''} 凭证`}
        onCancel={() => setEditing(null)}
        onOk={handleSave}
        confirmLoading={saving}
        okText="保存"
        cancelText="取消"
      >
        {editing?.token_hint && (
          <Alert type="warning" showIcon className="balances-modal-tip" message={editing.token_hint} />
        )}
        {/*
          凭证输入框**按后端声明的字段表渲染**（ProviderMeta.credential_fields）：
          ChatGPT 只有一条 access_token，Trae 要 authorization + cookie 两段。
          前端不再写死「access_token」—— 新增多字段平台时这里一行都不用改。
        */}
        {editing?.credential_fields.map((f) => (
          <div className="balances-field" key={f.key}>
            <Text strong>{f.label}</Text>
            {f.type === 'textarea' ? (
              <Input.TextArea
                rows={3}
                placeholder={f.placeholder ?? ''}
                value={credInputs[f.key] ?? ''}
                onChange={(e) =>
                  setCredInputs((prev) => ({ ...prev, [f.key]: e.target.value }))
                }
              />
            ) : f.type === 'password' ? (
              <Input.Password
                placeholder={f.placeholder ?? ''}
                value={credInputs[f.key] ?? ''}
                onChange={(e) =>
                  setCredInputs((prev) => ({ ...prev, [f.key]: e.target.value }))
                }
              />
            ) : (
              <Input
                placeholder={f.placeholder ?? ''}
                value={credInputs[f.key] ?? ''}
                onChange={(e) =>
                  setCredInputs((prev) => ({ ...prev, [f.key]: e.target.value }))
                }
              />
            )}
          </div>
        ))}
        {/*
          「一键抓取」：自动借本机 Chrome 的登录态并把上面几个字段填好。
          只对有抓取能力的平台（后端 has_grab）出现 —— 其余平台另写一套抓取逻辑
          才是真正的问题（抓取配置是声明式的，见 grab.rs）。
        */}
        {editing?.has_grab && (
          <div className="balances-field balances-grab">
            <Button
              size="small"
              icon={<CloudDownloadOutlined />}
              loading={grabbing}
              onClick={handleGrab}
            >
              一键抓取登录态
            </Button>
            {editing.grab_hint && (
              <Text type="secondary" className="balances-grab-hint">
                {editing.grab_hint}
              </Text>
            )}
          </div>
        )}
        {editing?.id === 'chatgpt' && (
          <div className="balances-field">
            <Text strong>account_id（可选，仅 ChatGPT 需要）</Text>
            <Input
              placeholder="留空则由接口自行判断"
              value={accountIdInput}
              onChange={(e) => setAccountIdInput(e.target.value)}
            />
          </div>
        )}
        {editing?.doc_url && (
          <a href={editing.doc_url} target="_blank" rel="noreferrer">
            获取凭证 / 查看控制台
          </a>
        )}
      </Modal>

      <Modal
        open={!!manualEditing}
        title={`手动录入 ${manualEditing?.name ?? ''} 余额`}
        onCancel={() => setManualEditing(null)}
        onOk={handleSaveManual}
        okText="保存"
        cancelText="取消"
      >
        <Alert
          type="info"
          showIcon
          className="balances-modal-tip"
          message="该平台无公开余额接口（或暂未接入），请到对应客户端/控制台查看后手动填写，数值会保存到本地并参与蓝牙推送。"
        />
        <div className="balances-field">
          <Text strong>标签</Text>
          <Input
            placeholder="如：剩余额度 / 本周已用"
            value={manualLabel}
            onChange={(e) => setManualLabel(e.target.value)}
          />
        </div>
        <div className="balances-field">
          <Text strong>数值</Text>
          <Input
            placeholder="如：$12.50 / 60%"
            value={manualValue}
            onChange={(e) => setManualValue(e.target.value)}
          />
        </div>
      </Modal>
    </div>
  );
};

export default BalancesView;
