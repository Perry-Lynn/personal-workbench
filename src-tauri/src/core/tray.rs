/*
 * 系统菜单栏（macOS 顶部状态栏 / Windows·Linux 托盘）
 * ------------------------------------------------------------------
 * 工作台级共用能力：把**若干行短文字**挂到系统菜单栏上，供用户随时瞥一眼。
 * 本层不认识「余额」—— 它只知道「每个状态项的标题 + 悬停提示 + 图标」，
 * 内容由调用方算好传进来（余额模块的算法在 src/features/balances/tray.ts，
 * 那边是纯逻辑、可单测）。
 *
 * ## 两类状态项，职责不重叠
 *
 *   1. **主项**（id = `TRAY_ID`，标题「工作台」）
 *      唯一的用途是**关窗转后台之后的兜底入口**。**只有在后台、且菜单栏上
 *      没有任何 agent 额度格时**才出现 —— 判据见 `should_show_main_item`。
 *      只要还有额度格，主项就不出现：那些格子本身就是入口（左键弹菜单、菜单里有「显示主窗口」），
 *      再挂一格「工作台」就是多余。
 *      ⚠️ **余额模块不许碰它**。这条禁令是「应用变成孤儿」那个致命故障的根治办法：
 *      以前余额模块关掉菜单栏显示时会把唯一入口一起藏掉，于是不得不再写一套
 *      「后台期间推迟隐藏 + 唤回后补做」的机制去兜。现在入口与业务内容分开，
 *      兜底机制整体删掉了（见 core::lifecycle 的说明）。
 *
 *   2. **平台项**（id = `TRAY_ITEM_PREFIX` + 平台 key）
 *      每个智能体一格，由余额模块通过 `workbench_tray_sync` **全量声明**。
 *      不在这份声明里的旧项会被自动藏掉，所以调用方不需要自己记「上次发了什么」。
 *
 * ## 为什么是**代码式**而不是 tauri.conf.json 的 `app.trayIcon`
 *   配置式只在启动时建一次，之后拿不到句柄改标题；而余额每次刷新都要改文字。
 *
 * ## 下面这些平台事实都是读 tauri 2.11.5 / tray-icon 0.24.2 源码确认的，
 *    不是猜的 —— 它们决定了本文件为什么长这样：
 *
 *   1. **一个 `TrayIcon` 就是一个独立的 `NSStatusItem`**，所以「每个平台一格」
 *      是系统层面支持的，不需要任何 hack（tray-icon macos/mod.rs 的 `create`
 *      里每次调 `NSStatusBar::systemStatusBar().statusItemWithLength(...)`）。
 *   2. **可以只有文字、没有图标。** tray-icon 在 icon 为 None 时走
 *      `button.setImage(None)`，状态项长度是 NSVariableStatusItemLength（自适应内容）。
 *   3. **图标会被强制缩放到 18pt 高**，宽度按原始宽高比推算
 *      （macos/mod.rs: `let icon_height = 18.0;`）。所以**给正方形图标**即可，
 *      不必自己算尺寸；给 36×36 就是 Retina 下的 18pt。
 *      同时它设了 `setImagePosition(NSCellImagePosition::ImageLeft)` ——
 *      图标天然排在文字**左边**，不用我们排。
 *   4. **图标走的是「RGBA → 内部编码 PNG → NSImage」**（tray-icon 自带 `png` 依赖）。
 *      也就是说 `tauri::image::Image::new_owned(rgba, w, h)` 就够了，
 *      **不需要给 tauri 开 `image-png` 特性**（那个特性是为了从字节解码 PNG）。
 *   5. **`set_title(None)` 不会清空标题** —— tray-icon 的 `set_title_inner` 只在
 *      `Some` 时才 `setTitle`。要清空必须传 `Some("")`。
 *   6. **所有 `set_*` 内部都走 `run_item_main_thread!`，从任意线程调都安全。**
 *      那个宏最终落到 `send_user_message`，它会先判断「当前是不是主线程」：
 *      是就**就地执行**，否则投递事件并阻塞等结果。所以无论从主线程（同步命令）
 *      还是运行时线程（异步命令）调用都不会死锁。
 *   7. **`TrayIcon` 是引用计数的，`build()` 会把它登记进 app 的 resources_table**，
 *      所以**不需要自己保存句柄**；之后用 `app.tray_by_id(id)` 取回来即可。
 *   8. **`tray_by_id` 是精确匹配**（manager/tray.rs 里 `tray_icon_id == &id`），
 *      不是前缀匹配 —— 所以主项 id 是平台项 id 的前缀也不会有问题。
 *   9. **左键与右键都弹同一份菜单**（2026-11-06 调整，用户要求左键也能看到额度明细）。
 *      `show_menu_on_left_click(true)` 让 tray-icon 自己在左键抬起时 `performClick`
 *      弹菜单，我们**不再**在 `on_tray_icon_event` 里做任何事 —— 否则一次点击会
 *      「弹菜单 + 唤回窗口」双触发。菜单里的「显示主窗口」仍然负责唤回，
 *      所以左键不再顺带打开主窗口。
 *      菜单里的「退出工作台」是**必需的**：关窗转入后台后应用被转成 UIElement，
 *      没有自己的菜单栏，Cmd+Q 也就不可用了（见 core/lifecycle.rs）。
 *
 * ## ⚠️ 一条已经不存在的坑，别照着旧代码再写一遍
 *   以前这里有个 `reset_to_default()`，必须在 `set_visible(false)` **之前**
 *   把标题/提示归位 —— 因为 tray-icon 的 `set_visible(true)` 在状态项不存在时会
 *   拿 attrs 里存的标题/图标**重新建**，不归位就会让上一次推送的余额数字
 *   在下次重新显示时复活成一个过期数字。
 *   现在**不再需要**它：`workbench_tray_sync` 每次都是「先写标题/提示/图标，
 *   最后才 `set_visible`」，attrs 在被读之前一定是最新的。
 *   ⚠️ 所以改这个文件时必须守住那条顺序 —— **`set_visible` 永远放最后**。
 *
 * 非 macOS 平台：命令照常存在。Windows/Linux 上 `set_title` 不生效
 * （tauri 文档明确写了 Windows 不支持、Linux 需要配图标），但不会报错 ——
 * 前端把「菜单栏不可用」当成静默降级处理，不影响余额功能本身。
 * @Author: fu
 */
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use tauri::image::Image;
use tauri::menu::{Menu, MenuBuilder, MenuEvent, MenuItemBuilder};
use tauri::tray::{TrayIcon, TrayIconBuilder};
/* 注意：`tray_by_id` 是 AppHandle 的**固有方法**，不需要 `Manager` 这个 trait */
use tauri::{command, AppHandle, Wry};

use crate::core::api::ApiResponse;

/*
 * 主项（后台入口）的 id。同一进程里 id 重复会让 build() 建出两个状态项，
 * 所以一律「先查后建」。
 */
pub const TRAY_ID: &str = "workbench-tray";

/*
 * 平台项的 id 前缀。后面接平台 key（= 后端 provider id，如 "qoder"）。
 * ⚠️ 平台 key 里**只允许** `[a-z0-9_]`（后端 all_providers() 的定义就是如此），
 * 这里不做转义 —— 带斜杠或空格的 key 会造出畸形的 id，虽然不会崩，
 * 但 `tray_by_id` 的精确匹配会变得难以推理。
 */
pub const TRAY_ITEM_PREFIX: &str = "workbench-tray-item-";

/*
 * 主项的默认标题与悬停提示。
 * 它是「关窗转入后台之后唯一的入口」，所以文案要写清楚怎么用。
 */
const DEFAULT_TITLE: &str = "工作台";
const DEFAULT_TOOLTIP: &str = "个人工作台 · 左键或右键打开菜单";

/* 右键菜单项 id。带前缀避免与将来其它菜单撞名 */
const MENU_SHOW: &str = "workbench-tray-show";
const MENU_QUIT: &str = "workbench-tray-quit";
/*
 * 明细行的 id 前缀。按「状态项 id + 序号」生成，`on_menu` 按前缀把它们
 * 当成**打开应用**（与「显示主窗口」同一行为）。
 *
 * ⚠️ 明细行**不用禁用态**（`enabled(false)`）。禁用态由 AppKit 用系统
 * `disabledControlTextColor` 绘制，在浅色外观下是很浅的灰（alpha 0.25），看不清
 * （用户已反馈）。启用态的颜色来自 `labelColor`：浅色外观近黑、深色外观是白，
 * 随系统外观自动翻转 —— 所以这里**不能**写死黑色，否则深色外观下会看不见。
 * 也正因为是启用态，它和下面的「显示主窗口 / 退出工作台」同色，
 * 且必须真的能点：点一行余额就回到工作台看详情，符合用户对可点项的预期。
 */
const MENU_DETAIL_PREFIX: &str = "workbench-tray-detail-";

/*
 * 上一轮 `workbench_tray_sync` 建过的平台项 id。
 *
 * 用途只有一个：把**这一轮没再声明**的旧项藏掉。`sync` 的语义是「全量声明」，
 * 调用方（前端）不必自己记「上次发了什么」，也就在前端少一份容易走味的状态。
 * 真实场景是后端下架了某个平台 —— 它的项若留着，菜单栏上会永远挂着一个
 * 不再更新的过期数字。
 *
 * 用 `Vec` 而不是 `HashSet`：平台最多十来个，线性查足够；
 * 而 `Vec::new()` 是 `const fn`，可以直接当 static 初始化（`HashSet::new()` 不是）。
 */
static KNOWN_ITEM_IDS: Mutex<Vec<String>> = Mutex::new(Vec::new());

/*
 * 当前可见的平台项数量（= 菜单栏上挂着几格 agent 额度）。
 *
 * 主项的可见性判据是「在后台 **且** 这个数为 0」（见 `should_show_main_item`）——
 * 只要菜单栏上还有 agent 额度格，主项就不出现：那些格子本身就是入口（左键弹菜单、菜单里有「显示主窗口」），
 * 再挂一格「工作台」就是多余。只有一格 agent 额度都没有时，主项才出来兜底，
 * 保证关窗后永远有能点回来的地方。
 *
 * 存这里是为了让判据保持「唯一真值来源」：`workbench_tray_sync` 是唯一写入方
 * （每轮同步用真实可见数覆盖），`sync_main_item` 只读它。与 `KNOWN_ITEM_IDS` 一样用
 * 基础类型，避免在前端多一份容易走味的状态。
 */
static VISIBLE_PLATFORM_ITEMS: AtomicUsize = AtomicUsize::new(0);

/*
 * 主项（后台入口）该不该出现。**纯函数**，便于单测直接喂四象限断言，不依赖 Tauri 运行时。
 *
 * 判据（2026-09-24 改）：`在后台 且 没有可见的平台项`。
 * 以前只有 `is_in_background()` 一条 —— 那时 menu bar 只要挂了 agent 额度格，
 * 还会额外多出一格「工作台」，用户觉得多余。
 */
pub fn should_show_main_item(in_background: bool, visible_platform_items: usize) -> bool {
    in_background && visible_platform_items == 0
}

/* =============================================
   ====== 图标数据 ======
   ============================================= */

/**
 * 一个图标的原始位图：边长 `size` 的正方形，RGBA 逐像素排列。
 *
 * 为什么传原始像素而不是 PNG：`tauri::image::Image::new_owned` 收的就是 RGBA，
 * 而 `tray_icon::Icon::from_rgba` 直接用它建 NSImage —— 整条路**不需要任何
 * 图像解码能力**（所以 Cargo.toml 不必开 `image-png`）。
 * 反过来，若这里改成收 PNG，就得为了一张 36×36 的小图引入解码器。
 *
 * 由前端用 Canvas 画好后取 `getImageData()` 得到（见 src/features/balances/icons.ts），
 * 这样「图标长什么样」这件事完全在前端，Rust 侧不认识任何平台。
 */
#[derive(serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TrayIconData {
    /** 正方形边长（像素）。36 = macOS 菜单栏 18pt @2x */
    pub size: u32,
    /** RGBA 逐像素，长度必须恰好是 size × size × 4 */
    pub rgba: Vec<u8>,
}

impl TrayIconData {
    /**
     * 转成 tauri 的 `Image`。
     *
     * 这里**主动校验长度**：`Image::new_owned` 是 `const fn`，不做任何检查；
     * 长度不对的话要到 `Icon::from_rgba` 才报错，而那时错误信息是
     * 「ByteCountNotDivisibleBy4 / DimensionsVsPixelCount」这种读不懂的话。
     * 前端传错（比如 canvas 尺寸与声明的 size 不一致）时，这条能直接指出差多少。
     */
    fn to_image(&self) -> Result<Image<'static>, String> {
        if self.size == 0 {
            return Err("图标尺寸不能为 0".into());
        }
        let expect = (self.size as usize)
            .checked_mul(self.size as usize)
            .and_then(|px| px.checked_mul(4))
            .ok_or_else(|| format!("图标尺寸过大：{}", self.size))?;
        if self.rgba.len() != expect {
            return Err(format!(
                "图标数据长度 {} 与尺寸 {}×{} 不符（应为 {}）",
                self.rgba.len(),
                self.size,
                self.size,
                expect
            ));
        }
        Ok(Image::new_owned(self.rgba.clone(), self.size, self.size))
    }
}

/* =============================================
   ====== 平台项：全量声明 ======
   ============================================= */

/**
 * 一个平台项的内容。字段名用 camelCase，与前端一致（前端直接传对象）。
 */
#[derive(serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TrayItemSpec {
    /**
     * 稳定标识 —— 用**后端 provider id**，不要用显示名。
     * 显示名会随界面语言/后端文案变，id 不会；而 id 变了意味着「这是另一个平台」，
     * 藏掉旧项、建个新项正是我们要的行为。
     */
    pub key: String,
    /** 状态项上的文字（平台已由图标区分，所以这里通常只有数值） */
    pub title: String,
    /** 悬停提示，可多行（`\n` 分隔） */
    pub tooltip: Option<String>,
    /** 是否显示。false 时状态项被移除，但**配置留在 attrs 里**，再开就原样恢复 */
    pub visible: bool,
    /** 图标；None = 该项只有文字（用户关掉了图标） */
    pub icon: Option<TrayIconData>,
    /**
     * 右键菜单里这一格下面的明细行（只读）。
     *
     * 目前只有 ChatGPT 这类「一个平台两个额度窗口」的场景会带：标题那一行
     * 空间不够放 5h / 7d 两条明细，所以把可读的长文案挪到菜单里。
     *
     * 空数组 = 菜单保持默认的「显示主窗口 / 退出工作台」，其它平台完全不受影响。
     */
    #[serde(default)]
    pub details: Vec<String>,
    /**
     * 明细的分组标题。
     *
     * 为什么不用子菜单：子菜单要在菜单里再悬停一层才看得见，而需求是
     * 「点开托盘就能读到两行」；分组头 + 明细行都是一级菜单，点开即见，
     * 也避开了 macOS 上子菜单与状态项菜单的兼容面。None 时明细直接顶格列出。
     */
    #[serde(default)]
    pub detail_title: Option<String>,
}

/**
 * 同步菜单栏上的**平台项**。
 *
 * 语义是**全量声明**：`items` 就是「此刻应该存在的全部平台项」。
 *   - 声明里有、之前没建过 → 建
 *   - 声明里有、已经建过 → 更新文字 / 提示 / 图标 / 可见性
 *   - 之前建过、这次没声明 → 藏掉（见 `KNOWN_ITEM_IDS`）
 *
 * ⚠️ **不要让它去动主项**。主项是关窗转后台的兜底入口，可见性由
 * `core::lifecycle` 独占管理；这里一旦也去 `set_visible(false)`，
 * 就又会造出「应用变成孤儿」那个致命故障（本文件顶部第 1 节）。
 *
 * 返回**可见的平台项个数** —— 前端把它写进诊断键，于是不看菜单栏也能确认
 * 「到底推上去了几格」。
 *
 * 单个平台出错**不中断**其余平台：一个图标数据坏了不该让整个菜单栏空掉。
 * 错误累积后一并返回（调用方静默降级 + 记诊断）。
 */
#[command]
pub async fn workbench_tray_sync(
    app: AppHandle,
    items: Vec<TrayItemSpec>,
) -> ApiResponse<usize> {
    let mut live: Vec<String> = Vec::with_capacity(items.len());
    let mut visible = 0usize;
    let mut first_err: Option<String> = None;

    for spec in &items {
        if spec.key.is_empty() {
            first_err.get_or_insert_with(|| "平台项的 key 不能为空".into());
            continue;
        }
        let id = format!("{TRAY_ITEM_PREFIX}{}", spec.key);
        live.push(id.clone());

        match apply_item(&app, &id, spec) {
            Ok(v) => visible += v,
            Err(e) => {
                first_err.get_or_insert(e);
            }
        }
    }

    /*
     * ⭐ 同步主项：可见平台项数归 0 且在后台 → 把【工作台】补出来兜底；
     * 否则藏掉（平台项本身就是入口：左键弹菜单，菜单里有「显示主窗口」）。
     * 放在「应用平台项之后、藏 stale 之前」—— 从 N 个平台项撤到 0 时，
     * 主项先出现、平台项后才被藏，绝不留下「零入口」的瞬间。
     * 只调 `sync_main_item`：主项可见性仍由这一处独占，余额模块不碰它。
     */
    VISIBLE_PLATFORM_ITEMS.store(visible, Ordering::Relaxed);
    if let Err(e) = sync_main_item(&app) {
        first_err.get_or_insert_with(|| format!("同步菜单栏主项失败：{e}"));
    }

    /* 上一轮建过、这一轮没声明的 → 藏掉。见 KNOWN_ITEM_IDS 的说明 */
    let stale = {
        let mut known = KNOWN_ITEM_IDS.lock().unwrap();
        let stale: Vec<String> = known
            .iter()
            .filter(|id| !live.contains(id))
            .cloned()
            .collect();
        *known = live;
        stale
    };
    for id in stale {
        if let Some(tray) = app.tray_by_id(&id) {
            if let Err(e) = tray.set_visible(false) {
                tracing::warn!("[菜单栏] 隐藏已下架平台的状态项失败（{id}）：{e}");
            }
        }
    }

    match first_err {
        Some(e) => ApiResponse::err(e),
        None => ApiResponse::ok(visible),
    }
}

/**
 * 应用单个平台项。返回它是否可见（1 = 可见，0 = 隐藏）。
 *
 * ⚠️ **顺序是这个函数的全部要点**：标题 / 提示 / 图标都必须在
 * `set_visible` **之前**写。理由见文件顶部「一条已经不存在的坑」——
 * `set_visible(true)` 会拿 attrs 重建状态项，attrs 旧了就会复活过期内容。
 */
fn apply_item(app: &AppHandle, id: &str, spec: &TrayItemSpec) -> Result<usize, String> {
    let image = match &spec.icon {
        Some(data) => Some(data.to_image()?),
        None => None,
    };

    let tray = match app.tray_by_id(id) {
        Some(t) => t,
        None => build_item(
            app,
            id,
            &spec.title,
            spec.tooltip.as_deref(),
            image.clone(),
            &spec.details,
            spec.detail_title.as_deref(),
        )?,
    };

    if let Err(e) = tray.set_title(Some(spec.title.as_str())) {
        return Err(format!("设置菜单栏文字失败（{}）：{e}", spec.key));
    }
    if let Err(e) = tray.set_tooltip(spec.tooltip.as_deref()) {
        return Err(format!("设置菜单栏提示失败（{}）：{e}", spec.key));
    }
    /*
     * 用 `set_icon_with_as_template` 而不是「set_icon + set_icon_as_template」：
     * 后者在 macOS 上会让图标渲染两次（可见的闪烁），前者是原子的。
     * `true` = 模板图，由系统按菜单栏前景色着色 —— 深色/浅色外观自动适配，
     * 我们只需要在 alpha 通道上画出形状（RGB 会被忽略）。
     */
    if let Err(e) = tray.set_icon_with_as_template(image, true) {
        return Err(format!("设置菜单栏图标失败（{}）：{e}", spec.key));
    }
    /*
     * 菜单是**每次同步都重建**的：明细文案随余额变化，只在建项时设一次会永远停在
     * 第一次的值。菜单项只有个位数，重建成本可以忽略；而且平台项的菜单与主项
     * 是各自独立的对象（`set_menu` 不会影响别的状态项），所以其它平台照旧。
     *
     * ⚠️ 必须放在 `set_visible` 之前：`set_visible(true)` 在状态项不存在时会拿
     * attrs 重建，attrs 里的菜单得已是最新的（见文件顶部「一条已经不存在的坑」）。
     */
    let menu = build_menu(app, id, &spec.details, spec.detail_title.as_deref())?;
    if let Err(e) = tray.set_menu(Some(menu)) {
        return Err(format!("设置菜单栏菜单失败（{}）：{e}", spec.key));
    }
    if let Err(e) = tray.set_visible(spec.visible) {
        return Err(format!("显示/隐藏菜单栏项失败（{}）：{e}", spec.key));
    }
    Ok(usize::from(spec.visible))
}

/* =============================================
   ====== 主项（后台入口） ======
   ============================================= */

/**
 * 让**主项**（关窗转后台的兜底入口）的存在性与可见性跟上「当前状态」。
 *
 *   - 在后台 **且** 没有可见的平台项：没有就建一个，有就显示出来
 *   - 否则（前台，或后台但还有 agent 额度格）：有就藏起来
 *     （**没有就什么都不做** —— 不建一个立刻就藏的项）
 *
 * 关窗转入后台时由 `core::lifecycle::hide_to_background` 调用；唤回窗口时由
 * `end_background` 调用；**每轮 `workbench_tray_sync` 也会调它一次**
 * （平台项数量变了，主项该藏还是该补要重新判）。
 *
 * **这个函数是唯一读写「主项可见性」的地方** —— 判据全部来自 `should_show_main_item`
 * （读 `is_in_background()` + `VISIBLE_PLATFORM_ITEMS`），不靠调用方记得先置位/后清位。
 *
 * 返回 Err 只可能发生在「该显示但建不出来」时 —— 那时调用方必须**放弃拦下关闭**：
 * 一个既没有 Dock 图标、也没有菜单栏入口的后台进程，用户只能去活动监视器杀它。
 */
pub fn sync_main_item(app: &AppHandle) -> Result<(), String> {
    /*
     * 不该出现（前台，或后台但还有 agent 额度格）的分支**不建项**：
     * 调这个函数的时机之一是「唤回窗口」，那一刻若还没建过主项，建出来又立刻藏掉纯属浪费，
     * 而且会让「主项存在 ⟺ 曾经进过后台」这个更简单的事实变得不成立。
     */
    if !should_show_main_item(
        crate::core::lifecycle::is_in_background(),
        VISIBLE_PLATFORM_ITEMS.load(Ordering::Relaxed),
    ) {
        set_main_visible(app, false);
        return Ok(());
    }

    let tray = match app.tray_by_id(TRAY_ID) {
        Some(t) => t,
        None => build_item(
            app,
            TRAY_ID,
            DEFAULT_TITLE,
            Some(DEFAULT_TOOLTIP),
            None,
            &[],
            None,
        )?,
    };
    tray.set_visible(true)
        .map_err(|e| format!("显示菜单栏项失败：{e}"))?;
    Ok(())
}

/*
 * 真正把主项显示/藏起来。**私有** —— 外部一律走 `sync_main_item`，
 * 免得「谁该负责藏主项」这件事散落到多个调用点（漏一处就是前台多挂一格）。
 *
 * 失败只记日志：藏不掉一个多余的入口，比「为了藏它而把应用搞坏」轻得多。
 */
fn set_main_visible(app: &AppHandle, visible: bool) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    if let Err(e) = tray.set_visible(visible) {
        tracing::warn!("[菜单栏] 切换主项可见性失败（{visible}）：{e}");
    }
}

/* =============================================
   ====== 构建与事件 ======
   ============================================= */

/**
 * 建右键菜单：可选的只读明细（分组头 + 若干行）在前，固定的
 * 「显示主窗口 / 退出工作台」在后。
 *
 * 明细**放在一级菜单**而不是子菜单：点开即见，不需要再悬停一层。
 *
 * 明细行用启用态而非禁用态 —— 见 `MENU_DETAIL_PREFIX` 上的说明：禁用态是浅灰，
 * 浅色外观下看不清；启用态取系统 `labelColor`，深浅外观都清楚。
 * 代价是这几行会随鼠标高亮、点击会关掉菜单，但 `on_menu` 对它们不做任何事，
 * 仍等于「只读展示」。
 */
fn build_menu(
    app: &AppHandle,
    id: &str,
    details: &[String],
    detail_title: Option<&str>,
) -> Result<Menu<Wry>, String> {
    let mut builder = MenuBuilder::new(app);

    if !details.is_empty() {
        if let Some(title) = detail_title.filter(|t| !t.is_empty()) {
            /* 分组头也用明细前缀：它同样是启用态的可点项，点了也该回工作台，
             * 否则「点了没反应」比「禁用态看不清」更让人困惑。 */
            let header = MenuItemBuilder::with_id(format!("{MENU_DETAIL_PREFIX}{id}-head"), title)
                .build(app)
                .map_err(|e| format!("创建菜单栏明细标题失败：{e}"))?;
            builder = builder.item(&header);
        }
        let mut rows = Vec::with_capacity(details.len());
        for (idx, line) in details.iter().enumerate() {
            let item = MenuItemBuilder::with_id(format!("{MENU_DETAIL_PREFIX}{id}-{idx}"), line)
                .build(app)
                .map_err(|e| format!("创建菜单栏明细项失败：{e}"))?;
            rows.push(item);
        }
        for row in &rows {
            builder = builder.item(row);
        }
        builder = builder.separator();
    }

    builder
        .text(MENU_SHOW, "显示主窗口")
        .separator()
        .text(MENU_QUIT, "退出工作台")
        .build()
        .map_err(|e| format!("创建菜单栏菜单失败：{e}"))
}

/* 建一个状态项。主项与平台项都走这里，差别只在有没有图标与明细。 */
fn build_item(
    app: &AppHandle,
    id: &str,
    title: &str,
    tooltip: Option<&str>,
    icon: Option<Image<'static>>,
    details: &[String],
    detail_title: Option<&str>,
) -> Result<TrayIcon<Wry>, String> {
    let menu = build_menu(app, id, details, detail_title)?;

    let mut builder = TrayIconBuilder::with_id(id)
        .title(title)
        .menu(&menu)
        /* 左键与右键都弹同一份菜单 —— 见本文件顶部第 9 条。左键不再唤回窗口，
         * 窗口从菜单的「显示主窗口」进。 */
        .show_menu_on_left_click(true)
        .on_menu_event(on_menu);
    if let Some(t) = tooltip {
        builder = builder.tooltip(t);
    }
    if let Some(i) = icon {
        /* 模板图：跟随菜单栏前景色，深浅色外观自动适配（见 apply_item 的说明） */
        builder = builder.icon(i).icon_as_template(true);
    }
    builder
        .build(app)
        .map_err(|e| format!("创建菜单栏项失败（{id}）：{e}"))
}

/*
 * 右键/左键菜单。
 *
 * ⚠️ `TrayIcon::on_menu_event` 挂的是**全局**监听器（tauri 把它 push 进
 * `menu.global_event_listeners`，见 tray/mod.rs 的 `register`），
 * 所以每个状态项的菜单事件都会跑到这里来。这是对的 —— 菜单项 id 是共享的，
 * 行为也该一样（不管从哪一格右键，都该能显示窗口 / 退出）。
 */
fn on_menu(app: &AppHandle, event: MenuEvent) {
    let id: &str = event.id().as_ref();
    /* 明细行（含分组头）点了就回工作台 —— 与「显示主窗口」同一行为，
     * 见 MENU_DETAIL_PREFIX 上的说明（它们是启用态，必须真的能点）。 */
    if id == MENU_SHOW || id.starts_with(MENU_DETAIL_PREFIX) {
        crate::core::lifecycle::restore_window(app);
    } else if id == MENU_QUIT {
        crate::core::lifecycle::quit(app);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /**
     * 图标长度校验。
     *
     * 这条守的是一个**只会静默降级**的失败：前端 canvas 尺寸与声明的 size
     * 对不上时，若不做校验就会一路走到 `Icon::from_rgba` 才报错，
     * 而那时错误信息是读不懂的英文枚举名 —— 现象是「图标不出来，也不知道为什么」。
     */
    #[test]
    fn 图标数据长度与尺寸不符时必须报错而不是硬塞() {
        let ok = TrayIconData {
            size: 2,
            rgba: vec![0u8; 2 * 2 * 4],
        };
        assert!(ok.to_image().is_ok(), "长度正确时必须能转成 Image");

        let short = TrayIconData {
            size: 2,
            rgba: vec![0u8; 2 * 2 * 4 - 1],
        };
        let err = short.to_image().unwrap_err();
        assert!(
            err.contains("不符"),
            "错误信息要指出是长度问题，实际是：{err}"
        );

        let zero = TrayIconData {
            size: 0,
            rgba: Vec::new(),
        };
        assert!(zero.to_image().is_err(), "尺寸为 0 必须挡住");
    }

    /**
     * 主项 id 不能等于任何平台项 id。
     *
     * `tray_by_id` 是**精确匹配**（manager/tray.rs 里 `tray_icon_id == &id`），
     * 所以主项 id 是平台项 id 的前缀本身没问题 —— 但**相等**就会让两者互相顶掉：
     * 余额模块 sync 时会把后台入口那一格当成平台项改掉，
     * 而用户关窗后就再也叫不回窗口了。
     */
    #[test]
    fn 主项_id_不会与平台项_id_相撞() {
        assert_ne!(TRAY_ID, TRAY_ITEM_PREFIX, "前缀本身不能就是主项 id");
        for key in ["qoder", "chatgpt", "openai", "claude", "gemini", "trae", "workbuddy"] {
            let id = format!("{TRAY_ITEM_PREFIX}{key}");
            assert_ne!(id, TRAY_ID, "平台项 {id} 撞上了主项 id");
            assert!(id.starts_with(TRAY_ITEM_PREFIX));
        }
    }

    /**
     * 主项可见性的四象限 —— 全部行为，抽成纯函数就是为了不依赖 Tauri 运行时直接断言
     * （这一层集成测/手工测不到）。
     */
    #[test]
    fn 主项只在后台且没额度格时才出现() {
        assert!(!should_show_main_item(false, 0), "前台永远不显主项");
        assert!(!should_show_main_item(false, 2), "前台有额度格也不显");
        assert!(
            should_show_main_item(true, 0),
            "后台且无额度格 → 主项兜底出现"
        );
        assert!(
            !should_show_main_item(true, 1),
            "后台但还有额度格 → 不显（格子本身就是入口）"
        );
        assert!(!should_show_main_item(true, 3), "后台且多个额度格 → 不显");
    }
}
