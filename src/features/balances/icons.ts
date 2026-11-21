/*
 * 菜单栏图标 · 位图（品牌 logo / 字形 → RGBA）
 * ------------------------------------------------------------------
 * 把「这一格该画什么」变成正方形 RGBA 位图，交给
 * src-tauri/src/core/tray.rs 的 workbench_tray_sync 当状态项图标。
 *
 * ## 两种图标，优先级明确
 *
 *   1. **品牌 logo**（`PROVIDER_LOGO_ALPHA` 里登记过的平台）—— 优先，且**恒定**：
 *      用户给这个平台改名字，图标**不变**。理由：logo 标识的是**平台**，
 *      不是名字；把「Qoder」改成「主力号」，logo 还是 Qoder，这符合直觉。
 *   2. **字形**（`tray.glyphOf` 给的一个字符）—— 没有 logo 的平台用它；
 *      用户改了名字，字形跟着名字走（见 tray.glyphOf 的说明）。
 *
 * 于是 `TrayItem.glyph` 的语义是「**这一格要显示图标，没有 logo 时用这个字形**」，
 * 非 null ⇔ 这一格有图标（见 tray.buildTrayItems 的 `withIcon`）。
 *
 * ## 为什么图标在前端画，而不是在 Rust 里画
 *
 *   1. **Rust 侧不需要任何图像解码能力**。tray-icon 收的是原始 RGBA
 *      （`Image::new_owned` → `Icon::from_rgba`），所以 Cargo.toml 不必开
 *      `image-png`；反过来若把图标做成 PNG 资源，就得为一张 36×36 的小图引解码器。
 *   2. **换图标不动 Rust**。加一个平台的 logo = 往 `PROVIDER_LOGO_ALPHA` 里加一条
 *      （素材与生成方式见下面那张表的说明），Rust 与偏好都不用动。
 *
 * ## 为什么用 Canvas 而不是内联 SVG
 *
 *   设置页里要预览、菜单栏上要位图，两者**必须是同一份像素**。
 *   SVG 预览 + Canvas 出图是两套实现，改一处忘一处就会「预览和菜单栏不一样」，
 *   而这类不一致极难发现。这里统一由 Canvas 出位图，预览把位图转成 data URL
 *   显示（见 BalancesView 的 TrayPreviewChip），于是不可能对不上。
 *
 * ## ⚠️ 模板图（template image）
 *
 *   Rust 侧用 `set_icon_with_as_template(_, true)`，macOS 只取**alpha 通道**、
 *   用菜单栏前景色着色（深浅色外观自动适配）。所以这里画**纯白**即可，
 *   RGB 会被系统忽略 —— 千万别在这里调颜色来「适配主题」，那是无效的。
 *
 * ⚠️ 本文件需要 DOM（canvas），**不进 scripts/logic-test.ts**（那边跑在 node 里）。
 *    字形本身（glyphOf）是纯逻辑，在 tray.ts，那边有断言；
 *    logo 登记的契约（id 是真平台、base64 长度对）由 `npm run check:labels` 守；
 *    **缩放**（改了看不出来对不对的那部分）抽在 bitmap.ts，那边有断言。
 * @Author: fu
 */

import { fitAlphaToBox } from './bitmap';

/*
 * 图标位图边长（像素）。
 *
 * 36 = macOS 菜单栏的 **18pt @2x** —— tray-icon 会强制把图标缩放到 18pt 高
 * （读 tray-icon-0.24.2/platform_impl/macos/mod.rs 确认：`let icon_height = 18.0;`），
 * 所以给 36×36 正好是 Retina 下的原生分辨率，不会再被拉伸。
 * 给 18×18 也能用，只是在 Retina 上会糊。
 *
 * ⚠️ **这个值恒定不变**，缩放改的是墨迹、不是画布（见 bitmap.fitAlphaToBox）：
 * 画布一变，Rust 侧 `Image::new_owned(rgba, size, size)` 也得跟着变。
 */
export const TRAY_ICON_PX = 36;

/*
 * 统一口径的目标墨迹边长（像素）：**scale = 1 时墨迹占 26px**。
 *
 * 字形与品牌 logo **共用**这一个数 —— 于是同一档「大小」下字母和 logo 一样大
 * （以前字母的墨迹只有 ≈18.7px、logo 有 34px，并排看着像坏了）。
 * 26 这个折中值是怎么来的、还有哪些取舍，写在 bitmap.ts 的「统一口径」那一节，
 * 那里是唯一该改这个数的地方。
 */
const INK_BOX_PX = 26;

/*
 * 字形的**基准**字号：只用来量一次墨迹，真正落笔的字号按目标墨迹反推
 * （见 glyphBitmap）。取 26px 是为了让量出来的 cap 高（≈0.72em ≈ 18.7px）
 * 与 INK_BOX_PX 同量级，反推系数接近 1，数值上更稳。
 */
const GLYPH_BASE_PX = 26;

/** 系统字体栈。字形是拉丁字母或汉字，任何一项都能画出来 */
function glyphFont(px: number): string {
  return `600 ${px}px -apple-system, "Helvetica Neue", "PingFang SC", sans-serif`;
}

/**
 * scale → 目标墨迹边长（像素）。
 *
 * 导出是为了让**推送去重键**用同一个数（service.syncTray）：键里若用 scale 原值，
 * 两个只差浮点噪声的值会各触发一次重推；用这个量化后的像素数则口径一致
 * —— 「图标缓存键」与「去重键」都只认最终尺寸。
 *
 * 这里只做「非有限值当 1」的兜底，真正的夹取在 bitmap.fitAlphaToBox 里 ——
 * 但字形那条路径不经过它，所以两边各兜一次，别以为只有一处。
 */
export function trayInkPx(scale: number): number {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return Math.max(1, Math.min(TRAY_ICON_PX, Math.round(INK_BOX_PX * s)));
}

export interface TrayIconBitmap {
  /** 正方形边长（像素），与 rgba.length 必须是 size × size × 4 */
  size: number;
  /** RGBA 逐像素。**普通数组**，理由见 glyphBitmap 里那段注释 */
  rgba: number[];
}

/* =============================================
   ====== 品牌 logo（alpha 位图） ======
   ============================================= */

/*
 * 各平台品牌 logo 的 **alpha 通道**，36×36、8 位、base64（正好 1296 字节 → 1728 字符）。
 *
 * 为什么只存 alpha：菜单栏图标是**模板图**，系统只用 alpha 通道着色，
 * RGB 完全被忽略 —— 存 RGB 是白存三倍体积。而 logo 原图的墨迹恰好是
 * 「近黑 + alpha 255」、背景「alpha 0」，所以 alpha 通道**就是**墨迹覆盖率。
 *
 * 为什么嵌在源码里而不是读资源文件：
 *   ① 读文件要 `Image`/`fetch`，都是**异步**的，会把 trayIconBitmap 变成 async，
 *      进而把 service.syncTray 与设置页渲染都拖成异步 —— 只为一张 1.7KB 的小图不值当；
 *   ② 前端直接 `atob` 解码是同步的，几微秒。
 *
 * ⚠️ **这段数据不要手改** —— 它是 `.workbuddy-ai/assets/tray-logos/make-alpha-b64.py`
 *    的产物。那个目录里还有两个平台的原始素材（`qoder.png` / `chatgpt.svg`）：
 *    换 logo、调边距、加平台都只改那边再跑一遍，**加 `--write` 让它直接写回本文件**
 *    （1700 多个字符手工转录必然出错，而错了不报任何错 —— 长度对、id 对，
 *    只是像素不对，菜单栏上画出来是糊的）。跑完它会重新读回磁盘再自检一遍。
 *    `npm run check:labels` 另外校验「id 是真平台」与「base64 解出来正好 1296 字节」。
 *
 * 已登记：
 *   qoder   —— Qoder 官方横版 logo 的图形标（已裁掉 "Qoder CN" 文字）
 *   chatgpt —— ChatGPT 官方图形标（24×24 viewBox 的路径，一字未改）
 */
const PROVIDER_LOGO_ALPHA: Record<string, string> = {
  qoder:
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAACUyXzu/35LFcAwAAAwAAAAAAAAAAAAAAAAAA' +
    'AAAAAAADAARm0f3/////////x1IAAAICAAAAAAAAAAAAAAAAAAAAAAMAKcP/////79DJ3f////++RAAAAwIAAAAAAAAAAAAA' +
    'AAAAAwA/6////rFXIgEAD03B/////qw0AAADAQAAAAAAAAAAAAACADfw///TQwAAAAABAAABVs3////7oCsAAAMBAAAAAAAA' +
    'AAIBF+L//7IPAAMDAgEAAQMAAAVk1Pz+//eUIQAAAwAAAAAAAAIAq///uwgAAwAAAAAAAAAABQAAEqz++f//7IIUAAIAAAAA' +
    'AABE//3jFwADAAAAAAAAAAADAAlxz/D7///////hXgACAAAAAAG5/v9aAAQAAAAAAAAAAAMAP9L//////ebp/////4IAAwAA' +
    'ADH5/swCAgEAAAAAAAAAAwBj+P/6/bllLxcaPKT/+/9WAAAAAIH//2wAAwAAAAAAAAADAGX//v7/+xIAAAAAAABr/v7dDwAA' +
    'ALj/+CkAAgAAAAAAAAIARPz9/vT/+R0DBAEBAwQAoP//YwAAANr/2w0AAQAAAAAAAQET3///eqn/9hsAAgAAAAMCM/v+rgAA' +
    'AOr/zQEAAQAAAAAAAwCN//+3AK7/9hsAAgAAAAEAD97/1QAAAOv/zAAAAQAAAAACAB/y/e0hAbX/8xoAAgAAAAEAAc3/5wAA' +
    'AOv/zAAAAQAAAAAEAHv//4UABcb/4xEAAQAAAAEAAMz/6AAAAOv/zAAAAQAAAAEBA8b+9SUCG+7/wwIBAQAAAAEAAMz/6AAA' +
    'AOv/zAAAAQAAAAEAHPP/vwIAXf//jgAEAAAAAAEAAMz/6AAAAOv/zAAAAQAAAAMAP///kAEDxv7+OwADAAAAAAEAAMz/6AAA' +
    'AOn/zQEAAQAAAAMAU///egBe///GBAEAAAAAAAEAAMz/6AAAANj/3g8AAQAAAAMAV///ZBXq/f9JAAMAAAAAAAEAAMz/6AAA' +
    'ALL+/DgBAwAAAAMAV//+g7z//6UAAwAAAAAAAAEAAMz/6AAAAGj//6cABQIAAAMAV//9+v//1hICAQAAAAAAAAEAAMz/6AAA' +
    'ABHh/f5sAAADAQMAV//9/f/jKQACAAAAAAAAAAEAAMz/6AAAAABZ//v/oSkAAAcBV//8/9EnAAIAAAAAAAAAAAEAAMz/6AAA' +
    'AAIAhP////KNHAAAWf//sRAAAwAAAAAAAAAAAAEAAMz/6AAAAAECAGTn////6H0PN///ewAGAAAAAAAAAAAAAAEAAMz/6AAA' +
    'AAAAAgAZhuz////divb/twADAAAAAAAAAAMCAwMAAMz/6AAAAAAAAAMAAB+S9P////3+9SgABQEBAQEEAgAAAAACA8z/6AAA' +
    'AAAAAAABAwAALaT9//76/8ENAAAAAAAAAD60mDEAAM3/6QAAAAAAAAAAAAIDAAA7s///+//KSAoABBtZrvz///imfvT92wAA' +
    'AAAAAAAAAAAAAgIAAES9/////9/E0PH/////////////fAAAAAAAAAAAAAAAAAACAgAAVM3//////////9locN7///+TBgAA' +
    'AAAAAAAAAAAAAAAAAAMBAAVTp9337cWHRQgAAAtKXDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  chatgpt:
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAFVaDM28ibSwEABAMAAAMEAgAAAAAAAAAA' +
    'AAAAAAAAAAADAEPJ/////////8A1AAADAwAAAAMBAAAAAAAAAAAAAAAAAAIAY/7/yW1BNEaG3f/wi7HMy7V4JQAAAQAAAAAA' +
    'AAAAAAAAAwBG/vlqAgAAAAAAN+b/////////9IsLAAEAAAAAAAAAAAABAg3c/10AAQYFAA986f/vkkgtMlyr///BEgABAAAA' +
    'AAAAAAEHAF//qgAFAwAAUtH//6UoAAAAAAAAQt3/tQUCAAAAAAAAAgAABrb9QwEEADWy///AQwAAAQAAAAcFACnm/2QAAwAA' +
    'AAACAARu0f/uGgABffv/3mMBAAMADHyRHgAACQBj/9MIAQEAAAIAIML////lDAAL6v+OFQADAABb1f//6HAIAAQP4f8yAAIA' +
    'AAIW1P/YaPbpCgAN4vwLAAAAOLr//8Sy///PTgAArP9eAAMAAACj/8oWBvjpCgAN5PwWAByR9v/UaggAUtD//6ojjf9vAAMA' +
    'AD/+7yQAHPfpCgAN5fsZaur///yHAAAEAAlv5v/t2v9gAQMAAJ//hgABF/fpCgAN5PvS//+mqP//zUsAAAIAHZT///1HAAMA' +
    'AN3+OQEAF/fpCgAO4P//w0YAAEjD//+uLgABAAA4xf/RFwEAAP3wHgAAF/fpDQAN4v5pAgACAgACa/v/9YMQAAMAC7z/rAAA' +
    'AP7wHQAAF/XoAAAQ5PwIAAQAAAQAC/X2/v/bYgMEABvo/zgAAN7+OAEAGPv3YwAB5fwYAQEAAAEBGfzfQrP//68HBACD/owA' +
    'AKD/hAAEBbD//7RA4f0YAQEAAAEBGfvjBABe9vsiAAE5/8QAAED+6BwABANi3P/+9vYKAAQAAAQACfviEgAA4/YgAAAc9PYA' +
    'AACm/7sLAAMAE4f3//lqAAACAgAAaf7fDwAJ5PggAAAc9PUAAAEV0v/HOQAAAQAurf//xUsAAEnE///eEAAG5PggAAE5/8MA' +
    'AAMAR/3//5QcAAEAAE3O//+ppv//0vvhEAAG5PggAQCF/4oAAAMBXv/e7f/ncgoABQAAh/v//+dpGvrjDwAG5PgmACTs/zcA' +
    'AAQAbv+PIKz//89RAAlp1v/1jhgAGPviDwAG5PkQEsj/qQAAAAMAXP+oAABNzP//scT//7c2AAAADPvgDwAH5Pdt0//TFwIA' +
    'AAMAM//dCwMABWzk///QVAAAAwAVjf/nDgAH4f7//8MfAAIAAAABCNP/XAAJAAAaiXQJAAMAAWHd//x9AQAR7v/SbgUAAgAA' +
    'AAADAGT/4yUABAYAAAACAABFw///sTUABAE9/rgFAAACAAAAAAABAgW1/9xCAAAAAAAAJqT//9JTAAADBQCk/14ABwEAAAAA' +
    'AAAAAQASwP//rFo2MkaQ7//nexAABQYCAFj+3A0CAQAAAAAAAAAAAAEACYr0/////////+g3AAAAAAACafn+RgADAAAAAAAA' +
    'AAAAAAABAAAleK/Lza6K8P/dhko1Q23H//1jAAMAAAAAAAAAAAAAAAAAAQMAAAAEBAAANsT/////////zkQAAwAAAAAAAAAA' +
    'AAAAAAAAAAACBAIAAAIEAABChLLCtYlKAwACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
};

/**
 * 该平台有没有内置品牌 logo。
 *
 * 有 logo 的平台，图标**恒为 logo**（用户改名也不变，理由见文件头）。
 * 导出是为了让设置页能标明「这一格用的是品牌图标」而不是画一个字形预览。
 */
export function hasBrandLogo(provider: string): boolean {
  return typeof PROVIDER_LOGO_ALPHA[provider] === 'string';
}

/**
 * base64 → **alpha 数组**（长度 36×36）；数据不合法时返回 null。
 *
 * 为什么中间过一道「只有 alpha」的数组：base64 里本来就只存了 alpha，
 * 而缩放要在 alpha 上做（bitmap.ts 只认 alpha）。先解 alpha、缩完再补纯白 RGB，
 * 比「先补 RGB 再缩放」少动 3/4 的数据，也让缩放那条路径完全与 RGB 无关。
 */
function logoAlpha(provider: string): number[] | null {
  const b64 = PROVIDER_LOGO_ALPHA[provider];
  if (!b64) return null;

  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    return null; /* base64 坏了 —— check:labels 会先一步拦住，这里只是不崩 */
  }
  const px = TRAY_ICON_PX * TRAY_ICON_PX;
  if (bin.length !== px) return null;

  const alpha = new Array<number>(px);
  for (let i = 0; i < px; i += 1) alpha[i] = bin.charCodeAt(i);
  return alpha;
}

/**
 * alpha 数组 → RGBA 位图。
 *
 * RGB 一律给**纯白**（模板图会忽略它），于是与字形那条路径**同构** ——
 * Rust 侧与设置页预览都只有一种输入形状，不必分辨「这张图是 logo 还是字形」。
 */
function alphaToBitmap(alpha: number[]): TrayIconBitmap {
  const px = TRAY_ICON_PX * TRAY_ICON_PX;
  const rgba = new Array<number>(px * 4);
  for (let i = 0; i < px; i += 1) {
    rgba[i * 4] = 255;
    rgba[i * 4 + 1] = 255;
    rgba[i * 4 + 2] = 255;
    rgba[i * 4 + 3] = alpha[i];
  }
  return { size: TRAY_ICON_PX, rgba };
}

/** 品牌 logo 位图（墨迹按 scale 缩放到统一口径）；数据不合法时返回 null */
function logoBitmap(provider: string, scale: number): TrayIconBitmap | null {
  const alpha = logoAlpha(provider);
  if (!alpha) return null;
  /*
   * 裁到墨迹再缩放到目标尺寸 —— 于是**显示大小与素材边距无关**：
   * 素材只负责把图形画清楚，尺寸由运行时决定。换 logo 不用再纠结
   * 生成器里留几像素边距（详见 bitmap.ts 的「统一口径」与「为什么裁到墨迹」）。
   */
  return alphaToBitmap(fitAlphaToBox(alpha, TRAY_ICON_PX, trayInkPx(scale), TRAY_ICON_PX));
}

/* =============================================
   ====== 字形位图（canvas） ======
   ============================================= */

/** 复用一个画布：每次新建 canvas 会带来不必要的布局/内存开销 */
let canvas: HTMLCanvasElement | null = null;

function getContext(): CanvasRenderingContext2D | null {
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.width = TRAY_ICON_PX;
    canvas.height = TRAY_ICON_PX;
  }
  /* willReadFrequently：我们每次都要 getImageData，提前声明能让浏览器
     用 CPU 侧后备存储，省掉一次 GPU 回读 */
  return canvas.getContext('2d', { willReadFrequently: true });
}

/** 把一个字符按统一口径画成位图；画布不可用时返回 null */
function glyphBitmap(glyph: string, scale: number): TrayIconBitmap | null {
  const ctx = getContext();
  if (!ctx) return null;

  ctx.clearRect(0, 0, TRAY_ICON_PX, TRAY_ICON_PX);
  ctx.textAlign = 'center';
  /* 用 alphabetic 基线 + 实测墨迹高度来居中，而不是 textBaseline='middle' ——
     后者对齐的是 em 方框的中点，大写字母会明显偏上/偏下（随字体而变）。
     图标只有 18pt，偏一两像素肉眼就看得出「歪了」。 */
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#ffffff';

  /*
   * ⚠️ **整个函数只能调一次 measureText**。
   *
   * 无头浏览器探针（`.workbuddy-ai/probe`）在 canvas 桩里记录「被量过的字形」，
   * 用来断言「没有 logo 的平台才画字形」（探针桩不认识 fillText 的语义，
   * 只能靠 measureText 这一句当作「要画这个字形」的信号）。多量一次，
   * 那条断言就废了。
   *
   * 所以：在**基准字号**上量一次拿到墨迹形状，之后全部靠比例换算 ——
   * 文本的墨迹尺寸与字号成正比，这是可以依赖的（同一字体、同一字符串）。
   */
  ctx.font = glyphFont(GLYPH_BASE_PX);
  const m = ctx.measureText(glyph);

  /* actualBoundingBox* 在部分引擎里可能缺失/为 0，那时退回经验值
     （cap 高 ≈ 0.72em；宽度退回 advance width） */
  const asc0 = m.actualBoundingBoxAscent || GLYPH_BASE_PX * 0.72;
  const desc0 = m.actualBoundingBoxDescent || 0;
  const left0 = m.actualBoundingBoxLeft || 0;
  const right0 = m.actualBoundingBoxRight || 0;
  const inkW0 = left0 + right0 || m.width;
  const inkH0 = asc0 + desc0;

  /*
   * 等比缩放到目标墨迹：取**较长的一边**去凑 —— 与 logo 那边
   * 「墨迹外接矩形的长边 = 目标尺寸」是同一句话（bitmap.resampleAlpha 也按长边定比例）。
   * 于是窄字母（I）与宽字母（W）都以「装得下」为准，不会被裁掉。
   */
  const k = trayInkPx(scale) / Math.max(inkW0, inkH0, 1);
  const asc = asc0 * k;
  const desc = desc0 * k;

  ctx.font = glyphFont(GLYPH_BASE_PX * k);
  const half = TRAY_ICON_PX / 2;
  /* 垂直：让墨迹（baseline-asc ~ baseline+desc）在画布上居中 */
  const baseline = half + (asc - desc) / 2;
  /* 水平：textAlign='center' 居中的是 **advance 宽度**，而墨迹因左右边距
     并不正好对称（单字母约差 0.5~1px）。这里把这点偏心补回去，
     于是「墨迹居中」这条与 logo 路径完全一致。 */
  const dx = ((left0 - right0) / 2) * k;

  ctx.fillText(glyph, half + dx, baseline);

  const data = ctx.getImageData(0, 0, TRAY_ICON_PX, TRAY_ICON_PX).data;
  /*
   * ⚠️ **必须 Array.from**，不能直接把 `data`（Uint8ClampedArray）交给 IPC。
   *
   * tauri 的 invoke 用 JSON 序列化参数，而 `JSON.stringify(new Uint8ClampedArray([1,2]))`
   * 得到的是 `{"0":1,"1":2}` —— 一个**对象**，不是数组。Rust 侧的
   * `Vec<u8>` 会因此反序列化失败，报一句读不懂的类型错。
   * 这类错只在真正推送时才出现，改完代码看不出来，所以在这里钉一句。
   */
  return { size: TRAY_ICON_PX, rgba: Array.from(data) };
}

/* =============================================
   ====== 对外入口 ======
   ============================================= */

/*
 * 按「图标身份 + 尺寸」缓存。
 *
 * 菜单栏每次刷新（默认 15 分钟）都要重建全部图标，而画布 + getImageData
 * 是同步且不便宜的（36×36×4 = 5184 个像素要跨边界拷出来）。图标一共就那么几个
 * （平台数 ≤ 十来个），缓存一份即可。
 *
 * 键用 `logo:<provider>` / `glyph:<字符>` 而不是「provider + 字形」：
 * logo 与字形是两个独立的位图，混在一个键里会让同一张 logo 被存好几份。
 *
 * ⚠️ **键里必须带尺寸**（用 `inkBoxFor` 的结果，也就是量化后的目标墨迹像素数，
 * 不是原始 scale）：拖动设置页的滑块时同一张图会被以多个尺寸反复请求，
 * 不区分就会把「上一个尺寸」的位图当成这次的答案返回 —— 表现是「拖了没反应，
 * 松手重开才生效」。用墨迹像素数而不是 scale 原值，是为了让
 * `0.7000000000000001` 这类浮点噪声落在同一个键上。
 */
const cache = new Map<string, TrayIconBitmap>();

/**
 * 取某一格的图标位图。
 *
 * @param provider 平台 id（`TrayItem.key`）。有品牌 logo 时用它查表
 * @param glyph    没有 logo 时画哪个字形（`TrayItem.glyph`）
 * @param scale    全局图标大小（`prefs.trayIconScale`）。
 *                 ⚠️ **刻意不给默认值**：忘了传会静默按标准尺寸出图，
 *                 屏幕上只是「设置没生效」，谁也看不出是这里漏了参数。
 *
 * 返回 null 表示这一格没有图标 —— 画布拿不到（理论上不会）时也走这里，
 * 调用方按「没有图标」处理，而不是让整次同步失败。
 */
export function trayIconBitmap(
  provider: string,
  glyph: string,
  scale: number,
): TrayIconBitmap | null {
  const box = trayInkPx(scale);

  if (hasBrandLogo(provider)) {
    const key = `logo:${provider}:${box}`;
    const hit = cache.get(key);
    if (hit) return hit;

    const bmp = logoBitmap(provider, scale);
    if (bmp) {
      cache.set(key, bmp);
      return bmp;
    }
    /*
     * logo 数据坏了（长度不对 / base64 非法）→ **退回字形**。
     * 不能就此返回 null：这一格的文字在「有图标」的前提下是**只有数值**的
     * （见 tray.composeTitle），没有图标就只剩一个裸数字，谁也认不出是哪个平台。
     * 宁可显示一个字母。`check:labels` 会先一步把这种数据拦在提交之前。
     */
  }

  const key = `glyph:${glyph}:${box}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const bmp = glyphBitmap(glyph, scale);
  if (bmp) cache.set(key, bmp);
  return bmp;
}

/**
 * 图标位图的 data URL，供设置页预览。
 *
 * 刻意**复用同一份位图**（而不是另画一个 SVG）：预览与菜单栏必须是同一份像素，
 * 否则「预览和实际不一样」这种问题查起来极费劲（见文件头说明）。
 *
 * 只有 alpha 通道有意义（模板图），所以给个纯色底再叠上去 ——
 * 否则在浅色卡片上「白字透明底」会完全看不见。
 *
 * 结果**按「图标 + 颜色 + 尺寸」缓存**：预览在每次渲染里都会调它，
 * 而 `toDataURL` 要编码 PNG，比画字形还贵。
 */
const urlCache = new Map<string, string>();

export function trayIconDataUrl(
  provider: string,
  glyph: string,
  color: string,
  scale: number,
): string | null {
  const box = trayInkPx(scale);
  const key = `${provider}\u0000${glyph}\u0000${color}\u0000${box}`;
  const hit = urlCache.get(key);
  if (hit !== undefined) return hit;

  const bmp = trayIconBitmap(provider, glyph, scale);
  if (!bmp) return null;
  const c = document.createElement('canvas');
  c.width = bmp.size;
  c.height = bmp.size;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  const img = ctx.createImageData(bmp.size, bmp.size);
  const rgb = hexToRgb(color);
  for (let i = 0; i < bmp.rgba.length; i += 4) {
    const a = bmp.rgba[i + 3] / 255;
    /* 把白色图形按 alpha 合成到指定颜色上（模板图的语义就是这样） */
    img.data[i] = rgb.r;
    img.data[i + 1] = rgb.g;
    img.data[i + 2] = rgb.b;
    img.data[i + 3] = Math.round(a * 255);
  }
  ctx.putImageData(img, 0, 0);
  const url = c.toDataURL('image/png');
  urlCache.set(key, url);
  return url;
}

/** `#rgb` / `#rrggbb` → 分量。认不出就当黑色（预览而已，不值得报错） */
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const s = hex.trim().replace(/^#/, '');
  const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  if (!/^[0-9a-f]{6}$/i.test(full)) return { r: 0, g: 0, b: 0 };
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}
