/*
 * 个人工作台 · Tauri 主入口
 * ------------------------------------------------------------------
 * 职责边界（本文件是**组合根**：把 core 与各模块拼起来，逻辑都下沉到它们内部）：
 *   1. 初始化 tracing 日志
 *   2. 注册插件
 *   3. 注册「工作台级命令」+ 各「模块命令」
 *   4. 窗口生命周期处理（关窗转后台 / 关闭前停止模块后台任务）
 *
 * 新增模块时，只需在下方 generate_handler! 里补上该模块的命令，
 * 不需要改动其它任何逻辑。
 * @Author: fu
 */
#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]
/*
 * 单测函数名刻意用中文 + ASCII 混写（如 `fn 空列表返回_None()`）—— 中文比英文更能
 * 说清「这个断言在钉什么」，而 rustc 的 non_snake_case 只认 ASCII 部分，会误报一片。
 * 这里**只在测试构建**里关掉它：`cfg_attr(test, …)` 让生产代码的命名规范照旧生效，
 * 不必去改 20 个 `mod tests`。
 */
#![cfg_attr(test, allow(non_snake_case))]

mod core;
mod modules;

use core::lifecycle;
use modules::logsight::services::LogStreamService;
use tauri::{Manager, RunEvent, WindowEvent};
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

/*
 * Tauri 主函数
 * 构建应用：初始化日志 -> 注册命令 -> 插件 -> setup 钩子 -> 运行
 */
fn main() {
    /*
     * 1. 初始化 tracing 日志系统（开发环境打印到终端，生产环境可配置文件）。
     * 注意：默认过滤器不能写成 "info,warn,error" 这种多个全局指令，
     * EnvFilter 会按最后一条生效，结果只剩 error，本应用自己的 info 日志全被吞掉。
     * 这里用「指定 target + 全局兜底」的写法：本应用 debug，依赖只留 warn。
     */
    let filter = match std::env::var("RUST_LOG") {
        Ok(v) if !v.trim().is_empty() => EnvFilter::new(v),
        _ => EnvFilter::new("workbench=debug,warn"),
    };
    tracing_subscriber::registry().with(filter).with(fmt::layer()).init();

    // 2. 构建并运行 Tauri 应用
    tauri::Builder::default()
        /*
         * ⚠️ 单实例守卫**必须第一个注册** —— 插件按注册顺序执行 setup，
         * 而它的 setup 干的正是「连得上自己那个 unix socket 就说明已经有实例在跑」，
         * 排在后面注册的话，别的插件的 setup 已经先白跑一遍了。
         *
         * 为什么非有不可：sled 数据库是**独占**打开的（core/storage.rs 里那段重试
         * 只能扛住「上一个进程刚退、文件系统还在收尾」的瞬时竞争，扛不住常驻的第二份进程）。
         * 同一个 bundle id 起了两份 —— 最常见的就是 /Applications 里那份还在跑，
         * 又去双击 src-tauri/target/debug/bundle 里的调试包 —— 后起的那份抢锁失败，
         * 表现是「打开本地存储失败：… could not acquire lock …」，
         * 而且**主密钥和所有设置都读不到**，界面上看起来像「数据全丢了」。
         *
         * 有了守卫，第二份进程根本走不到开库那一步：
         * 它把命令行参数交给第一份后自己 exit(0)。回调里做的就是
         * 「把已经跑着的那份唤到前台」—— 窗口已经关进后台（Dock 图标都藏了）也能靠它回来，
         * 与 RunEvent::Reopen 走的是同一条恢复路径。
         */
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            lifecycle::restore_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            /* ===== 工作台级命令（core/master.rs） =====
             * 主密钥与通用加解密，所有模块共用 */
            core::master::workbench_get_or_create_master_password,
            core::master::workbench_reset_master_password,
            core::master::workbench_decrypt_secret,
            /* 程序坞图标切换（macOS 专用） */
            core::dock::workbench_list_dock_icons,
            core::dock::workbench_set_dock_icon,
            core::directories::workbench_open_directory,
            core::directories::workbench_open_url,
            core::config_backup::workbench_read_text_file,
            core::config_backup::workbench_check_config_paths,
            core::config_backup::workbench_apply_config_backup,
            core::config_backup::workbench_validate_config_backup,
            /* 导出文本文件：系统保存对话框选好路径后由它写盘。
             * ⚠️ 前端不要自己用 Blob + a[download] —— 在本应用的 WKWebView 里
             * 那条路会被静默取消（点了什么都不发生），原因见 core/export.rs 文件头 */
            core::export::workbench_write_text_file,
            /* 系统菜单栏：每个智能体一格（macOS 顶部状态栏 / 托盘）。
             * 主项（关窗转后台的兜底入口）不在这里 —— 它只由 core::lifecycle 管。 */
            core::tray::workbench_tray_sync,
            /* 窗口生命周期：关窗后转入后台（读 / 写该偏好） */
            core::lifecycle::workbench_get_background_on_close,
            core::lifecycle::workbench_set_background_on_close,
            /* ===== LogSight 模块命令（modules/logsight/commands.rs） =====
             * 服务器配置 CRUD */
            modules::logsight::commands::logsight_save_server,
            modules::logsight::commands::logsight_list_servers,
            modules::logsight::commands::logsight_delete_server,
            /* SSH 连接 */
            modules::logsight::commands::logsight_test_connection,
            modules::logsight::commands::logsight_inspect_host_key,
            modules::logsight::commands::logsight_trust_host_key,
            /* 日志流 */
            modules::logsight::commands::logsight_start_tail,
            modules::logsight::commands::logsight_stop_tail,
            modules::logsight::commands::logsight_fetch_history,
            modules::logsight::commands::logsight_fetch_history_by_time,
            modules::logsight::commands::logsight_search_logs,
            /* 结构化日志能力：traceId 链路追踪 + 日志源预设探测 */
            modules::logsight::commands::logsight_search_by_trace_id,
            modules::logsight::commands::logsight_probe_log_sources,
            /* logback.xml 配置导入 */
            modules::logsight::commands::logsight_import_logback_config,
            modules::logsight::commands::logsight_get_logback_config,
            modules::logsight::commands::logsight_delete_logback_config,
            /* 服务器目录选择器 */
            modules::logsight::commands::logsight_list_server_dir,
            modules::logsight::commands::logsight_validate_server_path,
            modules::logsight::commands::logsight_resolve_server_home,
            /* ===== AI-Passport 蓝牙模块命令（modules/aipassport/commands.rs） =====
             * 扫描 / 连接 / 断开 / 推送 / 清空 / 读取状态 */
            modules::aipassport::commands::aipassport_scan,
            modules::aipassport::commands::aipassport_connect,
            modules::aipassport::commands::aipassport_disconnect,
            modules::aipassport::commands::aipassport_push,
            modules::aipassport::commands::aipassport_push_lines,
            modules::aipassport::commands::aipassport_clear,
            modules::aipassport::commands::aipassport_state,
            /* ===== 智能体余额模块命令（modules/balances/commands.rs） =====
             * 平台列表 / 保存凭证 / 抓取登录态 / 删除凭证 / 拉取余额 / 探测 Codex CLI / 手动录入 */
            modules::balances::commands::balances_list_providers,
            modules::balances::commands::balances_save_credential,
            modules::balances::commands::balances_grab_session,
            modules::balances::commands::balances_delete_credential,
            modules::balances::commands::balances_refresh,
            modules::balances::commands::balances_refresh_one,
            modules::balances::commands::balances_set_refresh_plan,
            modules::balances::commands::balances_reschedule,
            modules::balances::commands::balances_autodetect_codex,
            modules::balances::commands::balances_save_manual,
            modules::balances::commands::balances_clear_manual,
            /* ===== JVM 进程看板模块命令（modules/jvm/commands.rs） =====
             * 扫描本机 Java 进程（含已装 JDK）/ 线程栈 / 堆转储 / 结束进程 / 查端口占用 */
            modules::jvm::commands::jvm_scan,
            modules::jvm::commands::jvm_jdk_version,
            modules::jvm::commands::jvm_thread_dump,
            modules::jvm::commands::jvm_heap_dump,
            modules::jvm::commands::jvm_kill,
            modules::jvm::commands::jvm_port_owner,
            /* ===== Maven 助手模块命令（modules/maven/commands.rs） =====
             * 探测 mvn / 扫本地仓库体积与重复版本 / 解析依赖树冲突 */
            modules::maven::commands::maven_locate,
            modules::maven::commands::maven_scan_repo,
            modules::maven::commands::maven_dependency_tree,
            /* ===== Spring Boot 服务台模块命令（modules/spring/commands.rs） =====
             * 扫描识别 / 单端口重试探活 / 在浏览器里打开 actuator 页面 */
            modules::spring::commands::spring_scan,
            modules::spring::commands::spring_probe,
            modules::spring::commands::spring_open,
            /* ===== 片段库模块命令（modules/snippets/commands.rs） =====
             * 列出 / 新建或更新 / 删除 / 置顶 / 记一次使用 */
            modules::snippets::commands::snippets_list,
            modules::snippets::commands::snippets_save,
            modules::snippets::commands::snippets_delete,
            modules::snippets::commands::snippets_toggle_pin,
            modules::snippets::commands::snippets_touch,
            /* ===== JAR 运行器模块命令（modules/jarrunner/commands.rs） =====
             * 列已装的 JDK / 运行配置 CRUD / 启动·停止·查记录·取日志 */
            modules::jarrunner::commands::jarrunner_list_jdks,
            modules::jarrunner::commands::jarrunner_list_configs,
            modules::jarrunner::commands::jarrunner_preview,
            modules::jarrunner::commands::jarrunner_save_config,
            modules::jarrunner::commands::jarrunner_delete_config,
            modules::jarrunner::commands::jarrunner_start,
            modules::jarrunner::commands::jarrunner_stop,
            modules::jarrunner::commands::jarrunner_remove,
            modules::jarrunner::commands::jarrunner_list_runs,
            modules::jarrunner::commands::jarrunner_logs,
            modules::jarrunner::commands::jarrunner_clear_logs,
            /* ===== Git 管理模块命令（modules/git/commands.rs） =====
             * 打开仓库 / 状态与差异 / 暂存与提交 / 分支操作 / 拉取推送 */
            modules::git::commands::git_open_repo,
            modules::git::commands::git_operation_state,
            modules::git::commands::git_mark_resolved,
            modules::git::commands::git_open_conflict_file,
            modules::git::commands::git_continue_operation,
            modules::git::commands::git_abort_operation,
            modules::git::commands::git_status,
            modules::git::commands::git_diff,
            modules::git::commands::git_show,
            modules::git::commands::git_log,
            modules::git::commands::git_branches,
            modules::git::commands::git_remotes,
            modules::git::commands::git_ahead_behind,
            modules::git::commands::git_stage,
            modules::git::commands::git_unstage,
            modules::git::commands::git_stage_hunk,
            modules::git::commands::git_commit,
            modules::git::commands::git_checkout,
            modules::git::commands::git_delete_branch,
            modules::git::commands::git_merge,
            modules::git::commands::git_fetch,
            /* git_pull 已移除：pull 的语义改成「把所选分支快进到远端最新、不产生合并提交」，
               由 git_pull_branch 承担（它会按所选分支是不是当前检出分支选不同的做法）；
               要产生真正的合并提交走 git_merge（分支右键 → 合并到当前分支）。 */
            modules::git::commands::git_pull_branch,
            modules::git::commands::git_count_between,
            modules::git::commands::git_push,
            /* ===== Trae 社区模块命令（modules/community/commands.rs） =====
             * 匿名可读：最新列表 / 分类 / 主题详情与楼层 / 用户资料与摘要
             * 登录后才能读：通知 / 私信频道（当前固定返回「需要登录」） */
            modules::community::commands::community_latest,
            modules::community::commands::community_tags,
            modules::community::commands::community_tag_topics,
            modules::community::commands::community_category_topics,
            modules::community::commands::community_featured,
            modules::community::commands::community_categories,
            modules::community::commands::community_topic,
            modules::community::commands::community_topic_posts,
            modules::community::commands::community_user,
            modules::community::commands::community_user_summary,
            modules::community::commands::community_notifications,
            modules::community::commands::community_notifications_mark_read,
            modules::community::commands::community_chat_channels,
            modules::community::commands::community_chat_messages,
            modules::community::commands::community_session,
            modules::community::commands::community_login_open,
            modules::community::commands::community_login_check,
            modules::community::commands::community_logout,
        ])
        .setup(|app| {
            // 初始化应用数据目录（走 core 的统一入口，别在这里直接调 app.path()）
            if let Ok(dir) = crate::core::storage::try_app_data_dir(app.handle()) {
                std::fs::create_dir_all(&dir).ok();
                tracing::info!("应用数据目录: {:?}", dir);
            }
            // 关窗行为偏好：后台线程读一次，关窗回调只读内存里的原子量
            // （sled 首次打开要建目录、失败还带重试，不能放在 setup 里拖慢启动）
            lifecycle::load_setting_in_background(app.handle().clone());
            // 智能体余额自动刷新调度：由后端定时器持有排期并发起取数，
            // 即使窗口被 hide() 转入后台也不受 webview 节流影响（见 balances 模块）
            modules::balances::commands::start_balances_scheduler(app.handle().clone());
            // 主窗口基础设置
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title("个人工作台");
                // 磨砂玻璃**不在这里**做，这里只留指引，别再挂空块：
                //   材质   → tauri.conf.json 的 `transparent: true` +
                //            `windowEffects.effects: ["underWindowBackground"]`
                //            （配套要求 Cargo.toml 开 `macos-private-api` 与
                //             配置里 `macOSPrivateApi: true`）
                //   深浅   → 前端 `store/useWorkbenchStore.ts::applyNativeWindowTheme`
                //            调 `getCurrentWindow().setTheme()`（材质跟的是**窗口**外观，
                //            不是网页的 class，不同步会深浅错配）
                //   分层   → 网页层必须透明（html/body/#root/AppShell），
                //            否则一处不透明底就把整块材质盖住
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                /*
                 * ⚠️ 只管主窗口 —— `Builder::on_window_event` 是**所有窗口**的回调。
                 *
                 * 不加这个判断的话，将来任何新窗口（关于框、独立日志窗、设置窗）被点 × 时，
                 * 都会去把**主窗口**藏起来、并用 `prevent_close()` 把**那个窗口自己**留住：
                 * 现象是「点了 × 关不掉，主窗口还莫名其妙消失」，极难查。
                 * 现在只有一个窗口，所以这是「还没被踩到的坑」，不是「已存在的 bug」。
                 */
                if window.label() != lifecycle::MAIN_WINDOW {
                    return;
                }
                /*
                 * 先问「关窗是不是要转后台」。
                 *
                 * 转成功就拦下这次关闭，只把窗口藏起来 —— webview 与其中的定时器都还活着，
                 * 各模块的后台任务照常跑，所以**这里绝不能广播 app-closing、也不能停服务**。
                 * 菜单栏项建不出来时 `hide_to_background` 返回 Err，那就放行关闭、应用退出，
                 * 免得留下一个既没 Dock 图标、又没菜单栏入口的后台进程。
                 */
                if lifecycle::background_on_close() {
                    match lifecycle::hide_to_background(window.app_handle()) {
                        Ok(()) => {
                            api.prevent_close();
                            return;
                        }
                        Err(e) => {
                            tracing::warn!("[后台运行] 转入后台失败，将正常退出：{e}");
                        }
                    }
                }
                lifecycle::broadcast_closing(window.app_handle());
                let _ = api;
            }
        })
        .build(tauri::generate_context!())
        .expect("个人工作台启动失败，请检查 Tauri 配置与 Rust 工具链是否安装正确")
        .run(|app, event| match event {
            /*
             * 后台任务的收尾统一放在 RunEvent::Exit —— 无论从「关窗退出」还是
             * 「菜单栏右键 → 退出工作台」哪条路径退出，都会走到这里，不会漏。
             * 新增模块若有后台任务，在这里补上对应的 stop_all 调用。
             */
            RunEvent::Exit => {
                /* stop_all 返回停掉的条数，这里不用它；写成块是为了统一各分支的类型 */
                LogStreamService::stop_all();
                /*
                 * JAR 运行器的子进程是**长期存活**的：不收尾的话关掉工作台之后
                 * 那些 jar 还在跑（端口占着、日志还在写），用户只能去活动监视器杀。
                 * 新增「会长时间留下子进程」的模块时，都要在这里补一行。
                 */
                modules::jarrunner::commands::stop_all();
            }
            /*
             * macOS 的「重新打开」：双击 .app、或 `open -b com.fu.workbench`。
             *
             * **必须自己接**：tao 只把这个事件抛出来（见 tao 的
             * `application_should_handle_reopen`，它只 emit、不动窗口），
             * 所以不接的话「双击应用」在窗口被藏起来时什么都不会发生。
             *
             * 它的价值是给关窗转后台留**第二条**回窗口的路 —— 菜单栏项万一被系统
             * 收进溢出区（刘海机型上很容易），用户还有这一条，不必去活动监视器。
             * 窗口本来就可见时它只是把窗口提到最前，也是符合预期的。
             */
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => {
                lifecycle::restore_window(app);
            }
            _ => {}
        });
}
