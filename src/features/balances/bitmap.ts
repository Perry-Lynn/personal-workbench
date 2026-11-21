/*
 * 菜单栏图标 · 位图缩放（纯数值，零 DOM 依赖）
 * ------------------------------------------------------------------
 * 只做一件事：**把一张 alpha 位图按统一口径缩放到目标尺寸**。
 *
 * ## 为什么要单独一个模块
 *
 *   `scripts/logic-test.ts` 跑在 node 里，**没有 document / canvas**。
 *   图标位图的另一条路径（画字形）必须用 canvas，只能留在 icons.ts、测不了；
 *   而「缩放」恰恰是**改了看不出来对不对**的一类代码 —— 屏幕上只是小一圈，
 *   不报错、不出异常值、诊断里一切正常。于是把它抽成纯数值模块让 node 能跑，
 *   这是本文件存在的唯一理由（别把 canvas 相关的东西搬进来）。
 *
 * ## 统一口径（2026-09-24）
 *
 *   加这个设置之前，两条路径各画各的：
 *     · 字形    —— 26px 字号，大写字母的墨迹只有 **≈18.7px**（cap 高 ≈ 0.72em）
 *     · 品牌 logo —— 墨迹 **34px**（素材四周只留 1px 边距）
 *   同一档「大小」下字母比 logo 小一圈，一排状态项里 [大 logo][小字母] 看着像坏了。
 *   现在两条路径收敛到同一句话：
 *
 *     **scale = 1 时，图标的墨迹（外接矩形较长的那一边）占画布 26px。**
 *
 *   26px 是**折中值**，不是拍的：
 *     · 往 logo 那边靠（34px）→ 字母墨迹要涨到 34px（cap 高 17pt），
 *       而字母的墨比 logo 实心得多，同等墨迹高度下字母看着比 logo 还重；
 *     · 往字形那边靠（18.7px）→ logo 要缩掉 45%，品牌标认不出来了。
 *   26px 在 36px 画布上四周留 5px（18pt 的格子里是 2.5pt），
 *   显示出来墨迹高 13pt —— 与菜单栏文字的 cap 高同量级，正是一个状态项图标该有的分量。
 *
 *   ⚠️ 想回到「加这个设置之前 logo 的大小」就拉到头（scale = 1.3 → 34px），
 *      见 prefs.MAX_TRAY_ICON_SCALE 的说明。
 *
 * ## 为什么是「裁到墨迹再缩放」，而不是「整张画布等比缩」
 *
 *   整张画布等比缩要求**素材自己把墨迹摆在正中间**（靠生成器里的 MARGIN=1），
 *   一旦哪天加进来的 logo 边距不对称，图标就会偏 —— 而偏 1~2px 肉眼能看出来、
 *   代码里完全看不出。裁到墨迹再居中则**与素材边距无关**：
 *   显示尺寸由运行时决定，素材只负责把图形画清楚。
 *   顺带的好处：以后换 logo 不用再纠结留几像素边距。
 *
 * ⚠️ 本文件**不能** import icons.ts（那边一加载就要 document），保持零依赖。
 * @Author: fu
 */

/*
 * 墨迹判定的 alpha 阈值。
 *
 * 不能写 0：抗锯齿会在图形外围撒下一圈 alpha = 1~3 的散点，
 * 用 `> 0` 判外接矩形时，一个远在天边的散点就能把 bbox 撑大、
 * 让整个图形缩小一圈 —— 而且这种素材肉眼几乎看不出有问题。
 * 8/255 ≈ 3%，低于它的像素当作「没有墨迹」，足够挡住散点又不伤图形边缘。
 */
const INK_THRESHOLD = 8;

/** 墨迹外接矩形（闭区间，单位像素） */
export interface InkBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 墨迹（alpha > threshold）的外接矩形；整张全透明时返回 null */
export function alphaInkBox(
  alpha: number[],
  size: number,
  threshold: number = INK_THRESHOLD,
): InkBox | null {
  let x0 = size;
  let y0 = size;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < size; y += 1) {
    const row = y * size;
    for (let x = 0; x < size; x += 1) {
      if (alpha[row + x] > threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

/**
 * 把 src 的 `box` 区域重采样成 dstSize × dstSize。
 *
 * **面积平均（box filter），不是最近邻**：36 → 24 是 1.5 : 1，最近邻要丢掉
 * 三分之一的源像素，笔画粗细会随方向变化（横竖不匀），18pt 下看着像「字体坏了」。
 * 面积平均按真实覆盖面积加权，缩到多小都还平滑。
 *
 * 放大时同一套公式退化成双线性附近的行为，够用（放大只发生在 logo 素材比目标还小的时候）。
 */
function resampleAlpha(src: number[], srcSize: number, box: InkBox, dstSize: number): number[] {
  const out = new Array<number>(dstSize * dstSize).fill(0);
  const ratioX = (box.x1 - box.x0 + 1) / dstSize;
  const ratioY = (box.y1 - box.y0 + 1) / dstSize;

  for (let dy = 0; dy < dstSize; dy += 1) {
    const sy0 = box.y0 + dy * ratioY;
    const sy1 = sy0 + ratioY;
    for (let dx = 0; dx < dstSize; dx += 1) {
      const sx0 = box.x0 + dx * ratioX;
      const sx1 = sx0 + ratioX;

      let sum = 0;
      let area = 0;
      for (let sy = Math.floor(sy0); sy < Math.ceil(sy1); sy += 1) {
        /*
         * ⚠️ **必须夹住下标**。`sy1` 是浮点累加出来的，本该正好等于 box 下边界时
         * 可能多出 1e-15（例如 34.941176470588232 + 1.0588235294117647 = 36.000000000000004），
         * `Math.ceil` 于是把循环多推一格 → 读到源数组之外 → `undefined * w = NaN`
         * → 整个位图里散着 NaN → IPC 过 JSON 变成 `null` → Rust 侧反序列化失败。
         * 这类错只在**某些尺寸组合**下出现（本例是 box=34 / 画布=36），
         * 换个尺寸就没事，所以必须在这里无条件夹住，而不是靠调参数绕开。
         */
        if (sy < 0 || sy >= srcSize) continue;
        const wy = Math.min(sy + 1, sy1) - Math.max(sy, sy0);
        if (wy <= 0) continue;
        const row = sy * srcSize;
        for (let sx = Math.floor(sx0); sx < Math.ceil(sx1); sx += 1) {
          if (sx < 0 || sx >= srcSize) continue;
          const wx = Math.min(sx + 1, sx1) - Math.max(sx, sx0);
          if (wx <= 0) continue;
          const w = wx * wy;
          sum += src[row + sx] * w;
          area += w;
        }
      }
      /* area 为 0 只可能来自空 box（bbox 保证非空），保险起见给 0 */
      out[dy * dstSize + dx] = area > 0 ? Math.round(sum / area) : 0;
    }
  }
  return out;
}

/** 把 srcSize × srcSize 的图放到 dstSize × dstSize 的正中央，四周补透明 */
function placeCentered(src: number[], srcSize: number, dstSize: number): number[] {
  const out = new Array<number>(dstSize * dstSize).fill(0);
  const offset = Math.floor((dstSize - srcSize) / 2);
  for (let y = 0; y < srcSize; y += 1) {
    const dy = y + offset;
    if (dy < 0 || dy >= dstSize) continue;
    for (let x = 0; x < srcSize; x += 1) {
      const dx = x + offset;
      if (dx < 0 || dx >= dstSize) continue;
      out[dy * dstSize + dx] = src[y * srcSize + x];
    }
  }
  return out;
}

/**
 * 统一口径的缩放：**裁到墨迹 → 等比缩放到 boxSize → 居中放进 canvasSize 的画布**。
 *
 * @param src        alpha 数组，长度必须是 srcSize × srcSize
 * @param srcSize    源画布边长
 * @param boxSize    目标墨迹边长（= round(INK_BOX_PX × scale)）
 * @param canvasSize 目标画布边长（= TRAY_ICON_PX，**不变**）
 *
 * 输出长度恒为 canvasSize × canvasSize —— 只缩墨迹、不缩画布，
 * Rust 侧的 `Image::new_owned(rgba, size, size)` 才不用跟着改。
 *
 * `boxSize` 非有限值 / ≤ 0 时按「不缩」处理（回落到整张画布），
 * 沿用 prefs 里 validInterval 的口径：**损坏值回默认，不夹到边界**。
 * 这一条不是洁癖：boxSize = 0 会得到一张全透明图 —— 菜单栏上图标直接消失，
 * 而诊断里一切正常，是这类设置最难查的失败方式。
 */
export function fitAlphaToBox(
  src: number[],
  srcSize: number,
  boxSize: number,
  canvasSize: number,
): number[] {
  const box =
    Number.isFinite(boxSize) && boxSize > 0
      ? Math.max(1, Math.min(canvasSize, Math.round(boxSize)))
      : canvasSize;

  const ink = alphaInkBox(src, srcSize);
  /* 整张全透明（素材坏了 / 还没画）→ 原样返回一张空的，让调用方照常走
     「有图标」的路径，而不是在这里返回 null 把错误往上抛 */
  if (!ink) return new Array<number>(canvasSize * canvasSize).fill(0);

  return placeCentered(resampleAlpha(src, srcSize, ink, box), box, canvasSize);
}
