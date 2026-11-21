/*
 * 时区对比 · 主体视图
 * ------------------------------------------------------------------
 * 一个瞬间，两种看法。左边是基准，右边是对照，**两边都可以改**：
 * 改哪边的日期 / 钟点 / 加减按钮，都换算成同一个绝对瞬间，于是另一边立刻跟着走。
 *
 * 为什么是「一个瞬间」而不是「两个各自独立的钟」：
 *   两个独立的钟一旦分别被拖动，就没有「同一时刻」可言了，时差也会开始飘。
 *   这里只有一个 `ms`，两边都是它的投影 —— 联动不是靠同步逻辑，而是**结构上
 *   不可能不同步**。
 *
 * 三个必须显式处理的边界（换算逻辑在 core/timezones::wallToInstant）：
 *   · 前跳：那一段墙上时间**不存在**（美国 3 月某个 02:30）→ 顺延并提示；
 *   · 回拨：那一段墙上时间**出现两次**（11 月某个 01:30）→ 取较早的一次并提示；
 *   · 缩写：`PST`/`PDT` 由 Intl 按当前日期给出，界面不判断任何规则。
 *
 * 时刻**不持久化**：每次进来都从「现在」开始，一个昨天固定的时刻第二天只会
 * 让人以为界面坏了。只持久化选中的两个时区。
 * @Author: fu
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Select, Space, Switch, Tag, Tooltip } from 'antd';
import { SwapOutlined } from '@ant-design/icons';
import {
  ZONE_CATALOG,
  abbrPair,
  countryNamesOf,
  dstProfile,
  formatUtcOffset,
  groupZones,
  instantParts,
  nextTransition,
  offsetAt,
  offsetLabel,
  otherTier,
  pad2,
  partsAtOffset,
  tierTimes,
  wallToInstant,
  wallToInstantAtOffset,
  zoneLabel,
  type AbbrPair,
  type DstProfile,
} from '@/core/timezones';
import {
  offsetBadge,
  parseDateInput,
  parseTimeInput,
  toDateInput,
  toTimeInput,
  transitionText,
} from './format';
import { readComparePrefs, writeComparePrefs, type ComparePrefs } from './prefs';
import './timezone.css';

/* =============================================
   ====== 时区选项 ======
   =============================================
   分组下拉 + 搜索。搜索用的串把中文名、英文名、IANA id、缩写、**国家名**拼在一起，
   于是输入 `PT` / `pst` / `los` / `洛杉矶` / `印度尼西亚` 都能命中。
   国家名必须拼进来：用户脑子里常常是国家而不是城市（搜「印度尼西亚」不会想到要输「雅加达」）。
   ============================================= */
const ZONE_OPTIONS = groupZones(ZONE_CATALOG).map((group) => ({
  label: group.region,
  options: group.zones.map((z) => ({
    value: z.id,
    label: z.city,
    search: `${z.city} ${z.en} ${z.id} ${(z.abbrs ?? []).join(' ')} ${countryNamesOf(z.id).join(' ')}`.toLowerCase(),
  })),
}));

const filterZoneOption = (input: string, option?: Record<string, unknown>): boolean => {
  const q = input.trim().toLowerCase();
  if (!q) return true;
  return String(option?.search ?? '').includes(q);
};

/* =============================================
   ====== 缩写气泡 ======
   =============================================
   徽标本身只放得下四个字母，所以「另一档叫什么」放进 hover。
   文案全部由 `dstProfile` + `abbrPair` 现算，没有写死 PST/PDT ——
   换成悉尼它就会自己说 AEDT / AEST。
   ============================================= */
interface AbbrTipProps {
  zone: string;
  /** 此刻生效的缩写；没有字母缩写时是 `UTC±H` */
  current: string;
  profile: DstProfile | null;
  pair: AbbrPair | null;
  /** 这一侧是否跟随夏令时。关掉时说明要换一套说法，不能再说「此刻处于夏令时」 */
  useDst: boolean;
}

const AbbrTip: React.FC<AbbrTipProps> = ({ zone, current, profile, pair, useDst }) => {
  if (!profile || !profile.usesDst || !pair) {
    return (
      <div className="tz-tip">
        <div className="tz-tip-main">{current}</div>
        <div className="tz-tip-sub">{zoneLabel(zone)}不实行夏令时，全年同一档</div>
      </div>
    );
  }

  const other = otherTier(profile, pair);

  /* 关掉夏令时后，界面上的钟点是「标准时」那一档 —— 说明必须跟着改口径 */
  if (!useDst) {
    return (
      <div className="tz-tip">
        <div className="tz-tip-main">{current}</div>
        <div className="tz-tip-sub">已固定为标准时，不随夏令时跳变</div>
        <div className="tz-tip-sub">
          真实规则此刻是{profile.inDst ? '夏令时' : '标准时'}（
          {formatUtcOffset(profile.offset)}），{other.name}是 {other.text}
        </div>
      </div>
    );
  }

  return (
    <div className="tz-tip">
      <div className="tz-tip-main">{current}</div>
      <div className="tz-tip-sub">
        {profile.inDst ? '此刻处于夏令时' : '此刻处于标准时'}
        {profile.shift > 0 && ` · ${offsetLabel(profile.shift, '标准时')}`}
      </div>
      <div className="tz-tip-sub">
        {other.name}是 {other.text}
      </div>
    </div>
  );
};

/* =============================================
   ====== 概念说明 ======
   =============================================
   用原生 <details>：不引 AntD Collapse（会带 motion 进主包），也不需要展开动画。
   默认**展开** —— 这段就是用户要的答案，藏起来等于没写；不看了自己收起来。

   ⚠️ 不能用 `open={true}` 受控：外层每秒 tick 一次，受控的 `open` 会在用户
   手动收起后被下一次渲染「顶」回去。这里只在挂载时设一次，之后完全交给浏览器。
   ============================================= */
interface DstNoteProps {
  zone: string;
  current: string;
  profile: DstProfile | null;
  pair: AbbrPair | null;
}

const DstNote: React.FC<DstNoteProps> = ({ zone, current, profile, pair }) => {
  const label = zoneLabel(zone);
  const other = profile?.usesDst ? otherTier(profile, pair) : null;
  const ref = useRef<HTMLDetailsElement | null>(null);

  useEffect(() => {
    if (ref.current) ref.current.open = true;
  }, []);

  return (
    <details className="tz-note" ref={ref}>
      <summary className="tz-note-head">什么是夏令时？PST 和 PDT 差在哪？</summary>

      <div className="tz-note-body">
        <p>
          <b>夏令时（DST）</b>是「夏天把钟往前拨一小时」的做法，为了让下班时天还亮着；秋天再拨回来。
          所以同一个地方会有两个版本的时间，两者差一小时。
        </p>
        <p>
          <b>ST / DT 就是这两个版本的后缀</b>，北美那套命名是「地区 + ST/DT」：
          <code>PST</code> = Pacific <b>S</b>tandard Time（太平洋标准时），
          <code>PDT</code> = Pacific <b>D</b>aylight Time（太平洋夏令时）。
          同理还有 EST/EDT、CST/CDT、MST/MDT。欧洲不用这套后缀（CET / CEST）。
        </p>
        <p>
          <b>界面上的缩写会自己变</b>，因为它是按你选的日期向系统要的，不是写死的：
          把日期拨到夏天显示 DT，拨到冬天显示 ST。
        </p>
        <p>
          <b>这里不自己判断规则</b>：哪天开始、哪天结束是政治决定，而且会变
          （欧盟 2018 年投票要取消、墨西哥 2022 年已经取消）。自己维护偏移表迟早是错的，
          交给系统的时区库。
        </p>

        {profile?.usesDst && other ? (
          <p className="tz-note-example">
            例如 {label}：此刻 {current}（{profile.inDst ? '夏令时' : '标准时'}，
            {formatUtcOffset(profile.offset)}），{other.name}是 {other.text}。
          </p>
        ) : (
          profile && (
            <p className="tz-note-example">
              例如 {label}：不实行夏令时，全年都是 {current}。
            </p>
          )
        )}
      </div>
    </details>
  );
};

/* =============================================
   ====== 单侧面板 ======
   ============================================= */
interface PaneProps {
  side: 'a' | 'b';
  zone: string;
  ms: number;
  /** 这一侧是否跟随夏令时；false = 全年按标准时算 */
  useDst: boolean;
  onZone: (side: 'a' | 'b', id: string) => void;
  onToggleDst: (side: 'a' | 'b') => void;
  /** 改了日期或钟点：交给上层换算成瞬间 */
  onEdit: (side: 'a' | 'b', zone: string, dateStr: string, timeStr: string) => void;
  /** 按分钟平移（作用于绝对瞬间，不是墙上时间） */
  onNudge: (minutes: number) => void;
}

const NUDGES: Array<{ label: string; minutes: number }> = [
  { label: '−1 天', minutes: -1440 },
  { label: '−1 时', minutes: -60 },
  { label: '−15 分', minutes: -15 },
  { label: '+15 分', minutes: 15 },
  { label: '+1 时', minutes: 60 },
  { label: '+1 天', minutes: 1440 },
];

const Pane: React.FC<PaneProps> = ({
  side,
  zone,
  ms,
  useDst,
  onZone,
  onToggleDst,
  onEdit,
  onNudge,
}) => {
  /* 真实的墙上时间（含夏令时，由 Intl 按当前日期给出） */
  const real = instantParts(ms, zone);

  /*
   * 「下一次跳变」按天缓存：逐日扫最多 400 天，每秒重算没必要。
   * 依赖里放 dayIndex 而不是 ms —— 同一天内结果不变。
   */
  const dayIndex = Math.floor(ms / 86_400_000);
  const transition = useMemo(() => nextTransition(zone, ms), [zone, dayIndex]);
  /* 两侧缩写同理按天缓存；此刻生效的那个每帧现算，跳变当天才不会滞后 */
  const pair = useMemo(() => abbrPair(zone, transition), [zone, transition]);
  const profile = dstProfile(real?.offsetMinutes ?? null, transition);

  /*
   * ⭐ 实际采用的墙上时间 —— 后面**所有东西**都只认这一个：
   *   跟随夏令时 → Intl 给的（真实规则）；
   *   固定标准时 → 「瞬间 + 标准偏移」现算（见 core::partsAtOffset）。
   * 大钟、日期、两个输入框、缩写全都从它派生，所以关掉夏令时不会出现
   * 「钟点没变但缩写变了」这种半截状态。
   */
  const parts = useDst ? real : profile ? partsAtOffset(ms, profile.standardOffset) : null;

  if (!parts || !profile) {
    return (
      <section className="tz-pane">
        <div className="tz-pane-head">
          <span className="tz-city">{zoneLabel(zone)}</span>
        </div>
        <div className="tz-clock">—</div>
        <div className="tz-dst">这个时区不可用</div>
      </section>
    );
  }

  const dateStr = toDateInput(parts);
  const timeStr = toTimeInput(parts);
  /* 关掉夏令时后徽标要给**标准档**的缩写（PST），不是此刻真实的 PDT */
  const current = useDst
    ? offsetBadge(ms, zone)
    : pair?.standard || formatUtcOffset(profile.standardOffset);
  /* 两档并排只在「跟随夏令时」时才有意义 —— 固定标准时之后只剩一档 */
  const tiers = useDst && profile.usesDst ? tierTimes(ms, profile) : null;

  const dstText = !profile.usesDst
    ? transitionText(zone, null)
    : useDst
      ? transitionText(zone, transition)
      : `已固定为标准时（${formatUtcOffset(profile.standardOffset)}），不随夏令时跳变。`;

  const dstTip = !profile.usesDst
    ? `${zoneLabel(zone)}不实行夏令时，全年都是标准时`
    : useDst
      ? `跟随夏令时：此刻 ${formatUtcOffset(profile.offset)}。关掉后固定为标准时（${formatUtcOffset(
          profile.standardOffset,
        )}），全年不跳`
      : `已固定为标准时（${formatUtcOffset(profile.standardOffset)}）。打开后恢复跟随夏令时`;

  return (
    <section className="tz-pane">
      <div className="tz-pane-head">
        <Select
          className="tz-zone-select"
          size="small"
          value={zone}
          options={ZONE_OPTIONS}
          showSearch
          filterOption={(input, option) =>
            filterZoneOption(input, option as unknown as Record<string, unknown>)
          }
          onChange={(id: string) => onZone(side, id)}
          popupMatchSelectWidth={280}
        />
        {/* 徽标只说「此刻是哪个」，展开说「另一档是哪个」—— hover 才知道，不占版面 */}
        <Tooltip
          title={<AbbrTip zone={zone} current={current} profile={profile} pair={pair} useDst={useDst} />}
        >
          <span className="tz-abbr">{current}</span>
        </Tooltip>
        {/*
         * 夏令时开关：只对**真的实行夏令时**的时区可用。
         * 关掉 = 全年按标准时算（不随夏令时跳一小时），用来跟「不搞夏令时的地方」
         * 对齐口径，或者算「如果那边不调钟会是几点」。
         */}
        <Tooltip title={dstTip}>
          <label className={`tz-dst-ctl${profile.usesDst ? '' : ' is-na'}`}>
            <span className="tz-dst-ctl-label">夏令时</span>
            <Switch
              size="small"
              checked={useDst && profile.usesDst}
              disabled={!profile.usesDst}
              onChange={() => onToggleDst(side)}
            />
          </label>
        </Tooltip>
      </div>

      <div className="tz-date">
        {parts.year}年{parts.month}月{parts.day}日 {parts.weekday}
      </div>

      <div className="tz-clock">
        {pad2(parts.hour)}:{pad2(parts.minute)}
        <span className="tz-sec">:{pad2(parts.second)}</span>
      </div>

      {/*
       * 两档并排：同一个瞬间按标准时 / 夏令时各写一次。
       * **标准时在前**，它是基准；实行夏令时的时区才有这一行。
       */}
      {tiers && (
        <div className="tz-tiers">
          <span className="tz-tier is-standard">标准时 {tiers.standard}</span>
          <span className="tz-tier-sep"> · </span>
          <span className="tz-tier is-daylight">夏令时 {tiers.daylight}</span>
        </div>
      )}

      {/* 原生控件：日期给日历、时间给时钟，键盘也能直接输；样式由 .tz-edit 统一 */}
      <div className="tz-edit">
        <input
          type="date"
          value={dateStr}
          aria-label={`${zoneLabel(zone)} 的日期`}
          onChange={(e) => onEdit(side, zone, e.target.value, timeStr)}
        />
        <input
          type="time"
          value={timeStr}
          aria-label={`${zoneLabel(zone)} 的时间`}
          onChange={(e) => onEdit(side, zone, dateStr, e.target.value)}
        />
      </div>

      <div className="tz-nudges">
        {NUDGES.map((n) => (
          <button
            key={n.minutes}
            type="button"
            className="tz-nudge"
            onClick={() => onNudge(n.minutes)}
          >
            {n.label}
          </button>
        ))}
      </div>

      <div className="tz-dst">{dstText}</div>
    </section>
  );
};

/* =============================================
   ====== 视图 ======
   ============================================= */

/**
 * 某时区此刻的**标准时偏移**（不随夏令时变）。
 * 不实行夏令时的时区就等于此刻的偏移。
 *
 * ⚠️ 要逐日扫最多 400 天找下一次跳变 —— 只在「关掉夏令时」时才会被调用，
 * 且调用方按天缓存（见下面的 stdA / stdB）。
 */
function standardOffsetOf(zone: string, ms: number): number | null {
  const off = offsetAt(ms, zone);
  if (off === null) return null;
  return dstProfile(off, nextTransition(zone, ms))?.standardOffset ?? off;
}

const TimezoneView: React.FC = () => {
  /* 两个时区 + 各自的「是否跟随夏令时」；时刻仍然不持久化 */
  const [prefs, setPrefs] = useState<ComparePrefs>(readComparePrefs);
  /* 跟随现在 or 固定时刻：固定之后秒针停下，编辑才有意义 */
  const [live, setLive] = useState(true);
  const [frozenMs, setFrozenMs] = useState(() => Date.now());
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [notice, setNotice] = useState<string | null>(null);

  /*
   * 秒针：对齐到整秒再排下一次（setInterval 的误差会累积，跑一小时就差出几秒）。
   * 固定时刻后停掉 —— 停下来的钟不该还在动。
   */
  useEffect(() => {
    if (!live) return;
    let timer = 0;
    const tick = () => {
      setNowMs(Date.now());
      timer = window.setTimeout(tick, 1000 - (Date.now() % 1000));
    };
    timer = window.setTimeout(tick, 1000 - (Date.now() % 1000));
    return () => window.clearTimeout(timer);
  }, [live]);

  const ms = live ? nowMs : frozenMs;

  const setZone = useCallback((side: 'a' | 'b', id: string) => {
    setPrefs((prev) => {
      if (prev[side] === id) return prev;
      const next = { ...prev, [side]: id };
      writeComparePrefs(next);
      return next;
    });
  }, []);

  /** 切换某一侧是否跟随夏令时（关掉 = 全年按标准时算） */
  const toggleDst = useCallback((side: 'a' | 'b') => {
    setPrefs((prev) => {
      const next: ComparePrefs =
        side === 'a' ? { ...prev, dstA: !prev.dstA } : { ...prev, dstB: !prev.dstB };
      writeComparePrefs(next);
      return next;
    });
  }, []);

  const swap = useCallback(() => {
    setPrefs((prev) => {
      /* 开关也跟着换边 —— 否则「交换」之后两边的口径会跟着时区一起错位 */
      const next: ComparePrefs = {
        a: prev.b,
        b: prev.a,
        dstA: prev.dstB,
        dstB: prev.dstA,
      };
      writeComparePrefs(next);
      return next;
    });
    setNotice(null);
  }, []);

  const toNow = useCallback(() => {
    setLive(true);
    setNowMs(Date.now());
    setNotice(null);
  }, []);

  const apply = useCallback((nextMs: number, message: string | null) => {
    setLive(false);
    setFrozenMs(nextMs);
    setNotice(message);
  }, []);

  const edit = useCallback(
    (side: 'a' | 'b', zone: string, dateStr: string, timeStr: string) => {
      const date = parseDateInput(dateStr);
      const time = parseTimeInput(timeStr);
      /* 用户还没输完（浏览器会给空串 / 半截值）：忽略，不要当成 1970 年 */
      if (!date || !time) return;

      const hm = `${pad2(time.hour)}:${pad2(time.minute)}`;
      const useDst = side === 'a' ? prefs.dstA : prefs.dstB;

      /*
       * 固定标准时时**没有跳变**：每一段墙上时间都恰好对应一个瞬间，
       * 所以直接走线性换算，不需要（也不该）报「不存在 / 出现两次」。
       */
      if (!useDst) {
        const off = standardOffsetOf(zone, ms);
        const at = off === null ? null : wallToInstantAtOffset(off, { ...date, ...time });
        if (at === null) {
          setNotice(`${zoneLabel(zone)} 这个时区不可用`);
          return;
        }
        apply(at, null);
        return;
      }

      const res = wallToInstant(zone, { ...date, ...time });
      if (!res) {
        setNotice(`${zoneLabel(zone)} 这个时区不可用`);
        return;
      }

      if (res.kind === 'gap') {
        const after = instantParts(res.ms, zone);
        const to = after ? `${pad2(after.hour)}:${pad2(after.minute)}` : '跳变之后';
        apply(
          res.ms,
          `${zoneLabel(zone)}的 ${hm} 不存在 —— 夏令时开始时会跳过 ${res.gapMinutes} 分钟，已顺延到 ${to}。`,
        );
        return;
      }

      if (res.kind === 'ambiguous') {
        /*
         * 「另一处」不能报墙上时间：回拨的两个候选**墙上时间完全相同**
         * （这正是「出现两次」的定义），报 01:30 等于什么也没说。
         * 真正能区分它们的是偏移 / 缩写 —— EDT 还是 EST。
         */
        apply(
          res.ms,
          `${zoneLabel(zone)}的 ${hm} 出现两次 —— 已取较早的一次（${offsetBadge(
            res.ms,
            zone,
          )}），另一处晚一小时是 ${offsetBadge(res.alternativeMs, zone)}。`,
        );
        return;
      }

      apply(res.ms, null);
    },
    [apply, prefs.dstA, prefs.dstB],
  );

  /* 平移作用于**绝对瞬间**：两边一起走过同样长的真实时间，跨夏令时也不会错位 */
  const nudge = useCallback(
    (minutes: number) => {
      apply(ms + minutes * 60_000, null);
    },
    [apply, ms],
  );

  const labelA = zoneLabel(prefs.a);
  const labelB = zoneLabel(prefs.b);

  /*
   * 实际采用的偏移：跟随夏令时就用此刻真实的，固定标准时就用标准偏移。
   * 标准偏移要逐日扫最多 400 天，按天缓存（与面板内同一套开销模型）。
   */
  const offDayIndex = Math.floor(ms / 86_400_000);
  const stdA = useMemo(() => standardOffsetOf(prefs.a, ms), [prefs.a, offDayIndex]);
  const stdB = useMemo(() => standardOffsetOf(prefs.b, ms), [prefs.b, offDayIndex]);
  const offA = prefs.dstA ? offsetAt(ms, prefs.a) : stdA;
  const offB = prefs.dstB ? offsetAt(ms, prefs.b) : stdB;
  const diff = offA === null || offB === null ? null : offA - offB;

  /*
   * 底部说明块要举例。`nextTransition` / `abbrPair` 都按天缓存（与面板内同一套
   * 开销模型），每秒的 1Hz 重渲染不会重算它们。
   *
   * ⚠️ 举例**优先挑真的实行夏令时的那一侧**：默认配置是「本地 + 洛杉矶」，
   * 如果固定用左侧，国内用户看到的永远是「上海不实行夏令时」，这段说明就白讲了。
   * ⚠️ 这里用的是**真实偏移**（`offsetAt`），不是上面那个可能被固定成标准时的
   *    `offA/offB` —— 这段讲的是「夏令时是什么」，不该被开关影响。
   */
  const noteDayIndex = Math.floor(ms / 86_400_000);
  const noteNextA = useMemo(() => nextTransition(prefs.a, ms), [prefs.a, noteDayIndex]);
  const noteNextB = useMemo(() => nextTransition(prefs.b, ms), [prefs.b, noteDayIndex]);
  const noteProfileA = dstProfile(offsetAt(ms, prefs.a), noteNextA);
  const noteProfileB = dstProfile(offsetAt(ms, prefs.b), noteNextB);
  const noteZone = noteProfileA?.usesDst || !noteProfileB?.usesDst ? prefs.a : prefs.b;
  const noteProfile = noteProfileA?.usesDst ? noteProfileA : noteProfileB;
  const notePair = useMemo(
    () => abbrPair(noteZone, noteZone === prefs.a ? noteNextA : noteNextB),
    [noteZone, prefs.a, noteNextA, noteNextB],
  );

  return (
    <div className="tz-view">
      <header className="tz-head">
        <div className="tz-head-copy">
          <h2 className="tz-title">时区对比</h2>
          <p className="tz-sub">两边都能直接改时间 —— 改哪边，另一边跟着走。</p>
        </div>

        <Space size={8} wrap>
          <Tag className="tz-live-tag" color={live ? 'green' : undefined}>
            {live ? '跟随现在' : '已固定时刻'}
          </Tag>
          <Button size="small" onClick={toNow} disabled={live}>
            回到现在
          </Button>
          <Button size="small" icon={<SwapOutlined />} onClick={swap}>
            交换
          </Button>
        </Space>
      </header>

      {notice && (
        <Alert
          className="tz-notice"
          type="warning"
          showIcon
          message={notice}
          closable
          onClose={() => setNotice(null)}
        />
      )}

      <div className="tz-panes">
        <Pane
          side="a"
          zone={prefs.a}
          ms={ms}
          useDst={prefs.dstA}
          onZone={setZone}
          onToggleDst={toggleDst}
          onEdit={edit}
          onNudge={nudge}
        />

        <div className="tz-bridge" aria-hidden="true">
          <SwapOutlined />
        </div>

        <Pane
          side="b"
          zone={prefs.b}
          ms={ms}
          useDst={prefs.dstB}
          onZone={setZone}
          onToggleDst={toggleDst}
          onEdit={edit}
          onNudge={nudge}
        />
      </div>

      <div className="tz-summary">
        <span className="tz-summary-diff">
          {diff === null
            ? '时差不可用'
            : /* 两边选成同一个时区时，`offsetLabel(0)` 会给出「上海与上海相同」这种话 —— 单独说清楚 */
              prefs.a === prefs.b && prefs.dstA === prefs.dstB
              ? '两边是同一个时区'
              : `${labelA}${offsetLabel(diff, labelB)}`}
        </span>
        <span className="tz-summary-offsets">
          {labelA} {offA === null ? '—' : formatUtcOffset(offA)}
          <span className="tz-dot">·</span>
          {labelB} {offB === null ? '—' : formatUtcOffset(offB)}
        </span>
      </div>

      <DstNote
        zone={noteZone}
        current={offsetBadge(ms, noteZone)}
        profile={noteProfile}
        pair={notePair}
      />
    </div>
  );
};

export default TimezoneView;
