/*
 * 窗口生命周期：关闭窗口后转入后台运行（菜单栏常驻）
 * ------------------------------------------------------------------
 * 需求：点窗口的 × 之后**不退出应用** —— 程序坞图标消失，只在系统菜单栏留一个入口，
 * 后台任务（日志流、余额定时刷新）继续跑。
 *
 * 三件事必须一起做，少一件都会让应用变成「叫不回来」的孤儿：
 *   1. 拦下 `CloseRequested`（`api.prevent_close()`），只 `hide()` 窗口
 *   2. `set_dock_visibility(false)` —— 藏掉程序坞图标
 *   3. 保证菜单栏项**存在且可见** —— 它是关窗后唯一能回来的入口
 *
 * ⚠️ 失败处置：**先确保菜单栏项建出来，再拦关闭**。
 * 菜单栏建不出来（系统拒绝等）时返回 Err，由调用方放行关闭、应用正常退出 ——
 * 一个既没有 Dock 图标、也没有菜单栏入口的后台进程，用户只能去活动监视器杀它。
 *
 * ⚠️ 与「关窗即退出」的关系：本机制**只作用于窗口关闭**。
 * Cmd+Q、以及菜单栏右键里的「退出工作台」仍会真正退出（见 `quit`）。
 *
 * 设置项落在 sled 的 workbench 命名空间，但**运行期只读内存里的原子量** ——
 * 关窗回调跑在主线程上，不能在那里做文件 I/O。
 * @Author: fu
 */
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{command, AppHandle, Emitter, Manager};

use crate::core::api::ApiResponse;
use crate::core::storage::{app_data_dir, StorageService};

/* 设置键：关窗后是否转入后台 */
const SETTING_BACKGROUND_ON_CLOSE: &str = "background_on_close";

/*
 * 主窗口 label。
 *
 * ⚠️ 这是**唯一**的真值来源 —— `main.rs` 的关窗回调也用它来判断「这次关闭的是不是主窗口」。
 * 依据：`tauri.conf.json` 的 `app.windows[0]` **没有写 label**，而 tauri 的
 * `default_window_label()` 返回 `"main"`（读 tauri-utils-2.9.3/src/config.rs 确认）。
 *
 * 谁改了配置里的 label 就必须同步改这里 —— 否则 `get_webview_window` 会**静默**返回 None，
 * 表现为「点菜单栏唤不回窗口」，而不会报任何错。
 */
pub const MAIN_WINDOW: &str = "main";

/* 窗口即将关闭时广播的事件名，前端模块可监听做收尾 */
pub const EVENT_APP_CLOSING: &str = "workbench:app-closing";

/*
 * 「转入后台 / 回到前台」的广播事件名，payload 是 bool（true = 已转入后台）。
 *
 * ⚠️ 与 `EVENT_APP_CLOSING` 是两件事：转后台时**刻意不发**那个（服务要继续跑），
 * 所以前端不能靠它判断「窗口还在不在」。
 *
 * 给谁用：只在窗口可见时才有意义的定时任务（当前是 jvm 的自动扫描）。
 * 隐藏窗口后系统会对 webview 的定时器做节流，但那是**尽力而为** ——
 * 而且节流期间倒计时会停在过期值上，所以显式停 / 恢复比依赖节流可预测。
 */
pub const EVENT_BACKGROUND_CHANGED: &str = "workbench:background-changed";

/*
 * 默认值：开启。
 * 提这个需求时用户要的就是「点 × 不退出」，所以新装默认就按他要的来；
 * 想改回「× 就是退出」的用户可以在 设置 → 窗口与后台 里关掉。
 */
const DEFAULT_BACKGROUND_ON_CLOSE: bool = true;

/* 运行期值。关窗回调只读它，零 I/O */
static BACKGROUND_ON_CLOSE: AtomicBool = AtomicBool::new(DEFAULT_BACKGROUND_ON_CLOSE);

/*
 * 「用户本次会话里显式改过」标记。
 * 启动时那次异步读盘不能覆盖用户刚在设置页做的选择（两者可能交错）。
 */
static TOUCHED_BY_USER: AtomicBool = AtomicBool::new(false);

/*
 * 是否由**我们主动**把窗口藏起来了（= 正处于后台运行状态）。
 *
 * 为什么不直接看「窗口可不可见」：窗口被**最小化**时 `is_visible()` 同样是 false，
 * 而最小化状态下应用还在 Dock 里、随时能点回来，不该按「后台」对待。
 */
static IN_BACKGROUND: AtomicBool = AtomicBool::new(false);

/** 当前是否「关窗后转入后台」 */
pub fn background_on_close() -> bool {
    BACKGROUND_ON_CLOSE.load(Ordering::Relaxed)
}

/*
 * 启动时读一次设置。
 *
 * **丢到后台线程**：sled 首次打开要建目录、失败还带 sleep 重试（最长几百毫秒），
 * 放在 setup 里会直接拖慢启动。读不到就沿用默认值 —— 它与用户预期一致。
 */
pub fn load_setting_in_background(app: AppHandle) {
    std::thread::spawn(move || {
        let Some(v) = read_setting(&app) else {
            return;
        };
        if TOUCHED_BY_USER.load(Ordering::Relaxed) {
            /* 用户已经改过 → 以用户为准，不覆盖 */
            return;
        }
        BACKGROUND_ON_CLOSE.store(v, Ordering::Relaxed);
        tracing::info!("[后台运行] 关窗后{}退出", if v { "不" } else { "" });
    });
}

/*
 * 解析存下来的设置值。**纯函数**，好让「认不出的值怎么办」这类边界能直接断言。
 *
 * 返回 None = 「没有可用的值」→ 调用方沿用默认值。
 * 认不出的字符串**不猜**（比如把非空字符串当 true）—— 猜错会让用户
 * 在一个他从未设过的行为下运行，而默认值至少是他能预期的那个。
 */
fn parse_setting(raw: &str) -> Option<bool> {
    match raw.trim() {
        "1" | "true" => Some(true),
        "0" | "false" => Some(false),
        _ => None,
    }
}

/* 读盘。任何一步失败都返回 None（沿用默认值），不打扰启动流程 */
fn read_setting(app: &AppHandle) -> Option<bool> {
    let storage = StorageService::init(app_data_dir(app)).ok()?;
    let raw = storage.get_setting(SETTING_BACKGROUND_ON_CLOSE).ok()??;
    parse_setting(&raw)
}

/*
 * 序列化设置值。**与 `parse_setting` 是一对**。
 *
 * 抽出来只为了能在单测里断言「写出去的**一定**读得回来」（见文件末尾的测试）：
 * 两侧是两处独立代码，各改各的（比如写入侧改成 `"yes"`、解析侧仍认 `"1"`）时
 * 现象是「用户改了开关 → 重启 → 又回到默认值」，而两侧各自的单测**都是绿的**。
 */
fn encode_setting(enabled: bool) -> &'static str {
    if enabled {
        "1"
    } else {
        "0"
    }
}

/* 写盘 + 更新运行期值。写盘失败要让调用方知道（否则用户以为设置生效了） */
fn store_setting(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let storage = StorageService::init(app_data_dir(app))
        .map_err(|e| format!("打开本地存储失败：{e}"))?;
    storage
        .set_setting(SETTING_BACKGROUND_ON_CLOSE, encode_setting(enabled))
        .map_err(|e| format!("保存设置失败：{e}"))?;
    TOUCHED_BY_USER.store(true, Ordering::Relaxed);
    BACKGROUND_ON_CLOSE.store(enabled, Ordering::Relaxed);
    Ok(())
}

/* ============================ 转入后台 / 唤回 ============================ */

/*
 * 立起「在后台」意图位。
 *
 * 抽成函数只为一件事：**让置位 / 回滚这一对能在单测里真的跑一遍**
 * （见文件末尾的测试）。写成裸 `store` 的话，那条最容易写错、代价又最大的
 * 规则就只剩注释在守着了。
 */
fn mark_background() {
    IN_BACKGROUND.store(true, Ordering::Relaxed);
}

/*
 * 撤销意图位。两个调用点，含义是同一个「现在不在后台了」：
 *   1. 转入后台**中途失败** → 回滚，不能留下假的「在后台」状态。
 *   2. `restore_window` 唤回窗口后 → 后台状态结束。
 *
 * ⚠️ 回滚**不止是清一个原子量**：主项的可见性不变量是
 * 「可见 ⟺ 在后台 **且** 没有可见平台项」，所以清位之后必须把主项也藏回去，
 * 否则前台菜单栏上会平白多出一格「工作台」。
 * 这条配对写在 `end_background()` 里，别只调 `rollback_background()`。
 */
fn rollback_background() {
    IN_BACKGROUND.store(false, Ordering::Relaxed);
}

/*
 * 结束后台状态：清意图位 + 让主项跟上（= 藏掉）。
 *
 * **两个动作必须一起做**（不变量见 `core::tray::sync_main_item`）。
 * 抽成函数是为了让「忘了藏主项」这种漏做无法只改一半 ——
 * 它不会报错，只会在前台菜单栏上多留一格，很难被联想到是这个原因。
 */
fn end_background(app: &AppHandle) {
    rollback_background();
    if let Err(e) = crate::core::tray::sync_main_item(app) {
        /* 这个分支只可能发生在「该显示但建不出来」时，那时状态位是 true；
           正常唤回路径（已清位）走的是「藏起来」分支，不会失败 */
        tracing::warn!("[后台运行] 同步菜单栏主项失败：{e}");
    }
}

/*
 * 转入后台：藏窗口 + 藏程序坞图标。
 *
 * **先建菜单栏项再拦关闭** —— 建不出来就返回 Err，由调用方放行关闭（应用退出），
 * 免得留下一个既没 Dock 图标、又没菜单栏入口的后台进程。
 */
pub fn hide_to_background(app: &AppHandle) -> Result<(), String> {
    /*
     * ⚠️ 顺序：**先把「我要进后台」这个意图立起来，再动菜单栏和窗口**。
     *
     * 意图位 + 可见平台项数 是**主项可见性的唯一判据**（见 `core::tray::should_show_main_item`）：
     * 在后台且平台项归零时才显主项，平时入口交给那些格子。所以它必须早于任何可能
     * 让入口消失的动作。反过来，中途失败要**连同主项一起**
     * 收回去（`end_background`）—— 只清原子量的话，前台菜单栏上会多留一格
     * 「工作台」，而用户完全看不出它是哪来的。
     */
    mark_background();

    /* 1. 入口优先：主项必须存在**且可见**（没有 agent 额度格时它才是唯一入口；
       有额度格时这笔调用会判定「不显示」，把入口交给那些格子） */
    if let Err(e) = crate::core::tray::sync_main_item(app) {
        end_background(app);
        return Err(e);
    }
    /* 2. 藏窗口（不是关，webview 与其中的定时器都活着） */
    if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
        if let Err(e) = w.hide() {
            end_background(app);
            return Err(format!("隐藏窗口失败：{e}"));
        }
    }
    /*
     * 3. 藏程序坞图标。**放最后** —— 它和菜单栏项一起构成「回到窗口」的两条路，
     *    前两步失败时不该已经把其中一条断掉。
     */
    set_dock_visible(app, false);
    tracing::info!("[后台运行] 已转入后台，入口在系统菜单栏");
    /*
     * 4. 通知前端「窗口已不可见」。放在**最后**：前面任何一步失败都走
     *    `end_background` 提前返回了，前端不该收到一条「进后台了」而实际还在前台。
     */
    app.emit(EVENT_BACKGROUND_CHANGED, true).ok();
    Ok(())
}

/**
 * 当前是否正处于「关窗转后台」状态 —— 也就是**菜单栏上的主项是唯一入口**的时候。
 *
 * ⚠️ 判据是**意图位单独**，**不要**再与「窗口是否可见」取合取。
 * 取合取看似更稳（能挡住「窗口被别的路径弄回来后状态位还没清」），
 * 但它会开出一个致命的窗口期：转入后台的过程中「意图已置、窗口还没藏完」，
 * 合取为假 → 并发的隐藏请求被放行 → 唯一入口消失，应用变成孤儿。
 *
 * 「窗口回来了」这件事已经由 `restore_window` 清意图位来表达，
 * 而所有能让窗口重新出现的路径（菜单栏左键/右键菜单的「显示主窗口」、macOS 的 `Reopen`）
 * 都走它，所以不需要再靠窗口可见性兜底。
 *
 * ⚠️ 这个判据现在**只被主项的可见性使用**（`core::tray`）。余额模块的平台项
 * 与它无关 —— 那些项藏掉不影响入口，因为主项是独立的一格。这正是把入口与
 * 业务内容拆成两类状态项换来的：以前余额模块一关显示就会把唯一入口一起藏掉，
 * 才不得不写一套「后台期间推迟隐藏 + 唤回后补做」的机制去兜。
 */
pub fn is_in_background() -> bool {
    IN_BACKGROUND.load(Ordering::Relaxed)
}

/*
 * 唤回窗口：先恢复程序坞图标，再显示并聚焦。
 *
 * 顺序不能反 —— tao 的 `set_focus` 对「不可见 / 已最小化」的窗口直接返回，
 * 所以必须 show → unminimize → set_focus。
 */
pub fn restore_window(app: &AppHandle) {
    /* 先记下「本来在不在后台」：`end_background` 会把意图位清掉，之后就问不出来了 */
    let was_background = is_in_background();
    set_dock_visible(app, true);
    if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
    /*
     * 结束后台状态：清意图位 + 藏掉主项。
     * 主项必须在这里藏掉 —— 它的可见性不变量是「可见 ⟺ 在后台 且 没有可见平台项」，
     * 留着的话前台菜单栏上会一直挂着一格「工作台」。（后台且还有 agent 额度格时，
     * 那些格子本身就是入口，主项本就不出现。）
     */
    end_background(app);
    /*
     * 只有**真的**从后台回来才广播。
     * 点菜单栏上的余额格也会走到这里（它本身就能唤回窗口），那时应用根本没进过后台，
     * 每次都发一条「回前台了」只会让订阅方做一次无意义的重新排期。
     */
    if was_background {
        app.emit(EVENT_BACKGROUND_CHANGED, false).ok();
    }
}

/** 广播「应用即将关闭」，供前端模块收尾 */
pub fn broadcast_closing(app: &AppHandle) {
    app.emit(EVENT_APP_CLOSING, ()).ok();
}

/*
 * 真正退出应用。
 *
 * 后台任务的收尾**不在这里做** —— core 不该反向依赖 modules。
 * `main.rs` 在 `RunEvent::Exit` 里统一收尾，无论从哪条路径退出都会走到。
 */
pub fn quit(app: &AppHandle) {
    broadcast_closing(app);
    app.exit(0);
}

/*
 * 藏 / 显示程序坞图标（macOS）。
 *
 * 用 Tauri 自己的 `set_dock_visibility`，它底层是 tao 的
 * `TransformProcessType(kProcessTransformToUIElementApplication / Foreground)`。
 *
 * ⚠️ 已知限制（读 tao 0.35.3 的 `platform_impl/macos/dock.rs` 确认，不是猜的）：
 *   1. 转回 Foreground 是**异步**的，系统不通知完成，所以 tao 对
 *      「1 秒内紧跟着 show 的 hide」会**跳过那次 hide**（防 macOS 残留多个 Dock 图标）。
 *      表现是极短时间内反复关窗 / 唤回时，Dock 图标可能多留一会儿。属观感问题，不修。
 *   2. 转成 UIElement 后应用**没有自己的菜单栏**（macOS 的既定行为），
 *      所以关窗状态下 Cmd+Q 不可用 —— 这正是菜单栏右键必须提供「退出」的原因。
 */
fn set_dock_visible(app: &AppHandle, visible: bool) {
    #[cfg(target_os = "macos")]
    if let Err(e) = app.set_dock_visibility(visible) {
        tracing::warn!("[后台运行] 切换程序坞图标可见性失败：{e}");
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, visible);
    }
}

/* ============================ 命令 ============================ */

/** 读取「关窗后转入后台」设置。只读内存，无 I/O */
#[command]
pub async fn workbench_get_background_on_close() -> ApiResponse<bool> {
    ApiResponse::ok(background_on_close())
}

/* 修改「关窗后转入后台」设置。sled 是同步 I/O，按模块约定丢阻塞线程池 */
#[command]
pub async fn workbench_set_background_on_close(
    app: AppHandle,
    enabled: bool,
) -> ApiResponse<bool> {
    let handle = app.clone();
    match tokio::task::spawn_blocking(move || store_setting(&handle, enabled)).await {
        Ok(Ok(())) => {
            /*
             * 关掉这个开关时顺手把程序坞图标恢复出来。
             * 正常路径下它本来就是显示的（能点设置页就说明窗口开着），
             * 这里是**自愈**：万一之前某次 hide 因为 tao 的 1 秒节流漏掉了对应的 show，
             * 用户一关掉开关就能立刻恢复正常，不必重启应用。
             */
            if !enabled {
                set_dock_visible(&app, true);
            }
            ApiResponse::ok(enabled)
        }
        Ok(Err(e)) => ApiResponse::err(e),
        Err(e) => ApiResponse::err(format!("保存设置的任务异常：{e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 设置值认得出两种写法() {
        assert_eq!(parse_setting("1"), Some(true));
        assert_eq!(parse_setting("true"), Some(true));
        assert_eq!(parse_setting("0"), Some(false));
        assert_eq!(parse_setting("false"), Some(false));
    }

    #[test]
    fn 设置值忽略首尾空白() {
        /* 落盘时不会带空白，但用户手工改过 sled / 或将来换了写入格式都可能带上 */
        assert_eq!(parse_setting(" 1 "), Some(true));
        assert_eq!(parse_setting("\tfalse\n"), Some(false));
    }

    #[test]
    fn 写出去的设置值一定读得回来() {
        /*
         * 写入侧（`encode_setting`）与解析侧（`parse_setting`）是**两处独立代码**。
         * 只测一侧等于没测：写入改成 `"yes"`、解析仍认 `"1"` 时，现象是
         * 「用户改了开关 → 重启 → 又回到默认值」，而两侧各自的单测**都是绿的**。
         */
        for v in [true, false] {
            assert_eq!(
                parse_setting(encode_setting(v)),
                Some(v),
                "encode / parse 必须成对，改任意一侧都要同时改另一侧"
            );
        }
    }

    #[test]
    fn 主窗口_label_必须与配置对得上() {
        /*
         * 这条守的是一个**静默**的失败：`get_webview_window("main")` 取不到窗口时
         * 不报任何错，只是「点菜单栏唤不回窗口」。而在配置里换 label 是件很容易
         * 顺手做的事 —— 所以让配置与常量在这里对质一次。
         *
         * 配置里**没写** label 时，tauri 用 `default_window_label()`，它返回 "main"。
         */
        let cfg: serde_json::Value =
            serde_json::from_str(include_str!("../../tauri.conf.json"))
                .expect("tauri.conf.json 必须是合法 JSON");
        let windows = cfg["app"]["windows"]
            .as_array()
            .expect("app.windows 必须是数组");
        let first = windows.first().expect("至少要有一个窗口");
        let label = first
            .get("label")
            .and_then(|v| v.as_str())
            .unwrap_or("main");
        assert_eq!(
            label, MAIN_WINDOW,
            "配置里的窗口 label 与 lifecycle::MAIN_WINDOW 不一致 —— \
             同步改它，否则「唤回窗口」会静默失效"
        );
    }

    #[test]
    fn 认不出的设置值一律回默认而不是猜() {
        /*
         * 这几条是**有意**返回 None 的：宁可用默认值，也不要让用户
         * 在一个他从未设过的行为下运行（例如把 "yes" 猜成 true）。
         */
        assert_eq!(parse_setting(""), None);
        assert_eq!(parse_setting("   "), None);
        assert_eq!(parse_setting("yes"), None);
        assert_eq!(parse_setting("TRUE"), None);
        assert_eq!(parse_setting("2"), None);
    }

    #[test]
    fn 默认值是开启后台运行() {
        /* 用户提这个需求时要的就是「点 × 不退出」，默认必须是他要的那个 */
        assert!(DEFAULT_BACKGROUND_ON_CLOSE);
    }

    #[test]
    fn 后台意图位单独决定主项是否可见_不与窗口可见性取合取() {
        /*
         * 判据是**意图位单独**，不与窗口可见性取合取。
         * 取合取会开出一个致命窗口期：转入后台的过程中「意图已置、窗口还没藏完」，
         * 合取为假 → 那一刻主项会被判成「不该显示」→ 唯一入口消失，应用成孤儿。
         *
         * ⚠️ 本测试独占 `IN_BACKGROUND` 这个全局量，别再加第二个测试碰它 ——
         *    测试是并行跑的，两个测试读写同一个原子量会互相干扰。
         */
        rollback_background();
        assert!(!is_in_background(), "初始不该处于后台");

        mark_background();
        assert!(is_in_background(), "转入后台期间主项必须被判为可见");

        rollback_background();
        assert!(!is_in_background(), "回滚后主项必须被判为不可见");
    }
}
