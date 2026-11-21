/*
 * 程序坞图标切换（macOS）
 * ------------------------------------------------------------------
 * 设置页选图标 → 前端调 workbench_set_dock_icon(icon_id) →
 * 把对应 PNG 写到 app_data_dir，再用 NSApp.setApplicationIconImage_ 替换 Dock 图。
 *
 * 几个关键点：
 *   1. 1024 PNG 用 include_bytes! 嵌入二进制，不依赖文件系统查找 —— 编译期确定，
 *      不会有「图标文件没打进 bundle」这种运行期 404
 *   2. 临时 PNG 文件固定写在 app_data_dir/dock-icon-current.png，每次切换覆盖，
 *      NSImage initWithContentsOfFile 比 initWithData: 兼容性更好（处理 @2x retina 自动）
 *   3. 退出后 macOS 自动读回 .app 里的 .icns，所以不需要「重置」接口
 *   4. 改的是 NSApplication 进程级图标，不动磁盘上的 .icns —
 *      用户看到的「图标切换」完全在内存里，可逆性天然
 *   5. 非 macOS 平台：命令存在但返回错误，前端不在选择器里调
 */
use serde::Serialize;
use tauri::{command, AppHandle};

use crate::core::storage::try_app_data_dir;

#[derive(Serialize)]
pub struct DockIconInfo {
    pub id: String,
    pub name: String,
    pub description: String,
}

/* 编译期嵌入 3 套图标（与 src-tauri/icons/dock/ 下的 SVG 同源）。
   改了 SVG 后必须重新编译才能生效。
   用 CARGO_MANIFEST_DIR 锚定到 src-tauri/，不依赖 include_bytes! 相对于源文件的解析规则。 */
const ICON_BRAND: &[u8] =
    include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/icons/dock/brand.png"));
const ICON_MONO: &[u8] =
    include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/icons/dock/mono.png"));
const ICON_PRISM: &[u8] =
    include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/icons/dock/prism.png"));

/*
 * 列出可用的程序坞图标（设置页选择器用）。
 * 顺序即设置页的展示顺序。
 */
#[command]
pub fn workbench_list_dock_icons() -> Vec<DockIconInfo> {
    vec![
        DockIconInfo {
            id: "brand".into(),
            name: "品牌".into(),
            description: "深底 + 翠绿品牌光晕 + 模块色点".into(),
        },
        DockIconInfo {
            id: "mono".into(),
            name: "极简".into(),
            description: "纯灰阶，低调不抢眼".into(),
        },
        DockIconInfo {
            id: "prism".into(),
            name: "棱镜".into(),
            description: "彩虹渐变 W，活泼有辨识度".into(),
        },
    ]
}

/*
 * 切换程序坞图标。
 * 返回 Ok(()) 表示已替换 Dock 图标，Err(msg) 用于前端 message.error。
 */
#[command]
pub fn workbench_set_dock_icon(app: AppHandle, icon_id: String) -> Result<(), String> {
    let bytes: &[u8] = match icon_id.as_str() {
        "brand" => ICON_BRAND,
        "mono" => ICON_MONO,
        "prism" => ICON_PRISM,
        other => return Err(format!("未知的程序坞图标：{}", other)),
    };
    #[cfg(target_os = "macos")]
    unsafe {
        apply_icon(app, bytes)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = bytes;
        Err("切换程序坞图标仅支持 macOS".into())
    }
}

/*
 * 下面这个函数用的是 `cocoa` / `objc` —— 两个**已被官方标记 deprecated** 的 crate
 * （迁移目标是 `objc2` / `objc2-foundation`）。就地压掉告警，理由分两类：
 *   1. `deprecated`（5 条）：`cocoa::base::nil` / `NSString` 等，功能完全正常，
 *      只是上游不再维护。迁移要重写整段 msg_send 并动 Cargo.toml 依赖 —— 独立任务。
 *   2. `unexpected_cfgs`（7 条）：**根本不在我们的代码里**，是 `class!` / `msg_send!`
 *      宏展开出的 `cfg!(cargo-clippy)`（宏在**定义侧**求值，看不到本 crate 的 feature
 *      列表），我们无从修改，只能就地压掉。
 */
#[allow(deprecated, unexpected_cfgs)]
#[cfg(target_os = "macos")]
unsafe fn apply_icon(app: AppHandle, bytes: &[u8]) -> Result<(), String> {
    use cocoa::base::nil;
    use cocoa::foundation::NSString;
    use objc::{class, msg_send, sel, sel_impl};

    /*
     * 写到 app_data_dir 而不是 /tmp —— 用户卸载 app 时能跟着清掉。
     * 用 `try_app_data_dir` 而不是 `app_data_dir`：这里是**写文件**，
     * 拿不到目录时必须报错，不能退化成「写到当前工作目录」。
     */
    let dir = try_app_data_dir(&app).map_err(|e| format!("无法获取 app 数据目录：{}", e))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建 app 数据目录失败：{}", e))?;
    let path = dir.join("dock-icon-current.png");
    std::fs::write(&path, bytes).map_err(|e| format!("写入图标失败：{}", e))?;

    let path_str = path.to_str().ok_or_else(|| "临时图标路径含非 UTF-8 字符".to_string())?;
    let ns_path = NSString::alloc(nil).init_str(path_str);

    /* NSImage *img = [[NSImage alloc] initWithContentsOfFile:path]; */
    let image_class = class!(NSImage);
    let image: *mut objc::runtime::Object = msg_send![image_class, alloc];
    let image: *mut objc::runtime::Object = msg_send![image, initWithContentsOfFile: ns_path];
    if image.is_null() {
        return Err(format!("NSImage 无法读取图标：{}", path_str));
    }

    /* NSApp = [NSApplication sharedApplication]; [NSApp setApplicationIconImage:image]; */
    let ns_app: *mut objc::runtime::Object =
        msg_send![class!(NSApplication), sharedApplication];
    let _: () = msg_send![ns_app, setApplicationIconImage: image];

    /* Dock 会自己 retain，引用计数交给它 */
    let _: () = msg_send![image, release];

    tracing::info!("已切换程序坞图标：{}", path_str);
    Ok(())
}