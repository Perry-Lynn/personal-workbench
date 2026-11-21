/*
 * 工作台主题层
 * ------------------------------------------------------------------
 * 双主题（dark / light）的色板与 AntD ConfigProvider 配置。
 * 色板值必须与 src/index.css 里的 --wb-* 令牌保持一致，两边改一处要同步另一处。
 *
 * 模块组件不要自己写死颜色，用 --wb-* 变量或 wb-* Tailwind 类，
 * 这样新增模块自动获得双主题支持。
 * @Author: fu
 */
import { theme as AntTheme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import type { ThemeConfig } from 'antd';

export type ThemeMode = 'dark' | 'light';

/*
 * 全局基准字号（px）—— 设置页可调。
 *
 * 默认值 16：是「设置」面板里 slider 的中间档，对应 calc(--wb-font-base - 2.5px)
 * 的侧栏列表项落在 13.5px —— 兼顾密集信息的可读性与多模块并存时的占地。
 * 下限 13 是字号硬下限（再小看不清），上限 18 再往上会让侧栏与密集表格换行失控。
 * 这里放主题层而不是 store，是因为 buildAntdConfig 需要它来派生 token，
 * 而 store 已经依赖本文件的 ThemeMode —— 反过来 import 会成环。
 *
 * 改这里只影响默认值。已存进 localStorage 的旧值（workbench:font-size）
 * 不会被自动迁移 —— 用户可在「设置 → 基准字号」点「重置」回到新默认。
 */
export const FONT_MIN_SIZE = 13;
export const FONT_MAX_SIZE = 18;
export const FONT_DEFAULT_SIZE = 16;

/* 把任意输入收敛到合法字号（非法/NaN 一律回落到默认） */
export function clampFontSize(n: number): number {
  if (!Number.isFinite(n)) return FONT_DEFAULT_SIZE;
  return Math.min(FONT_MAX_SIZE, Math.max(FONT_MIN_SIZE, Math.round(n)));
}

/*
 * 把「本地记录的原样字符串」解析成合法字号。
 *
 * ⚠️ 存在的唯一理由，是挡住一个**已经踩过的坑**：
 * 直接写 `clampFontSize(Number(raw))` 时，首次运行 `raw` 是 `null`、
 * `Number(null)` 是 **0**，于是被夹到**下限 13** —— 默认值永远轮不到，
 * 表现为「新用户/清过缓存的人字号永远是最小号」，而改 FONT_DEFAULT_SIZE 毫无效果。
 * 2026-09-23 用无头浏览器探针量到 `--wb-font-base = 13px` 才发现。
 *
 * 判据是「没有值」而不是「值为假」：`Number('')` 同样是 0，一并当没有记录。
 * 抽成纯函数就是为了能在 scripts/logic-test.ts 里直接钉住这条边界。
 *
 * 可举一反三的通用判据：**`clamp` 会把任何非法输入「变成」一个合法值，
 * 从而掩盖「没有值」这件事**。所以读「可能不存在」的配置必须**先判有没有值、再 clamp**。
 * 反过来用**区间校验**（`if (!(v >= min && v <= max)) return DEFAULT`）就没这问题 ——
 * 0 落在区间外，自然回默认。本仓的侧栏宽度、LogSight 日志字号都是区间校验，所以没中招。
 */
export function parseStoredFontSize(raw: string | null | undefined): number {
  if (raw === null || raw === undefined || raw.trim() === '') return FONT_DEFAULT_SIZE;
  return clampFontSize(Number(raw));
}

/*
 * 控件高度锚定在「默认字号 16」对应的 34 / 28 / 40。
 * 字号每 +1，高度也 +1 —— 只放大字号不动高度，文字会贴在按钮/输入框边缘。
 * 校验：base=13 时算出 31/25/37（最小字号时控件缩到最小）。
 */
const CONTROL_H = 34;
const CONTROL_H_SM = 28;
const CONTROL_H_LG = 40;

/* 深色主题色板（偏蓝灰深色基底 + 翠绿品牌） */
const DARK = {
  /* 与 index.css 深色背景阶梯逐字同值：sider < base < surface < secondary < elevated */
  bgBase: '#131519', bgSurface: '#1A1D23', bgElevated: '#20242B', bgSecondary: '#1E2128',
  bgSider: '#0E0F12', bgOverlay: 'rgba(255,255,255,0.06)',
  /*
   * ⚠️ 这里的文字色必须与 index.css 的 --wb-text-* 逐字同值。
   * 本文件喂给 AntD（colorTextTertiary / 禁用态文字），CSS 令牌喂给模块自定义样式；
   * 一旦不同步，同一个「说明文字」在原生控件和自绘元素上会是两种深浅。
   * 深色 tertiary 原 #5F626B 只有 3.2:1，已提到 #8D919A（抬底后 base 5.79:1 / elevated 4.93:1）。
   */
  textPrimary: '#ECEDEF', textSecondary: '#989BA4', textTertiary: '#8D919A',
  textQuaternary: 'rgba(236,237,239,0.30)',
  borderPrimary: 'rgba(255,255,255,0.07)', borderSecondary: 'rgba(255,255,255,0.12)',
  brand: '#34D399', brandHover: '#2FBF87', brandActive: '#059669',
  cyan: '#22D3EE', blue: '#60A5FA',
  success: '#34D399', warning: '#FBBF24', error: '#F87171', info: '#60A5FA',
  menuSelectedBg: 'rgba(52,211,153,0.13)', menuSelectedColor: '#34D399',
  menuHoverBg: 'rgba(255,255,255,0.055)',
  btnShadow: '0 1px 2px rgba(0,0,0,0.35)',
  inputFocusShadow: '0 0 0 2px rgba(52,211,153,0.18)',
  tagDefaultBg: 'rgba(52,211,153,0.12)', tagDefaultColor: '#34D399',
  /* 表头/树底原来直接复用侧栏色 #0E0F12 —— 抬底后那会比页面还暗，成了一道「凹槽」，
     改成夹在 base 与 surface 之间的一档 */
  tableHeaderBg: '#171A20', rowHoverBg: 'rgba(255,255,255,0.05)',
  treeBg: '#14161B', treeHoverBg: 'rgba(255,255,255,0.05)',
  tooltipBg: '#2A2D31', tooltipText: '#E8EAED', tooltipBorder: 'rgba(232,234,237,0.10)',
  popoverBg: '#2A2D31', popoverText: '#E8EAED',
} as const;

/* 浅色主题色板（清爽冷灰 + 深青碧品牌） */
const LIGHT = {
  bgBase: '#F7F8F8', bgSurface: '#FFFFFF', bgElevated: '#FFFFFF', bgSecondary: '#F2F3F4',
  bgSider: '#F2F3F4', bgOverlay: 'rgba(16,24,40,0.03)',
  /* 与 index.css 浅色令牌逐字同值：tertiary 4.7:1、secondary 7.4:1（均过 AA） */
  textPrimary: '#16171A', textSecondary: '#4E525B', textTertiary: '#6B6F78',
  textQuaternary: 'rgba(22,23,26,0.30)',
  borderPrimary: 'rgba(16,24,40,0.09)', borderSecondary: 'rgba(16,24,40,0.14)',
  brand: '#0D9488', brandHover: '#0F766E', brandActive: '#115E59',
  cyan: '#0891B2', blue: '#2563EB',
  /* warning 与 CSS 同值：#D97706 在纸白底上只有 3.0:1，#B45309 是 4.7:1 */
  success: '#059669', warning: '#B45309', error: '#DC2626', info: '#2563EB',
  menuSelectedBg: 'rgba(13,148,136,0.10)', menuSelectedColor: '#0F766E',
  menuHoverBg: 'rgba(16,24,40,0.04)',
  btnShadow: '0 1px 2px rgba(13,148,136,0.18)',
  inputFocusShadow: '0 0 0 2px rgba(13,148,136,0.14)',
  /* 标签文字同样是「文字」，跟 --wb-text-brand 走 #0F766E，不跟填充色 #0D9488 */
  tagDefaultBg: 'rgba(13,148,136,0.10)', tagDefaultColor: '#0F766E',
  tableHeaderBg: '#F2F3F4', rowHoverBg: 'rgba(16,24,40,0.03)',
  treeBg: '#FFFFFF', treeHoverBg: 'rgba(16,24,40,0.04)',
  tooltipBg: '#FFFFFF', tooltipText: '#0F172A', tooltipBorder: 'rgba(15,23,42,0.12)',
  popoverBg: '#FFFFFF', popoverText: '#1D2129',
} as const;

/*
 * 取出某个主题的色板，供模块（如需要内联色值）复用。
 * 零引用（scan:dead 会报）：现在模块都走 CSS 变量（--wb-*），没人要 JS 里的色值 ——
 * 保留为扩展点：真要在 canvas / 内联 SVG 里手绘时，从这里取色才不会跟主题脱节。
 */
export function getPalette(mode: ThemeMode) {
  return mode === 'dark' ? DARK : LIGHT;
}

/*
 * 构建 AntD 全局配置（含中文语言包与组件级 token）
 * fontSize 为全局基准字号，省略时用默认值；控件高度随它联动。
 */
export function buildAntdConfig(
  mode: ThemeMode,
  fontSize: number = FONT_DEFAULT_SIZE,
): { locale: typeof zhCN; theme: ThemeConfig } {
  const isDark = mode === 'dark';
  const p = isDark ? DARK : LIGHT;
  const base = clampFontSize(fontSize);
  const dh = base - FONT_DEFAULT_SIZE;

  return {
    locale: zhCN,
    theme: {
      algorithm: isDark ? AntTheme.darkAlgorithm : AntTheme.defaultAlgorithm,
      token: {
        colorPrimary: p.brand,
        colorSuccess: p.success,
        colorInfo: p.info,
        colorWarning: p.warning,
        colorError: p.error,
        colorLink: p.cyan,
        colorBgLayout: p.bgBase,
        colorBgContainer: p.bgSurface,
        colorBgElevated: p.bgElevated,
        /* Tooltip 底色走别名 token colorBgSpotlight */
        colorBgSpotlight: p.tooltipBg,
        colorBgMask: 'rgba(0,0,0,0.5)',
        colorText: p.textPrimary,
        colorTextSecondary: p.textSecondary,
        colorTextTertiary: p.textTertiary,
        colorTextQuaternary: p.textQuaternary,
        colorBorder: p.borderPrimary,
        colorBorderSecondary: p.borderSecondary,
        borderRadius: 8,
        borderRadiusLG: 10,
        borderRadiusXS: 4,
        borderRadiusSM: 6,
        /* 字号与控件高度联动：base=13 时回落为 32/26/38（原设计），base=18 时为 37/31/43 */
        fontSize: base,
        fontSizeSM: Math.max(11, base - 2),
        fontSizeLG: base + 2,
        lineHeight: 1.5,
        controlHeight: CONTROL_H + dh,
        controlHeightSM: CONTROL_H_SM + dh,
        controlHeightLG: CONTROL_H_LG + dh,
        fontFamily:
          '"SF Pro Text", -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", Helvetica, Segoe UI, Arial, sans-serif',
        fontFamilyCode:
          '"JetBrains Mono", "SF Mono", Menlo, Monaco, Consolas, "Courier New", monospace',
        motionDurationMid: '0.16s',
        motionDurationFast: '0.10s',
        motionEaseOut: 'cubic-bezier(.2,.8,.2,1)',
      },
      components: {
        Layout: {
          headerBg: p.bgSurface,
          bodyBg: p.bgBase,
          siderBg: p.bgSider,
          headerHeight: 48,
          headerPadding: '0 14px',
          triggerBg: 'transparent',
          /* 注：antd 6 的 Layout 组件 token 不含 headerBorderBottom / siderBorderRight，
             这两处边框由 src/index.css 里的全局样式统一控制 */
        },
        Menu: isDark
          ? {
              darkItemBg: 'transparent',
              darkSubMenuItemBg: 'transparent',
              darkItemSelectedBg: p.menuSelectedBg,
              darkItemSelectedColor: p.menuSelectedColor,
              darkItemHoverBg: p.menuHoverBg,
              darkItemColor: p.textPrimary,
              darkItemDisabledColor: p.textTertiary,
            }
          : {
              itemBg: 'transparent',
              subMenuItemBg: 'transparent',
              itemSelectedBg: p.menuSelectedBg,
              itemSelectedColor: p.menuSelectedColor,
              itemHoverBg: p.menuHoverBg,
              itemColor: p.textPrimary,
              itemDisabledColor: p.textTertiary,
            },
        Tabs: {
          itemColor: p.textTertiary,
          itemSelectedColor: p.textPrimary,
          itemHoverColor: p.textSecondary,
          inkBarColor: p.brand,
          titleFontSize: base,
          cardBg: p.bgSurface,
          itemActiveColor: p.brand,
          horizontalItemGutter: 14,
        },
        Button: {
          colorPrimary: p.brand,
          colorPrimaryHover: p.brandHover,
          colorPrimaryActive: p.brandActive,
          primaryShadow: p.btnShadow,
          borderRadiusLG: 8,
          defaultBg: p.bgOverlay,
          defaultColor: p.textSecondary,
          defaultBorderColor: p.borderPrimary,
        },
        Input: {
          colorBorder: p.borderPrimary,
          hoverBorderColor: p.brand,
          activeBorderColor: p.brand,
          activeShadow: p.inputFocusShadow,
          colorBgContainer: p.bgSurface,
        },
        Select: {
          colorBorder: p.borderPrimary,
          hoverBorderColor: p.brand,
          activeBorderColor: p.brand,
          optionSelectedBg: p.menuSelectedBg,
          colorBgContainer: p.bgSurface,
        },
        Switch: {
          colorPrimary: p.brand,
        },
        Modal: {
          headerBg: p.bgElevated,
          contentBg: p.bgElevated,
          titleColor: p.textPrimary,
          /* 注：antd 6 的 Modal 组件 token 不含 headerBorderBottom / footerBorderTop */
        },
        Tag: {
          defaultBg: p.tagDefaultBg,
          defaultColor: p.tagDefaultColor,
        },
        Dropdown: {
          controlItemBgActive: p.menuSelectedBg,
        },
        Tree: {
          colorBgContainer: p.treeBg,
          nodeHoverBg: p.treeHoverBg,
          nodeSelectedBg: p.menuSelectedBg,
          directoryNodeSelectedBg: p.menuSelectedBg,
          titleHeight: 28,
        },
        Table: {
          headerBg: p.tableHeaderBg,
          rowHoverBg: p.rowHoverBg,
        },
        /* 注：antd 6 的 Tooltip / Popover 组件 token 里没有 colorBg / colorText。
           它们的底色来自别名 token（Tooltip 用 colorBgSpotlight，Popover 用 colorBgElevated），
           文字色跟随 colorText；另有 src/index.css 里的强制覆盖块兜底双主题对比度。 */
      },
    },
  };
}
